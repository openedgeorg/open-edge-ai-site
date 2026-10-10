/**
 * The test double of the conversation client against the working tree's own client, in Chrome.
 *
 * atlas_chat_double.test.mjs compares the two controllers without a document. This file compares
 * what they PAINT: the same scripted scenario is played against a page that serves the double at
 * /js/app.js and against a page that serves the working tree's site/js/app.js, and everything a
 * visitor (or the Atlas, which only watches the page) can see is compared: the sequence of
 * #phase texts, the sequence of #history lists, the message box, the Send and provider controls,
 * what is kept in sessionStorage, and every request the page made.
 *
 * One scenario plays TWO turns: turn 1 over the event stream, turn 2 with /events answering 404
 * and /history lagging (it still lists the older turns and the new question, but not the new reply,
 * for a while). That is where the working tree's acceptance of /history shows: a client that waits
 * for the NEW reply and one that takes any earlier assistant row paint different lists and reach
 * "ready" at different times. A double that is wrong there fails this file (see the scenario).
 *
 * It exists so that the browser suites can run on the double (and pass on a clean checkout)
 * without the double being allowed to drift away from the client it stands in for. Needs a Chrome
 * and a working tree whose own chat client can follow a stream, fill the history, settle and send
 * the CSRF header; without them the file is skipped with the reason printed.
 *
 * Not covered: the live client's source rendering (citations, the source panel) and the live API.
 *
 * Run: node --test --test-concurrency=1 tests/e2e/atlas_browser_double.test.mjs
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { findChrome, launchBrowser, realChatCapability, sleep, startSite } from "./atlas_browser_support.mjs";

const CHROME = findChrome();
const CAPABILITY = realChatCapability();
const SKIP = !CHROME.path
  ? CHROME.reason
  : CAPABILITY.ok
    ? false
    : `the working tree's own chat client cannot run: ${CAPABILITY.missing.join("; ")}`;

let browser = null;
const diagnostics = [];

/**
 * Recorder installed before any page script runs: the phase line and the list, as they change
 * (empty phase texts are not recorded: the line is empty until the chat has booted). It watches the
 * whole document from the first byte, so a paint that comes before DOMContentLoaded is not missed.
 */
const RECORDER = `(() => {
  const trace = { phase: [], rows: [] };
  Object.defineProperty(window, "__trace", { value: trace });
  let lastRows = "[]";
  const look = () => {
    const phase = document.querySelector("#phase");
    if (phase && phase.textContent !== "" && trace.phase[trace.phase.length - 1] !== phase.textContent) trace.phase.push(phase.textContent);
    const rows = JSON.stringify(Array.from(document.querySelectorAll("#history li > p")).map((p) => p.textContent));
    if (rows !== lastRows) { lastRows = rows; trace.rows.push(rows); }
  };
  new MutationObserver(look).observe(document, { childList: true, characterData: true, subtree: true });
})()`;

const READ = `(() => {
  const q = (selector) => document.querySelector(selector);
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem("esp-client")); } catch (error) { saved = "unreadable"; }
  return {
    phase: q("#phase").textContent,
    draft: q("#draft").value,
    rows: Array.from(document.querySelectorAll("#history li > p")).map((p) => p.textContent),
    sendDisabled: q("#send").disabled,
    providerDisabled: q("#provider").disabled,
    providerValue: q("#provider").value,
    saved,
    storageKeys: Object.keys(sessionStorage).filter((key) => !key.startsWith("esp-atlas")).sort(),
    trace: { phase: window.__trace.phase.slice(), rows: window.__trace.rows.slice() },
  };
})()`;

/** Random request ids become request-id-N, in the order they are first met. */
function idNormaliser() {
  const ids = new Map();
  return (value) => {
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) return value;
    if (!ids.has(value)) ids.set(value, `request-id-${ids.size + 1}`);
    return ids.get(value);
  };
}

