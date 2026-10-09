/**
 * Browser end-to-end tests for the Atlas: the real site/index.html and the real js/app.js +
 * js/atlas*.js modules, driven in headless Chrome through the DevTools protocol (no npm
 * packages: Node built-ins only, see atlas_browser_support.mjs).
 *
 * The page is served from site/ by a node:http server that also answers the chat API calls
 * app.js makes (same origin, relative URLs). No Content-Security-Policy header is added: the
 * meta tag in index.html is what ships, and Chrome enforces it here.
 *
 * Island names, teasers and terms are never hardcoded: they are read from js/atlas-graph.js.
 * Only three first-load facts are written out on purpose (the start island, the first suggestion
 * and the edge dragon caption), because a visitor sees exactly those words on a first visit.
 *
 * Run: node --test tests/e2e/atlas_browser.test.mjs
 * Chrome: /usr/bin/google-chrome, or the executable named by ATLAS_CHROME. Without a Chrome
 * the whole suite is skipped with the reason printed. Screenshots go to /tmp/atlas-e2e/.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { REJECT_PAUSE_MS } from "../../site/js/atlas-chat.js";
import { EDGES, EDGE_DRAGON_CAPTION, FIRST_SUGGESTION, ISLANDS, REGIONS, START_ID, buildIndex } from "../../site/js/atlas-graph.js";
import { classifyTerm, compileGlossary, matchReply } from "../../site/js/atlas-match.js";
import { regionHeading, suggestionItems } from "../../site/js/atlas-panel.js";
import { deriveView } from "../../site/js/atlas-state.js";
import { OUT_DIR, findChrome, launchBrowser, sleep, startSite } from "./atlas_browser_support.mjs";

const INDEX = buildIndex();
const GLOSSARY = compileGlossary(ISLANDS);
const START = INDEX.byId.get(START_ID);
const START_NEIGHBOURS = [...INDEX.neighbours.get(START_ID)];

/** The proposal's example reply: it names several places and leaves the pot and the overdraft next door. */
const HOOK_REPLY =
  "Your ISP, as your financial counterparty. You pay it under one standing plan, and apps earn through the protocol. Its monthly commitment for your household enters a common fund and funds your guaranteed base allowance.";
/** The example reply for turn 1 and a distinct variant for later turns (the Atlas ignores a repeated identical reply). */
const hookReplyFor = (n) => (n === 1 ? HOOK_REPLY : `${HOOK_REPLY} (follow-up ${n})`);
/** A reply that names no place on the map. */
const PLAIN_REPLY = "That is a fair question, and the short answer is: it depends on the household.";

const CHROME = findChrome();
/** Every console message, Log entry and uncaught exception from every page of this run. */
const diagnostics = [];
let browser = null;

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/** Fresh server + stub + isolated browser context for one test. Cleaned up even on failure. */
async function openSite(t, label, pageOptions = {}) {
  const site = await startSite();
  const page = await browser.openPage({ label, diagnostics, ...pageOptions });
  t.after(async () => {
    await page.close();
    await site.close();
  });
  return { site, stub: site.stub, page, url: `${site.origin}/` };
}

/** Load the page and wait until the Atlas has painted and the chat is ready for a suggestion. */
async function boot(page, url) {
  await page.goto(url);
  await page.waitFor(`(document.querySelector("#atlas-count")?.textContent || "").length > 0`, {
    what: "the Atlas count to be painted",
  });
  await page.waitFor(
    `(() => {
      const chip = document.querySelector("#atlas-suggest .atlas-chip");
      return !!chip && !chip.disabled && document.querySelector("#phase").textContent.trim() === "ready";
    })()`,
    { what: "the chat to be ready and the first suggestion enabled" },
  );
}

/** One read of everything the tests look at. */
const READ_ATLAS = `(() => {
  const q = (selector) => document.querySelector(selector);
  const islands = {};
  for (const g of document.querySelectorAll("#atlas-map .atlas-island")) {
    const classes = g.classList;
    islands[g.getAttribute("data-id")] = {
      status: classes.contains("is-visited") ? "visited" : classes.contains("is-frontier") ? "frontier" : classes.contains("is-fogged") ? "fogged" : "unknown",
      flare: classes.contains("is-flare"),
      role: g.getAttribute("role"),
      ariaHidden: g.getAttribute("aria-hidden"),
      ariaDisabled: g.getAttribute("aria-disabled"),
      ariaLabel: g.getAttribute("aria-label"),
      tabindex: g.getAttribute("tabindex"),
      label: Array.from(g.querySelectorAll(".atlas-label tspan")).map((span) => span.textContent).join(" "),
      labelRendered: !!g.querySelector(".atlas-label") && getComputedStyle(g.querySelector(".atlas-label")).display !== "none",
    };
  }
  const edges = {};
  for (const g of document.querySelectorAll("#atlas-map .atlas-edge")) {
    edges[g.getAttribute("data-edge")] = g.classList.contains("is-lit") ? "lit" : g.classList.contains("is-stub") ? "stub" : "hidden";
  }
  const chips = Array.from(document.querySelectorAll("#atlas-suggest .atlas-chip")).map((chip) => ({
    text: chip.textContent,
    disabled: chip.disabled,
    ariaDisabled: chip.getAttribute("aria-disabled"),
  }));
  const asks = Array.from(document.querySelectorAll("#atlas-list .atlas-list-ask")).filter((button) => !button.hidden).map((button) => ({
    text: button.textContent,
    disabled: button.disabled,
    ariaDisabled: button.getAttribute("aria-disabled"),
  }));
  const dragon = q(".atlas-edge-dragon");
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("esp-atlas")); } catch (error) { session = "unreadable"; }
  const draft = q("#draft");
  const history = Array.from(document.querySelectorAll("#history li > p")).map((p) => ({ text: p.textContent, children: p.children.length }));
  return {
    count: q("#atlas-count") ? q("#atlas-count").textContent : null,
    islands,
    edges,
    chips,
    asks,
    notice: q("#atlas-notice") ? q("#atlas-notice").textContent.trim() : null,
    inked: !!dragon && dragon.classList.contains("is-inked"),
    session,
    localKeys: Object.keys(localStorage),
    sessionKeys: Object.keys(sessionStorage),
    phase: q("#phase") ? q("#phase").textContent.trim() : null,
    draft: draft ? draft.value : null,
    history,
    flared: Array.from(document.querySelectorAll("#atlas-map .is-flare")).map((g) => g.getAttribute("data-id")),
  };
})()`;

const readAtlas = (page) => page.eval(READ_ATLAS);

/** Compare a page read with what the state model says the map must show. */
function assertMatchesModel(snap, visited, replies) {
  const view = deriveView({ visited, replies }, INDEX);
  assert.equal(snap.count, `${view.visitedCount} of ${view.total} visited`, "count text");
  for (const island of ISLANDS) {
    assert.equal(snap.islands[island.id]?.status, view.status[island.id], `status of island ${island.id}`);
  }
  for (const [key, state] of Object.entries(view.edges)) {
    assert.equal(snap.edges[key], state, `state of path ${key}`);
  }
  assert.equal(snap.inked, replies > 0, "edge dragon inked once there has been a reply");
  assert.deepEqual(
    snap.chips.map((chip) => chip.text),
    suggestionItems(view),
    "suggestion chips",
  );
}

const idsWithStatus = (snap, status) => Object.keys(snap.islands).filter((id) => snap.islands[id].status === status);

/** The graph-order list of ids a reply visits, start island first. */
function visitedAfter(before, reply) {
  const ids = matchReply(reply, GLOSSARY);
  return [...before, ...ids.filter((id) => !before.includes(id))];
}

/** Wait until the nth stream has finished and the Atlas has scanned the nth reply. */
async function waitReply(page, stub, n) {
  await stub.waitFor(() => stub.completed >= n, { what: `stream ${n} to finish` });
  await page.waitFor(
    `(() => {
      const raw = sessionStorage.getItem("esp-atlas");
      return !!raw && JSON.parse(raw).replies >= ${n} && document.querySelector("#phase").textContent.trim() === "ready";
    })()`,
    { what: `the Atlas to scan reply ${n} and the chat to be ready` },
  );
}

