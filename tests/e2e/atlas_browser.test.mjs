/**
 * Browser end-to-end tests for the Atlas: the real site/index.html and the real js/atlas*.js
 * modules, driven in headless Chrome through the DevTools protocol (no npm packages: Node
 * built-ins only, see atlas_browser_support.mjs).
 *
 * The page is served from site/ by a node:http server that also answers the chat API calls the
 * conversation client makes (same origin, relative URLs). No Content-Security-Policy header is
 * added: the meta tag in index.html is what ships, and Chrome enforces it here.
 *
 * The conversation client in the page is chosen by ATLAS_CHAT (see atlas_browser_support.mjs):
 * "double" (the default) serves tests/fixtures/atlas_chat_double/app.js at /js/app.js, a
 * self-contained port of the working-tree client that paints like the live client, so this file passes on a clean
 * checkout whatever state site/js/app.js, api.js and state.js are in; "real" serves the working
 * tree's own client and is skipped, with the reason printed, when that tree cannot follow a
 * stream, fill the history, settle and send the CSRF header; "auto" picks real when it can.
 *
 * Island names, teasers and terms are never hardcoded: they are read from js/atlas-graph.js.
 * Only three first-load facts are written out on purpose (the start island, the first suggestion
 * and the edge dragon caption), because a visitor sees exactly those words on a first visit.
 *
 * Run: node --test --test-concurrency=1 tests/e2e/atlas_browser.test.mjs
 * (`node --test` runs FILES in parallel and each browser file starts its own Chrome: run the
 * browser files one at a time, as tests/e2e/test_atlas.py does.)
 * Chrome: /usr/bin/google-chrome, or the executable named by ATLAS_CHROME. Without a Chrome
 * the whole suite is skipped with the reason printed. Screenshots go to /tmp/atlas-e2e/.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { CLEAR_CONFIRM_LABEL, CLEAR_CONFIRM_MS, CLEAR_LABEL, NO_GLOSSARY_NOTICE, describeLit } from "../../site/js/atlas.js";
import { REJECT_PAUSE_MS } from "../../site/js/atlas-chat.js";
import { EDGES, EDGE_DRAGON_CAPTION, FIRST_SUGGESTION, ISLANDS, REGIONS, START_ID, buildIndex } from "../../site/js/atlas-graph.js";
import { classifyTerm, compileGlossary, matchReply } from "../../site/js/atlas-match.js";
import { regionHeading, statusWord, suggestionItems } from "../../site/js/atlas-panel.js";
import { deriveView } from "../../site/js/atlas-state.js";
import { CHAT_SETUP, OUT_DIR, SITE_DIR, findChrome, launchBrowser, sleep, startSite } from "./atlas_browser_support.mjs";

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

/** Every stub of this run: the last test audits all the traffic they saw. */
const allStubs = [];

