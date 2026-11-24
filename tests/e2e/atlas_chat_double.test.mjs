/**
 * The test double of the conversation client (tests/fixtures/atlas_chat_double/app.js) and the working
 * tree's own client (site/js/app.js), without a browser.
 *
 * The double is a port of the OLD client. This file used to prove that the two paint the same; it cannot any
 * more, because the working tree's client has been fixed on purpose (F01 to F03). So it plays the same
 * scripted server answers, step by step, against both controllers and states what each one shows after every
 * step: [step, phase, message box, Send disabled, provider fixed]. The `double` rows are what the old client
 * does (the browser suites run on it by default); the `real` rows are what the working tree's client does now.
 * Where they differ the difference is one of the fixes, and the reason is written next to it. Where they agree
 * the scenario says so by giving no `real` rows.
 *
 * The working tree's client is tested on its own, against a fake backend that follows the API contract, in
 * chat_client_*.test.mjs. The fake `healthy()` server below only has what the old scenarios need: no
 * /providers and a status that says nothing, so the working tree's client treats every status as unreadable.
 *
 * Needs a working tree whose own client can follow a stream, fill the history, settle and send the CSRF
 * header (see realChatCapability in atlas_browser_support.mjs); without that the comparison is skipped with
 * the reason printed, and the double's own behaviour is still checked.
 *
 * Not covered here (no document in Node): painting into #phase, #history and #draft, and the stream
 * follow. atlas_browser_double.test.mjs covers those in Chrome.
 *
 * Run: node --test tests/e2e/atlas_chat_double.test.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createController as createDouble } from "../fixtures/atlas_chat_double/app.js";
import { realChatCapability } from "./atlas_browser_support.mjs";

const CAPABILITY = realChatCapability();
const REAL_SKIP = CAPABILITY.ok ? false : `the working tree's own chat client cannot run: ${CAPABILITY.missing.join("; ")}`;
const realModule = CAPABILITY.ok ? await import("../../site/js/app.js") : null;

// ---- a scripted server ------------------------------------------------------------------------

function reply(status, body, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    json: async () => {
      if (body === undefined) throw new SyntaxError("not json");
      return body;
    },
    body: null,
  };
}

/** A Storage stand-in. */
function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
  };
}

const HEADERS_THAT_MATTER = ["accept", "content-type", "x-esp-csrf"];

/**
 * @param {(call: {method: string, path: string, body: object|null}, n: number) => object|Error} script
 *   what the server answers to each request
 */
function recordedFetch(script) {
  const calls = [];
  const ids = new Map();
  const comparable = (value) => {
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) return value;
    if (!ids.has(value)) ids.set(value, `request-id-${ids.size + 1}`);
    return ids.get(value);
  };
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || "GET";
    const headers = {};
    for (const [key, value] of Object.entries(options.headers || {})) headers[key.toLowerCase()] = value;
    const body = options.body ? JSON.parse(options.body) : null;
    const call = {
      method,
      path: String(url).replace(/(client_request_id=)[^&]+/, (_, head) => `${head}<id>`),
      credentials: options.credentials,
      headers: Object.fromEntries(HEADERS_THAT_MATTER.filter((name) => name in headers).map((name) => [name, headers[name]])),
      body: body ? Object.fromEntries(Object.entries(body).map(([key, value]) => [key, comparable(value)])) : null,
    };
    calls.push(call);
    const answer = script({ method, path: String(url).split("?")[0], body }, calls.length);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetchImpl, calls, comparable };
}

