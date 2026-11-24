/**
 * The conversation outcome contract, row by row, against the REAL client (site/js/app.js, api.js,
 * state.js, sse.js, outcomes.js) and a fake backend that follows the API contract. Time is a manual
 * clock, so every wait is exact. A question is never sent twice in any of these: the number of
 * POST /messages is asserted wherever it matters.
 *
 * Run: node --test tests/e2e/chat_client_outcomes.test.mjs
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TIMEOUTS } from "../../site/js/api.js";

import {
  ANSWER_ONE,
  errorBody,
  flush,
  frame,
  heldStream,
  jsonResponse,
  newHarness,
} from "./chat_client_support.mjs";

const QUESTION = "Who actually pays the apps I use?";

/** The service takes the question; the response is lost on the way back. */
function loseResponseAfterAccepting(h) {
  h.backend.override("messages", async (ctx) => {
    const response = h.backend.defaults.messages(ctx);
    await response.body.cancel();
    return new Error("network lost");
  });
}

/** The service holds the question but cannot prove it: 409 submission_unconfirmed, and a status that stays unconfirmed. */
function unconfirmedAcceptance(h) {
  h.backend.override("messages", (ctx) => {
    const conv = h.backend.conversations.get(ctx.params[0]);
    const requestId = ctx.body.client_request_id;
    const run = { requestId, conversationId: conv.id, runId: "run-1", workRef: "work-1", state: "unconfirmed" };
    conv.run = run;
    conv.items.push({ id: `item-${++h.backend.ids.item}`, role: "user", text: ctx.body.message, workRef: "work-1", provisional: false });
    h.backend.requests.set(requestId, run);
    return jsonResponse(
      409,
      { error: { code: "submission_unconfirmed", message: "Your message may have been received. Check its status before sending it again.", retryable: false }, submitted: null, status_url: `/conversations/${conv.id}/status?client_request_id=${requestId}`, resubmission_allowed: false },
      { "x-esp-acceptance": "unconfirmed" },
    );
  });
}

/** Like unconfirmedAcceptance, but the history does not list the question: nothing proves it arrived. */
function unconfirmedAndUnseen(h) {
  h.backend.override("messages", (ctx) => {
    const requestId = ctx.body.client_request_id;
    const run = { requestId, conversationId: ctx.params[0], runId: "run-1", workRef: "work-1", state: "unconfirmed" };
    h.backend.conversations.get(ctx.params[0]).run = run;
    h.backend.requests.set(requestId, run);
    return jsonResponse(
      409,
      { error: { code: "submission_unconfirmed", message: "Your message may have been received. Check its status before sending it again.", retryable: false }, submitted: null },
      { "x-esp-acceptance": "unconfirmed" },
    );
  });
}

/** The view right after a send was started but before the network answered. */
async function sendWithoutWaiting(h, text) {
  const pending = h.controller.send(h.view, text);
  const snapshot = { phase: h.view.phase, sendDisabled: h.view.sendDisabled, rows: h.rows(), status: h.statusText(), draft: h.view.draft };
  await pending;
  await flush();
  return snapshot;
}

