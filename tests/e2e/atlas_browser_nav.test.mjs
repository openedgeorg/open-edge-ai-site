/**
 * Browser tests for moving about the Atlas and for its entry (handoff findings F05, F06 and F08):
 *
 *  - F08: on 1440x900, 1366x768, 390x844 and 320x740 the first screen holds the household premise in plain
 *    words, its draft caveats, ONE prominent first question and the way into the Atlas, with the counter's
 *    "1 of 65 visited" explained as a starting marker; the question sends the first question once; without
 *    JavaScript the premise and the plain index remain;
 *  - F06: the inspector keeps the last place or path that was looked at (hover is transient: the exact
 *    hover-then-scroll reproduction of the handoff), a visited place can be asked again, a frontier place still
 *    asks on activation (once), and a path can be inspected by pointer, touch and keyboard;
 *  - F05: on 390x844 and 320x740 with touch emulation, the loop between the map, the answer and the list works
 *    without long manual searches: the dock (Map / Conversation / new places), the way back to the place that
 *    was being looked at, the explicit route to places lit out of sight, and a List that opens only the regions
 *    that matter, has visited / next to explore / all filters and a jump to a region and still reaches all 65
 *    places, with no sideways overflow and no composer under the dock.
 *
 * Island names, teasers and terms are read from js/atlas-graph.js at run time.
 *
 * Run: node --test --test-concurrency=1 tests/e2e/atlas_browser_nav.test.mjs
 * Chrome: /usr/bin/google-chrome, or the executable named by ATLAS_CHROME. Without a Chrome the suite is skipped
 * with the reason printed. The conversation client is the one named by ATLAS_CHAT (see atlas_browser_support.mjs).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import { FIRST_SUGGESTION, ISLANDS, REGIONS, START_ID, buildIndex } from "../../site/js/atlas-graph.js";
import { classifyTerm, compileGlossary, matchReply } from "../../site/js/atlas-match.js";
import { deriveView } from "../../site/js/atlas-state.js";
import * as support from "./atlas_browser_support.mjs";

const { findChrome, launchBrowser, sleep, startSite } = support;

const INDEX = buildIndex();
const GLOSSARY = compileGlossary(ISLANDS);
const CHROME = findChrome();
const CHAT_SKIP = support.CHAT_SETUP ? support.CHAT_SETUP.skip : false;
const HTML = readFileSync(new URL("../../site/index.html", import.meta.url), "utf8");
const diagnostics = [];
let browser = null;

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/**
 * Fresh server + stub + isolated browser context for one test. `touch` turns on mobile emulation with
 * touch input (taps are dispatched as touch events, not as mouse clicks).
 */
async function openSite(t, label, { touch = false, ...pageOptions } = {}) {
  const site = await startSite();
  const page = await browser.openPage({ label, diagnostics, ...pageOptions });
  if (touch) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: pageOptions.width,
      height: pageOptions.height,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  }
  t.after(async () => {
    await page.close();
    await site.close();
  });
  return { site, stub: site.stub, page, url: `${site.origin}/` };
}

