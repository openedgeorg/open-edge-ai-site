/**
 * Browser end-to-end tests for the Atlas chat bridge when the chat paints from the outside in
 * awkward ways: a "ready" that arrives before the reply, an older /history snapshot, a backend
 * that dies after the page loaded, a chat that never boots.
 *
 * Same method as atlas_browser.test.mjs: the real site/index.html and the real js/atlas*.js
 * modules run in headless Chrome (DevTools protocol, Node built-ins only), served by a node:http
 * server that also answers the chat API. This file has its OWN stub backend because it needs
 * behaviours the shared stub does not have (a /history that lags, a session endpoint that dies);
 * it only reuses the Chrome launcher, the DevTools client and the choice of conversation client
 * from atlas_browser_support.mjs. That client is the test double
 * (tests/fixtures/atlas_chat_double/app.js) by default, so the file passes on a clean checkout;
 * ATLAS_CHAT=real serves the working tree's own site/js/app.js instead (and skips, saying why, when
 * that tree cannot follow a stream and fill the history). Both clients behave as described next.
 *
 * What the conversation client does (the double reproduces it; site/js/app.js is never changed here):
 *  - /events that answers 404 (or ends before the run does) makes follow() settle at once; the
 *    chat then polls /history every 2 s, but only until ANY assistant row exists, which from turn
 *    2 on is true from the first fetch.
 *  - The message box's focus handler repaints #phase from the controller state, which already
 *    reads `ready` in that fallback path: the Atlas sees a `ready` while the run goes on.
 *  - Nothing re-fetches /history after an older snapshot has been painted until the next submit.
 *    The Atlas cannot make the chat fetch it; what it must do is (1) light nothing wrongly in the
 *    meantime and (2) light the reply once, and not before it is in the chat, when the list is
 *    rewritten. The turn-2 test plays the part of that later rewrite by running the chat's own
 *    showHistory() from a second controller (same module, same stored conversation).
 *
 * The waits are real time on purpose (the bridge's timers are the thing under test): the file
 * takes about 20 s, its tests run side by side.
 *
 * Run: node --test --test-concurrency=1 tests/e2e/atlas_browser_late.test.mjs
 * (`node --test` runs FILES in parallel; run the browser files one at a time.)
 * Chrome: /usr/bin/google-chrome, or ATLAS_CHROME. Without a Chrome the whole file is skipped.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { LATE_SETTLE_MS, NO_PROGRESS_MS, START_GIVE_UP_MS } from "../../site/js/atlas-chat.js";
import { ISLANDS, START_ID, buildIndex } from "../../site/js/atlas-graph.js";
import { compileGlossary, matchReply } from "../../site/js/atlas-match.js";
import { deriveView } from "../../site/js/atlas-state.js";
import { BROWSER_CONCURRENCY, CHAT_SETUP, findChrome, launchBrowser, siteFileFor, sleep } from "./atlas_browser_support.mjs";

const INDEX = buildIndex();
const GLOSSARY = compileGlossary(ISLANDS);

/** The proposal's example reply: it names several places. */
const REPLY_ONE =
  "Your ISP, as your financial counterparty. You pay it under one standing plan, and apps earn through the protocol. Its monthly commitment for your household enters a common fund and funds your guaranteed base allowance.";
/** A second reply that names other places than the first. */
const REPLY_TWO = "Slashing and collateral and hoarding keep the ISPs honest.";

const CHROME = findChrome();
let browser = null;
/** Everything every page logged (kept for debugging; these tests assert on behaviour, not on logs). */
const diagnostics = [];

// ---------------------------------------------------------------------------------------------
// a stub backend of our own
// ---------------------------------------------------------------------------------------------

/**
 * Behaviour switches, all changeable while a page runs:
 *  eventsMode  "404" (follow() settles at once) | "sse" (deltas, then done, over runMs)
 *  sessionMode "ok" | "html" (a 502 page: the chat never boots) | "reset" (connection dropped)
 *  lagging     while true, /history only shows the turns before `lagFromTurn`
 *  runMs       how long a run takes before its assistant row exists in /history
 */