describe("outcome table: no active request, submitting, accepted", () => {
  test("no active request: the composer is usable and says nothing", async () => {
    const h = newHarness();
    await h.boot();
    assert.equal(h.view.phase, "ready");
    assert.equal(h.view.sendDisabled, false);
    assert.equal(h.statusText(), "");
    assert.deepEqual(h.view.actions, {
      cancel: false,
      cancelDisabled: false,
      checkStatus: false,
      retry: false,
      newConversation: false,
      newConversationLabel: "New conversation",
    });
  });

  test("submitting: the activation is acknowledged synchronously, with the question visible and a second submit refused", async () => {
    const h = newHarness();
    await h.boot();
    h.controller.editDraft(h.view, QUESTION);
    const snapshot = await sendWithoutWaiting(h, QUESTION);
    assert.equal(snapshot.phase, "submitting");
    assert.equal(snapshot.sendDisabled, true);
    assert.deepEqual(snapshot.rows, [`user: ${QUESTION}`]);
    assert.match(snapshot.status, /^Sending your question/);
    assert.equal(snapshot.draft, "", "the sent text left the draft");
    assert.equal(h.backend.posts().length, 1);
  });

  test("one activation is one logical submission: rapid clicks and a re-delivered submit add no POST and no row", async () => {
    const h = newHarness();
    await h.boot();
    h.controller.editDraft(h.view, QUESTION);
    const results = await Promise.all([
      h.controller.send(h.view, QUESTION),
      h.controller.send(h.view, QUESTION),
      h.controller.send(h.view, QUESTION),
    ]);
    await flush();
    assert.deepEqual(results.map((result) => result.sent), [true, false, false]);
    assert.equal(h.backend.posts().length, 1);
    assert.equal(h.backend.callsTo("create").length, 1);
    assert.deepEqual(h.rows(), [`user: ${QUESTION}`]);
    await h.controller.send(h.view, QUESTION);
    assert.equal(h.backend.posts().length, 1, "a send while the answer is pending is refused");
  });

  test("accepted: the AI is preparing this answer; Cancel is offered because the run is known", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(QUESTION);
    assert.equal(h.view.phase, "running");
    assert.equal(h.view.sendDisabled, true);
    assert.match(h.statusText(), /^Your question was received\. The answer is being prepared\./);
    assert.equal(h.view.actions.cancel, true, "the first frame of the accepted response named the run");
    assert.equal(h.saved().runId, "run-1");
    assert.equal(h.saved().nativeWorkRef, "work-1");
    assert.equal(h.saved().requestId, "req-1");
  });

  test("a still-working message at 15 seconds and a long-wait state at 60 seconds, neither resends", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(QUESTION);
    await h.advance(14000);
    assert.doesNotMatch(h.statusText(), /Still working/);
    assert.equal(h.view.actions.checkStatus, false);
    await h.advance(1500);
    assert.match(h.statusText(), /^Still working on your answer\./);
    assert.equal(h.view.status.kind, "waiting");
    assert.equal(h.view.actions.checkStatus, true);
    await h.advance(45000);
    assert.match(h.statusText(), /^This is taking longer than usual\. You can keep waiting, check the status, or start a new conversation\./);
    assert.equal(h.view.status.kind, "long");
    assert.deepEqual(
      [h.view.actions.cancel, h.view.actions.checkStatus, h.view.actions.newConversation, h.view.actions.retry],
      [true, true, true, false],
    );
    assert.equal(h.view.phase, "running", "the UI wait threshold manufactures no failure");
    assert.equal(h.backend.posts().length, 1);
  });

  test("completed: the final answer is rendered once, the status says so, the composer is free again", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(QUESTION);
    h.backend.answer(ANSWER_ONE);
    await h.advance(2000);
    assert.equal(h.view.phase, "ready");
    assert.equal(h.view.sendDisabled, false);
    assert.deepEqual(h.rows(), [`user: ${QUESTION}`, `assistant: ${ANSWER_ONE}`]);
    assert.equal(h.statusText(), "The answer is ready.");
    assert.equal(h.saved().requestId, null);
    assert.equal(h.backend.posts().length, 1);
    assert.equal(h.controller.activity().loop, false);
  });

  test("an answer that streams in is shown while it grows, then replaced by the history's final text", async () => {
    const h = newHarness();
    await h.boot();
    const stream = heldStream([]);
    h.backend.override("events", () => stream.response);
    await h.send(QUESTION);
    stream.push(frame({ protocol_version: 1, conversation_id: "conv-1", provider_session_id: "p", activeAgentRunId: "run-1", nativeWorkRef: "work-1", connection_id: "c", sequence: 1, event: { type: "text_delta", text: "The house" } }));
    await flush();
    stream.push(frame({ protocol_version: 1, conversation_id: "conv-1", provider_session_id: "p", activeAgentRunId: "run-1", nativeWorkRef: "work-1", connection_id: "c", sequence: 2, event: { type: "text_delta", text: "hold pays." } }));
    await flush();
    assert.deepEqual(h.rows(), [`user: ${QUESTION}`, "assistant: The household pays."]);
    assert.equal(h.view.phase, "running");
    h.backend.answer("The household pays.");
    stream.push(frame({ protocol_version: 1, conversation_id: "conv-1", provider_session_id: "p", activeAgentRunId: "run-1", nativeWorkRef: "work-1", connection_id: "c", sequence: 3, event: { type: "done", nativeWorkRef: "work-1" } }));
    stream.release();
    await h.advance(1000);
    assert.equal(h.view.phase, "ready");
    assert.deepEqual(h.rows(), [`user: ${QUESTION}`, "assistant: The household pays."]);
    assert.equal(h.view.rows.filter((row) => row.role === "assistant").length, 1);
  });
});

