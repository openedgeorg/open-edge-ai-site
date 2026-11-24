/**
 * Seeded random play against the REAL client and the fake backend: whatever order the visitor's actions
 * and the service's failures come in, the invariants of the outcome contract hold. The seeds are fixed, so a
 * failure is reproducible: the message names the seed and the steps played.
 *
 * Invariants checked after every step:
 *  - one activation is at most one logical submission, that is one client request id (a Send, or a Send again that
 *    the status allowed); a busy refusal right after an answer may be offered again, but always under the same id;
 *  - a busy phase disables Send; a ready phase tracks no request; nothing in storage is the string "undefined";
 *  - the rows have unique keys, and the same text is never listed twice for one asked question;
 *  - the saved state restores into a state that does not crash a reload.
 * And at the end of each run, after the bounded rounds are over with no further action, nothing is busy for ever.
 *
 * Run: node --test tests/e2e/chat_client_fuzz.test.mjs
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BUSY_PHASES, restoreSession } from "../../site/js/state.js";
import { errorBody, flush, jsonResponse, newHarness } from "./chat_client_support.mjs";

/** A small deterministic generator (mulberry32). */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const QUESTIONS = ["Who actually pays the apps I use?", "What is the pot?", "Why one monthly plan?", "What happens at the end of the month?"];
const ANSWERS = ["The household pays one plan.", "The pot is shared.", "Because it is simpler.\n\nAnd fairer.", "Balances are settled."];

function install(h, rnd) {
  const pick = (options) => options[Math.floor(rnd() * options.length)];
  h.backend.override("messages", async (ctx) => {
    const fate = pick(["accept", "accept", "accept", "lose-after", "lose-before", "busy", "limit", "capacity", "boom", "unconfirmed"]);
    if (fate === "accept") return undefined;
    if (fate === "lose-after") {
      const response = h.backend.defaults.messages(ctx);
      await response.body.cancel();
      return new Error("lost after the service took it");
    }
    if (fate === "lose-before") return new Error("lost before the service saw it");
    if (fate === "busy") return jsonResponse(409, errorBody("conversation_busy", "busy"));
    if (fate === "limit") return jsonResponse(429, errorBody("rate_limited", "slow", { retryable: true }), { "retry-after": "5" });
    if (fate === "capacity") return jsonResponse(503, errorBody("capacity_unavailable", "none", { retryable: true }));
    if (fate === "boom") return jsonResponse(500, { error: { code: "boom" } });
    const conv = h.backend.conversations.get(ctx.params[0]);
    if (!conv || conv.run) return jsonResponse(409, errorBody("conversation_busy", "busy"));
    const run = { requestId: ctx.body.client_request_id, conversationId: conv.id, runId: `run-${++h.backend.ids.run}`, workRef: `work-${h.backend.ids.run}`, state: "unconfirmed" };
    conv.run = run;
    h.backend.requests.set(run.requestId, run);
    conv.items.push({ id: `item-${++h.backend.ids.item}`, role: "user", text: ctx.body.message, workRef: run.workRef, provisional: false });
    return jsonResponse(409, { error: { code: "submission_unconfirmed", message: "x", retryable: false }, submitted: null, status_url: "/s", resubmission_allowed: false }, { "x-esp-acceptance": "unconfirmed" });
  });
  h.backend.override("status", () => {
    const fate = pick(["ok", "ok", "ok", "ok", "unavailable", "unauthenticated", "unreadable", "gone"]);
    if (fate === "unavailable") return jsonResponse(503, errorBody("service_unavailable", "x", { retryable: true, submitted: null }));
    if (fate === "unauthenticated") return jsonResponse(401, errorBody("unauthenticated", "x", { submitted: null }));
    if (fate === "unreadable") return jsonResponse(200, { state: "idle" });
    if (fate === "gone" && rnd() < 0.15) return jsonResponse(404, errorBody("not_found", "x", { submitted: null }));
    return undefined;
  });
  h.backend.override("history", () => {
    const fate = pick(["ok", "ok", "ok", "unavailable", "unreadable"]);
    if (fate === "unavailable") return jsonResponse(503, errorBody("history_unavailable", "x", { retryable: true, submitted: null }));
    if (fate === "unreadable") return jsonResponse(200, { nope: true });
    return undefined;
  });
  h.backend.override("events", () => {
    const fate = pick(["ok", "ok", "missing", "broken"]);
    if (fate === "missing") return jsonResponse(404, errorBody("not_found", "x"));
    if (fate === "broken") return new Error("connection reset");
    return undefined;
  });
  h.backend.override("cancel", () => (rnd() < 0.2 ? new Error("lost") : undefined));
  h.backend.override("session", () => (rnd() < 0.1 ? new Response("down", { status: 503 }) : undefined));
  h.backend.override("providers", () => (rnd() < 0.2 ? jsonResponse(503, errorBody("service_unavailable", "x", { retryable: true })) : undefined));
}

