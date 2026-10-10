/**
 * Browser tests for how the Atlas sits on screen and how it is used with keys and in high contrast:
 *
 *  - F6: after the hero link on a 1440x900 screen, the start place, the counter, the first chip and the
 *    edge dragon's caption are all in the window, and nothing above the map moves when the first reply
 *    arrives, when a question runs or when a pause is explained;
 *  - F7: on a phone (390x844) a reply scrolls the map to the first place it lit and the page to the map
 *    (unless the visitor is reading the conversation), without moving focus; the answer stays one tap away;
 *  - F8: in forced-colors mode every fill and stroke of the map is a system colour and its text is readable;
 *  - F5: the arrow keys follow paths in the real page, near places first;
 *  - F24: the pause notice stays in the flow, beside the heading or under it, and never covers the intro, the
 *    honesty note, the heading or the chips, also with text enlarged to 150% and 200% (root font size) at
 *    900, 1180, 1280 and 1440px;
 *  - F36: on a phone, a visitor who scrolled away from the map while waiting is not pulled back to it;
 *  - F37: on a 1366x768 laptop the start place's NAME is on the first screen after the hero link, too;
 *  - F38: a short keyboard hint shows under the map while the map has focus, and moves nothing.
 *
 * Island names, teasers and terms are read from js/atlas-graph.js at run time: the only graph facts
 * written out here are the start place and the first suggestion.
 *
 * Run: node --test --test-concurrency=1 tests/e2e/atlas_browser_ui.test.mjs
 * Chrome: /usr/bin/google-chrome, or the executable named by ATLAS_CHROME. Without a Chrome the suite is
 * skipped with the reason printed. The conversation client is the one named by ATLAS_CHAT (see
 * atlas_browser_support.mjs); the default is the test double.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import { ISLANDS, START_ID, FIRST_SUGGESTION, buildIndex } from "../../site/js/atlas-graph.js";
import { NO_GLOSSARY_NOTICE } from "../../site/js/atlas.js";
import { ARROW_KEYS, EDGE_STRIP, createArrowNav } from "../../site/js/atlas-map.js";
import { classifyTerm, compileGlossary, matchReply } from "../../site/js/atlas-match.js";
import * as support from "./atlas_browser_support.mjs";

const { findChrome, launchBrowser, sleep, startSite } = support;

const INDEX = buildIndex();
const GLOSSARY = compileGlossary(ISLANDS);
const CHROME = findChrome();
const CHAT_SKIP = support.CHAT_SETUP ? support.CHAT_SETUP.skip : false;
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

/** Wait until the page has stopped scrolling (the hero link scrolls smoothly). */
async function settle(page) {
  let last = null;
  let still = 0;
  for (let i = 0; i < 100 && still < 4; i += 1) {
    const now = await page.eval(`[scrollX, scrollY, document.querySelector("#atlas-map").scrollLeft].join()`);
    still = now === last ? still + 1 : 0;
    last = now;
    await sleep(60);
  }
  assert.ok(still >= 4, "the page stops scrolling");
}