describe("outcome table: acceptance uncertain", () => {
  test("a lost response: the question is tracked with the same request id and never sent again", async () => {
    const h = newHarness();
    await h.boot();
    loseResponseAfterAccepting(h);
    const result = await h.send(QUESTION);
    assert.equal(result.reason, "lost");
    assert.equal(h.backend.posts().length, 1);
    const status = h.backend.callsTo("status");
    assert.equal(status.length, 1);
    assert.equal(status[0].query.get("client_request_id"), "req-1");
    // The status named the work: the question is running, whatever happened to the response.
    assert.equal(h.view.phase, "running");
    assert.equal(h.view.sendDisabled, true);
    assert.equal(h.view.actions.retry, false);
    assert.equal(h.backend.posts().length, 1);
    h.backend.answer(ANSWER_ONE);
    await h.advance(3000);
    assert.equal(h.view.phase, "ready");
    assert.deepEqual(h.rows(), [`user: ${QUESTION}`, `assistant: ${ANSWER_ONE}`]);
    assert.equal(h.backend.posts().length, 1);
  });

  test("a lost response with an unreadable status: the visitor is told the question may be on its way and it is not resent", async () => {
    const h = newHarness();
    await h.boot();
    loseResponseAfterAccepting(h);
    h.backend.override("status", () => jsonResponse(503, errorBody("service_unavailable", "Status cannot be checked right now.", { retryable: true, submitted: null })));
    await h.send(QUESTION);
    assert.equal(h.view.phase, "reconciling");
    assert.equal(h.view.sendDisabled, true);
    assert.match(h.statusText(), /The status cannot be checked right now\. Trying again shortly\. Your question will not be sent again\./);
    assert.equal(h.view.actions.retry, false);
    assert.equal(h.view.actions.checkStatus, true);
  });

  test("a lost response of a question the service never saw: the status allows resubmission and Send again resends the same request", async () => {
    const h = newHarness();
    await h.boot();
    let attempts = 0;
    h.backend.override("messages", (ctx) => {
      attempts += 1;
      if (attempts === 1) return new Error("network lost before the service saw anything");
      return undefined;
    });
    await h.send(QUESTION);
    await flush();
    assert.equal(h.view.phase, "failed");
    assert.equal(h.view.actions.retry, true);
    assert.equal(h.view.retryText, QUESTION);
    assert.match(h.statusText(), /never reached the AI/);
    assert.equal(h.view.sendDisabled, false);
    assert.deepEqual(h.rows(), [`user: ${QUESTION}`], "the pending question stays visible");
    assert.equal(h.backend.posts().length, 1);
    const draftBefore = h.view.draft;
    const result = await h.send("", { retry: true });
    assert.equal(result.sent, true);
    assert.equal(h.backend.posts().length, 2);
    assert.equal(h.backend.posts()[1].body.client_request_id, "req-1", "the same logical submission");
    assert.equal(h.view.draft, draftBefore, "a retry does not touch what the visitor typed");
    assert.equal(h.view.phase, "running");
    h.backend.answer(ANSWER_ONE);
    await h.advance(2000);
    assert.equal(h.view.phase, "ready");
    assert.equal(h.view.rows.filter((row) => row.role === "assistant").length, 1);
  });

  test("Retry is refused unless the status allowed resubmission", async () => {
    const h = newHarness();
    await h.boot();
    unconfirmedAndUnseen(h);
    await h.send(QUESTION);
    assert.equal(h.view.phase, "reconciling");
    assert.equal(h.backend.posts().length, 1);
    const result = await h.send("", { retry: true });
    assert.deepEqual([result.sent, result.reason], [false, "busy"]);
    assert.equal(h.backend.posts().length, 1);
  });

  test("409 submission_unconfirmed with submitted:null and resubmission_allowed:false never triggers a resend, even when status stays unconfirmed", async () => {
    const h = newHarness();
    await h.boot();
    unconfirmedAndUnseen(h);
    await h.send(QUESTION);
    assert.equal(h.view.phase, "reconciling");
    assert.equal(h.view.actions.retry, false);
    await h.advance(400000);
    assert.equal(h.backend.posts().length, 1, "never resent");
    assert.equal(h.view.phase, "unresolved", "bounded checking ends in an honest unresolved state");
    assert.equal(h.view.sendDisabled, true);
    assert.deepEqual(
      [h.view.actions.retry, h.view.actions.checkStatus, h.view.actions.newConversation],
      [false, true, true],
    );
    assert.match(h.statusText(), /We could not confirm what happened to your last question\. It may or may not have been received, so it is not sent again\./);
    const checks = h.backend.callsTo("status").length;
    assert.ok(checks >= 10 && checks <= 60, `bounded polling with backoff, not a hammer (${checks} checks)`);
    await h.advance(120000);
    assert.equal(h.backend.callsTo("status").length, checks, "no automatic checks once the window is over");
  });

  test("the status stays unconfirmed but the history lists the question: it arrived, so the turn is working, not lost", async () => {
    const h = newHarness();
    await h.boot();
    unconfirmedAcceptance(h);
    await h.send(QUESTION);
    assert.equal(h.view.phase, "running", "a question listed in the history did arrive");
    assert.equal(h.view.actions.retry, false);
    assert.match(h.statusText(), /Your question was received\. The answer is being prepared\./);
    assert.doesNotMatch(h.statusText(), /could not confirm/);
    await h.advance(400000);
    assert.equal(h.backend.posts().length, 1, "never resent");
    assert.equal(h.view.phase, "unresolved");
    assert.match(h.statusText(), /Your question arrived, but no answer has come back yet\. It is not sent again\./);
    assert.doesNotMatch(h.statusText(), /may or may not have been received/);
    assert.deepEqual([h.view.actions.retry, h.view.actions.checkStatus, h.view.actions.newConversation], [false, true, true]);
  });

  test("the status stays unconfirmed after the work is done (the sender had given up): the answer is taken from the history", async () => {
    const h = newHarness();
    await h.boot();
    unconfirmedAcceptance(h);
    await h.send(QUESTION);
    assert.equal(h.view.phase, "running");
    // The work finishes; the service still cannot match the request id (outcome stays submission_unconfirmed).
    const conversation = [...h.backend.conversations.values()][0];
    conversation.items.push({ id: `item-${++h.backend.ids.item}`, role: "assistant", text: ANSWER_ONE, workRef: "work-1", provisional: false });
    await h.advance(3000);
    assert.equal(h.view.phase, "ready");
    assert.deepEqual(h.rows(), [`user: ${QUESTION}`, `assistant: ${ANSWER_ONE}`]);
    assert.equal(h.backend.posts().length, 1);
    assert.equal(h.view.sendDisabled, false);
  });

  test("the send is allowed to outlast the service's own 90 s acceptance budget (a first question takes 20 to 40 s)", () => {
    assert.ok(TIMEOUTS.send >= 95000, `send timeout ${TIMEOUTS.send} ms`);
  });

  test("a slow acceptance says so at 15 s and at 60 s instead of pretending it is still the first second", async () => {
    const h = newHarness();
    await h.boot();
    let finish;
    h.backend.override("messages", () => new Promise((resolve) => { finish = () => resolve(h.backend.defaults.messages({ params: [[...h.backend.conversations.keys()][0]], body: { client_request_id: h.view.requestId || "r", message: QUESTION } })); }));
    h.controller.editDraft(h.view, QUESTION);
    const pending = h.controller.send(h.view, QUESTION);
    await flush();
    assert.equal(h.view.phase, "submitting");
    assert.match(h.statusText(), /^Sending your question/);
    await h.advance(16000);
    assert.equal(h.view.phase, "submitting");
    assert.match(h.statusText(), /Still sending your question\./);
    await h.advance(50000);
    assert.match(h.statusText(), /still being handed to the AI/);
    void pending;
    void finish;
  });

  test("a manual Check status runs a new bounded round and consumes the real answer", async () => {
    const h = newHarness();
    await h.boot();
    unconfirmedAcceptance(h);
    await h.send(QUESTION);
    await h.advance(400000);
    assert.equal(h.view.phase, "unresolved");
    // The service settles the question after all.
    h.backend.answer(ANSWER_ONE);
    await h.controller.checkStatus(h.view);
    await h.advance(1000);
    assert.equal(h.view.phase, "ready");
    assert.deepEqual(h.rows(), [`user: ${QUESTION}`, `assistant: ${ANSWER_ONE}`]);
    assert.equal(h.backend.posts().length, 1);
  });

  test("a status that says the question is still running (not another reconciling) puts the phase back to running", async () => {
    const h = newHarness();
    await h.boot();
    loseResponseAfterAccepting(h);
    await h.send(QUESTION);
    assert.equal(h.view.phase, "running", "the status response decided, not the loss");
    assert.equal(h.view.actions.cancel, true, "the status named the run");
    assert.match(h.statusText(), /Last check: the AI is still working on it\./);
  });
});

