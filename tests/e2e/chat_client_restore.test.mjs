/**
 * What a refresh keeps and what the client refuses to believe: the history on boot, the unsent draft, the
 * provider, a pending question that is re-checked and never resent, a history that cannot be read, an
 * old answer that must not complete a new turn, duplicate deliveries, storage that is missing or corrupt.
 * The REAL client against a fake backend that follows the API contract; time is a manual clock.
 *
 * Run: node --test tests/e2e/chat_client_restore.test.mjs
 */

import { TIMEOUTS } from "../../site/js/api.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ANSWER_ONE,
  errorBody,
  flush,
  frame,
  heldStream,
  jsonResponse,
  makeStorage,
  newHarness,
} from "./chat_client_support.mjs";

const Q1 = "Who actually pays the apps I use?";
const Q2 = "What is the pot?";

async function completedTurn(h, question, answer) {
  await h.send(question);
  h.backend.answer(answer);
  await h.advance(3000);
  assert.equal(h.view.phase, "ready");
}

describe("refresh restores the conversation without sending anything", () => {
  test("a completed turn reappears from the history on boot; the only requests are reads", async () => {
    const first = newHarness();
    await first.boot();
    await completedTurn(first, Q1, ANSWER_ONE);
    const second = first.reloaded();
    const before = second.backend.calls.length;
    await second.boot();
    assert.deepEqual(second.rows(), [`user: ${Q1}`, `assistant: ${ANSWER_ONE}`]);
    assert.equal(second.view.phase, "ready");
    assert.equal(second.view.sendDisabled, false);
    const added = second.backend.calls.slice(before).map((call) => `${call.method} ${call.route}`);
    assert.deepEqual(added.sort(), ["GET history", "GET providers", "POST session"].sort());
    assert.equal(second.backend.posts().length, 1, "nothing was sent");
    assert.equal(second.backend.callsTo("create").length, 1);
  });

  test("while the history loads there is a loading line, and it is gone when it has loaded", async () => {
    const first = newHarness();
    await first.boot();
    await completedTurn(first, Q1, ANSWER_ONE);
    const second = first.reloaded();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    second.backend.override("history", async () => {
      await gate;
      return undefined;
    });
    const booting = second.controller.boot(second.view);
    await flush();
    assert.deepEqual(second.view.historyState, { kind: "loading", text: "Loading the conversation so far…" });
    assert.equal(second.view.phase, "ready", "the chat is usable while it loads");
    release();
    await booting;
    assert.deepEqual(second.view.historyState, { kind: "idle", text: "" });
    assert.equal(second.view.rows.length, 2);
  });

  test("the unsent draft survives, however it was typed, and the sent text is not mixed into it", async () => {
    const first = newHarness();
    await first.boot();
    await completedTurn(first, Q1, ANSWER_ONE);
    for (const text of ["C", "Co", "Could you give a household example?", "Could you give a household", "", "pasted text that was never typed"]) {
      first.controller.editDraft(first.view, text);
    }
    assert.equal(first.saved().draft, "pasted text that was never typed");
    const second = first.reloaded();
    await second.boot();
    assert.equal(second.view.draft, "pasted text that was never typed");
    assert.ok(second.view.draftRevision >= 0);
    assert.equal(second.saved().submitted, "");
  });

  test("a draft typed while the answer is pending is kept, and the late answer does not touch it", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(Q1);
    h.controller.editDraft(h.view, "Could you give a household example?");
    const revision = h.view.draftRevision;
    h.backend.answer(ANSWER_ONE);
    await h.advance(3000);
    assert.equal(h.view.phase, "ready");
    assert.equal(h.view.draft, "Could you give a household example?");
    assert.equal(h.view.draftRevision, revision, "no programmatic write over the visitor's text");
  });

  test("the provider of the conversation is restored with the conversation and cannot be changed in place", async () => {
    const first = newHarness();
    first.controller.selectProvider(first.view, "xai");
    await first.boot();
    first.controller.selectProvider(first.view, "xai");
    await completedTurn(first, Q1, ANSWER_ONE);
    assert.equal(first.view.provider, "xai");
    const second = first.reloaded();
    await second.boot();
    assert.equal(second.view.provider, "xai");
    assert.equal(second.view.providerFixed, true);
    second.controller.selectProvider(second.view, "openai");
    assert.equal(second.view.provider, "xai", "a provider change needs a new conversation");
    assert.equal(second.saved().provider, "xai");
  });

  test("providers that are not available are marked, and the first available one is the default", async () => {
    const h = newHarness();
    h.backend.providers[0].available = false;
    h.backend.providers[1].eligible = true;
    await h.boot();
    assert.deepEqual(
      h.view.providers.map((entry) => [entry.provider, entry.available, entry.reason]),
      [
        ["openai", false, "unavailable right now"],
        ["xai", true, ""],
      ],
    );
    assert.equal(h.view.provider, "xai", "the default moves off an unavailable provider");
    h.controller.selectProvider(h.view, "openai");
    assert.equal(h.view.provider, "xai", "an unavailable provider cannot be chosen");
    await h.send(Q1);
    assert.equal(h.backend.callsTo("create")[0].body.provider, "xai");
  });

  test("an ineligible provider says it is not open to new conversations; a provider the service does not list is marked too", async () => {
    const h = newHarness();
    h.backend.providers = [{ provider: "openai", harness: "codex", display_model: "m", eligible: false, available: false }];
    await h.boot();
    assert.deepEqual(h.view.providers.map((entry) => entry.reason), ["not open to new conversations", "not offered here"]);
  });

  test("when /providers cannot be read nothing is disabled on a guess", async () => {
    const h = newHarness();
    h.backend.override("providers", () => jsonResponse(503, errorBody("service_unavailable", "x", { retryable: true })));
    await h.boot();
    assert.deepEqual(h.view.providers.map((entry) => entry.available), [true, true]);
  });

  test("a conversation whose history cannot be read: a visible failure with a retry, no new question needed, prior context not faked", async () => {
    const first = newHarness();
    await first.boot();
    await completedTurn(first, Q1, ANSWER_ONE);
    const second = first.reloaded();
    let calls = 0;
    second.backend.override("history", () => (++calls === 1 ? jsonResponse(503, errorBody("history_unavailable", "This conversation's history cannot be read right now.", { retryable: true, submitted: null })) : undefined));
    const before = second.backend.posts().length;
    await second.boot();
    assert.equal(second.view.historyState.kind, "failed");
    assert.match(second.view.historyState.text, /could not be loaded\. They are not lost; only the display failed\./);
    assert.deepEqual(second.view.rows, [], "an empty panel is not an empty conversation");
    assert.equal(second.view.providerFixed, true, "it is still the same conversation");
    assert.equal(second.view.phase, "ready");
    await second.controller.retryHistory(second.view);
    assert.deepEqual(second.view.historyState, { kind: "idle", text: "" });
    assert.deepEqual(second.rows(), [`user: ${Q1}`, `assistant: ${ANSWER_ONE}`]);
    assert.equal(second.backend.posts().length, before, "retrying the display sent nothing");
  });

  test("a conversation that is gone says so and offers a new one", async () => {
    const first = newHarness();
    await first.boot();
    await completedTurn(first, Q1, ANSWER_ONE);
    const second = first.reloaded();
    second.backend.conversations.clear();
    await second.boot();
    assert.equal(second.view.historyState.kind, "failed");
    assert.equal(second.view.historyState.gone, true);
    assert.equal(second.view.status.kind, "gone");
    assert.equal(second.view.actions.newConversation, true);
  });

  test("the history is shown as the service has it: replayed ids and empty items are not extra rows", async () => {
    const first = newHarness();
    await first.boot();
    await completedTurn(first, Q1, ANSWER_ONE);
    const second = first.reloaded();
    second.backend.override("history", () => {
      const conv = second.backend.conversation();
      const item = (id, role, text) => ({ native_item_id: id, native_work_ref: "w", role, text, citations: [], assets: [], structured_data: [], provisional: false });
      return jsonResponse(200, {
        items: [item("a", "user", Q1), item("a", "user", Q1), item("b", "assistant", ANSWER_ONE), item("c", "assistant", ""), item("b", "assistant", ANSWER_ONE)],
        native_cursor: null,
        status: { status: "completed", native_work_ref: "w", request_id: "x", saved_input_available: true },
        provenance: [],
      });
    });
    await second.boot();
    assert.deepEqual(second.rows(), [`user: ${Q1}`, `assistant: ${ANSWER_ONE}`]);
  });
});