/** Make the request log comparable: only the headers that matter stay. */
function comparableRequests(stub, norm) {
  const interesting = new Set(["accept", "content-type", "x-esp-csrf"]);
  return stub.requests
    .filter((request) => !/\.(js|css|html|ico|json|svg|png)$/.test(request.path) && request.path !== "/")
    .map((request) => ({
      method: request.method,
      url: request.url.replace(/(client_request_id=)[^&]+/, (_, head) => `${head}<id>`),
      headers: request.headers.filter((name) => interesting.has(name)),
      body: request.body && Object.keys(request.body).length ? Object.fromEntries(Object.entries(request.body).map(([key, value]) => [key, norm(value)])) : null,
    }));
}

/** Play one scenario against one client and return everything observable. */
async function play(chat, label, scenario) {
  const site = await startSite({ chat });
  const page = await browser.openPage({ label: `${label} (${chat})`, diagnostics });
  try {
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });
    const norm = idNormaliser();
    const observed = {};
    const take = async (name) => {
      const snapshot = await page.eval(READ);
      if (snapshot.saved && typeof snapshot.saved === "object") snapshot.saved.requestId = norm(snapshot.saved.requestId);
      observed[name] = snapshot;
    };
    await scenario({ page, stub: site.stub, url: `${site.origin}/`, take });
    observed.requests = comparableRequests(site.stub, norm);
    return observed;
  } finally {
    await page.close();
    await site.close();
  }
}

async function ready(page, url) {
  await page.goto(url);
  await page.waitFor(`document.querySelector("#phase").textContent.trim() === "ready"`, { what: "the chat to boot" });
}

