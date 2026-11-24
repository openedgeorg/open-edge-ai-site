/**
 * Reading an answer in a real browser (finding F04 of the Atlas handoff): the conversation card at
 * desktop and phone widths and at 200 percent, with the answer the audit actually captured.
 *
 * What is checked, in Chrome, against the real site/index.html, site/css/chat.css and site/js/atlas.js:
 *  - the captured 309-word first answer (tests/fixtures/atlas_reading/first_answer.txt) arrives through the
 *    stub chat API and shows as paragraphs: white-space is pre-wrap, the blank lines between paragraphs
 *    take room, and the text is the answer byte for byte, as a text node;
 *  - rows say who is speaking (You / Answer / Problem, a label before the text, a different look per role);
 *  - how much history there is to read in: its visible height and width at 1440x1000, 1280x800, 390x844,
 *    320x740 and at 200 percent (browser zoom, and text at 200 percent), the map keeping its room;
 *  - the beginning of a finished answer is on screen, or one press away ("Back to start of answer"), and
 *    "Jump to latest" brings the visitor to the end;
 *  - a visitor who scrolls up (with the mouse wheel) while a second answer is streamed in and swapped for
 *    the stored history is left where they are;
 *  - long terms, code-like text and list lines wrap: no clipped text, no sideways scroll of the page, at 320,
 *    390, 1440 and 200 percent; model HTML stays text.
 *
 * The conversation client in the page is the one ATLAS_CHAT selects (see atlas_browser_support.mjs): the
 * double (default) or the working tree's own. Rows painted by the double carry no role, so the role checks
 * on live rows run with ATLAS_CHAT=real only; the role look itself is checked with rows built by
 * site/js/render.js in both modes.
 *
 * Run: node --test --test-concurrency=1 tests/e2e/atlas_browser_reading.test.mjs
 * Screenshots go to /tmp/atlas-e2e/ (ATLAS_E2E_OUT).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { CHAT_SETUP, OUT_DIR, findChrome, launchBrowser, startSite } from "./atlas_browser_support.mjs";

const FIXTURES = new URL("../fixtures/atlas_reading/", import.meta.url);
/** The 309-word answer to the first question of the audit, and the 241-word answer to "What is the pot...". */
const FIRST_ANSWER = fs.readFileSync(new URL("first_answer.txt", FIXTURES), "utf8");
const SECOND_ANSWER = fs.readFileSync(new URL("second_answer.txt", FIXTURES), "utf8");
const FIRST_PARAGRAPHS = FIRST_ANSWER.split("\n\n");
const SECOND_QUESTION = "What is the pot an ISP gets each month?";

/** Text that is hard to wrap: an unbroken term, a URL, code, list lines, and markup that must stay text. */
const HOSTILE_ANSWER = [
  "Short intro line.",
  "",
  `Term: ${"honorificabilitudinitatibus".repeat(8)}`,
  "",
  `Link: https://example.invalid/${"very-long-path-segment/".repeat(10)}end`,
  "",
  "Code:",
  "    const settlementTotalForTheWholeEpochInTheCommonFund = priceOfOneRequest * numberOfRequestsServedThisMonth;",
  `    path = "${"/a_long_identifier_without_any_break".repeat(5)}"`,
  "",
  `- A list item that needs several lines on a phone, mentioning ${"unbreakable_".repeat(12)} and then more words after it.`,
  `- Another item with a code-like token: P_minus_C=${"9".repeat(60)}`,
  "",
  "<script>window.__pwned = 1</script><img src=x onerror=\"window.__pwned = 2\"> <b>not bold</b>",
].join("\n");

const CHROME = findChrome();
const diagnostics = [];
let browser = null;

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

async function openSite(t, label, pageOptions = {}) {
  const site = await startSite();
  const page = await browser.openPage({ label, diagnostics, ...pageOptions });
  t.after(async () => {
    await page.close();
    await site.close();
  });
  return { site, stub: site.stub, page, url: `${site.origin}/` };
}

/** Load the page and wait until the Atlas has painted and the chat is ready for a question. */
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

/** The nth reply has streamed, the stored history has replaced the streamed rows and the Atlas has read it. */
async function waitReply(page, stub, n, rows = 2 * n) {
  await stub.waitFor(() => stub.completed >= n, { what: `stream ${n} to finish` });
  await page.waitFor(
    `(() => {
      const raw = sessionStorage.getItem("esp-atlas");
      return !!raw && JSON.parse(raw).replies >= ${n}
        && document.querySelector("#phase").textContent.trim() === "ready"
        && document.querySelectorAll("#history > li").length === ${rows};
    })()`,
    { what: `the Atlas to read reply ${n} and the history to hold ${rows} rows`, timeout: 15000 },
  );
  await frames(page, 3);
}

/** A few animation frames, so scroll events and the buttons under the history have been handled. */
const frames = (page, count = 2) =>
  page.eval(`(async () => { for (let i = 0; i < ${count}; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve)); return true; })()`);

