/**
 * Support code for the deterministic conversation-client tests (tests/e2e/chat_client_*.test.mjs; not a
 * test file itself).
 *
 * The REAL client runs here: site/js/app.js with api.js, state.js, sse.js and outcomes.js, unchanged.
 * Only the network is replaced, by `createBackend`: a small model of the conversation API that follows
 * the contract of apps/api (visitor session without a subject id, providers, conversations, messages with
 * X-ESP-Acceptance and a first server-sent frame, status as a SubmissionView, history items with native
 * ids and a status block, a snapshot event stream, cancel). Every failure the client has to survive is an
 * override of one route. Time is a manual clock: nothing here sleeps or races.
 */

import { createController } from "../../site/js/app.js";
import { sessionMemory } from "../../site/js/state.js";

export const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

export function makeClock(start = 1_700_000_000_000) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  const clock = {
    now: () => current,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: current + Math.max(0, ms) });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    /** Move the clock forward, running every timer on the way in order, letting async work settle between them. */
    async advance(ms) {
      const target = current + ms;
      await flush();
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        current = Math.max(current, due[1].at);
        due[1].fn();
        await flush();
      }
      current = target;
      await flush();
    },
  };
  return clock;
}

/** A sessionStorage stand-in. `fail`: every access throws (storage disabled). */
export function makeStorage({ seed = {}, fail = false } = {}) {
  const data = new Map(Object.entries(seed));
  const guard = () => {
    if (fail) throw new Error("SecurityError: storage is disabled");
  };
  return {
    data,
    getItem(key) {
      guard();
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      guard();
      data.set(key, String(value));
    },
    removeItem(key) {
      guard();
      data.delete(key);
    },
  };
}

export function makeView() {
  return { phase: "", draft: "", sendDisabled: false, providerFixed: false, changes: 0 };
}

/* ---------------- the fake backend ---------------- */

const encoder = new TextEncoder();

export function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function sseResponse(frames, { headers = {}, status = 200 } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(typeof frame === "string" ? encoder.encode(frame) : frame);
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream", ...headers } });
}

/** A stream that delivers `frames`, then stays open until `release()` (or errors with `fail()`). */
export function heldStream(frames) {
  let controllerRef = null;
  const body = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push: (frame) => controllerRef.enqueue(encoder.encode(frame)),
    release: () => controllerRef.close(),
    fail: (error = new Error("connection reset")) => controllerRef.error(error),
  };
}