/** Load the page and wait until the Atlas has painted and the chat is ready for a suggestion. */
async function boot(page, url) {
  await page.goto(url);
  await page.waitFor(`(document.querySelector("#atlas-count")?.textContent || "").length > 0`, { what: "the Atlas count" });
  await page.waitFor(
    `(() => {
      const chip = document.querySelector("#atlas-suggest .atlas-chip");
      return !!chip && chip.getAttribute("aria-disabled") !== "true" && document.querySelector("#phase").textContent.trim() === "ready";
    })()`,
    { what: "the chat to be ready and the first suggestion enabled" },
  );
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

/** Wait until the page has stopped scrolling. */
async function settle(page) {
  let last = null;
  let still = 0;
  for (let i = 0; i < 120 && still < 5; i += 1) {
    const now = await page.eval(`[scrollX, scrollY, document.querySelector("#atlas-map").scrollLeft].join()`);
    still = now === last ? still + 1 : 0;
    last = now;
    await sleep(60);
  }
  assert.ok(still >= 5, "the page stops scrolling");
}

/** A sentence that lights `island` (some term of it that the matcher really reads). */
function sentenceFor(island) {
  for (const term of [island.name, ...island.terms]) {
    if (classifyTerm(term) === "rejected") continue;
    const text = `A note on ${term}.`;
    if (matchReply(text, GLOSSARY).includes(island.id)) return text;
  }
  throw new Error(`no sentence lights ${island.id}`);
}

/** A reply that lights every one of `ids`. */
function replyLighting(ids) {
  const reply = ids.map((id) => sentenceFor(INDEX.byId.get(id))).join(" ");
  const lit = matchReply(reply, GLOSSARY);
  for (const id of ids) assert.ok(lit.includes(id), `${id} is lit by its sentence`);
  return { reply, lit };
}

const ordinary = (island) => island.status !== "open" && island.status !== "contested";
/** Places a first reply can light next to the start: ordinary neighbours, in graph order. */
const NEAR_START = ISLANDS.filter((island) => INDEX.neighbours.get(START_ID).has(island.id) && ordinary(island));
/** Ordinary places far to the right of the map, so a phone's map panel really has to scroll to them. */
const FAR = [...ISLANDS].filter(ordinary).sort((p, q) => q.x - p.x);

/** Where `selector` is (viewport pixels) and whether all of it is on screen below the header and above the dock. */
const BOX = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const header = document.querySelector(".site-header").getBoundingClientRect().bottom;
  const dock = document.querySelector(".atlas-dock");
  const d = dock && getComputedStyle(dock).display !== "none" ? dock.getBoundingClientRect() : null;
  const floor = d && d.top < innerHeight && d.bottom >= innerHeight - 1 ? d.top : innerHeight;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, header, floor,
    inView: r.width > 0 && r.height > 0 && r.top >= header - 1 && r.bottom <= floor + 1 && r.left >= -1 && r.right <= innerWidth + 1 };
})()`;

async function assertInView(page, selector, what) {
  const box = await page.eval(BOX(selector));
  assert.ok(box, `${what} exists`);
  assert.ok(box.inView, `${what} is on screen (${selector}: top ${Math.round(box.top)}, bottom ${Math.round(box.bottom)}, header ${Math.round(box.header)}, floor ${Math.round(box.floor)})`);
  return box;
}

/** Whether a place on the map is on screen: inside the window (above the dock) and inside the map panel. */
const PLACE_IN_VIEW = (id) => `(() => {
  const g = document.querySelector('#atlas-map [data-id="${id}"] .atlas-disc');
  if (!g) return false;
  const r = g.getBoundingClientRect();
  const panel = document.querySelector("#atlas-map").getBoundingClientRect();
  const header = document.querySelector(".site-header").getBoundingClientRect().bottom;
  const dock = document.querySelector(".atlas-dock");
  const d = dock && getComputedStyle(dock).display !== "none" ? dock.getBoundingClientRect() : null;
  const floor = d && d.top < innerHeight && d.bottom >= innerHeight - 1 ? d.top : innerHeight;
  return r.width > 0 && r.top >= header && r.bottom <= floor && r.left >= panel.left && r.right <= panel.right;
})()`;

/**
 * A touch tap at the centre of an element, after the same checks a visitor's finger would meet: the element is
 * on screen (it is scrolled into view first unless `scroll` is false) and nothing else covers its centre.
 */
async function tap(page, selector, { scroll = true, within = "" } = {}) {
  const target = await page.eval(`(async () => {
    const frames = (n) => new Promise((resolve) => { let left = n; const step = () => { left -= 1; if (left <= 0) resolve(); else requestAnimationFrame(step); }; requestAnimationFrame(step); });
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { error: "no element for " + ${JSON.stringify(selector)} };
    if (${JSON.stringify(scroll)}) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await frames(3);
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { error: "zero-size element " + ${JSON.stringify(selector)} };
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { error: ${JSON.stringify(selector)} + " is not on screen at " + Math.round(x) + "," + Math.round(y) };
    const hit = document.elementFromPoint(x, y);
    const within = ${JSON.stringify(within)};
    const ok = !!hit && (el === hit || el.contains(hit) || (within && hit.closest(within) && hit.closest(within) === el.closest(within)));
    return { x, y, ok, hit: hit ? hit.tagName + "#" + hit.id + "." + (hit.getAttribute("class") || "") : "nothing" };
  })()`);
  if (target.error) throw new Error(target.error);
  if (!target.ok) throw new Error(`a tap on ${selector} would hit ${target.hit} instead`);
  await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: target.x, y: target.y }] });
  await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(60);
}

/** Move the real mouse pointer to a viewport point. */
const pointerTo = (page, x, y) => page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });

/** The centre of an element in viewport pixels. */
const centreOf = (page, selector) =>
  page.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);

const noSidewaysScroll = (page) => page.eval(`({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })`);

/** The luminance contrast between two CSS colours, read from computed styles in the page. */
const CONTRAST = (selector) => `(() => {
  const parse = (c) => (c.match(/[\\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const el = document.querySelector(${JSON.stringify(selector)});
  const s = getComputedStyle(el);
  const [x, y] = [lum(parse(s.color)), lum(parse(s.backgroundColor))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
})()`;

// ---------------------------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------------------------

describe("Atlas navigation and entry (real browser)", { skip: CHROME.path ? CHAT_SKIP : CHROME.reason, timeout: 480000 }, () => {
  before(async (t) => {
    if (support.CHAT_SETUP) t.diagnostic(support.CHAT_SETUP.label);
    browser = await launchBrowser(CHROME.path);
  });

  after(async () => {
    if (browser) await browser.close();
    browser = null;
  });

  // ---- F08: the entry ----

  for (const [width, height] of [[1440, 900], [1366, 768], [390, 844], [320, 740]]) {
    it(`F08. ${width}x${height}: the first screen holds the household premise, one prominent first question and the way in`, async (t) => {
      const { page, url } = await openSite(t, `f08-${width}x${height}`, { width, height });
      await boot(page, url);
      await page.eval("window.scrollTo(0, 0)");

      const h1 = await assertInView(page, ".hero h1", "the headline");
      await assertInView(page, ".hero-tagline", "the premise");
      const ask = await assertInView(page, ".hero-ask", "the first question");
      const link = await assertInView(page, ".hero-cta-link", "the Explore the design link");
      await assertInView(page, ".hero-start", "the note about the starting marker");
      assert.ok(ask.height >= 48, `the question is a large target (${Math.round(ask.height)}px high)`);
      assert.ok(ask.height > link.height, "and larger than the Explore link: it is the one thing to do");
      assert.ok(ask.width >= Math.min(320, width - 60), `and wide (${Math.round(ask.width)}px in ${width}px)`);
      assert.ok(h1.bottom < ask.top && ask.bottom < link.top + 1, "in reading order: headline, premise, the question, then the link");

      const facts = await page.eval(`(() => {
        const text = (selector) => (document.querySelector(selector)?.innerText || "").replace(/\\s+/g, " ").trim();
        const ask = document.querySelector(".hero-ask");
        return {
          h1: text(".hero h1"),
          premise: text(".hero-tagline"),
          kicker: text(".hero-kicker"),
          askText: text(".hero-ask"),
          askSize: parseFloat(getComputedStyle(ask).fontSize),
          label: text(".hero-ask-label"),
          start: text(".hero-start"),
          count: text(".hero-count"),
          heroText: text(".hero"),
          atlasCount: document.querySelector("#atlas-count").textContent,
          ctaLink: text(".hero-cta-link"),
          navLinks: Array.from(document.querySelectorAll(".nav-links a")).map((a) => a.getAttribute("href")),
        };
      })()`);
      assert.equal(facts.askText, FIRST_SUGGESTION, "the first question is the Atlas's own first suggestion");
      assert.ok(facts.askSize >= 17, `its text is large (${facts.askSize}px)`);
      assert.ok((await page.eval(CONTRAST(".hero-ask"))) >= 4.5, "its text is readable against its background");
      assert.match(facts.label, /start with one question/i);
      assert.match(facts.h1, /internet bill/i, "the headline is about the household's bill");
      assert.match(facts.premise, /internet provider/i);
      assert.match(facts.premise, /monthly plan/i);
      assert.match(facts.premise, /proposed design/i);
      assert.match(facts.premise, /draft/i, "the draft status is said");
      assert.match(facts.premise, /not a product/i, "and that it is not a product");
      assert.match(facts.premise, /illustrative/i, "and that figures are illustrative");
      for (const [what, text] of [["the headline", facts.h1], ["the premise", facts.premise], ["the question", facts.askText]]) {
        assert.doesNotMatch(text, /\bESP\b/, `${what} needs no acronym`);
      }
      assert.doesNotMatch(facts.heroText, /gate 1|development client|\blearned\b|ratified|guarantee|settled economics/i, "no release-gate jargon and no overpromise on the first screen");
      assert.equal(facts.count, "1 of 65 visited", "the counter on the first screen");
      assert.equal(facts.atlasCount, "1 of 65 visited", "agrees with the Atlas counter");
      assert.match(facts.start, /starting marker/i, "1 visited is explained as a starting marker");
      assert.match(facts.start, /not that you understand it/i, "not as something already understood");
      assert.equal(facts.ctaLink, "Explore the design", "the Explore link stays");
      assert.deepEqual(facts.navLinks, ["#about", "#esp", "#clear-ledger", "#explore"], "and so does the navigation");
      const overflow = await noSidewaysScroll(page);
      assert.ok(overflow.scroll <= overflow.client, `the first screen does not scroll sideways (${overflow.scroll} > ${overflow.client})`);
    });
  }

  it("F08. without JavaScript the premise, the draft caveats and the plain index remain, and nothing offers a question", async (t) => {
    const { page, url } = await openSite(t, "f08-no-js", { width: 1280, height: 800, scriptsDisabled: true });
    await page.goto(url);
    const facts = await page.eval(`(() => {
      const shown = (selector) => { const el = document.querySelector(selector); if (!el) return "missing"; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? "shown" : "hidden"; };
      return {
        h1: shown(".hero h1"), premise: shown(".hero-tagline"), link: shown(".hero-cta-link"),
        ask: shown(".hero-ask"), wrap: shown(".hero-ask-wrap"), note: shown(".hero-cta-note"),
        premiseText: document.querySelector(".hero-tagline").innerText,
        heroText: document.querySelector(".hero").innerText,
        regions: document.querySelectorAll("#atlas noscript h3").length,
        places: document.querySelectorAll("#atlas noscript li > strong").length,
      };
    })()`);
    assert.deepEqual({ h1: facts.h1, premise: facts.premise, link: facts.link }, { h1: "shown", premise: "shown", link: "shown" });
    assert.deepEqual({ ask: facts.ask, wrap: facts.wrap, note: facts.note }, { ask: "hidden", wrap: "hidden", note: "hidden" }, "no question and no sentence about a map without the script");
    assert.match(facts.premiseText, /draft/i);
    assert.doesNotMatch(facts.heroText, /Who actually pays/);
    assert.equal(facts.regions, REGIONS.length, "the plain index lists every region");
    assert.equal(facts.places, ISLANDS.length, "and every place");
  });

  it("F08. the hero question asks the first question once, leads to the Atlas, and afterwards only leads back (the hero does not change size)", async (t) => {
    const { stub, page, url } = await openSite(t, "f08-ask", { width: 1280, height: 800 });
    stub.reply = () => replyLighting(NEAR_START.slice(0, 1).map((island) => island.id)).reply;
    await boot(page, url);
    const heroBefore = await page.eval(`document.querySelector(".hero").getBoundingClientRect().height`);

    const release = stub.holdStreams();
    await page.click(".hero-ask");
    await stub.waitFor(() => stub.posts.length >= 1, { what: "the question's POST" });
    assert.deepEqual(stub.posts, [{ message: FIRST_SUGGESTION, status: 200 }], "exactly the first question");
    await settle(page);
    const landed = await page.eval(`(() => { const t = document.querySelector("#atlas-title").getBoundingClientRect(); const h = document.querySelector(".site-header").getBoundingClientRect().bottom; return { title: t.top, header: h }; })()`);
    assert.ok(landed.title >= landed.header && landed.title < 260, `the Atlas heading is at the top of the window (${Math.round(landed.title)}, header ${Math.round(landed.header)})`);
    const paused = await page.eval(`(() => { const b = document.querySelector(".hero-ask"); return { aria: b.getAttribute("aria-disabled"), by: b.getAttribute("aria-describedby"), disabled: b.disabled }; })()`);
    assert.deepEqual(paused, { aria: "true", by: "atlas-notice", disabled: false }, "while it runs the question is paused like a chip: aria-disabled, pointing at the notice");
    await page.eval(`document.querySelector(".hero-ask").click()`);
    await page.eval(`document.querySelector(".hero-ask").click()`);
    await sleep(200);
    assert.equal(stub.posts.length, 1, "pressing it again while the question runs sends nothing");

    release();
    await waitReply(page, stub, 1);
    await page.waitFor(`document.querySelector(".hero-ask-text").textContent === "Keep exploring the map"`, { what: "the hero to offer the way back" });
    assert.equal(await page.eval(`document.querySelector(".hero-ask-label").textContent`), "Pick up where you left off");
    assert.equal(await page.eval(`document.querySelector(".hero-ask").getAttribute("aria-disabled")`), null);
    assert.equal(await page.eval(`document.querySelector(".hero-count").textContent`), await page.eval(`document.querySelector("#atlas-count").textContent`), "the hero counter follows the Atlas counter");
    const heroAfter = await page.eval(`document.querySelector(".hero").getBoundingClientRect().height`);
    assert.ok(Math.abs(heroAfter - heroBefore) <= 1, `the hero keeps its size when the first answer arrives (${heroBefore} -> ${heroAfter}), so nothing below it moves`);

    await page.eval(`window.scrollTo({ top: 0, behavior: "instant" })`);
    await settle(page);
    await page.click(".hero-ask");
    await settle(page);
    assert.equal(stub.posts.length, 1, "once started, the hero question sends nothing");
    const back = await page.eval(`document.querySelector("#atlas-title").getBoundingClientRect().top`);
    assert.ok(back >= 60 && back < 260, `and leads back to the Atlas (${Math.round(back)})`);
  });

  it("F08. the conversation intro shows no release-gate wording to a visitor (it belongs in a developer-facing details element or a comment)", {
    // The paragraph sits inside div#conversation, the block of the conversation client's owner. Until it moves, this stays a to-do.
    todo: /<div id="conversation"[\s\S]*?Gate 1/.test(HTML.replace(/<details[\s\S]*?<\/details>/g, "").replace(/<!--[\s\S]*?-->/g, ""))
      ? "the intro paragraph in div#conversation still says \"development client ... Gate 1\"; move it into a <details> or a comment"
      : false,
  }, async (t) => {
    const { page, url } = await openSite(t, "f08-gate", { width: 1280, height: 800 });
    await boot(page, url);
    const text = await page.eval(`document.querySelector("#conversation").innerText`);
    assert.doesNotMatch(text, /gate 1|development client/i, `the visible conversation text is free of it: ${text.slice(0, 160)}`);
  });

  // ---- F06: the inspector ----

  it("F06. 1440x1000: hovering a place and scrolling down to read about it keeps the card, also when the pointer moves between map and card", async (t) => {
    const { page, url } = await openSite(t, "f06-hover-scroll", { width: 1440, height: 1000 });
    await boot(page, url);
    await page.click(".hero-cta-link");
    await settle(page);
    const start = INDEX.byId.get(START_ID);

    // The handoff's reproduction: hover the starting island, then scroll down to the inspector.
    const disc = await centreOf(page, `#atlas-map [data-id="${START_ID}"] .atlas-hit`);
    await pointerTo(page, disc.x, disc.y);
    await page.waitFor(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent === ${JSON.stringify(start.name)}`, { what: "the card of the hovered place" });
    assert.equal(await page.eval(`document.querySelector('#atlas-map [data-id="${START_ID}"]').classList.contains("is-active")`), true, "the place is emphasised while the pointer is on it");
    const inspectorTop = await page.eval(`document.querySelector("#atlas-inspector").getBoundingClientRect().top`);

    await page.eval(`window.scrollBy({ top: 600, behavior: "instant" })`);
    await pointerTo(page, disc.x, disc.y);
    await sleep(250);
    const read = await page.eval(`(() => {
      const mount = document.querySelector("#atlas-inspector");
      const r = mount.getBoundingClientRect();
      return {
        name: mount.querySelector(".atlas-inspector-name")?.textContent || null,
        hint: !!mount.querySelector(".is-hint"),
        text: mount.innerText,
        top: r.top, bottom: r.bottom, innerHeight,
        active: document.querySelector('#atlas-map [data-id="${START_ID}"]').classList.contains("is-active"),
        inspected: document.querySelector('#atlas-map [data-id="${START_ID}"]').classList.contains("is-inspected"),
      };
    })()`);
    assert.ok(inspectorTop > 0, "the card started somewhere below");
    assert.equal(read.hint, false, "the card did not go back to its hint when the page moved under the pointer");
    assert.equal(read.name, start.name, "it still describes the place that was hovered");
    assert.ok(read.top < read.innerHeight && read.bottom > 60, `and it is on screen to be read (top ${Math.round(read.top)}, window ${read.innerHeight})`);
    assert.match(read.text, /Status: visited/);
    assert.match(read.text, /Starting point/i, "the start place says that it starts visited");
    assert.equal(read.active, false, "the pointer is no longer on it, so it is no longer emphasised");
    assert.equal(read.inspected, true, "but the map still marks the place the card is about");

    // Moving the pointer onto the card, and back over the empty sea, does not erase it either.
    const card = await centreOf(page, "#atlas-inspector");
    await pointerTo(page, card.x, card.y);
    await sleep(100);
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent`), start.name, "pointer on the card");
    await pointerTo(page, 5, 5);
    await sleep(100);
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent`), start.name, "pointer away");
    await page.eval(`window.scrollTo({ top: 0, behavior: "instant" })`);
    await sleep(100);
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent`), start.name, "after scrolling back up");

    // A page that scrolls under a resting pointer reports the pointer on another place without the pointer having
    // moved: that place is emphasised, but it does not take over the card.
    await page.eval(`window.scrollTo({ top: 0, behavior: "instant" })`);
    await page.eval(`document.querySelector('#atlas-map [data-id="${START_ID}"]').scrollIntoView({ block: "center", behavior: "instant" })`);
    const rest = await centreOf(page, `#atlas-map [data-id="${START_ID}"] .atlas-hit`);
    await pointerTo(page, rest.x, rest.y);
    await page.waitFor(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent === ${JSON.stringify(start.name)}`, { what: "the start card again" });
    const drifted = NEAR_START[0];
    await page.eval(`(() => {
      window.dispatchEvent(new Event("scroll"));
      const hit = document.querySelector('#atlas-map [data-id="${drifted.id}"] .atlas-hit');
      hit.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: ${rest.x}, clientY: ${rest.y}, view: window }));
    })()`);
    assert.equal(await page.eval(`document.querySelector('#atlas-map [data-id="${drifted.id}"]').classList.contains("is-active")`), true, "the place under the pointer is emphasised");
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent`), start.name, "but the card is still about the place that was being read");
    await pointerTo(page, 5, 5);

    // Another place hovered replaces it, and stays in its turn.
    const neighbour = NEAR_START[0];
    await page.eval(`document.querySelector('#atlas-map [data-id="${neighbour.id}"]').scrollIntoView({ block: "center", behavior: "instant" })`);
    const there = await centreOf(page, `#atlas-map [data-id="${neighbour.id}"] .atlas-hit`);
    await pointerTo(page, there.x, there.y);
    await page.waitFor(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent === ${JSON.stringify(neighbour.name)}`, { what: "the neighbour's card" });
    await pointerTo(page, 5, 5);
    await sleep(100);
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent`), neighbour.name, "the last place looked at is the one the card keeps");

    // Escape ends the reading; so does a click on the empty sea.
    await page.eval(`document.querySelector('#atlas-map [data-id="${START_ID}"]').focus()`);
    await page.press("Escape");
    assert.equal(await page.eval(`!!document.querySelector("#atlas-inspector .is-hint")`), true, "Escape puts the hint back");
    assert.equal(await page.eval(`document.querySelectorAll("#atlas-map .is-inspected").length`), 0, "and the map marks nothing");
  });

  it("F06. a visited place can be asked again from its card, a frontier place asks when activated, and nothing is sent twice", async (t) => {
    const { stub, page, url } = await openSite(t, "f06-ask", { width: 1440, height: 1000 });
    const first = NEAR_START[0];
    const second = NEAR_START[1];
    stub.reply = () => replyLighting([first.id]).reply;
    await boot(page, url);
    await page.click(".hero-cta-link");
    await settle(page);

    // A visited place: its card offers to ask about it again; nothing is sent by choosing it.
    await page.clickIsland(START_ID);
    const start = INDEX.byId.get(START_ID);
    await page.waitFor(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent === ${JSON.stringify(start.name)}`, { what: "the start card" });
    assert.equal(stub.posts.length, 0, "choosing a visited place asks nothing");
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-ask")?.textContent`), "Ask about this again");
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-ask").getAttribute("aria-label")`), `Ask about this again: ${start.teaser}`);

    const release = stub.holdStreams();
    await page.click("#atlas-inspector .atlas-inspector-ask");
    await stub.waitFor(() => stub.posts.length >= 1, { what: "the ask-again POST" });
    assert.deepEqual(stub.posts, [{ message: start.teaser, status: 200 }], "exactly the place's own question");
    const during = await page.eval(`(() => { const b = document.querySelector("#atlas-inspector .atlas-inspector-ask"); return { aria: b.getAttribute("aria-disabled"), by: b.getAttribute("aria-describedby"), disabled: b.disabled, focused: document.activeElement === b }; })()`);
    assert.deepEqual(during, { aria: "true", by: "atlas-notice", disabled: false, focused: true }, "paused while the question runs, and still focused");
    await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-ask").click()`);
    await sleep(150);
    assert.equal(stub.posts.length, 1, "a second press sends nothing");
    release();
    await waitReply(page, stub, 1);
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-ask").getAttribute("aria-disabled")`), null, "enabled again");
    assert.equal(await page.eval(`document.querySelector("#atlas-count").textContent`), `${1 + 1} of ${ISLANDS.length} visited`, "asking again about a visited place adds nothing to the count by itself");

    // A frontier place: activation asks, once, even when pressed twice at once.
    stub.reply = () => replyLighting([second.id]).reply;
    const hold = stub.holdStreams();
    await page.clickIsland(second.id);
    await page.clickIsland(second.id);
    await stub.waitFor(() => stub.posts.length >= 2, { what: "the frontier POST" });
    await sleep(200);
    assert.deepEqual(stub.posts.slice(1), [{ message: second.teaser, status: 200 }], "one POST for two quick activations");
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent`), second.name, "and its card is open");
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-ask")?.getAttribute("aria-disabled")`), "true", "paused, like every other way of asking");
    hold();
    await waitReply(page, stub, 2);
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-ask")?.textContent`), "Ask about this again", "once visited its card says so");
    assert.equal(await page.eval(`document.querySelector('#atlas-map [data-id="${second.id}"]').classList.contains("is-visited")`), true);
    assert.equal(stub.posts.length, 2);
  });

  it("F06. a path can be inspected by pointer, by keyboard and by touch: a lit path of a visited place is a button that opens its card", async (t) => {
    const { stub, page, url } = await openSite(t, "f06-paths", { width: 1440, height: 1000 });
    const lit = NEAR_START.slice(0, 2).map((island) => island.id);
    stub.reply = () => replyLighting(lit).reply;
    await boot(page, url);
    await page.click(".hero-cta-link");
    await settle(page);
    await page.click("#atlas-suggest .atlas-chip");
    await waitReply(page, stub, 1);
    const start = INDEX.byId.get(START_ID);
    const edge = INDEX.edgesOf.get(START_ID).find((candidate) => lit.includes(candidate.a === START_ID ? candidate.b : candidate.a));
    assert.ok(edge, "the start has a lit path to one of the places the reply lit");
    const other = INDEX.byId.get(edge.a === START_ID ? edge.b : edge.a);
    const key = [edge.a, edge.b].sort().join("|");

    await page.clickIsland(START_ID);
    await page.waitFor(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent === ${JSON.stringify(start.name)}`, { what: "the start card" });
    const buttons = await page.eval(`Array.from(document.querySelectorAll("#atlas-inspector .atlas-inspector-path-button")).map((b) => b.textContent)`);
    assert.ok(buttons.length >= 2, `every lit path of the place is a button (${buttons.join(" | ")})`);
    assert.ok(buttons.includes(`→ ${other.name}: ${edge.label}`), "each one reads as the path: where it leads and why");

    // Pointer.
    const index = buttons.indexOf(`→ ${other.name}: ${edge.label}`);
    await page.eval(`document.querySelectorAll("#atlas-inspector .atlas-inspector-path-button")[${index}].scrollIntoView({ block: "center", behavior: "instant" })`);
    await page.click(`#atlas-inspector .atlas-inspector-path:nth-child(${index + 1}) .atlas-inspector-path-button`);
    const card = await page.eval(`(() => {
      const mount = document.querySelector("#atlas-inspector");
      return {
        name: mount.querySelector(".atlas-inspector-name")?.textContent,
        label: mount.querySelector(".atlas-inspector-label-path")?.textContent,
        ends: Array.from(mount.querySelectorAll(".atlas-inspector-end")).map((b) => b.textContent),
        pinned: document.querySelector('#atlas-map [data-edge="${key}"]').classList.contains("is-active"),
        tip: document.querySelector(".atlas-edge-tip").classList.contains("is-visible"),
        focusInside: mount.contains(document.activeElement),
      };
    })()`);
    assert.equal(card.name, `${INDEX.byId.get(edge.a).name} ↔ ${INDEX.byId.get(edge.b).name}`, "the card names both ends");
    assert.equal(card.label, edge.label, "the card reads the path's own words");
    assert.deepEqual(card.ends, [`Show ${INDEX.byId.get(edge.a).name}`, `Show ${INDEX.byId.get(edge.b).name}`]);
    assert.equal(card.pinned, true, "the path is drawn bold on the map");
    assert.equal(card.tip, true, "with its label");
    assert.equal(card.focusInside, true, "and the keyboard stays inside the card");
    // The label is a caption: whatever it is drawn over (a place's click target, found in the live journey) still gets the click.
    const tipHit = await page.eval(`(() => {
      const bg = document.querySelector(".atlas-edge-tip-bg");
      bg.scrollIntoView({ block: "center", behavior: "instant" });
      const r = bg.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { pointerEvents: getComputedStyle(bg).pointerEvents, groupPointerEvents: getComputedStyle(document.querySelector(".atlas-edge-tip")).pointerEvents, width: r.width, caught: Boolean(el && el.closest(".atlas-edge-tip")) };
    })()`);
    assert.ok(tipHit.width > 0, "the label is on screen");
    assert.equal(tipHit.pointerEvents, "none", "the label's box takes no pointer events");
    assert.equal(tipHit.groupPointerEvents, "none");
    assert.equal(tipHit.caught, false, "a click at the middle of the label reaches what is under it");

    // The pointer leaving the path does not close it.
    await pointerTo(page, 5, 5);
    await sleep(100);
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-label-path")?.textContent`), edge.label, "the path card stays");

    // Back to a place by its button; the card changes to the place and the path is released.
    await page.click(`#atlas-inspector .atlas-inspector-end:nth-child(${edge.a === other.id ? 1 : 2})`);
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent`), other.name);
    assert.equal(await page.eval(`document.querySelector('#atlas-map [data-edge="${key}"]').classList.contains("is-active")`), true, "the path is still drawn bold (it touches the place)");
    assert.equal(await page.eval(`document.querySelector("#atlas-map").querySelector(".is-selected")?.getAttribute("data-id")`), other.id, "the map selects the place");

    // Keyboard: Tab to a path button and press Enter, then Space.
    await page.clickIsland(START_ID);
    await page.eval(`document.querySelectorAll("#atlas-inspector .atlas-inspector-path-button")[${index}].focus()`);
    await page.press("Enter");
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-label-path")?.textContent`), edge.label, "Enter on a path button opens the path");
    await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-end").focus()`);
    await page.press(" ");
    assert.ok(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-name").textContent`), "Space on a Show button opens the place");
    assert.equal(await page.eval(`!!document.querySelector("#atlas-inspector .atlas-inspector-label-path")`), false, "and the path card is gone");

    // The line on the map: a click on it chooses it too.
    const mid = await page.eval(`(() => {
      const path = document.querySelector('#atlas-map [data-edge="${key}"] .atlas-edge-hit');
      const svg = document.querySelector("#atlas-map svg");
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      const m = svg.getScreenCTM();
      path.scrollIntoView({ block: "center", behavior: "instant" });
      const m2 = svg.getScreenCTM();
      return { x: point.x * m2.a + m2.e, y: point.y * m2.d + m2.f };
    })()`);
    await page.clickPoint(mid.x, mid.y);
    await page.waitFor(`!!document.querySelector("#atlas-inspector .atlas-inspector-label-path")`, { what: "the card of the clicked line" });
    await pointerTo(page, 5, 5);
    await sleep(100);
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-label-path")?.textContent`), edge.label, "a line chosen by click stays chosen");
    await page.eval(`document.querySelector('#atlas-map [data-id="${START_ID}"]').focus()`);
    await page.press("Escape");
    assert.equal(await page.eval(`!!document.querySelector("#atlas-inspector .is-hint")`), true, "Escape ends it");
  });

  it("F06. 390x844 touch: tapping a place opens its card and it stays, a path button opens the path, a frontier tap asks once", async (t) => {
    const { stub, page, url } = await openSite(t, "f06-touch", { width: 390, height: 844, touch: true });
    const lit = NEAR_START.slice(0, 2).map((island) => island.id);
    stub.reply = () => replyLighting(lit).reply;
    await boot(page, url);
    await tap(page, "#atlas-suggest .atlas-chip");
    await waitReply(page, stub, 1);
    await settle(page);
    const start = INDEX.byId.get(START_ID);
    const edge = INDEX.edgesOf.get(START_ID).find((candidate) => lit.includes(candidate.a === START_ID ? candidate.b : candidate.a));
    const other = INDEX.byId.get(edge.a === START_ID ? edge.b : edge.a);

    // A tap on a visited place: its card, nothing asked.
    await page.eval(`document.querySelector('#atlas-map [data-id="${START_ID}"]').scrollIntoView({ block: "center", behavior: "instant" })`);
    await tap(page, `#atlas-map [data-id="${START_ID}"] .atlas-hit`, { scroll: false, within: ".atlas-island" });
    await page.waitFor(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent === ${JSON.stringify(start.name)}`, { what: "the card of the tapped place" });
    assert.equal(stub.posts.length, 1, "a tap on a visited place asks nothing");
    // Scrolling the page to the card (a touch scroll) does not close it.
    await page.eval(`document.querySelector("#atlas-inspector").scrollIntoView({ block: "center", behavior: "instant" })`);
    await sleep(150);
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent`), start.name);

    // A tap on a path button: the path's card, with its words.
    await tap(page, `#atlas-inspector .atlas-inspector-path-button`);
    const label = await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-label-path")?.textContent`);
    assert.ok(label && INDEX.edgesOf.get(START_ID).some((candidate) => candidate.label === label), `the card reads a path of the place (${label})`);
    // A tap on Show <place> goes to the place.
    await tap(page, "#atlas-inspector .atlas-inspector-end:nth-child(1)");
    assert.ok(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent`));
    assert.equal(await page.eval(`!!document.querySelector("#atlas-inspector .atlas-inspector-label-path")`), false);

    // The paths of the visited place, chosen once more, then a tap on a frontier place: one question.
    const frontier = [...INDEX.neighbours.get(START_ID)].map((id) => INDEX.byId.get(id)).find((island) => !lit.includes(island.id) && ordinary(island));
    assert.ok(frontier, "the start has a neighbour that is still next to explore");
    stub.reply = () => replyLighting([frontier.id]).reply;
    const hold = stub.holdStreams();
    await page.eval(`document.querySelector('#atlas-map [data-id="${frontier.id}"]').scrollIntoView({ block: "center", behavior: "instant" })`);
    await tap(page, `#atlas-map [data-id="${frontier.id}"] .atlas-hit`, { scroll: false, within: ".atlas-island" });
    await stub.waitFor(() => stub.posts.length >= 2, { what: "the frontier POST" });
    await sleep(250);
    assert.deepEqual(stub.posts.slice(1), [{ message: frontier.teaser, status: 200 }], "one tap, one question");
    assert.equal(await page.eval(`document.querySelector("#atlas-inspector .atlas-inspector-name")?.textContent`), frontier.name, "and the card of the place that was asked about");
    assert.match(await page.eval(`document.querySelector(".atlas-dock-note").textContent`), /waiting/, "the dock says the answer is on its way");
    hold();
    await waitReply(page, stub, 2);
    assert.equal(stub.posts.length, 2);
  });

  // ---- F05: the loop on a phone ----

  for (const [width, height] of [[390, 844], [320, 740]]) {
    it(`F05. ${width}x${height} touch: the question, the answer, the places it lit and the way back are each one tap apart`, async (t) => {
      const { stub, page, url } = await openSite(t, `f05-loop-${width}x${height}`, { width, height, touch: true });
      const nearReply = replyLighting(NEAR_START.slice(0, 2).map((island) => island.id)).reply;
      const far = FAR[0];
      const farReply = replyLighting([far.id]).reply;
      stub.reply = (_message, n) => (n === 1 ? nearReply : farReply);
      await boot(page, url);
      const sideways = async (when) => {
        const o = await noSidewaysScroll(page);
        assert.ok(o.scroll <= o.client, `${when}: the page does not scroll sideways (${o.scroll} > ${o.client})`);
        const dock = await page.eval(`(() => { const d = document.querySelector(".atlas-dock"); const r = d.getBoundingClientRect(); return { left: r.left, right: r.right, shown: getComputedStyle(d).display !== "none" }; })()`);
        if (dock.shown) assert.ok(dock.left >= 0 && dock.right <= width + 0.5, `${when}: the dock lies inside the window (${dock.left}..${dock.right})`);
        // Primary controls: none sticks out of the window or has its text cut off by its own box.
        const clipped = await page.eval(`(() => {
          const out = [];
          for (const el of document.querySelectorAll(".atlas-dock-button, #atlas-toolbar button, #atlas-list .atlas-list-filter, #atlas-list .atlas-list-bulk, #atlas-list .atlas-list-select, #atlas-view-map, #atlas-view-list, .atlas-chip, .hero-ask, .hero-cta-link, #send")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const where = el.className || el.id;
            if (r.left < -0.5 || r.right > innerWidth + 0.5) out.push(where + " sticks out: " + Math.round(r.left) + ".." + Math.round(r.right));
            if (el.scrollWidth > el.clientWidth + 1) out.push(where + " clips its text: " + el.scrollWidth + " > " + el.clientWidth);
          }
          return out;
        })()`);
        assert.deepEqual(clipped, [], `${when}: no primary control is clipped`);
      };
      await sideways("at the start");

      // 1. The first question is on the first screen and one tap.
      const release = stub.holdStreams();
      await assertInView(page, ".hero-ask", "the first question");
      await tap(page, ".hero-ask", { scroll: false });
      await stub.waitFor(() => stub.posts.length >= 1, { what: "the hero question's POST" });
      assert.deepEqual(stub.posts, [{ message: FIRST_SUGGESTION, status: 200 }], "one tap, one question");
      await settle(page);

      // 2. While it runs the Atlas is on screen with the dock at its foot, and the dock says what is going on.
      const dockBox = await page.eval(`(() => { const r = document.querySelector(".atlas-dock").getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`);
      assert.ok(dockBox.bottom <= height + 1 && dockBox.top > height * 0.5, `the dock is on screen at the foot of the window (${Math.round(dockBox.top)}..${Math.round(dockBox.bottom)} of ${height})`);
      const waiting = await page.eval(`({ note: document.querySelector(".atlas-dock-note").textContent, hidden: document.querySelector(".atlas-dock-note").hidden, current: Array.from(document.querySelectorAll(".atlas-dock [aria-current]")).map((b) => b.textContent), top: document.querySelector(".atlas-dock").getBoundingClientRect().top })`);
      assert.equal(waiting.note, "waiting…");
      assert.ok(waiting.top > height * 0.5, "the dock sits at the bottom of the window");
      assert.deepEqual(waiting.current, ["Map"], "and shows that the visitor is at the map");
      await sideways("while the question runs");

      // 3. The answer arrives: the places it lit are brought into view, and the dock says an answer is waiting.
      release();
      await waitReply(page, stub, 1);
      const first = NEAR_START[0];
      await page.waitFor(PLACE_IN_VIEW(first.id), { what: `${first.id} to be on screen`, timeout: 8000 });
      await settle(page);
      await page.waitFor(`document.querySelector(".atlas-dock-note").textContent === "new answer"`, { what: "the dock to announce the answer" });
      const mapY = await page.eval("scrollY");

      // 4. One tap on Conversation: the history with the question and the answer is on screen, and the keyboard is there.
      await tap(page, ".atlas-dock-answer", { scroll: false });
      await settle(page);
      const answer = await page.eval(`(() => {
        const history = document.querySelector("#history");
        const r = history.getBoundingClientRect();
        const rows = Array.from(history.querySelectorAll("li > p")).map((p) => p.textContent);
        const header = document.querySelector(".site-header").getBoundingClientRect().bottom;
        const dock = document.querySelector(".atlas-dock").getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, header, dockTop: dock.top, last: rows[rows.length - 1], active: document.activeElement.id, current: Array.from(document.querySelectorAll(".atlas-dock [aria-current]")).map((b) => b.textContent.trim()), note: document.querySelector(".atlas-dock-note").hidden };
      })()`);
      assert.equal(answer.last, nearReply, "the answer is the last row of the history");
      assert.ok(answer.top >= answer.header - 1 && answer.top < height - 200, `and the history is on screen (top ${Math.round(answer.top)})`);
      assert.equal(answer.active, "history", "the keyboard moved with the visitor");
      assert.deepEqual(answer.current, ["Conversation"], "the dock shows where the visitor is");
      assert.equal(answer.note, true, "and no longer announces an answer that is being read");
      await sideways("at the answer");

      // 5. One tap on Map: back to the place that was being looked at, not to the heading of the Atlas.
      await tap(page, ".atlas-dock-map", { scroll: false });
      await settle(page);
      await page.waitFor(PLACE_IN_VIEW(first.id), { what: `${first.id} to be on screen again`, timeout: 8000 });
      const back = await page.eval(`({ y: scrollY, title: document.querySelector("#atlas-title").getBoundingClientRect().bottom, header: document.querySelector(".site-header").getBoundingClientRect().bottom, active: document.activeElement.closest("#atlas-map") ? document.activeElement.closest(".atlas-island")?.getAttribute("data-id") : null })`);
      assert.ok(Math.abs(back.y - mapY) <= 40, `the window is where it was (${mapY} -> ${back.y})`);
      assert.ok(back.title < back.header, "and that is not the section heading");
      assert.ok(back.active, "the keyboard is on a place of the map");

      // 6. A visitor who is reading the conversation is not moved when their next answer lights a place far away,
      //    and gets a button for it instead.
      await tap(page, ".atlas-dock-answer", { scroll: false });
      await settle(page);
      await tap(page, "#draft");
      await page.type("Tell me about it.");
      const activeBefore = await page.eval(`document.activeElement.id`);
      assert.equal(activeBefore, "draft");
      await tap(page, "#send");
      await waitReply(page, stub, 2);
      await sleep(900);
      const reading = await page.eval(`(() => ({
        y: scrollY,
        news: document.querySelector(".atlas-dock-new").hidden ? "" : document.querySelector(".atlas-dock-new").textContent,
        toolbar: document.querySelector(".atlas-new-places").hidden ? "" : document.querySelector(".atlas-new-places").textContent,
        activeInMap: !!document.activeElement.closest("#atlas-map"),
        chatInView: document.querySelector("#history").getBoundingClientRect().top < innerHeight,
      }))()`);
      assert.equal(reading.news, "Show 1 new place", "the dock offers the place that was lit out of sight");
      assert.equal(reading.toolbar, "Show 1 new place", "and so does the toolbar of the Atlas");
      assert.equal(reading.activeInMap, false, "the keyboard did not move to the map");
      assert.equal(reading.chatInView, true, "nor did the window leave the conversation");
      await sideways("with a new place waiting");
      assert.equal(await page.eval(PLACE_IN_VIEW(far.id)), false, "the far place is not on screen yet");

      await tap(page, ".atlas-dock-new", { scroll: false });
      await page.waitFor(PLACE_IN_VIEW(far.id), { what: `${far.id} (lit out of sight) to be on screen`, timeout: 8000 });
      const shown = await page.eval(`({ news: document.querySelector(".atlas-dock-new").hidden, toolbar: document.querySelector(".atlas-new-places").hidden, active: document.activeElement.className })`);
      assert.equal(shown.news, true, "the button is gone once the place is shown");
      assert.equal(shown.toolbar, true);
      assert.match(String(shown.active), /atlas-dock-map/, "and the keyboard went to the neighbouring button, not to the page");

      // 7. The list is short, steered by filters and a jump, and still reaches all 65 places.
      await tap(page, "#atlas-view-list");
      await page.waitFor(`!document.querySelector("#atlas-list").hidden`, { what: "the list" });
      const stateNow = await page.eval(`JSON.parse(sessionStorage.getItem("esp-atlas"))`);
      const view = deriveView({ visited: stateNow.visited, replies: stateNow.replies }, INDEX);
      const rows = () => page.eval(`Array.from(document.querySelectorAll("#atlas-list .atlas-list-item")).filter((li) => li.getBoundingClientRect().height > 0).map((li) => li.querySelector(".atlas-list-name").textContent)`);
      const nameOf = (id) => INDEX.byId.get(id).name;
      const total = await page.eval(`document.querySelectorAll("#atlas-list .atlas-list-item").length`);
      assert.equal(total, ISLANDS.length, "all 65 rows are in the page");
      const open = await rows();
      const listHeight = await page.eval(`document.querySelector("#atlas-list").getBoundingClientRect().height`);
      assert.ok(open.length < ISLANDS.length && open.length >= view.frontier.filter((id) => INDEX.byId.get(id).status !== "open").length, `only the regions with something to do are open (${open.length} rows)`);
      assert.ok(listHeight < 4200, `so the list is short (${Math.round(listHeight)}px, it was about 9150px)`);
      const toggles = await page.eval(`Array.from(document.querySelectorAll("#atlas-list h3 button")).map((b) => [b.textContent, b.getAttribute("aria-expanded")])`);
      assert.deepEqual(toggles.map(([text]) => text), REGIONS.map((region) => `${region.name} · ${region.level} · ${region.subtitle}`), "one disclosure per region");
      assert.ok(toggles.some(([, expanded]) => expanded === "false") && toggles.some(([, expanded]) => expanded === "true"));
      await sideways("in the list");

      // Filters.
      const filterLabels = await page.eval(`Array.from(document.querySelectorAll("#atlas-list .atlas-list-filter")).map((b) => b.textContent)`);
      const nextNames = view.frontier.filter((id) => INDEX.byId.get(id).status !== "open").map(nameOf);
      assert.deepEqual(filterLabels, [`All places (${ISLANDS.length})`, `Visited (${view.visitedCount})`, `Next to explore (${nextNames.length})`]);
      await tap(page, "#atlas-list .atlas-list-filter:nth-child(2)");
      assert.deepEqual(new Set(await rows()), new Set(stateNow.visited.map(nameOf)), "Visited shows the visited places");
      await tap(page, "#atlas-list .atlas-list-filter:nth-child(3)");
      assert.deepEqual(new Set(await rows()), new Set(nextNames), "Next to explore shows the places that can be asked");
      assert.equal(await page.eval(`document.querySelector("#atlas-list .atlas-list-filter:nth-child(3)").getAttribute("aria-pressed")`), "true");
      await tap(page, "#atlas-list .atlas-list-filter:nth-child(1)");
      assert.equal((await rows()).length, open.length, "All places goes back to the regions that were open");

      // Jump to a region: it opens and its heading is brought up.
      const target = REGIONS[REGIONS.length - 1];
      await page.eval(`(() => { const s = document.querySelector("#atlas-list .atlas-list-select"); s.scrollIntoView({ block: "center", behavior: "instant" }); s.value = ${JSON.stringify(target.id)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await settle(page);
      const jumped = await page.eval(`(() => {
        const h = document.querySelector("#atlas-list-region-${target.id}");
        const r = h.getBoundingClientRect();
        const header = document.querySelector(".site-header").getBoundingClientRect().bottom;
        return { top: r.top, header, expanded: h.querySelector("button").getAttribute("aria-expanded"), rows: Array.from(document.querySelectorAll("#atlas-list-items-${target.id} > li")).filter((li) => li.getBoundingClientRect().height > 0).length, select: document.querySelector("#atlas-list .atlas-list-select").value };
      })()`);
      assert.equal(jumped.expanded, "true", "the region opened");
      assert.ok(jumped.top >= jumped.header - 1 && jumped.top < height * 0.5, `its heading is near the top of the window (${Math.round(jumped.top)})`);
      assert.equal(jumped.rows, ISLANDS.filter((island) => island.region === target.id).length, "with all its places");
      assert.equal(jumped.select, "", "and the menu is ready for the next jump");

      // Every one of the 65 places can be reached: open everything.
      await tap(page, "#atlas-list .atlas-list-bulk");
      assert.equal((await rows()).length, ISLANDS.length, "Expand all shows all 65 places");
      await sideways("with the whole list open");
      await tap(page, "#atlas-list .atlas-list-bulk");
      assert.equal((await rows()).length, 0, "Collapse all closes them again (every row stays in the page)");
      assert.equal(await page.eval(`document.querySelectorAll("#atlas-list .atlas-list-item").length`), ISLANDS.length);

      // The list keeps its place across a visit to the conversation.
      const region = REGIONS[4];
      await page.eval(`(() => { const s = document.querySelector("#atlas-list .atlas-list-select"); s.value = ${JSON.stringify(region.id)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await settle(page);
      const listY = await page.eval("scrollY");
      assert.equal(await page.eval(`document.querySelector(".atlas-dock-map").textContent`), "List", "the dock offers the way back to the list");
      await tap(page, ".atlas-dock-answer", { scroll: false });
      await settle(page);
      assert.ok((await page.eval("scrollY")) > listY + 300, "the conversation is further down");
      await tap(page, ".atlas-dock-map", { scroll: false });
      await settle(page);
      const backInList = await page.eval(`({ y: scrollY, hidden: document.querySelector("#atlas-list").hidden, heading: document.querySelector("#atlas-list-region-${region.id}").getBoundingClientRect().top })`);
      assert.equal(backInList.hidden, false, "still the list");
      assert.ok(Math.abs(backInList.y - listY) <= 40, `at the same place (${listY} -> ${backInList.y})`);
      assert.ok(backInList.heading >= 0 && backInList.heading < height, "with the region that was being read on screen");

      // A reply that lights a place while the list is open: the row carries "new", and the button leads to it.
      const second = FAR[1];
      stub.reply = () => replyLighting([second.id]).reply;
      await tap(page, ".atlas-dock-answer", { scroll: false });
      await settle(page);
      await tap(page, "#draft");
      await page.type("And another one?");
      await tap(page, "#send");
      await waitReply(page, stub, 3);
      await page.waitFor(`!document.querySelector(".atlas-dock-new").hidden`, { what: "the button for the place lit while the list was open" });
      await tap(page, ".atlas-dock-new", { scroll: false });
      await settle(page);
      const row = await page.eval(`(() => {
        const li = Array.from(document.querySelectorAll("#atlas-list .atlas-list-item")).find((item) => item.querySelector(".atlas-list-name").textContent === ${JSON.stringify(second.name)});
        const r = li.getBoundingClientRect();
        const header = document.querySelector(".site-header").getBoundingClientRect().bottom;
        const dock = document.querySelector(".atlas-dock").getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, header, dockTop: dock.top, isNew: !li.querySelector(".atlas-list-new").hidden, visited: li.classList.contains("is-visited") };
      })()`);
      assert.equal(row.visited, true);
      assert.equal(row.isNew, true, "the row of the place the latest reply lit says so");
      assert.ok(row.top >= row.header - 1 && row.bottom <= row.dockTop + 1, `and it is on screen (${Math.round(row.top)}..${Math.round(row.bottom)}, header ${Math.round(row.header)}, dock ${Math.round(row.dockTop)})`);
      await sideways("at the end");
    });

    it(`F05. ${width}x${height} touch: the composer is never under the dock, and the dock steps aside while a text field has focus`, async (t) => {
      const { page, url } = await openSite(t, `f05-composer-${width}x${height}`, { width, height, touch: true });
      await boot(page, url);
      await page.eval(`document.querySelector("#conversation").scrollIntoView({ block: "start", behavior: "instant" })`);
      await settle(page);

      // With the dock showing: Send, scrolled into view the way a browser does for a focused control, clears it.
      const clear = await page.eval(`(() => {
        const send = document.querySelector("#send");
        send.scrollIntoView({ block: "end", behavior: "instant" });
        const s = send.getBoundingClientRect();
        const d = document.querySelector(".atlas-dock").getBoundingClientRect();
        const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
        return { sendBottom: s.bottom, dockTop: d.top, dockShown: getComputedStyle(document.querySelector(".atlas-dock")).display !== "none", hit: hit === send || send.contains(hit), height: s.height };
      })()`);
      assert.equal(clear.dockShown, true);
      assert.ok(clear.sendBottom <= clear.dockTop + 1, `Send ends above the dock (${Math.round(clear.sendBottom)} <= ${Math.round(clear.dockTop)})`);
      assert.equal(clear.hit, true, "and nothing covers it");
      assert.ok(clear.height >= 44, "and it is a full-size target");

      // Focus in the message box: the dock steps aside, the box is fully on screen and uncovered.
      await tap(page, "#draft");
      await sleep(150);
      const typing = await page.eval(`(() => {
        const draft = document.querySelector("#draft");
        const r = draft.getBoundingClientRect();
        const dock = document.querySelector(".atlas-dock");
        const header = document.querySelector(".site-header").getBoundingClientRect().bottom;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { focused: document.activeElement === draft, tucked: dock.classList.contains("is-tucked"), display: getComputedStyle(dock).display, top: r.top, bottom: r.bottom, header, hit: hit === draft };
      })()`);
      assert.equal(typing.focused, true);
      assert.equal(typing.tucked, true, "the dock steps aside");
      assert.equal(typing.display, "none");
      assert.ok(typing.top >= typing.header - 1 && typing.bottom <= height, "the box is on screen");
      assert.equal(typing.hit, true, "and uncovered");

      // An on-screen keyboard takes most of the window: the box and Send still fit above it once scrolled to.
      const keyboard = Math.round(height * 0.55);
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: height - keyboard, deviceScaleFactor: 1, mobile: true });
      await page.eval(`document.querySelector("#draft").scrollIntoView({ block: "center", behavior: "instant" })`);
      await sleep(100);
      const squeezed = await page.eval(`(() => {
        const r = document.querySelector("#draft").getBoundingClientRect();
        const dock = document.querySelector(".atlas-dock");
        const header = document.querySelector(".site-header").getBoundingClientRect().bottom;
        return { top: r.top, bottom: r.bottom, header, floor: innerHeight, display: getComputedStyle(dock).display, scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth };
      })()`);
      assert.equal(squeezed.display, "none", "the dock stays aside under a keyboard");
      assert.ok(squeezed.top >= squeezed.header - 1 && squeezed.bottom <= squeezed.floor + 1, `the box fits above the keyboard (${Math.round(squeezed.top)}..${Math.round(squeezed.bottom)} in ${squeezed.floor})`);
      assert.ok(squeezed.scrollW <= squeezed.clientW, "no sideways scrolling");
      await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true });

      // Leaving the field brings the dock back.
      await page.eval(`document.querySelector("#draft").blur()`);
      await sleep(100);
      assert.equal(await page.eval(`getComputedStyle(document.querySelector(".atlas-dock")).display !== "none"`), true, "the dock is back");
    });
  }

  it("F05. 1280x800: a place lit out of sight is offered by a button in the toolbar, which moves nothing by itself", async (t) => {
    const { stub, page, url } = await openSite(t, "f05-news-desktop", { width: 1280, height: 800 });
    const target = NEAR_START[0];
    stub.reply = () => replyLighting([target.id]).reply;
    await boot(page, url);
    await page.click(".hero-cta-link");
    await settle(page);
    const R = (selector) => `(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [b.left + scrollX, b.top + scrollY, b.width, b.height].map((v) => Math.round(v * 10) / 10); })()`;
    const idle = await page.eval(`({ toolbar: ${R("#atlas-toolbar")}, map: ${R("#atlas-map")}, suggest: ${R("#atlas-suggest")} })`);

    // The visitor asks, then goes back up the page while the answer is on its way.
    const release = stub.holdStreams();
    await page.click("#atlas-suggest .atlas-chip");
    await stub.waitFor(() => stub.posts.length >= 1, { what: "the chip's POST" });
    await page.eval(`window.scrollTo({ top: 0, behavior: "instant" })`);
    await settle(page);
    release();
    await waitReply(page, stub, 1);
    await page.waitFor(`!document.querySelector(".atlas-new-places").hidden`, { what: "the button for the place that was lit out of sight" });
    await sleep(500);
    const waiting = await page.eval(`({ y: scrollY, text: document.querySelector(".atlas-new-places").textContent, toolbar: ${R("#atlas-toolbar")}, map: ${R("#atlas-map")}, suggest: ${R("#atlas-suggest")}, active: document.activeElement.tagName })`);
    assert.equal(waiting.y, 0, "the window did not move");
    assert.equal(waiting.text, "Show 1 new place");
    assert.deepEqual({ toolbar: waiting.toolbar, map: waiting.map, suggest: waiting.suggest }, { toolbar: idle.toolbar, map: idle.map, suggest: idle.suggest }, "and the button moves nothing on the page: the toolbar keeps its height");
    assert.equal(await page.eval(`document.querySelector(".atlas-dock") && getComputedStyle(document.querySelector(".atlas-dock")).display`), "none", "the dock is a phone's: it is not here");

    // Pressing it brings the place into view.
    await page.eval(`document.querySelector(".atlas-new-places").scrollIntoView({ block: "center", behavior: "instant" })`);
    await page.click(".atlas-new-places");
    await page.waitFor(PLACE_IN_VIEW(target.id), { what: `${target.id} to be on screen`, timeout: 8000 });
    await page.waitFor(`document.querySelector(".atlas-new-places").hidden`, { what: "the button to go" });
    assert.equal(await page.eval(`document.activeElement.id`), "atlas-view-map", "and the keyboard went to the neighbouring control, not to the page");
  });

  it("F05. 390x844: Map and List each keep the place the window was at", async (t) => {
    const { page, url } = await openSite(t, "f05-view-spots", { width: 390, height: 844 });
    await boot(page, url);
    // The tabs are pressed in place (a click that scrolls first would change the place being remembered).
    const press = (id) => page.eval(`document.querySelector("#${id}").click()`);
    await page.eval(`document.querySelector("#atlas-map").scrollIntoView({ block: "start", behavior: "instant" })`);
    await page.eval(`document.querySelector("#atlas-map").scrollLeft = 260`);
    await settle(page);
    const mapAt = await page.eval(`({ y: scrollY, left: document.querySelector("#atlas-map").scrollLeft })`);
    assert.ok(mapAt.left > 100, `the map panel is scrolled sideways (${mapAt.left})`);

    await press("atlas-view-list");
    await page.eval(`window.scrollBy({ top: 700, behavior: "instant" })`);
    await settle(page);
    const listAt = await page.eval(`scrollY`);
    await press("atlas-view-map");
    await settle(page);
    const backOnMap = await page.eval(`({ y: scrollY, left: document.querySelector("#atlas-map").scrollLeft })`);
    assert.ok(Math.abs(backOnMap.y - mapAt.y) <= 2, `the window is back where the map was (${mapAt.y} -> ${backOnMap.y})`);
    assert.equal(backOnMap.left, mapAt.left, "and so is the map panel's sideways position");
    await press("atlas-view-list");
    await settle(page);
    assert.ok(Math.abs((await page.eval("scrollY")) - listAt) <= 2, `the list is where it was left (${listAt})`);
  });

  it("F05. 390x844 keyboard: the dock, the list's disclosures and filters work with Tab, Enter and Space", async (t) => {
    const { stub, page, url } = await openSite(t, "f05-keys", { width: 390, height: 844 });
    stub.reply = () => replyLighting(NEAR_START.slice(0, 1).map((island) => island.id)).reply;
    await boot(page, url);
    await page.click("#atlas-suggest .atlas-chip");
    await waitReply(page, stub, 1);
    await page.eval(`window.scrollTo({ top: 0, behavior: "instant" })`);
    await page.click("#atlas-view-map");
    await settle(page);

    // Conversation by keyboard: focus the button, press Enter, and the keyboard is in the history.
    await page.eval(`document.querySelector(".atlas-dock-answer").focus()`);
    await page.press("Enter");
    await settle(page);
    assert.equal(await page.eval(`document.activeElement.id`), "history", "focus moved to the history");
    assert.equal(await page.eval(`document.querySelector("#history").getBoundingClientRect().top < innerHeight - 100`), true, "which is on screen");

    // Map by keyboard: focus lands on a place, so Tab and the arrow keys carry on from there.
    await page.eval(`document.querySelector(".atlas-dock-map").focus()`);
    await page.press("Enter");
    await settle(page);
    const landed = await page.eval(`({ island: document.activeElement.closest("#atlas-map") ? document.activeElement.closest(".atlas-island")?.getAttribute("data-id") : null })`);
    assert.ok(landed.island, "focus is on a place of the map");
    await page.press("ArrowRight");
    assert.ok(await page.eval(`document.activeElement.closest(".atlas-island")`), "and the arrow keys work from there");

    // The list: Enter and Space on a region heading, and on a filter.
    await page.click("#atlas-view-list");
    const closed = await page.eval(`(() => { const b = Array.from(document.querySelectorAll("#atlas-list h3 button")).find((x) => x.getAttribute("aria-expanded") === "false"); b.scrollIntoView({ block: "center", behavior: "instant" }); b.focus(); return b.textContent; })()`);
    await page.press("Enter");
    assert.equal(await page.eval(`document.activeElement.getAttribute("aria-expanded")`), "true", `Enter opens ${closed}`);
    await page.press(" ");
    assert.equal(await page.eval(`document.activeElement.getAttribute("aria-expanded")`), "false", "Space closes it again");
    assert.equal(await page.eval(`document.activeElement.textContent`), closed, "and focus stays on the heading");
    await page.eval(`document.querySelector("#atlas-list .atlas-list-filter:nth-child(2)").focus()`);
    await page.press("Enter");
    assert.equal(await page.eval(`document.activeElement.getAttribute("aria-pressed")`), "true", "Enter on a filter chooses it");
    assert.equal(await page.eval(`document.activeElement === document.querySelector("#atlas-list .atlas-list-filter:nth-child(2)")`), true, "and focus stays there");
  });
});
