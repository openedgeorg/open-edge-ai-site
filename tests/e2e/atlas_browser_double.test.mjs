/**
 * The test double of the conversation client next to the working tree's own client, in Chrome.
 *
 * The double (tests/fixtures/atlas_chat_double/app.js) is a port of the OLD conversation client. The
 * working tree's client has since been fixed (F01 to F03: every question has a visible outcome, a
 * pending turn is only completed by its OWN answer, a refresh restores the history, the draft and the
 * pending request, a failing service is told in words). So the two no longer paint the same thing, and
 * this file no longer asserts that they do. It plays the same scripted scenarios against a page that
 * serves the double at /js/app.js and against a page that serves the working tree's site/js/app.js, and
 * for each side it states what a visitor (or the Atlas, which only watches the page) sees at each
 * snapshot: #phase, the message box, the rows of the list, Send, and the sequence of phases painted:
 *  - `double`: what the old client paints (the browser suites run on it by default, so this pins what
 *    they are testing the Atlas against, quirks included);
 *  - `real`: what the working tree's client paints now.
 * Where the two differ, the difference is the fix. Where a browser suite only passes on the double
 * because the double lacks the new behaviour, that is said in the suite (REAL branches in
 * atlas_browser_late.test.mjs and atlas_browser_reload.test.mjs); the double is not edited.
 *
 * Two scenarios play TWO turns: turn 1 over the event stream, turn 2 with /events answering 404
 * and /history lagging for a while. They differ in what the lagging /history lists:
 *  - [Q1, A1, Q2]: the older turns and the new question, but not the new reply;
 *  - [Q1, A1]: the older turns only, not even the new question (stub.historyHidesNewQuestion).
 * The old client takes any earlier assistant row for the answer and paints `ready` on the older list; the
 * working tree's client keeps the turn pending until its own answer is listed.
 *
 * Needs a Chrome and a working tree whose own chat client can follow a stream, fill the history, settle and
 * send the CSRF header; without them the file is skipped with the reason printed.
 *
 * Not covered: the live client's source rendering (citations, the source panel) and the live API
 * (tests/e2e/chat_client_*.test.mjs run the real client against a fake backend that follows the API contract).
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

/** Play one scenario against one client: everything observable, and what the stub's /history answered, in order. */
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
    // What /history answered is only used to prove the scenario played the shape it claims; it is not compared.
    return { observed, historyReads: site.stub.historyReads.map((read) => read.slice()) };
  } finally {
    await page.close();
    await site.close();
  }
}

async function ready(page, url) {
  await page.goto(url);
  await page.waitFor(`document.querySelector("#phase").textContent.trim() === "ready"`, { what: "the chat to boot" });
}

const FIRST_TURN_READ = ["user: first question", "assistant: First answer, streamed."];

/**
 * Two turns, the second with no event stream while /history lags. Turn 2's lag lists either the older
 * turns and the new question ([Q1, A1, Q2]) or the older turns only ([Q1, A1]); both are played.
 * @param {{hideNewQuestion: boolean}} shape
 */