/** Fresh server + stub + isolated browser context for one test. Cleaned up even on failure. */
async function openSite(t, label, pageOptions = {}) {
  const site = await startSite();
  allStubs.push({ label, stub: site.stub });
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
      return !!chip && chip.getAttribute("aria-disabled") !== "true" && document.querySelector("#phase").textContent.trim() === "ready";
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
    // The question a tap would send. A chip on the open list also carries a small "open, not ratified" tag.
    text: (chip.querySelector(".atlas-chip-text") || chip).textContent,
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
  const announce = q("#atlas-announce");
  const history = Array.from(document.querySelectorAll("#history li > p")).map((p) => ({ text: p.textContent, children: p.children.length }));
  return {
    count: q("#atlas-count") ? q("#atlas-count").textContent : null,
    islands,
    edges,
    chips,
    asks,
    notice: q("#atlas-notice") ? q("#atlas-notice").textContent.trim() : null,
    announce: announce ? announce.textContent.trim() : null,
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

/** Clear map is two presses: arm, then confirm. */
async function clearMap(page) {
  await page.click("#atlas-reset");
  await page.click("#atlas-reset");
}

/** A suggestion chip is there and not paused. Paused chips are aria-disabled, never `disabled`. */
const CHIP_ENABLED = `(() => { const chip = document.querySelector("#atlas-suggest .atlas-chip"); return !!chip && chip.getAttribute("aria-disabled") !== "true"; })()`;
const CHIP_BLOCKED = `(() => { const chip = document.querySelector("#atlas-suggest .atlas-chip"); return !!chip && chip.getAttribute("aria-disabled") === "true"; })()`;

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
    suggestionItems(view, { visited }),
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

/**
 * Every revealed-but-not-visited island, chip and Ask button is paused: aria-disabled="true", and
 * NOT the `disabled` attribute (a disabled control drops keyboard focus). With `notice: false` (the
 * visitor has text in the message box) no explanation is written anywhere.
 */
function assertPaused(snap, label, { notice = true } = {}) {
  const frontier = idsWithStatus(snap, "frontier");
  assert.ok(frontier.length > 0, `${label}: there are frontier islands to check`);
  for (const id of frontier) assert.equal(snap.islands[id].ariaDisabled, "true", `${label}: frontier island ${id} is aria-disabled`);
  assert.ok(snap.chips.length > 0, `${label}: there are chips to check`);
  for (const chip of snap.chips) {
    assert.equal(chip.ariaDisabled, "true", `${label}: chip "${chip.text}" is aria-disabled`);
    assert.equal(chip.disabled, false, `${label}: chip "${chip.text}" keeps focus: it is not the disabled attribute`);
  }
  for (const ask of snap.asks) {
    assert.equal(ask.ariaDisabled, "true", `${label}: Ask button "${ask.text}" is aria-disabled`);
    assert.equal(ask.disabled, false, `${label}: Ask button "${ask.text}" is not the disabled attribute`);
  }
  if (notice) assert.ok(snap.notice && snap.notice.length > 0, `${label}: the notice says why`);
  else assert.equal(snap.notice, "", `${label}: no explanation is written for the visitor's own draft`);
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

/** The toolbar at the top of the screen (under the sticky header): the map fills the rest. */
const scrollToMap = (page) =>
  page.eval(`(document.querySelector("#atlas-toolbar").scrollIntoView({ block: "start", behavior: "instant" }), true)`);

/** Everything the chat-card layout tests look at, in viewport pixels. */
const READ_CARD = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
  const card = document.querySelector("#conversation");
  const history = document.querySelector("#history");
  const chatChips = card.querySelectorAll(".atlas-chip, #atlas-suggest").length;
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
    chatChips,
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

describe("Atlas in a real browser", { skip: CHROME.path ? CHAT_SETUP.skip : CHROME.reason, timeout: 240000 }, () => {
  before(async (t) => {
    t.diagnostic(CHAT_SETUP.label);
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
    assert.equal(snap.chips[0].ariaDisabled, null, "the first suggestion is enabled");
    assert.equal(snap.chips[0].disabled, false);
    const chipPlace = await page.eval(`(() => {
      const atlas = document.querySelector("#atlas");
      const chip = document.querySelector("#atlas-suggest");
      const nodes = Array.from(atlas.children);
      const at = (el) => nodes.indexOf(el);
      return {
        inAtlas: atlas.contains(chip),
        inChat: document.querySelector("#conversation").contains(chip),
        underHonesty: at(chip) === at(document.querySelector(".atlas-honesty")) + 1,
        beforeToolbar: at(chip) < at(document.querySelector("#atlas-toolbar")),
        label: chip.getAttribute("aria-label"),
      };
    })()`);
    assert.deepEqual(chipPlace, { inAtlas: true, inChat: false, underHonesty: true, beforeToolbar: true, label: "Suggested questions" }, "the chips sit in the Atlas card, under the honesty note and above the toolbar");

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

    assert.equal(
      snap.announce,
      describeLit(newIds.map((id) => INDEX.byId.get(id).name), expectedVisited.length, ISLANDS.length),
      "the polite status element names what lit",
    );
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
      await page.waitFor(CHIP_ENABLED, {
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
      await page.waitFor(CHIP_ENABLED, {
        what: "the chip to come back although the refused text is still in the box",
      });
      const resumed = await readAtlas(page);
      assert.equal(resumed.draft, FIRST_SUGGESTION, "the refused text is still in the box");
      assertEnabled(resumed, "own text in the box after the pause");

      // Whatever the visitor adds to it is theirs, and blocks teasers with the usual message.
      await page.type(" and my own words");
      await page.waitFor(CHIP_BLOCKED, { what: "the chip to be blocked by typed text" });
      const typed = await readAtlas(page);
      assert.equal(typed.draft, `${FIRST_SUGGESTION} and my own words`);
      assertPaused(typed, "typed text in the box", { notice: false });
      assert.equal(stub.posts.length, 1, "nothing was sent while the box held the visitor's text");
      for (let i = 0; i < " and my own words".length; i += 1) await page.press("Backspace");
      await page.waitFor(CHIP_ENABLED, { what: "the chip to come back when the text is the bridge's own again" });

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
    await page.waitFor(CHIP_ENABLED, {
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
    assertPaused(withDraft, "with a draft in the box", { notice: false });
    await page.clickIsland(idsWithStatus(withDraft, "frontier")[0]);
    await page.click(".atlas-chip");
    await sleep(250);
    assert.equal(stub.posts.length, 1, "a non-empty draft stops teaser taps");
    await page.click("#draft");
    await page.clearFocused();
    await page.waitFor(CHIP_ENABLED, {
      what: "chips to come back when the draft is empty",
    });
    assertEnabled(await readAtlas(page), "empty draft");

    // Clear map takes two presses. One only arms it, and it disarms itself.
    const resetState = () =>
      page.eval(`(() => {
        const button = document.querySelector("#atlas-reset");
        return { text: button.textContent, confirming: button.classList.contains("is-confirming"), width: Math.round(button.getBoundingClientRect().width) };
      })()`);
    const idle = await resetState();
    assert.deepEqual({ text: idle.text, confirming: idle.confirming }, { text: CLEAR_LABEL, confirming: false });
    await page.click("#atlas-reset");
    const armed = await resetState();
    assert.deepEqual({ text: armed.text, confirming: armed.confirming }, { text: CLEAR_CONFIRM_LABEL, confirming: true }, "the first press asks for confirmation");
    assert.equal(armed.width, idle.width, "the button does not change width, so the toolbar does not shift");
    assertMatchesModel(await readAtlas(page), expectedVisited, 1);
    assert.match((await readAtlas(page)).announce, /again/i, "the status element says to press again");
    await page.waitFor(`document.querySelector("#atlas-reset").textContent === ${JSON.stringify(CLEAR_LABEL)}`, {
      what: "the button to disarm itself",
      timeout: CLEAR_CONFIRM_MS + 3000,
    });
    assertMatchesModel(await readAtlas(page), expectedVisited, 1);
    await page.click("#atlas-reset");
    await page.click("#atlas-reset");
    const cleared = await readAtlas(page);
    assert.equal((await resetState()).text, CLEAR_LABEL, "the button is a plain button again");
    assert.equal(cleared.announce, `Map cleared. 1 of ${ISLANDS.length} visited.`);
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
    await clearMap(page);
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
    assert.ok(!/<ol[\s>]/.test(block), "the plain index is a bulleted list: the open (dragon) items must not read as a numbered to-do list");
    assert.equal((block.match(/<ul>/g) || []).length, REGIONS.length, "one bulleted list per region");

    // The same through Chrome with script execution disabled (it renders <noscript> content).
    await page.goto(url);
    const dom = await page.eval(`(() => {
      const sections = [];
      for (const h3 of document.querySelectorAll("#atlas noscript h3")) {
        // The open-list heading is followed by a one-sentence framing paragraph before its list.
        let list = h3.nextElementSibling;
        while (list && list.tagName !== "UL" && list.tagName !== "OL") list = list.nextElementSibling;
        sections.push({ heading: h3.textContent, tag: list.tagName, listStyle: getComputedStyle(list.querySelector("li")).listStyleType, names: Array.from(list.querySelectorAll("li > strong")).map((s) => s.textContent) });
      }
      const box = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const toolbar = document.querySelector("#atlas-toolbar");
      const chatNote = document.querySelector("#conversation noscript p");
      const shown = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return "missing";
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? "shown" : "hidden";
      };
      return {
        sections,
        parts: {
          honesty: shown(".atlas-honesty"),
          intro: shown(".atlas-intro"),
          legend: shown(".atlas-legend"),
          heroNote: shown(".hero-cta-note"),
          heroLink: shown(".hero-cta-link"),
          suggest: shown("#atlas-suggest .atlas-chip"),
          notice: shown("#atlas-notice"),
        },
        indexVisible: box(document.querySelector("#atlas noscript h3")),
        toolbarHidden: toolbar.hidden && !box(toolbar),
        count: document.querySelector("#atlas-count").textContent,
        mapChildren: document.querySelector("#atlas-map").children.length,
        chips: document.querySelectorAll("#atlas-suggest .atlas-chip").length,
        chatNote: chatNote ? chatNote.textContent : null,
      };
    })()`);
    assert.deepEqual(
      dom.sections.map(({ heading, names }) => ({ heading, names })),
      expected,
      "rendered noscript index matches the graph",
    );
    for (const section of dom.sections) {
      assert.equal(section.tag, "UL", `${section.heading}: a bulleted list`);
      assert.notEqual(section.listStyle, "decimal", `${section.heading}: no numbering`);
    }
    assert.deepEqual(
      dom.parts,
      { honesty: "shown", intro: "hidden", legend: "hidden", heroNote: "hidden", heroLink: "shown", suggest: "missing", notice: "hidden" },
      "without JavaScript only the honesty note and the plain index describe the Atlas: no sentence about a map, chips or a legend",
    );
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
    it(`13. chat card at ${width}x${height}: after tapping a place the newest answer, the box and Send are on screen, with the chips beside the map`, async (t) => {
      const { page, stub, url } = await openSite(t, `13-card-${width}x${height}`, { width, height });
      const SECOND_REPLY =
        "The pot is where the month's commitments wait before they are shared out. Your ISP puts the monthly commitment in, and app payouts come out. Figures are illustrative.";
      stub.reply = (_message, n) => (n === 1 ? HOOK_REPLY : n === 2 ? SECOND_REPLY : `The debt is settled once a month. ${SECOND_REPLY}`);
      await boot(page, url);
      await page.click(".atlas-chip");
      await waitReply(page, stub, 1);

      // At the top of the Atlas the new suggestions are on screen, above the map and outside the chat card.
      await scrollToAtlas(page);
      const top = await page.eval(READ_CARD);
      assert.ok(top.chips.length >= 1, "there are suggestion chips");
      assert.equal(top.chatChips, 0, "the chat card holds no chips: they live in the Atlas card");
      for (const chip of top.chips) {
        assert.ok(inside(chip, { top: 0, bottom: top.viewport.height }), `a chip is fully visible next to the map: ${JSON.stringify(chip)}`);
      }

      // A visitor with the map in view taps a place that is next to explore. Nothing is scrolled for them.
      await scrollToMap(page);
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

      // The history is the first keyboard stop of the chat card (right after the map), and shows a focus ring when it has focus.
      await page.eval(`document.querySelector('#atlas-map [tabindex="0"]').focus()`);
      await page.press("Tab");
      const stop = await page.eval(`(() => {
        const a = document.activeElement;
        const s = a ? getComputedStyle(a) : null;
        return { id: a ? a.id : "", focusVisible: !!a && a.matches(":focus-visible"), outlineStyle: s && s.outlineStyle, outlineWidth: s && s.outlineWidth };
      })()`);
      assert.equal(stop.id, "history", "Tab from the map lands on the history");
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

  // -------------------------------------------------------------------------------------------
  // review fixes: discoverability, wording, focus, layout stability, spoken summary, warm-up, traffic
  // -------------------------------------------------------------------------------------------

  /** Seed the saved map, reload, and wait until the Atlas has painted it. */
  async function seedAndReload(page, visited, replies = 1) {
    await page.eval(`sessionStorage.setItem("esp-atlas", ${JSON.stringify(JSON.stringify({ v: 1, visited, replies }))}); true`);
    await page.reload();
    await page.waitFor(`(document.querySelector("#atlas-count")?.textContent || "").length > 0`, { what: "the Atlas to paint the seeded map" });
    await page.waitFor(`document.querySelectorAll("#atlas-map .is-flare").length === 0`, { what: "no flare" });
  }

  /** Let a smooth scroll come to rest. */
  const settleScroll = (page) =>
    page.waitFor(
      `new Promise((resolve) => {
        let last = scrollY;
        setTimeout(() => { const now = scrollY; resolve(now === last && now > 0 ? now : false); }, 250);
      })`,
      { what: "the page to stop scrolling", timeout: 8000, interval: 50 },
    );

  for (const [width, height] of [
    [1400, 1000],
    [1280, 800],
    [390, 844],
  ]) {
    it(`14. discoverability at ${width}x${height}: the nav and the hero lead to the Atlas, and its first question is on screen beside the map`, async (t) => {
      const { page, url } = await openSite(t, `14-discover-${width}x${height}`, { width, height });
      await boot(page, url);

      const top = await page.eval(`(() => {
        window.scrollTo({ top: 0, behavior: "instant" });
        const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const nav = document.querySelector('.nav-links a[href="#explore"]');
        const cta = document.querySelector('.hero-cta-link[href="#explore"]');
        const note = document.querySelector(".hero-cta-note");
        const order = ["#about", "#esp", "#clear-ledger", "#explore"].map((selector) => document.querySelector(selector));
        const inOrder = order.every((el, i) => i === 0 || !!(order[i - 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
        return {
          nav: nav ? { text: nav.textContent.trim(), box: box(nav) } : null,
          navLinks: Array.from(document.querySelectorAll(".nav-links a")).map((a) => a.getAttribute("href")),
          cta: cta ? { text: cta.textContent.trim(), box: box(cta) } : null,
          note: note ? { hidden: note.hidden, text: note.textContent.trim(), box: box(note) } : null,
          inOrder,
          innerHeight,
          scrollPaddingTop: getComputedStyle(document.documentElement).scrollPaddingTop,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        };
      })()`);
      assert.deepEqual(top.navLinks, ["#about", "#esp", "#clear-ledger", "#explore"], "the nav gains one link, the others keep their order");
      assert.equal(top.nav.text, "The Atlas");
      assert.ok(top.nav.box.width > 0 && top.nav.box.height > 0, "the nav link is visible");
      assert.ok(top.cta, "the hero has a call to action");
      assert.ok(top.cta.box.bottom <= top.innerHeight, `the call to action is on the first screen (bottom ${Math.round(top.cta.box.bottom)} of ${top.innerHeight})`);
      assert.ok(top.cta.box.height >= 44, "the call to action is a 44px touch target");
      assert.equal(top.note.hidden, false, "the note about asking questions is shown once JavaScript runs");
      assert.match(top.note.text, /ask a question/i);
      assert.ok(top.inOrder, "About, ESP, Clear Ledger and the Atlas keep their order");
      assert.ok(parseFloat(top.scrollPaddingTop) >= 80, `scroll-padding-top clears the sticky header (${top.scrollPaddingTop})`);
      assert.ok(top.scrollWidth <= top.clientWidth, `the page does not scroll sideways (${top.scrollWidth} > ${top.clientWidth})`);

      // The nav link takes a visitor to the Atlas, not under the sticky header.
      await page.click('.nav-links a[href="#explore"]');
      await settleScroll(page);
      const landed = await page.eval(`(() => {
        const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
        const header = document.querySelector(".site-header").getBoundingClientRect();
        const chip = document.querySelector("#atlas-suggest .atlas-chip");
        return {
          headerBottom: header.bottom,
          title: box(document.querySelector("#atlas-title")),
          chip: box(chip),
          chipText: chip.textContent,
          map: box(document.querySelector("#atlas-map")),
          innerHeight,
          innerWidth,
        };
      })()`);
      assert.ok(landed.title.top >= landed.headerBottom, `the Atlas title is not under the sticky header (${Math.round(landed.title.top)} vs ${Math.round(landed.headerBottom)})`);
      assert.equal(landed.chipText, FIRST_SUGGESTION);
      assert.ok(landed.chip.bottom <= landed.innerHeight && landed.chip.top >= landed.headerBottom, `the first suggestion is on screen: ${JSON.stringify(landed.chip)}`);
      assert.ok(landed.chip.right <= landed.innerWidth, "the first suggestion is not cut off at the side");
      assert.ok(landed.map.top < landed.innerHeight - 40, `the top of the map is on screen with it (map top ${Math.round(landed.map.top)} of ${landed.innerHeight})`);
    });
  }

  it("15. dragons never read as a goal: inspector, list and map say \"open, not ratified\" until they are visited", async (t) => {
    const { page, url } = await openSite(t, "15-dragons");
    await boot(page, url);
    const dragons = ISLANDS.filter((island) => island.status === "open");
    assert.ok(dragons.length >= 9, "the graph has its dragons");
    const FORBIDDEN = /next to explore|not reached yet/i;

    // The pure rule first.
    for (const island of dragons) {
      assert.equal(statusWord("frontier", island), "open, not ratified", `${island.id} frontier`);
      assert.equal(statusWord("fogged", island), "open, not ratified", `${island.id} fogged`);
      assert.equal(statusWord("visited", island), "visited", `${island.id} visited`);
    }
    assert.equal(statusWord("frontier", INDEX.byId.get("the-pot")), "next to explore", "an ordinary place keeps its words");
    assert.equal(statusWord("fogged", INDEX.byId.get("the-pot")), "not reached yet");
    assert.equal(statusWord("frontier"), "next to explore");

    const readDragonRows = () =>
      page.eval(`Array.from(document.querySelectorAll("#atlas-list .atlas-list-item.is-open")).map((li) => ({
        name: li.querySelector(".atlas-list-name").textContent,
        status: li.querySelector(".atlas-list-status").textContent,
        cls: li.className,
        text: li.textContent,
        askShown: !!li.querySelector(".atlas-list-ask") && !li.querySelector(".atlas-list-ask").hidden,
      }))`);

    // 1. Only the start is visited: every dragon is in the fog.
    await page.click("#atlas-view-list");
    const fogged = await readDragonRows();
    assert.equal(fogged.length, dragons.length);
    for (const row of fogged) {
      assert.match(row.cls, /is-fogged/);
      assert.equal(row.status, "open, not ratified", `${row.name} (fogged)`);
      assert.doesNotMatch(row.text, FORBIDDEN, `${row.name} (fogged) row text`);
    }

    // 2. Everything except the dragons is visited: the dragons next to a visited place are on the frontier.
    const ordinary = ISLANDS.filter((island) => island.status !== "open").map((island) => island.id);
    const view = deriveView({ visited: ordinary, replies: 3 }, INDEX);
    const frontierDragons = dragons.filter((island) => view.status[island.id] === "frontier");
    assert.ok(frontierDragons.length >= 1, "some dragon is next to a visited place in this state");
    await seedAndReload(page, ordinary, 3);
    await page.click("#atlas-view-list");
    const frontierRows = await readDragonRows();
    for (const island of dragons) {
      const row = frontierRows.find((candidate) => candidate.name === island.name);
      const expected = view.status[island.id];
      assert.match(row.cls, new RegExp(`is-${expected}`), `${island.id} is ${expected}`);
      assert.equal(row.status, "open, not ratified", `${island.id} (${expected}) list status`);
      assert.doesNotMatch(row.text, FORBIDDEN, `${island.id} (${expected}) list row text`);
    }
    const asking = frontierRows.filter((row) => row.askShown);
    assert.ok(asking.length >= 1, "a dragon on the frontier can still be asked about, in its own words");

    // The map says the same, and the inspector for a frontier dragon too.
    const target = frontierDragons[0];
    const labelled = await page.eval(`document.querySelector('#atlas-map [data-id="${target.id}"]').getAttribute("aria-label")`);
    assert.match(labelled, /open, not ratified/);
    assert.doesNotMatch(labelled, FORBIDDEN, "the map's accessible name");
    await page.click("#atlas-view-map");
    assert.ok(await focusIsland(page, target.id), "the frontier dragon takes focus");
    await page.waitFor(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent === ${JSON.stringify(target.name)}`, {
      what: "the inspector to show the dragon",
    });
    const card = await page.eval(`document.querySelector("#atlas-inspector").textContent`);
    assert.match(card, /Status: open, not ratified/, "the inspector's status line");
    assert.doesNotMatch(card, FORBIDDEN, "the inspector card");
    assert.match(card, /open list/i, "the card says it is the designers' own open list");
    assert.doesNotMatch(card, /roadmap/i);

    // 3. A visited dragon is "visited", and its label keeps "open, not ratified".
    await seedAndReload(page, [...ordinary, target.id], 4);
    await page.click("#atlas-view-list");
    const visitedRow = (await readDragonRows()).find((row) => row.name === target.name);
    assert.equal(visitedRow.status, "visited");
    assert.match(visitedRow.text, /open, not ratified/, "the visited dragon's meta line keeps the label");
    await page.click("#atlas-view-map");
    assert.ok(await focusIsland(page, target.id));
    await page.waitFor(`document.querySelector("#atlas-inspector .atlas-inspector-status")?.textContent === "Status: visited"`, {
      what: "the visited dragon's status",
    });
    const visitedCard = await page.eval(`document.querySelector("#atlas-inspector").textContent`);
    assert.match(visitedCard, /open, not ratified/);
    assert.doesNotMatch(visitedCard, FORBIDDEN);
    assert.doesNotMatch(visitedCard, /learned/i);
  });

  it("16. focus survives a tap: chips and Ask buttons stay in the DOM and keep focus while paused and after the reply", async (t) => {
    const { page, stub, url } = await openSite(t, "16-focus");
    stub.reply = () => HOOK_REPLY;
    const release = stub.holdStreams();
    await boot(page, url);

    // Keyboard: focus the chip, press Enter.
    assert.equal(
      await page.eval(`(() => { const chip = document.querySelector("#atlas-suggest .atlas-chip"); window.__chip = chip; chip.focus(); return document.activeElement === chip; })()`),
      true,
      "the chip takes keyboard focus",
    );
    await page.press("Enter");
    await stub.waitFor(() => stub.posts.length >= 1, { what: "the chip's POST" });
    const READ_CHIP = `(() => ({
      focused: document.activeElement === window.__chip,
      connected: window.__chip.isConnected,
      inList: document.querySelector("#atlas-suggest").contains(window.__chip),
      ariaDisabled: window.__chip.getAttribute("aria-disabled"),
      disabled: window.__chip.disabled,
      describedBy: window.__chip.getAttribute("aria-describedby"),
      text: window.__chip.textContent,
    }))()`;
    const during = await page.eval(READ_CHIP);
    assert.deepEqual(
      { focused: during.focused, connected: during.connected, inList: during.inList, ariaDisabled: during.ariaDisabled, disabled: during.disabled, describedBy: during.describedBy },
      { focused: true, connected: true, inList: true, ariaDisabled: "true", disabled: false, describedBy: "atlas-notice" },
      "while the question runs the same chip is still there, focused, aria-disabled and pointing at the notice",
    );
    await page.press("Enter");
    await page.press(" ");
    await sleep(150);
    assert.equal(stub.posts.length, 1, "an aria-disabled chip does nothing when activated");

    release();
    await waitReply(page, stub, 1);
    const after = await page.eval(READ_CHIP);
    assert.equal(after.focused, true, "after the reply the same chip still has focus");
    assert.equal(after.connected, true, "the same chip element is still in the page after the reply");
    assert.equal(after.ariaDisabled, null, "and it is enabled again");
    assert.equal(after.describedBy, null);
    const view = deriveView({ visited: visitedAfter([START_ID], HOOK_REPLY), replies: 1 }, INDEX);
    assert.equal(
      after.text.startsWith(suggestionItems(view, { visited: visitedAfter([START_ID], HOOK_REPLY) })[0]),
      true,
      "its text is now the first of the new suggestions",
    );
    assertMatchesModel(await readAtlas(page), visitedAfter([START_ID], HOOK_REPLY), 1);

    // The list's Ask button: same rule.
    await page.click("#atlas-view-list");
    const ask = await page.eval(`(() => {
      const button = document.querySelector("#atlas-list .atlas-list-item.is-frontier .atlas-list-ask");
      window.__ask = button; button.focus();
      return { focused: document.activeElement === button, text: button.textContent };
    })()`);
    assert.equal(ask.focused, true, "the Ask button takes keyboard focus");
    stub.reply = (_message, n) => hookReplyFor(n);
    const hold = stub.holdStreams();
    await page.press("Enter");
    await stub.waitFor(() => stub.posts.length >= 2, { what: "the Ask POST" });
    assert.equal(stub.posts[1].message, ask.text);
    const askDuring = await page.eval(`({ same: document.activeElement === window.__ask, connected: window.__ask.isConnected, ariaDisabled: window.__ask.getAttribute("aria-disabled"), disabled: window.__ask.disabled, hidden: window.__ask.hidden })`);
    assert.deepEqual(askDuring, { same: true, connected: true, ariaDisabled: "true", disabled: false, hidden: false });
    hold();
    await waitReply(page, stub, 2);
    const askAfter = await page.eval(`({ body: document.activeElement === document.body, inList: !!document.activeElement.closest && !!document.activeElement.closest("#atlas-list"), tag: document.activeElement.tagName })`);
    assert.equal(askAfter.body, false, "focus is not dropped to the page when the place the button asked about is visited");
    assert.equal(askAfter.inList, true, `focus stays in the list (${askAfter.tag})`);
  });

  it("17. nothing moves while typing or while a question runs, and a pause is explained in one place", async (t) => {
    const { page, stub, url } = await openSite(t, "17-stable");
    stub.reply = () => HOOK_REPLY;
    await boot(page, url);
    await page.click("#atlas-view-map");

    // Document coordinates, so a scroll does not look like a move.
    const BOXES = `(() => {
      const r = (selector) => { const b = document.querySelector(selector).getBoundingClientRect(); return [b.left + scrollX, b.top + scrollY, b.width, b.height].map(Math.round); };
      return { suggest: r("#atlas-suggest"), notice: r("#atlas-notice"), toolbar: r("#atlas-toolbar"), map: r("#atlas-map"), inspector: r("#atlas-inspector"), draft: r("#draft"), send: r("#send"), phase: r("#phase"), card: r("#conversation") };
    })()`;
    const idle = await page.eval(BOXES);

    const noticeFacts = await page.eval(`(() => {
      const el = document.querySelector("#atlas-notice");
      const s = getComputedStyle(el);
      return { hidden: el.hidden, display: s.display, role: el.getAttribute("role"), height: el.getBoundingClientRect().height, text: el.textContent, lineHeight: parseFloat(s.lineHeight) };
    })()`);
    assert.equal(noticeFacts.hidden, false, "the notice is rendered while empty, so its live region exists before it speaks");
    assert.notEqual(noticeFacts.display, "none");
    assert.equal(noticeFacts.role, "status");
    assert.equal(noticeFacts.text, "");
    // Round 2 (F6), kept in the flow by round 3 (F24): empty, the notice reserves no blank band above the map;
    // beside the heading it takes no extra row at 900px and wider, which is what the "nothing moves" checks below prove.
    assert.ok(noticeFacts.height < noticeFacts.lineHeight, `an empty notice reserves no blank band (${noticeFacts.height}px, line ${noticeFacts.lineHeight}px)`);

    // 1. The visitor types: chips pause, nothing is written, nothing moves.
    await page.click("#draft");
    const afterClick = await page.eval(BOXES);
    await page.type("a");
    const typed = await page.eval(BOXES);
    assert.deepEqual(typed, afterClick, "typing the first character moves nothing");
    const snapTyped = await readAtlas(page);
    assertPaused(snapTyped, "typing", { notice: false });
    const extraText = await page.eval(`document.querySelectorAll(".atlas-suggest-paused, .atlas-list-paused, .atlas-pause-note").length`);
    assert.equal(extraText, 0, "no second copy of any pause message exists in the DOM");
    await page.clearFocused();
    await page.waitFor(CHIP_ENABLED, { what: "the chip to come back" });
    const cleared = await page.eval(BOXES);
    assert.deepEqual(cleared, afterClick, "clearing the box moves nothing either");

    // 2. A question runs: the notice speaks beside the heading, nothing around it moves.
    const release = stub.holdStreams();
    await page.click(".atlas-chip");
    await stub.waitFor(() => stub.posts.length >= 1, { what: "the chip's POST" });
    await page.waitFor(`document.querySelector("#atlas-notice").textContent.trim().length > 0`, { what: "the busy notice" });
    const busy = await page.eval(BOXES);
    for (const part of ["suggest", "toolbar", "map", "inspector"]) {
      assert.deepEqual(busy[part], idle[part], `${part} did not move when the notice appeared`);
    }
    assert.ok(busy.notice[3] > 0, "and the notice itself now has a box with the message in it");
    const snapBusy = await readAtlas(page);
    assertPaused(snapBusy, "busy");
    const message = snapBusy.notice;

    // The message is written once: in the notice. Not in the SVG, the list, a chip paragraph, a title or a label.
    const copies = await page.eval(`(() => {
      const message = ${JSON.stringify(message)};
      const textCopies = Array.from(document.querySelectorAll("body *"))
        .filter((el) => el.tagName !== "SCRIPT" && el.tagName !== "NOSCRIPT" && el.textContent.includes(message) && !Array.from(el.children).some((child) => child.textContent.includes(message)))
        .map((el) => el.tagName.toLowerCase() + "#" + el.id);
      const attrCopies = Array.from(document.querySelectorAll("[aria-label], [title], [aria-description]"))
        .filter((el) => ["aria-label", "title", "aria-description"].some((name) => (el.getAttribute(name) || "").includes(message)))
        .map((el) => el.tagName.toLowerCase() + "#" + el.id);
      const describedBy = {
        islands: Array.from(document.querySelectorAll('#atlas-map .atlas-island[aria-disabled="true"]')).map((g) => g.getAttribute("aria-describedby")),
        chips: Array.from(document.querySelectorAll('#atlas-suggest [aria-disabled="true"]')).map((b) => b.getAttribute("aria-describedby")),
        asks: Array.from(document.querySelectorAll('#atlas-list [aria-disabled="true"]')).map((b) => b.getAttribute("aria-describedby")),
      };
      return { textCopies, attrCopies, describedBy };
    })()`);
    assert.deepEqual(copies.textCopies, ["p#atlas-notice"], "the pause message is written in one visible place");
    assert.deepEqual(copies.attrCopies, [], "and in no accessible name or tooltip");
    assert.ok(copies.describedBy.islands.length > 0 && copies.describedBy.islands.every((value) => value === "atlas-notice"), "paused islands point at the notice");
    assert.ok(copies.describedBy.chips.every((value) => value === "atlas-notice"), "paused chips point at the notice");
    release();
    await waitReply(page, stub, 1);
    await page.waitFor(`document.querySelector("#atlas-notice").textContent === ""`, { what: "the notice to clear" });
  });

  it("18. spoken summary: after each reply a polite status element says which places lit", async (t) => {
    const { page, stub, url } = await openSite(t, "18-announce");
    stub.reply = (_message, n) => (n === 1 ? HOOK_REPLY : `${PLAIN_REPLY} (answer ${n})`);
    await boot(page, url);
    const facts = await page.eval(`(() => {
      const el = document.querySelector("#atlas-announce");
      const r = el.getBoundingClientRect();
      const inspector = document.querySelector("#atlas-inspector");
      return { role: el.getAttribute("role"), width: r.width, height: r.height, position: getComputedStyle(el).position, inspectorLive: inspector.hasAttribute("aria-live"), inspectorRole: inspector.getAttribute("role"), text: el.textContent };
    })()`);
    assert.equal(facts.role, "status");
    assert.ok(facts.width <= 1 && facts.height <= 1 && facts.position === "absolute", "the status element is visually hidden");
    assert.equal(facts.inspectorLive, false, "the inspector is not a live region: keyboard focus already announces a place");
    assert.equal(facts.text, "");

    await page.click(".atlas-chip");
    await waitReply(page, stub, 1);
    const newIds = matchReply(HOOK_REPLY, GLOSSARY).filter((id) => id !== START_ID);
    const names = newIds.map((id) => INDEX.byId.get(id).name);
    const expected = describeLit(names, 1 + newIds.length, ISLANDS.length);
    assert.match(expected, /^Lit: .+\. \d+ of \d+ visited\.$/);
    const said = (await readAtlas(page)).announce;
    assert.equal(said, expected);
    const listed = names.slice(0, 5);
    for (const name of listed) assert.ok(said.includes(name), `${name} is named`);
    if (names.length > 5) assert.ok(said.includes(`(+${names.length - 5} more)`), "the rest is counted");
    assert.ok(!said.includes(names[5] || "\u0000"), "no more than five names are listed");

    // A reply that lights nothing says so, and says it again for the next one that lights nothing.
    await sendViaComposer(page, stub, "tell me something general", 2);
    assert.equal((await readAtlas(page)).announce, "No new places lit.");
    await sendViaComposer(page, stub, "and another general question", 3);
    await page.waitFor(`document.querySelector("#atlas-announce").textContent === "No new places lit."`, { what: "the same sentence to be spoken again" });
    assert.equal((await readAtlas(page)).announce, "No new places lit.");
  });

  it("19. the matcher is warmed in idle time; an engine that cannot compile it gets an honest notice", async (t) => {
    const { page, url } = await openSite(t, "19-warm");
    await boot(page, url);
    await page.waitFor(`window.__idle.scheduled >= 1`, { what: "the Atlas to schedule its warm-up" });
    await page.waitFor(`window.__idle.ran >= 1`, { what: "the warm-up to run" });
    const quiet = await readAtlas(page);
    assert.equal(quiet.notice, "", "a working matcher shows no standing notice");

    // A browser whose RegExp cannot compile Unicode property classes: no term can be compiled.
    const broken = await openSite(t, "19-no-regexp", { diagnostics: [] });
    await broken.page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const Real = RegExp;
        window.RegExp = new Proxy(Real, {
          construct(target, args, newTarget) {
            if (typeof args[0] === "string" && args[0].includes("\\\\p{")) throw new SyntaxError("Invalid regular expression: unsupported property escape");
            return Reflect.construct(target, args, newTarget === window.RegExp ? target : newTarget);
          },
        });
      })();`,
    });
    broken.stub.reply = () => HOOK_REPLY;
    await broken.page.goto(broken.url);
    await broken.page.waitFor(`(document.querySelector("#atlas-count")?.textContent || "").length > 0 && document.querySelector("#phase").textContent.trim() === "ready"`, {
      what: "the Atlas to start without a matcher",
    });
    const notice = await readAtlas(broken.page);
    assert.equal(notice.notice, NO_GLOSSARY_NOTICE);
    assert.equal(NO_GLOSSARY_NOTICE, "This browser cannot read answers for the map; the list still works.");
    assert.equal(notice.count, `1 of ${ISLANDS.length} visited`);
    await broken.page.click("#atlas-view-list");
    const list = await broken.page.eval(`document.querySelectorAll("#atlas-list .atlas-list-item").length`);
    assert.equal(list, ISLANDS.length, "the list still works");
    // A question still goes out and is answered; the map just does not light.
    await broken.page.click(".atlas-chip");
    await waitReply(broken.page, broken.stub, 1);
    const after = await readAtlas(broken.page);
    assert.equal(after.count, `1 of ${ISLANDS.length} visited`, "nothing lit");
    assert.equal(after.history.length, 2, "the conversation itself is fine");
    assert.equal(after.announce, "No new places lit.");
  });

  it("20. CSS: touch targets, contrast, focus ring, forced colours and text zoom", async (t) => {
    const { page, stub, url } = await openSite(t, "20-css", { width: 1400, height: 1000 });
    stub.reply = () => HOOK_REPLY;
    await boot(page, url);
    await page.click(".atlas-chip");
    await waitReply(page, stub, 1);
    await page.click("#atlas-view-list");
    await page.click("#atlas-view-map");
    await page.press("Shift");

    const MEASURE = `(() => {
      const parse = (c) => (c.match(/[\\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const backgroundOf = (el) => {
        for (let node = el; node; node = node.parentElement) {
          const c = parse(getComputedStyle(node).backgroundColor);
          if (c.length === 3 || (c.length === 4 && c[3] > 0.99)) return c.slice(0, 3);
        }
        return [255, 255, 255];
      };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const textContrast = (el) => ratio(parse(getComputedStyle(el).color).slice(0, 3), backgroundOf(el));
      const borderContrast = (el, side = "Top") => ratio(parse(getComputedStyle(el)["border" + side + "Color"]).slice(0, 3), backgroundOf(el.parentElement || el));
      const h = (selector) => document.querySelector(selector).getBoundingClientRect().height;
      const chip = document.querySelector("#atlas-suggest .atlas-chip");
      chip.focus();
      const ring = getComputedStyle(chip);
      const fog = document.querySelector("#atlas-map .is-fogged .atlas-fog-dot");
      const sea = parse(getComputedStyle(document.querySelector("#atlas-map .atlas-sea")).fill);
      const tab = document.querySelector("#atlas-view-list");
      return {
        chipHeight: h("#atlas-suggest .atlas-chip"),
        sendHeight: h("#send"),
        cancelHeight: h("#cancel"),
        resetHeight: h("#atlas-reset"),
        tabHeight: h("#atlas-view-list"),
        chipText: textContrast(chip),
        chipBorder: borderContrast(chip),
        tabBorder: borderContrast(tab),
        outlineStyle: ring.outlineStyle,
        outlineWidth: ring.outlineWidth,
        outlineColor: parse(ring.outlineColor).slice(0, 3),
        cardColor: backgroundOf(chip.parentElement),
        fogFill: getComputedStyle(fog).fill,
        fogOpacity: getComputedStyle(fog).opacity,
        gap: (() => { const a = document.querySelector("#atlas-view-list").getBoundingClientRect(); const b = document.querySelector("#atlas-reset").getBoundingClientRect(); return b.left - a.right; })(),
      };
    })()`;
    const m = await page.eval(MEASURE);
    for (const key of ["chipHeight", "sendHeight", "cancelHeight", "resetHeight", "tabHeight"]) {
      assert.ok(m[key] >= 44, `${key} is at least 44px at 1400 (${m[key]})`);
    }
    assert.ok(m.chipText >= 4.5, `chip text contrast ${m.chipText.toFixed(2)}:1`);
    assert.ok(m.chipBorder >= 3, `chip border contrast ${m.chipBorder.toFixed(2)}:1`);
    assert.ok(m.tabBorder >= 3, `toolbar button border contrast ${m.tabBorder.toFixed(2)}:1`);
    assert.notEqual(m.outlineStyle, "none", "the focused chip has an outline");
    assert.ok(parseFloat(m.outlineWidth) >= 3, `its outline is 3px (${m.outlineWidth})`);
    assert.ok(m.gap >= 16, `Clear map sits apart from the Map and List toggles (${m.gap}px)`);

    // Fog dots and the focus ring against the dark card (non-text contrast, WCAG 1.4.11).
    const ratioOf = await page.eval(`(() => {
      const parse = (c) => (c.match(/[\\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const chip = document.querySelector("#atlas-suggest .atlas-chip");
      const fog = parse(getComputedStyle(document.querySelector("#atlas-map .is-fogged .atlas-fog-dot")).fill).slice(0, 3);
      const opacity = parseFloat(getComputedStyle(document.querySelector("#atlas-map .is-fogged .atlas-fog-dot")).opacity);
      const sea = parse(getComputedStyle(document.querySelector("#atlas-map .atlas-sea")).fill).slice(0, 3);
      const dot = fog.map((c, i) => c * opacity + sea[i] * (1 - opacity));
      const card = parse(getComputedStyle(document.querySelector("#atlas")).backgroundColor).slice(0, 3);
      chip.focus();
      const ring = parse(getComputedStyle(chip).outlineColor).slice(0, 3);
      return { fogOnSea: ratio(dot, sea), ringOnCard: ratio(ring, card) };
    })()`);
    assert.ok(ratioOf.fogOnSea >= 3, `a fogged place's dot is 3:1 against the sea (${ratioOf.fogOnSea.toFixed(2)}:1)`);
    assert.ok(ratioOf.ringOnCard >= 3, `the chip's focus ring is 3:1 against the card (${ratioOf.ringOnCard.toFixed(2)}:1)`);

    // Forced colours: text on the map keeps its glyphs on top of its halo.
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    const forced = await page.eval(`(() => {
      const pick = (selector) => { const el = document.querySelector(selector); const s = getComputedStyle(el); return { paintOrder: s.paintOrder, strokeWidth: s.strokeWidth, stroke: s.stroke }; };
      return { sub: pick(".atlas-region-sub"), name: pick(".atlas-region-name"), level: pick(".atlas-region-level"), caption: pick(".atlas-ed-caption"), label: pick(".atlas-label") };
    })()`);
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "none" }] });
    for (const [what, style] of Object.entries(forced)) {
      assert.match(style.paintOrder, /^stroke/, `forced colours: the halo of ${what} is painted under its glyphs (${style.paintOrder})`);
    }

    // Text at 200% on a 320px phone: the composer's buttons wrap instead of overflowing.
    const narrow = await openSite(t, "20-narrow", { width: 320, height: 700 });
    await boot(narrow.page, narrow.url);
    const plain = await narrow.page.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    assert.ok(plain <= 0, `at 320px and normal text the page does not scroll sideways (${plain}px)`);
    const zoomed = await narrow.page.eval(`(() => {
      document.documentElement.style.setProperty("font-size", "32px");
      const card = document.querySelector("#conversation");
      const cardBox = card.getBoundingClientRect();
      const buttons = ["#send", "#cancel"].map((selector) => document.querySelector(selector).getBoundingClientRect());
      return {
        cardRight: cardBox.right,
        buttons: buttons.map((b) => ({ left: b.left, right: b.right, top: b.top })),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cardOverflow: card.scrollWidth - card.clientWidth,
      };
    })()`);
    for (const button of zoomed.buttons) assert.ok(button.right <= zoomed.cardRight + 0.5, `a composer button stays inside the card (${button.right} > ${zoomed.cardRight})`);
    assert.ok(zoomed.cardOverflow <= 1, `the chat card does not scroll sideways (${zoomed.cardOverflow}px)`);
  });

  it("21. traffic: the Atlas adds nothing to what the chat sends, and asks for nothing of its own", async (t) => {
    // A last tour that uses every way of asking, on top of everything the earlier tests did.
    const { page, stub, url } = await openSite(t, "21-traffic");
    stub.reply = (_message, n) => hookReplyFor(n);
    await boot(page, url);
    await page.click(".atlas-chip");
    await waitReply(page, stub, 1);
    await page.click("#atlas-view-list");
    await page.click(".atlas-list-item.is-frontier .atlas-list-ask");
    await waitReply(page, stub, 2);
    await page.click("#atlas-view-map");
    await sendViaComposer(page, stub, "My own question, typed by hand.", 3);
    await page.click("#atlas-reset");
    await page.click("#atlas-reset");
    await page.reload();
    await page.waitFor(`(document.querySelector("#atlas-count")?.textContent || "").length > 0`);

    const CHAT_PATHS = [/^\/visitor-session$/, /^\/conversations$/, /^\/conversations\/conv-1\/(messages|events|history)$/, /^\/conversations\/conv-1\/status$/];
    const STATIC_PATHS = [/^\/$/, /^\/favicon\.ico$/, /^\/css\/[a-z-]+\.css$/, /^\/js\/[a-z-]+\.js$/];
    const KEYS = ["client_request_id", "conversation_id", "message"];
    let posts = 0;
    for (const { label, stub: seen } of allStubs) {
      for (const request of seen.requests) {
        const where = `${label}: ${request.method} ${request.url}`;
        const allowed = [...CHAT_PATHS, ...STATIC_PATHS].some((pattern) => pattern.test(request.path));
        assert.ok(allowed, `${where} is neither a chat endpoint nor a static file of the site`);
        if (request.path.startsWith("/js/") || request.path.startsWith("/css/")) {
          const file = path.join(SITE_DIR, request.path);
          assert.ok(fs.existsSync(file), `${where} names a file that exists in site/`);
        }
        assert.ok(!request.headers.some((name) => /atlas|island|visited/i.test(name)), `${where} carries no Atlas header: ${request.headers.join(",")}`);
        if (!/^\/(css|js)\//.test(request.path)) {
          const query = new URL(request.url, "http://x.invalid").searchParams;
          const keys = [...query.keys()];
          assert.deepEqual(keys, request.path.endsWith("/status") ? ["client_request_id"] : [], `${where}: no query parameter beyond the chat's own`);
        }
        if (request.path === "/conversations/conv-1/messages") {
          posts += 1;
          assert.equal(request.method, "POST");
          assert.deepEqual(Object.keys(request.body || {}).sort(), KEYS, `${where}: the body has exactly conversation_id, client_request_id and message`);
          assert.equal(request.body.conversation_id, "conv-1");
          assert.equal(typeof request.body.client_request_id, "string");
          assert.ok(request.body.client_request_id.length > 0);
          assert.equal(typeof request.body.message, "string");
        }
        if (request.path === "/conversations") assert.deepEqual(Object.keys(request.body || {}), ["provider"], `${where}: only the provider`);
        if (request.path === "/visitor-session") assert.deepEqual(request.body, {}, `${where}: no body`);
      }
    }
    assert.ok(posts >= 20, `the audit looked at ${posts} message POSTs across ${allStubs.length} pages`);
    // The three asks of this test went out as exactly their own text.
    const mine = stub.requests.filter((request) => request.path === "/conversations/conv-1/messages").map((request) => request.body.message);
    assert.equal(mine[0], FIRST_SUGGESTION);
    assert.equal(mine[2], "My own question, typed by hand.");
  });
});