/** A visitor's own question through the real form: click the box, type, click Send. */
async function sendViaComposer(page, stub, text, n) {
  await page.click("#draft");
  await page.type(text);
  await page.click("#send");
  await waitReply(page, stub, n);
}

/** Make the Atlas look at the bridge again: a real keystroke into the message box and back out. */
async function nudge(page) {
  await page.click("#draft");
  await page.type("x");
  await page.clearFocused();
}

/** Every revealed-but-not-visited island is disabled and every chip and Ask button too. */
function assertPaused(snap, label) {
  const frontier = idsWithStatus(snap, "frontier");
  assert.ok(frontier.length > 0, `${label}: there are frontier islands to check`);
  for (const id of frontier) assert.equal(snap.islands[id].ariaDisabled, "true", `${label}: frontier island ${id} is aria-disabled`);
  assert.ok(snap.chips.length > 0, `${label}: there are chips to check`);
  for (const chip of snap.chips) {
    assert.ok(chip.disabled || chip.ariaDisabled === "true", `${label}: chip "${chip.text}" is disabled`);
  }
  for (const ask of snap.asks) {
    assert.ok(ask.disabled || ask.ariaDisabled === "true", `${label}: Ask button "${ask.text}" is disabled`);
  }
  assert.ok(snap.notice && snap.notice.length > 0, `${label}: the notice says why`);
}

function assertEnabled(snap, label) {
  for (const id of idsWithStatus(snap, "frontier")) {
    assert.equal(snap.islands[id].ariaDisabled, null, `${label}: frontier island ${id} is enabled`);
  }
  for (const chip of snap.chips) assert.ok(!chip.disabled && chip.ariaDisabled === null, `${label}: chip "${chip.text}" is enabled`);
  for (const ask of snap.asks) assert.ok(!ask.disabled && ask.ariaDisabled === null, `${label}: Ask "${ask.text}" is enabled`);
  assert.equal(snap.notice, "", `${label}: no notice`);
}

/** The console line Chrome prints for the shipped meta CSP that carries frame-ancestors. */
const META_FRAME_ANCESTORS = /frame-ancestors' is ignored when delivered via a <meta> element/i;
/** Failed fetches that the 409/429 scenarios provoke on purpose. */
const EXPECTED_REJECTION = /Failed to load resource: the server responded with a status of (409|429)/;

/** Split diagnostics into the things the suite refuses and the known notes. */
function classifyDiagnostics(entries) {
  const exceptions = entries.filter((entry) => entry.kind === "exception");
  const violations = entries.filter((entry) => /refused to|violates the following content security policy/i.test(entry.text));
  const cspNotes = entries.filter(
    (entry) => /content security policy/i.test(entry.text) && !violations.includes(entry) && !META_FRAME_ANCESTORS.test(entry.text),
  );
  const errors = entries.filter(
    (entry) =>
      entry.level === "error" &&
      entry.kind !== "exception" &&
      !META_FRAME_ANCESTORS.test(entry.text) &&
      !EXPECTED_REJECTION.test(entry.text),
  );
  const knownMetaNotes = entries.filter((entry) => META_FRAME_ANCESTORS.test(entry.text));
  return { exceptions, violations, cspNotes, errors, knownMetaNotes };
}

const describeEntries = (entries) => entries.map((entry) => `[${entry.test}] ${entry.kind}/${entry.level || ""}: ${entry.text}`).join("\n");

function assertQuiet(entries, label = "page") {
  const { exceptions, violations, cspNotes, errors } = classifyDiagnostics(entries);
  assert.equal(exceptions.length, 0, `${label}: uncaught exceptions\n${describeEntries(exceptions)}`);
  assert.equal(violations.length, 0, `${label}: Content-Security-Policy violations\n${describeEntries(violations)}`);
  assert.equal(cspNotes.length, 0, `${label}: unexpected Content-Security-Policy messages\n${describeEntries(cspNotes)}`);
  assert.equal(errors.length, 0, `${label}: console errors\n${describeEntries(errors)}`);
}

const scrollToAtlas = (page) =>
  page.eval(`(document.querySelector("#explore").scrollIntoView({ block: "start", behavior: "instant" }), true)`);

