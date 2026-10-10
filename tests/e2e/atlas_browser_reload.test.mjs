/**
 * Browser end-to-end tests for the two things a reload can break in the Atlas chat bridge:
 *
 *  F11  the reply must be tied to its question. After a reload the bridge has forgotten everything
 *       it delivered and every question it saw, and the chat can show an OLDER snapshot of the
 *       conversation on top of that. An old answer, or the visitor's own earlier question, must not
 *       be taken for the answer to the question that was just asked and light the map.
 *  F16  after the chat refused a suggestion (409 or 429) and the page was reloaded, the chat puts
 *       the refused text back into the message box. That text is the Atlas's own, not the
 *       visitor's: it must not block the next suggestion, while words the visitor adds to it do.
 *
 * Same method as atlas_browser_late.test.mjs: the real site/index.html and the real js/atlas*.js run
 * in headless Chrome (DevTools protocol, Node built-ins only), served by a node:http server that
 * also answers the chat API. This file has its OWN stub backend because it needs behaviours the
 * shared stub does not have: a /history that lags (shows the conversation as it was one turn ago)
 * or shows an arbitrary older snapshot, and a /events that answers 404. It only reuses the Chrome
 * launcher, the DevTools client and the choice of conversation client from atlas_browser_support.mjs.
 * That client is the test double (tests/fixtures/atlas_chat_double/app.js) by default, so the file
 * passes on a clean checkout; ATLAS_CHAT=real serves the working tree's own site/js/app.js instead
 * (and skips, saying why, when that tree cannot follow a stream and fill the history).
 *
 * Nothing about the graph is written down here. The replies the stub gives are built at run time
 * from the terms of islands of the shipped graph, picked through the page's own matcher so that the
 * two replies of a scenario light disjoint sets of places; the expected map is computed in Node from
 * the same modules the page runs (atlas-graph.js, atlas-match.js, atlas-state.js). Teasers are read
 * from the graph. The only literal texts are the visitor's own typed questions.
 *
 * Known gap (test e, marked todo, expected to fail today): when turn 2 is the very same text as turn 1,
 * which is what a visitor gets by pressing Clear map and tapping the first suggestion again, the older
 * snapshot [Q1, A1] is indistinguishable from the answer to the new question. Remove the todo when the
 * bridge can tell them apart.
 *
 * What the conversation client does that matters here (the double reproduces it):
 *  - After a reload the list (#history) is EMPTY and stays so until the visitor sends something.
 *  - /events that answers 404 makes follow() settle at once; the chat then polls /history every 2 s,
 *    but only until ANY assistant row exists, which from turn 2 on is true from the first fetch. So
 *    an older snapshot with an old answer in it is painted, the chat paints `ready`, and it does not
 *    fetch /history again until the next submit. The scenarios play the part of that later rewrite
 *    by running the chat's own showHistory() from a second controller (same module, same stored
 *    conversation), once the stub's /history tells the truth.
 *  - A 409 or 429 puts the phase to `rejected` and keeps the refused text as the draft; both are
 *    kept in sessionStorage, so they come back after a reload (the pause starts again).
 *
 * The waits are real time on purpose (the bridge's timers are the thing under test); only the
 * 30 s pause after a refusal is skipped by moving the page's clock on, as atlas_browser.test.mjs does.
 *
 * Run: node --test --test-concurrency=1 tests/e2e/atlas_browser_reload.test.mjs
 * (`node --test` runs FILES in parallel; run the browser files one at a time.)
 * Chrome: /usr/bin/google-chrome, or ATLAS_CHROME. Without a Chrome the whole file is skipped.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { LATE_SETTLE_MS, REJECT_PAUSE_MS } from "../../site/js/atlas-chat.js";
import { FIRST_SUGGESTION, ISLANDS, START_ID, buildIndex } from "../../site/js/atlas-graph.js";
import { compileGlossary, matchReply } from "../../site/js/atlas-match.js";
import { deriveView } from "../../site/js/atlas-state.js";
import { BROWSER_CONCURRENCY, CHAT_SETUP, findChrome, launchBrowser, siteFileFor, sleep } from "./atlas_browser_support.mjs";

const INDEX = buildIndex();
const GLOSSARY = compileGlossary(ISLANDS);
const START_NEIGHBOURS = [...INDEX.neighbours.get(START_ID)];

/** The visitor's own second question, typed (it is not a suggestion, and not the first one). */
const QUESTION_TWO = "And how does the month end if something goes wrong?";
/** Words a visitor adds to, or types instead of, a suggestion. */
const VISITOR_WORDS = " and my own words";
const VISITOR_QUESTION = "A question I wrote myself.";