/** The usual healthy server, with overrides by path suffix. */
function healthy(overrides = {}) {
  return ({ method, path, body }, n) => {
    for (const [key, answer] of Object.entries(overrides)) {
      const [verb, suffix] = key.split(" ");
      if (verb === method && path.endsWith(suffix)) return typeof answer === "function" ? answer(body, n) : answer;
    }
    if (path.endsWith("/visitor-session")) return reply(200, { subject_id: "s-1", csrf_token: "t-1" });
    if (path.endsWith("/conversations") && method === "POST") return reply(201, { id: "conv-1" });
    if (path.endsWith("/messages")) return reply(200, {}, { "X-ESP-Acceptance": "accepted" });
    if (path.includes("/status")) return reply(200, { state: "idle" });
    if (path.endsWith("/history")) return reply(200, { items: [] });
    return reply(404, {});
  };
}

// ---- running the same steps against a controller ----------------------------------------------

async function run(createController, { script, steps, storageSeed }) {
  const storage = memoryStorage(storageSeed);
  const net = recordedFetch(script);
  const controller = createController({ fetchImpl: net.fetchImpl, storage });
  const view = { phase: "ready", draft: "", sendDisabled: false, providerFixed: false };
  const trace = [];
  const snapshot = (label) => {
    let saved = storage.data.get("esp-client");
    if (saved !== undefined) {
      saved = JSON.parse(saved);
      saved.requestId = net.comparable(saved.requestId);
    }
    trace.push({ label, view: { ...view }, saved: saved ?? null, calls: net.calls.length });
  };
  for (const [label, step] of steps) {
    let failure = null;
    try {
      await step(controller, view, storage);
    } catch (error) {
      failure = `${error && error.name}`;
    }
    snapshot(label);
    trace[trace.length - 1].failure = failure;
  }
  return { trace, calls: net.calls };
}

const boot = ["boot", (c, v) => c.boot(v)];
const send = (text) => [`send ${text}`, (c, v) => c.send(v, text)];
const focus = ["focus", async (c, v) => c.focus(v)];
const reload = ["reload", (c, v) => c.reload(v)];

/** @type {Record<string, {script: Function, steps: Array<[string, Function]>, storageSeed?: object}>} */
const SCENARIOS = {
  "a question is accepted": {
    script: healthy(),
    steps: [boot, focus, send("What is the pot?"), focus, send("a second one while running"), reload],
  },
  "a rate-limited question is refused, kept, and retried with the same request id": {
    script: healthy({
      "POST /messages": (body, n) => (n < 6 ? reply(429, { error: { code: "rate_limited" } }) : reply(200, {}, { "X-ESP-Acceptance": "accepted" })),
    }),
    steps: [boot, send("first try"), focus, send("first try"), reload, send("first try")],
  },
  "a 409 other than submission_unconfirmed and a 503 are refusals": {
    script: healthy({ "POST /messages": reply(409, { error: { code: "run_active" } }) }),
    steps: [boot, send("busy?"), reload],
  },
  "a 503 is a refusal": {
    script: healthy({ "POST /messages": reply(503, { error: { code: "busy" } }) }),
    steps: [boot, send("busy?"), reload],
  },
  "409 submission_unconfirmed means the answer was lost: reconcile": {
    script: healthy({ "POST /messages": reply(409, { error: { code: "submission_unconfirmed" } }) }),
    steps: [boot, send("did it go?"), focus, reload, reload],
  },
  "a lost answer (network error) is reconciled, also after a reload": {
    script: healthy({ "POST /messages": new TypeError("network") }),
    steps: [boot, send("did it go?"), focus, reload],
  },
  "a 200 without the acceptance header counts as lost": {
    script: healthy({ "POST /messages": reply(200, {}) }),
    steps: [boot, send("no header"), reload],
  },
  "any other status makes the chat unavailable for good": {
    script: healthy({ "POST /messages": reply(500, { error: { code: "boom" } }) }),
    steps: [boot, send("boom"), focus, send("again"), reload],
  },
  "a conversation that cannot be opened makes the chat unavailable": {
    script: healthy({ "POST /conversations": reply(500, {}) }),
    steps: [boot, send("hello"), send("hello again")],
  },
  "the session endpoint answers with something that is not JSON": {
    script: healthy({ "POST /visitor-session": reply(502, undefined) }),
    steps: [boot, send("hello")],
  },
  "a saved rejected phase and draft come back": {
    script: healthy(),
    storageSeed: {
      "esp-client": JSON.stringify({ identity: "s-1", provider: "openai", conversationId: "conv-1", draft: "kept text", requestId: "11111111-2222-3333-4444-555555555555", phase: "rejected" }),
    },
    steps: [boot, send("kept text")],
  },
  "a saved pending request id comes back as reconciling": {
    script: healthy(),
    storageSeed: {
      "esp-client": JSON.stringify({ identity: "s-1", provider: "xai", conversationId: "conv-1", draft: "", requestId: "11111111-2222-3333-4444-555555555555", phase: "running" }),
    },
    steps: [boot, focus, reload],
  },
  "a saved running phase without a pending id comes back as ready": {
    script: healthy(),
    storageSeed: { "esp-client": JSON.stringify({ identity: "s-1", provider: "xai", conversationId: "conv-1", draft: "", requestId: null, phase: "running" }) },
    steps: [boot, send("go on")],
  },
};