/** The visitor asks something in the message box. */
async function ask(page, text) {
  await page.click("#draft");
  await page.type(text);
  await page.click("#send");
}

/** Put the conversation card on screen the way the page lays it out: sticky card in two columns, scrolled to in one. */
const showCard = (page) =>
  page.eval(`(async () => {
    const card = document.querySelector("#conversation");
    const sticky = getComputedStyle(card).position === "sticky";
    if (sticky) window.scrollTo({ top: document.querySelector("#atlas").getBoundingClientRect().top + scrollY + 250, behavior: "instant" });
    else card.scrollIntoView({ block: "start", behavior: "instant" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  })()`);

/** Everything these tests measure about the history, in CSS pixels. */
const READ = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
  const history = document.querySelector("#history");
  const rows = Array.from(history.querySelectorAll(":scope > li"));
  const answers = rows.filter((row) => !row.hasAttribute("data-role") || row.getAttribute("data-role") === "assistant");
  const lastAnswer = answers[answers.length - 1] || null;
  const bar = document.querySelector("#history-nav");
  const button = (id) => { const el = document.getElementById(id); return el && !el.hidden && el.getBoundingClientRect().width > 0 ? { height: el.getBoundingClientRect().height, text: el.textContent } : null; };
  const doc = document.documentElement;
  return {
    viewport: { width: innerWidth, height: innerHeight },
    docOverflow: doc.scrollWidth - doc.clientWidth,
    bodyOverflow: document.body.scrollWidth - doc.clientWidth,
    history: box(history),
    historyScroll: { top: history.scrollTop, height: history.scrollHeight, client: history.clientHeight, sideways: history.scrollWidth - history.clientWidth },
    rowCount: rows.length,
    lastAnswer: lastAnswer ? box(lastAnswer) : null,
    lastAnswerText: lastAnswer ? (lastAnswer.querySelector("p") || {}).textContent : null,
    nav: { visible: !!bar && !bar.hidden, start: button("history-start"), latest: button("history-latest") },
    card: box(document.querySelector("#conversation")),
    cardOverflow: document.querySelector("#conversation").scrollWidth - document.querySelector("#conversation").clientWidth,
    overscroll: getComputedStyle(history).overscrollBehaviorY,
    // The controls that are on screen (the conversation client hides Cancel, Check status ... until they apply).
    controls: ["#draft", "#send", "#provider", "#cancel", "#check-status", "#retry", "#new-conversation", "#history-retry"]
      .map((selector) => document.querySelector(selector))
      .filter((el) => el && el.getBoundingClientRect().width > 0)
      .map((el) => ({ selector: "#" + el.id, ...box(el) })),
    activeId: document.activeElement ? document.activeElement.id : "",
  };
})()`;

const read = (page) => page.eval(READ);

/**
 * The history shows its last line. The card changes height a few times while a question is sent (the status
 * line comes and goes), and the history is put back at its end one frame after each change, so a test that
 * wants the end waits for it.
 */
const AT_END = `(() => { const h = document.querySelector("#history"); return h.scrollHeight - h.scrollTop - h.clientHeight <= 2; })()`;

/** A real wheel turn over an element. */
async function wheel(page, selector, deltaY) {
  const at = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, innerHeight - r.top - 10) }; })()`);
  await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY });
}

const inside = (inner, outer, slack = 1) => inner.top >= outer.top - slack && inner.bottom <= outer.bottom + slack;

/** `cardOnly`: leave the rest of the page (the site header, the map card) out of it and look at the conversation card alone. */
function assertNoSidewaysScroll(snap, label, { cardOnly = false } = {}) {
  if (!cardOnly) {
    assert.ok(snap.docOverflow <= 0, `${label}: the page does not scroll sideways (${snap.docOverflow}px wider than the window)`);
    assert.ok(snap.bodyOverflow <= 0, `${label}: the body does not scroll sideways (${snap.bodyOverflow}px)`);
  }
  assert.ok(snap.historyScroll.sideways <= 0, `${label}: the history does not scroll sideways (${snap.historyScroll.sideways}px)`);
  assert.ok(snap.cardOverflow <= 1, `${label}: the conversation card does not scroll sideways (${snap.cardOverflow}px)`);
  assert.ok(snap.card.right <= snap.viewport.width + 0.5 && snap.card.left >= -0.5, `${label}: the card is inside the window`);
  for (const control of snap.controls) {
    assert.ok(control.right <= snap.card.right + 0.5 && control.left >= snap.card.left - 0.5, `${label}: ${control.selector} stays inside the card`);
  }
}