function createBackend() {
  const backend = {
    eventsMode: "404",
    sessionMode: "ok",
    lagging: false,
    lagFromTurn: 2,
    runMs: 1500,
    reply: (message, n) => `Plain reply number ${n}.`,
    turns: [],
    /** Parsed body of every POST to /messages. */
    posts: [],
    requests: [],
    historyCalls: 0,
  };
  return backend;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

/** Split a reply into a few SSE deltas on code points. */
function deltasOf(text) {
  const chars = Array.from(String(text));
  const parts = chars.length > 80 ? 3 : chars.length > 2 ? 2 : 1;
  const size = Math.ceil(chars.length / parts) || 1;
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

async function handle(req, res, backend) {
  const url = new URL(req.url, "http://stub.invalid");
  const pathname = url.pathname;
  const method = req.method || "GET";
  backend.requests.push({ method, path: pathname });

  if (pathname === "/favicon.ico") return void res.writeHead(204).end();

  if (method === "POST" && pathname === "/visitor-session") {
    await readJson(req);
    if (backend.sessionMode === "reset") return void req.socket.destroy();
    if (backend.sessionMode === "html") {
      res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      return void res.end("<html><body>Bad gateway</body></html>");
    }
    return json(res, 200, { subject_id: "s-1", csrf_token: "t-1" });
  }
  if (method === "POST" && pathname === "/conversations") {
    await readJson(req);
    return json(res, 201, { id: "conv-1" });
  }
  if (method === "POST" && pathname === "/conversations/conv-1/messages") {
    const body = await readJson(req);
    backend.posts.push(body);
    const message = String(body.message ?? "");
    const number = backend.turns.length + 1;
    backend.turns.push({
      user: message,
      reply: String(backend.reply(message, number)),
      doneAt: Date.now() + backend.runMs,
    });
    return json(res, 200, { accepted: true }, { "X-ESP-Acceptance": "accepted" });
  }
  if (method === "GET" && pathname === "/conversations/conv-1/events") {
    if (backend.eventsMode === "404") return json(res, 404, { error: { code: "not_found" } });
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    let closed = false;
    res.on("close", () => {
      closed = true;
    });
    const turn = backend.turns[backend.turns.length - 1];
    if (!turn) {
      res.write('data: {"type":"done"}\n\n');
      return void res.end();
    }
    const deltas = deltasOf(turn.reply);
    const gap = Math.max(5, Math.floor(Math.max(turn.doneAt - Date.now(), 0) / (deltas.length + 1)));
    for (const delta of deltas) {
      await sleep(gap);
      if (closed) return;
      res.write(`data: ${JSON.stringify({ type: "text_delta", text: delta })}\n\n`);
    }
    const rest = turn.doneAt - Date.now();
    if (rest > 0) await sleep(rest);
    if (closed) return;
    res.write('data: {"type":"done"}\n\n');
    return void res.end();
  }
  if (method === "GET" && pathname === "/conversations/conv-1/history") {
    backend.historyCalls += 1;
    const items = [];
    const now = Date.now();
    backend.turns.forEach((turn, index) => {
      if (backend.lagging && index + 1 >= backend.lagFromTurn) return; // an older snapshot
      items.push({ role: "user", text: turn.user });
      if (now >= turn.doneAt) items.push({ role: "assistant", text: turn.reply });
    });
    return json(res, 200, { items });
  }
  if (pathname.startsWith("/conversations/conv-1/status")) return json(res, 200, { state: "idle" });
  if (method === "GET" || method === "HEAD") {
    let relative = decodeURIComponent(pathname);
    if (relative.endsWith("/")) relative += "index.html";
    const full = siteFileFor(relative);
    if (full === null) return void res.writeHead(403).end();
    return fs.readFile(full, (error, data) => {
      if (error) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        return void res.end("not found");
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(data);
    });
  }
  res.writeHead(404).end();
}

async function startServer(backend) {
  const server = http.createServer((req, res) => {
    handle(req, res, backend).catch((error) => {
      try {
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(error && error.message));
      } catch {
        /* the socket is gone */
      }
    });
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// page helpers
// ---------------------------------------------------------------------------------------------

/** A fresh backend + server + isolated browser context. Cleaned up even when the test fails. */
async function openSite(t, label, configure = () => {}) {
  const backend = createBackend();
  configure(backend);
  const server = await startServer(backend);
  const page = await browser.openPage({ label, diagnostics });
  t.after(async () => {
    await page.close();
    await server.close();
  });
  return { backend, page, url: `${server.origin}/` };
}

const CHIP = "#atlas-suggest .atlas-chip";

/** Everything the tests look at, in one read. */
const READ = `(() => {
  const q = (selector) => document.querySelector(selector);
  const visited = Array.from(document.querySelectorAll("#atlas-map .atlas-island.is-visited")).map((g) => g.getAttribute("data-id"));
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("esp-atlas")); } catch (error) { session = null; }
  return {
    phase: q("#phase") ? q("#phase").textContent.trim() : null,
    count: q("#atlas-count") ? q("#atlas-count").textContent.trim() : null,
    replies: session ? session.replies : 0,
    visited,
    rows: Array.from(document.querySelectorAll("#history li > p")).map((p) => p.textContent),
    chips: Array.from(document.querySelectorAll(${JSON.stringify(CHIP)})).map((c) => ({
      text: c.textContent,
      off: c.disabled || c.getAttribute("aria-disabled") === "true",
    })),
    notice: q("#atlas-notice") ? q("#atlas-notice").textContent.trim() : null,
    sendDisabled: q("#send") ? q("#send").disabled : null,
    draft: q("#draft") ? q("#draft").value : null,
    cspViolations: window.__cspViolations ? window.__cspViolations.length : -1,
  };
})()`;

const read = (page) => page.eval(READ);

/** Load the page; optionally wait for a ready chat and an enabled first chip. */
async function boot(page, url, { chat = true } = {}) {
  await page.goto(url);
  await page.waitFor(`(document.querySelector("#atlas-count")?.textContent || "").length > 0`, {
    what: "the Atlas count to be painted",
  });
  if (!chat) return;
  await page.waitFor(
    `(() => {
      const chip = document.querySelector(${JSON.stringify(CHIP)});
      return !!chip && !chip.disabled && chip.getAttribute("aria-disabled") !== "true" && document.querySelector("#phase").textContent.trim() === "ready";
    })()`,
    { what: "the chat to be ready and the first suggestion enabled" },
  );
}

/**
 * A recorder inside the page: one sample whenever the phase line, the history or the count line
 * changes (taken in the mutation observers' own callbacks, so the times are the browser's, not
 * the test's polling), plus a 50 ms heartbeat. The timeline is how "never earlier than the final
 * reply" is proved.
 */
const INSTALL_RECORDER = `(() => {
  if (window.__timeline) return true;
  const samples = [];
  let previous = "";
  const sample = () => {
    let replies = 0;
    try { replies = JSON.parse(sessionStorage.getItem("esp-atlas")).replies; } catch (error) { replies = 0; }
    const rows = Array.from(document.querySelectorAll("#history li > p")).map((p) => p.textContent);
    const entry = {
      phase: (document.querySelector("#phase") || { textContent: "" }).textContent.trim(),
      replies,
      rows: rows.length,
      last: rows.length ? rows[rows.length - 1] : "",
    };
    const key = JSON.stringify(entry);
    if (key === previous) return;
    previous = key;
    samples.push({ t: Math.round(performance.now()), ...entry });
  };
  const watch = new MutationObserver(sample);
  for (const selector of ["#phase", "#history", "#atlas-count"]) {
    const element = document.querySelector(selector);
    if (element) watch.observe(element, { childList: true, characterData: true, subtree: true });
  }
  sample();
  setInterval(sample, 50);
  window.__timeline = samples;
  return true;
})()`;

const timeline = (page) => page.eval(`window.__timeline.slice()`);

/** The visited ids the state model gives after `replyTexts`, in order. */
function modelVisited(replyTexts) {
  const visited = [START_ID];
  for (const text of replyTexts) {
    for (const id of matchReply(text, GLOSSARY)) if (!visited.includes(id)) visited.push(id);
  }
  return visited;
}

function assertMapShows(snap, replyTexts, label) {
  const expected = modelVisited(replyTexts);
  assert.deepEqual([...snap.visited].sort(), [...expected].sort(), `${label}: the visited islands`);
  const view = deriveView({ visited: expected, replies: replyTexts.length }, INDEX);
  assert.equal(snap.count, `${view.visitedCount} of ${view.total} visited`, `${label}: the count`);
  assert.equal(snap.replies, replyTexts.length, `${label}: replies counted`);
}

/**
 * The invariants of a late reply, from the page's own timeline:
 *  - the reply count never goes up before the reply is the last row of the chat;
 *  - it goes up by exactly one;
 *  - the Atlas waited for the list to be quiet (LATE_SETTLE_MS) after the reply showed up.
 * @returns {{shownAt: number, litAt: number}}
 */
function assertLitOnceAfterFinal(samples, { before, finalText, label }) {
  const early = samples.filter((s) => s.replies > before && s.last.trim() !== finalText.trim());
  assert.deepEqual(early, [], `${label}: the map must not light while the chat does not show the final reply yet`);
  const over = samples.filter((s) => s.replies > before + 1);
  assert.deepEqual(over, [], `${label}: one reply must be counted exactly once`);
  const shown = samples.find((s) => s.last.trim() === finalText.trim());
  const lit = samples.find((s) => s.replies === before + 1);
  assert.ok(shown, `${label}: the chat showed the final reply`);
  assert.ok(lit, `${label}: the map was lit`);
  assert.ok(lit.t >= shown.t, `${label}: lit (${lit.t}) at or after the reply showed (${shown.t})`);
  assert.ok(
    lit.t - shown.t >= LATE_SETTLE_MS - 100,
    `${label}: the Atlas should wait for the list to be quiet (${lit.t - shown.t} ms after the reply showed)`,
  );
  return { shownAt: shown.t, litAt: lit.t };
}

// ---------------------------------------------------------------------------------------------
// the scenarios
// ---------------------------------------------------------------------------------------------

const SUITE = { skip: CHROME.path ? CHAT_SETUP.skip : CHROME.reason, timeout: 240000, concurrency: BROWSER_CONCURRENCY };

describe("Atlas chat bridge in a real browser: late and failing chats", SUITE, () => {
  before(async (t) => {
    t.diagnostic(CHAT_SETUP.label);
    browser = await launchBrowser(CHROME.path);
  });

  after(async () => {
    if (browser) await browser.close();
  });

  it("the message box gets focus while the chat still polls /history: the reply is found once, and not before it shows", async (t) => {
    const { backend, page, url } = await openSite(t, "focus-while-polling", (b) => {
      b.eventsMode = "404";
      b.runMs = 4500;
      b.reply = () => REPLY_ONE;
    });
    await boot(page, url);
    await page.eval(INSTALL_RECORDER);

    await page.click(CHIP);
    await page.waitFor(`document.querySelector("#phase").textContent.trim() === "running"`, { what: "the run to be accepted" });
    await sleep(900);
    // The visitor clicks into the message box to start typing their next question. The chat repaints
    // its status line from the controller state, which already says `ready`: it is not, the run goes on.
    await page.click("#draft");
    const early = await read(page);
    assert.equal(early.phase, "ready", "precondition: the chat painted ready while the run is still going (app.js focus handler)");
    assert.equal(early.rows.length, 1, "precondition: the list holds only the visitor's own question");
    assert.equal(early.replies, 0);
    assert.equal(early.visited.length, 1, "the map has not moved");

    // /history catches up on its own poll (every 2 s), some time after the run ended at 4.5 s.
    await page.waitFor(`document.querySelectorAll("#history li > p").length === 2`, {
      timeout: 15000,
      what: "/history to catch up and the list to be rewritten",
    });
    await page.waitFor(`JSON.parse(sessionStorage.getItem("esp-atlas") || "{}").replies === 1`, {
      timeout: 10000,
      what: "the Atlas to scan the late reply",
    });
    const lit = await read(page);
    assertMapShows(lit, [REPLY_ONE], "after the late reply");
    assert.deepEqual(lit.rows, [lit.rows[0], REPLY_ONE]);

    // Once only: wait for another quiet period and a chance for any second delivery.
    await sleep(LATE_SETTLE_MS + 2500);
    const later = await read(page);
    assertMapShows(later, [REPLY_ONE], "a few seconds later");
    const samples = await timeline(page);
    const gap = assertLitOnceAfterFinal(samples, { before: 0, finalText: REPLY_ONE, label: "focus while polling" });
    t.diagnostic(`reply shown at ${gap.shownAt} ms, map lit at ${gap.litAt} ms (waited ${gap.litAt - gap.shownAt} ms for a quiet list)`);
    assert.equal(later.cspViolations, 0, "no Content-Security-Policy violation");
    assert.ok(backend.historyCalls >= 2, "the chat really did poll /history more than once");
  });

  it("turn 2 on an older /history snapshot: nothing false is lit, and the reply is lit once when the list shows it", async (t) => {
    const { backend, page, url } = await openSite(t, "stale-snapshot", (b) => {
      b.eventsMode = "404";
      b.runMs = 800;
      b.reply = (message, n) => (n === 1 ? REPLY_ONE : REPLY_TWO);
    });
    const afterOne = modelVisited([REPLY_ONE]);
    const afterTwo = modelVisited([REPLY_ONE, REPLY_TWO]);
    assert.ok(afterTwo.length > afterOne.length, "scenario sanity: the second reply names places the first did not");

    await boot(page, url);
    await page.eval(INSTALL_RECORDER);

    // Turn 1 as usual (events 404: the chat polls until the assistant row exists).
    await page.click(CHIP);
    await page.waitFor(`JSON.parse(sessionStorage.getItem("esp-atlas") || "{}").replies === 1`, {
      timeout: 15000,
      what: "turn 1 to be scanned",
    });
    await page.waitFor(`document.querySelector("#phase").textContent.trim() === "ready"`, { what: "the chat to be ready again" });
    assertMapShows(await read(page), [REPLY_ONE], "after turn 1");

    // Turn 2, typed by the visitor, while /history still shows the turn before it.
    backend.lagging = true;
    await page.click("#draft");
    await page.type("And what keeps the ISPs honest?");
    await page.click("#send");
    await page.waitFor(`document.querySelectorAll("#history li > p").length === 2 && document.querySelector("#phase").textContent.trim() === "ready"`, {
      timeout: 15000,
      what: "the chat to paint ready on the older snapshot",
    });
    assert.equal(backend.turns.length, 2, "the question did reach the backend");
    const stale = await read(page);
    assert.equal(stale.rows[1], REPLY_ONE, "precondition: the chat now shows the older list, ending with the old reply");
    // Neither the question nor the old reply may be taken for the new reply, however long we wait.
    await sleep(LATE_SETTLE_MS + 2000);
    const quiet = await read(page);
    assertMapShows(quiet, [REPLY_ONE], "on the older snapshot");
    assert.equal(quiet.chips.some((chip) => chip.off), false, "nothing is busy: suggestions work");

    // /history catches up and the list is rewritten (the chat's own showHistory(), run again).
    backend.lagging = false;
    const before = (await read(page)).replies;
    await page.eval(`import("/js/app.js").then((chat) => chat.createController({ storage: sessionStorage }).showHistory()).then(() => true)`);
    await page.waitFor(`JSON.parse(sessionStorage.getItem("esp-atlas") || "{}").replies === ${before + 1}`, {
      timeout: 10000,
      what: "the Atlas to scan the reply once the list shows it",
    });
    const lit = await read(page);
    assertMapShows(lit, [REPLY_ONE, REPLY_TWO], "after turn 2");
    assert.equal(lit.rows.at(-1), REPLY_TWO);

    await sleep(LATE_SETTLE_MS + 2500);
    assertMapShows(await read(page), [REPLY_ONE, REPLY_TWO], "a few seconds later");
    const samples = await timeline(page);
    const turnTwo = samples.filter((s) => s.t >= samples.find((x) => x.replies === 1).t);
    const gap = assertLitOnceAfterFinal(turnTwo, { before: 1, finalText: REPLY_TWO, label: "turn 2 on an older snapshot" });
    t.diagnostic(`reply shown at ${gap.shownAt} ms, map lit at ${gap.litAt} ms (waited ${gap.litAt - gap.shownAt} ms for a quiet list)`);
    assert.equal(lit.cspViolations, 0);
  });

  it("an identical reply in a later turn still counts, because the list is longer", async (t) => {
    const { page, url } = await openSite(t, "identical-reply", (b) => {
      b.eventsMode = "sse";
      b.runMs = 600;
      b.reply = () => REPLY_ONE; // a deterministic or cached answer: the very same text every time
    });
    await boot(page, url);
    await page.click(CHIP);
    await page.waitFor(`JSON.parse(sessionStorage.getItem("esp-atlas") || "{}").replies === 1 && document.querySelector("#phase").textContent.trim() === "ready"`, {
      timeout: 15000,
      what: "turn 1 to be scanned",
    });
    await page.click("#draft");
    await page.type("Could you say that again?");
    await page.click("#send");
    await page.waitFor(`JSON.parse(sessionStorage.getItem("esp-atlas") || "{}").replies === 2`, {
      timeout: 15000,
      what: "the identical reply of turn 2 to be counted",
    });
    const twice = await read(page);
    assert.equal(twice.rows.length, 4);
    assert.deepEqual(twice.rows.filter((row) => row === REPLY_ONE).length, 2, "the chat shows the same text twice");
    assert.deepEqual([...twice.visited].sort(), [...modelVisited([REPLY_ONE])].sort(), "no new place: the same text names the same places");
    // (A re-read of the same list does not count again: the older-snapshot test shows that.)
    assert.equal(twice.cspViolations, 0);
  });

  it("the backend dies after the page loaded: the wait is dropped with an honest message and suggestions work again", async (t) => {
    const { backend, page, url } = await openSite(t, "backend-down", (b) => {
      b.eventsMode = "sse";
      b.runMs = 1200;
      b.reply = () => REPLY_ONE;
    });
    await boot(page, url);

    backend.sessionMode = "reset"; // the connection is dropped from now on
    const tappedAt = Date.now();
    await page.click(CHIP);
    await page.waitFor(`document.querySelectorAll("#history li > p").length === 1`, { what: "the question to be echoed" });
    await sleep(1500);
    const waiting = await read(page);
    assert.equal(waiting.phase, "ready", "the chat never painted anything: the request failed before it could");
    assert.equal(waiting.sendDisabled, false);
    assert.ok(waiting.chips.every((chip) => chip.off), "the suggestions wait for the question they sent");
    assert.ok(waiting.notice.length > 0, "and the notice says why");

    // After NO_PROGRESS_MS, by itself (no nudge): the wait ends.
    await page.waitFor(`!document.querySelector(${JSON.stringify(CHIP)}).disabled && document.querySelector(${JSON.stringify(CHIP)}).getAttribute("aria-disabled") !== "true"`, {
      timeout: NO_PROGRESS_MS + 10000,
      what: "the suggestions to work again",
    });
    const waited = Date.now() - tappedAt;
    assert.ok(waited >= NO_PROGRESS_MS - 1500, `the Atlas should not give up early (${waited} ms)`);
    assert.ok(waited <= NO_PROGRESS_MS + 5000, `the Atlas should give up by itself (${waited} ms)`);
    const dropped = await read(page);
    assert.equal(dropped.notice, "The last question did not go through.");
    assert.ok(dropped.chips.every((chip) => !chip.off));
    assert.equal(dropped.sendDisabled, false, "the Send button was never off");
    assertMapShows(dropped, [], "nothing was answered");

    // The backend is back: a suggestion goes through, and its reply lights the map as usual.
    backend.sessionMode = "ok";
    await page.click(CHIP);
    await page.waitFor(`JSON.parse(sessionStorage.getItem("esp-atlas") || "{}").replies === 1`, {
      timeout: 15000,
      what: "the retried question to be answered and scanned",
    });
    const recovered = await read(page);
    assertMapShows(recovered, [REPLY_ONE], "after the retry");
    assert.equal(recovered.notice, "", "the notice is gone");
    assert.equal(recovered.cspViolations, 0);
  });

  it("the chat never boots: starting, then an honest 'not available', and it recovers if the chat shows up", async (t) => {
    const { backend, page, url } = await openSite(t, "never-boots", (b) => {
      b.sessionMode = "html";
    });
    const startedAt = Date.now();
    await boot(page, url, { chat: false });
    await sleep(700);
    const starting = await read(page);
    assert.equal(starting.phase, "", "the chat never painted a phase");
    assert.ok(starting.chips.length > 0 && starting.chips.every((chip) => chip.off), "suggestions are off");
    assert.match(starting.notice, /still starting/i);

    await page.waitFor(`/not available/i.test(document.querySelector("#atlas-notice").textContent)`, {
      timeout: START_GIVE_UP_MS + 8000,
      what: "the notice to stop promising that the chat is starting",
    });
    const gaveUpAfter = Date.now() - startedAt;
    assert.ok(gaveUpAfter >= START_GIVE_UP_MS - 1500, `not before the give-up time (${gaveUpAfter} ms)`);
    assert.ok(gaveUpAfter <= START_GIVE_UP_MS + 5000, `by itself, soon after (${gaveUpAfter} ms)`);
    const unavailable = await read(page);
    assert.equal(unavailable.notice, "The chat is not available right now.");
    assert.ok(unavailable.chips.every((chip) => chip.off), "suggestions stay off: nothing could answer them");

    // A tap on a switched-off suggestion sends nothing.
    await page.click(CHIP);
    await sleep(300);
    assert.deepEqual(backend.posts, [], "no question was sent");
    assert.equal((await read(page)).rows.length, 0);

    // If the chat does show up after all, the Atlas follows.
    await page.eval(`(document.querySelector("#phase").textContent = "ready", true)`);
    await page.waitFor(
      `(() => { const chip = document.querySelector(${JSON.stringify(CHIP)}); return !chip.disabled && chip.getAttribute("aria-disabled") !== "true" && document.querySelector("#atlas-notice").textContent.trim() === ""; })()`,
      { what: "the suggestions to work again once the chat is ready" },
    );
    assert.equal((await read(page)).cspViolations, 0);
  });
});