/**
 * What each client shows after each step: [step, phase, message box, Send disabled, provider fixed].
 * `real` absent: the working tree's client does exactly what the double does.
 * @type {Record<string, {why: string, double: Array<Array<unknown>>, real?: Array<Array<unknown>>}>}
 */
const EXPECTED = {
  "a question is accepted": {
    why: "the pending question survives a reload (the old client forgot it: ready, nothing to check), so it is checked again, never sent again",
    double: [
      ["boot", "ready", "", false, false],
      ["focus", "ready", "", false, false],
      ["send What is the pot?", "running", "", true, true],
      ["focus", "running", "", true, true],
      ["send a second one while running", "running", "", true, true],
      ["reload", "ready", "", false, true],
    ],
    real: [
      ["boot", "ready", "", false, false],
      ["focus", "ready", "", false, false],
      ["send What is the pot?", "running", "", true, true],
      ["focus", "running", "", true, true],
      ["send a second one while running", "running", "", true, true],
      ["reload", "reconciling", "", true, true],
    ],
  },
  "a rate-limited question is refused, kept, and retried with the same request id": {
    why: "a refusal sent nothing, so a refused retry stays a refusal and a reload keeps the text and the refusal; the old client sent the retry without asking again and lost the refusal on a reload",
    double: [
      ["boot", "ready", "", false, false],
      ["send first try", "rejected", "first try", false, true],
      ["focus", "rejected", "first try", false, true],
      ["send first try", "running", "", true, true],
      ["reload", "ready", "", false, true],
      ["send first try", "running", "", true, true],
    ],
    real: [
      ["boot", "ready", "", false, false],
      ["send first try", "rejected", "first try", false, true],
      ["focus", "rejected", "first try", false, true],
      ["send first try", "rejected", "first try", false, true],
      ["reload", "rejected", "first try", false, true],
      ["send first try", "running", "", true, true],
    ],
  },
  "a 409 other than submission_unconfirmed and a 503 are refusals": {
    why: "same view",
    double: [
      ["boot", "ready", "", false, false],
      ["send busy?", "rejected", "busy?", false, true],
      ["reload", "rejected", "busy?", false, true],
    ],
  },
  "a 503 is a refusal": {
    why: "same view",
    double: [
      ["boot", "ready", "", false, false],
      ["send busy?", "rejected", "busy?", false, true],
      ["reload", "rejected", "busy?", false, true],
    ],
  },
  "409 submission_unconfirmed means the answer was lost: reconcile": {
    why: "the pending question is not turned into a draft (it would invite a second send): it is listed as asked, its request is checked",
    double: [
      ["boot", "ready", "", false, false],
      ["send did it go?", "reconciling", "did it go?", true, true],
      ["focus", "reconciling", "did it go?", true, true],
      ["reload", "reconciling", "did it go?", true, true],
      ["reload", "reconciling", "did it go?", true, true],
    ],
    real: [
      ["boot", "ready", "", false, false],
      ["send did it go?", "reconciling", "", true, true],
      ["focus", "reconciling", "", true, true],
      ["reload", "reconciling", "", true, true],
      ["reload", "reconciling", "", true, true],
    ],
  },
  "a lost answer (network error) is reconciled, also after a reload": {
    why: "the pending question is not turned into a draft",
    double: [
      ["boot", "ready", "", false, false],
      ["send did it go?", "reconciling", "did it go?", true, true],
      ["focus", "reconciling", "did it go?", true, true],
      ["reload", "reconciling", "did it go?", true, true],
    ],
    real: [
      ["boot", "ready", "", false, false],
      ["send did it go?", "reconciling", "", true, true],
      ["focus", "reconciling", "", true, true],
      ["reload", "reconciling", "", true, true],
    ],
  },
  "a 200 without the acceptance header counts as lost": {
    why: "the pending question is not turned into a draft",
    double: [
      ["boot", "ready", "", false, false],
      ["send no header", "reconciling", "no header", true, true],
      ["reload", "reconciling", "no header", true, true],
    ],
    real: [
      ["boot", "ready", "", false, false],
      ["send no header", "reconciling", "", true, true],
      ["reload", "reconciling", "", true, true],
    ],
  },
  "any other status makes the chat unavailable for good": {
    why: "a 500 may have reached the service, so it is an unknown outcome that is checked, not a dead end; the old client switched Send off for good",
    double: [
      ["boot", "ready", "", false, false],
      ["send boom", "unavailable", "boom", true, true],
      ["focus", "unavailable", "boom", true, true],
      ["send again", "unavailable", "boom", true, true],
      ["reload", "reconciling", "boom", true, true],
    ],
    real: [
      ["boot", "ready", "", false, false],
      ["send boom", "reconciling", "", true, true],
      ["focus", "reconciling", "", true, true],
      ["send again", "reconciling", "", true, true],
      ["reload", "reconciling", "", true, true],
    ],
  },
  "a conversation that cannot be opened makes the chat unavailable": {
    why: "nothing was sent, so the text goes back in the box and Send stays usable; the old client switched Send off for good",
    double: [
      ["boot", "ready", "", false, false],
      ["send hello", "unavailable", "", true, true],
      ["send hello again", "unavailable", "", true, true],
    ],
    real: [
      ["boot", "ready", "", false, false],
      ["send hello", "rejected", "hello", false, false],
      ["send hello again", "rejected", "hello", false, false],
    ],
  },
  "the session endpoint answers with something that is not JSON": {
    why: "the old client threw out of boot and send (no phase, no message); the working tree's client says it is unavailable and keeps the text",
    double: [
      ["boot", "ready", "", false, false, "SyntaxError"],
      ["send hello", "ready", "", false, false, "SyntaxError"],
    ],
    real: [
      ["boot", "unavailable", "", false, false],
      ["send hello", "rejected", "hello", false, false],
    ],
  },
  "a saved rejected phase and draft come back": {
    why: "same view",
    double: [
      ["boot", "rejected", "kept text", false, true],
      ["send kept text", "running", "", true, true],
    ],
  },
  "a saved pending request id comes back as reconciling": {
    why: "same view",
    double: [
      ["boot", "reconciling", "", true, true],
      ["focus", "reconciling", "", true, true],
      ["reload", "reconciling", "", true, true],
    ],
  },
  "a saved running phase without a pending id comes back as ready": {
    why: "same view",
    double: [
      ["boot", "ready", "", false, true],
      ["send go on", "running", "", true, true],
    ],
  },
};