const CHROME = findChrome();
let browser = null;
/** Everything every page logged (kept for debugging; these tests assert on behaviour, not on logs). */
const diagnostics = [];

// ---------------------------------------------------------------------------------------------
// replies built from the graph
// ---------------------------------------------------------------------------------------------

/** The places a text lights, start island left out (it is lit from the start whatever is said). */
function lightOf(text) {
  return matchReply(text, GLOSSARY).filter((id) => id !== START_ID);
}

/** A sentence that names island `island` through one of its own terms, or null if none does it. */
function sentenceFor(island) {
  for (const term of island.terms) {
    const text = `In this design, ${term} comes up at this point.`;
    if (matchReply(text, GLOSSARY).includes(island.id)) return text;
  }
  return null;
}

let planned = null;

/**
 * Two replies for the two turns of a scenario, derived from the shipped graph and its matcher at run
 * time: each names three or more places, the two sets are disjoint, and neither contains the start
 * island. Also a teaser that lights a place by itself (an echo of it would be visible on the map).
 * @returns {{first: {text: string, lit: string[]}, second: {text: string, lit: string[]}, echo: string, echoLit: string[]}}
 */
function plan() {
  if (planned) return planned;
  const pool = ISLANDS.filter((island) => island.id !== START_ID)
    .map((island) => ({ id: island.id, sentence: sentenceFor(island) }))
    .filter((entry) => entry.sentence !== null);
  const taken = new Set();
  const replies = [];
  for (let turn = 0; turn < 2; turn += 1) {
    const parts = [];
    let lit = [];
    for (const entry of pool) {
      if (parts.length >= 3) break;
      const trial = lightOf([...parts, entry.sentence].join(" "));
      if (!trial.includes(entry.id) || trial.some((id) => taken.has(id))) continue;
      parts.push(entry.sentence);
      lit = trial;
    }
    assert.ok(lit.length >= 2, `scenario setup: reply ${turn + 1} must name at least two places of the graph (got ${lit.length})`);
    for (const id of lit) taken.add(id);
    replies.push({ text: parts.join(" "), lit });
  }
  const [first, second] = replies;
  assert.deepEqual(first.lit.filter((id) => second.lit.includes(id)), [], "scenario setup: the two replies name different places");
  assert.notEqual(first.text, second.text);
  // The visitor's own earlier suggestion: a teaser of the graph that names a place all by itself.
  const echoes = ISLANDS.filter((island) => island.teaser !== FIRST_SUGGESTION && lightOf(island.teaser).length > 0);
  assert.ok(echoes.length > 0, "scenario setup: some teaser of the graph must name a place by itself, or an echo of it proves nothing");
  const apart = echoes.find((island) => lightOf(island.teaser).every((id) => !second.lit.includes(id))) || echoes[0];
  assert.ok(!ISLANDS.some((island) => island.teaser === QUESTION_TWO) && QUESTION_TWO !== FIRST_SUGGESTION, "the typed question is not a suggestion");
  planned = { first, second, echo: apart.teaser, echoLit: lightOf(apart.teaser) };
  return planned;
}

// ---------------------------------------------------------------------------------------------
// a stub backend of our own
// ---------------------------------------------------------------------------------------------

/**
 * Behaviour switches, all changeable while a page runs:
 *  eventsMode       "404" (follow() settles at once) | "sse" (deltas, then done, over runMs)
 *  lagging          while true, /history only shows the turns before `lagFromTurn`
 *  historyOverride  when an array of {role, text}, /history returns exactly that (an older snapshot)
 *  runMs            how long a run takes before its assistant row exists in /history
 *  outcome          (postNumber, message) => "accept" | 409 | 429
 */
