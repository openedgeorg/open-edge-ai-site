/**
 * The test double of the conversation client (tests/fixtures/atlas_chat_double/app.js) against the
 * working tree's own client (site/js/app.js), without a browser.
 *
 * The browser suites run on the double by default so that they pass on a clean checkout. That is
 * only worth anything while the double behaves like the client it stands in for. This file feeds
 * the same scripted server answers to both controllers, step by step, and compares everything a
 * caller can observe: the view after each step, what was kept in sessionStorage, and every request
 * (method, path, the headers that matter, the body, with the random request id made comparable).
 *
 * Needs a working tree whose own client can follow a stream, fill the history, settle and send the
 * CSRF header (see realChatCapability in atlas_browser_support.mjs); without that the comparison
 * is skipped with the reason printed, and the double's own behaviour is still checked.
 *
 * Not covered here (no document in Node): painting into #phase, #history and #draft, and the
 * stream follow. atlas_browser_double.test.mjs covers those in Chrome.
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

describe("the chat double behaves like the working tree's chat client (controller level)", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(name, { skip: REAL_SKIP }, async () => {
      const real = await run(realModule.createController, scenario);
      const double = await run(createDouble, scenario);
      assert.deepEqual(double.trace, real.trace, "the view and the saved state after every step");
      assert.deepEqual(double.calls, real.calls, "every request, in order");
    });
  }

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