const viewOf = (trace) => trace.map((step) => [step.label, step.view.phase, step.view.draft, step.view.sendDisabled, step.view.providerFixed, ...(step.failure ? [step.failure] : [])]);

describe("the chat double (the old client) and the working tree's client, controller level", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    const expected = EXPECTED[name];
    it(name, { skip: REAL_SKIP }, async () => {
      assert.ok(expected, `the scenario "${name}" has an expectation`);
      const real = await run(realModule.createController, scenario);
      const double = await run(createDouble, scenario);
      assert.deepEqual(viewOf(double.trace), expected.double, "the double does what the old client did");
      assert.deepEqual(viewOf(real.trace), expected.real || expected.double, `the working tree's client (${expected.why})`);
    });
  }

  it("every scenario has an expectation and every expectation a scenario", () => {
    assert.deepEqual(Object.keys(EXPECTED).sort(), Object.keys(SCENARIOS).sort());
  });

  it("the working tree's client never sends a question twice on its own: one POST per scenario step that sends", { skip: REAL_SKIP }, async () => {
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      const real = await run(realModule.createController, scenario);
      const posts = real.calls.filter((call) => call.method === "POST" && call.path.endsWith("/messages"));
      const sends = scenario.steps.filter(([label]) => label.startsWith("send")).length;
      assert.ok(posts.length <= sends, `${name}: ${posts.length} POSTs for ${sends} sends`);
    }
  });

  it("sends the CSRF token on every POST after the session, and on no GET", async () => {
    const net = recordedFetch(healthy());
    const controller = createDouble({ fetchImpl: net.fetchImpl, storage: memoryStorage() });
    const view = { phase: "ready", draft: "", sendDisabled: false, providerFixed: false };
    await controller.boot(view);
    await controller.send(view, "hello");
    const posts = net.calls.filter((call) => call.method === "POST");
    assert.deepEqual(posts.map((call) => call.path), ["/visitor-session", "/visitor-session", "/conversations", "/conversations/conv-1/messages"]);
    assert.equal(posts[0].headers["x-esp-csrf"], undefined, "no token before the session answered");
    for (const call of posts.slice(1)) assert.equal(call.headers["x-esp-csrf"], "t-1", `${call.path} carries the token`);
    for (const call of net.calls.filter((c) => c.method === "GET")) assert.equal(call.headers["x-esp-csrf"], undefined);
    assert.equal(view.phase, "running");
    assert.equal(view.draft, "", "an accepted question empties the draft");
  });

  it("exposes the methods the tests import", () => {
    const controller = createDouble({ fetchImpl: async () => reply(200, {}), storage: memoryStorage() });
    for (const name of ["boot", "send", "reload", "focus", "stream", "showHistory", "follow"]) {
      assert.equal(typeof controller[name], "function", name);
    }
  });

  it("the working tree's controller keeps those methods and adds the ones the outcome contract needs", { skip: REAL_SKIP }, () => {
    const controller = realModule.createController({ fetchImpl: async () => reply(200, {}), storage: memoryStorage() });
    for (const name of ["boot", "send", "reload", "focus", "stream", "showHistory", "follow", "editDraft", "cancel", "checkStatus", "newConversation", "retryHistory", "selectProvider"]) {
      assert.equal(typeof controller[name], "function", name);
    }
  });

  it("stream() reads data frames, also split across chunks and with CRLF line ends", async () => {
    const controller = createDouble({ fetchImpl: async () => reply(200, {}), storage: memoryStorage() });
    async function* chunks() {
      yield 'data: {"type":"text_delta","te';
      yield 'xt":"Hel"}\r\n\r\ndata: {"type":"text_delta","text":"lo"}\n\n';
      yield new TextEncoder().encode('data: {"type":"done"}\n\n');
    }
    const seen = [];
    for await (const event of controller.stream(chunks())) seen.push(event);
    assert.deepEqual(seen, [{ type: "text_delta", text: "Hel" }, { type: "text_delta", text: "lo" }, { type: "done" }]);
  });
});