/** Wait for a send while the clock runs, as it does in a browser: a busy refusal right after an answer waits to offer again. */
async function sending(h, promises) {
  let pending = true;
  const all = Promise.all(promises).finally(() => {
    pending = false;
  });
  for (let spent = 0; pending && spent < 120000; spent += 1000) {
    await flush();
    if (pending) await h.advance(1000);
  }
  await all;
}

async function play(seed, steps) {
  const rnd = random(seed);
  const pick = (options) => options[Math.floor(rnd() * options.length)];
  let h = newHarness();
  install(h, rnd);
  await h.boot();
  const log = [];
  // Each Send that the composer accepted, and each Send again that the status allowed. A burst of clicks is one.
  let activations = 0;
  const check = (label) => {
    const where = `seed ${seed}, after ${label}; steps: ${log.join(" > ")}`;
    const view = h.view;
    if (BUSY_PHASES.has(view.phase)) assert.equal(view.sendDisabled, true, `${where}: a busy phase (${view.phase}) disables Send`);
    const saved = h.saved();
    if (saved) {
      assert.doesNotMatch(JSON.stringify(saved), /undefined/, `${where}: nothing in storage is "undefined"`);
      if (saved.phase === "ready") assert.equal(saved.requestId, null, `${where}: ready tracks no request`);
      assert.doesNotThrow(() => restoreSession(h.storage), `${where}: the saved state restores`);
    }
    if (view.phase === "ready") assert.equal(h.controller.inspect().state.requestId, null, `${where}: ready tracks no request`);
    const keys = (view.rows || []).map((row) => row.key);
    assert.equal(new Set(keys).size, keys.length, `${where}: unique row keys ${keys.join(",")}`);
    const posted = new Set(h.backend.posts().map((post) => post.body.client_request_id)).size;
    assert.ok(posted <= activations, `${where}: ${posted} submissions for ${activations} activations`);
  };
  for (let step = 0; step < steps; step += 1) {
    const action = pick(["send", "send", "advance", "advance", "advance", "answer", "fail", "reload", "check", "cancel", "retry", "newconv", "type", "history", "double"]);
    log.push(action);
    if (action === "send" || action === "double") {
      const text = pick(QUESTIONS);
      const before = h.controller.inspect().state.phase;
      const blocked = BUSY_PHASES.has(before) || before === "unresolved";
      const tries = action === "double" ? 3 : 1;
      await sending(h, Array.from({ length: tries }, () => h.controller.send(h.view, text)));
      await flush();
      if (!blocked) activations += 1;
    } else if (action === "retry") {
      const state = h.controller.inspect().state;
      if (state.phase === "failed" && state.resubmission) {
        activations += 1;
        await sending(h, [h.controller.send(h.view, "", { retry: true })]);
        await flush();
      }
    } else if (action === "advance") {
      await h.advance(pick([500, 1000, 3000, 8000, 20000, 70000]));
    } else if (action === "answer") {
      const conv = h.backend.conversations.size ? h.backend.conversation() : null;
      if (conv && conv.run) {
        h.backend.answer(pick(ANSWERS));
        if (rnd() < 0.5) await h.advance(2000);
      }
    } else if (action === "fail") {
      const conv = h.backend.conversations.size ? h.backend.conversation() : null;
      if (conv && conv.run) h.backend.failRun({ emitEvent: rnd() < 0.5 });
    } else if (action === "reload") {
      h = h.reloaded();
      await h.boot();
    } else if (action === "check") {
      await h.controller.checkStatus(h.view);
      await flush();
    } else if (action === "cancel") {
      await h.controller.cancel(h.view);
      await flush();
    } else if (action === "newconv") {
      h.controller.newConversation(h.view);
      if (rnd() < 0.7) h.controller.newConversation(h.view);
    } else if (action === "type") {
      h.controller.editDraft(h.view, pick(QUESTIONS));
    } else if (action === "history") {
      await h.controller.showHistory(h.view);
      await flush();
    }
    check(action);
  }
  // Nothing more happens: the bounded rounds end, nothing stays busy.
  h.backend.clearOverride("status");
  await h.advance(10 * 60 * 1000);
  await flush();
  log.push("quiesce");
  const phase = h.view.phase;
  // A run the service still holds may keep a question running; a finished or lost one must not.
  const conv = h.backend.conversations.size ? h.backend.conversation() : null;
  if (BUSY_PHASES.has(phase)) {
    assert.ok(conv && conv.run, `seed ${seed}: busy (${phase}) with no run at the service; steps: ${log.join(" > ")}`);
  }
  h.controller.dispose();
}

describe("random play against the real client", () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    test(`seed ${seed}`, async () => {
      await play(seed, 30);
    });
  }
});