describe("outcome table: stream interrupted after acceptance", () => {
  test("a broken stream is not a failure: the same turn is recovered from the status and the history", async () => {
    const h = newHarness();
    await h.boot();
    const stream = heldStream([]);
    h.backend.override("events", () => stream.response);
    await h.send(QUESTION);
    stream.push(frame({ protocol_version: 1, conversation_id: "conv-1", provider_session_id: "p", activeAgentRunId: "run-1", nativeWorkRef: "work-1", connection_id: "c", sequence: 1, event: { type: "text_delta", text: "The hou" } }));
    await flush();
    stream.fail();
    await flush();
    assert.equal(h.view.phase, "running", "the status said the work is still running");
    h.backend.clearOverride("events");
    h.backend.answer("The household pays.");
    await h.advance(10000);
    assert.equal(h.view.phase, "ready");
    assert.deepEqual(h.rows(), [`user: ${QUESTION}`, "assistant: The household pays."]);
    assert.equal(h.backend.posts().length, 1);
  });

  test("a stream that goes silent is given up on after the idle limit and the turn is checked instead", async () => {
    const h = newHarness({ timing: { streamIdleMs: 20000 } });
    await h.boot();
    const stream = heldStream([]);
    h.backend.override("events", () => stream.response);
    await h.send(QUESTION);
    assert.equal(h.controller.activity().streaming, true);
    await h.advance(21000);
    assert.equal(h.controller.activity().streaming, false);
    assert.ok(h.backend.callsTo("status").length >= 1);
    h.backend.clearOverride("events");
    h.backend.answer("Done.");
    await h.advance(10000);
    assert.equal(h.view.phase, "ready");
    assert.equal(h.backend.posts().length, 1);
  });

  test("the stream saying done without the history listing the answer yet keeps the turn pending", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(QUESTION);
    // The service says done (queued event) but the answer is not in the history yet.
    const conv = h.backend.conversation();
    conv.queue.push({ type: "done", nativeWorkRef: "work-1" });
    h.backend.requests.get("req-1").state = "completed";
    await h.advance(5000);
    assert.notEqual(h.view.phase, "ready");
    assert.equal(h.view.rows.filter((row) => row.role === "assistant").length, 0);
    conv.items.push({ id: "item-9", role: "assistant", text: "Late answer.", workRef: "work-1", provisional: false });
    await h.advance(10000);
    assert.equal(h.view.phase, "ready");
    assert.deepEqual(h.rows(), [`user: ${QUESTION}`, "assistant: Late answer."]);
  });
});