const SCENARIOS = [
  [
    "a question is accepted and its reply streams into the list",
    async ({ page, stub, url, take }) => {
      stub.reply = () => "Alpha beta gamma delta epsilon.";
      await ready(page, url);
      await take("booted");
      await page.click("#draft");
      await page.type("hello there");
      await page.click("#send");
      await page.waitFor(`document.querySelector("#phase").textContent === "ready" && document.querySelectorAll("#history li").length === 2`, {
        timeout: 15000,
        what: "the reply in the list and the chat ready",
      });
      await take("answered");
    },
  ],
  [
    "no event stream: the chat settles from /history alone",
    async ({ page, stub, url, take }) => {
      stub.eventsMode = "404";
      stub.reply = () => "Only in the history.";
      await ready(page, url);
      await page.click("#draft");
      await page.type("hello there");
      await page.click("#send");
      await page.waitFor(`document.querySelector("#phase").textContent === "ready" && document.querySelectorAll("#history li").length === 2`, {
        timeout: 15000,
        what: "the reply in the list and the chat ready",
      });
      await take("answered");
    },
  ],
  [
    "a refusal keeps the text, the same request id is used for the retry",
    async ({ page, stub, url, take }) => {
      stub.outcome = (n) => (n === 1 ? 429 : "accept");
      stub.reply = () => "Second time lucky.";
      await ready(page, url);
      await page.click("#draft");
      await page.type("please answer");
      await page.click("#send");
      await page.waitFor(`document.querySelector("#phase").textContent === "rejected"`, { what: "the refusal to be painted" });
      await sleep(150);
      await take("refused");
      await page.click("#send");
      await page.waitFor(`document.querySelector("#phase").textContent === "ready" && document.querySelectorAll("#history li").length === 2`, {
        timeout: 15000,
        what: "the retried question to be answered",
      });
      await take("retried");
    },
  ],
  [
    "a lost acceptance is reconciled, also after a reload",
    async ({ page, stub, url, take }) => {
      stub.outcome = () => "drop";
      await ready(page, url);
      await page.click("#draft");
      await page.type("did it go?");
      await page.click("#send");
      await page.waitFor(`document.querySelector("#phase").textContent === "reconciling"`, { what: "reconciling to be painted" });
      await sleep(200);
      await take("lost");
      await page.reload();
      await page.waitFor(`document.querySelector("#phase").textContent.trim() !== ""`, { what: "the chat to boot again" });
      await sleep(200);
      await take("reloaded");
    },
  ],
  [
    "the session endpoint is down: nothing is ever painted and nothing is posted",
    async ({ page, stub, url, take }) => {
      stub.sessionMode = "html";
      await page.goto(url);
      await sleep(400);
      await take("booted");
      await page.click("#draft");
      await page.type("anyone there?");
      await page.click("#send");
      await sleep(500);
      await take("tried");
    },
  ],
  [
    "the message box gets focus while /history lags: a premature ready is painted",
    async ({ page, stub, url, take }) => {
      stub.eventsMode = "404";
      stub.historyDelayMs = 2600;
      stub.reply = () => "Late, but there.";
      await ready(page, url);
      await page.click("#draft");
      await page.type("slow one");
      await page.click("#send");
      await page.waitFor(`document.querySelector("#phase").textContent === "running"`, { what: "running to be painted" });
      await page.click("#draft");
      await page.waitFor(`document.querySelector("#phase").textContent === "ready"`, { what: "the premature ready" });
      await take("focused");
      await page.waitFor(`document.querySelectorAll("#history li").length === 2`, { timeout: 15000, what: "the history to catch up" });
      await sleep(200);
      await take("caught up");
    },
  ],
  [
    "a second question with no event stream while /history lags: the lists, the phases and the requests agree",
    async ({ page, stub, url, take }) => {
      stub.reply = (message, n) => (n === 1 ? "First answer, streamed." : "Second answer, late in the history.");
      await ready(page, url);
      await page.click("#draft");
      await page.type("first question");
      await page.click("#send");
      await page.waitFor(`document.querySelector("#phase").textContent === "ready" && document.querySelectorAll("#history li").length === 2`, {
        timeout: 15000,
        what: "turn 1 answered over the stream and the chat ready",
      });
      await take("turn 1");
      // Turn 2: no stream at all, and /history keeps listing the older turns and the new question
      // (but not the new reply) for 2.6 s. The history is polled every 2 s.
      stub.eventsMode = "404";
      stub.historyDelayMs = 2600;
      await page.click("#draft");
      await page.type("second question");
      await page.click("#send");
      await stub.waitFor(() => stub.posts.length === 2, { what: "the second question to be posted" });
      await page.waitFor(
        `document.querySelector("#phase").textContent === "ready" && window.__trace.phase.filter((text) => text === "running").length >= 2`,
        { timeout: 20000, what: "the second turn to run and the chat to be ready again" },
      );
      await take("turn 2 settled");
      // Past the lag: a client that took the older list does not refresh it; one that waited has the late reply by now.
      await sleep(stub.historyDelayMs + 800);
      await take("turn 2 later");
    },
    (real) => {
      // The scenario really played two turns (two identical but wrong runs would prove nothing).
      const messages = real.requests.filter((request) => request.method === "POST" && request.url.endsWith("/messages"));
      assert.deepEqual(
        messages.map((request) => request.body.message),
        ["first question", "second question"],
      );
      assert.equal(real.requests.filter((request) => request.url.endsWith("/events")).length, 2, "one stream request per turn");
      assert.ok(real.requests.filter((request) => request.url.endsWith("/history")).length >= 2, "the history was read after each turn");
      assert.deepEqual(real["turn 1"].rows, ["first question", "First answer, streamed."]);
      assert.equal(real["turn 2 settled"].phase, "ready");
      assert.ok(real["turn 2 settled"].rows.includes("second question"), "the second question is in the list");
      assert.equal(real["turn 2 settled"].saved.requestId, null, "nothing is pending at the end");
    },
  ],
];

describe("the chat double paints like the working tree's chat client (browser level)", { skip: SKIP, timeout: 240000 }, () => {
  before(async () => {
    browser = await launchBrowser(CHROME.path);
  });

  after(async () => {
    if (browser) await browser.close();
  });

  for (const [name, scenario, verify] of SCENARIOS) {
    it(name, async () => {
      const real = await play("real", name, scenario);
      const double = await play("double", name, scenario);
      // Sanity: the scenario really happened (a comparison of two empty runs proves nothing).
      assert.ok(Object.keys(real).length >= 2, "the scenario took at least one snapshot");
      assert.ok(real.requests.length >= 1, "the page talked to the stub");
      if (verify) verify(real);
      assert.deepEqual(double, real);
    });
  }
});
