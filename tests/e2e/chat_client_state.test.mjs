/**
 * The conversation client's state: the reducer (site/js/state.js) and what survives in sessionStorage.
 * Pure functions, no network.
 *
 * Run: node --test tests/e2e/chat_client_state.test.mjs
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import {
  BUSY_PHASES,
  initialClientState,
  persistSession,
  reduceClientState,
  restoreSession,
  sendBlocked,
  sessionMemory,
  validId,
  validProvider,
} from "../../site/js/state.js";
import { baselineOf, findAnswer, itemsSince, listsQuestion } from "../../site/js/outcomes.js";
import { makeStorage } from "./chat_client_support.mjs";

beforeEach(() => sessionMemory().clear());

const KEY = "esp-client";

function tracked(extra = {}) {
  return {
    ...initialClientState(),
    provider: "xai",
    conversationId: "conv-1",
    phase: "running",
    requestId: "req-1",
    submitted: "What is the pot?",
    nativeWorkRef: "work-1",
    runId: "run-1",
    baseline: { count: 2, lastKey: "item-2" },
    sentAt: 1000,
    sendDisabled: true,
    ...extra,
  };
}

describe("identifiers", () => {
  test("validId accepts real identifiers and refuses the strings a bad serialisation leaves behind", () => {
    for (const good of ["6f1c3b3e-2a4b-4c55-8d0e-0a1b2c3d4e5f", "conv-1", "subject_1.a:b~c", "x".repeat(200)]) assert.equal(validId(good), good);
    for (const bad of ["undefined", "null", "NaN", "UNDEFINED", "true", "", " ", "a b", "a/b", "../x", "x".repeat(201), null, undefined, 5, {}, [], "a\nb"]) {
      assert.equal(validId(bad), null, `${JSON.stringify(bad)} is not an identity`);
    }
    assert.equal(validProvider("xai"), "xai");
    for (const bad of ["XAI", "gemini", "", null, undefined, 3]) assert.equal(validProvider(bad), null);
  });

  test("the identity action never stores an invented subject", () => {
    let state = initialClientState();
    for (const subjectId of [undefined, null, "undefined", "", 7]) {
      state = reduceClientState(state, { type: "identity", subjectId });
      assert.equal(state.identity, null);
    }
    state = reduceClientState(state, { type: "identity", subjectId: "subject-1" });
    assert.equal(state.identity, "subject-1");
    assert.equal(reduceClientState(state, { type: "identity", subjectId: "subject-2" }).identity, "subject-1", "set once");
  });
});

describe("reducer", () => {
  test("submit moves the text from the draft to the pending question and starts the clock", () => {
    const typed = { ...initialClientState(), draft: "What is the pot?", conversationId: "conv-1", provider: "openai" };
    const next = reduceClientState(typed, { type: "submit", requestId: "req-1", text: "What is the pot?", baseline: { count: 0, lastKey: null }, at: 5000 });
    assert.equal(next.phase, "submitting");
    assert.equal(next.sendDisabled, true);
    assert.equal(next.draft, "");
    assert.equal(next.submitted, "What is the pot?");
    assert.equal(next.requestId, "req-1");
    assert.equal(next.sentAt, 5000);
    assert.deepEqual(next.baseline, { count: 0, lastKey: null });
  });

  test("the draft is editable in every phase and a pending question is never the draft", () => {
    for (const phase of ["submitting", "running", "reconciling", "unresolved", "cancelling"]) {
      const next = reduceClientState(tracked({ phase }), { type: "edit_draft", text: "the next thing" });
      assert.equal(next.draft, "the next thing", phase);
      assert.equal(next.submitted, "What is the pot?", phase);
    }
  });

  test("accepted keeps the correlation: request, run and native work", () => {
    const next = reduceClientState(tracked({ phase: "submitting", runId: null, nativeWorkRef: null }), { type: "accepted", runId: "run-9", nativeWorkRef: "work-9" });
    assert.equal(next.phase, "running");
    assert.equal(next.requestId, "req-1");
    assert.equal(next.runId, "run-9");
    assert.equal(next.nativeWorkRef, "work-9");
    const kept = reduceClientState(tracked({ phase: "submitting" }), { type: "accepted", runId: "undefined", nativeWorkRef: null });
    assert.equal(kept.runId, "run-1", "an invalid id never replaces a known one");
  });

  test("status_checked decides the phase from the outcome, it is not another reconciling", () => {
    const base = tracked({ phase: "reconciling" });
    const phase = (action, from = base) => reduceClientState(from, { type: "status_checked", ...action }).phase;
    assert.equal(phase({ outcome: "running" }), "running");
    assert.equal(phase({ outcome: "accepted" }), "running");
    assert.equal(phase({ outcome: "running", runtimeState: "recovering" }), "recovering");
    assert.equal(phase({ outcome: "submission_unconfirmed" }), "reconciling");
    assert.equal(phase({ outcome: "not_started", resubmissionAllowed: false }), "reconciling");
    assert.equal(phase({ outcome: "failed" }), "failed");
    assert.equal(phase({ outcome: "cancelled" }), "cancelled");
    assert.equal(phase({ outcome: "completed" }), "reconciling", "completion is final only once the answer is in the history");
    assert.equal(phase({ outcome: "running" }, tracked({ phase: "cancelling" })), "cancelling", "a stop in progress stays one");

    const retryable = reduceClientState(base, { type: "status_checked", outcome: "not_started", resubmissionAllowed: true, notice: { kind: "error", text: "never started" } });
    assert.equal(retryable.phase, "failed");
    assert.equal(retryable.resubmission, true);
    assert.equal(retryable.requestId, "req-1", "the request identity is kept for the retry");
    assert.equal(retryable.submitted, "What is the pot?");
    assert.equal(retryable.sendDisabled, false);

    const failed = reduceClientState(base, { type: "status_checked", outcome: "failed", restoreDraft: true });
    assert.equal(failed.requestId, null);
    assert.equal(failed.draft, "What is the pot?");
    assert.equal(failed.sendDisabled, false);
  });

  test("a failure puts the question back only into an empty draft", () => {
    const empty = reduceClientState(tracked(), { type: "failed", restoreDraft: true, notice: { kind: "error", text: "x" } });
    assert.equal(empty.draft, "What is the pot?");
    const typing = reduceClientState(tracked({ draft: "my own words" }), { type: "failed", restoreDraft: true, notice: { kind: "error", text: "x" } });
    assert.equal(typing.draft, "my own words");
    for (const state of [empty, typing]) {
      assert.equal(state.phase, "failed");
      assert.equal(state.requestId, null);
      assert.equal(state.submitted, "");
      assert.equal(state.runId, null);
    }
  });

  test("a clean rejection forgets the request (nothing was sent) and restores the draft", () => {
    const next = reduceClientState(tracked({ phase: "submitting" }), { type: "rejected", notice: { kind: "error", text: "busy" } });
    assert.equal(next.phase, "rejected");
    assert.equal(next.sendDisabled, false);
    assert.equal(next.requestId, null);
    assert.equal(next.draft, "What is the pot?");
    assert.deepEqual(next.notice, { kind: "error", text: "busy" });
  });

  test("cancel_requested needs a known run and a pending question", () => {
    assert.equal(reduceClientState(tracked(), { type: "cancel_requested" }).phase, "cancelling");
    assert.equal(reduceClientState(tracked({ runId: null }), { type: "cancel_requested" }).phase, "running");
    assert.equal(reduceClientState(tracked({ phase: "ready" }), { type: "cancel_requested" }).phase, "ready");
  });

  test("settled ends a pending question only from a pending phase", () => {
    const done = reduceClientState(tracked(), { type: "settled", notice: { kind: "done", text: "ok" } });
    assert.equal(done.phase, "ready");
    assert.equal(done.requestId, null);
    assert.equal(done.submitted, "");
    assert.equal(done.sentAt, null);
    const idle = { ...initialClientState(), draft: "typing" };
    assert.equal(reduceClientState(idle, { type: "settled" }), idle);
  });

  test("new_conversation forgets the conversation and the pending request, and keeps the draft", () => {
    const next = reduceClientState(tracked({ draft: "keep me", identity: "s-1" }), { type: "new_conversation", notice: { kind: "info", text: "new" } });
    assert.equal(next.conversationId, null);
    assert.equal(next.provider, null);
    assert.equal(next.requestId, null);
    assert.equal(next.phase, "ready");
    assert.equal(next.draft, "keep me");
    assert.equal(next.identity, "s-1");
  });

  test("sendBlocked: a pending question and an unresolved one block the composer, a refusal, a failure and a cancellation do not", () => {
    for (const phase of BUSY_PHASES) assert.equal(sendBlocked(phase), true, phase);
    assert.equal(sendBlocked("unresolved"), true);
    for (const phase of ["ready", "rejected", "failed", "cancelled", "unavailable"]) assert.equal(sendBlocked(phase), false, phase);
  });

  test("the legacy actions still do what they did", () => {
    let state = initialClientState();
    state = reduceClientState(state, { type: "choose_provider", provider: "xai" });
    assert.equal(state.provider, "xai");
    assert.equal(reduceClientState(state, { type: "choose_provider", provider: "openai" }).provider, "xai", "the first choice stands");
    assert.equal(reduceClientState({ ...state, phase: "rejected" }, { type: "manual_retry" }).phase, "ready");
    assert.equal(reduceClientState(state, { type: "manual_retry" }), state);
    assert.equal(reduceClientState(state, { type: "focus" }), state);
    assert.equal(reduceClientState(state, { type: "no_such_action" }), state);
  });
});

describe("persistence", () => {
  test("a pending question comes back as a request to re-check, with its whole correlation", () => {
    const storage = makeStorage();
    persistSession(storage, tracked());
    const restored = restoreSession(storage);
    assert.equal(restored.phase, "reconciling");
    assert.equal(restored.sendDisabled, true);
    assert.equal(restored.requestId, "req-1");
    assert.equal(restored.submitted, "What is the pot?");
    assert.equal(restored.conversationId, "conv-1");
    assert.equal(restored.provider, "xai");
    assert.equal(restored.nativeWorkRef, "work-1");
    assert.equal(restored.runId, "run-1");
    assert.deepEqual(restored.baseline, { count: 2, lastKey: "item-2" });
    assert.equal(restored.sentAt, 1000);
  });

  test("every pending phase is re-checked after a reload, never sent again", () => {
    for (const phase of ["submitting", "running", "reconciling", "recovering", "cancelling", "unresolved"]) {
      const storage = makeStorage();
      persistSession(storage, tracked({ phase }));
      assert.equal(restoreSession(storage).phase, "reconciling", phase);
    }
  });

  test("a question the status allowed to resend comes back as that", () => {
    const storage = makeStorage();
    persistSession(storage, tracked({ phase: "failed", resubmission: true, sendDisabled: false, notice: { kind: "error", text: "never started" } }));
    const restored = restoreSession(storage);
    assert.equal(restored.phase, "failed");
    assert.equal(restored.resubmission, true);
    assert.equal(restored.requestId, "req-1");
    assert.deepEqual(restored.notice, { kind: "error", text: "never started" });
  });

  test("outcomes that need no checking survive: a refusal with its draft and its message, a failure, a cancellation", () => {
    for (const phase of ["rejected", "failed", "cancelled", "unavailable"]) {
      const storage = makeStorage();
      persistSession(storage, { ...initialClientState(), phase, draft: "kept", notice: { kind: "error", text: "why" } });
      const restored = restoreSession(storage);
      assert.equal(restored.phase, phase);
      assert.equal(restored.draft, "kept");
      assert.deepEqual(restored.notice, { kind: "error", text: "why" });
      assert.equal(restored.sendDisabled, false);
    }
  });

  test("a phase without a pending question comes back ready, and a stale 'answer is ready' is not repeated", () => {
    const running = makeStorage();
    persistSession(running, { ...initialClientState(), phase: "running", conversationId: "conv-1", provider: "xai" });
    assert.equal(restoreSession(running).phase, "ready");
    const done = makeStorage();
    persistSession(done, { ...initialClientState(), notice: { kind: "done", text: "The answer is ready." } });
    assert.equal(restoreSession(done).notice, null);
  });

  test("a question that never reached a conversation was never sent: it returns to the draft", () => {
    const storage = makeStorage();
    persistSession(storage, { ...initialClientState(), phase: "submitting", requestId: "req-1", submitted: "What is the pot?", conversationId: null });
    const restored = restoreSession(storage);
    assert.equal(restored.phase, "ready");
    assert.equal(restored.requestId, null);
    assert.equal(restored.draft, "What is the pot?");
  });

  test("identifiers that are not identifiers are dropped, never carried or invented", () => {
    const storage = makeStorage({
      seed: {
        [KEY]: JSON.stringify({
          v: 2,
          identity: "undefined",
          provider: "xai",
          conversationId: "undefined",
          requestId: "null",
          draft: "typed",
          phase: "running",
        }),
      },
    });
    const restored = restoreSession(storage);
    assert.equal(restored.identity, null);
    assert.equal(restored.conversationId, null);
    assert.equal(restored.provider, null, "a provider without a conversation is not a conversation");
    assert.equal(restored.requestId, null);
    assert.equal(restored.draft, "typed");
    assert.equal(restored.phase, "ready");
  });

  test("a conversation without a known provider is not kept", () => {
    const storage = makeStorage({ seed: { [KEY]: JSON.stringify({ v: 2, conversationId: "conv-1", provider: "someone-else", phase: "ready" }) } });
    const restored = restoreSession(storage);
    assert.equal(restored.conversationId, null);
    assert.equal(restored.provider, null);
  });

  test("corrupt storage gives a clean start, not a crash", () => {
    for (const raw of ["not json", "{", "null", "[]", "5", '"text"', "", "{\"phase\": 3, \"draft\": 7, \"baseline\": \"x\", \"sentAt\": \"soon\"}"]) {
      const storage = makeStorage({ seed: { [KEY]: raw } });
      const restored = restoreSession(storage);
      assert.equal(restored.phase, "ready", raw);
      assert.equal(restored.conversationId, null, raw);
      assert.equal(restored.requestId, null, raw);
      assert.equal(typeof restored.draft, "string", raw);
    }
  });

  test("a storage that throws on every access falls back to memory for this tab", () => {
    const broken = makeStorage({ fail: true });
    assert.doesNotThrow(() => persistSession(broken, { ...initialClientState(), draft: "kept in memory", conversationId: "conv-1", provider: "xai" }));
    const restored = restoreSession(broken);
    assert.equal(restored.draft, "kept in memory");
    assert.equal(restored.conversationId, "conv-1");
    assert.equal(restoreSession(null).draft, "kept in memory", "no storage at all: the same fallback");
  });

  test("no transcript is ever written: only ids, the pending question and the draft", () => {
    const storage = makeStorage();
    persistSession(storage, tracked({ draft: "typing" }));
    const saved = JSON.parse(storage.data.get(KEY));
    assert.deepEqual(Object.keys(saved).sort(), ["baseline", "conversationId", "draft", "identity", "notice", "nativeWorkRef", "phase", "provider", "requestId", "resubmission", "runId", "sentAt", "submitted", "v"].sort());
    assert.doesNotMatch(storage.data.get(KEY), /undefined/);
  });

  test("malformed baselines and notices from storage are discarded", () => {
    const storage = makeStorage({
      seed: {
        [KEY]: JSON.stringify({
          v: 2,
          conversationId: "conv-1",
          provider: "xai",
          requestId: "req-1",
          submitted: "q",
          baseline: { count: -3, lastKey: 7 },
          notice: { kind: "scary", text: "<b>x</b>" },
          sentAt: "yesterday",
          phase: "running",
        }),
      },
    });
    const restored = restoreSession(storage);
    assert.equal(restored.baseline, null);
    assert.equal(restored.notice, null);
    assert.equal(restored.sentAt, null);
    assert.equal(restored.requestId, "req-1");
  });
});

describe("telling this turn's answer from an older one", () => {
  const item = (key, role, text, extra = {}) => ({ key, role, text, workRef: null, provisional: false, ...extra });
  const OLD = [item("a", "user", "Q1", { workRef: "w1" }), item("b", "assistant", "A1", { workRef: "w1" })];

  test("a baseline is the count and the last key; unknown history gives none", () => {
    assert.deepEqual(baselineOf([]), { count: 0, lastKey: null });
    assert.deepEqual(baselineOf(OLD), { count: 2, lastKey: "b" });
    assert.equal(baselineOf(null), null);
  });

  test("items since the baseline: found by key, by count when the key is gone, all of them for an empty baseline", () => {
    const now = [...OLD, item("c", "user", "Q2"), item("d", "assistant", "A2")];
    assert.deepEqual(itemsSince(now, baselineOf(OLD)).map((entry) => entry.key), ["c", "d"]);
    assert.deepEqual(itemsSince(now, { count: 2, lastKey: "gone" }).map((entry) => entry.key), ["c", "d"]);
    assert.deepEqual(itemsSince(now, { count: 0, lastKey: null }).map((entry) => entry.key), ["a", "b", "c", "d"]);
    assert.deepEqual(itemsSince(OLD, baselineOf(OLD)), []);
  });

  test("without a baseline the newest copy of the question is where the turn starts, and a missing question means nothing is new", () => {
    const now = [...OLD, item("c", "user", " Q1 "), item("d", "assistant", "A1 again")];
    assert.deepEqual(itemsSince(now, null, "Q1").map((entry) => entry.key), ["c", "d"]);
    assert.deepEqual(itemsSince(OLD, null, "Something else"), []);
    assert.deepEqual(itemsSince(OLD, null, ""), []);
  });

  test("only an assistant item after the baseline that is final and has text is an answer", () => {
    const pending = { baseline: baselineOf(OLD), submitted: "Q2", nativeWorkRef: null };
    assert.equal(findAnswer(OLD, pending), null, "the old answer is the last row, and it is not new");
    assert.equal(findAnswer([...OLD, item("c", "user", "Q2")], pending), null);
    assert.equal(findAnswer([...OLD, item("c", "user", "Q2"), item("d", "assistant", "partial", { provisional: true })], pending), null);
    assert.equal(findAnswer([...OLD, item("c", "user", "Q2"), item("d", "assistant", "   ")], pending), null);
    assert.deepEqual(findAnswer([...OLD, item("c", "user", "Q2"), item("d", "assistant", "A2")], pending).map((entry) => entry.text), ["A2"]);
  });

  test("several final rows of one turn are all its answer", () => {
    const pending = { baseline: baselineOf(OLD), submitted: "Q2", nativeWorkRef: null };
    const rows = [...OLD, item("c", "user", "Q2"), item("d", "assistant", "Preamble."), item("e", "assistant", "The answer.")];
    assert.deepEqual(findAnswer(rows, pending).map((entry) => entry.text), ["Preamble.", "The answer."]);
  });

  test("an item of another native work is not this turn's, unless the status itself said completed and nothing carries the reference", () => {
    const pending = { baseline: baselineOf(OLD), submitted: "Q2", nativeWorkRef: "w2" };
    const foreign = [...OLD, item("x", "assistant", "Someone else's", { workRef: "w9" })];
    assert.equal(findAnswer(foreign, pending), null);
    assert.equal(findAnswer(foreign, pending, { authoritative: true }), null, "no question of ours in the list either");
    const named = [...foreign, item("c", "user", "Q2", { workRef: "w2x" }), item("d", "assistant", "A2", { workRef: "w2x" })];
    assert.equal(findAnswer(named, pending), null, "a history that names its works differently is not trusted by a guess");
    assert.deepEqual(findAnswer(named, pending, { authoritative: true }).map((entry) => entry.text), ["A2"], "but the status's completed plus the question's position settle it");
    const ours = [...foreign, item("c", "user", "Q2", { workRef: "w2" }), item("d", "assistant", "A2", { workRef: "w2" })];
    assert.deepEqual(findAnswer(ours, pending).map((entry) => entry.text), ["A2"]);
  });

  test("listsQuestion: the question is listed once a user item with its text is newer than the baseline", () => {
    const pending = { baseline: baselineOf(OLD), submitted: "Q2", nativeWorkRef: null };
    assert.equal(listsQuestion(OLD, pending), false);
    assert.equal(listsQuestion([...OLD, item("c", "user", "Q2")], pending), true);
    assert.equal(listsQuestion([...OLD, item("c", "user", "Q1")], pending), false, "the older copy of a text does not count");
  });
});