describe("refresh while a question is pending", () => {
  async function pending({ keepRunning = true } = {}) {
    const first = newHarness();
    await first.boot();
    await first.send(Q1);
    assert.equal(first.view.phase, "running");
    return first;
  }

  test("the same request is re-checked, never sent again; the history and the question stay visible", async () => {
    const first = await pending();
    const second = first.reloaded();
    const before = second.backend.calls.length;
    await second.boot();
    assert.equal(second.backend.posts().length, 1, "no resend");
    const status = second.backend.calls.slice(before).filter((call) => call.route === "status");
    assert.equal(status.length, 1);
    assert.equal(status[0].query.get("client_request_id"), "req-1", "the same request identity");
    assert.equal(second.view.phase, "running", "the status said it is still running");
    assert.equal(second.view.actions.cancel, true, "the run identity survived the reload");
    assert.deepEqual(second.rows(), [`user: ${Q1}`], "the saved question is listed once");
    assert.equal(second.view.draft, "", "the pending question is not turned into a draft");
    second.backend.answer(ANSWER_ONE);
    await second.advance(3000);
    assert.equal(second.view.phase, "ready");
    assert.deepEqual(second.rows(), [`user: ${Q1}`, `assistant: ${ANSWER_ONE}`]);
    assert.equal(second.backend.posts().length, 1);
  });

  test("repeated reloads neither erase the pending request nor manufacture progress", async () => {
    let h = await pending();
    for (let i = 0; i < 4; i += 1) {
      h = h.reloaded();
      await h.boot();
      assert.equal(h.saved().requestId, "req-1");
      assert.equal(h.saved().submitted, Q1);
      assert.equal(h.view.rows.filter((row) => row.role === "assistant").length, 0);
      assert.equal(h.view.draft, "");
    }
    assert.equal(h.backend.posts().length, 1);
  });

  test("the wait thresholds continue across a reload instead of starting over", async () => {
    const first = await pending();
    await first.advance(50000);
    const second = first.reloaded();
    await second.boot();
    assert.match(second.statusText(), /Still working on your answer\./);
    await second.advance(11000);
    assert.match(second.statusText(), /This is taking longer than usual\./);
  });

  test("an answer that completed before the reload is recovered from the history, not from a stream that is gone", async () => {
    const first = await pending();
    first.backend.answer(ANSWER_ONE);
    const second = first.reloaded();
    await second.boot();
    await second.advance(1000);
    assert.equal(second.view.phase, "ready");
    assert.deepEqual(second.rows(), [`user: ${Q1}`, `assistant: ${ANSWER_ONE}`]);
    assert.equal(second.backend.posts().length, 1);
  });

  test("a failure that happened before the reload is told after it", async () => {
    const first = await pending();
    first.backend.failRun({ emitEvent: false });
    const second = first.reloaded();
    await second.boot();
    await second.advance(1000);
    assert.equal(second.view.phase, "failed");
    assert.match(second.statusText(), /could not finish an answer/);
    assert.equal(second.view.draft, Q1);
    assert.equal(second.view.sendDisabled, false);
  });

  test("a reload while the POST was in flight: the service never saw it, so Send again is offered (same request id)", async () => {
    const first = newHarness();
    await first.boot();
    first.backend.override("messages", () => new Promise(() => {}));
    void first.controller.send(first.view, Q1);
    await flush();
    assert.equal(first.view.phase, "submitting");
    assert.equal(first.saved().requestId, "req-1");
    first.backend.clearOverride("messages");
    const second = first.reloaded();
    await second.boot();
    assert.equal(second.view.phase, "failed");
    assert.equal(second.view.actions.retry, true);
    assert.equal(second.view.retryText, Q1);
    assert.equal(second.backend.posts().length, 1, "the abandoned POST is not repeated by the reload");
    await second.send("", { retry: true });
    assert.equal(second.backend.posts().length, 2);
    assert.equal(second.backend.posts()[1].body.client_request_id, "req-1");
  });

  test("a reload while the POST was in flight and the service did take it: running, no second run", async () => {
    const first = newHarness();
    await first.boot();
    first.backend.override("messages", async (ctx) => {
      const response = first.backend.defaults.messages(ctx);
      await response.body.cancel();
      return new Promise(() => {}); // the answer never comes back
    });
    void first.controller.send(first.view, Q1);
    await flush();
    first.backend.clearOverride("messages");
    const second = first.reloaded();
    await second.boot();
    assert.equal(second.view.phase, "running");
    assert.equal(second.backend.posts().length, 1);
    assert.equal(second.backend.conversation().run.requestId, "req-1");
  });

  test("a POST that never answers ends as an unknown outcome after the time limit and is checked, not resent", async () => {
    const h = newHarness();
    await h.boot();
    h.backend.override("messages", async (ctx) => {
      const response = h.backend.defaults.messages(ctx);
      await response.body.cancel();
      return new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    const sending = h.controller.send(h.view, Q1);
    await h.advance(TIMEOUTS.send + 1000);
    await sending;
    assert.equal(h.backend.posts().length, 1);
    assert.equal(h.view.phase, "running", "the status found the work");
    assert.equal(h.backend.callsTo("status")[0].query.get("client_request_id"), "req-1");
  });

  test("the bounded round for a stuck question ends in an unresolved state that survives a reload as a fresh check", async () => {
    const first = newHarness();
    await first.boot();
    first.backend.override("messages", (ctx) => {
      const conv = first.backend.conversations.get(ctx.params[0]);
      const run = { requestId: ctx.body.client_request_id, conversationId: conv.id, runId: "run-1", workRef: "work-1", state: "unconfirmed" };
      conv.run = run;
      first.backend.requests.set(run.requestId, run);
      return jsonResponse(409, { error: { code: "submission_unconfirmed", message: "x", retryable: false }, submitted: null, status_url: "/s", resubmission_allowed: false });
    });
    await first.send(Q1);
    await first.advance(400000);
    assert.equal(first.view.phase, "unresolved");
    const second = first.reloaded();
    const before = second.backend.callsTo("status").length;
    await second.boot();
    await second.advance(60000);
    assert.equal(second.backend.callsTo("status").length - before, 1, "one check, then the window (measured from the first send) is over");
    assert.equal(second.view.phase, "unresolved");
    assert.equal(second.backend.posts().length, 1);
  });
});

describe("the current turn is the one that completes", () => {
  test("a history that holds only older answers leaves the new turn pending", async () => {
    const h = newHarness();
    await h.boot();
    await completedTurn(h, Q1, ANSWER_ONE);
    h.backend.override("status", () => jsonResponse(200, { state: "idle" })); // no usable status: the history is all there is
    await h.send(Q2);
    h.backend.conversation().queue.length = 0;
    // The history still shows [Q1, A1, Q2] and nothing after the new question.
    await h.advance(30000);
    assert.equal(h.view.phase, "running");
    assert.equal(h.view.rows.filter((row) => row.role === "assistant").length, 1, "only the old answer");
    assert.deepEqual(h.rows().slice(-1), [`user: ${Q2}`]);
    h.backend.answer("The pot is shared.");
    await h.advance(10000);
    assert.equal(h.view.phase, "ready");
    assert.deepEqual(h.rows().slice(-2), [`user: ${Q2}`, "assistant: The pot is shared."]);
  });

  test("a history that does not list the new question yet (only older turns) is not mistaken for completion", async () => {
    const h = newHarness();
    await h.boot();
    await completedTurn(h, Q1, ANSWER_ONE);
    h.backend.override("status", () => jsonResponse(200, { state: "idle" }));
    const hidden = [];
    h.backend.override("history", (ctx) => {
      const conv = h.backend.conversation();
      const items = conv.items.map((item) => ({ native_item_id: item.id, native_work_ref: item.workRef, role: item.role, text: item.text, citations: [], assets: [], structured_data: [], provisional: false }));
      hidden.push(items.length);
      return jsonResponse(200, { items: items.slice(0, 2), native_cursor: null, status: { status: "idle", native_work_ref: null, request_id: null, saved_input_available: false }, provenance: [] });
    });
    await h.send(Q2);
    h.backend.answer("The pot is shared.");
    await h.advance(60000);
    assert.equal(h.view.phase, "running", "only the older turn is listed, so the new one is not finished");
    assert.equal(h.view.rows.filter((row) => row.role === "assistant" && row.text === ANSWER_ONE).length, 1);
    h.backend.clearOverride("history");
    await h.advance(10000);
    assert.equal(h.view.phase, "ready");
    assert.deepEqual(h.rows().slice(-2), [`user: ${Q2}`, "assistant: The pot is shared."]);
  });

  test("an answer item that is still provisional (partial) does not complete the turn", async () => {
    const h = newHarness();
    await h.boot();
    h.backend.override("status", () => jsonResponse(200, { state: "idle" }));
    await h.send(Q1);
    h.backend.partial("The household pa");
    await h.advance(20000);
    assert.equal(h.view.phase, "running");
    assert.ok(h.view.rows.some((row) => row.role === "assistant" && row.provisional), "the partial text is shown as it is");
    h.backend.conversation().run.partial = "";
    h.backend.answer("The household pays.");
    await h.advance(10000);
    assert.equal(h.view.phase, "ready");
    assert.equal(h.view.rows.filter((row) => row.role === "assistant").length, 1);
  });

  test("with the status completed, an older answer in the history still does not stand in for the new one", async () => {
    const h = newHarness();
    await h.boot();
    await completedTurn(h, Q1, ANSWER_ONE);
    await h.send(Q2);
    h.backend.requests.get("req-2").state = "completed"; // the status says completed, the history lags
    h.backend.conversation().run = null;
    await h.advance(20000);
    assert.notEqual(h.view.phase, "ready");
    assert.match(h.statusText(), /The answer is finished and is being loaded\./);
    h.backend.conversation().items.push({ id: "item-99", role: "assistant", text: "The pot is shared.", workRef: "work-2", provisional: false });
    await h.advance(10000);
    assert.equal(h.view.phase, "ready");
    assert.deepEqual(h.rows().slice(-2), [`user: ${Q2}`, "assistant: The pot is shared."]);
  });

  test("an item of another native work is not this turn's answer", async () => {
    const h = newHarness();
    await h.boot();
    h.backend.override("status", () => jsonResponse(200, { state: "idle" }));
    await h.send(Q1);
    const conv = h.backend.conversation();
    conv.items.push({ id: "item-foreign", role: "assistant", text: "Someone else's answer", workRef: "work-other", provisional: false });
    await h.advance(20000);
    assert.equal(h.view.phase, "running");
    conv.items.pop();
    h.backend.answer("Mine.");
    await h.advance(5000);
    assert.equal(h.view.phase, "ready");
    assert.deepEqual(h.rows(), [`user: ${Q1}`, "assistant: Mine."]);
  });
});

describe("a turn whose history could not be read before it was sent", () => {
  async function conversationWithOneTurn() {
    const first = newHarness();
    await first.boot();
    await completedTurn(first, Q1, ANSWER_ONE);
    return first;
  }

  test("the history is read once more before the question goes out, so its baseline is known", async () => {
    const first = await conversationWithOneTurn();
    const second = first.reloaded();
    let calls = 0;
    second.backend.override("history", () => (++calls === 1 ? jsonResponse(503, errorBody("history_unavailable", "x", { retryable: true, submitted: null })) : undefined));
    await second.boot();
    assert.equal(second.view.historyState.kind, "failed");
    const before = second.backend.calls.length;
    await second.send(Q2);
    const routes = second.backend.calls.slice(before).map((call) => call.route);
    assert.deepEqual(routes.slice(0, 2), ["history", "messages"], "the baseline is read before the POST");
    assert.deepEqual(second.saved().baseline, { count: 2, lastKey: "item-2" });
    assert.deepEqual(second.view.historyState, { kind: "idle", text: "" }, "the failure line is gone once the history has been read");
    second.backend.answer("The pot is shared.");
    await second.advance(3000);
    assert.equal(second.view.phase, "ready");
    assert.deepEqual(second.rows(), [`user: ${Q1}`, `assistant: ${ANSWER_ONE}`, `user: ${Q2}`, "assistant: The pot is shared."]);
  });

  test("without any baseline an older answer cannot finish the turn: only proof does (the stream's done, the work reference, the history's own status)", async () => {
    const first = await conversationWithOneTurn();
    const second = first.reloaded();
    let reads = 0;
    second.backend.override("history", () => {
      // The reads before the question goes out fail (the boot, then the one before the POST); the later ones work.
      if (++reads <= 2) return jsonResponse(503, errorBody("history_unavailable", "x", { retryable: true, submitted: null }));
      return undefined;
    });
    second.backend.override("status", () => jsonResponse(200, { state: "idle" }));
    // The accepted response does not name the work either.
    second.backend.override("messages", async (ctx) => {
      const response = second.backend.defaults.messages(ctx);
      await response.body.cancel();
      return new Response("{}", { status: 200, headers: { "content-type": "application/json", "x-esp-acceptance": "accepted" } });
    });
    second.backend.override("events", () => jsonResponse(404, errorBody("not_found", "x")));
    await second.boot();
    await second.send(Q1); // the very same text as the older question
    assert.equal(second.saved().baseline, null, "the baseline stayed unknown");
    // The service has the older turn [Q1, A1] and the new question, no answer yet.
    await second.advance(30000);
    assert.equal(second.view.phase, "running", "the older answer is not this turn's");
    assert.equal(second.view.rows.filter((row) => row.role === "assistant").length, 1);
  });

  test("showHistory finishes a pending turn only with an answer newer than the question", async () => {
    const first = await conversationWithOneTurn();
    await first.send(Q2);
    const workRef = first.saved().nativeWorkRef;
    await first.controller.showHistory(first.view);
    assert.equal(first.view.phase, "running", "only the older answer is in the history");
    first.backend.conversation().items.push({ id: "item-77", role: "assistant", text: "The pot is shared.", workRef, provisional: false });
    await first.controller.showHistory(first.view);
    await flush();
    assert.equal(first.view.phase, "ready");
    assert.deepEqual(first.rows().slice(-2), [`user: ${Q2}`, "assistant: The pot is shared."]);
  });
});

describe("completed, but the answer cannot be read", () => {
  test("after the bounded rounds the visitor is told the answer is finished, not that nothing is known", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(Q1);
    h.backend.answer(ANSWER_ONE);
    h.backend.override("history", () => jsonResponse(503, errorBody("history_unavailable", "x", { retryable: true, submitted: null })));
    await h.advance(400000);
    assert.equal(h.view.phase, "unresolved");
    assert.match(h.statusText(), /Your answer is finished, but the conversation could not be read to show it\. It was not lost\./);
    assert.equal(h.view.actions.checkStatus, true);
    h.backend.clearOverride("history");
    await h.controller.checkStatus(h.view);
    await h.advance(1500);
    assert.equal(h.view.phase, "ready");
    assert.deepEqual(h.rows(), [`user: ${Q1}`, `assistant: ${ANSWER_ONE}`]);
  });
});

describe("the event stream", () => {
  test("a connection that never answers does not stop the checking of the turn", async () => {
    const h = newHarness({ timing: { streamOpenMs: 5000 } });
    await h.boot();
    h.backend.override("events", (ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    await h.send(Q1);
    assert.equal(h.controller.activity().streaming, true);
    assert.equal(h.backend.callsTo("status").length, 0);
    await h.advance(5100);
    assert.equal(h.controller.activity().streaming, false);
    assert.equal(h.backend.callsTo("status").length, 1, "the status was asked once the stream gave up");
    assert.equal(h.backend.callsTo("events")[0].signal.aborted, true, "and the hanging request was aborted");
    h.backend.clearOverride("events");
    h.backend.answer(ANSWER_ONE);
    await h.advance(4000);
    assert.equal(h.view.phase, "ready");
  });

  test("an error event with a partial answer on the screen still ends the turn as failed when the status cannot be read", async () => {
    const h = newHarness();
    await h.boot();
    h.backend.override("status", () => jsonResponse(503, errorBody("service_unavailable", "x", { retryable: true, submitted: null })));
    const stream = heldStream([]);
    h.backend.override("events", () => stream.response);
    await h.send(Q1);
    const envelope = (sequence, event) => ({ protocol_version: 1, conversation_id: "conv-1", provider_session_id: "p", activeAgentRunId: "run-1", nativeWorkRef: "work-1", connection_id: "c", sequence, event });
    stream.push(frame(envelope(1, { type: "text_delta", text: "Half an answer" })));
    stream.push(frame(envelope(2, { type: "error", code: "run_failed", message: "The model stopped", retryable: false })));
    stream.release();
    await h.advance(3000);
    assert.equal(h.view.phase, "failed");
    assert.match(h.statusText(), /The answer could not be completed: The model stopped/);
    assert.equal(h.view.rows.filter((row) => row.role === "assistant").length, 0, "the half answer is not kept as one");
  });
});

describe("a chat that could not start before a reload", () => {
  test("it starts after the reload when the service is back", async () => {
    const first = newHarness();
    first.backend.override("session", () => new Response("down", { status: 503 }));
    await first.boot();
    assert.equal(first.view.phase, "unavailable");
    first.backend.clearOverride("session");
    const second = first.reloaded();
    await second.boot();
    assert.equal(second.view.phase, "ready");
    assert.equal(second.statusText(), "");
  });

  test("and keeps trying if it is still down", async () => {
    const first = newHarness();
    first.backend.override("session", () => new Response("down", { status: 503 }));
    await first.boot();
    const second = first.reloaded();
    await second.boot();
    assert.equal(second.view.phase, "unavailable");
    second.backend.clearOverride("session");
    await second.advance(4000);
    assert.equal(second.view.phase, "ready");
  });
});

describe("duplicate deliveries", () => {
  function envelope(sequence, event, connection = "conn-A") {
    return { protocol_version: 1, conversation_id: "conv-1", provider_session_id: "p", activeAgentRunId: "run-1", nativeWorkRef: "work-1", connection_id: connection, sequence, event };
  }

  test("an envelope delivered twice by the transport adds its text once", async () => {
    const h = newHarness();
    await h.boot();
    const stream = heldStream([]);
    h.backend.override("events", () => stream.response);
    await h.send(Q1);
    const delta = (sequence, text) => frame(envelope(sequence, { type: "text_delta", text }));
    stream.push(delta(1, "The "));
    stream.push(delta(1, "The "));
    stream.push(delta(2, "house"));
    stream.push(delta(2, "house"));
    stream.push(delta(3, "hold."));
    await flush();
    assert.deepEqual(h.rows().slice(-1), ["assistant: The household."]);
    stream.release();
  });

  test("a stream that restarts its text with output_reset shows the new text only", async () => {
    const h = newHarness();
    await h.boot();
    const stream = heldStream([]);
    h.backend.override("events", () => stream.response);
    await h.send(Q1);
    stream.push(frame(envelope(1, { type: "text_delta", text: "first try" })));
    stream.push(frame(envelope(2, { type: "output_reset", activeAgentRunId: "run-1" })));
    stream.push(frame(envelope(3, { type: "text_delta", text: "second try" })));
    await flush();
    assert.deepEqual(h.rows().slice(-1), ["assistant: second try"]);
    stream.release();
  });

  test("a duplicate response to the same request id is a status, not a second run", async () => {
    const h = newHarness();
    await h.boot();
    h.backend.override("messages", (ctx) => {
      if (ctx.n === 1) {
        // The first POST is accepted but its response is lost.
        return (async () => {
          const response = h.backend.defaults.messages(ctx);
          await response.body.cancel();
          return new Error("lost");
        })();
      }
      return undefined;
    });
    await h.send(Q1);
    assert.equal(h.view.phase, "running");
    // Some other path re-delivers the same request: the service answers with a duplicate status.
    const result = await h.controller.send(h.view, "", { retry: true });
    assert.equal(result.sent, false);
    assert.equal(h.backend.conversation().items.filter((item) => item.role === "user").length, 1);
  });

  test("the service's duplicate acceptance response (X-ESP-Acceptance: duplicate) is consumed as a status", async () => {
    const h = newHarness();
    await h.boot();
    h.backend.override("messages", (ctx) => {
      const conv = h.backend.conversations.get(ctx.params[0]);
      const run = { requestId: ctx.body.client_request_id, conversationId: conv.id, runId: "run-1", workRef: "work-1", state: "running" };
      conv.run = run;
      h.backend.requests.set(run.requestId, run);
      return jsonResponse(200, { outcome: "running", active_agent_run_id: "run-1", native_work_ref: "work-1", resubmission_allowed: false, runtime_state: "running" }, { "x-esp-acceptance": "duplicate" });
    });
    await h.send(Q1);
    assert.equal(h.view.phase, "running");
    assert.equal(h.backend.posts().length, 1);
    assert.ok(h.backend.callsTo("status").length >= 1);
  });

  test("the events of an answer that is not streamed (404) leave the history and status to decide", async () => {
    const h = newHarness();
    await h.boot();
    h.backend.override("events", () => jsonResponse(404, errorBody("not_found", "x")));
    await h.send(Q1);
    assert.equal(h.view.phase, "running");
    h.backend.answer(ANSWER_ONE);
    await h.advance(3000);
    assert.equal(h.view.phase, "ready");
    assert.deepEqual(h.rows(), [`user: ${Q1}`, `assistant: ${ANSWER_ONE}`]);
  });
});

describe("storage that is missing, disabled or corrupt", () => {
  test("a disabled sessionStorage: the chat works, the tab keeps its state in memory, and nothing throws", async () => {
    const storage = makeStorage({ fail: true });
    const first = newHarness({ storage });
    await first.boot();
    first.controller.editDraft(first.view, "kept");
    await completedTurn(first, Q1, ANSWER_ONE);
    first.controller.editDraft(first.view, "still kept");
    const second = first.reloaded();
    await second.boot();
    assert.equal(second.view.draft, "still kept");
    assert.equal(second.view.providerFixed, true);
    assert.deepEqual(second.rows(), [`user: ${Q1}`, `assistant: ${ANSWER_ONE}`]);
  });

  test("no storage at all behaves the same", async () => {
    const first = newHarness({ storage: null });
    await first.boot();
    await completedTurn(first, Q1, ANSWER_ONE);
    const second = first.reloaded({ storage: null });
    await second.boot();
    assert.equal(second.view.providerFixed, true);
    assert.equal(second.view.rows.length, 2);
  });

  test("a corrupt value boots a clean chat: no crash, no invented identity, and the next save repairs it", async () => {
    for (const raw of ["{not json", "undefined", "[1,2]", JSON.stringify({ identity: "undefined", conversationId: "undefined", provider: "undefined", requestId: "undefined", draft: 5 })]) {
      const storage = makeStorage({ seed: { "esp-client": raw } });
      const h = newHarness({ storage });
      await h.boot();
      assert.equal(h.view.phase, "ready", raw);
      assert.equal(h.view.providerFixed, false, raw);
      await h.send(Q1);
      assert.equal(h.view.phase, "running", raw);
      assert.doesNotMatch(storage.data.get("esp-client"), /undefined/, "nothing in storage is the string undefined");
      assert.equal(JSON.parse(storage.data.get("esp-client")).conversationId, "conv-1");
    }
  });

  test("the session storing nothing about the subject never produces the identity 'undefined'", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(Q1);
    assert.equal(h.saved().identity, null);
    h.backend.subjectId = "subject-7";
    const second = h.reloaded();
    await second.boot();
    assert.equal(second.saved().identity, "subject-7");
  });

  test("no transcript is ever written to localStorage", async () => {
    const writes = [];
    globalThis.localStorage = { setItem: (key, value) => writes.push([key, value]), getItem: () => null, removeItem() {} };
    try {
      const h = newHarness();
      await h.boot();
      await completedTurn(h, Q1, ANSWER_ONE);
      assert.deepEqual(writes, []);
      assert.doesNotMatch(h.storage.data.get("esp-client"), new RegExp(ANSWER_ONE.slice(0, 12)), "the answer is not in sessionStorage either");
    } finally {
      delete globalThis.localStorage;
    }
  });
});

describe("the session and the requests it makes", () => {
  test("every write carries the CSRF token of the session and no read does", async () => {
    const h = newHarness();
    await h.boot();
    await completedTurn(h, Q1, ANSWER_ONE);
    for (const call of h.backend.calls) {
      if (call.method === "POST" && call.route !== "session") assert.equal(call.headers["x-esp-csrf"], "csrf-token-1", call.route);
      if (call.method === "GET") assert.equal(call.headers["x-esp-csrf"], undefined, call.route);
    }
  });

  test("a session older than five minutes is renewed before the next send, a fresh one is not", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(Q1);
    assert.equal(h.backend.callsTo("session").length, 1);
    h.backend.answer(ANSWER_ONE);
    await h.advance(6 * 60 * 1000);
    await h.send(Q2);
    assert.equal(h.backend.callsTo("session").length, 2);
  });

  test("a read the service answers with 401 (the cookie ran out) renews the session once and asks again", async () => {
    const first = newHarness();
    await first.boot();
    await completedTurn(first, Q1, ANSWER_ONE);
    const second = first.reloaded();
    let reads = 0;
    second.backend.override("history", () => (++reads === 1 ? jsonResponse(401, errorBody("unauthenticated", "A visitor session is required.", { submitted: null })) : undefined));
    const sessions = second.backend.callsTo("session").length;
    await second.boot();
    assert.equal(second.backend.callsTo("session").length, sessions + 2, "the boot's own session and the renewal");
    assert.deepEqual(second.rows(), [`user: ${Q1}`, `assistant: ${ANSWER_ONE}`]);
    assert.equal(second.view.historyState.kind, "idle");
  });

  test("a status the service answers with 401 renews the session and is asked again", async () => {
    const h = newHarness();
    await h.boot();
    let reads = 0;
    h.backend.override("status", () => (++reads === 1 ? jsonResponse(401, errorBody("unauthenticated", "A visitor session is required.", { submitted: null })) : undefined));
    await h.send(Q1);
    assert.equal(h.view.phase, "running");
    assert.equal(h.backend.callsTo("status").length, 2);
    assert.equal(h.backend.callsTo("session").length, 2);
    assert.match(h.statusText(), /Last check: the AI is still working on it\./);
  });

  test("the request body is exactly the three fields the service accepts", async () => {
    const h = newHarness();
    await h.boot();
    await h.send(Q1);
    assert.deepEqual(Object.keys(h.backend.posts()[0].body).sort(), ["client_request_id", "conversation_id", "message"]);
    assert.deepEqual(Object.keys(h.backend.callsTo("create")[0].body), ["provider"]);
    assert.equal(h.backend.posts()[0].body.conversation_id, "conv-1");
  });
});