describe("outcome table: known failure", () => {
  test("a failed run (status failed): a problem is explained, no empty success, the question is back in the box", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(QUESTION);
    h.backend.failRun({ emitEvent: false });
    await h.advance(3000);
    assert.equal(h.view.phase, "failed");
    assert.equal(h.view.sendDisabled, false);
    assert.match(h.statusText(), /^The AI could not finish an answer to this question\./);
    assert.match(h.statusText(), /Your question is back in the message box/);
    assert.equal(h.view.status.kind, "error");
    assert.equal(h.view.draft, QUESTION);
    assert.equal(h.view.actions.retry, false, "failed work is not resubmitted by a button; the visitor decides");
    assert.equal(h.view.rows.filter((row) => row.role === "assistant").length, 0);
    assert.equal(h.backend.posts().length, 1);
    assert.equal(h.saved().requestId, null);
  });

  test("an error event with a message: the message is shown, as text, and the draft keeps what the visitor typed meanwhile", async () => {
    const h = newHarness();
    await h.boot();
    const stream = heldStream([]);
    h.backend.override("events", () => stream.response);
    await h.send(QUESTION);
    h.controller.editDraft(h.view, "something else I am typing");
    h.backend.failRun({ message: "The model <b>refused</b> the request" });
    stream.push(frame({ protocol_version: 1, conversation_id: "conv-1", provider_session_id: "p", activeAgentRunId: "run-1", nativeWorkRef: "work-1", connection_id: "c", sequence: 1, event: { type: "error", code: "run_failed", message: "The model <b>refused</b> the request", retryable: false } }));
    stream.release();
    await h.advance(3000);
    assert.equal(h.view.phase, "failed");
    assert.match(h.statusText(), /The answer could not be completed: The model <b>refused<\/b> the request/);
    assert.equal(h.view.draft, "something else I am typing", "a late failure never overwrites the draft");
    assert.equal(h.view.rows.filter((row) => row.role === "assistant").length, 0);
  });

  test("the problem is told when the history says the work failed and the status endpoint is unreadable", async () => {
    const h = newHarness();
    await h.boot();
    h.backend.override("status", () => jsonResponse(200, { state: "idle" }));
    await h.send(QUESTION);
    h.backend.failRun({ emitEvent: false });
    await h.advance(3000);
    assert.equal(h.view.phase, "failed");
  });

  test("after a failed turn the next question is a new logical submission with a new request id", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(QUESTION);
    h.backend.failRun({ emitEvent: false });
    await h.advance(3000);
    await h.send(QUESTION);
    assert.equal(h.backend.posts().length, 2);
    assert.notEqual(h.backend.posts()[0].body.client_request_id, h.backend.posts()[1].body.client_request_id);
    h.backend.answer(ANSWER_ONE);
    await h.advance(3000);
    assert.equal(h.view.phase, "ready");
    assert.equal(h.view.rows.filter((row) => row.role === "assistant").length, 1);
  });
});