export function frame(envelope) {
  return `event: ${envelope.event.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

export function errorBody(code, message, { retryable = false, submitted = false } = {}) {
  return { error: { code, message, retryable }, submitted };
}

const ROUTES = [
  ["session", "POST", /^\/visitor-session$/],
  ["providers", "GET", /^\/providers$/],
  ["create", "POST", /^\/conversations$/],
  ["messages", "POST", /^\/conversations\/([^/]+)\/messages$/],
  ["status", "GET", /^\/conversations\/([^/]+)\/status$/],
  ["history", "GET", /^\/conversations\/([^/]+)\/history$/],
  ["events", "GET", /^\/conversations\/([^/]+)\/events$/],
  ["cancel", "POST", /^\/conversations\/([^/]+)\/runs\/([^/]+)\/cancel$/],
];

export function createBackend() {
  const backend = {
    calls: [],
    csrf: "csrf-token-1",
    /** The real /visitor-session names no subject; set a string to test the other shape. */
    subjectId: undefined,
    providers: [
      { provider: "openai", harness: "codex", display_model: "model-a", eligible: true, available: true },
      { provider: "xai", harness: "grok-build", display_model: "model-b", eligible: true, available: true },
    ],
    conversations: new Map(),
    requests: new Map(),
    overrides: new Map(),
    counts: new Map(),
    ids: { conversation: 0, run: 0, item: 0, connection: 0 },
    /** What cancel does: "stops" (confirmed), "unconfirmed" (accepted, still running) or "fails" (500). */
    cancelBehavior: "stops",

    /** Replace one route. `fn(ctx)` returns a Response, an Error to throw, or undefined to fall through to the default. */
    override(route, fn) {
      backend.overrides.set(route, fn);
      return backend;
    },
    clearOverride(route) {
      backend.overrides.delete(route);
    },
    callsTo(route) {
      return backend.calls.filter((call) => call.route === route);
    },
    posts() {
      return backend.callsTo("messages");
    },
    conversation(id) {
      return backend.conversations.get(id) || [...backend.conversations.values()].at(-1);
    },

    /** The assistant's answer arrives: the run completes, history gets the item, the stream gets deltas and done. */
    answer(text, { conversation = null, chunks = null } = {}) {
      const conv = conversation || backend.conversation();
      const run = conv.run;
      const workRef = run ? run.workRef : "work-x";
      conv.items.push({ id: `item-${++backend.ids.item}`, role: "assistant", text, workRef, provisional: false });
      for (const piece of chunks || [text]) conv.queue.push({ type: "text_delta", text: piece, workRef });
      conv.queue.push({ type: "done", nativeWorkRef: workRef, workRef });
      if (run) {
        run.state = "completed";
        conv.run = null;
      }
    },
    /** Output grows: provisional history item and queued deltas, the run is still open. */
    partial(text, { conversation = null } = {}) {
      const conv = conversation || backend.conversation();
      conv.queue.push({ type: "text_delta", text, workRef: conv.run.workRef });
      conv.run.partial = (conv.run.partial || "") + text;
    },
    failRun({ conversation = null, message = "The model failed", emitEvent = true } = {}) {
      const conv = conversation || backend.conversation();
      const run = conv.run;
      if (emitEvent) conv.queue.push({ type: "error", code: "run_failed", message, retryable: false, workRef: run.workRef });
      run.state = "failed";
      conv.run = null;
    },
    /** The run is gone from the service's point of view without an answer (a status of unconfirmed). */
    unconfirm(requestId) {
      backend.requests.get(requestId).state = "unconfirmed";
    },
  };

  function envelope(conv, run, event, sequence, connection) {
    return {
      protocol_version: 1,
      conversation_id: conv.id,
      provider_session_id: "provider-session-1",
      activeAgentRunId: run ? run.runId : "run-none",
      nativeWorkRef: event.workRef || (run ? run.workRef : null),
      connection_id: connection,
      sequence,
      event: Object.fromEntries(Object.entries(event).filter(([key]) => key !== "workRef")),
    };
  }

  function view(conv, run, outcome, extra = {}) {
    return {
      outcome,
      active_agent_run_id: conv.run && conv.run === run ? run.runId : null,
      native_work_ref: run ? run.workRef : null,
      resubmission_allowed: false,
      runtime_state: conv.run && conv.run === run ? "running" : "warm_idle",
      ...extra,
    };
  }

  function historyBody(conv) {
    const run = conv.run;
    const last = [...backend.requests.values()].filter((r) => r.conversationId === conv.id).at(-1);
    const items = conv.items.map((item) => ({
      native_item_id: item.id,
      native_work_ref: item.workRef,
      role: item.role,
      text: item.text,
      citations: [],
      assets: [],
      structured_data: [],
      provisional: item.provisional,
    }));
    if (run && run.partial) {
      items.push({
        native_item_id: `partial-${run.runId}`,
        native_work_ref: run.workRef,
        role: "assistant",
        text: run.partial,
        citations: [],
        assets: [],
        structured_data: [],
        provisional: true,
      });
    }
    const status = last
      ? {
          status: last.state === "completed" ? "completed" : last.state === "failed" ? "failed" : last.state === "cancelled" ? "interrupted" : "running",
          native_work_ref: last.workRef,
          request_id: last.requestId,
          saved_input_available: true,
        }
      : { status: "idle", native_work_ref: null, request_id: null, saved_input_available: false };
    return { items, native_cursor: null, status, provenance: [] };
  }

  const defaults = {
    session() {
      return jsonResponse(200, { csrf_token: backend.csrf, ...(backend.subjectId ? { subject_id: backend.subjectId } : {}) });
    },
    providers() {
      return jsonResponse(200, { providers: backend.providers });
    },
    create(ctx) {
      if (ctx.headers["x-esp-csrf"] !== backend.csrf) return jsonResponse(403, errorBody("csrf_rejected", "The request is missing a valid CSRF token."));
      const option = backend.providers.find((entry) => entry.provider === ctx.body.provider);
      if (!option || !option.eligible || !option.available) {
        return jsonResponse(503, errorBody("provider_not_eligible", "This provider cannot start a new conversation right now."));
      }
      const id = `conv-${++backend.ids.conversation}`;
      const conv = { id, provider: ctx.body.provider, items: [], run: null, queue: [] };
      backend.conversations.set(id, conv);
      return jsonResponse(201, { id, provider: conv.provider, harness: option.harness, status: "active", runtime_state: null, active_agent_run_id: null });
    },
    messages(ctx) {
      if (ctx.headers["x-esp-csrf"] !== backend.csrf) return jsonResponse(403, errorBody("csrf_rejected", "The request is missing a valid CSRF token."));
      const conv = backend.conversations.get(ctx.params[0]);
      if (!conv) return jsonResponse(404, errorBody("not_found", "No such conversation."));
      const body = ctx.body;
      const known = backend.requests.get(body.client_request_id);
      if (known && conv.run === known) {
        return jsonResponse(200, view(conv, known, "running"), { "x-esp-acceptance": "duplicate" });
      }
      if (conv.run) return jsonResponse(409, errorBody("conversation_busy", "This conversation is still working on another message. Your message was not sent."));
      const run = { requestId: body.client_request_id, conversationId: conv.id, runId: `run-${++backend.ids.run}`, workRef: `work-${backend.ids.run}`, state: "running", question: body.message };
      conv.run = run;
      backend.requests.set(run.requestId, run);
      conv.items.push({ id: `item-${++backend.ids.item}`, role: "user", text: body.message, workRef: run.workRef, provisional: false });
      const first = envelope(conv, run, { type: "session_status", status: "running" }, 1, `accept-${++backend.ids.connection}`);
      return sseResponse([frame(first)], { headers: { "x-esp-acceptance": "accepted" } });
    },
    status(ctx) {
      const conv = backend.conversations.get(ctx.params[0]);
      if (!conv) return jsonResponse(404, errorBody("not_found", "No such conversation.", { submitted: null }));
      const run = backend.requests.get(ctx.query.get("client_request_id"));
      if (!run || run.conversationId !== conv.id) {
        return jsonResponse(200, { outcome: "not_started", active_agent_run_id: null, native_work_ref: null, resubmission_allowed: true, runtime_state: "warm_idle" });
      }
      const outcome = { running: "running", completed: "completed", failed: "failed", cancelled: "cancelled", unconfirmed: "submission_unconfirmed", accepted: "accepted" }[run.state];
      return jsonResponse(200, view(conv, run, outcome));
    },
    history(ctx) {
      const conv = backend.conversations.get(ctx.params[0]);
      if (!conv) return jsonResponse(404, errorBody("not_found", "No such conversation.", { submitted: null }));
      return jsonResponse(200, historyBody(conv));
    },
    events(ctx) {
      const conv = backend.conversations.get(ctx.params[0]);
      if (!conv) return jsonResponse(404, errorBody("not_found", "No such conversation."));
      const frames = [];
      const connection = `events-${++backend.ids.connection}`;
      let sequence = 1;
      const run = conv.run;
      if (run) frames.push(frame(envelope(conv, run, { type: "session_status", status: "running" }, sequence++, connection)));
      // Like the service: with no current run nothing is published, and an event of another work is dropped.
      for (const event of conv.queue.splice(0)) {
        if (run && event.workRef === run.workRef) frames.push(frame(envelope(conv, run, event, sequence++, connection)));
      }
      return sseResponse(frames);
    },
    cancel(ctx) {
      const conv = backend.conversations.get(ctx.params[0]);
      if (!conv) return jsonResponse(404, errorBody("not_found", "No such conversation."));
      const run = conv.run;
      if (!run || run.runId !== ctx.params[1]) return jsonResponse(200, view(conv, run, "accepted"));
      if (backend.cancelBehavior === "fails") return jsonResponse(500, errorBody("cancel_failed", "Cancel failed.", { submitted: null }));
      if (backend.cancelBehavior === "unconfirmed") return jsonResponse(200, view(conv, run, "running", { runtime_state: "cancelling" }));
      run.state = "cancelled";
      conv.run = null;
      return jsonResponse(200, view(conv, run, "cancelled", { active_agent_run_id: null }));
    },
  };

  backend.defaults = defaults;

  backend.fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input), "http://backend.test");
    const method = init.method || "GET";
    let hit = null;
    for (const [route, verb, pattern] of ROUTES) {
      const match = pattern.exec(url.pathname);
      if (verb === method && match) {
        hit = { route, params: match.slice(1).map(decodeURIComponent) };
        break;
      }
    }
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { route: hit ? hit.route : "unknown", method, path: url.pathname, query: url.searchParams, body, headers, signal: init.signal || null };
    backend.calls.push(call);
    if (!hit) return jsonResponse(404, { error: { code: "no_route" } });
    const n = (backend.counts.get(hit.route) || 0) + 1;
    backend.counts.set(hit.route, n);
    const ctx = { ...call, params: hit.params, n, backend };
    const override = backend.overrides.get(hit.route);
    if (override) {
      const answer = await override(ctx);
      if (answer instanceof Error) throw answer;
      if (answer !== undefined) return answer;
    }
    return defaults[hit.route](ctx);
  };

  return backend;
}

/* ---------------- the harness ---------------- */

export function newHarness({ storage = makeStorage(), timing = {}, backend = createBackend(), clock = makeClock(), keepMemory = false } = {}) {
  if (!keepMemory) sessionMemory().clear();
  let counter = 0;
  const view = makeView();
  view.onChange = () => {
    view.changes += 1;
  };
  const controller = createController({
    fetchImpl: backend.fetchImpl,
    storage,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    timing,
    newId: () => `req-${++counter}`,
  });
  const harness = {
    backend,
    clock,
    storage,
    view,
    controller,
    saved: () => JSON.parse(storage.data.get("esp-client") || "null"),
    statusText: () => (view.status ? view.status.text : ""),
    rows: () => (view.rows || []).map((row) => `${row.role}: ${row.text}`),
    async boot() {
      await controller.boot(view);
      await flush();
    },
    async send(text, options) {
      const result = await controller.send(view, text, options);
      await flush();
      return result;
    },
    async advance(ms) {
      await clock.advance(ms);
    },
    /** Run the clock until the controller has nothing left to wait for (bounded). */
    async quiesce(limitMs = 600000) {
      let spent = 0;
      while (spent < limitMs && (controller.activity().loop || controller.activity().streaming || controller.activity().sending)) {
        await clock.advance(1000);
        spent += 1000;
      }
      await flush();
    },
    /** A fresh controller on the same storage and backend, like a reload of the tab. */
    reloaded({ storage: nextStorage = storage, timing: nextTiming = timing } = {}) {
      controller.dispose();
      // A reload of the same tab keeps what the tab keeps (its storage, or the fallback memory).
      return newHarness({ storage: nextStorage, timing: nextTiming, backend, clock, keepMemory: true });
    },
  };
  return harness;
}

export const ANSWER_ONE = "The household pays one monthly plan.\n\nThe pot is shared.";
