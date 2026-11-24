/**
 * The conversation client's page wiring in Chrome: what site/js/app.js paints into the real
 * site/index.html (status line, action buttons, history rows and its loading/failed line, provider
 * select, message box) and what real input does to it.
 *
 * The page talks to a small HTTP server that wraps the same fake backend the Node tests use
 * (chat_client_support.mjs: it follows the API contract of apps/api), so a failure is one override of
 * one route. The client is always the working tree's own site/js/app.js, whatever ATLAS_CHAT says.
 * The logic (every row of the outcome table, polling, correlation) is covered without a browser in
 * chat_client_outcomes/restore/state.test.mjs; this file is about the DOM: nothing reaches the page
 * as markup, buttons are shown only when they apply, a refresh restores what it should, one click is one
 * question.
 *
 * Run: node --test --test-concurrency=1 tests/e2e/chat_client_browser.test.mjs
 * Chrome: /usr/bin/google-chrome, or ATLAS_CHROME. Without a Chrome the whole file is skipped.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { BROWSER_CONCURRENCY, findChrome, launchBrowser, siteFileFor, sleep } from "./atlas_browser_support.mjs";
import { ANSWER_ONE, createBackend, errorBody, frame, heldStream, jsonResponse } from "./chat_client_support.mjs";

const CHROME = findChrome();
let browser = null;
const diagnostics = [];

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
const API = /^\/(visitor-session|providers|conversations)(\/|$)/;

/** A server for the site and, on the same origin, the fake backend. */
async function startServer(backend) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://stub.invalid");
    try {
      if (API.test(url.pathname)) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString("utf8");
        let response;
        try {
          response = await backend.fetchImpl(`${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: body || undefined });
        } catch {
          req.socket.destroy(); // the backend "lost" the connection
          return;
        }
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (!response.body) {
          res.end();
          return;
        }
        const reader = response.body.getReader();
        res.on("close", () => void reader.cancel().catch(() => {}));
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          res.write(next.value);
        }
        res.end();
        return;
      }
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      let relative = decodeURIComponent(url.pathname);
      if (relative.endsWith("/")) relative += "index.html";
      const full = siteFileFor(relative, "real");
      if (full === null) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(full, (error, data) => {
        if (error) {
          res.writeHead(404, { "content-type": "text/plain" }).end("not found");
          return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
        res.end(data);
      });
    } catch (error) {
      try {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(error && error.message));
      } catch {
        /* the socket is gone */
      }
    }
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
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

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

const PHASE = `document.querySelector("#phase").textContent.trim()`;
const phaseIs = (phase) => `${PHASE} === ${JSON.stringify(phase)}`;

async function boot(page, url) {
  await page.goto(url);
  await page.waitFor(`${PHASE} !== ""`, { what: "the chat to paint a phase" });
}

/** Everything the tests look at. */
const READ = `(() => {
  const q = (selector) => document.querySelector(selector);
  const shown = (selector) => { const el = q(selector); return !!el && !el.hidden && el.getClientRects().length > 0; };
  const history = q("#history");
  return {
    phase: q("#phase").textContent.trim(),
    status: q("#chat-status").textContent,
    statusKind: q("#chat-status").getAttribute("data-kind"),
    statusShown: shown("#chat-status"),
    draft: q("#draft").value,
    sendDisabled: q("#send").disabled,
    providerValue: q("#provider").value,
    providerDisabled: q("#provider").disabled,
    options: Array.from(q("#provider").options).map((o) => ({ value: o.value, text: o.textContent, disabled: o.disabled })),
    rows: Array.from(history.children).map((li) => ({ role: li.getAttribute("data-role"), key: li.getAttribute("data-key"), text: li.querySelector("p").textContent })),
    buttons: { cancel: shown("#cancel"), checkStatus: shown("#check-status"), retry: shown("#retry"), newConversation: shown("#new-conversation") },
    cancelDisabled: q("#cancel").disabled,
    newConversationLabel: q("#new-conversation").textContent,
    historyState: { shown: shown("#history-state"), kind: q("#history-state").getAttribute("data-kind"), text: q("#history-state-text").textContent, retry: shown("#history-retry") },
    // A control with the hidden attribute must really be gone: no style of the page may bring it back.
    hiddenAreGone: ["#cancel", "#check-status", "#retry", "#new-conversation", "#chat-status", "#history-state", "#history-retry"]
      .filter((selector) => q(selector).hidden)
      .every((selector) => getComputedStyle(q(selector)).display === "none"),
    csp: window.__cspViolations ? window.__cspViolations.length : -1,
    stored: sessionStorage.getItem("esp-client"),
  };
})()`;
const read = (page) => page.eval(READ);

async function typeAndSend(page, text) {
  await page.click("#draft");
  await page.type(text);
  await page.click("#send");
}

const SUITE = { skip: CHROME.path ? false : CHROME.reason, timeout: 240000, concurrency: BROWSER_CONCURRENCY };

describe("the conversation client in Chrome", SUITE, () => {
  before(async () => {
    browser = await launchBrowser(CHROME.path);
  });

  after(async () => {
    if (browser) await browser.close();
  });

  it("nothing is painted before the first boot, then the chat is ready with no stale controls", async (t) => {
    const { page, url } = await openSite(t, "boot");
    await boot(page, url);
    const view = await read(page);
    assert.equal(view.phase, "ready");
    assert.equal(view.status, "");
    assert.equal(view.statusShown, false);
    assert.deepEqual(view.buttons, { cancel: false, checkStatus: false, retry: false, newConversation: false });
    assert.equal(view.historyState.shown, false);
    assert.equal(view.hiddenAreGone, true, "hidden controls are not drawn");
    assert.deepEqual(view.rows, []);
    assert.equal(view.sendDisabled, false);
    assert.equal(view.csp, 0, "no Content-Security-Policy violation");
  });

  it("a question and its answer: rows with roles, the status line, Cancel only while a run is known, nothing as markup", async (t) => {
    const { backend, page, url } = await openSite(t, "turn");
    await boot(page, url);
    await typeAndSend(page, "Who pays <b>the apps</b>?");
    await page.waitFor(phaseIs("running"), { what: "the run to be accepted" });
    const running = await read(page);
    assert.equal(running.sendDisabled, true);
    assert.equal(running.draft, "", "the sent text left the message box");
    assert.deepEqual(running.rows.map((row) => [row.role, row.text]), [["user", "Who pays <b>the apps</b>?"]]);
    assert.match(running.status, /^Your question was received\. The answer is being prepared\./);
    assert.equal(running.statusKind, "working");
    assert.equal(running.statusShown, true);
    assert.equal(running.buttons.cancel, true, "the accepted response named the run");
    assert.equal(running.providerDisabled, true);
    assert.equal(running.buttons.newConversation, true);

    backend.answer("<script>window.__pwned = 1</script>The household pays.\n\nSecond paragraph.");
    await page.waitFor(phaseIs("ready"), { timeout: 15000, what: "the answer" });
    const done = await read(page);
    assert.deepEqual(done.rows.map((row) => [row.role, row.text]), [
      ["user", "Who pays <b>the apps</b>?"],
      ["assistant", "<script>window.__pwned = 1</script>The household pays.\n\nSecond paragraph."],
    ]);
    assert.equal(await page.eval(`document.querySelectorAll("#history b, #history script").length`), 0, "no element came from the answer");
    assert.equal(await page.eval(`window.__pwned`), undefined);
    assert.equal(done.status, "The answer is ready.");
    assert.deepEqual(done.buttons, { cancel: false, checkStatus: false, retry: false, newConversation: true });
    assert.equal(done.sendDisabled, false);
    assert.equal(done.csp, 0);
  });

  it("one click is one question: a fast double click and a repeated Enter-less submit send once", async (t) => {
    const { backend, page, url } = await openSite(t, "double-click");
    await boot(page, url);
    await page.click("#draft");
    await page.type("Just one question");
    await page.eval(`(() => { const b = document.querySelector("#send"); b.click(); b.click(); document.querySelector("#composer").requestSubmit(); return true; })()`);
    await page.waitFor(phaseIs("running"), { what: "the run" });
    await sleep(300);
    assert.equal(backend.posts().length, 1);
    assert.equal(backend.callsTo("create").length, 1);
    assert.equal((await read(page)).rows.length, 1);
  });

  it("the unsent draft is saved as it is typed, pasted, deleted and left, and comes back after a refresh", async (t) => {
    const { backend, page, url } = await openSite(t, "draft");
    await boot(page, url);
    await page.click("#draft");
    await page.type("Could you give");
    await page.type(" a household example?"); // a paste or a composition commit
    for (let i = 0; i < 9; i += 1) await page.press("Backspace");
    await page.press("Tab"); // leaves the box
    await page.reload();
    await page.waitFor(`${PHASE} !== ""`, { what: "the chat after the refresh" });
    const after = await read(page);
    assert.equal(after.draft, "Could you give a household");
    assert.equal(backend.posts().length, 0);
    assert.doesNotMatch(after.stored, /undefined/);
  });

  it("a refresh brings the conversation back without sending anything, with the provider of that conversation", async (t) => {
    const { backend, page, url } = await openSite(t, "refresh", () => {});
    await boot(page, url);
    await page.eval(`(() => { const s = document.querySelector("#provider"); s.value = "xai"; s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
    await typeAndSend(page, "First question");
    await page.waitFor(phaseIs("running"), { what: "the run" });
    backend.answer(ANSWER_ONE);
    await page.waitFor(phaseIs("ready"), { timeout: 15000, what: "the answer" });
    await page.click("#draft");
    await page.type("An unsent follow-up");
    await page.press("Tab");
    const posts = backend.posts().length;
    await page.reload();
    await page.waitFor(`${PHASE} === "ready" && document.querySelectorAll("#history li").length === 2`, { what: "the history to come back" });
    const view = await read(page);
    assert.deepEqual(view.rows.map((row) => row.role), ["user", "assistant"]);
    assert.equal(view.rows[1].text, ANSWER_ONE);
    assert.equal(view.draft, "An unsent follow-up");
    assert.equal(view.providerValue, "xai", "the provider of the conversation");
    assert.equal(view.providerDisabled, true);
    assert.equal(view.historyState.shown, false);
    assert.equal(backend.posts().length, posts, "a refresh sends nothing");
    assert.equal(backend.callsTo("create").length, 1);
  });

  it("while the history loads there is a loading line; when it cannot be read there is a failure line with its own retry", async (t) => {
    const { backend, page, url } = await openSite(t, "history-line");
    await boot(page, url);
    await typeAndSend(page, "A question");
    await page.waitFor(phaseIs("running"), { what: "the run" });
    backend.answer(ANSWER_ONE);
    await page.waitFor(phaseIs("ready"), { timeout: 15000, what: "the answer" });

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    backend.override("history", async () => {
      calls += 1;
      if (calls === 1) await gate;
      if (calls === 2) return jsonResponse(503, errorBody("history_unavailable", "This conversation's history cannot be read right now.", { retryable: true, submitted: null }));
      return undefined;
    });
    await page.reload();
    await page.waitFor(`document.querySelector("#history-state") && !document.querySelector("#history-state").hidden`, { what: "the loading line" });
    const loading = await read(page);
    assert.equal(loading.historyState.kind, "loading");
    assert.equal(loading.historyState.text, "Loading the conversation so far…");
    assert.equal(loading.historyState.retry, false);
    assert.equal(loading.sendDisabled, false, "the chat is usable while the history loads");
    release();
    await page.waitFor(`document.querySelectorAll("#history li").length === 2`, { what: "the history" });
    assert.equal((await read(page)).historyState.shown, false);

    // Now the read fails.
    calls = 1; // the next read is the failing one
    await page.reload();
    await page.waitFor(`document.querySelector("#history-state").getAttribute("data-kind") === "failed"`, { what: "the failure line" });
    const failed = await read(page);
    assert.match(failed.historyState.text, /could not be loaded/);
    assert.equal(failed.historyState.retry, true, "a retry button");
    assert.deepEqual(failed.rows, [], "an empty list is not an empty conversation");
    assert.equal(failed.providerDisabled, true, "it is still the same conversation");
    const posts = backend.posts().length;
    await page.click("#history-retry");
    await page.waitFor(`document.querySelectorAll("#history li").length === 2 && document.querySelector("#history-state").hidden`, { what: "the history after the retry" });
    assert.equal(backend.posts().length, posts, "retrying the display sent nothing");
  });

  it("a refusal is explained, the text is back in the box and Send works; nothing is shown as sent", async (t) => {
    const { backend, page, url } = await openSite(t, "refusal", (b) => {
      b.override("messages", (ctx) => (ctx.n === 1 ? jsonResponse(429, errorBody("rate_limited", "Too many", { retryable: true }), { "retry-after": "20" }) : undefined));
    });
    await boot(page, url);
    await typeAndSend(page, "Please answer");
    await page.waitFor(phaseIs("rejected"), { what: "the refusal" });
    const view = await read(page);
    assert.match(view.status, /You are sending messages too quickly\. Nothing was sent\. Wait about 20 seconds/);
    assert.equal(view.statusKind, "error");
    assert.equal(view.draft, "Please answer");
    assert.deepEqual(view.rows, []);
    assert.equal(view.sendDisabled, false);
    await page.click("#send");
    await page.waitFor(phaseIs("running"), { what: "the second try" });
    assert.equal(backend.posts().length, 2);
    assert.equal((await read(page)).status.startsWith("Your question was received"), true, "the old message is gone");
  });

  it("an acceptance that never reached the service: the status allows Send again, and it is the same request", async (t) => {
    let dropping = true;
    const { backend, page, url } = await openSite(t, "never-saw-it", (b) => {
      // (The browser repeats a POST whose connection was dropped; every attempt fails while `dropping`.)
      b.override("messages", () => (dropping ? new Error("lost") : undefined));
    });
    await boot(page, url);
    await typeAndSend(page, "Did it go?");
    await page.waitFor(phaseIs("failed"), { what: "the status to say it never started" });
    const failed = await read(page);
    assert.deepEqual(failed.buttons, { cancel: false, checkStatus: false, retry: true, newConversation: true });
    assert.match(failed.status, /never reached the AI/);
    assert.deepEqual(failed.rows.map((row) => row.text), ["Did it go?"]);
    assert.equal(failed.draft, "", "the pending question is not turned into a draft");
    assert.equal(failed.sendDisabled, false);
    await page.click("#draft");
    await page.type("something typed meanwhile");
    dropping = false;
    await page.click("#retry");
    await page.waitFor(phaseIs("running"), { what: "the resend" });
    const ids = new Set(backend.posts().map((call) => call.body.client_request_id));
    assert.equal(ids.size, 1, "the same logical question, however often the browser repeated the request");
    assert.equal(backend.posts().at(-1).body.message, "Did it go?");
    const view = await read(page);
    assert.equal(view.draft, "something typed meanwhile", "what the visitor typed is theirs");
    assert.equal(view.buttons.retry, false);
  });

  it("an acceptance whose answer was lost after the service took it: the browser's repeat is a duplicate, and it is consumed as a status", async (t) => {
    const { backend, page, url } = await openSite(t, "duplicate", (b) => {
      b.override("messages", async (ctx) => {
        if (ctx.n === 1) {
          const response = b.defaults.messages(ctx);
          await response.body.cancel();
          return new Error("lost after the service took it");
        }
        return undefined; // the repeat meets the current request: the service answers with a duplicate
      });
    });
    await boot(page, url);
    await typeAndSend(page, "Did it go?");
    await page.waitFor(phaseIs("running"), { what: "the run, found through the duplicate or the status" });
    assert.equal(new Set(backend.posts().map((call) => call.body.client_request_id)).size, 1);
    assert.equal(backend.conversation().items.filter((item) => item.role === "user").length, 1, "one question in the conversation");
    assert.deepEqual((await read(page)).rows.map((row) => row.text), ["Did it go?"]);
  });

  it("a status that cannot say: Check status is offered, Send again never, and Check status asks the service again", async (t) => {
    const { backend, page, url } = await openSite(t, "unconfirmed", (b) => {
      b.override("messages", (ctx) => {
        const conv = b.conversations.get(ctx.params[0]);
        const run = { requestId: ctx.body.client_request_id, conversationId: conv.id, runId: "run-1", workRef: "work-1", state: "unconfirmed" };
        conv.run = run;
        b.requests.set(run.requestId, run);
        return jsonResponse(409, { error: { code: "submission_unconfirmed", message: "x", retryable: false }, submitted: null, status_url: "/s", resubmission_allowed: false }, { "x-esp-acceptance": "unconfirmed" });
      });
    });
    await boot(page, url);
    await typeAndSend(page, "Did it go?");
    await page.waitFor(phaseIs("reconciling"), { what: "reconciling" });
    // The phase changes first; Cancel appears when the status reply has named the run. Wait for that, do not race it.
    await page.waitFor(`(() => { const el = document.querySelector("#cancel"); return !!el && !el.hidden && el.getClientRects().length > 0; })()`, { what: "Cancel to appear once the status named the run" });
    const view = await read(page);
    assert.deepEqual(view.buttons, { cancel: true, checkStatus: true, retry: false, newConversation: true }, "the status named the run, so it can be cancelled");
    assert.match(view.status, /We could not confirm that your question arrived\. It may already be on its way, so it will not be sent again\./);
    assert.equal(view.sendDisabled, true);
    const checks = backend.callsTo("status").length;
    await page.click("#check-status");
    await page.waitFor(`true`);
    await sleep(200);
    assert.ok(backend.callsTo("status").length > checks, "the button asked again");
    assert.match((await read(page)).status, /Last check: still not confirmed\./);
    assert.equal(backend.posts().length, 1);
  });

  it("Cancel reports the real result", async (t) => {
    const { backend, page, url } = await openSite(t, "cancel");
    await boot(page, url);
    await typeAndSend(page, "A long question");
    await page.waitFor(phaseIs("running"), { what: "the run" });
    await page.waitFor(`!document.querySelector("#cancel").hidden`, { what: "Cancel" });
    await page.click("#cancel");
    await page.waitFor(phaseIs("cancelled"), { what: "the confirmed cancellation" });
    const view = await read(page);
    assert.match(view.status, /^Cancelled\. This question has no answer\./);
    assert.deepEqual(view.buttons, { cancel: false, checkStatus: false, retry: false, newConversation: true });
    assert.equal(backend.callsTo("cancel").length, 1);

    // And an unconfirmed stop is not reported as a cancellation.
    backend.cancelBehavior = "unconfirmed";
    await page.click("#draft");
    await page.type("Another long question");
    await page.click("#send");
    await page.waitFor(phaseIs("running"), { what: "the second run" });
    await page.waitFor(`!document.querySelector("#cancel").hidden`, { what: "Cancel" });
    await page.click("#cancel");
    await page.waitFor(`${PHASE} === "cancelling" && /could not confirm it yet/.test(document.querySelector("#chat-status").textContent)`, { what: "the honest message" });
    const stopping = await read(page);
    assert.doesNotMatch(stopping.status, /^Cancelled/);
    assert.equal(stopping.cancelDisabled, true, "Cancel cannot be pressed twice");
  });

  it("New conversation asks twice, says what it clears, and lets the visitor pick the provider", async (t) => {
    const { backend, page, url } = await openSite(t, "new-conversation");
    await boot(page, url);
    await typeAndSend(page, "First");
    await page.waitFor(phaseIs("running"), { what: "the run" });
    backend.answer(ANSWER_ONE);
    await page.waitFor(phaseIs("ready"), { timeout: 15000, what: "the answer" });
    await page.click("#new-conversation");
    let view = await read(page);
    assert.match(view.status, /clears the answers shown here/);
    assert.match(view.status, /Your map progress is kept/);
    assert.equal(view.statusKind, "confirm");
    assert.equal(view.newConversationLabel, "Confirm: start a new conversation");
    assert.equal(view.rows.length, 2, "nothing is cleared by the first press");
    await page.click("#new-conversation");
    view = await read(page);
    assert.deepEqual(view.rows, []);
    assert.equal(view.providerDisabled, false, "the provider can be chosen again");
    assert.match(view.status, /^New conversation\./);
    assert.deepEqual(view.buttons.newConversation, false);
    await page.eval(`(() => { const s = document.querySelector("#provider"); s.value = "xai"; s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
    await typeAndSend(page, "Second");
    await page.waitFor(phaseIs("running"), { what: "the run in the new conversation" });
    assert.equal(backend.callsTo("create").length, 2);
    assert.equal(backend.callsTo("create")[1].body.provider, "xai");
    assert.equal((await read(page)).providerValue, "xai");
  });

  it("a provider that is not available is marked in the select with its reason, and the default moves to one that is", async (t) => {
    const { page, url } = await openSite(t, "providers", (b) => {
      b.providers[0].available = false;
    });
    await boot(page, url);
    await page.waitFor(`document.querySelector("#provider").options[0].disabled`, { what: "the provider list to be read" });
    const view = await read(page);
    assert.deepEqual(view.options, [
      { value: "openai", text: "OpenAI (unavailable right now)", disabled: true },
      { value: "xai", text: "xAI", disabled: false },
    ]);
    assert.equal(view.providerValue, "xai");
    assert.equal(view.providerDisabled, false);
  });

  it("a service that cannot be reached is told in words, and the chat comes back by itself", async (t) => {
    const { backend, page, url } = await openSite(t, "unreachable", (b) => {
      b.override("session", () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    });
    await boot(page, url);
    const view = await read(page);
    assert.equal(view.phase, "unavailable");
    assert.match(view.status, /could not be reached\. Nothing was sent\./);
    assert.equal(view.sendDisabled, false);
    backend.clearOverride("session");
    await page.waitFor(phaseIs("ready"), { timeout: 20000, what: "the chat to start by itself" });
    assert.equal((await read(page)).status, "");
  });

  it("a stream that streams the answer shows it growing in one row, then the history's text", async (t) => {
    const stream = heldStream([]);
    const { backend, page, url } = await openSite(t, "streaming", (b) => {
      b.override("events", () => stream.response);
    });
    await boot(page, url);
    await typeAndSend(page, "Stream it");
    await page.waitFor(phaseIs("running"), { what: "the run" });
    const envelope = (sequence, text) => frame({ protocol_version: 1, conversation_id: "conv-1", provider_session_id: "p", activeAgentRunId: "run-1", nativeWorkRef: "work-1", connection_id: "c", sequence, event: { type: "text_delta", text } });
    stream.push(envelope(1, "The house"));
    await page.waitFor(`document.querySelectorAll("#history li").length === 2`, { what: "the answer row" });
    stream.push(envelope(2, "hold pays."));
    await page.waitFor(`document.querySelectorAll("#history li")[1].querySelector("p").textContent === "The household pays."`, { what: "the row to grow" });
    assert.equal(await page.eval(`document.querySelectorAll("#history li").length`), 2, "one row, not one per delta");
    backend.answer("The household pays.");
    stream.release();
    await page.waitFor(phaseIs("ready"), { timeout: 15000, what: "the final answer" });
    assert.deepEqual((await read(page)).rows.map((row) => row.text), ["Stream it", "The household pays."]);
  });
});