describe("outcome table: clean rejection", () => {
  async function rejected(response, overrides = {}) {
    const h = newHarness();
    await h.boot();
    h.backend.override("messages", () => response);
    await h.send(QUESTION);
    return { h, ...overrides };
  }

  function assertCleanRefusal(h, pattern, kind = "error") {
    assert.equal(h.view.phase, "rejected");
    assert.equal(h.view.sendDisabled, false, "the visitor may send again");
    assert.equal(h.view.draft, QUESTION, "the refused text is back in the box");
    assert.match(h.statusText(), pattern);
    assert.equal(h.view.status.kind, kind);
    assert.equal(h.backend.posts().length, 1);
    assert.equal(h.backend.callsTo("status").length, 0, "nothing is pending, so nothing is checked");
    assert.deepEqual(h.rows(), [], "the refused question is not shown as sent");
    assert.equal(h.saved().requestId, null);
  }

  test("409 conversation_busy", async () => {
    const { h } = await rejected(jsonResponse(409, errorBody("conversation_busy", "This conversation is still working on another message. Your message was not sent.")));
    assertCleanRefusal(h, /still working on another message, so yours was not sent/);
    assert.equal(h.view.actions.newConversation, true);
  });

  async function answeredOnce() {
    const h = newHarness();
    await h.boot();
    await h.send(QUESTION);
    h.backend.answer(ANSWER_ONE);
    await h.advance(3000);
    assert.equal(h.view.phase, "ready");
    return h;
  }

  test("409 conversation_busy right after an answer was read (the service frees the run a moment later): offered again, same request id, then it goes through", async () => {
    const h = await answeredOnce();
    let calls = 0;
    h.backend.override("messages", (ctx) => {
      calls += 1;
      return calls < 3 ? jsonResponse(409, errorBody("conversation_busy", "This conversation is still working on another message. Your message was not sent.")) : h.backend.defaults.messages(ctx);
    });
    h.controller.editDraft(h.view, "And what is the pot?");
    const sending = h.controller.send(h.view, "And what is the pot?");
    await flush();
    assert.equal(h.view.phase, "submitting", "not shown as refused: nothing the visitor has to act on yet");
    assert.match(h.statusText(), /The previous answer is just being wrapped up\. Your question will go out in a moment\./);
    await h.advance(1600);
    await h.advance(3100);
    await sending;
    assert.equal(calls, 3);
    assert.equal(h.view.phase, "running");
    const posts = h.backend.posts().slice(-3);
    assert.equal(new Set(posts.map((post) => post.body.client_request_id)).size, 1, "one logical submission");
    assert.deepEqual(h.rows().slice(-1), ["user: And what is the pot?"]);
  });

  test("409 conversation_busy that does not clear is told after five tries, with the draft back and nothing marked sent", async () => {
    const h = await answeredOnce();
    h.backend.override("messages", () => jsonResponse(409, errorBody("conversation_busy", "This conversation is still working on another message. Your message was not sent.")));
    h.controller.editDraft(h.view, "And what is the pot?");
    const sending = h.controller.send(h.view, "And what is the pot?");
    await h.advance(1600);
    await h.advance(3100);
    await h.advance(5100);
    await h.advance(8100);
    await h.advance(12100);
    await sending;
    assert.equal(h.view.phase, "rejected");
    assert.equal(h.view.draft, "And what is the pot?");
    assert.match(h.statusText(), /still working on another message, so yours was not sent/);
    assert.equal(h.backend.posts().filter((post) => post.body.message === "And what is the pot?").length, 6, "the first try and five offers, no more");
  });

  test("409 conversation_busy long after the last answer is not retried: another message really is running", async () => {
    const h = await answeredOnce();
    await h.advance(70000);
    h.backend.override("messages", () => jsonResponse(409, errorBody("conversation_busy", "This conversation is still working on another message. Your message was not sent.")));
    h.controller.editDraft(h.view, "And what is the pot?");
    await h.send("And what is the pot?");
    assert.equal(h.view.phase, "rejected");
    assert.equal(h.backend.posts().filter((post) => post.body.message === "And what is the pot?").length, 1);
  });

  test("429 rate_limited with Retry-After", async () => {
    const { h } = await rejected(jsonResponse(429, errorBody("rate_limited", "Too many messages right now. Your message was not sent.", { retryable: true }), { "retry-after": "20" }));
    assertCleanRefusal(h, /sending messages too quickly\. Nothing was sent\. Wait about 20 seconds/);
  });

  test("503 capacity_unavailable names the provider", async () => {
    const { h } = await rejected(jsonResponse(503, errorBody("capacity_unavailable", "No capacity is available right now. Your message was not sent.", { retryable: true })));
    assertCleanRefusal(h, /OpenAI has no capacity for another message right now, so yours was not sent/);
    assert.match(h.statusText(), /Or start a new conversation with xAI\./);
  });

  test("503 service_unavailable", async () => {
    const { h } = await rejected(jsonResponse(503, errorBody("service_unavailable", "The conversation service is unavailable right now.", { retryable: true })));
    assertCleanRefusal(h, /is not available right now, so your message was not sent/);
  });

  test("400 invalid_request keeps the draft and says what the service said", async () => {
    const { h } = await rejected(jsonResponse(400, errorBody("invalid_request", "Send exactly a conversation, a request ID and a message.")));
    assertCleanRefusal(h, /The service did not accept that message, so nothing was sent\. \(Send exactly a conversation/);
  });

  test("413 from the service", async () => {
    const { h } = await rejected(jsonResponse(413, errorBody("message_too_large", "The message is longer than the allowed size.")));
    assertCleanRefusal(h, /too long to send \(the limit is 8,192 bytes\)/);
  });

  test("404 not_found: the conversation is gone, a new one is offered, nothing is silently recreated", async () => {
    const { h } = await rejected(jsonResponse(404, errorBody("not_found", "No such conversation.")));
    assertCleanRefusal(h, /no longer available/, "gone");
    assert.equal(h.backend.callsTo("create").length, 1, "no replacement conversation was created behind the visitor's back");
    assert.equal(h.view.providerFixed, true);
  });

  test("a rejected question can be sent again by the visitor, and then it is one more submission", async () => {
    const h = newHarness();
    await h.boot();
    let calls = 0;
    h.backend.override("messages", () => (++calls === 1 ? jsonResponse(429, errorBody("rate_limited", "x", { retryable: true }), { "retry-after": "3" }) : undefined));
    await h.send(QUESTION);
    assert.equal(h.view.phase, "rejected");
    await h.send(h.view.draft);
    assert.equal(h.backend.posts().length, 2);
    assert.equal(h.view.phase, "running");
  });

  test("an oversized or empty message is refused before any request", async () => {
    const h = newHarness();
    await h.boot();
    const empty = await h.send("   ");
    assert.equal(empty.reason, "empty");
    const huge = await h.send("é".repeat(5000));
    assert.equal(huge.reason, "too_large");
    assert.match(h.statusText(), /too long to send/);
    assert.equal(h.backend.calls.filter((call) => call.route === "create" || call.route === "messages").length, 0);
  });

  test("a 403 csrf_rejected renews the session and says nothing was sent", async () => {
    const h = newHarness();
    await h.boot();
    let calls = 0;
    h.backend.override("messages", () => (++calls === 1 ? jsonResponse(403, errorBody("csrf_rejected", "The request is missing a valid CSRF token.")) : undefined));
    await h.send(QUESTION);
    assert.equal(h.view.phase, "rejected");
    assert.match(h.statusText(), /session could not be verified, so nothing was sent/);
    await h.send(h.view.draft);
    assert.equal(h.backend.callsTo("session").length, 2, "the session was renewed before the visitor's next send");
    assert.equal(h.view.phase, "running");
  });
});

describe("outcome table: provider refusals", () => {
  test("a provider that cannot start a conversation is named, nothing is sent, the draft survives", async () => {
    const h = newHarness();
    h.backend.providers[0].available = false;
    await h.boot();
    h.backend.providers[0].available = true; // /providers was stale; the creation is the authority
    h.backend.override("create", () => jsonResponse(503, errorBody("provider_not_eligible", "This provider cannot start a new conversation right now.")));
    await h.send(QUESTION, { provider: "openai" });
    assert.equal(h.view.phase, "rejected");
    assert.match(h.statusText(), /OpenAI cannot start a new conversation right now, so nothing was sent\./);
    assert.equal(h.view.draft, QUESTION);
    assert.equal(h.backend.posts().length, 0);
    assert.equal(h.view.providerFixed, false, "no conversation exists, so the provider can still be chosen");
  });

  test("a conversation that cannot be created for another reason is explained", async () => {
    const h = newHarness();
    await h.boot();
    h.backend.override("create", () => jsonResponse(500, { error: { code: "boom" } }));
    await h.send(QUESTION);
    assert.equal(h.view.phase, "rejected");
    assert.equal(h.view.sendDisabled, false, "nothing was sent, so sending again is the retry");
    assert.match(h.statusText(), /A conversation with OpenAI could not be started, so nothing was sent\./);
    assert.equal(h.view.draft, QUESTION);
    assert.equal(h.backend.posts().length, 0);
  });

  test("a visitor session that fails at send time sends nothing and keeps the question", async () => {
    const h = newHarness({ timing: { sessionFreshMs: 0 } });
    await h.boot();
    h.backend.override("session", () => new Error("connection reset"));
    await h.send(QUESTION);
    assert.equal(h.view.phase, "rejected");
    assert.match(h.statusText(), /The conversation service could not be reached\. Nothing was sent\./);
    assert.equal(h.view.draft, QUESTION);
    assert.equal(h.backend.posts().length, 0);
    assert.equal(h.backend.callsTo("create").length, 0);
  });

  test("a failing visitor session says so instead of leaving a blank chat", async () => {
    const h = newHarness();
    h.backend.override("session", () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    await h.boot();
    assert.equal(h.view.phase, "unavailable");
    assert.match(h.statusText(), /The conversation service could not be reached\. Nothing was sent\./);
    assert.equal(h.view.sendDisabled, false);
    h.backend.clearOverride("session");
    await h.send(QUESTION);
    assert.equal(h.view.phase, "running", "the next send tries the session again");
  });

  test("a chat that could not start recovers by itself when the service comes back, in a bounded number of tries", async () => {
    const h = newHarness();
    h.backend.override("session", () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    await h.boot();
    assert.equal(h.view.phase, "unavailable");
    await h.advance(2900);
    assert.equal(h.backend.callsTo("session").length, 1, "the first retry is not before its time");
    await h.advance(200);
    assert.equal(h.backend.callsTo("session").length, 2);
    assert.equal(h.view.phase, "unavailable");
    h.backend.clearOverride("session");
    await h.advance(9000);
    assert.equal(h.view.phase, "ready");
    assert.equal(h.statusText(), "");
    assert.equal(h.backend.callsTo("providers").length, 2, "the providers are read again once the service is back");
  });

  test("the retries of a chat that cannot start are bounded", async () => {
    const h = newHarness();
    h.backend.override("session", () => new Response("down", { status: 503 }));
    await h.boot();
    await h.advance(10 * 60 * 1000);
    assert.equal(h.backend.callsTo("session").length, 5, "the boot try and four retries, then no more");
    assert.equal(h.view.phase, "unavailable");
    assert.equal(h.view.sendDisabled, false, "the visitor's Send is still the way to try again");
  });
});

describe("outcome table: cancel", () => {
  test("cancel confirmed: the real result is reported and the composer is free", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(QUESTION);
    const pending = h.controller.cancel(h.view);
    assert.equal(h.view.phase, "cancelling");
    assert.match(h.statusText(), /^A stop was requested\./);
    assert.equal(h.view.actions.cancelDisabled, true);
    await pending;
    await flush();
    assert.equal(h.view.phase, "cancelled");
    assert.match(h.statusText(), /^Cancelled\. This question has no answer\./);
    assert.equal(h.view.sendDisabled, false);
    assert.equal(h.view.actions.cancel, false);
    assert.equal(h.backend.callsTo("cancel").length, 1);
    assert.equal(h.backend.callsTo("cancel")[0].path, "/conversations/conv-1/runs/run-1/cancel");
    assert.equal(h.backend.callsTo("cancel")[0].headers["x-esp-csrf"], "csrf-token-1");
  });

  test("cancel not yet confirmed: the stop is NOT claimed; the turn keeps being checked until the service says", async () => {
    const h = newHarness();
    h.backend.cancelBehavior = "unconfirmed";
    await h.boot();
    await h.send(QUESTION);
    await h.controller.cancel(h.view);
    await h.advance(500);
    assert.equal(h.view.phase, "cancelling");
    assert.match(h.statusText(), /We asked the AI to stop but could not confirm it yet\. It may still finish this answer\./);
    assert.doesNotMatch(h.statusText(), /Cancelled/);
    assert.equal(h.view.sendDisabled, true);
    // The stop takes effect later.
    const run = h.backend.requests.get("req-1");
    run.state = "cancelled";
    h.backend.conversation().run = null;
    await h.advance(10000);
    assert.equal(h.view.phase, "cancelled");
    assert.match(h.statusText(), /^Cancelled\./);
  });

  test("cancel request fails: no cancellation is claimed", async () => {
    const h = newHarness();
    h.backend.cancelBehavior = "fails";
    await h.boot();
    await h.send(QUESTION);
    await h.controller.cancel(h.view);
    await h.advance(500);
    assert.equal(h.view.phase, "cancelling");
    assert.doesNotMatch(h.statusText(), /^Cancelled/);
    assert.match(h.statusText(), /could not confirm it yet/);
  });

  test("the answer finishes while the stop is pending: the visitor gets the answer, not a cancellation", async () => {
    const h = newHarness();
    h.backend.cancelBehavior = "unconfirmed";
    await h.boot();
    await h.send(QUESTION);
    await h.controller.cancel(h.view);
    h.backend.answer(ANSWER_ONE);
    await h.advance(10000);
    assert.equal(h.view.phase, "ready");
    assert.deepEqual(h.rows(), [`user: ${QUESTION}`, `assistant: ${ANSWER_ONE}`]);
  });

  test("Cancel is offered only when a cancellable run is known", async () => {
    const h = newHarness();
    await h.boot();
    // An accepted response without a frame (no run named) and a status without a run.
    h.backend.override("messages", () => {
      const conv = h.backend.conversation();
      const run = { requestId: "req-1", conversationId: conv.id, runId: "run-9", workRef: "work-9", state: "running" };
      conv.run = null;
      h.backend.requests.set("req-1", run);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json", "x-esp-acceptance": "accepted" } });
    });
    h.backend.override("status", () => jsonResponse(200, { outcome: "running", active_agent_run_id: null, native_work_ref: null, resubmission_allowed: false, runtime_state: "running" }));
    await h.send(QUESTION);
    assert.equal(h.view.phase, "running");
    assert.equal(h.view.actions.cancel, false);
    const result = await h.controller.cancel(h.view);
    assert.equal(result, undefined);
    assert.equal(h.backend.callsTo("cancel").length, 0);
  });
});

describe("outcome table: status or history temporarily unavailable", () => {
  test("a status endpoint that keeps failing: prior context is kept, checks stay bounded, the end is unresolved, not a failure", async () => {
    const h = newHarness();
    await h.boot();
    h.backend.override("status", () => jsonResponse(503, errorBody("service_unavailable", "Status cannot be checked right now.", { retryable: true, submitted: null })));
    h.backend.override("history", (ctx) => (ctx.n > 1 ? jsonResponse(503, errorBody("history_unavailable", "This conversation's history cannot be read right now.", { retryable: true, submitted: null })) : undefined));
    await h.send(QUESTION);
    assert.equal(h.view.phase, "running");
    assert.match(h.statusText(), /Its status cannot be checked right now; trying again shortly\./);
    await h.advance(340000);
    assert.equal(h.view.phase, "unresolved");
    assert.equal(h.view.sendDisabled, true);
    assert.deepEqual(h.rows(), [`user: ${QUESTION}`], "what was shown stays shown");
    assert.equal(h.backend.posts().length, 1);
    assert.equal(h.view.actions.checkStatus, true);
    assert.equal(h.view.actions.newConversation, true);
  });

  test("status completed but the history cannot be read yet: the turn waits, then settles when it can", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(QUESTION);
    h.backend.answer(ANSWER_ONE);
    let calls = 0;
    h.backend.override("history", () => (++calls <= 2 ? jsonResponse(503, errorBody("history_unavailable", "x", { retryable: true, submitted: null })) : undefined));
    await h.advance(1500);
    assert.notEqual(h.view.phase, "ready");
    assert.match(h.statusText(), /answer may be ready, but the conversation cannot be read right now|finished and is being loaded/);
    await h.advance(20000);
    assert.equal(h.view.phase, "ready");
    assert.deepEqual(h.rows(), [`user: ${QUESTION}`, `assistant: ${ANSWER_ONE}`]);
  });

  test("the status says gone (404): the conversation is unavailable and the visitor is told", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(QUESTION);
    h.backend.override("status", () => jsonResponse(404, errorBody("not_found", "No such conversation.", { submitted: null })));
    await h.advance(3000);
    assert.equal(h.view.phase, "failed");
    assert.match(h.statusText(), /no longer available/);
    assert.equal(h.view.actions.newConversation, true);
  });
});