/** The way a visitor gets to the Atlas from the first screen. */
async function followHeroLink(page) {
  await page.click(".hero-cta-link");
  await settle(page);
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

/** A reply that lights every one of `ids`, and the ids it lights in all (graph order). */
function replyLighting(ids) {
  const reply = ids.map((id) => sentenceFor(INDEX.byId.get(id))).join(" ");
  const lit = matchReply(reply, GLOSSARY);
  for (const id of ids) assert.ok(lit.includes(id), `${id} is lit by its sentence`);
  return { reply, lit };
}

const ordinary = (island) => island.status !== "open" && island.status !== "contested";
/** Places a first reply can light next to the start: ordinary neighbours, in graph order. */
const NEAR_START = ISLANDS.filter((island) => INDEX.neighbours.get(START_ID).has(island.id) && ordinary(island));

/** Where `selector` is, in viewport pixels, and whether all of it is on screen below the sticky header. */
const BOX = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const header = document.querySelector(".site-header").getBoundingClientRect().bottom;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, header,
    inView: r.width > 0 && r.height > 0 && r.top >= header - 1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1 };
})()`;

async function assertInView(page, selector, what) {
  const box = await page.eval(BOX(selector));
  assert.ok(box, `${what} exists`);
  assert.ok(box.inView, `${what} is on screen (${selector}: top ${Math.round(box.top)}, bottom ${Math.round(box.bottom)}, window ${await page.eval("innerHeight")}, header ${Math.round(box.header)})`);
  return box;
}

const R = (selector) => `(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [b.left + scrollX, b.top + scrollY, b.width, b.height].map((v) => Math.round(v * 10) / 10); })()`;

/** The pause messages of the chat bridge, read from its source (MESSAGES is not exported), plus the standing one. */
function noticeMessages() {
  const source = readFileSync(new URL("../../site/js/atlas-chat.js", import.meta.url), "utf8");
  const block = /const MESSAGES = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(block, "atlas-chat.js has a MESSAGES table");
  const found = {};
  for (const line of block[1].matchAll(/^\s*(\w+):\s*"([^"]+)",?\s*$/gm)) found[line[1]] = line[2];
  for (const key of ["starting", "busy", "draft", "rejected", "rate", "unavailable", "noprogress"]) {
    assert.equal(typeof found[key], "string", `the message "${key}" is in the table`);
  }
  return { ...found, noGlossary: NO_GLOSSARY_NOTICE };
}

/** Root font sizes a visitor may use (text-only zoom, a larger default size) and the widths F24 was seen at. */
const TEXT_SIZES = [["100%", ""], ["150%", "24px"], ["200%", "32px"]];
const NOTICE_WIDTHS = [900, 1180, 1280, 1440];

/**
 * Put the page at each width and text size and look at where the pause notice lies: it must meet
 * none of the text around it, lie inside the card, be shown whole, be in the flow, and add no sideways
 * scrolling to the page. Returns the problems found (empty when all is well) and how often the notice
 * sat beside the heading and under it.
 */
async function noticeProblems(page, label) {
  const problems = [];
  const layouts = { beside: 0, below: 0 };
  for (const [zoom, size] of TEXT_SIZES) {
    for (const width of NOTICE_WIDTHS) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const at = `${label} at ${zoom}, ${width}px`;
      const facts = await page.eval(`(async () => {
        const root = document.documentElement;
        if (${JSON.stringify(size)}) root.style.fontSize = ${JSON.stringify(size)}; else root.style.removeProperty("font-size");
        const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await frames();
        const notice = document.querySelector("#atlas-notice");
        const text = notice.textContent;
        // The page's width with and without the message: a notice must not add sideways scrolling.
        notice.textContent = "";
        await frames();
        const without = root.scrollWidth;
        const introTopWithout = document.querySelector(".atlas-intro").getBoundingClientRect().top + scrollY;
        notice.textContent = text;
        await frames();
        const introTop = document.querySelector(".atlas-intro").getBoundingClientRect().top + scrollY;
        const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
        const heading = document.createRange();
        heading.selectNodeContents(document.querySelector("#atlas-title"));
        const h = heading.getBoundingClientRect();
        const positioned = [];
        for (let el = notice; el && el.id !== "atlas"; el = el.parentElement) {
          const s = getComputedStyle(el);
          if (s.position !== "static") positioned.push(el.tagName.toLowerCase() + "#" + el.id + "." + el.className + " " + s.position);
        }
        const s = getComputedStyle(notice);
        return {
          text,
          notice: box(notice),
          card: box(document.querySelector("#atlas")),
          around: {
            intro: box(document.querySelector(".atlas-intro")),
            honesty: box(document.querySelector(".atlas-honesty")),
            heading: { l: h.left, t: h.top, r: h.right, b: h.bottom },
            chips: box(document.querySelector("#atlas-suggest")),
            toolbar: box(document.querySelector("#atlas-toolbar")),
            map: box(document.querySelector("#atlas-map")),
          },
          positioned,
          shown: s.display !== "none" && s.visibility === "visible" && Number(s.opacity) === 1,
          clipped: notice.scrollWidth > notice.clientWidth + 1 || notice.scrollHeight > notice.clientHeight + 1,
          introClipped: document.querySelector(".atlas-intro").scrollHeight > document.querySelector(".atlas-intro").clientHeight + 1,
          rootSize: getComputedStyle(root).fontSize,
          scrollWidth: root.scrollWidth,
          scrollWidthWithout: without,
          introShift: introTop - introTopWithout,
        };
      })()`);
      const meets = (p, q) => p.l < q.r - 0.5 && q.l < p.r - 0.5 && p.t < q.b - 0.5 && q.t < p.b - 0.5;
      const expectedSize = size || "16px";
      if (facts.rootSize !== expectedSize) problems.push(`${at}: the root font size is ${facts.rootSize}, not ${expectedSize}`);
      if (!facts.text) problems.push(`${at}: the notice is empty`);
      if (!(facts.notice.r - facts.notice.l > 20 && facts.notice.b - facts.notice.t > 10)) problems.push(`${at}: the notice has no box ${JSON.stringify(facts.notice)}`);
      for (const [name, other] of Object.entries(facts.around)) {
        if (meets(facts.notice, other)) problems.push(`${at}: the notice (${JSON.stringify(facts.notice)}) lies over the ${name} (${JSON.stringify(other)})`);
      }
      const inside = facts.notice.l >= facts.card.l - 0.5 && facts.notice.r <= facts.card.r + 0.5 && facts.notice.t >= facts.card.t - 0.5 && facts.notice.b <= facts.card.b + 0.5;
      if (!inside) problems.push(`${at}: the notice leaves the card`);
      if (facts.positioned.length) problems.push(`${at}: the notice or a parent is out of the flow (${facts.positioned.join("; ")})`);
      if (!facts.shown) problems.push(`${at}: the notice is not shown`);
      if (facts.clipped) problems.push(`${at}: the text of the notice is cut off`);
      if (facts.introClipped) problems.push(`${at}: the intro is cut off`);
      if (facts.scrollWidth > facts.scrollWidthWithout) problems.push(`${at}: the notice adds sideways scrolling (${facts.scrollWidthWithout} -> ${facts.scrollWidth})`);
      // At normal text size and from 900px up the notice has the room beside the heading: nothing moves when it speaks.
      if (!size && Math.abs(facts.introShift) > 0.5) problems.push(`${at}: the text below moved ${facts.introShift}px when the notice appeared`);
      if (facts.notice.t < facts.around.heading.b - 0.5) layouts.beside += 1;
      else layouts.below += 1;
    }
  }
  return { problems, layouts };
}

// ---------------------------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------------------------

describe("Atlas on screen, with keys and in high contrast (real browser)", { skip: CHROME.path ? CHAT_SKIP : CHROME.reason, timeout: 240000 }, () => {
  before(async (t) => {
    if (support.CHAT_SETUP) t.diagnostic(support.CHAT_SETUP.label);
    browser = await launchBrowser(CHROME.path);
  });

  after(async () => {
    if (browser) await browser.close();
    browser = null;
  });

  // ---- F6 ----

  it("F6. 1440x900, after the hero link: the start place, the counter, the first chip and the edge dragon are on screen, and the map holds still", async (t) => {
    assert.ok(NEAR_START.length >= 1, "the start place has an ordinary neighbour to light");
    const { site, stub, page, url } = await openSite(t, "f6-first-screen", { width: 1440, height: 900 });
    const { reply, lit } = replyLighting(NEAR_START.slice(0, 2).map((island) => island.id));
    stub.reply = () => reply;
    await boot(page, url);
    await followHeroLink(page);

    const seen = async () => ({
      start: await assertInView(page, `#atlas-map [data-id="${START_ID}"] .atlas-disc`, "the start place"),
      startLabel: await assertInView(page, `#atlas-map [data-id="${START_ID}"] .atlas-label`, "its name"),
      count: await assertInView(page, "#atlas-count", "the counter"),
      chip: await assertInView(page, "#atlas-suggest .atlas-chip", "the first chip"),
      caption: await assertInView(page, ".atlas-ed-caption", "the edge dragon's caption"),
      serpent: await assertInView(page, ".atlas-ed-body", "the edge dragon"),
    });
    const first = await seen();
    assert.equal(await page.eval(`document.querySelector("#atlas-suggest .atlas-chip").textContent`), FIRST_SUGGESTION);
    assert.equal(await page.eval(`document.querySelector(".atlas-edge-dragon").classList.contains("is-inked")`), false, "the dragon is still faint");

    const before = await page.eval(`({ map: ${R("#atlas-map")}, toolbar: ${R("#atlas-toolbar")}, suggest: ${R("#atlas-suggest")}, scrollY })`);

    // A question runs: the notice speaks, and nothing around it moves.
    const release = stub.holdStreams();
    await page.clickInView("#atlas-suggest .atlas-chip");
    await stub.waitFor(() => stub.posts.length >= 1, { what: "the chip's POST" });
    await page.waitFor(`document.querySelector("#atlas-notice").textContent.trim().length > 0`, { what: "the pause notice" });
    const busy = await page.eval(`({ map: ${R("#atlas-map")}, toolbar: ${R("#atlas-toolbar")}, suggest: ${R("#atlas-suggest")}, scrollY })`);
    assert.deepEqual(busy, before, "nothing moved when the notice appeared");
    const overlap = await page.eval(`(() => {
      const box = (selector) => { const b = document.querySelector(selector).getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      const meets = (p, q) => p.l < q.r && q.l < p.r && p.t < q.b && q.t < p.b;
      const notice = box("#atlas-notice");
      const card = box("#atlas");
      // The heading is a block as wide as the card: what must stay clear is the text of it.
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("#atlas-title"));
      const text = range.getBoundingClientRect();
      return {
        withChip: meets(notice, box("#atlas-suggest .atlas-chip")),
        withToolbar: meets(notice, box("#atlas-toolbar")),
        withMap: meets(notice, box("#atlas-map")),
        withHeading: meets(notice, { l: text.left, t: text.top, r: text.right, b: text.bottom }),
        inCard: notice.l >= card.l && notice.r <= card.r && notice.t >= card.t && notice.b <= card.b,
        position: getComputedStyle(document.querySelector("#atlas-notice")).position,
        height: notice.b - notice.t,
        beside: notice.l >= text.right && notice.t < text.bottom && notice.b > text.top,
        noticeBox: notice,
        headingBox: { l: text.left, t: text.top, r: text.right, b: text.bottom },
      };
    })()`);
    assert.deepEqual(
      { withChip: overlap.withChip, withToolbar: overlap.withToolbar, withMap: overlap.withMap, withHeading: overlap.withHeading, inCard: overlap.inCard },
      { withChip: false, withToolbar: false, withMap: false, withHeading: false, inCard: true },
      "the notice lies in the empty corner beside the heading, on nothing else",
    );
    // Round 3 (F24): it is in the flow, in the heading row. At this size the row is no taller than the heading
    // alone, which is why nothing above moved.
    assert.equal(overlap.position, "static", "it is part of the page flow (never absolute: it must not be able to cover text)");
    assert.ok(overlap.beside, `it sits beside the heading, in the same row (notice ${JSON.stringify(overlap.noticeBox)}, heading text ${JSON.stringify(overlap.headingBox)})`);
    release();
    await waitReply(page, stub, 1);
    await page.waitFor(`document.querySelector("#atlas-notice").textContent === ""`, { what: "the notice to clear" });

    // The first reply: the chips grow to three, the dragon is inked, and the map is where it was.
    const after = await page.eval(`({ map: ${R("#atlas-map")}, toolbar: ${R("#atlas-toolbar")}, suggest: ${R("#atlas-suggest")}, scrollY })`);
    for (const [part, box] of Object.entries(after)) {
      const was = before[part];
      const delta = Array.isArray(box) ? Math.max(...box.map((value, at) => Math.abs(value - was[at]))) : Math.abs(box - was);
      assert.ok(delta <= 3, `${part} moved ${delta}px when the first reply arrived (${JSON.stringify(was)} -> ${JSON.stringify(box)})`);
    }
    const second = await seen();
    for (const key of Object.keys(first)) {
      assert.ok(Math.abs(second[key].top - first[key].top) <= 3, `${key} stays where it was (${Math.round(first[key].top)} -> ${Math.round(second[key].top)})`);
    }
    assert.equal(await page.eval(`document.querySelector(".atlas-edge-dragon").classList.contains("is-inked")`), true, "the dragon is inked, in view");
    const chips = await page.eval(`Array.from(document.querySelectorAll("#atlas-suggest .atlas-chip")).map((chip) => { const r = chip.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; })`);
    assert.ok(chips.length >= 1 && chips.length <= 3);
    assert.ok(chips.every((chip) => Math.abs(chip.top - chips[0].top) <= 2), `all chips share one row ${JSON.stringify(chips)}`);
    const litNow = await page.eval(`Array.from(document.querySelectorAll("#atlas-map .atlas-island.is-visited")).map((g) => g.getAttribute("data-id"))`);
    assert.deepEqual(new Set(litNow), new Set([START_ID, ...lit]), "the reply lit what its sentences name");
    assert.equal(site.stub.csrfFailures.length, 0);
  });

  it("F6. 1280x800: the start place, the counter, the first chip and the edge dragon are on screen before and after the first reply", async (t) => {
    const { stub, page, url } = await openSite(t, "f6-laptop", { width: 1280, height: 800 });
    stub.reply = () => replyLighting(NEAR_START.slice(0, 1).map((island) => island.id)).reply;
    await boot(page, url);
    await followHeroLink(page);
    const parts = [
      [`#atlas-map [data-id="${START_ID}"] .atlas-disc`, "the start place"],
      ["#atlas-count", "the counter"],
      ["#atlas-suggest .atlas-chip", "the first chip"],
      [".atlas-ed-caption", "the edge dragon's caption"],
    ];
    const tops = [];
    for (const [selector, what] of parts) tops.push((await assertInView(page, selector, what)).top);
    await page.clickInView("#atlas-suggest .atlas-chip");
    await waitReply(page, stub, 1);
    for (const [at, [selector, what]] of parts.entries()) {
      const box = await assertInView(page, selector, `${what} after the first reply`);
      assert.ok(Math.abs(box.top - tops[at]) <= 3, `${what} did not move (${Math.round(tops[at])} -> ${Math.round(box.top)})`);
    }
  });

  it("F6. with every place visited, no name, label or glyph is cut off by the edge of the map", async (t) => {
    const everything = ISLANDS.map((island) => island.id);
    const { page, url } = await openSite(t, "f6-inside", { width: 1440, height: 900 });
    await page.goto(url);
    await page.eval(`sessionStorage.setItem("esp-atlas", ${JSON.stringify(JSON.stringify({ v: 1, visited: everything, replies: 5 }))})`);
    await page.reload();
    await page.waitFor(`document.querySelectorAll("#atlas-map .atlas-island.is-visited").length === ${everything.length}`, { what: "every place visited" });
    const outside = await page.eval(`(() => {
      const svg = document.querySelector("#atlas-map svg").getBoundingClientRect();
      const out = [];
      for (const el of document.querySelectorAll("#atlas-map svg .atlas-label, #atlas-map svg .atlas-sublabel, #atlas-map svg .atlas-disc, #atlas-map svg .atlas-dragon, #atlas-map svg .atlas-region-name, #atlas-map svg .atlas-region-sub")) {
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        if (r.left < svg.left - 1 || r.right > svg.right + 1 || r.top < svg.top - 1 || r.bottom > svg.bottom + 1) {
          const g = el.closest(".atlas-island");
          out.push((g ? g.getAttribute("data-id") : "region") + " " + el.getAttribute("class") + " " + Math.round(r.left - svg.left) + ".." + Math.round(r.right - svg.left) + " of " + Math.round(svg.width));
        }
      }
      return out;
    })()`);
    assert.deepEqual(outside, [], "everything lies inside the map");
  });

  it("F6. the dragon swims in a strip of sea above the bands and does not cover any place or caption", async (t) => {
    const { page, url } = await openSite(t, "f6-strip", { width: 1440, height: 900 });
    await boot(page, url);
    const geometry = await page.eval(`(() => {
      const svg = document.querySelector("#atlas-map svg");
      const box = (el) => { const b = el.getBBox(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
      const dragon = document.querySelector(".atlas-edge-dragon");
      const bands = Array.from(svg.querySelectorAll(".atlas-band")).map((band) => box(band));
      const sea = box(svg.querySelector(".atlas-sea"));
      const shift = dragon.transform.baseVal.consolidate().matrix.f;
      const own = dragon.getBBox();
      const svgRect = svg.getBoundingClientRect();
      const dragonRect = dragon.getBoundingClientRect();
      const caption = document.querySelector(".atlas-ed-caption").getBoundingClientRect();
      return {
        viewBox: svg.getAttribute("viewBox"),
        sea,
        top: own.y + shift,
        bottom: own.y + own.height + shift,
        bandTop: Math.min(...bands.map((band) => band.y)),
        insideSvg: dragonRect.top >= svgRect.top && dragonRect.bottom <= svgRect.bottom && dragonRect.right <= svgRect.right + 1,
        captionRight: caption.right,
        serpentLeft: document.querySelector(".atlas-ed-body").getBoundingClientRect().left,
      };
    })()`);
    assert.match(geometry.viewBox, new RegExp(`^0 -${EDGE_STRIP} 1240 \\d+$`), geometry.viewBox);
    assert.equal(geometry.sea.y, -EDGE_STRIP, "the sea covers the strip too");
    assert.ok(geometry.top >= -EDGE_STRIP - 1, `the dragon starts inside the strip (${geometry.top})`);
    assert.ok(geometry.bottom <= geometry.bandTop, `and ends above the first band (${geometry.bottom} <= ${geometry.bandTop})`);
    assert.equal(geometry.insideSvg, true, "none of it is clipped");
    assert.ok(geometry.captionRight <= geometry.serpentLeft + 4, "the caption sits beside the serpent, not on it");
  });

  // ---- F7 ----

  it("F7. 390x844: a tap on a chip scrolls the map to the first place the reply lit, without moving focus, and the answer is one tap away", async (t) => {
    // A place far to the right of the map, so the panel really has to scroll sideways to it.
    const far = [...ISLANDS].filter(ordinary).sort((p, q) => q.x - p.x)[0];
    const { reply, lit } = replyLighting([far.id]);
    const first = INDEX.byId.get(lit.find((id) => id !== START_ID));
    const { stub, page, url } = await openSite(t, "f7-phone", { width: 390, height: 844 });
    stub.reply = () => reply;
    await boot(page, url);
    await followHeroLink(page);
    const before = await page.eval(`({ scrollLeft: document.querySelector("#atlas-map").scrollLeft, scrollY, active: document.activeElement.tagName })`);
    assert.equal(before.scrollLeft, 0);

    await page.clickInView("#atlas-suggest .atlas-chip");
    await waitReply(page, stub, 1);
    const target = `#atlas-map [data-id="${first.id}"]`;
    await page.waitFor(
      `(() => {
        const header = document.querySelector(".site-header").getBoundingClientRect().bottom;
        const r = document.querySelector(${JSON.stringify(target)} + " .atlas-disc").getBoundingClientRect();
        const panel = document.querySelector("#atlas-map").getBoundingClientRect();
        return r.top >= header && r.bottom <= innerHeight && r.left >= panel.left && r.right <= panel.right;
      })()`,
      { what: `${first.id} (the first place the reply lit) to be in view`, timeout: 8000 },
    );
    const after = await page.eval(`({
      scrollLeft: document.querySelector("#atlas-map").scrollLeft,
      scrollY,
      activeTag: document.activeElement.tagName,
      activeClass: document.activeElement.className,
      activeInMap: !!document.activeElement.closest("#atlas-map"),
    })`);
    assert.ok(after.scrollLeft > 0, `the map panel scrolled sideways (${after.scrollLeft})`);
    assert.notEqual(after.scrollY, before.scrollY, "and the page scrolled to it");
    assert.equal(after.activeInMap, false, "focus did not move to the map");
    assert.match(String(after.activeClass), /atlas-chip/, "focus stayed on the chip that was tapped");

    // The answer is one tap away.
    const link = await page.eval(BOX(".atlas-to-chat"));
    assert.ok(link && link.width > 0 && link.height >= 44, "the way down to the conversation is shown, at least 44px high");
    await assertInView(page, ".atlas-to-chat", "the link to the conversation");
    await page.click(".atlas-to-chat");
    await page.waitFor(`(() => { const r = document.querySelector("#conversation").getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight - 200; })()`, { what: "the conversation to scroll into view", timeout: 8000 });
    const rows = await page.eval(`Array.from(document.querySelectorAll("#history li > p")).map((p) => p.textContent)`);
    assert.equal(rows[rows.length - 1], reply, "the answer is the last row of the history");
  });

  it("F7. under reduced motion the scroll to the lit place is instant", async (t) => {
    const far = [...ISLANDS].filter(ordinary).sort((p, q) => q.x - p.x)[0];
    const { reply, lit } = replyLighting([far.id]);
    const first = lit.find((id) => id !== START_ID);
    const { stub, page, url } = await openSite(t, "f7-reduced", { width: 390, height: 844, reducedMotion: true });
    stub.reply = () => reply;
    await boot(page, url);
    await followHeroLink(page);
    await page.clickInView("#atlas-suggest .atlas-chip");
    await waitReply(page, stub, 1);
    // No waiting for an animation: the scan of the reply and the scroll happen in one task.
    const inView = await page.eval(`(() => {
      const header = document.querySelector(".site-header").getBoundingClientRect().bottom;
      const r = document.querySelector('#atlas-map [data-id="${first}"] .atlas-disc').getBoundingClientRect();
      const panel = document.querySelector("#atlas-map").getBoundingClientRect();
      return r.top >= header && r.bottom <= innerHeight && r.left >= panel.left && r.right <= panel.right;
    })()`);
    assert.equal(inView, true, `${first} is in view as soon as the reply is scanned`);
  });

  it("F7. a visitor reading the conversation keeps their place: a reply they typed moves the map panel, not the page", async (t) => {
    const far = [...ISLANDS].filter(ordinary).sort((p, q) => q.x - p.x)[0];
    const { reply } = replyLighting([far.id]);
    const { stub, page, url } = await openSite(t, "f7-reading", { width: 390, height: 844 });
    stub.reply = () => reply;
    await boot(page, url);
    await page.eval(`(document.querySelector("#conversation").scrollIntoView({ block: "center", behavior: "instant" }), true)`);
    await settle(page);
    await page.click("#draft");
    await page.type("Tell me about it.");
    await page.eval(`(document.querySelector("#conversation").scrollIntoView({ block: "center", behavior: "instant" }), true)`);
    await settle(page);
    const before = await page.eval(`({ scrollY, scrollLeft: document.querySelector("#atlas-map").scrollLeft, apart: document.querySelector("#conversation").getBoundingClientRect().top - document.querySelector("#atlas-map").getBoundingClientRect().top })`);
    assert.ok(before.apart > 1000, `the conversation lies far below the map in one column (${Math.round(before.apart)}px)`);
    await page.clickInView("#send");
    await waitReply(page, stub, 1);
    await sleep(900);
    const after = await page.eval(`({
      scrollY,
      scrollLeft: document.querySelector("#atlas-map").scrollLeft,
      chat: document.querySelector("#conversation").getBoundingClientRect().top < innerHeight - 200,
      lastRow: (() => { const rows = document.querySelectorAll("#history li > p"); const r = rows[rows.length - 1].getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })(),
    })`);
    // The chat card grows by a few rows and the browser keeps what the visitor looks at in place; a jump to
    // the map would be a thousand pixels or more.
    assert.ok(Math.abs(after.scrollY - before.scrollY) < 400, `the page stayed where the visitor was reading (${before.scrollY} -> ${after.scrollY})`);
    assert.equal(after.chat, true, "the conversation is still on screen");
    assert.equal(after.lastRow, true, "and so is the answer");
    assert.ok(after.scrollLeft > 0, "the map panel is already turned to the lit place for when they look up");
  });

  it("F7. on a wide screen the link to the conversation is not shown and a reply does not scroll the page", async (t) => {
    const { stub, page, url } = await openSite(t, "f7-wide", { width: 1440, height: 900 });
    stub.reply = () => replyLighting(NEAR_START.slice(0, 1).map((island) => island.id)).reply;
    await boot(page, url);
    await followHeroLink(page);
    const link = await page.eval(`(() => { const el = document.querySelector(".atlas-to-chat"); const r = el.getBoundingClientRect(); return { hidden: el.hidden, shown: r.width > 0 && r.height > 0, display: getComputedStyle(el).display }; })()`);
    assert.deepEqual(link, { hidden: false, shown: false, display: "none" });
    const before = await page.eval("scrollY");
    await page.clickInView("#atlas-suggest .atlas-chip");
    await waitReply(page, stub, 1);
    await sleep(500);
    assert.equal(await page.eval("scrollY"), before);
  });

  // ---- F8 ----

  it("F8. forced colors: every fill and stroke of the map is a system colour and the text is readable, in every state", async (t) => {
    const dragons = ISLANDS.filter((island) => island.status === "open");
    const contested = ISLANDS.filter((island) => island.status === "contested");
    assert.ok(dragons.length >= 1 && contested.length >= 1);
    // The first 24 places in the order a walk from the start meets them, plus one contested and one open place.
    const walk = [START_ID];
    for (let at = 0; at < walk.length && walk.length < 24; at += 1) {
      for (const id of INDEX.neighbours.get(walk[at])) if (!walk.includes(id) && walk.length < 24) walk.push(id);
    }
    const visited = [...new Set([...walk, contested[0].id, dragons[0].id])];
    const { page, url } = await openSite(t, "f8-forced", { width: 1280, height: 900 });
    await page.goto(url);
    await page.eval(`sessionStorage.setItem("esp-atlas", ${JSON.stringify(JSON.stringify({ v: 1, visited, replies: 3 }))})`);
    await page.reload();
    await page.waitFor(`(document.querySelector("#atlas-count")?.textContent || "").length > 0`);
    await page.waitFor(`document.querySelectorAll("#atlas-map .atlas-island.is-visited").length === ${visited.length}`, { what: "the saved map" });

    // A keyboard-focused place (so :focus-visible applies) and an active one.
    const focusId = await page.eval(`(() => document.querySelector('#atlas-map .atlas-island.is-frontier:not(.is-open)')?.getAttribute("data-id") || "")()`);
    assert.ok(focusId, "there is a next-to-explore place to focus");
    await page.press("Shift");
    await page.eval(`(document.querySelector('#atlas-map [data-id="${focusId}"]').focus(), true)`);
    assert.equal(await page.eval(`document.querySelector('#atlas-map [data-id="${focusId}"]').matches(":focus-visible")`), true);

    const STATES = `(() => {
      const q = (selector) => document.querySelectorAll("#atlas-map " + selector).length;
      return {
        visited: q(".atlas-island.is-visited"),
        frontier: q(".atlas-island.is-frontier"),
        fogged: q(".atlas-island.is-fogged"),
        contestedVisited: q(".atlas-island.is-contested.is-visited"),
        openVisited: q(".atlas-island.is-open.is-visited"),
        openFrontier: q(".atlas-island.is-open.is-frontier"),
        lit: q(".atlas-edge.is-lit"),
        stub: q(".atlas-edge.is-stub"),
        active: q(".atlas-island.is-active"),
        inked: q(".atlas-edge-dragon.is-inked"),
        focused: q(".atlas-island:focus-visible"),
      };
    })()`;
    const states = await page.eval(STATES);
    for (const key of ["visited", "frontier", "fogged", "contestedVisited", "openVisited", "lit", "stub", "active", "inked", "focused"]) {
      assert.ok(states[key] >= 1, `the page shows a state "${key}" to check (${JSON.stringify(states)})`);
    }

    const PAINT = `(() => {
      const probe = (name) => { const el = document.createElement("div"); el.style.color = name; document.body.appendChild(el); const value = getComputedStyle(el).color; el.remove(); return value; };
      const system = new Set(["Canvas", "CanvasText", "GrayText", "Highlight", "HighlightText", "ButtonText", "ButtonFace", "LinkText", "Mark", "MarkText"].map(probe));
      const parse = (c) => (c.match(/[\\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const allowed = (value) => value === "none" || value === "rgba(0, 0, 0, 0)" || system.has(value);
      const sea = parse(getComputedStyle(document.querySelector("#atlas-map .atlas-sea")).fill).slice(0, 3);
      const wrong = [];
      let checked = 0;
      for (const el of document.querySelectorAll("#atlas-map svg *")) {
        const style = getComputedStyle(el);
        for (const property of ["fill", "stroke"]) {
          checked += 1;
          if (!allowed(style[property])) wrong.push(el.tagName + "." + (el.getAttribute("class") || "") + " " + property + "=" + style[property]);
        }
      }
      const text = [];
      for (const el of document.querySelectorAll("#atlas-map svg text")) {
        const g = el.closest(".atlas-island");
        if (g && getComputedStyle(g).display === "none") continue;
        const r = el.getBoundingClientRect();
        if (el.closest(".atlas-edge-tip") || !r.width) continue;
        const fill = parse(getComputedStyle(el).fill).slice(0, 3);
        text.push({ what: el.tagName + "." + (el.getAttribute("class") || "") + " " + (g ? g.getAttribute("class") : ""), ratio: ratio(fill, sea) });
      }
      return { forced: matchMedia("(forced-colors: active)").matches, checked, wrong: wrong.slice(0, 12), wrongCount: wrong.length, text, system: [...system] };
    })()`;

    // Normal colours first: the palette really is in force, so the forced rules are what changes it.
    const normal = await page.eval(PAINT);
    assert.equal(normal.forced, false);
    assert.ok(normal.wrongCount > 20, `outside forced colours the map uses its palette (${normal.wrongCount} non-system paints)`);

    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    try {
      await page.waitFor(`matchMedia("(forced-colors: active)").matches`, { what: "forced colors to apply" });
      await page.waitFor(`(() => { const s = getComputedStyle(document.querySelector("#atlas-map .atlas-edge-line")).stroke; return !/0\\.5\\)/.test(s); })()`, { what: "no colour is mid-transition", timeout: 4000 });
      const forced = await page.eval(PAINT);
      assert.equal(forced.forced, true, "forced colors are on");
      assert.ok(forced.checked > 500, `${forced.checked} paints checked`);
      assert.deepEqual(forced.wrong, [], `${forced.wrongCount} fills or strokes keep a palette colour`);
      assert.ok(forced.text.length > 40, `${forced.text.length} text elements checked`);
      const unreadable = forced.text.filter((entry) => entry.ratio < 4.5);
      assert.deepEqual(unreadable, [], "every label, sublabel, region caption and the edge dragon's caption has 4.5:1 against the sea");
      const kinds = await page.eval(`(() => {
        const sea = getComputedStyle(document.querySelector("#atlas-map .atlas-sea")).fill;
        const fillOf = (selector) => { const el = document.querySelector("#atlas-map " + selector); return el ? getComputedStyle(el).fill : null; };
        const strokeOf = (selector) => { const el = document.querySelector("#atlas-map " + selector); return el ? getComputedStyle(el).stroke : null; };
        return {
          sea,
          frontierLabel: fillOf(".atlas-island.is-frontier .atlas-label"),
          focusedLabel: fillOf(".atlas-island:focus-visible .atlas-label"),
          activeLabel: fillOf(".atlas-island.is-active .atlas-label"),
          openSublabel: fillOf(".atlas-island.is-open .atlas-sublabel"),
          contestedSublabel: fillOf(".atlas-island.is-contested .atlas-sublabel"),
          caption: fillOf(".atlas-ed-caption"),
          stubLine: strokeOf(".atlas-edge.is-stub .atlas-edge-line"),
          litLine: strokeOf(".atlas-edge.is-lit:not(.is-active) .atlas-edge-line"),
          text: getComputedStyle(document.querySelector("#atlas-map .atlas-region-name")).fill,
        };
      })()`);
      for (const key of ["frontierLabel", "focusedLabel", "activeLabel", "caption"]) {
        assert.equal(kinds[key], kinds.text, `${key} is CanvasText`);
        assert.notEqual(kinds[key], kinds.sea, `${key} is not the colour of the sea`);
      }
      for (const key of ["openSublabel", "contestedSublabel"]) if (kinds[key]) assert.equal(kinds[key], kinds.text, `${key} is CanvasText`);
      assert.notEqual(kinds.stubLine, kinds.litLine, "a path that is only a stub still differs from a lit one (GrayText, dashed)");
    } finally {
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "none" }] });
    }
    const back = await page.eval(PAINT);
    assert.equal(back.forced, false);
    assert.ok(back.wrongCount > 20, "and the palette is back when forced colors go off");
  });

  // ---- F5 ----

  it("F5. the arrow keys follow paths in the page: the nearest place that way first, and back-and-forth tries the next", async (t) => {
    const everything = ISLANDS.map((island) => island.id);
    const { page, url } = await openSite(t, "f5-arrows", { width: 1440, height: 900 });
    await page.goto(url);
    await page.eval(`sessionStorage.setItem("esp-atlas", ${JSON.stringify(JSON.stringify({ v: 1, visited: everything, replies: 5 }))})`);
    await page.reload();
    await page.waitFor(`document.querySelectorAll("#atlas-map .atlas-island.is-visited").length === ${everything.length}`, { what: "every place visited" });
    const arrows = createArrowNav({ index: INDEX, usable: () => true });

    const focused = () => page.eval(`document.activeElement && document.activeElement.closest ? (document.activeElement.closest(".atlas-island")?.getAttribute("data-id") || "") : ""`);
    // A place with two or more neighbours the same way, to see the cycling; and a few ordinary places.
    let cycling = null;
    for (const island of ISLANDS) {
      for (const key of Object.keys(ARROW_KEYS)) {
        if (!cycling && arrows.ranked(island.id, key).length >= 2) cycling = { id: island.id, key, list: arrows.ranked(island.id, key) };
      }
    }
    assert.ok(cycling, "some place has two paths leading the same way");
    const opposite = { ArrowRight: "ArrowLeft", ArrowLeft: "ArrowRight", ArrowDown: "ArrowUp", ArrowUp: "ArrowDown" }[cycling.key];

    await page.press("Shift");
    await page.eval(`(document.querySelector('#atlas-map [data-id="${cycling.id}"]').focus(), true)`);
    assert.equal(await focused(), cycling.id);
    await page.press(cycling.key);
    assert.equal(await focused(), cycling.list[0], `${cycling.key} from ${cycling.id} goes to its best place that way`);
    await page.press(opposite);
    assert.equal(await focused(), cycling.id, "the opposite arrow comes back");
    await page.press(cycling.key);
    assert.equal(await focused(), cycling.list[1], "and the same arrow again tries the next one");

    // Plain first presses agree with the geometry for a sample of places.
    for (const island of ISLANDS.filter((_, at) => at % 7 === 0)) {
      for (const key of Object.keys(ARROW_KEYS)) {
        const expected = createArrowNav({ index: INDEX, usable: () => true }).press(island.id, key);
        await page.eval(`(document.querySelector('#atlas-map [data-id="${island.id}"]').focus(), true)`);
        await page.press(key);
        assert.equal(await focused(), expected ?? island.id, `${key} from ${island.id}`);
      }
    }
  });

  // ---- F24 ----

  it("F24. with text enlarged to 150% and 200% the pause notice covers neither the intro, the honesty note, the heading nor the chips (every message, 900-1440px)", async (t) => {
    const messages = noticeMessages();
    const { page, url } = await openSite(t, "f24-all-messages", { width: 1440, height: 900 });
    await boot(page, url);
    // The messages the chat bridge can speak and the standing one, as the controller writes them: textContent of the live region.
    const problems = [];
    const layouts = { beside: 0, below: 0 };
    for (const [name, message] of Object.entries(messages)) {
      await page.eval(`(document.querySelector("#atlas-notice").textContent = ${JSON.stringify(message)}, true)`);
      const found = await noticeProblems(page, `"${name}"`);
      problems.push(...found.problems);
      layouts.beside += found.layouts.beside;
      layouts.below += found.layouts.below;
    }
    assert.equal(problems.length, 0, `the notice lies in the flow and meets no text, in every combination (${problems.length} problems, the first ones):\n${problems.slice(0, 8).join("\n")}`);
    // Not a vacuous pass: both layouts really occur (beside the heading where there is room, under it where there is not).
    assert.ok(layouts.beside > 0, `the notice sits beside the heading somewhere (${JSON.stringify(layouts)})`);
    assert.ok(layouts.below > 0, `and drops under the heading when text is enlarged (${JSON.stringify(layouts)})`);
    // The longest ones are among those checked.
    const longest = Object.values(messages).sort((p, q) => q.length - p.length).slice(0, 3);
    assert.ok(longest.includes("The chat asked for a pause. Suggestions will be back shortly.") || longest.includes(NO_GLOSSARY_NOTICE));
  });

  it("F24. the notice the chat really speaks (a question running, a pause after a refusal) keeps clear of the text as well, and appears and goes without a trace", async (t) => {
    const { stub, page, url } = await openSite(t, "f24-real-states", { width: 1440, height: 900 });
    stub.reply = () => replyLighting(NEAR_START.slice(0, 1).map((island) => island.id)).reply;
    await boot(page, url);

    // A question runs.
    const release = stub.holdStreams();
    await followHeroLink(page);
    await page.clickInView("#atlas-suggest .atlas-chip");
    await stub.waitFor(() => stub.posts.length >= 1, { what: "the chip's POST" });
    await page.waitFor(`/busy/.test(document.querySelector("#atlas-notice").textContent)`, { what: "the busy notice" });
    const busy = await noticeProblems(page, "busy");
    assert.equal(busy.problems.length, 0, busy.problems.slice(0, 8).join("\n"));
    await page.eval(`(document.documentElement.style.removeProperty("font-size"), true)`);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    release();
    await waitReply(page, stub, 1);
    await page.waitFor(`document.querySelector("#atlas-notice").textContent === ""`, { what: "the notice to clear" });
    const gone = await page.eval(`(() => { const b = document.querySelector("#atlas-notice").getBoundingClientRect(); return { height: b.height, width: b.width }; })()`);
    assert.deepEqual(gone, { height: 0, width: 0 }, "an empty notice has no box at all");

    // A refusal: the chat asks for a pause (409 from the server), and the notice says so for a while.
    stub.outcome = () => 409;
    await page.click("#atlas-suggest .atlas-chip");
    await stub.waitFor(() => stub.posts.length >= 2, { what: "the second POST" });
    await page.waitFor(`/pause/.test(document.querySelector("#atlas-notice").textContent)`, { what: "the pause notice", timeout: 15000 });
    const rejected = await noticeProblems(page, "rejected");
    assert.equal(rejected.problems.length, 0, rejected.problems.slice(0, 8).join("\n"));
  });

  it("F24. a phone puts the notice under the heading, in the flow, and the text below makes room for as long as it speaks", async (t) => {
    const { stub, page, url } = await openSite(t, "f24-phone", { width: 390, height: 844 });
    stub.reply = () => replyLighting(NEAR_START.slice(0, 1).map((island) => island.id)).reply;
    await boot(page, url);
    const introTop = () => page.eval(`document.querySelector(".atlas-intro").getBoundingClientRect().top + scrollY`);
    const idle = await introTop();
    const release = stub.holdStreams();
    await page.click("#atlas-suggest .atlas-chip");
    await stub.waitFor(() => stub.posts.length >= 1, { what: "the chip's POST" });
    await page.waitFor(`document.querySelector("#atlas-notice").textContent.trim().length > 0`, { what: "the pause notice" });
    const facts = await page.eval(`(() => {
      const n = document.querySelector("#atlas-notice").getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("#atlas-title"));
      const h = range.getBoundingClientRect();
      const intro = document.querySelector(".atlas-intro").getBoundingClientRect();
      return { position: getComputedStyle(document.querySelector("#atlas-notice")).position, noticeTop: n.top, noticeBottom: n.bottom, headingBottom: h.bottom, introTop: intro.top };
    })()`);
    assert.equal(facts.position, "static");
    assert.ok(facts.noticeTop >= facts.headingBottom - 0.5, "under the heading");
    assert.ok(facts.noticeBottom <= facts.introTop + 0.5, "and above the intro, covering neither");
    assert.ok((await introTop()) > idle + 20, "the text below makes room for it");
    release();
    await waitReply(page, stub, 1);
    await page.waitFor(`document.querySelector("#atlas-notice").textContent === ""`, { what: "the notice to clear" });
    assert.ok(Math.abs((await introTop()) - idle) <= 1, "and takes it back when the notice goes");
  });

  // ---- F36 ----

  it("F36. 390x844: a visitor who scrolls to the top while waiting is not pulled down to the map when the reply lands (the panel still turns to the lit place)", async (t) => {
    const far = [...ISLANDS].filter(ordinary).sort((p, q) => q.x - p.x)[0];
    const { reply, lit } = replyLighting([far.id]);
    const first = lit.find((id) => id !== START_ID);
    const { stub, page, url } = await openSite(t, "f36-scrolled-away", { width: 390, height: 844 });
    stub.reply = () => reply;
    await boot(page, url);
    await followHeroLink(page);
    const atMap = await page.eval("scrollY");
    assert.ok(atMap > 1000, `the map lies far down the page in one column (${atMap}px)`);

    const release = stub.holdStreams();
    await page.clickInView("#atlas-suggest .atlas-chip");
    await stub.waitFor(() => stub.posts.length >= 1, { what: "the chip's POST" });
    // The visitor loses patience and goes back to the top of the page.
    await page.eval(`(window.scrollTo({ top: 0, left: 0, behavior: "instant" }), true)`);
    await settle(page);
    assert.equal(await page.eval("scrollY"), 0);
    assert.equal(await page.eval(`document.querySelector("#atlas").getBoundingClientRect().top > innerHeight`), true, "the Atlas card is out of view");
    release();
    await waitReply(page, stub, 1);
    await page.waitFor(`document.querySelector("#atlas-map").scrollLeft > 0`, { what: "the map panel to turn to the lit place", timeout: 8000 });
    await sleep(1200); // a smooth scroll to the map would be under way, or done, by now
    const after = await page.eval(`({ scrollY, litPlace: document.querySelector('#atlas-map [data-id="${first}"]').classList.contains("is-visited") })`);
    assert.equal(after.litPlace, true, "the reply did light its place");
    assert.equal(after.scrollY, 0, "and the visitor is left at the top of the page");
  });

  it("F36. 390x844: a visitor who stays where they asked is still taken to the lit place", async (t) => {
    const far = [...ISLANDS].filter(ordinary).sort((p, q) => q.x - p.x)[0];
    const { reply, lit } = replyLighting([far.id]);
    const first = lit.find((id) => id !== START_ID);
    const { stub, page, url } = await openSite(t, "f36-stays", { width: 390, height: 844 });
    stub.reply = () => reply;
    await boot(page, url);
    await followHeroLink(page);
    const release = stub.holdStreams();
    await page.clickInView("#atlas-suggest .atlas-chip");
    await stub.waitFor(() => stub.posts.length >= 1, { what: "the chip's POST" });
    // A small scroll while waiting (less than half a screen) changes nothing.
    await page.eval(`(window.scrollBy({ top: -150, left: 0, behavior: "instant" }), true)`);
    await settle(page);
    release();
    await waitReply(page, stub, 1);
    await page.waitFor(
      `(() => {
        const header = document.querySelector(".site-header").getBoundingClientRect().bottom;
        const r = document.querySelector('#atlas-map [data-id="${first}"] .atlas-disc').getBoundingClientRect();
        const panel = document.querySelector("#atlas-map").getBoundingClientRect();
        return r.top >= header && r.bottom <= innerHeight && r.left >= panel.left && r.right <= panel.right;
      })()`,
      { what: `${first} to be in view`, timeout: 8000 },
    );
  });

  // ---- F37 ----

  it("F37. 1366x768, after the hero link: the start place's NAME is on screen with its disc, the counter, the first chip and the edge dragon's caption, before and after the first reply", async (t) => {
    const { stub, page, url } = await openSite(t, "f37-laptop", { width: 1366, height: 768 });
    stub.reply = () => replyLighting(NEAR_START.slice(0, 1).map((island) => island.id)).reply;
    await boot(page, url);
    await followHeroLink(page);
    const parts = [
      [`#atlas-map [data-id="${START_ID}"] .atlas-disc`, "the start place"],
      [`#atlas-map [data-id="${START_ID}"] .atlas-label`, "the start place's name"],
      ["#atlas-count", "the counter"],
      ["#atlas-suggest .atlas-chip", "the first chip"],
      [".atlas-ed-caption", "the edge dragon's caption"],
      [".atlas-ed-body", "the edge dragon"],
    ];
    const tops = [];
    for (const [selector, what] of parts) tops.push((await assertInView(page, selector, what)).top);
    const label = await page.eval(BOX(`#atlas-map [data-id="${START_ID}"] .atlas-label`));
    assert.ok(label.bottom <= 768, `the name ends above the bottom of the window (${Math.round(label.bottom)} <= 768)`);
    assert.equal(await page.eval(`document.querySelector("#atlas-map [data-id='${START_ID}'] .atlas-label").textContent`), INDEX.byId.get(START_ID).name);

    // The tighter spacing of a short window keeps the heading row as tall as the notice needs: a question running moves nothing.
    const release = stub.holdStreams();
    await page.clickInView("#atlas-suggest .atlas-chip");
    await stub.waitFor(() => stub.posts.length >= 1, { what: "the chip's POST" });
    await page.waitFor(`document.querySelector("#atlas-notice").textContent.trim().length > 0`, { what: "the pause notice" });
    for (const [at, [selector, what]] of parts.entries()) {
      const box = await assertInView(page, selector, `${what} while the notice speaks`);
      assert.ok(Math.abs(box.top - tops[at]) <= 0.5, `${what} did not move when the notice appeared (${Math.round(tops[at])} -> ${Math.round(box.top)})`);
    }
    release();
    await waitReply(page, stub, 1);
    for (const [at, [selector, what]] of parts.entries()) {
      const box = await assertInView(page, selector, `${what} after the first reply`);
      assert.ok(Math.abs(box.top - tops[at]) <= 3, `${what} did not move (${Math.round(tops[at])} -> ${Math.round(box.top)})`);
    }
  });

  for (const [width, height] of [[1280, 720], [1536, 864], [1024, 768]]) {
    it(`F37. ${width}x${height}, after the hero link: the start place's name is on screen as well`, async (t) => {
      const { page, url } = await openSite(t, `f37-${width}x${height}`, { width, height });
      await boot(page, url);
      await followHeroLink(page);
      for (const [selector, what] of [
        [`#atlas-map [data-id="${START_ID}"] .atlas-disc`, "the start place"],
        [`#atlas-map [data-id="${START_ID}"] .atlas-label`, "its name"],
        ["#atlas-count", "the counter"],
        ["#atlas-suggest .atlas-chip", "the first chip"],
        [".atlas-ed-caption", "the edge dragon's caption"],
      ]) {
        await assertInView(page, selector, what);
      }
    });
  }

  // ---- F38 ----

  it("F38. a short keyboard hint shows under the map while the map has focus, moves nothing, and is not a live region", async (t) => {
    const HINT = "Arrow keys follow paths, repeat an arrow to try the next place; PageUp and PageDown step through every place.";
    const { page, url } = await openSite(t, "f38-keyhint", { width: 1440, height: 900 });
    await boot(page, url);
    const read = () => page.eval(`(() => {
      const hint = document.querySelector(".atlas-keyhint");
      const r = (el) => { const b = el.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((v) => Math.round(v * 10) / 10); };
      const s = getComputedStyle(hint);
      return {
        text: hint.textContent,
        hiddenAttribute: hint.hidden,
        visibility: s.visibility,
        display: s.display,
        box: r(hint),
        map: r(document.querySelector("#atlas-map")),
        toolbar: r(document.querySelector("#atlas-toolbar")),
        suggest: r(document.querySelector("#atlas-suggest")),
        live: !!hint.closest("[aria-live], [role=status], [role=alert], [role=log]"),
        notice: document.querySelector("#atlas-notice").textContent,
        announce: document.querySelector("#atlas-announce").textContent,
        focusInMap: !!document.querySelector("#atlas-map").querySelector(":focus"),
        descLen: document.querySelector("#atlas-map svg desc").textContent.length,
        desc: document.querySelector("#atlas-map svg desc").textContent,
      };
    })()`);

    const idle = await read();
    assert.equal(idle.text, HINT);
    assert.equal(idle.hiddenAttribute, false, "the script shows it (without a script it stays hidden)");
    assert.equal(idle.visibility, "hidden", "invisible while the map has no focus");
    assert.equal(idle.focusInMap, false);
    assert.ok(idle.box[3] >= 15, `but its line is kept (${idle.box[3]}px high)`);
    assert.ok(idle.box[1] >= idle.map[1] + idle.map[3] - 0.5, "it lies under the map, not over it");
    assert.equal(idle.live, false, "it is plain text, not a live region");
    assert.ok(/Arrow keys/.test(idle.desc) && /Page Down and Page Up/.test(idle.desc), "the SVG description is kept");

    // Keyboard focus into the map: Tab-like focus on a place the visitor can reach.
    await page.press("Shift");
    await page.eval(`(document.querySelector('#atlas-map [data-id="${START_ID}"]').focus(), true)`);
    const focused = await read();
    assert.equal(focused.focusInMap, true);
    assert.equal(focused.visibility, "visible", "visible while the map has focus");
    assert.deepEqual(focused.box, idle.box, "the hint did not move");
    for (const part of ["map", "toolbar", "suggest"]) assert.deepEqual(focused[part], idle[part], `${part} did not move`);
    assert.equal(focused.notice, idle.notice, "the notice was not touched");
    assert.equal(focused.announce, idle.announce, "and nothing was said through the spoken summary");
    assert.equal(focused.live, false);

    // Arrow keys still work, and the hint stays while the focus stays in the map.
    await page.press("ArrowRight");
    assert.equal((await read()).visibility, "visible");

    // Focus leaves the map: the hint goes, its line stays.
    await page.eval(`(document.querySelector("#atlas-suggest .atlas-chip").focus(), true)`);
    const left = await read();
    assert.equal(left.focusInMap, false);
    assert.equal(left.visibility, "hidden");
    assert.deepEqual(left.box, idle.box);

    // The list view has no map to hint about.
    await page.click("#atlas-view-list");
    await page.waitFor(`document.querySelector("#atlas-map").hidden`, { what: "the list view" });
    assert.equal((await read()).display, "none", "no hint (and no blank line) in the list view");
    await page.click("#atlas-view-map");
    assert.notEqual((await read()).display, "none");
  });

  it("F38. the hint is read from a page without the script as nothing: it is hidden until the script runs", async (t) => {
    const { page, url } = await openSite(t, "f38-noscript", { width: 1440, height: 900, scriptsDisabled: true });
    await page.goto(url);
    const facts = await page.eval(`(() => { const el = document.querySelector(".atlas-keyhint"); const r = el.getBoundingClientRect(); return { hidden: el.hidden, width: r.width, height: r.height }; })()`);
    assert.deepEqual(facts, { hidden: true, width: 0, height: 0 });
  });
});