/** Everything the chat-card layout tests look at, in viewport pixels. */
const READ_CARD = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
  const card = document.querySelector("#conversation");
  const history = document.querySelector("#history");
  const form = document.querySelector("#composer");
  const rows = Array.from(history.querySelectorAll("li > p"));
  const last = rows[rows.length - 1];
  const after = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  return {
    viewport: { width: innerWidth, height: innerHeight },
    scrollY,
    card: box(card),
    cardScroll: { top: card.scrollTop, height: card.scrollHeight, client: card.clientHeight },
    history: box(history),
    historyScroll: { top: history.scrollTop, height: history.scrollHeight, client: history.clientHeight },
    lastRow: last ? box(last) : null,
    rowCount: rows.length,
    chips: Array.from(document.querySelectorAll("#atlas-suggest .atlas-chip")).map(box),
    textarea: box(document.querySelector("#draft")),
    send: box(document.querySelector("#send")),
    phase: box(document.querySelector("#phase")),
    activeId: document.activeElement ? document.activeElement.id : "",
    order: {
      firstChild: form.firstElementChild.id,
      lastChild: form.lastElementChild.id,
      historyBeforeProvider: after(history, document.querySelector("#provider")),
      historyBeforeDraft: after(history, document.querySelector("#draft")),
      sendBeforePhase: after(document.querySelector("#send"), document.querySelector("#phase")),
    },
  };
})()`;

/** WCAG contrast of the chat card's status line and history rows, from computed styles. */
const READ_CONTRAST = `(() => {
  const parse = (c) => (c.match(/[\\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const backgroundOf = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c.length === 3 || (c.length === 4 && c[3] > 0.99)) return c.slice(0, 3);
    }
    return [255, 255, 255];
  };
  const ratio = (el) => {
    const a = lum(parse(getComputedStyle(el).color).slice(0, 3));
    const b = lum(backgroundOf(el));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  return {
    phase: ratio(document.querySelector("#phase")),
    phaseText: document.querySelector("#phase").textContent.trim(),
    rows: Array.from(document.querySelectorAll("#history li > p")).map(ratio),
  };
})()`;

/** Is `inner` inside `outer` (viewport pixels, half a pixel of slack)? */
const inside = (inner, outer) => inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;

/** Make the Atlas look at the bridge again WITHOUT changing the message box: type a letter and take it back out. */
async function poke(page) {
  await page.click("#draft");
  await page.eval(`(() => { const box = document.querySelector("#draft"); box.setSelectionRange(box.value.length, box.value.length); return true; })()`);
  await page.type("x");
  await page.press("Backspace");
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

/** Which element holds keyboard focus, in terms a test can compare. */
const ACTIVE = `(() => {
  const a = document.activeElement;
  return {
    tag: a ? a.tagName.toLowerCase() : null,
    cls: a ? (a.getAttribute("class") || "") : "",
    id: a ? a.getAttribute("data-id") : null,
    domId: a ? a.id : "",
  };
})()`;

const focusIsland = (page, id) =>
  page.eval(`(() => { const g = document.querySelector('#atlas-map [data-id="${id}"]'); g.focus(); return document.activeElement === g; })()`);

// ---------------------------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------------------------

describe("Atlas in a real browser", { skip: CHROME.path ? false : CHROME.reason, timeout: 150000 }, () => {
  before(async () => {
    browser = await launchBrowser(CHROME.path);
    ensureOutDir();
  });

  after(async () => {
    if (browser) await browser.close();
    browser = null;
  });

  it("1. first load: one lit island, its neighbours on the frontier, everything else in the fog", async (t) => {
    const { page, stub, url } = await openSite(t, "1-first-load");
    await boot(page, url);
    const snap = await readAtlas(page);

    const toolbar = await page.eval(`(() => {
      const bar = document.querySelector("#atlas-toolbar");
      const r = bar.getBoundingClientRect();
      return { hidden: bar.hidden, height: r.height, width: r.width };
    })()`);
    assert.equal(toolbar.hidden, false, "toolbar is revealed by the script");
    assert.ok(toolbar.height > 0 && toolbar.width > 0, "toolbar has a visible box");

    assert.equal(snap.count, `1 of ${ISLANDS.length} visited`);
    assert.deepEqual(idsWithStatus(snap, "visited"), [START_ID]);
    assert.equal(START.name, "Your internet bill", "the start island is the visitor's own bill");
    assert.equal(snap.islands[START_ID].label, START.name, "the start island shows its name");
    assert.equal(snap.islands[START_ID].labelRendered, true);
    for (const id of START_NEIGHBOURS) assert.equal(snap.islands[id].labelRendered, true, `${id} shows its name on the frontier`);

    assert.deepEqual(new Set(idsWithStatus(snap, "frontier")), new Set(START_NEIGHBOURS), "frontier = graph neighbours of the start");
    for (const id of START_NEIGHBOURS) {
      const island = INDEX.byId.get(id);
      const view = snap.islands[id];
      assert.equal(view.role, "button", `${id} is a button`);
      assert.ok(view.ariaLabel && view.ariaLabel.includes(island.name), `${id} aria-label names it`);
      assert.ok(view.ariaLabel.includes(island.teaser), `${id} aria-label carries its teaser`);
      assert.equal(view.ariaHidden, null, `${id} is exposed to assistive technology`);
      assert.ok(view.tabindex === "0" || view.tabindex === "-1", `${id} is part of the roving tabindex`);
      assert.equal(view.ariaDisabled, null, `${id} is enabled on first load`);
    }
    const fogged = idsWithStatus(snap, "fogged");
    assert.equal(fogged.length, ISLANDS.length - 1 - START_NEIGHBOURS.length, "every other island is fogged");
    for (const id of fogged) {
      assert.equal(snap.islands[id].ariaHidden, "true", `${id} is aria-hidden`);
      assert.equal(snap.islands[id].tabindex, null, `${id} has no tabindex`);
      assert.equal(snap.islands[id].role, null, `${id} has no role`);
      assert.equal(snap.islands[id].labelRendered, false, `${id} shows no name while it is fogged`);
    }
    const stops = Object.keys(snap.islands).filter((id) => snap.islands[id].tabindex === "0");
    assert.deepEqual(stops, [START_ID], "exactly one island is in the tab order, the start");

    assert.equal(snap.chips.length, 1, "exactly one suggestion chip");
    assert.equal(snap.chips[0].text, FIRST_SUGGESTION);
    assert.equal(snap.chips[0].text, "Who actually pays the apps I use?");
    assert.ok(!snap.chips[0].disabled);

    const page1 = await page.eval(`(() => {
      const dragon = document.querySelector(".atlas-edge-dragon");
      const caption = document.querySelector(".atlas-ed-caption");
      const honesty = document.querySelector(".atlas-honesty");
      const legend = document.querySelector(".atlas-legend");
      const legendBox = legend.getBoundingClientRect();
      const items = Array.from(legend.querySelectorAll("li")).map((li) => {
        const r = li.getBoundingClientRect();
        return { text: li.textContent.trim(), width: r.width, height: r.height, top: Math.round(r.top) };
      });
      const hit = document.querySelector('#atlas-map [data-id="${START_ID}"] .atlas-hit').getBoundingClientRect();
      return {
        dragon: !!dragon,
        caption: caption ? caption.textContent : null,
        inked: !!dragon && dragon.classList.contains("is-inked"),
        honesty: honesty ? honesty.textContent.toLowerCase() : "",
        atlasHtml: document.querySelector("#atlas").outerHTML.toLowerCase(),
        legend: { visible: legendBox.width > 0 && legendBox.height > 0 && getComputedStyle(legend).visibility === "visible", items },
        hitSize: Math.min(hit.width, hit.height),
        strictCsp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
      };
    })()`);
    assert.ok(page1.dragon, "the edge dragon exists");
    assert.equal(page1.caption, "Unfinished. You will get here.");
    assert.equal(page1.caption, EDGE_DRAGON_CAPTION);
    assert.equal(page1.inked, false, "the edge dragon is still faint");
    assert.ok(page1.honesty.includes("illustrative"), "honesty text says the figures are illustrative");
    assert.ok(page1.honesty.includes("not company-approved"), "honesty text says the summary is not company-approved");
    assert.ok(!page1.atlasHtml.includes("learned"), 'the word "learned" appears nowhere in the Atlas section (text or attributes)');
    assert.ok(page1.legend.visible, "legend is visible");
    assert.equal(page1.legend.items.length, 4, "legend explains visited, next, awaits incorporation and open");
    for (const item of page1.legend.items) assert.ok(item.width > 0 && item.height > 0, `legend entry is rendered: ${item.text}`);
    const legendRows = new Map();
    for (const item of page1.legend.items) legendRows.set(item.top, (legendRows.get(item.top) || 0) + 1);
    const perRow = [...legendRows.values()];
    assert.ok(
      perRow.every((count) => count === perRow[0]) && [2, 4].includes(perRow[0]),
      `the legend is balanced (2 + 2 or one row), never 3 + 1: rows hold ${perRow.join(" + ")}`,
    );
    assert.ok(page1.hitSize >= 44, `island hit area is at least 44 CSS px at 1400 px (got ${page1.hitSize.toFixed(1)})`);
    assert.match(page1.strictCsp, /default-src 'self'/, "the shipped CSP meta tag is present");

    // The chat card reads top to bottom as it looks: history, provider, message box, Send, status line.
    const card = await page.eval(READ_CARD);
    assert.equal(card.order.firstChild, "history", "the history is the first thing in the form");
    assert.equal(card.order.lastChild, "phase", "the status line is the last thing in the form");
    assert.ok(card.order.historyBeforeProvider && card.order.historyBeforeDraft && card.order.sendBeforePhase, "DOM order = visual order");
    const historyFacts = await page.eval(`(() => {
      const history = document.querySelector("#history");
      return { tabindex: history.getAttribute("tabindex"), label: history.getAttribute("aria-label"), display: getComputedStyle(history).display, rows: history.children.length };
    })()`);
    assert.equal(historyFacts.tabindex, "0", "the history is a keyboard-reachable scroll region");
    assert.equal(historyFacts.label, "History");
    assert.equal(historyFacts.rows, 0);
    assert.equal(historyFacts.display, "none", "an empty history draws no box and is no empty tab stop");

    assert.deepEqual(snap.localKeys, [], "localStorage is untouched");
    assert.deepEqual(stub.posts, [], "nothing is sent on load");
    assert.deepEqual(stub.notFound, [], "every asset the page asks for exists");
    assert.deepEqual(stub.csrfFailures, []);
    assertMatchesModel(snap, [START_ID], 0);

    await scrollToAtlas(page);
    await page.screenshot(path.join(OUT_DIR, "first-load.png"));
    await page.screenshot(path.join(OUT_DIR, "first-load-section.png"), { clipSelector: "#explore" });
  });

  it("2. hook flow: the suggestion chip asks the question, the reply lights the places it names", async (t) => {
    const { page, stub, url } = await openSite(t, "2-hook-flow");
    stub.reply = () => HOOK_REPLY;
    stub.sseDelayMs = 100;
    await boot(page, url);

    await page.click(".atlas-chip");
    await stub.waitFor(() => stub.posts.length >= 1, { what: "the chip's POST" });
    assert.deepEqual(stub.posts, [{ message: FIRST_SUGGESTION, status: 200 }], "exactly one POST with the chip's text");

    const newIds = matchReply(HOOK_REPLY, GLOSSARY).filter((id) => id !== START_ID);
    assert.ok(newIds.length >= 3, "the example reply names several places");
    const expectedVisited = [START_ID, ...newIds];
    const expectedCount = `${1 + newIds.length} of ${ISLANDS.length} visited`;

    await page.waitFor(`document.querySelector("#atlas-count").textContent === ${JSON.stringify(expectedCount)}`, {
      what: `count to become ${expectedCount}`,
    });
    const lit = await readAtlas(page);
    assert.deepEqual(new Set(lit.flared), new Set(newIds), "exactly the newly visited places flare");
    for (const id of newIds) assert.equal(lit.islands[id].status, "visited", `${id} is visited`);
    await scrollToAtlas(page);
    await page.screenshot(path.join(OUT_DIR, "post-hook-flare.png"), { clipSelector: "#explore" });

    await waitReply(page, stub, 1);
    await page.waitFor(`document.querySelectorAll("#atlas-map .is-flare").length === 0`, {
      what: "the flare class to be removed",
      timeout: 6000,
    });

    const snap = await readAtlas(page);
    assertMatchesModel(snap, expectedVisited, 1);
    assert.ok(!newIds.includes("the-pot") && !newIds.includes("overdraft"), "the example reply leaves the pot and the overdraft unvisited");
    assert.equal(snap.islands["the-pot"].status, "frontier", "the pot is next to explore");
    assert.equal(snap.islands["overdraft"].status, "frontier", "the overdraft is next to explore");
    const litPaths = EDGES.filter((edge) => expectedVisited.includes(edge.a) && expectedVisited.includes(edge.b));
    assert.ok(litPaths.length > 0, "the visited places share lit paths");
    for (const edge of litPaths) {
      assert.equal(snap.edges[[edge.a, edge.b].sort().join("|")], "lit", `path ${edge.a} - ${edge.b} is lit`);
    }
    assert.equal(snap.inked, true, "the edge dragon is inked after a reply");
    assert.deepEqual(snap.session, { v: 1, visited: expectedVisited, replies: 1 }, "sessionStorage esp-atlas holds the visited ids");
    assert.deepEqual(snap.localKeys, [], "localStorage has no keys at all");
    assert.ok(snap.sessionKeys.includes("esp-atlas"));

    assert.equal(snap.history.length, 2, "the history shows the question and the reply");
    assert.deepEqual(snap.history[0], { text: FIRST_SUGGESTION, children: 0 });
    assert.deepEqual(snap.history[1], { text: HOOK_REPLY, children: 0 }, "the reply is plain text in the history list");
    assert.equal(stub.posts.length, 1, "no extra request was sent");

    // Visited islands can be read in the inspector, in the visitor's words ("visited", never "learned").
    await page.clickIsland(newIds[0]);
    const card = await page.eval(`(() => {
      const mount = document.querySelector("#atlas-inspector");
      const name = mount.querySelector(".atlas-inspector-name");
      return { name: name ? name.textContent : null, text: mount.textContent.toLowerCase() };
    })()`);
    assert.equal(card.name, INDEX.byId.get(newIds[0]).name, "the inspector names the clicked place");
    assert.ok(card.text.includes("visited") && !card.text.includes("learned"));

    await scrollToAtlas(page);
    await page.screenshot(path.join(OUT_DIR, "post-hook.png"));
    await page.screenshot(path.join(OUT_DIR, "post-hook-section.png"), { clipSelector: "#explore" });
    assertQuiet(page.diagnostics.filter((entry) => entry.test === "2-hook-flow"), "hook flow");
  });

  it("3. in-flight guard: nothing can be tapped while a question runs", async (t) => {
    const { page, stub, url } = await openSite(t, "3-in-flight");
    stub.reply = () => HOOK_REPLY;
    const release = stub.holdStreams();
    await boot(page, url);
    await page.click("#atlas-view-list");
    await page.waitFor(`document.querySelector("#atlas-list .atlas-list-ask:not([hidden])")`, { what: "Ask buttons in the list" });

    await page.click(".atlas-chip");
    await stub.waitFor(() => stub.posts.length >= 1, { what: "the chip's POST" });
    const during = await readAtlas(page);
    assertPaused(during, "while the reply is pending");
    assert.ok(during.asks.length > 0, "the list shows Ask buttons for the frontier");

    // Try every way of asking again.
    const frontierId = START_NEIGHBOURS[0];
    await page.click(".atlas-list-item.is-frontier .atlas-list-ask");
    await page.click(".atlas-chip");
    await page.click("#atlas-view-map");
    await page.clickIsland(frontierId);
    await page.eval(`document.querySelector('#atlas-map [data-id="${frontierId}"]').focus()`);
    await page.press("Enter");
    await page.press(" ");
    await sleep(150);
    assert.equal(stub.posts.length, 1, "no second POST while a question runs");

    release();
    await waitReply(page, stub, 1);
    const after = await readAtlas(page);
    assertEnabled(after, "after the reply");
    assert.equal(stub.posts.length, 1);
    assertMatchesModel(after, visitedAfter([START_ID], HOOK_REPLY), 1);
  });

  for (const status of [409, 429]) {
    it(`4. ${status}: the chat asks for a pause, teasers stop, the visitor's own Send still works`, async (t) => {
      const { page, stub, url } = await openSite(t, `4-reject-${status}`);
      stub.reply = (_message, n) => hookReplyFor(n);
      stub.outcome = (number) => (number === 1 ? status : "accept");
      await boot(page, url);

      await page.click(".atlas-chip");
      await stub.waitFor(() => stub.posts.length >= 1, { what: "the chip's POST" });
      assert.deepEqual(stub.posts, [{ message: FIRST_SUGGESTION, status }]);
      await page.waitFor(`document.querySelector("#phase").textContent.trim() === "rejected"`, { what: "phase rejected" });
      await page.waitFor(`document.querySelector("#atlas-notice").textContent.trim().length > 0`, { what: "the pause notice" });

      const paused = await readAtlas(page);
      assertPaused(paused, `after ${status}`);
      assertMatchesModel(paused, [START_ID], 0);
      if (status === 409) {
        await scrollToAtlas(page);
        await page.screenshot(path.join(OUT_DIR, "paused-409.png"));
      }
      t.diagnostic(`draft box after the rejected tap: ${JSON.stringify(paused.draft)} (app.js puts the rejected text back for a retry)`);

      // Taps during the pause send nothing.
      await page.clickIsland(START_NEIGHBOURS[0]);
      await page.click(".atlas-chip");
      await page.eval(`document.querySelector('#atlas-map [data-id="${START_NEIGHBOURS[1]}"]').focus()`);
      await page.press("Enter");
      await page.click("#atlas-view-list");
      await page.click(".atlas-list-item.is-frontier .atlas-list-ask");
      await page.click("#atlas-view-map");
      await sleep(250);
      assert.equal(stub.posts.length, 1, "no teaser was sent during the pause");

      // The visitor's own Send is not blocked by the pause.
      await page.click("#draft");
      await page.clearFocused();
      await sendViaComposer(page, stub, "What do I pay in a normal month?", 1);
      assert.deepEqual(stub.posts[1], { message: "What do I pay in a normal month?", status: 200 }, "the visitor's own message went through");
      const afterOwn = await readAtlas(page);
      assertMatchesModel(afterOwn, visitedAfter([START_ID], HOOK_REPLY), 1);

      // After the pause has run its course the teasers work again (the clock is moved on, not waited for).
      await page.eval(`window.__atlasSkew(${REJECT_PAUSE_MS + 1000})`);
      await nudge(page);
      await page.waitFor(`document.querySelector("#atlas-suggest .atlas-chip") && !document.querySelector("#atlas-suggest .atlas-chip").disabled`, {
        what: "chips to come back after the pause",
      });
      const resumed = await readAtlas(page);
      assertEnabled(resumed, "after the pause");
      const chipText = resumed.chips[0].text;
      await page.click(".atlas-chip");
      await stub.waitFor(() => stub.posts.length >= 3, { what: "the teaser after the pause" });
      assert.deepEqual(stub.posts[2], { message: chipText, status: 200 }, "a teaser tap works again after the pause");
      await waitReply(page, stub, 2);
    });
  }

  for (const status of [409, 429]) {
    it(`4b. ${status}: the refused teaser left in the message box is the bridge's own text, so it does not block the next teaser`, async (t) => {
      const { page, stub, url } = await openSite(t, `4b-own-text-${status}`);
      stub.reply = (_message, n) => hookReplyFor(n);
      stub.outcome = (number) => (number === 1 ? status : "accept");
      await boot(page, url);

      await page.click(".atlas-chip");
      await stub.waitFor(() => stub.posts.length >= 1, { what: "the chip's POST" });
      await page.waitFor(`document.querySelector("#phase").textContent.trim() === "rejected"`, { what: "phase rejected" });
      await page.waitFor(`document.querySelector("#atlas-notice").textContent.trim().length > 0`, { what: "the pause notice" });
      const refused = await readAtlas(page);
      assert.equal(refused.draft, FIRST_SUGGESTION, "the chat put the refused text back into the message box");
      assertPaused(refused, `after ${status}`);
      assert.match(refused.notice, /pause|shortly/i, "while the pause lasts the notice talks about the pause, not about the message box");

      // The pause is over (the clock is moved on, not waited for). The box still holds the refused text.
      await page.eval(`window.__atlasSkew(${REJECT_PAUSE_MS + 1000})`);
      await poke(page);
      await page.waitFor(`document.querySelector("#atlas-suggest .atlas-chip") && !document.querySelector("#atlas-suggest .atlas-chip").disabled`, {
        what: "the chip to come back although the refused text is still in the box",
      });
      const resumed = await readAtlas(page);
      assert.equal(resumed.draft, FIRST_SUGGESTION, "the refused text is still in the box");
      assertEnabled(resumed, "own text in the box after the pause");

      // Whatever the visitor adds to it is theirs, and blocks teasers with the usual message.
      await page.type(" and my own words");
      await page.waitFor(`document.querySelector("#atlas-suggest .atlas-chip").disabled`, { what: "the chip to be blocked by typed text" });
      const typed = await readAtlas(page);
      assert.equal(typed.draft, `${FIRST_SUGGESTION} and my own words`);
      assertPaused(typed, "typed text in the box");
      assert.match(typed.notice, /message box has text/i, `the notice names the message box: "${typed.notice}"`);
      assert.equal(stub.posts.length, 1, "nothing was sent while the box held the visitor's text");
      for (let i = 0; i < " and my own words".length; i += 1) await page.press("Backspace");
      await page.waitFor(`!document.querySelector("#atlas-suggest .atlas-chip").disabled`, { what: "the chip to come back when the text is the bridge's own again" });

      // A new tap overwrites the old text and is sent exactly once, unchanged.
      await page.click(".atlas-chip");
      await stub.waitFor(() => stub.posts.length >= 2, { what: "the second teaser POST" });
      assert.deepEqual(stub.posts[1], { message: FIRST_SUGGESTION, status: 200 }, "the teaser went out as exactly its own text");
      await waitReply(page, stub, 1);
      const done = await readAtlas(page);
      assertMatchesModel(done, visitedAfter([START_ID], HOOK_REPLY), 1);
      assert.equal(done.draft, "", "the chat cleared the box after the accepted send");
    });
  }

  it("5. rate guard: after 20 quick questions teaser taps are refused", async (t) => {
    const { page, stub, url } = await openSite(t, "5-rate");
    assert.deepEqual(matchReply(PLAIN_REPLY, GLOSSARY), [], "the filler reply names no place");
    stub.reply = (_message, n) => `${PLAIN_REPLY} (answer ${n})`;
    await boot(page, url);

    for (let n = 1; n <= 19; n += 1) await sendViaComposer(page, stub, `question ${n}`, n);
    assert.equal(stub.posts.length, 19);
    assertEnabled(await readAtlas(page), "after 19 questions");

    await sendViaComposer(page, stub, "question 20", 20);
    assert.equal(stub.posts.length, 20);
    const limited = await readAtlas(page);
    assertPaused(limited, "after 20 questions");
    assert.match(limited.notice, /quick|rate|slow|too many/i, `the notice talks about the rate: "${limited.notice}"`);

    await page.click(".atlas-chip");
    await page.clickIsland(START_NEIGHBOURS[0]);
    await sleep(250);
    assert.equal(stub.posts.length, 20, "no 21st request was sent");

    // The window moves on: a minute later the teasers are back.
    await page.eval(`window.__atlasSkew(61000)`);
    await nudge(page);
    await page.waitFor(`document.querySelector("#atlas-suggest .atlas-chip") && !document.querySelector("#atlas-suggest .atlas-chip").disabled`, {
      what: "chips to come back after the window",
    });
    assertEnabled(await readAtlas(page), "a minute later");
    assert.equal(stub.posts.length, 20);
  });

  it("6a. keyboard: one Tab from the toolbar lands on the roving island", async (t) => {
    const { page, url } = await openSite(t, "6a-tab-order");
    await boot(page, url);
    await page.eval(`document.querySelector("#atlas-reset").focus()`);
    await page.press("Tab");
    const first = await page.eval(ACTIVE);
    assert.equal(
      first.id,
      START_ID,
      `the first Tab stop after the toolbar must be the roving-tabindex island, but focus is on <${first.tag} class="${first.cls}"> (an extra tab stop in front of the map)`,
    );
  });

  it("6b. keyboard: arrows follow revealed paths, Enter asks, Escape clears the inspector", async (t) => {
    const { page, stub, url } = await openSite(t, "6b-keyboard");
    stub.reply = () => PLAIN_REPLY;
    await boot(page, url);
    await page.eval(`document.querySelector("#atlas-reset").focus()`);
    let active = null;
    for (let presses = 0; presses < 3; presses += 1) {
      await page.press("Tab");
      active = await page.eval(ACTIVE);
      if (active.id) break;
    }
    assert.equal(active.id, START_ID, "Tab reaches the map's island");

    const reveal = await readAtlas(page);
    const revealed = (snap, id) => snap.islands[id] && snap.islands[id].status !== "fogged";
    const moved = [];
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"]) {
      assert.ok(await focusIsland(page, START_ID));
      await page.press(key);
      const now = await page.eval(ACTIVE);
      assert.ok(now.id, `${key}: focus is on an island`);
      if (now.id !== START_ID) {
        assert.ok(INDEX.neighbours.get(START_ID).has(now.id), `${key} from the start moved to a graph neighbour (${now.id})`);
        assert.ok(revealed(reveal, now.id), `${key} moved to a revealed island`);
        moved.push(now.id);
      }
    }
    assert.ok(moved.length >= 2, `arrows reach several neighbours (moved to ${moved.join(", ")})`);

    // From a frontier island the only revealed path leads back to the start: never into the fog.
    const from = moved[0];
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"]) {
      assert.ok(await focusIsland(page, from));
      await page.press(key);
      const now = await page.eval(ACTIVE);
      assert.ok(now.id === from || now.id === START_ID, `${key} from ${from} stays or goes back to the start, got ${now.id}`);
    }

    // The inspector follows keyboard focus; Enter on a frontier island sends its teaser.
    assert.ok(await focusIsland(page, from));
    const target = INDEX.byId.get(from);
    await page.waitFor(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent === ${JSON.stringify(target.name)}`, {
      what: "the inspector to show the focused island",
    });
    await page.press("Enter");
    await stub.waitFor(() => stub.posts.length >= 1, { what: "the Enter POST" });
    assert.deepEqual(stub.posts, [{ message: target.teaser, status: 200 }], "one POST with exactly the island's teaser");
    await waitReply(page, stub, 1);
    assert.equal(stub.posts.length, 1);

    // Escape clears the inspector.
    assert.ok(await focusIsland(page, from));
    await page.press("Escape");
    const cleared = await page.eval(`(() => {
      const mount = document.querySelector("#atlas-inspector");
      return { hint: !!mount.querySelector(".is-hint"), names: mount.querySelectorAll(".atlas-inspector-name").length };
    })()`);
    assert.deepEqual(cleared, { hint: true, names: 0 }, "Escape returns the inspector to its hint");
  });

  it("6c. focus: the bare map shows no outline when clicked, the focused island keeps its ring", async (t) => {
    const { page, url } = await openSite(t, "6c-focus-ring");
    await boot(page, url);
    await scrollToAtlas(page);

    // A click on empty sea (the L4 band, between fogged places) puts focus on the bare map.
    const sea = await page.eval(`(() => {
      const svg = document.querySelector("#atlas-map svg.atlas-svg");
      const r = svg.getBoundingClientRect();
      const [vx, vy] = [680, 375];
      const x = r.left + (vx / 1240) * r.width;
      const y = r.top + (vy / 780) * r.height;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit: hit ? hit.tagName + "." + (hit.getAttribute("class") || "") : null, tabindex: svg.getAttribute("tabindex") };
    })()`);
    assert.equal(sea.tabindex, "-1", "the bare map is not a tab stop");
    assert.ok(sea.hit && !/atlas-hit/.test(sea.hit), `the point is empty sea, not an island (${sea.hit})`);
    await page.clickPoint(sea.x, sea.y);
    const clicked = await page.eval(`(() => {
      const svg = document.querySelector("#atlas-map svg.atlas-svg");
      const s = getComputedStyle(svg);
      return { focused: document.activeElement === svg, outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth };
    })()`);
    assert.equal(clicked.focused, true, "the click focused the bare map (precondition of this check)");
    assert.ok(clicked.outlineStyle === "none" || clicked.outlineWidth === "0px", `no outline after a click: ${clicked.outlineStyle} ${clicked.outlineWidth}`);

    // Also when the browser decides focus is keyboard-driven (script focus after a key press).
    await page.press("Shift");
    const keyboard = await page.eval(`(() => {
      const svg = document.querySelector("#atlas-map svg.atlas-svg");
      document.activeElement && document.activeElement.blur();
      svg.focus();
      const s = getComputedStyle(svg);
      return { focused: document.activeElement === svg, focusVisible: svg.matches(":focus-visible"), outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth };
    })()`);
    assert.equal(keyboard.focused, true);
    assert.ok(keyboard.outlineStyle === "none" || keyboard.outlineWidth === "0px", `no outline on the bare map even for :focus-visible (${keyboard.focusVisible}): ${keyboard.outlineStyle} ${keyboard.outlineWidth}`);

    // Control: the island keeps its own visible ring when it is focused with the keyboard.
    await page.eval(`document.querySelector("#atlas-reset").focus()`);
    await page.press("Tab");
    const ring = await page.eval(`(() => {
      const g = document.activeElement;
      const circle = g && g.querySelector ? g.querySelector(".atlas-focus-ring") : null;
      const s = circle ? getComputedStyle(circle) : null;
      return { id: g ? g.getAttribute("data-id") : null, focusVisible: !!g && g.matches(":focus-visible"), stroke: s && s.stroke, width: s && s.strokeWidth, display: s && s.display };
    })()`);
    assert.equal(ring.id, START_ID, "Tab reaches the start island");
    assert.equal(ring.focusVisible, true);
    assert.notEqual(ring.display, "none");
    assert.ok(ring.stroke && ring.stroke !== "none", `the island's focus ring is drawn: stroke ${ring.stroke}`);
    assert.equal(ring.width, "3px");
  });

  it("7. list view: every place is named, only next-to-explore places can be asked", async (t) => {
    const { page, stub, url } = await openSite(t, "7-list");
    stub.reply = () => PLAIN_REPLY;
    await boot(page, url);
    const names = ISLANDS.map((island) => island.name);
    assert.equal(new Set(names).size, names.length, "island names are unique (rows are matched by name)");

    await page.click("#atlas-view-list");
    const view = await page.eval(`(() => {
      const map = document.querySelector("#atlas-map");
      const list = document.querySelector("#atlas-list");
      const box = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const rows = Array.from(list.querySelectorAll(".atlas-list-item")).map((li) => {
        const ask = li.querySelector(".atlas-list-ask");
        return {
          name: li.querySelector(".atlas-list-name").textContent,
          status: li.classList.contains("is-visited") ? "visited" : li.classList.contains("is-frontier") ? "frontier" : "fogged",
          askVisible: !!ask && !ask.hidden && box(ask),
          askText: ask ? ask.textContent : "",
          askDisabled: !!ask && ask.disabled,
        };
      });
      const headings = Array.from(list.querySelectorAll("h3")).map((h) => h.textContent);
      return {
        mapHidden: map.hidden || !box(map),
        listVisible: !list.hidden && box(list),
        pressed: { map: document.querySelector("#atlas-view-map").getAttribute("aria-pressed"), list: document.querySelector("#atlas-view-list").getAttribute("aria-pressed") },
        rows,
        headings,
      };
    })()`);
    assert.equal(view.mapHidden, true, "the map is hidden");
    assert.equal(view.listVisible, true, "the list is visible");
    assert.deepEqual(view.pressed, { map: "false", list: "true" });
    assert.equal(view.rows.length, ISLANDS.length, "one row per island");
    assert.deepEqual(new Set(view.rows.map((row) => row.name)), new Set(names), "every island is named");
    assert.deepEqual(view.headings, REGIONS.map(regionHeading), "rows are grouped by region");
    for (const row of view.rows) {
      const island = ISLANDS.find((candidate) => candidate.name === row.name);
      const expected = island.id === START_ID ? "visited" : START_NEIGHBOURS.includes(island.id) ? "frontier" : "fogged";
      assert.equal(row.status, expected, `row status of ${island.id}`);
      if (expected === "frontier") {
        assert.ok(row.askVisible, `${island.id} has an Ask button`);
        assert.equal(row.askText, island.teaser, `${island.id}'s Ask button carries its teaser`);
        assert.equal(row.askDisabled, false);
      } else {
        assert.equal(row.askVisible, false, `${island.id} (${expected}) has no Ask button`);
      }
    }

    const first = view.rows.find((row) => row.status === "frontier");
    const firstIsland = ISLANDS.find((island) => island.name === first.name);
    await page.click(".atlas-list-item.is-frontier .atlas-list-ask");
    await stub.waitFor(() => stub.posts.length >= 1, { what: "the Ask POST" });
    assert.deepEqual(stub.posts, [{ message: firstIsland.teaser, status: 200 }], "Ask sends the teaser");
    await waitReply(page, stub, 1);

    await page.click("#atlas-view-map");
    const back = await page.eval(`(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return {
        mapVisible: !document.querySelector("#atlas-map").hidden && box(document.querySelector("#atlas-map")),
        listHidden: document.querySelector("#atlas-list").hidden,
        pressed: { map: document.querySelector("#atlas-view-map").getAttribute("aria-pressed"), list: document.querySelector("#atlas-view-list").getAttribute("aria-pressed") },
      };
    })()`);
    assert.deepEqual(back, { mapVisible: true, listHidden: true, pressed: { map: "true", list: "false" } });
  });

  it("8. reload: the map comes back from sessionStorage, Clear map resets it, a draft blocks teasers", async (t) => {
    const { page, stub, url } = await openSite(t, "8-reload");
    stub.reply = () => HOOK_REPLY;
    await boot(page, url);
    await page.click(".atlas-chip");
    await waitReply(page, stub, 1);
    const expectedVisited = visitedAfter([START_ID], HOOK_REPLY);
    const before = await readAtlas(page);
    assertMatchesModel(before, expectedVisited, 1);

    // A half-written message before the reload.
    await page.click("#draft");
    await page.type("a half written question");
    assert.equal((await readAtlas(page)).draft, "a half written question");

    await page.reload();
    await page.waitFor(`(document.querySelector("#atlas-count")?.textContent || "").length > 0`, { what: "the Atlas to paint after the reload" });
    await page.waitFor(`document.querySelector("#phase").textContent.trim() === "ready"`, { what: "the chat to be ready after the reload" });
    const restored = await readAtlas(page);
    assertMatchesModel(restored, expectedVisited, 1);
    assert.deepEqual(restored.session, before.session, "sessionStorage survived the reload");
    assert.deepEqual(restored.localKeys, [], "still no localStorage");
    assert.equal(restored.flared.length, 0, "a restored map does not flare");
    t.diagnostic(`draft box after the reload: ${JSON.stringify(restored.draft)}`);

    // The draft rule holds whatever the chat did with the half-written text: with text in the
    // box teasers are refused, with an empty box they work.
    await page.click("#draft");
    if (restored.draft === "") await page.type("typed again after the reload");
    const withDraft = await readAtlas(page);
    assert.notEqual(withDraft.draft.trim(), "");
    assertPaused(withDraft, "with a draft in the box");
    await page.clickIsland(idsWithStatus(withDraft, "frontier")[0]);
    await page.click(".atlas-chip");
    await sleep(250);
    assert.equal(stub.posts.length, 1, "a non-empty draft stops teaser taps");
    await page.click("#draft");
    await page.clearFocused();
    await page.waitFor(`document.querySelector("#atlas-suggest .atlas-chip") && !document.querySelector("#atlas-suggest .atlas-chip").disabled`, {
      what: "chips to come back when the draft is empty",
    });
    assertEnabled(await readAtlas(page), "empty draft");

    // Clear map.
    await page.click("#atlas-reset");
    const cleared = await readAtlas(page);
    assertMatchesModel(cleared, [START_ID], 0);
    assert.equal(cleared.count, `1 of ${ISLANDS.length} visited`);
    assert.equal(cleared.inked, false, "the edge dragon is faint again");
    assert.deepEqual(cleared.session, { v: 1, visited: [START_ID], replies: 0 });
    assert.deepEqual(cleared.chips.map((chip) => chip.text), [FIRST_SUGGESTION], "the first question is back");

    // And it stays cleared across another reload.
    await page.reload();
    await page.waitFor(`(document.querySelector("#atlas-count")?.textContent || "").length > 0`, { what: "the Atlas to paint after the second reload" });
    assertMatchesModel(await readAtlas(page), [START_ID], 0);
  });

  it("9. safety: model markup is shown as plain text and never becomes elements", async (t) => {
    const { page, stub, url } = await openSite(t, "9-safety");
    const target = INDEX.byId.get("the-pot");
    const term = target.terms.find((candidate) => classifyTerm(candidate) === "phrase");
    assert.ok(term, "the-pot has a phrase term to put inside the markup");
    const hostile = `<img src=x onerror="document.title=1"> <b>${term}</b> <script>document.title=2</script>`;
    stub.reply = () => hostile;
    const lit = matchReply(hostile, GLOSSARY);
    assert.ok(lit.includes(target.id), "the plain-text term inside the markup names an island");
    await boot(page, url);
    const titleBefore = await page.eval(`document.title`);
    const baseline = await page.eval(`document.querySelectorAll("img, b, [onerror]").length`);
    assert.equal(baseline, 0, "precondition: the page has no img or b elements");

    await page.click(".atlas-chip");
    await waitReply(page, stub, 1);
    const snap = await readAtlas(page);
    const dom = await page.eval(`({
      elements: document.querySelectorAll("img, b, [onerror], #atlas script, #conversation script").length,
      title: document.title,
      historyHtml: document.querySelector("#history").innerHTML,
    })`);
    assert.equal(dom.elements, 0, "no <img>, <b>, onerror attribute or <script> was created from the reply");
    assert.equal(dom.title, titleBefore, "document.title did not change");
    assert.equal(snap.history.at(-1).text, hostile, "the history row holds the reply as text");
    assert.equal(snap.history.at(-1).children, 0);
    assert.ok(dom.historyHtml.includes("&lt;img"), "the markup is escaped text in the history");
    for (const id of lit) assert.equal(snap.islands[id].status, "visited", `${id} (named in plain text) is visited`);
    assert.ok(!stub.requests.some((request) => request.path === "/x"), "no image request was made");
    assertMatchesModel(snap, visitedAfter([START_ID], hostile), 1);
  });

  it("10. CSP and console: no violations, no exceptions, no inline styles or scripts", async (t) => {
    // A short tour through the interactive parts first.
    const { page, stub, url } = await openSite(t, "10-tour");
    stub.reply = () => HOOK_REPLY;
    await boot(page, url);
    await page.click(".atlas-chip");
    await waitReply(page, stub, 1);
    await page.clickIsland("isp-commitment");
    await page.clickIsland("the-pot");
    await page.eval(`document.querySelector('#atlas-map [data-id="${START_ID}"]').focus()`);
    for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Escape"]) await page.press(key);
    await page.click("#atlas-view-list");
    await page.click("#atlas-view-map");
    await page.click("#atlas-reset");
    await sleep(100);

    const dom = await page.eval(`(() => {
      const styled = Array.from(document.querySelectorAll("[style]")).map((el) => el.tagName + "." + (el.getAttribute("class") || "") + " style=" + el.getAttribute("style"));
      return {
        styled,
        inlineScriptsInAtlas: document.querySelectorAll("#explore script:not([src])").length,
        inlineStylesInAtlas: document.querySelectorAll("#explore style").length,
        inlineScriptsAnywhere: document.querySelectorAll("script:not([src])").length,
        styleElements: document.querySelectorAll("style").length,
        handlers: document.querySelectorAll("[onclick], [onerror], [onload], [onfocus]").length,
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
        violations: window.__cspViolations,
      };
    })()`);
    assert.deepEqual(dom.violations, [], "Chrome reported no securitypolicyviolation event");
    assert.deepEqual(dom.styled, [], "no element carries a style attribute");
    assert.equal(dom.inlineScriptsInAtlas, 0, "no inline <script> in the Atlas section");
    assert.equal(dom.inlineStylesInAtlas, 0, "no inline <style> in the Atlas section");
    assert.equal(dom.inlineScriptsAnywhere, 0, "no inline <script> anywhere");
    assert.equal(dom.styleElements, 0, "no <style> element anywhere");
    assert.equal(dom.handlers, 0, "no inline event handler attributes");
    assert.match(dom.csp, /default-src 'self'/);
    assert.deepEqual(stub.notFound, []);
    assert.deepEqual(stub.csrfFailures, [], "every state-changing request carried the CSRF token");
    const served = await fetch(url);
    assert.equal(served.headers.get("content-security-policy"), null, "the test server adds no CSP header: only the page's meta tag is enforced");

    // Positive control: the same meta tag really blocks an inline script in this Chrome, so a
    // clean console above means something. This tab is not part of the pooled diagnostics.
    const control = await openSite(t, "10-control", { diagnostics: [] });
    await control.page.goto(control.url);
    const blocked = await control.page.eval(`new Promise((resolve) => {
      let violated = null;
      document.addEventListener("securitypolicyviolation", (event) => { violated = event.violatedDirective; });
      window.__inlineRan = false;
      const script = document.createElement("script");
      script.textContent = "window.__inlineRan = true";
      document.head.appendChild(script);
      setTimeout(() => resolve({ ran: window.__inlineRan, violated }), 100);
    })`);
    assert.equal(blocked.ran, false, "an inline script does not run under the shipped CSP");
    assert.match(String(blocked.violated), /script-src|default-src/, "Chrome reported the violation");

    // Everything every earlier test collected.
    const pooled = diagnostics.filter((entry) => entry.test !== "10-control");
    assertQuiet(pooled, "all pages so far");
    const { knownMetaNotes } = classifyDiagnostics(pooled);
    if (knownMetaNotes.length) {
      t.diagnostic(
        `known note seen ${knownMetaNotes.length}x (not an Atlas issue, comes from index.html's CSP meta tag): ${knownMetaNotes[0].text}`,
      );
    }
  });

  it("11. no JavaScript: the plain index lists every place by region and the map stays out of the way", async (t) => {
    const { page, stub, url } = await openSite(t, "11-no-js", { scriptsDisabled: true });

    // The raw HTML, as shipped.
    const raw = await (await fetch(url)).text();
    const begin = raw.indexOf("<!-- atlas-index:begin -->");
    const end = raw.indexOf("<!-- atlas-index:end -->");
    assert.ok(begin > 0 && end > begin, "the generated index sits between its markers");
    const decode = (text) =>
      text
        .replace(/&middot;/g, "·")
        .replace(/&rsquo;/g, "’")
        .replace(/&lsquo;/g, "‘")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
    const block = raw.slice(begin, end);
    const rawSections = block
      .split(/<h3>/)
      .slice(1)
      .map((part) => {
        const [heading, rest] = [part.slice(0, part.indexOf("</h3>")), part.slice(part.indexOf("</h3>"))];
        return { heading: decode(heading), names: [...rest.matchAll(/<li><strong>(.*?)<\/strong>/g)].map((match) => decode(match[1])) };
      });
    const expected = REGIONS.map((region) => ({
      heading: regionHeading(region),
      names: ISLANDS.filter((island) => island.region === region.id).map((island) => island.name),
    }));
    assert.deepEqual(rawSections, expected, "raw HTML: the noscript index lists every island, grouped by region");

    // The same through Chrome with script execution disabled (it renders <noscript> content).
    await page.goto(url);
    const dom = await page.eval(`(() => {
      const sections = [];
      for (const h3 of document.querySelectorAll("#atlas noscript h3")) {
        const ol = h3.nextElementSibling;
        sections.push({ heading: h3.textContent, names: Array.from(ol.querySelectorAll("li > strong")).map((s) => s.textContent) });
      }
      const box = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const toolbar = document.querySelector("#atlas-toolbar");
      const chatNote = document.querySelector("#conversation noscript p");
      return {
        sections,
        indexVisible: box(document.querySelector("#atlas noscript h3")),
        toolbarHidden: toolbar.hidden && !box(toolbar),
        count: document.querySelector("#atlas-count").textContent,
        mapChildren: document.querySelector("#atlas-map").children.length,
        chips: document.querySelectorAll("#atlas-suggest .atlas-chip").length,
        chatNote: chatNote ? chatNote.textContent : null,
      };
    })()`);
    assert.deepEqual(dom.sections, expected, "rendered noscript index matches the graph");
    assert.equal(dom.indexVisible, true, "the plain index is visible");
    assert.equal(dom.toolbarHidden, true, "the toolbar stays hidden");
    assert.equal(dom.count, "");
    assert.equal(dom.mapChildren, 0, "no map is drawn");
    assert.equal(dom.chips, 0, "no suggestion chips");
    assert.match(String(dom.chatNote), /Conversation controls need JavaScript/, "the chat explains that it needs JavaScript");
    assert.deepEqual(stub.posts, []);
    assertQuiet(page.diagnostics.filter((entry) => entry.test === "11-no-js"), "no-JS page");
  });

  for (const [width, height] of [
    [1400, 1000],
    [1280, 800],
  ]) {
    it(`13. chat card at ${width}x${height}: after tapping a place the chips, the newest answer, the box and Send are all on screen`, async (t) => {
      const { page, stub, url } = await openSite(t, `13-card-${width}x${height}`, { width, height });
      const SECOND_REPLY =
        "The pot is where the month's commitments wait before they are shared out. Your ISP puts the monthly commitment in, and app payouts come out. Figures are illustrative.";
      stub.reply = (_message, n) => (n === 1 ? HOOK_REPLY : n === 2 ? SECOND_REPLY : `The debt is settled once a month. ${SECOND_REPLY}`);
      await boot(page, url);
      await page.click(".atlas-chip");
      await waitReply(page, stub, 1);

      // A visitor with the map in view taps a place that is next to explore. Nothing is scrolled for them.
      await scrollToAtlas(page);
      await page.clickInView(`#atlas-map [data-id="the-pot"] .atlas-hit`, { within: ".atlas-island" });
      const before = await page.eval(`scrollY`);
      await stub.waitFor(() => stub.posts.length >= 2, { what: "the tap's POST" });
      assert.deepEqual(stub.posts[1], { message: INDEX.byId.get("the-pot").teaser, status: 200 });
      await waitReply(page, stub, 2);
      await sleep(150);

      const m = await page.eval(READ_CARD);
      const screen = { top: 0, bottom: m.viewport.height };
      assert.equal(m.scrollY, before, "the page was not scrolled by the answer arriving");
      assert.ok(inside(m.card, screen), `the card is on screen: ${JSON.stringify(m.card)}`);
      assert.ok(m.cardScroll.height <= m.cardScroll.client + 1, `the card itself does not scroll (${m.cardScroll.height} > ${m.cardScroll.client})`);
      assert.equal(m.cardScroll.top, 0);
      assert.ok(m.chips.length >= 1, "there are suggestion chips");
      for (const chip of m.chips) assert.ok(inside(chip, m.card) && inside(chip, screen), `a chip is fully visible: ${JSON.stringify(chip)}`);
      for (const [name, box] of [["message box", m.textarea], ["Send", m.send], ["status line", m.phase]]) {
        assert.ok(inside(box, m.card) && inside(box, screen), `the ${name} is visible: ${JSON.stringify(box)}`);
      }
      assert.ok(m.rowCount >= 4, "the history holds both turns");
      assert.ok(m.history.height >= 110, `the history has room to read in (${Math.round(m.history.height)} px)`);
      assert.ok(m.lastRow && inside(m.lastRow, m.history), `the newest answer is fully visible inside the history: ${JSON.stringify(m.lastRow)} in ${JSON.stringify(m.history)}`);
      assert.ok(
        m.historyScroll.height - m.historyScroll.top - m.historyScroll.client <= 2,
        `the history is scrolled to its newest row (${JSON.stringify(m.historyScroll)})`,
      );
      assert.notEqual(m.activeId, "history", "scrolling the history did not move focus into it");
      assert.notEqual(m.activeId, "draft", "the tap did not steal focus into the message box");
      assert.ok(m.order.historyBeforeProvider && m.order.historyBeforeDraft && m.order.sendBeforePhase, "DOM order = visual order");

      // The visitor sends something of their own: the history follows it down again.
      await page.click("#draft");
      await page.type("And what about the debt?");
      await page.click("#send");
      await waitReply(page, stub, 3);
      const own = await page.eval(READ_CARD);
      assert.ok(
        own.historyScroll.height - own.historyScroll.top - own.historyScroll.client <= 2,
        `after the visitor's own send the history is at its newest row (${JSON.stringify(own.historyScroll)})`,
      );

      // The history is a keyboard stop right after the chips, and shows a focus ring when it has focus.
      await page.eval(`Array.from(document.querySelectorAll("#atlas-suggest .atlas-chip")).at(-1).focus()`);
      await page.press("Tab");
      const stop = await page.eval(`(() => {
        const a = document.activeElement;
        const s = a ? getComputedStyle(a) : null;
        return { id: a ? a.id : "", focusVisible: !!a && a.matches(":focus-visible"), outlineStyle: s && s.outlineStyle, outlineWidth: s && s.outlineWidth };
      })()`);
      assert.equal(stop.id, "history", "Tab from the last suggestion lands on the history");
      assert.equal(stop.focusVisible, true);
      assert.ok(stop.outlineStyle !== "none" && stop.outlineWidth !== "0px", `the history shows a focus ring: ${stop.outlineStyle} ${stop.outlineWidth}`);

      // P4: the status line and the history rows read well (WCAG AA body text is 4.5:1).
      const contrast = await page.eval(READ_CONTRAST);
      assert.ok(contrast.phaseText.length > 0);
      assert.ok(contrast.phase >= 4.5, `status line contrast ${contrast.phase.toFixed(2)}:1`);
      assert.ok(contrast.rows.length >= 4);
      for (const ratio of contrast.rows) assert.ok(ratio >= 4.5, `history row contrast ${ratio.toFixed(2)}:1`);

      await page.screenshot(path.join(OUT_DIR, `chat-card-${width}x${height}.png`));
    });
  }

  it("12. reduced motion: no pulse on the frontier, no expanding flare", async (t) => {
    const { page, stub, url } = await openSite(t, "12-reduced-motion");
    stub.reply = () => HOOK_REPLY;
    await boot(page, url);
    const haloSelector = `#atlas-map [data-id="${START_NEIGHBOURS[0]}"] .atlas-halo`;
    const animationOf = (selector) => page.eval(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).animationName`);

    // Control: with no preference the halo pulses, so "none" below really comes from the media query.
    assert.equal(await animationOf(haloSelector), "atlas-pulse", "control: a frontier halo pulses by default");
    await page.setReducedMotion(true);
    assert.equal(await animationOf(haloSelector), "none", "prefers-reduced-motion: the frontier halo does not pulse");
    await page.setReducedMotion(false);

    await page.click(".atlas-chip");
    const newIds = matchReply(HOOK_REPLY, GLOSSARY).filter((id) => id !== START_ID);
    await page.waitFor(`document.querySelectorAll("#atlas-map .is-flare").length === ${newIds.length}`, { what: "the flare" });
    const ringSelector = `#atlas-map [data-id="${newIds[0]}"] .atlas-flare-ring`;
    assert.equal(await animationOf(ringSelector), "atlas-flare", "control: the flare ring expands by default");
    await page.setReducedMotion(true);
    assert.equal(await animationOf(ringSelector), "none", "prefers-reduced-motion: the flare ring does not animate");
    const everything = await page.eval(`Array.from(document.querySelectorAll("#atlas-map *, #atlas-suggest *, #atlas-list *")).filter((el) => {
      const style = getComputedStyle(el);
      return style.animationName !== "none" || parseFloat(style.transitionDuration) > 0;
    }).map((el) => el.tagName + "." + (el.getAttribute("class") || ""))`);
    assert.deepEqual(everything, [], "nothing in the Atlas animates or transitions");
    await waitReply(page, stub, 1);
    await page.waitFor(`document.querySelectorAll("#atlas-map .is-flare").length === 0`, { what: "flare removed by its timer", timeout: 6000 });
    assertQuiet(page.diagnostics.filter((entry) => entry.test === "12-reduced-motion"), "reduced-motion page");
  });
});