describe("a new conversation is explicit", () => {
  test("the first activation explains, the second one clears the conversation and keeps the draft", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(QUESTION);
    h.backend.answer(ANSWER_ONE);
    await h.advance(2000);
    h.controller.editDraft(h.view, "my next question");
    assert.equal(h.view.actions.newConversation, true);
    assert.equal(h.view.providerFixed, true);
    assert.equal(h.view.provider, "openai");
    const first = h.controller.newConversation(h.view);
    assert.equal(first.confirmed, false);
    assert.match(h.statusText(), /clears the answers shown here \(they stay with the old conversation\) and lets you pick a provider\. Your map progress is kept\. Press the button again to confirm\./);
    assert.equal(h.view.actions.newConversationLabel, "Confirm: start a new conversation");
    assert.equal(h.view.rows.length, 2, "nothing is cleared by the first activation");
    const second = h.controller.newConversation(h.view);
    assert.equal(second.confirmed, true);
    assert.deepEqual(h.rows(), []);
    assert.equal(h.view.providerFixed, false);
    assert.equal(h.view.draft, "my next question");
    assert.match(h.statusText(), /^New conversation\./);
    assert.equal(h.saved().conversationId, null);
    // The next question starts a conversation with the provider the visitor picks now.
    h.controller.selectProvider(h.view, "xai");
    await h.send("my next question");
    assert.equal(h.backend.callsTo("create").at(-1).body.provider, "xai");
    assert.equal(h.view.provider, "xai");
  });

  test("sending a message drops a pending confirmation", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(QUESTION);
    h.backend.answer(ANSWER_ONE);
    await h.advance(2000);
    h.controller.newConversation(h.view);
    await h.send("another question");
    assert.equal(h.view.actions.newConversationLabel, "New conversation");
    assert.equal(h.view.providerFixed, true);
  });

  test("a new conversation while a question is pending abandons it without cancelling or resending anything", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(QUESTION);
    h.controller.newConversation(h.view);
    assert.match(h.statusText(), /The question still waiting for an answer is abandoned\./);
    h.controller.newConversation(h.view);
    assert.equal(h.view.phase, "ready");
    assert.equal(h.saved().requestId, null);
    assert.equal(h.controller.activity().loop, false);
    const before = h.backend.calls.length;
    await h.advance(60000);
    assert.equal(h.backend.calls.length, before, "no background checks of the abandoned question");
  });
});