function createBackend() {
  return {
    eventsMode: "sse",
    lagging: false,
    lagFromTurn: 2,
    historyOverride: null,
    runMs: 600,
    reply: (_message, n) => `Plain reply number ${n}.`,
    outcome: () => "accept",
    turns: [],
    /** Every POST to /messages: { message, status }. */
    posts: [],
    requests: [],
    historyCalls: 0,
  };
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
    return json(res, 200, { subject_id: "s-1", csrf_token: "t-1" });
  }
  if (method === "POST" && pathname === "/conversations") {
    await readJson(req);
    return json(res, 201, { id: "conv-1" });
  }
  if (method === "POST" && pathname === "/conversations/conv-1/messages") {
    const body = await readJson(req);
    const message = String(body.message ?? "");
    const decision = backend.outcome(backend.posts.length + 1, message);
    if (decision === 409 || decision === 429) {
      backend.posts.push({ message, status: decision });
      const code = decision === 409 ? "run_active" : "rate_limited";
      return json(res, decision, { error: { code, message: "not now" } });
    }
    backend.posts.push({ message, status: 200 });
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
    if (Array.isArray(backend.historyOverride)) return json(res, 200, { items: backend.historyOverride });
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
const CHIP_ENABLED = `(() => { const chip = document.querySelector(${JSON.stringify(CHIP)}); return !!chip && !chip.disabled && chip.getAttribute("aria-disabled") !== "true"; })()`;
const CHIP_BLOCKED = `(() => { const chip = document.querySelector(${JSON.stringify(CHIP)}); return !!chip && chip.getAttribute("aria-disabled") === "true"; })()`;
const PHASE_IS = (phase) => `document.querySelector("#phase").textContent.trim() === ${JSON.stringify(phase)}`;
const REPLIES_ARE = (n) => `JSON.parse(sessionStorage.getItem("esp-atlas") || "{}").replies === ${n}`;
const COUNT_PAINTED = `(document.querySelector("#atlas-count")?.textContent || "").length > 0`;

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
    draft: q("#draft") ? q("#draft").value : null,
    cspViolations: window.__cspViolations ? window.__cspViolations.length : -1,
  };
})()`;

const read = (page) => page.eval(READ);

/** Load the page; wait for a ready chat and an enabled first chip. */
async function boot(page, url) {
  await page.goto(url);
  await page.waitFor(COUNT_PAINTED, { what: "the Atlas count to be painted" });
  await page.waitFor(`${CHIP_ENABLED} && ${PHASE_IS("ready")}`, { what: "the chat to be ready and the first suggestion enabled" });
}

/** Reload the tab (sessionStorage survives, the list and every in-memory record of the page do not). */
async function reloadTab(page, { phase = "ready" } = {}) {
  await page.reload();
  await page.waitFor(COUNT_PAINTED, { what: "the Atlas to paint after the reload" });
  await page.waitFor(PHASE_IS(phase), { what: `the chat to paint ${phase} after the reload` });
}

/** Clear map is two presses: arm, then confirm. */
async function clearMap(page) {
  await page.click("#atlas-reset");
  await page.click("#atlas-reset");
  await page.waitFor(`${REPLIES_ARE(0)} && document.querySelectorAll("#atlas-map .atlas-island.is-visited").length === 1`, {
    what: "the map to be cleared",
  });
}

/** Put the caret at the end of the message box, like a visitor who clicks into it and presses End. */
async function focusEnd(page) {
  await page.click("#draft");
  await page.eval(`(() => { const box = document.querySelector("#draft"); box.setSelectionRange(box.value.length, box.value.length); return true; })()`);
}

/** Make the Atlas look at the bridge again: a real keystroke into the message box and back out. */
async function poke(page) {
  await focusEnd(page);
  await page.type("x");
  await page.press("Backspace");
}

/** A visitor's own question through the real form: click the box, type, click Send. */
async function typeAndSend(page, text) {
  await page.click("#draft");
  await page.type(text);
  await page.click("#send");
}

/**
 * Play the part of the chat's later /history poll: run the chat's own showHistory() from a second
 * controller on the same stored conversation. It rewrites the list from whatever /history says now.
 */
const rewriteList = (page) =>
  page.eval(`import("/js/app.js").then((chat) => chat.createController({ storage: sessionStorage }).showHistory()).then(() => true)`);

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

/** The visited ids the state model gives after `replyTexts`, in order, from a map that holds only the start island. */
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

/** Nothing has lit: the map holds the start island only and no reply was counted. */
function assertNothingLit(snap, label) {
  assert.equal(snap.replies, 0, `${label}: no reply was counted`);
  assert.deepEqual(snap.visited, [START_ID], `${label}: only the start island is lit`);
}

/** No sample of `samples` counts a reply. */
function assertNeverCounted(samples, label) {
  assert.ok(samples.length > 0, `${label}: the recorder has samples`);
  assert.deepEqual(
    samples.filter((s) => s.replies > 0).map((s) => ({ t: s.t, replies: s.replies, last: s.last.slice(0, 60) })),
    [],
    `${label}: the reply count must stay 0`,
  );
}

/**
 * The invariants of a reply, from the page's own timeline (the recorder starts BEFORE the question):
 *  - the reply count never goes up before the reply is the last row of the chat;
 *  - it goes up by exactly one;
 *  - it goes up after the reply showed (and, with `waitsForQuiet`, only after the list was quiet for
 *    LATE_SETTLE_MS, which is what the late path promises).
 * @returns {{shownAt: number, litAt: number}}
 */
function assertLitOnceAfterFinal(samples, { before, finalText, label, waitsForQuiet }) {
  const early = samples.filter((s) => s.replies > before && s.last.trim() !== finalText.trim());
  assert.deepEqual(early, [], `${label}: the map must not light while the chat does not show the final reply yet`);
  const over = samples.filter((s) => s.replies > before + 1);
  assert.deepEqual(over, [], `${label}: one reply must be counted exactly once`);
  const shown = samples.find((s) => s.last.trim() === finalText.trim());
  const lit = samples.find((s) => s.replies === before + 1);
  assert.ok(shown, `${label}: the chat showed the final reply`);
  assert.ok(lit, `${label}: the map was lit`);
  assert.ok(lit.t >= shown.t, `${label}: lit (${lit.t}) at or after the reply showed (${shown.t})`);
  if (waitsForQuiet) {
    assert.ok(
      lit.t - shown.t >= LATE_SETTLE_MS - 100,
      `${label}: the Atlas should wait for the list to be quiet (${lit.t - shown.t} ms after the reply showed)`,
    );
  }
  return { shownAt: shown.t, litAt: lit.t };
}

/** The map after a first turn that lit `plan().first`, a reload and a press on Clear map. */
async function firstTurnReloadClear(page, url, first) {
  await boot(page, url);
  await page.click(CHIP);
  await page.waitFor(`${REPLIES_ARE(1)} && ${PHASE_IS("ready")}`, { timeout: 15000, what: "turn 1 to be answered and scanned" });
  const lit = await read(page);
  assertMapShows(lit, [first.text], "after turn 1");
  assert.deepEqual(lit.rows, [FIRST_SUGGESTION, first.text], "precondition: the chat shows turn 1");

  await reloadTab(page);
  const restored = await read(page);
  assertMapShows(restored, [first.text], "after the reload");
  assert.deepEqual(restored.rows, [], "precondition: after a reload the chat shows no rows");
  await clearMap(page);
  assertNothingLit(await read(page), "after Clear map");
}

// ---------------------------------------------------------------------------------------------
// the scenarios
// ---------------------------------------------------------------------------------------------

const SUITE = { skip: CHROME.path ? CHAT_SETUP.skip : CHROME.reason, timeout: 240000, concurrency: BROWSER_CONCURRENCY };

describe("Atlas chat bridge in a real browser: after a reload", SUITE, () => {
  before(async (t) => {
    t.diagnostic(CHAT_SETUP.label);
    browser = await launchBrowser(CHROME.path);
  });

  after(async () => {
    if (browser) await browser.close();
  });

  // ---- F11: the reply belongs to the question --------------------------------------------------

  /**
   * Turn 1 asked and answered, reload, Clear map, turn 2 typed. The chat then shows an older
   * snapshot of the conversation (`stale`) for several seconds. Nothing may light, and the reply
   * count stays 0, until the list holds the real answer to turn 2; then exactly its places light, once.
   */
  async function staleScenario(t, label, { stale, staleRows, question = QUESTION_TWO, ask = (page) => typeAndSend(page, QUESTION_TWO) }) {
    const { first, second } = plan();
    const { backend, page, url } = await openSite(t, label, (b) => {
      b.eventsMode = "sse";
      b.runMs = 700;
      b.reply = (_message, n) => (n === 1 ? first.text : second.text);
    });
    await firstTurnReloadClear(page, url, first);

    // Turn 2: no stream, and /history shows an older snapshot.
    backend.eventsMode = "404";
    stale(backend);
    await page.eval(INSTALL_RECORDER);
    await ask(page);
    await page.waitFor(`${PHASE_IS("ready")} && document.querySelectorAll("#history li > p").length === ${staleRows.length}`, {
      timeout: 15000,
      what: "the chat to paint ready on the older snapshot",
    });
    assert.equal(backend.turns.length, 2, "the question did reach the backend");
    assert.deepEqual(backend.posts.map((post) => post.message), [FIRST_SUGGESTION, question]);
    const shown = await read(page);
    assert.deepEqual(shown.rows, staleRows, "precondition: the chat shows the older list, without the question just asked");

    // However long we wait, neither the old answer nor the visitor's own earlier question is the answer.
    await sleep(LATE_SETTLE_MS + 2500);
    const quiet = await read(page);
    assertNothingLit(quiet, "on the older snapshot");
    assert.equal(quiet.cspViolations, 0);
    const beforeFlip = await timeline(page);
    assertNeverCounted(beforeFlip, "on the older snapshot");

    // /history catches up and the list is rewritten: the real answer is there.
    backend.lagging = false;
    backend.historyOverride = null;
    await rewriteList(page);
    await page.waitFor(REPLIES_ARE(1), { timeout: 10000, what: "the Atlas to scan the answer once the list shows it" });
    const lit = await read(page);
    assertMapShows(lit, [second.text], "after the real answer");
    assert.deepEqual(lit.rows, [FIRST_SUGGESTION, first.text, question, second.text], "the list is the true conversation");
    for (const id of first.lit) assert.ok(!lit.visited.includes(id), `nothing of the old answer is lit (${id})`);
    for (const id of second.lit) assert.ok(lit.visited.includes(id), `the places of the real answer are lit (${id})`);

    // Once only: another quiet period, a chance for a second delivery of the same list.
    await sleep(LATE_SETTLE_MS + 2000);
    const later = await read(page);
    assertMapShows(later, [second.text], "a few seconds later");
    const samples = await timeline(page);
    const gap = assertLitOnceAfterFinal(samples, { before: 0, finalText: second.text, label, waitsForQuiet: true });
    t.diagnostic(`answer shown at ${gap.shownAt} ms, map lit at ${gap.litAt} ms (waited ${gap.litAt - gap.shownAt} ms for a quiet list)`);
    assert.equal(later.cspViolations, 0, "no Content-Security-Policy violation");
  }

  it("a. reload, Clear map, turn 2 on an older [Q1, A1] snapshot: nothing from A1 lights; A2 lights once when the list shows it", async (t) => {
    const { first } = plan();
    await staleScenario(t, "reload-stale-old-answer", {
      stale: (backend) => {
        backend.lagging = true;
        backend.lagFromTurn = 2; // only turn 1 is shown: [Q1, A1]
      },
      staleRows: [FIRST_SUGGESTION, first.text],
    });
  });

  it("b. the older snapshot ends with the visitor's own earlier teaser: nothing lights (an echo is not an answer)", async (t) => {
    const { first, echo, echoLit } = plan();
    assert.ok(echoLit.length > 0, "precondition: lit by itself, that teaser would show on the map");
    const snapshot = [
      { role: "user", text: FIRST_SUGGESTION },
      { role: "assistant", text: first.text },
      { role: "user", text: echo }, // asked before the reload; its answer is not in this snapshot
    ];
    await staleScenario(t, "reload-stale-own-teaser", {
      stale: (backend) => {
        backend.historyOverride = snapshot;
      },
      staleRows: snapshot.map((item) => item.text),
    });
  });

  it(
    "e. (known gap) turn 2 is the very same suggestion as turn 1, and the older snapshot is [Q1, A1]: nothing lights",
    {
      todo:
        "F11 is not closed for this case: Clear map brings the first suggestion back, so a visitor can ask Q1 again after a reload, and an older [Q1, A1] snapshot then looks exactly like the answer to the new question. The bridge cannot tell them apart from the list alone, delivers A1 and lights its places.",
    },
    async (t) => {
      const { first } = plan();
      await staleScenario(t, "reload-stale-same-text", {
        stale: (backend) => {
          backend.lagging = true;
          backend.lagFromTurn = 2;
        },
        staleRows: [FIRST_SUGGESTION, first.text],
        question: FIRST_SUGGESTION,
        ask: (page) => page.click(CHIP),
      });
    },
  );

  // ---- the normal path still works -------------------------------------------------------------

  it("d1. the fast path: a suggestion and a typed question are each answered, and each lights its places exactly once", async (t) => {
    const { first, second } = plan();
    const { page, url } = await openSite(t, "fast-path", (b) => {
      b.eventsMode = "sse";
      b.runMs = 600;
      b.reply = (_message, n) => (n === 1 ? first.text : second.text);
    });
    await boot(page, url);
    await page.eval(INSTALL_RECORDER);

    await page.click(CHIP);
    await page.waitFor(`${REPLIES_ARE(1)} && ${PHASE_IS("ready")}`, { timeout: 15000, what: "turn 1 to be scanned" });
    assertMapShows(await read(page), [first.text], "after turn 1");

    await typeAndSend(page, QUESTION_TWO);
    await page.waitFor(`${REPLIES_ARE(2)} && ${PHASE_IS("ready")}`, { timeout: 15000, what: "turn 2 to be scanned" });
    const both = await read(page);
    assertMapShows(both, [first.text, second.text], "after turn 2");
    assert.deepEqual(both.rows, [FIRST_SUGGESTION, first.text, QUESTION_TWO, second.text]);

    // Exactly once: wait past the quiet period and read again.
    await sleep(LATE_SETTLE_MS + 1500);
    const later = await read(page);
    assertMapShows(later, [first.text, second.text], "a few seconds later");
    const samples = await timeline(page);
    const turnOne = samples.filter((s) => s.rows <= 2);
    assertLitOnceAfterFinal(turnOne, { before: 0, finalText: first.text, label: "fast path, turn 1", waitsForQuiet: false });
    const turnTwo = samples.filter((s) => s.t >= samples.find((x) => x.replies === 1).t);
    assertLitOnceAfterFinal(turnTwo, { before: 1, finalText: second.text, label: "fast path, turn 2", waitsForQuiet: false });
    assert.equal(later.cspViolations, 0);
  });

  it("d2. the fast path after a reload and Clear map: the answer of the question just asked lights exactly its places, once", async (t) => {
    const { first, second } = plan();
    const { page, url } = await openSite(t, "reload-fast-path", (b) => {
      b.eventsMode = "sse";
      b.runMs = 600;
      b.reply = (_message, n) => (n === 1 ? first.text : second.text);
    });
    await firstTurnReloadClear(page, url, first);
    await page.eval(INSTALL_RECORDER);

    await typeAndSend(page, QUESTION_TWO);
    await page.waitFor(`${REPLIES_ARE(1)} && ${PHASE_IS("ready")}`, { timeout: 15000, what: "the answer to be scanned" });
    const lit = await read(page);
    assertMapShows(lit, [second.text], "after the answer");
    assert.deepEqual(lit.rows, [FIRST_SUGGESTION, first.text, QUESTION_TWO, second.text]);
    for (const id of first.lit) assert.ok(!lit.visited.includes(id), `nothing of the earlier answer is lit (${id})`);

    await sleep(LATE_SETTLE_MS + 1500);
    assertMapShows(await read(page), [second.text], "a few seconds later");
    const samples = await timeline(page);
    assertLitOnceAfterFinal(samples, { before: 0, finalText: second.text, label: "fast path after a reload", waitsForQuiet: false });
    assert.equal((await read(page)).cspViolations, 0);
  });

  // ---- F16: a refused suggestion left in the box after a reload ---------------------------------

  const REFUSALS = [
    { status: 409, how: "chip" },
    { status: 429, how: "chip" },
    { status: 409, how: "island" },
  ];
  for (const { status, how } of REFUSALS) {
    it(`c. ${status} on ${how === "chip" ? "the first suggestion" : "an island's suggestion"}, then a reload: the refused text in the box does not block suggestions; words the visitor adds still do`, async (t) => {
      const { first } = plan();
      const refusedIsland = START_NEIGHBOURS[0];
      const refusedText = how === "chip" ? FIRST_SUGGESTION : INDEX.byId.get(refusedIsland).teaser;
      const { backend, page, url } = await openSite(t, `refused-${status}-${how}`, (b) => {
        b.eventsMode = "sse";
        b.runMs = 500;
        b.reply = () => first.text;
        b.outcome = (number) => (number === 1 ? status : "accept");
      });
      await boot(page, url);

      // The chat refuses the suggestion and puts its text back into the message box.
      if (how === "chip") await page.click(CHIP);
      else await page.clickIsland(refusedIsland);
      await page.waitFor(`${PHASE_IS("rejected")} && document.querySelector("#atlas-notice").textContent.trim().length > 0`, {
        what: "the refusal and the pause notice",
      });
      assert.deepEqual(backend.posts, [{ message: refusedText, status }], "the refused suggestion is the only POST");
      assert.ok(ISLANDS.some((island) => island.teaser === refusedText) || refusedText === FIRST_SUGGESTION, "it is a suggestion of the graph");
      assert.equal((await read(page)).draft, refusedText, "precondition: the chat kept the refused text in the box");

      // Reload: the chat restores the refused text and the refusal; the Atlas has forgotten that the text was its own.
      await reloadTab(page, { phase: "rejected" });
      await page.waitFor(`document.querySelector("#draft").value === ${JSON.stringify(refusedText)}`, {
        what: "the chat to restore the refused text into the box",
      });
      await page.waitFor(`${CHIP_BLOCKED} && document.querySelector("#atlas-notice").textContent.trim().length > 0`, {
        what: "the pause to start again after the reload",
      });
      assert.equal(backend.posts.length, 1, "nothing was sent during the pause");

      // The pause is over (the clock is moved on, not waited for). The box still holds the refused text.
      await page.eval(`window.__atlasSkew(${REJECT_PAUSE_MS + 1000})`);
      await poke(page);
      await page.waitFor(CHIP_ENABLED, { what: "the suggestion to come back although the refused text is still in the box" });
      const resumed = await read(page);
      assert.equal(resumed.draft, refusedText, "the refused text is still in the box");
      assert.equal(resumed.notice, "", "no pause and no 'message box has text' notice");
      assert.ok(resumed.chips.length > 0 && resumed.chips.every((chip) => !chip.off), "every suggestion works");

      // Whatever the visitor adds to it is theirs: suggestions are off again, and tapping sends nothing.
      await page.type(VISITOR_WORDS);
      await page.waitFor(CHIP_BLOCKED, { what: "the suggestion to be blocked by the visitor's words" });
      const typed = await read(page);
      assert.equal(typed.draft, `${refusedText}${VISITOR_WORDS}`);
      assert.ok(typed.chips.every((chip) => chip.off), "all suggestions are off while the box holds the visitor's text");
      assert.equal(typed.notice, "", "no explanation is written for the visitor's own draft");
      await page.click(CHIP);
      await page.clickIsland(START_NEIGHBOURS[1]);
      await sleep(250);
      assert.equal(backend.posts.length, 1, "no POST while the box holds text the visitor typed");
      await focusEnd(page); // the taps above took the focus away from the box
      for (let i = 0; i < VISITOR_WORDS.length; i += 1) await page.press("Backspace");
      await page.waitFor(CHIP_ENABLED, { what: "the suggestion to come back when the box holds only the refused text again" });
      assert.equal((await read(page)).draft, refusedText);

      // A new tap is sent exactly once, unchanged, and its answer lights the map as usual.
      const chipText = (await read(page)).chips[0].text;
      assert.equal(chipText, FIRST_SUGGESTION, "the map is still at its start: the first suggestion is offered");
      await page.click(CHIP);
      await page.waitFor(`${REPLIES_ARE(1)} && ${PHASE_IS("ready")}`, { timeout: 15000, what: "the suggestion to be answered and scanned" });
      assert.deepEqual(backend.posts[1], { message: chipText, status: 200 }, "the new tap went out as exactly its own text");
      assert.equal(backend.posts.length, 2, "and only once");
      const done = await read(page);
      assertMapShows(done, [first.text], "after the answer");
      assert.equal(done.draft, "", "the chat cleared the box after the accepted send");

      // And the visitor's own words, typed from scratch, still stop suggestions.
      await page.click("#draft");
      await page.type(VISITOR_QUESTION);
      await page.waitFor(CHIP_BLOCKED, { what: "the suggestion to be blocked by a typed question" });
      await page.click(CHIP);
      await sleep(250);
      assert.equal(backend.posts.length, 2, "no POST while the box holds a typed question");
      assert.equal((await read(page)).cspViolations, 0);
    });
  }
});