/** The first line of the newest answer is inside the history window, near its top edge. */
function assertAnswerStartInView(snap, label) {
  assert.ok(snap.lastAnswer, `${label}: there is an answer row`);
  assert.ok(
    snap.lastAnswer.top >= snap.history.top - 1 && snap.lastAnswer.top < snap.history.top + snap.history.height * 0.35,
    `${label}: the answer starts at the top of the history window (answer ${Math.round(snap.lastAnswer.top)}, history ${Math.round(snap.history.top)}-${Math.round(snap.history.bottom)})`,
  );
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

const META_FRAME_ANCESTORS = /frame-ancestors' is ignored when delivered via a <meta> element/i;

// ---------------------------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------------------------

describe("Reading an answer in a real browser", { skip: CHROME.path ? CHAT_SETUP.skip : CHROME.reason, timeout: 300000 }, () => {
  before(async (t) => {
    t.diagnostic(CHAT_SETUP.label);
    browser = await launchBrowser(CHROME.path);
    ensureOutDir();
  });

  after(async () => {
    if (browser) await browser.close();
    browser = null;
  });

  it("1. 1440x1000: the 309-word answer reads as paragraphs, from its first line, in a card with room", async (t) => {
    const { page, stub, url } = await openSite(t, "1-desktop", { width: 1440, height: 1000 });
    stub.reply = () => FIRST_ANSWER;
    await boot(page, url);
    await page.click(".atlas-chip");
    await waitReply(page, stub, 1);
    await showCard(page);
    const snap = await read(page);

    // Room: the audit saw 280 x 352 px.
    assert.ok(snap.history.height >= 420, `the history is tall enough to read in (${Math.round(snap.history.height)}px; it was 352)`);
    assert.ok(snap.history.width >= 330, `and wide enough (${Math.round(snap.history.width)}px; it was 280)`);
    assert.ok(inside(snap.history, { top: 0, bottom: snap.viewport.height }), "the whole history window is on screen");
    assert.equal(snap.overscroll, "contain", "beside the map a wheel turn at the end of the history does not scroll the page away");
    const mapRoom = await page.eval(`(() => { const map = document.querySelector("#atlas-map"); return { overflow: map.scrollWidth - map.clientWidth, width: map.clientWidth }; })()`);
    assert.ok(mapRoom.overflow <= 1 && mapRoom.width >= 900, `the map keeps its 900px drawing without sideways scrolling (${mapRoom.width}px wide, ${mapRoom.overflow}px over)`);
    assertNoSidewaysScroll(snap, "1440x1000");

    // The answer is the captured text, unchanged, as plain text.
    assert.equal(snap.lastAnswerText, FIRST_ANSWER, "the answer row holds the captured answer, character for character");
    const paragraph = await page.eval(`(() => {
      const rows = Array.from(document.querySelectorAll("#history > li"));
      const p = rows[rows.length - 1].querySelector("p");
      const text = p.firstChild;
      const style = getComputedStyle(p);
      const lineHeight = parseFloat(style.lineHeight);
      // Where the last character of paragraph 1 and the first character of paragraph 2 are drawn.
      const first = ${JSON.stringify(FIRST_PARAGRAPHS[0])};
      const at = (index) => { const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + 1); return range.getBoundingClientRect(); };
      const end1 = at(first.length - 1);
      const start2 = at(first.length + 2);
      return {
        whiteSpace: style.whiteSpace,
        overflowWrap: style.overflowWrap,
        children: p.children.length,
        textNodes: p.childNodes.length,
        lineHeight,
        gap: start2.top - end1.bottom,
        sameLine: Math.abs(start2.top - end1.top) < 2,
      };
    })()`);
    assert.equal(paragraph.whiteSpace, "pre-wrap", "line breaks of the answer are kept by the style sheet");
    assert.equal(paragraph.overflowWrap, "anywhere");
    assert.equal(paragraph.children, 0, "no element was made from the text");
    assert.equal(paragraph.textNodes, 1, "one text node");
    assert.ok(!paragraph.sameLine && paragraph.gap >= paragraph.lineHeight * 0.8, `paragraph 2 starts a blank line below paragraph 1 (gap ${paragraph.gap.toFixed(1)}px, line ${paragraph.lineHeight}px)`);
    const bullets = await page.eval(`(() => {
      const p = document.querySelector("#history > li:last-child p");
      const lines = p.textContent.split("\\n").filter((line) => line.startsWith("- "));
      return lines.length;
    })()`);
    assert.equal(bullets, 4, "the four list lines are still lines of their own");

    // The beginning of the answer is where the visitor lands, and the rest is one press away.
    assertAnswerStartInView(snap, "1440x1000");
    assert.ok(snap.historyScroll.height > snap.historyScroll.client * 1.5, "the answer really is longer than the window (otherwise this proves nothing)");
    assert.equal(snap.nav.start, null, "no 'Back to start' while the start is in view");
    assert.ok(snap.nav.latest && snap.nav.latest.text === "Jump to latest", "there is more below, and the page says how to get to it");

    await page.screenshot(path.join(OUT_DIR, "reading-1440x1000-start.png"));

    // Jump to latest: the end of the answer, with the way back to its start.
    await page.click("#history-latest");
    await page.waitFor(AT_END, { what: "Jump to latest to reach the end" });
    const end = await read(page);
    assert.equal(end.activeId, "history", "the press moved focus to the history, so the arrow keys scroll it");
    assert.ok(end.nav.start && end.nav.start.text === "Back to start of answer", "'Back to start of answer' is offered at the end of a long answer");
    assert.equal(end.nav.latest, null, "and 'Jump to latest' is gone");
    await page.screenshot(path.join(OUT_DIR, "reading-1440x1000-end.png"));

    await page.click("#history-start");
    await frames(page);
    const back = await read(page);
    assertAnswerStartInView(back, "after Back to start of answer");
    assert.equal(back.nav.start, null);
    assert.ok(back.nav.latest, "Jump to latest is offered again");
  });

  it("2. a second long answer: the visitor who does not scroll lands on ITS first line", async (t) => {
    const { page, stub, url } = await openSite(t, "2-second-answer", { width: 1440, height: 1000 });
    stub.reply = (_message, n) => (n === 1 ? FIRST_ANSWER : SECOND_ANSWER);
    await boot(page, url);
    await page.click(".atlas-chip");
    await waitReply(page, stub, 1);
    await ask(page, SECOND_QUESTION);
    await waitReply(page, stub, 2);
    await showCard(page);
    const snap = await read(page);
    assert.equal(snap.rowCount, 4, "two questions and two answers");
    assert.equal(snap.lastAnswerText, SECOND_ANSWER);
    assertAnswerStartInView(snap, "second answer");
    assert.ok(snap.historyScroll.top > 0, "the first exchange is above, one scroll away");
  });

  it("3. a visitor who scrolls up to re-read is not dragged down by the next answer, its stored copy, or its end", async (t) => {
    const { page, stub, url } = await openSite(t, "3-scroll-up", { width: 1440, height: 1000 });
    stub.reply = (_message, n) => (n === 1 ? FIRST_ANSWER : SECOND_ANSWER);
    await boot(page, url);
    await page.click(".atlas-chip");
    await waitReply(page, stub, 1);

    // The second question goes out; its answer is held back until the visitor has scrolled.
    const release = stub.holdStreams();
    await ask(page, SECOND_QUESTION);
    await stub.waitFor(() => stub.posts.length >= 2, { what: "the second question to be posted" });
    await page.waitFor(`document.querySelectorAll("#history > li").length >= 3`, { what: "the question to be echoed in the history" });
    await showCard(page);
    await page.waitFor(AT_END, { what: "asking to bring the history to its end, to the visitor's own question" });
    await frames(page, 3);
    const sent = await read(page);
    assert.ok(sent.historyScroll.height - sent.historyScroll.top - sent.historyScroll.client <= 2, "still at the end");

    // They scroll back up with the wheel to read the first answer again.
    await wheel(page, "#history", -700);
    await page.waitFor(`document.querySelector("#history").scrollTop < ${sent.historyScroll.top - 300}`, { what: "the wheel to scroll the history up" });
    await frames(page, 4);
    const away = (await read(page)).historyScroll.top;
    assert.ok(away > 0 && away < sent.historyScroll.top - 300, `scrolled up to ${Math.round(away)} from ${Math.round(sent.historyScroll.top)}`);
    await page.eval(`(() => {
      const history = document.querySelector("#history");
      window.__samples = [];
      const note = (what) => window.__samples.push({ what, top: history.scrollTop, height: history.scrollHeight, rows: history.children.length });
      history.addEventListener("scroll", () => note("scroll"));
      new MutationObserver(() => note("mutation")).observe(history, { childList: true, subtree: true, characterData: true });
      return true;
    })()`);

    // The answer streams in, then the stored history replaces the streamed rows.
    release();
    await waitReply(page, stub, 2, 4);
    await frames(page, 4);
    const samples = await page.eval(`window.__samples`);
    assert.ok(samples.filter((sample) => sample.what === "mutation").length >= 2, `the answer was painted in pieces (${samples.length} samples)`);
    assert.ok(samples.some((sample) => sample.height > sent.historyScroll.height + 200), "the answer made the history longer");
    for (const sample of samples) {
      assert.ok(Math.abs(sample.top - away) <= 2, `${sample.what} left the visitor at ${Math.round(sample.top)}, not at ${Math.round(away)}`);
    }
    const after = await read(page);
    assert.ok(Math.abs(after.historyScroll.top - away) <= 2, `still at ${Math.round(away)} after the answer is complete (${Math.round(after.historyScroll.top)})`);
    assert.equal(after.rowCount, 4);
    assert.ok(after.nav.latest && after.nav.latest.text === "Jump to latest", "the new answer is one press away");
    await page.screenshot(path.join(OUT_DIR, "reading-scrolled-up-during-answer.png"));

    // One press and they are at the newest answer's end; then a question of their own brings them back to the end as before.
    await page.click("#history-latest");
    await page.waitFor(AT_END, { what: "Jump to latest to reach the end" });
    const latest = await read(page);
    assert.ok(latest.lastAnswer && inside({ top: latest.lastAnswer.bottom - 1, bottom: latest.lastAnswer.bottom }, latest.history), "the last line of the newest answer is on screen");
  });

  it("4. 390x844 and 320x740: the page does not scroll sideways, the history is tall, and its end hands a swipe on to the page", async (t) => {
    for (const [width, height] of [
      [390, 844],
      [320, 740],
    ]) {
      const { page, stub, url } = await openSite(t, `4-phone-${width}`, { width, height });
      stub.reply = () => FIRST_ANSWER;
      await boot(page, url);
      await page.click(".atlas-chip");
      await waitReply(page, stub, 1);
      await showCard(page);
      const snap = await read(page);
      const label = `${width}x${height}`;
      assertNoSidewaysScroll(snap, label);
      assert.ok(snap.history.height >= height * 0.5, `${label}: the history is at least half the screen high (${Math.round(snap.history.height)}px)`);
      assert.ok(snap.history.height <= height, `${label}: and never taller than the screen, so it can be read without losing the page`);
      assert.equal(snap.overscroll, "auto", `${label}: a swipe that reaches the end of the history carries on to the page`);
      assertAnswerStartInView(snap, label);
      assert.equal(snap.lastAnswerText, FIRST_ANSWER);
      assert.ok(snap.history.width >= width - 100, `${label}: the history is nearly as wide as the screen (${Math.round(snap.history.width)}px)`);
      assert.ok(snap.nav.latest && snap.nav.latest.height >= 44, `${label}: Jump to latest is at least 44px high (${snap.nav.latest && snap.nav.latest.height})`);
      await page.screenshot(path.join(OUT_DIR, `reading-${label}.png`));
      await page.click("#history-latest");
      await page.waitFor(AT_END, { what: "Jump to latest to reach the end" });
      const end = await read(page);
      assert.ok(end.nav.start && end.nav.start.height >= 44, `${label}: Back to start of answer is at least 44px high`);
      assertNoSidewaysScroll(end, `${label} at the end of the answer`);
    }
  });

  it("5. 1280x800: the card keeps a readable history", async (t) => {
    const { page, stub, url } = await openSite(t, "5-laptop", { width: 1280, height: 800 });
    stub.reply = () => FIRST_ANSWER;
    await boot(page, url);
    await page.click(".atlas-chip");
    await waitReply(page, stub, 1);
    await showCard(page);
    const snap = await read(page);
    // A 800px window leaves the card 712px, and the controls under the history (provider, message box, Send, the
    // action row and the status line of the conversation client) take about 440 of them.
    assert.ok(snap.history.height >= 250, `${Math.round(snap.history.height)}px high`);
    assert.ok(snap.history.width >= 300, `${Math.round(snap.history.width)}px wide`);
    assertAnswerStartInView(snap, "1280x800");
    assertNoSidewaysScroll(snap, "1280x800");
    const card = await page.eval(`(() => { const card = document.querySelector("#conversation"); return { scroll: card.scrollHeight - card.clientHeight, top: card.getBoundingClientRect().top, bottom: card.getBoundingClientRect().bottom, inner: innerHeight }; })()`);
    assert.ok(card.bottom <= card.inner + 1 && card.top >= 0, "the whole card is on screen (it sticks beside the map)");
  });

  for (const [name, setup, setupLeavesTheHeaderWide] of [
    ["browser zoom 200% (a 720x500 window at twice the pixels)", async (page) => page.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 500, deviceScaleFactor: 2, mobile: false }), false],
    [
      "text at 200% (root font size 32px) on a 1440x1000 window",
      async (page) => page.eval(`(document.documentElement.style.fontSize = "32px", true)`),
      false,
    ],
    [
      "text at 200% (root font size 32px) on a 390x844 window",
      async (page) => {
        await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
        await page.eval(`(document.documentElement.style.fontSize = "32px", true)`);
      },
      true,
    ],
  ]) {
    it(`6. ${name}: the answer can be read from its first line and nothing is pushed out of the card`, async (t) => {
      const { page, stub, url } = await openSite(t, `6-${name.slice(0, 12)}`, { width: 1440, height: 1000 });
      stub.reply = () => FIRST_ANSWER;
      await boot(page, url);
      await setup(page);
      await frames(page, 3);
      await page.click(".atlas-chip");
      await waitReply(page, stub, 1);
      await showCard(page);
      const snap = await read(page);
      // A phone-width window with the text at 200% is wider than the window in the site header's own link row
      // (main.css, outside the conversation card): there only the card is held to the rule.
      assertNoSidewaysScroll(snap, name, { cardOnly: setupLeavesTheHeaderWide });
      assert.ok(snap.history.height >= Math.min(300, snap.viewport.height * 0.45), `${name}: the history is ${Math.round(snap.history.height)}px high in a ${snap.viewport.height}px window`);
      assert.ok(snap.history.width >= 200, `${name}: and ${Math.round(snap.history.width)}px wide`);
      assertAnswerStartInView(snap, name);
      assert.equal(snap.lastAnswerText, FIRST_ANSWER);
      assert.ok(snap.nav.latest, `${name}: Jump to latest is offered`);
      assert.ok(snap.nav.latest.height >= 32, `${name}: and big enough to hit (${snap.nav.latest.height}px)`);
      await page.click("#history-latest");
      await page.waitFor(AT_END, { what: `${name}: Jump to latest to reach the end` });
      const end = await read(page);
      assert.ok(end.nav.start, `${name}: and the way back to the start is offered`);
      await page.click("#history-start");
      await frames(page);
      assertAnswerStartInView(await read(page), `${name} after Back to start of answer`);
      await page.screenshot(path.join(OUT_DIR, `reading-${name.slice(0, 22).replace(/[^a-z0-9]+/gi, "-")}.png`));
    });
  }

  for (const [width, height] of [
    [1440, 1000],
    [390, 844],
    [320, 740],
  ]) {
    it(`7. ${width}x${height}: long terms, code-like text and list lines wrap, and model markup stays text`, async (t) => {
      const { page, stub, url } = await openSite(t, `7-hostile-${width}`, { width, height });
      stub.reply = () => HOSTILE_ANSWER;
      await boot(page, url);
      await page.click(".atlas-chip");
      await waitReply(page, stub, 1);
      await showCard(page);
      const snap = await read(page);
      const label = `${width}x${height}`;
      assertNoSidewaysScroll(snap, label);
      assert.equal(snap.lastAnswerText, HOSTILE_ANSWER, `${label}: the text is unchanged`);
      const wraps = await page.eval(`(() => {
        const rows = Array.from(document.querySelectorAll("#history > li"));
        const p = rows[rows.length - 1].querySelector("p");
        // The right edge of every visible character. A space at the end of a line is left out: pre-wrap lets it hang past the edge, unseen.
        const text = p.firstChild;
        const edge = p.getBoundingClientRect().right;
        let widest = -Infinity;
        let where = "";
        for (let at = 0; at < text.length; at += 1) {
          if (/\\s/.test(text.data[at])) continue;
          const range = document.createRange();
          range.setStart(text, at);
          range.setEnd(text, at + 1);
          const right = range.getBoundingClientRect().right;
          if (right > widest) {
            widest = right;
            where = JSON.stringify(text.data.slice(Math.max(0, at - 10), at + 1));
          }
        }
        return {
          where,
          overshoot: widest - edge,
          pOverflow: p.scrollWidth - p.clientWidth,
          rowOverflow: rows[rows.length - 1].scrollWidth - rows[rows.length - 1].clientWidth,
          children: p.children.length,
          injected: document.querySelectorAll("#history script, #history img, #history b").length,
          pwned: window.__pwned === undefined ? null : window.__pwned,
          lines: Math.round(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight)),
        };
      })()`);
      assert.ok(wraps.overshoot <= 0.5, `${label}: no line runs past the edge of its paragraph (${wraps.overshoot}px, at ${wraps.where})`);
      assert.ok(wraps.pOverflow <= 0 && wraps.rowOverflow <= 0, `${label}: nothing is clipped inside the row (p ${wraps.pOverflow}px, row ${wraps.rowOverflow}px)`);
      assert.equal(wraps.children, 0, `${label}: no element was made from the text`);
      assert.equal(wraps.injected, 0, `${label}: model markup did not become elements`);
      assert.equal(wraps.pwned, null, `${label}: no model script ran`);
      assert.ok(wraps.lines >= 14, `${label}: the answer's own line breaks are there (${wraps.lines} lines)`);
      await page.screenshot(path.join(OUT_DIR, `reading-hostile-${label}.png`));
    });
  }

  it("8. rows built by the history renderer: who is speaking is written, and each role looks different (390 and 1440 wide)", async (t) => {
    for (const [width, height] of [
      [1440, 1000],
      [390, 844],
    ]) {
      const { page, url } = await openSite(t, `8-roles-${width}`, { width, height });
      await boot(page, url);
      const facts = await page.eval(`(async () => {
        const { renderHistoryItem } = await import("/js/render.js");
        // The working-tree client repaints its own list (and removes rows it did not make) whenever its state moves, so the
        // rows under test go into a copy of the list that takes its place in the page: same id, same styles, nobody else
        // writing to it. The client keeps painting the detached original.
        const original = document.querySelector("#history");
        const history = original.cloneNode(false);
        original.replaceWith(history);
        renderHistoryItem({ role: "user", text: "Who actually pays the apps I use?" }, history);
        renderHistoryItem({ role: "assistant", text: ${JSON.stringify(FIRST_PARAGRAPHS.slice(0, 2).join("\n\n"))} }, history);
        renderHistoryItem({ role: "error", text: "The answer could not be delivered. Check its status before asking again." }, history);
        renderHistoryItem({ role: "something-else", text: "A row of an unknown role." }, history);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        history.scrollTop = 0;
        const parse = (c) => (c.match(/[\\d.]+/g) || []).map(Number);
        const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
        return Array.from(history.children).map((row) => {
          const label = row.querySelector(".speaker");
          const p = row.querySelector("p");
          const rowStyle = getComputedStyle(row);
          const labelBox = label ? label.getBoundingClientRect() : null;
          const pBox = p.getBoundingClientRect();
          return {
            role: row.getAttribute("data-role"),
            label: label ? label.textContent : null,
            labelDisplay: label ? getComputedStyle(label).display : null,
            labelAbove: labelBox ? labelBox.bottom <= pBox.top + 1 : null,
            background: rowStyle.backgroundColor,
            border: rowStyle.borderLeftColor,
            labelContrast: label ? ratio(parse(getComputedStyle(label).color).slice(0, 3), parse(rowStyle.backgroundColor).slice(0, 3)) : null,
            textContrast: ratio(parse(getComputedStyle(p).color).slice(0, 3), parse(rowStyle.backgroundColor).slice(0, 3)),
            listStyle: getComputedStyle(history).listStyleType,
            width: row.getBoundingClientRect().width,
          };
        });
      })()`);
      const label = `${width}px`;
      assert.deepEqual(
        facts.map((fact) => fact.role),
        ["user", "assistant", "error", null],
      );
      assert.deepEqual(
        facts.map((fact) => fact.label),
        ["You", "Answer", "Problem", null],
      );
      for (const fact of facts.slice(0, 3)) {
        assert.equal(fact.labelDisplay, "block", `${label}: the label stands on its own line`);
        assert.equal(fact.labelAbove, true, `${label}: and above the text (${fact.role})`);
        assert.ok(fact.labelContrast >= 4.5, `${label}: the ${fact.role} label has contrast ${fact.labelContrast.toFixed(2)}:1`);
      }
      for (const fact of facts) {
        assert.ok(fact.textContrast >= 4.5, `${label}: the ${fact.role} text has contrast ${fact.textContrast.toFixed(2)}:1`);
        assert.equal(fact.listStyle, "none", `${label}: no list numbers`);
      }
      assert.equal(new Set(facts.slice(0, 3).map((fact) => `${fact.background}|${fact.border}`)).size, 3, `${label}: question, answer and problem each look different`);
      const rowsWidth = new Set(facts.map((fact) => Math.round(fact.width)));
      assert.equal(rowsWidth.size, 1, `${label}: rows are as wide as each other`);
      await page.screenshot(path.join(OUT_DIR, `reading-roles-${label}.png`));
    }
  });

  it("8b. the status line, the action buttons and the history line of the conversation client are readable and take no room when empty (320 and 1440 wide)", async (t) => {
    for (const [width, height] of [
      [1440, 1000],
      [320, 740],
    ]) {
      const { page, url } = await openSite(t, `8b-status-${width}`, { width, height });
      await boot(page, url);
      const facts = await page.eval(`(async () => {
        const parse = (c) => (c.match(/[\\d.]+/g) || []).map(Number);
        const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
        const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const status = document.querySelector("#chat-status");
        const state = document.querySelector("#history-state");
        const actions = document.querySelector(".chat-actions");
        const card = document.querySelector("#conversation");
        const out = { idle: {}, status: [], state: [], actions: {} };
        // Nothing to say: nothing drawn.
        await frame();
        out.idle = {
          status: getComputedStyle(status).display,
          state: getComputedStyle(state).display,
          actions: getComputedStyle(actions).display,
        };
        // Every kind of outcome the client can show.
        for (const kind of ["working", "waiting", "warning", "long", "error", "gone", "info", "done"]) {
          status.hidden = false;
          status.dataset.kind = kind;
          status.textContent = "This question has an outcome in words, long enough to need a second line on a narrow phone, and a veryveryveryveryveryveryveryverylongtokenthatmustwrapinsidethebox.";
          await frame();
          const style = getComputedStyle(status);
          const box = status.getBoundingClientRect();
          out.status.push({ kind, contrast: ratio(parse(style.color).slice(0, 3), parse(style.backgroundColor).slice(0, 3)), left: style.borderLeftColor, inside: box.right <= card.getBoundingClientRect().right + 0.5 && status.scrollWidth <= status.clientWidth + 1, height: box.height });
        }
        status.hidden = true;
        status.textContent = "";
        // The history line, loading and failed, with its retry button.
        const text = document.querySelector("#history-state-text");
        const retry = document.querySelector("#history-retry");
        for (const [kind, label] of [["loading", "Loading your earlier messages…"], ["failed", "Your earlier messages could not be loaded. Nothing was sent."]]) {
          state.hidden = false;
          state.dataset.kind = kind;
          text.textContent = label;
          retry.hidden = kind !== "failed";
          await frame();
          const style = getComputedStyle(state);
          const box = state.getBoundingClientRect();
          const retryBox = retry.getBoundingClientRect();
          out.state.push({ kind, contrast: ratio(parse(style.color).slice(0, 3), parse(style.backgroundColor).slice(0, 3)), inside: box.right <= card.getBoundingClientRect().right + 0.5 && state.scrollWidth <= state.clientWidth + 1, retryHeight: kind === "failed" ? retryBox.height : null, retryInside: kind === "failed" ? retryBox.right <= box.right + 0.5 && retryBox.left >= box.left - 0.5 : null });
        }
        state.hidden = true;
        // The action row: one button shown is a row, all hidden is no row.
        const buttons = Array.from(actions.querySelectorAll("button"));
        buttons[0].hidden = false;
        buttons[buttons.length - 1].hidden = false;
        await frame();
        const shown = Array.from(actions.querySelectorAll("button")).filter((b) => !b.hidden).map((b) => ({ id: b.id, height: b.getBoundingClientRect().height, inside: b.getBoundingClientRect().right <= card.getBoundingClientRect().right + 0.5 }));
        out.actions = { display: getComputedStyle(actions).display, shown };
        for (const b of buttons) b.hidden = true;
        await frame();
        out.actions.displayWhenEmpty = getComputedStyle(actions).display;
        out.docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        return out;
      })()`);
      const label = `${width}px`;
      assert.deepEqual(facts.idle, { status: "none", state: "none", actions: "none" }, `${label}: with nothing to say the three take no room`);
      assert.equal(facts.status.length, 8);
      for (const entry of facts.status) {
        assert.ok(entry.contrast >= 4.5, `${label}: the ${entry.kind} status has contrast ${entry.contrast.toFixed(2)}:1`);
        assert.ok(entry.inside, `${label}: the ${entry.kind} status stays inside the card, long word included`);
      }
      assert.equal(new Set(facts.status.map((entry) => entry.left)).size >= 4, true, `${label}: working, warning, error and done are told apart by more than the words`);
      for (const entry of facts.state) {
        assert.ok(entry.contrast >= 4.5, `${label}: the ${entry.kind} history line has contrast ${entry.contrast.toFixed(2)}:1`);
        assert.ok(entry.inside, `${label}: the ${entry.kind} history line stays inside the card`);
      }
      const failed = facts.state.find((entry) => entry.kind === "failed");
      assert.ok(failed.retryHeight >= 44, `${label}: the history retry button is ${failed.retryHeight}px high`);
      assert.ok(failed.retryInside, `${label}: and inside its line`);
      assert.equal(facts.actions.display, "flex", `${label}: the action row is a row while a button is shown`);
      assert.equal(facts.actions.displayWhenEmpty, "none", `${label}: and takes no room when all its buttons are hidden`);
      for (const button of facts.actions.shown) {
        assert.ok(button.height >= 44 && button.inside, `${label}: ${button.id} is at least 44px high and inside the card`);
      }
      assert.ok(facts.docOverflow <= 0, `${label}: the page does not scroll sideways`);
    }
  });

  it("9. rows painted by the conversation client carry their role (needs ATLAS_CHAT=real)", { skip: CHAT_SETUP.mode === "real" ? false : "the test double paints rows without a role; run with ATLAS_CHAT=real" }, async (t) => {
    const { page, stub, url } = await openSite(t, "9-live-roles", { width: 1440, height: 1000 });
    stub.reply = () => FIRST_ANSWER;
    await boot(page, url);
    await page.click(".atlas-chip");
    await waitReply(page, stub, 1);
    const rows = await page.eval(`Array.from(document.querySelectorAll("#history > li")).map((row) => ({
      role: row.getAttribute("data-role"),
      label: (row.querySelector(":scope > .speaker") || {}).textContent || null,
      labelBeforeText: !!row.querySelector(":scope > .speaker + p"),
      text: (row.querySelector("p") || {}).textContent,
    }))`);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => [row.role, row.label, row.labelBeforeText]),
      [
        ["user", "You", true],
        ["assistant", "Answer", true],
      ],
    );
    assert.equal(rows[1].text, FIRST_ANSWER);
  });

  it("10. no script errors, no policy violations, no resize-loop errors in any of these pages", () => {
    const exceptions = diagnostics.filter((entry) => entry.kind === "exception");
    const violations = diagnostics.filter((entry) => /refused to|violates the following content security policy/i.test(entry.text));
    const loops = diagnostics.filter((entry) => /ResizeObserver loop/i.test(entry.text));
    // The stub chat API has no /providers: the working tree's client asks for it and takes the 404 for "no choice offered".
    const NO_PROVIDERS = (entry) => /status of 404/.test(entry.text) && /\/providers$/.test(entry.url || "");
    const errors = diagnostics.filter(
      (entry) =>
        entry.level === "error" &&
        entry.kind !== "exception" &&
        !META_FRAME_ANCESTORS.test(entry.text) &&
        !/ResizeObserver loop/i.test(entry.text) &&
        !NO_PROVIDERS(entry),
    );
    const describe = (entries) => entries.map((entry) => `[${entry.test}] ${entry.kind}/${entry.level || ""}: ${entry.text}`).join("\n");
    assert.equal(exceptions.length, 0, `uncaught exceptions\n${describe(exceptions)}`);
    assert.equal(violations.length, 0, `Content-Security-Policy violations\n${describe(violations)}`);
    assert.equal(loops.length, 0, `resize-observer loop errors\n${describe(loops)}`);
    assert.equal(errors.length, 0, `console errors\n${describe(errors)}`);
  });
});