function twoTurns({ hideNewQuestion }) {
  const listing = hideNewQuestion ? "does not list the new question yet" : "already lists the new question";
  const TURN_ONE = ["first question", "First answer, streamed."];
  const TURN_TWO = [...TURN_ONE, "second question", "Second answer, late in the history."];
  const oldPhases = ["ready", "running", "ready", "running", "ready"];
  const realPhases = ["ready", "submitting", "running", "ready", "submitting", "running", "ready"];
  // The old client paints `ready` on the older list; which list it is depends on what the lag lists.
  const oldList = hideNewQuestion ? TURN_ONE : [...TURN_ONE, "second question"];
  return {
    name: `a second question with no event stream while /history lags and ${listing}`,
    scenario: async ({ page, stub, url, take }) => {
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
      // Turn 2: no stream at all, and /history keeps listing the older turns (with or without the new question,
      // never the new reply) for 2.6 s. The history is polled every 2 s.
      stub.eventsMode = "404";
      stub.historyDelayMs = 2600;
      stub.historyHidesNewQuestion = hideNewQuestion;
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
    verify: (real, historyReads) => {
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
      assert.equal(real["turn 2 settled"].saved.requestId, null, "nothing is pending at the end");
      // ... and /history really lagged in the shape this scenario names.
      const lagging = historyReads.filter((read) => read.length >= 2 && !read.includes("assistant: Second answer, late in the history."));
      if (hideNewQuestion) {
        assert.ok(
          historyReads.filter((read) => JSON.stringify(read) === JSON.stringify(FIRST_TURN_READ)).length >= 2,
          "after turn 1, /history was read again and still listed the older turns only",
        );
        assert.ok(!lagging.some((read) => read.includes("user: second question")), "the lag never lists the new question");
      } else {
        assert.ok(
          lagging.some((read) => JSON.stringify(read) === JSON.stringify([...FIRST_TURN_READ, "user: second question"])),
          "the lag lists the older turns and the new question, but not the new reply",
        );
        assert.ok(real["turn 2 settled"].rows.includes("second question"), "the second question is in the list");
      }
    },
    double: {
      "turn 1": { phase: "ready", draft: "", rows: TURN_ONE, sendDisabled: false, phases: ["ready", "running", "ready"] },
      "turn 2 settled": { phase: "ready", draft: "", rows: oldList, sendDisabled: false, phases: oldPhases },
      "turn 2 later": { phase: "ready", draft: "", rows: oldList, sendDisabled: false, phases: oldPhases },
    },
    real: {
      "turn 1": { phase: "ready", draft: "", rows: TURN_ONE, sendDisabled: false, phases: ["ready", "submitting", "running", "ready"] },
      // The working tree's client waits for its own answer, however long /history lags.
      "turn 2 settled": { phase: "ready", draft: "", rows: TURN_TWO, sendDisabled: false, phases: realPhases },
      "turn 2 later": { phase: "ready", draft: "", rows: TURN_TWO, sendDisabled: false, phases: realPhases },
    },
  };
}

const FIRST = "hello there";

/** What a snapshot comes down to for the Atlas and the visitor. */
function summary(observed) {
  const out = {};
  for (const [name, snapshot] of Object.entries(observed)) {
    if (name === "requests") continue;
    out[name] = { phase: snapshot.phase, draft: snapshot.draft, rows: snapshot.rows, sendDisabled: snapshot.sendDisabled, phases: snapshot.trace.phase };
  }
  return out;
}

/** The ids of the questions the page POSTed, in order, without repeats (the browser may repeat a request whose connection dropped). */
const questionIds = (requests) => [...new Set(requests.filter((request) => request.method === "POST" && request.url.endsWith("/messages")).map((request) => request.body.client_request_id))];

const SCENARIOS = [
  {
    name: "a question is accepted and its reply streams into the list",
    scenario: async ({ page, stub, url, take }) => {
      stub.reply = () => "Alpha beta gamma delta epsilon.";
      await ready(page, url);
      await take("booted");
      await page.click("#draft");
      await page.type(FIRST);
      await page.click("#send");
      await page.waitFor(`document.querySelector("#phase").textContent === "ready" && document.querySelectorAll("#history li").length === 2`, {
        timeout: 15000,
        what: "the reply in the list and the chat ready",
      });
      await take("answered");
    },
    double: {
      booted: { phase: "ready", draft: "", rows: [], sendDisabled: false, phases: ["ready"] },
      answered: { phase: "ready", draft: "", rows: [FIRST, "Alpha beta gamma delta epsilon."], sendDisabled: false, phases: ["ready", "running", "ready"] },
    },
    real: {
      booted: { phase: "ready", draft: "", rows: [], sendDisabled: false, phases: ["ready"] },
      answered: { phase: "ready", draft: "", rows: [FIRST, "Alpha beta gamma delta epsilon."], sendDisabled: false, phases: ["ready", "submitting", "running", "ready"] },
    },
  },
  {
    name: "no event stream: the chat settles from /history alone",
    scenario: async ({ page, stub, url, take }) => {
      stub.eventsMode = "404";
      stub.reply = () => "Only in the history.";
      await ready(page, url);
      await page.click("#draft");
      await page.type(FIRST);
      await page.click("#send");
      await page.waitFor(`document.querySelector("#phase").textContent === "ready" && document.querySelectorAll("#history li").length === 2`, {
        timeout: 15000,
        what: "the reply in the list and the chat ready",
      });
      await take("answered");
    },
    double: { answered: { phase: "ready", draft: "", rows: [FIRST, "Only in the history."], sendDisabled: false, phases: ["ready", "running", "ready"] } },
    real: { answered: { phase: "ready", draft: "", rows: [FIRST, "Only in the history."], sendDisabled: false, phases: ["ready", "submitting", "running", "ready"] } },
  },
  {
    name: "a refusal puts the text back in the box; the visitor sends it again",
    scenario: async ({ page, stub, url, take }) => {
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
    verify: (real) => {
      // The refused question was never sent, so the second one is a new logical question with a new id.
      assert.equal(questionIds(real.requests).length, 2);
    },
    double: {
      refused: { phase: "rejected", draft: "please answer", rows: ["please answer"], sendDisabled: false, phases: ["ready", "rejected"] },
      retried: { phase: "ready", draft: "", rows: ["please answer", "Second time lucky."], sendDisabled: false, phases: ["ready", "rejected", "running", "ready"] },
    },
    real: {
      // A question that was refused is not shown as sent; its text is back in the box.
      refused: { phase: "rejected", draft: "please answer", rows: [], sendDisabled: false, phases: ["ready", "submitting", "rejected"] },
      retried: { phase: "ready", draft: "", rows: ["please answer", "Second time lucky."], sendDisabled: false, phases: ["ready", "submitting", "rejected", "submitting", "running", "ready"] },
    },
  },
  {
    name: "a lost acceptance is checked, never resent, also after a reload",
    scenario: async ({ page, stub, url, take }) => {
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
    verify: (real) => {
      // (The browser itself may repeat a POST whose connection was dropped; the page asked once.)
      assert.equal(questionIds(real.requests).length, 1, "one logical question");
      assert.ok(real.requests.filter((request) => request.url.includes("/status?client_request_id=")).length >= 2, "its status was asked, before and after the reload");
    },
    double: {
      lost: { phase: "reconciling", draft: "did it go?", rows: ["did it go?"], sendDisabled: true, phases: ["ready", "reconciling"] },
      // The old client forgets the pending question on a reload: ready, an empty list, the text as a draft.
      reloaded: { phase: "ready", draft: "did it go?", rows: [], sendDisabled: false, phases: ["ready"] },
    },
    real: {
      lost: { phase: "reconciling", draft: "", rows: ["did it go?"], sendDisabled: true, phases: ["ready", "submitting", "reconciling"] },
      // The working tree's client keeps it: still checking, the question still listed, Send still off.
      reloaded: { phase: "reconciling", draft: "", rows: ["did it go?"], sendDisabled: true, phases: ["reconciling"] },
    },
  },
  {
    name: "the session endpoint is down: nothing is posted but the session",
    scenario: async ({ page, stub, url, take }) => {
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
    verify: (real) => {
      assert.equal(real.requests.filter((request) => request.url.endsWith("/messages") || request.url.endsWith("/conversations")).length, 0, "no conversation, no question");
    },
    double: {
      // Nothing is ever painted by the old client until the box gets focus; the typed text is listed as if sent.
      booted: { phase: "", draft: "", rows: [], sendDisabled: false, phases: [] },
      tried: { phase: "ready", draft: "anyone there?", rows: ["anyone there?"], sendDisabled: false, phases: ["ready"] },
    },
    real: {
      booted: { phase: "unavailable", draft: "", rows: [], sendDisabled: false, phases: ["unavailable"] },
      tried: { phase: "rejected", draft: "anyone there?", rows: [], sendDisabled: false, phases: ["unavailable", "submitting", "rejected"] },
    },
  },
  {
    name: "the message box gets focus while /history lags",
    scenario: async ({ page, stub, url, take }) => {
      stub.eventsMode = "404";
      stub.historyDelayMs = 2600;
      stub.reply = () => "Late, but there.";
      await ready(page, url);
      await page.click("#draft");
      await page.type("slow one");
      await page.click("#send");
      await page.waitFor(`document.querySelector("#phase").textContent === "running"`, { what: "running to be painted" });
      await page.click("#draft");
      await page.waitFor(`document.querySelector("#phase").textContent === "ready"`, { timeout: 15000, what: "ready" });
      await take("focused");
      await page.waitFor(`document.querySelectorAll("#history li").length === 2`, { timeout: 15000, what: "the history to catch up" });
      await sleep(200);
      await take("caught up");
    },
    double: {
      // The focus handler paints `ready` while the run goes on: the premature ready the Atlas has to cope with.
      focused: { phase: "ready", draft: "", rows: ["slow one"], sendDisabled: false, phases: ["ready", "running", "ready"] },
      "caught up": { phase: "ready", draft: "", rows: ["slow one", "Late, but there."], sendDisabled: false, phases: ["ready", "running", "ready"] },
    },
    real: {
      // Focusing the box paints nothing: `ready` comes with the answer.
      focused: { phase: "ready", draft: "", rows: ["slow one", "Late, but there."], sendDisabled: false, phases: ["ready", "submitting", "running", "ready"] },
      "caught up": { phase: "ready", draft: "", rows: ["slow one", "Late, but there."], sendDisabled: false, phases: ["ready", "submitting", "running", "ready"] },
    },
  },
  twoTurns({ hideNewQuestion: false }),
  twoTurns({ hideNewQuestion: true }),
];

describe("the chat double (the old client) and the working tree's client, in Chrome", { skip: SKIP, timeout: 240000 }, () => {
  before(async () => {
    browser = await launchBrowser(CHROME.path);
  });

  after(async () => {
    if (browser) await browser.close();
  });

  for (const { name, scenario, verify, double: expectedDouble, real: expectedReal } of SCENARIOS) {
    it(name, async () => {
      const { observed: real, historyReads } = await play("real", name, scenario);
      const { observed: double } = await play("double", name, scenario);
      // Sanity: the scenario really happened (a run that did nothing proves nothing).
      assert.ok(Object.keys(real).length >= 2, "the scenario took at least one snapshot");
      assert.ok(real.requests.length >= 1, "the page talked to the stub");
      if (verify) verify(real, historyReads);
      assert.deepEqual(summary(double), expectedDouble, "the double paints what the old client painted");
      assert.deepEqual(summary(real), expectedReal, "the working tree's client paints what it should now");
    });
  }
});
