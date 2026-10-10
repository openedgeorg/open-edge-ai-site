import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  LATE_SETTLE_MS,
  MAX_SENDS_PER_WINDOW,
  NO_PROGRESS_MS,
  REJECT_PAUSE_MS,
  SEND_WINDOW_MS,
  STALE_SUBMIT_MS,
  START_GIVE_UP_MS,
  createChatBridge,
  createDomPort,
} from "../../site/js/atlas-chat.js";
import { FIRST_SUGGESTION, ISLANDS } from "../../site/js/atlas-graph.js";

/* ---------- helpers: manual clock, fake port ---------- */

function makeClock(start = 1_000_000) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: current + ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        current = Math.max(current, due[1].at);
        due[1].fn();
      }
      current = target;
    },
    pending: () => timers.size,
  };
}

/**
 * A port that behaves like the real form and the real list.
 *
 * `port.list` is the chat's `#history` (one string per `li > p` row). Like app.js, a composer submit
 * appends the visitor's own text as a row AFTER the capture-phase listeners (the bridge's) have seen
 * the draft. The assistant's reply is appended with `say()`, and `setHistory()` replaces the whole
 * list (the chat's showHistory) and wakes the history listeners.
 */
function makeFakePort({ phase = "ready", draft = "", list = [], reportsSubmit = true } = {}) {
  const phaseListeners = new Set();
  const submitListeners = new Set();
  const historyListeners = new Set();
  const port = {
    phase,
    draft,
    list: [...list],
    submitted: [],
    readPhase: () => port.phase,
    readDraft: () => port.draft,
    rows: () => [...port.list],
    // Kept for the DOM port's compatibility; the bridge reads rows() only.
    lastReply: () => [...port.list].reverse().find((text) => text.trim() !== "") ?? "",
    rowCount: () => port.list.filter((text) => text.trim() !== "").length,
    submit(text) {
      port.submitted.push(text);
      if (reportsSubmit) port.composerSubmit(text);
      else port.list.push(String(text ?? ""));
    },
    onPhase(callback) {
      phaseListeners.add(callback);
      return () => phaseListeners.delete(callback);
    },
    onSubmit(callback) {
      submitListeners.add(callback);
      return () => submitListeners.delete(callback);
    },
    onHistory(callback) {
      historyListeners.add(callback);
      return () => historyListeners.delete(callback);
    },
    setPhase(next) {
      port.phase = next;
      for (const callback of [...phaseListeners]) callback(next);
    },
    composerSubmit(text) {
      for (const callback of [...submitListeners]) callback(text);
      port.list.push(String(text ?? "")); // the chat's own handler appends the visitor's row
    },
    /** The chat appended an assistant row (a stream, or showHistory) without a list rewrite. */
    say(text) {
      port.list.push(text);
    },
    /** The chat rewrote the whole list (showHistory) and #history observers fire. */
    setHistory(list) {
      port.list = [...list];
      for (const callback of [...historyListeners]) callback();
    },
    listenerCount: () => phaseListeners.size + submitListeners.size + historyListeners.size,
  };
  return port;
}

function setup(portOptions = {}, bridgeOptions = {}) {
  const clock = makeClock();
  const port = makeFakePort(portOptions);
  const replies = [];
  const changes = [];
  const bridge = createChatBridge({
    port,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onReply: (text) => replies.push(text),
    onChange: (status) => changes.push(status),
    ...bridgeOptions,
  });
  return { clock, port, bridge, replies, changes };
}

/** One full chat cycle as the real page paints it: ready -> running -> ready with the question and a new reply row. */
function composerCycle(port, question, answer) {
  port.composerSubmit(question);
  port.setPhase("running");
  port.say(answer);
  port.setPhase("ready");
}

/* ---------- bridge ---------- */

describe("constants", () => {
  test("match the contract", () => {
    assert.equal(SEND_WINDOW_MS, 60000);
    assert.equal(MAX_SENDS_PER_WINDOW, 20);
    assert.equal(REJECT_PAUSE_MS, 30000);
  });

  test("the reliability timings are in the range the lead decided", () => {
    assert.equal(STALE_SUBMIT_MS, 120000);
    assert.equal(NO_PROGRESS_MS, 15000);
    assert.equal(START_GIVE_UP_MS, 10000);
    assert.equal(LATE_SETTLE_MS, 1500);
    assert.ok(NO_PROGRESS_MS < STALE_SUBMIT_MS);
  });
});

describe("sendTeaser gating", () => {
  test("ready sends the teaser exactly once through the port", () => {
    const { bridge, port } = setup();
    assert.deepEqual(bridge.status(), { canSend: true, reason: "", message: "", resumeAt: null });
    assert.deepEqual(bridge.sendTeaser("  Who pays the apps?  "), { sent: true, reason: "" });
    assert.deepEqual(port.submitted, ["Who pays the apps?"]);
  });

  test("busy phases refuse with reason busy and do not submit", () => {
    for (const phase of ["submitting", "running", "reconciling", "recovering"]) {
      const { bridge, port } = setup({ phase });
      const status = bridge.status();
      assert.equal(status.canSend, false, phase);
      assert.equal(status.reason, "busy", phase);
      assert.ok(status.message.length > 0, phase);
      assert.equal(status.resumeAt, null, phase);
      assert.deepEqual(bridge.sendTeaser("hello"), { sent: false, reason: "busy" }, phase);
      assert.deepEqual(port.submitted, [], phase);
    }
  });

  test("an unknown phase is treated as busy", () => {
    const { bridge, port } = setup({ phase: "mystery" });
    assert.equal(bridge.status().reason, "busy");
    assert.deepEqual(bridge.sendTeaser("hello"), { sent: false, reason: "busy" });
    assert.deepEqual(port.submitted, []);
  });

  test("an empty phase (before boot) refuses with reason starting", () => {
    const { bridge, port, changes } = setup({ phase: "" });
    assert.equal(bridge.status().reason, "starting");
    assert.deepEqual(bridge.sendTeaser("hello"), { sent: false, reason: "starting" });
    assert.deepEqual(port.submitted, []);
    port.setPhase("ready");
    assert.equal(bridge.status().canSend, true);
    assert.ok(changes.length >= 1);
    assert.equal(changes.at(-1).canSend, true);
  });

  test("unavailable refuses with reason unavailable", () => {
    const { bridge, port } = setup({ phase: "unavailable" });
    assert.equal(bridge.status().reason, "unavailable");
    assert.deepEqual(bridge.sendTeaser("hello"), { sent: false, reason: "unavailable" });
    assert.deepEqual(port.submitted, []);
  });

  test("a non-empty draft refuses with reason draft and does not submit", () => {
    const { bridge, port } = setup({ draft: "half a thought" });
    const status = bridge.status();
    assert.equal(status.canSend, false);
    assert.equal(status.reason, "draft");
    assert.equal(status.resumeAt, null);
    assert.deepEqual(bridge.sendTeaser("hello"), { sent: false, reason: "draft" });
    assert.deepEqual(port.submitted, []);
    port.draft = "";
    assert.deepEqual(bridge.sendTeaser("hello"), { sent: true, reason: "" });
    assert.deepEqual(port.submitted, ["hello"]);
  });

  test("a whitespace-only draft counts as empty", () => {
    const { bridge, port } = setup({ draft: "  \n " });
    assert.deepEqual(bridge.sendTeaser("hello"), { sent: true, reason: "" });
    assert.deepEqual(port.submitted, ["hello"]);
  });

  test("empty teaser text is refused without a submit", () => {
    const { bridge, port } = setup();
    assert.deepEqual(bridge.sendTeaser("   "), { sent: false, reason: "empty" });
    assert.deepEqual(bridge.sendTeaser(undefined), { sent: false, reason: "empty" });
    assert.deepEqual(port.submitted, []);
  });
});

describe("double taps and in-flight submits", () => {
  test("a second tap on the same teaser while the run is busy is refused", () => {
    const { bridge, port } = setup();
    assert.equal(bridge.sendTeaser("Same question").sent, true);
    // The real chat keeps painting "ready" until its first paint after the network round trip.
    assert.equal(port.phase, "ready");
    assert.deepEqual(bridge.sendTeaser("Same question"), { sent: false, reason: "busy" });
    port.setPhase("running");
    assert.deepEqual(bridge.sendTeaser("Same question"), { sent: false, reason: "busy" });
    assert.deepEqual(port.submitted, ["Same question"]);
  });

  test("a port that does not report its own submit is still tracked as in flight", () => {
    const { bridge, port } = setup({ reportsSubmit: false });
    assert.equal(bridge.sendTeaser("Question").sent, true);
    assert.deepEqual(bridge.sendTeaser("Question"), { sent: false, reason: "busy" });
    assert.deepEqual(port.submitted, ["Question"]);
    port.setPhase("running");
    port.say("Answer");
    port.setPhase("ready");
    assert.equal(bridge.status().canSend, true);
  });

  test("a composer submit makes teasers busy even while the phase still reads ready", () => {
    const { bridge, port } = setup();
    port.composerSubmit("typed question");
    assert.equal(bridge.status().reason, "busy");
    assert.deepEqual(bridge.sendTeaser("teaser"), { sent: false, reason: "busy" });
    assert.deepEqual(port.submitted, []);
  });

  test("a submit that never reaches a busy phase stops blocking after NO_PROGRESS_MS", () => {
    const { bridge, clock, changes } = setup();
    bridge.sendTeaser("Question");
    assert.equal(bridge.status().reason, "busy");
    clock.advance(NO_PROGRESS_MS - 1);
    assert.equal(bridge.status().reason, "busy");
    const seen = changes.length;
    clock.advance(1);
    assert.equal(bridge.status().canSend, true);
    assert.ok(changes.length > seen, "onChange fires when the pointless wait is dropped");
    assert.equal(changes.at(-1).canSend, true);
  });

  test("a long busy phase does not make the submit stale: the reply is still delivered", () => {
    const { bridge, port, clock, replies } = setup();
    bridge.sendTeaser("Question");
    port.setPhase("running");
    clock.advance(STALE_SUBMIT_MS * 3);
    assert.equal(bridge.status().reason, "busy");
    port.say("A long answer");
    port.setPhase("ready");
    assert.deepEqual(replies, ["A long answer"]);
  });
});

describe("reply delivery", () => {
  test("running -> ready delivers the last reply exactly once", () => {
    const { bridge, port, replies } = setup();
    bridge.sendTeaser("What is a pot?");
    port.setPhase("running");
    assert.deepEqual(replies, []);
    port.say("A pot is a shared account.");
    port.setPhase("ready");
    assert.deepEqual(replies, ["A pot is a shared account."]);
    // Further paints of the same phase never deliver again.
    port.setPhase("ready");
    port.setPhase("ready");
    assert.deepEqual(replies, ["A pot is a shared account."]);
    assert.equal(bridge.status().canSend, true);
  });

  test("a composer submit is delivered the same way", () => {
    const { port, replies } = setup();
    composerCycle(port, "typed", "typed answer");
    assert.deepEqual(replies, ["typed answer"]);
  });

  test("the reply is passed through unchanged", () => {
    const { port, replies } = setup();
    composerCycle(port, "q", "  Line one\n\nLine two  ");
    assert.deepEqual(replies, ["  Line one\n\nLine two  "]);
  });

  test("a reconciling run also delivers on the way back to ready", () => {
    const { port, replies } = setup();
    port.composerSubmit("q");
    port.setPhase("reconciling");
    port.setPhase("running");
    port.say("recovered answer");
    port.setPhase("ready");
    assert.deepEqual(replies, ["recovered answer"]);
  });

  test("a failed run whose last row is still the question delivers nothing", () => {
    const { bridge, port, replies } = setup();
    bridge.sendTeaser("Why is the sky blue?");
    port.setPhase("running");
    port.setPhase("ready");
    assert.deepEqual(port.rows(), ["Why is the sky blue?"]);
    assert.deepEqual(replies, []);
    assert.equal(bridge.status().canSend, true);
  });

  test("the question row is found whatever its whitespace, so the row before it is never a reply", () => {
    const { port, replies } = setup();
    port.composerSubmit("Why   is the sky blue?\n");
    port.setPhase("running");
    port.setHistory(["Why is the sky blue?"]);
    port.setPhase("ready");
    assert.deepEqual(replies, []);
    // the same question, reflowed, followed by the reply: that reply is the one
    const second = setup();
    second.port.composerSubmit("Why   is the sky blue?\n");
    second.port.setPhase("running");
    second.port.setHistory(["Why is the sky blue?", "Because of Rayleigh scattering."]);
    second.port.setPhase("ready");
    assert.deepEqual(second.replies, ["Because of Rayleigh scattering."]);
  });

  test("an empty last row delivers nothing", () => {
    const { port, replies } = setup();
    composerCycle(port, "q", "   ");
    assert.deepEqual(replies, []);
  });

  test("the same reply row is not delivered twice, but a new row with the same text is", () => {
    const { port, replies } = setup();
    composerCycle(port, "first", "Same answer");
    // the question is asked again while the chat shows the list of before (no new question row yet)
    port.composerSubmit("first");
    port.setHistory(["first", "Same answer"]);
    port.setPhase("running");
    port.setPhase("ready");
    assert.deepEqual(replies, ["Same answer"]);
    composerCycle(port, "third", "Different answer");
    assert.deepEqual(replies, ["Same answer", "Different answer"]);
  });

  test("a failed run that leaves an older reply as the last row delivers nothing new", () => {
    const { port, replies } = setup();
    composerCycle(port, "first", "Old answer");
    port.composerSubmit("second");
    port.setPhase("running");
    // history reloaded without the failed question: the old answer is the last row again
    port.setHistory(["first", "Old answer"]);
    port.setPhase("ready");
    assert.deepEqual(replies, ["Old answer"]);
  });

  test("a transition into ready without a submit delivers nothing", () => {
    const { port, replies } = setup({ phase: "", list: ["an old question", "stale text from before"] });
    port.setPhase("ready");
    port.setPhase("running");
    port.setPhase("ready");
    assert.deepEqual(replies, []);
  });

  test("repainting ready while the run is still starting does not end the in-flight submit", () => {
    const { bridge, port, replies } = setup();
    bridge.sendTeaser("Question");
    port.setPhase("ready"); // e.g. the draft box got focus and the chat repainted
    assert.equal(bridge.status().reason, "busy");
    port.setPhase("running");
    port.say("Answer");
    port.setPhase("ready");
    assert.deepEqual(replies, ["Answer"]);
  });

  test("a run that ends unavailable delivers nothing and is no longer in flight", () => {
    const { bridge, port, replies } = setup();
    bridge.sendTeaser("Question");
    port.setPhase("unavailable");
    assert.deepEqual(replies, []);
    assert.equal(bridge.status().reason, "unavailable");
    port.setPhase("ready");
    assert.deepEqual(replies, []);
    assert.equal(bridge.status().canSend, true);
  });

  test("onReply fires before onChange reports the freed bridge", () => {
    const order = [];
    const { port } = setup({}, {
      onReply: () => order.push("reply"),
      onChange: (status) => order.push(status.canSend ? "free" : "blocked"),
    });
    composerCycle(port, "q", "answer");
    assert.deepEqual(order.slice(-2), ["reply", "free"]);
  });
});

/* ---------- the final reply when the chat paints `ready` too early ---------- */

describe("late replies", () => {
  /**
   * The chat painted ready while the run was still going (the message box got focus, or /history
   * returned an older list): the list still ends with the visitor's own question (its local echo).
   */
  function prematureReady(port, question) {
    port.composerSubmit(question);
    port.setPhase("running");
    port.setPhase("ready");
  }

  test("a premature ready delivers nothing at once, then the reply once the list has been quiet", () => {
    const { bridge, port, clock, replies } = setup();
    prematureReady(port, "Why?");
    assert.deepEqual(replies, []);
    assert.equal(bridge.status().canSend, true, "the late watch blocks nothing");
    // the chat finally rewrites the list with the real reply
    port.setHistory(["Why?", "Because."]);
    assert.deepEqual(replies, [], "not at the first change: a stream may still be growing");
    clock.advance(LATE_SETTLE_MS - 1);
    assert.deepEqual(replies, []);
    clock.advance(1);
    assert.deepEqual(replies, ["Because."]);
    // once only, however much the list keeps changing afterwards
    port.setHistory(["Why?", "Because, and more."]);
    clock.advance(LATE_SETTLE_MS * 4);
    assert.deepEqual(replies, ["Because."]);
  });

  test("the reply is looked up again when the quiet period ends, so a growing stream is not taken as final", () => {
    const { port, clock, replies } = setup();
    prematureReady(port, "Why?");
    port.setHistory(["Why?", "Because the"]);
    clock.advance(1000);
    port.setHistory(["Why?", "Because the pot is shared"]);
    clock.advance(1000);
    port.setHistory(["Why?", "Because the pot is shared by the household."]);
    clock.advance(LATE_SETTLE_MS - 1);
    assert.deepEqual(replies, []);
    clock.advance(1);
    assert.deepEqual(replies, ["Because the pot is shared by the household."]);
  });

  test("the visitor's own echo is never delivered, however often the list changes", () => {
    const { port, clock, replies } = setup();
    prematureReady(port, "Why   is it so?");
    port.setHistory(["Why is it so?"]); // the same question, whitespace aside
    clock.advance(LATE_SETTLE_MS * 2);
    port.setHistory(["Why is it so?", "  \n "]); // a blank row after it
    clock.advance(LATE_SETTLE_MS * 2);
    assert.deepEqual(replies, []);
    port.setHistory(["Why is it so?", "Because."]);
    clock.advance(LATE_SETTLE_MS);
    assert.deepEqual(replies, ["Because."]);
  });

  test("an earlier question of the visitor is an echo too, not a reply", () => {
    const { port, clock, replies } = setup();
    composerCycle(port, "first question", "first answer");
    prematureReady(port, "second question");
    // an older snapshot that ends with the first question, and one where it follows the second
    port.setHistory(["first question"]);
    clock.advance(LATE_SETTLE_MS * 2);
    port.setHistory(["second question", "first question"]);
    clock.advance(LATE_SETTLE_MS * 2);
    assert.deepEqual(replies, ["first answer"]);
  });

  test("a reply delivered before is not delivered again from a stale list", () => {
    const { port, clock, replies } = setup();
    composerCycle(port, "first", "Answer one"); // delivered on a list of 2 rows
    assert.deepEqual(replies, ["Answer one"]);
    // turn 2: the chat repaints ready and shows the old list (2 rows, ending with the old answer)
    port.composerSubmit("second");
    port.setPhase("running");
    port.setHistory(["first", "Answer one"]);
    port.setPhase("ready");
    clock.advance(LATE_SETTLE_MS * 3);
    assert.deepEqual(replies, ["Answer one"]);
    // /history catches up: two more rows
    port.setHistory(["first", "Answer one", "second", "Answer two"]);
    clock.advance(LATE_SETTLE_MS);
    assert.deepEqual(replies, ["Answer one", "Answer two"]);
  });

  test("a late reply that equals an older canned answer still counts on the longer list", () => {
    const { port, clock, replies } = setup();
    composerCycle(port, "first", "I can only talk about the ESP design.");
    prematureReady(port, "second");
    port.setHistory(["first", "I can only talk about the ESP design.", "second", "I can only talk about the ESP design."]);
    clock.advance(LATE_SETTLE_MS);
    assert.deepEqual(replies, ["I can only talk about the ESP design.", "I can only talk about the ESP design."]);
  });

  test("the next submit forgets the late record", () => {
    const { port, clock, replies } = setup();
    prematureReady(port, "first");
    port.composerSubmit("second");
    port.setHistory(["first", "Answer to the first", "second"]);
    clock.advance(LATE_SETTLE_MS * 3);
    assert.deepEqual(replies, [], "an old late record must not answer a newer question");
    port.setPhase("running");
    port.say("Answer to the second");
    port.setPhase("ready");
    assert.deepEqual(replies, ["Answer to the second"]);
  });

  test("a submit during the quiet period cancels the wait", () => {
    const { port, clock, replies } = setup();
    prematureReady(port, "first");
    port.setHistory(["first", "Answer to the first"]);
    clock.advance(LATE_SETTLE_MS - 100);
    port.composerSubmit("second");
    clock.advance(1000);
    assert.deepEqual(replies, []);
  });

  test("the watch gives up after STALE_SUBMIT_MS", () => {
    const { port, clock, replies } = setup();
    prematureReady(port, "Why?");
    clock.advance(STALE_SUBMIT_MS + 1);
    port.setHistory(["Why?", "Because."]);
    clock.advance(LATE_SETTLE_MS * 2);
    assert.deepEqual(replies, []);
  });

  test("the window is measured from the premature ready, not from the submit", () => {
    const { port, clock, replies } = setup();
    port.composerSubmit("Why?");
    port.setPhase("running");
    clock.advance(STALE_SUBMIT_MS - 1000); // a long run
    port.setPhase("ready");
    clock.advance(30000);
    port.setHistory(["Why?", "Because."]);
    clock.advance(LATE_SETTLE_MS);
    assert.deepEqual(replies, ["Because."]);
  });

  test("changes while the phase is not ready are ignored; ready again starts the wait", () => {
    const { port, clock, replies } = setup();
    prematureReady(port, "Why?");
    port.setPhase("recovering");
    port.setHistory(["Why?", "Because."]);
    clock.advance(LATE_SETTLE_MS * 2);
    assert.deepEqual(replies, []);
    port.setPhase("ready");
    clock.advance(LATE_SETTLE_MS);
    assert.deepEqual(replies, ["Because."]);
  });

  test("a phase that leaves ready during the quiet period delivers nothing", () => {
    const { port, clock, replies } = setup();
    prematureReady(port, "Why?");
    port.setHistory(["Why?", "Because."]);
    clock.advance(LATE_SETTLE_MS - 1);
    port.setPhase("unavailable");
    clock.advance(10);
    assert.deepEqual(replies, []);
  });

  test("a normal reply needs no watch: later changes to the list deliver nothing", () => {
    const { port, clock, replies } = setup();
    composerCycle(port, "q", "answer");
    port.setHistory(["q", "answer, edited"]);
    clock.advance(LATE_SETTLE_MS * 3);
    assert.deepEqual(replies, ["answer"]);
    assert.equal(clock.pending(), 0, "no timer is left running");
  });

  test("the watch of a failed run is harmless: nothing is delivered and suggestions stay usable", () => {
    const { bridge, port, clock, replies } = setup();
    prematureReady(port, "Why?");
    clock.advance(STALE_SUBMIT_MS * 2);
    assert.deepEqual(replies, []);
    assert.equal(bridge.status().canSend, true);
  });

  test("onReply fires before onChange reports the freed bridge, as for an ordinary reply", () => {
    const order = [];
    const { port, clock } = setup({}, {
      onReply: () => order.push("reply"),
      onChange: (status) => order.push(status.canSend ? "free" : "blocked"),
    });
    prematureReady(port, "Why?");
    order.length = 0;
    port.setHistory(["Why?", "Because."]);
    clock.advance(LATE_SETTLE_MS);
    assert.deepEqual(order, ["reply", "free"]);
  });

  test("a throwing rows() or onReply during the late path never breaks the bridge", () => {
    const { bridge, port, clock } = setup({}, {
      onReply: () => {
        throw new Error("boom");
      },
    });
    prematureReady(port, "Why?");
    const lookup = port.rows;
    port.rows = () => {
      throw new Error("boom");
    };
    port.setHistory(["x"]);
    assert.doesNotThrow(() => clock.advance(LATE_SETTLE_MS));
    port.rows = lookup;
    port.setHistory(["Why?", "Because."]);
    assert.doesNotThrow(() => clock.advance(LATE_SETTLE_MS));
    assert.equal(bridge.status().canSend, true);
  });

  test("the quiet period is injectable through timings and the timer", () => {
    const { port, clock, replies } = setup({}, { timings: { lateSettleMs: 200 } });
    prematureReady(port, "Why?");
    port.setHistory(["Why?", "Because."]);
    clock.advance(199);
    assert.deepEqual(replies, []);
    clock.advance(1);
    assert.deepEqual(replies, ["Because."]);
  });

  test("a port without onHistory still works; it just never sees a late reply", () => {
    const clock = makeClock();
    const port = makeFakePort();
    port.onHistory = undefined;
    const replies = [];
    const bridge = createChatBridge({
      port,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onReply: (text) => replies.push(text),
    });
    composerCycle(port, "q", "answer");
    assert.deepEqual(replies, ["answer"]);
    prematureReady(port, "again");
    clock.advance(STALE_SUBMIT_MS);
    assert.deepEqual(replies, ["answer"]);
    assert.doesNotThrow(() => bridge.dispose());
  });

  test("a throwing onHistory registration leaves a working bridge", () => {
    const clock = makeClock();
    const port = makeFakePort();
    port.onHistory = () => {
      throw new Error("boom");
    };
    const replies = [];
    const bridge = createChatBridge({
      port,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onReply: (text) => replies.push(text),
    });
    composerCycle(port, "q", "answer");
    assert.deepEqual(replies, ["answer"]);
    assert.doesNotThrow(() => bridge.dispose());
  });

  test("dispose cancels a pending quiet period and unsubscribes from the history", () => {
    const { bridge, port, clock, replies } = setup();
    prematureReady(port, "Why?");
    port.setHistory(["Why?", "Because."]);
    assert.ok(clock.pending() > 0);
    bridge.dispose();
    assert.equal(clock.pending(), 0);
    assert.equal(port.listenerCount(), 0);
    port.setHistory(["Why?", "Because, again."]);
    clock.advance(STALE_SUBMIT_MS);
    assert.deepEqual(replies, []);
  });

  test("a setTimer that throws does not break the late path", () => {
    const { port } = setup({}, { setTimer: () => {
      throw new Error("boom");
    } });
    prematureReady(port, "Why?");
    assert.doesNotThrow(() => port.setHistory(["Why?", "Because."]));
  });
});

/* ---------- a reply belongs to the question that was asked ---------- */

describe("a reply is tied to its question", () => {
  /** A page that was just reloaded: a fresh bridge (empty memory) on a list the chat restored. */
  function reloaded(list, bridgeOptions = {}) {
    return setup({ list }, bridgeOptions);
  }

  test("the normal list [.., question, reply] delivers the row after the question", () => {
    const { port, replies } = setup({ list: ["Q1", "A1"] });
    port.composerSubmit("Q2");
    port.setPhase("running");
    port.say("A2");
    port.setPhase("ready");
    assert.deepEqual(port.rows(), ["Q1", "A1", "Q2", "A2"]);
    assert.deepEqual(replies, ["A2"]);
  });

  test("a row is not a reply merely because it is the last one", () => {
    const { port, replies } = setup({ list: ["something unrelated", "the last row"] });
    port.composerSubmit("a question that is in the list nowhere");
    port.setPhase("running");
    port.setHistory(["something unrelated", "the last row"]); // the chat shows a list without the question
    port.setPhase("ready");
    assert.deepEqual(replies, []);
  });

  test("reload + stale snapshot [Q1, A1] while Q2 was asked lights nothing, then the real reply does", () => {
    const { port, clock, replies } = reloaded(["Q1", "A1"]);
    port.composerSubmit("Q2");
    port.setPhase("running");
    port.setHistory(["Q1", "A1"]); // the chat swaps in the snapshot from before Q2
    port.setPhase("ready");
    clock.advance(LATE_SETTLE_MS * 3);
    assert.deepEqual(replies, [], "the old reply is not the reply to Q2");
    port.setHistory(["Q1", "A1", "Q2", "A2"]);
    clock.advance(LATE_SETTLE_MS);
    assert.deepEqual(replies, ["A2"]);
  });

  test("a stale list that ends with the visitor's own earlier teaser lights nothing", () => {
    // After a reload the bridge has no memory of what was submitted, so that teaser is not a known echo.
    const { port, clock, replies } = reloaded(["Q1", "A1", "Who actually pays the apps I use?"]);
    port.composerSubmit("Q2");
    port.setPhase("running");
    port.setHistory(["Q1", "A1", "Who actually pays the apps I use?"]);
    port.setPhase("ready");
    clock.advance(LATE_SETTLE_MS * 3);
    assert.deepEqual(replies, []);
  });

  test("the same question asked twice: the reply is the row after the LAST copy", () => {
    const { port, clock, replies } = setup();
    composerCycle(port, "Q", "A1");
    assert.deepEqual(replies, ["A1"]);
    port.composerSubmit("Q"); // [Q, A1, Q]: the new copy has no reply yet
    port.setPhase("running");
    port.setPhase("ready");
    assert.deepEqual(replies, ["A1"], "the reply to the first copy is not the reply to the second");
    port.setHistory(["Q", "A1", "Q", "A2"]);
    clock.advance(LATE_SETTLE_MS);
    assert.deepEqual(replies, ["A1", "A2"]);
  });

  test("the same question asked twice, with the chat still showing the list of before", () => {
    const { port, clock, replies } = setup();
    composerCycle(port, "Q", "A1");
    port.composerSubmit("Q");
    port.setPhase("running");
    port.setHistory(["Q", "A1"]); // the reply row that was delivered already
    port.setPhase("ready");
    clock.advance(LATE_SETTLE_MS * 3);
    assert.deepEqual(replies, ["A1"], "the same row of the same list is not delivered twice");
    port.setHistory(["Q", "A1", "Q", "A2"]);
    clock.advance(LATE_SETTLE_MS);
    assert.deepEqual(replies, ["A1", "A2"]);
  });

  test("blank rows around the reply are skipped", () => {
    const { port, replies } = setup();
    port.composerSubmit("Q");
    port.setPhase("running");
    port.setHistory(["Q", "", "  \n ", "A", "  "]);
    port.setPhase("ready");
    assert.deepEqual(replies, ["A"]);
  });

  test("only blank rows after the question: nothing yet, and the reply is found when it shows", () => {
    const { port, clock, replies } = setup();
    port.composerSubmit("Q");
    port.setPhase("running");
    port.setHistory(["Q", ""]);
    port.setPhase("ready");
    assert.deepEqual(replies, []);
    port.setHistory(["Q", "", "A"]);
    clock.advance(LATE_SETTLE_MS);
    assert.deepEqual(replies, ["A"]);
  });

  test("the first row with text after the question is the reply, not a later row", () => {
    const { port, replies } = setup();
    port.composerSubmit("Q");
    port.setPhase("running");
    port.setHistory(["Q", "A", "something added later"]);
    port.setPhase("ready");
    assert.deepEqual(replies, ["A"]);
  });

  test("a row after the question that is another question of the visitor is not a reply", () => {
    const { port, clock, replies } = setup();
    composerCycle(port, "first", "first answer");
    port.composerSubmit("second");
    port.setPhase("running");
    port.setHistory(["second", "first"]); // 'first' is a known echo
    port.setPhase("ready");
    clock.advance(LATE_SETTLE_MS * 3);
    assert.deepEqual(replies, ["first answer"]);
  });

  test("the reply text is passed on exactly as the page shows it", () => {
    const { port, replies } = setup();
    port.composerSubmit("Q");
    port.setPhase("running");
    port.setHistory(["Q", "  Line one\n\nLine two  "]);
    port.setPhase("ready");
    assert.deepEqual(replies, ["  Line one\n\nLine two  "]);
  });

  test("a blank or missing submitted text can never be matched to a reply", () => {
    const { port, replies } = setup({ list: ["", "Q", "A"] });
    port.composerSubmit("   ");
    port.setPhase("running");
    port.setPhase("ready");
    port.composerSubmit(undefined);
    port.setPhase("running");
    port.setPhase("ready");
    assert.deepEqual(replies, []);
  });

  test("a teaser sent through the bridge is found by its squashed text", () => {
    const { bridge, port, replies } = setup({ list: ["old question", "old answer"] });
    assert.equal(bridge.sendTeaser("  Who pays\n the apps?  ").sent, true);
    port.setPhase("running");
    port.setHistory(["old question", "old answer", "Who pays the apps?", "The ISP's bill does."]);
    port.setPhase("ready");
    assert.deepEqual(replies, ["The ISP's bill does."]);
  });
});

/* ---------- reply de-duplication by position and text ---------- */

describe("replies are remembered by position and text", () => {
  test("an identical canned answer in a later turn counts again", () => {
    const { port, replies } = setup();
    composerCycle(port, "off topic", "I can only talk about the ESP design.");
    composerCycle(port, "still off topic", "I can only talk about the ESP design.");
    assert.deepEqual(replies, ["I can only talk about the ESP design.", "I can only talk about the ESP design."]);
  });

  test("a re-read of the same list stays deduped", () => {
    const { port, replies } = setup();
    composerCycle(port, "first", "Same answer");
    // the same question again; the chat repaints ready on the same two-row list
    port.composerSubmit("first");
    port.setPhase("running");
    port.setHistory(["first", "Same answer"]);
    port.setPhase("ready");
    assert.deepEqual(replies, ["Same answer"]);
  });

  test("clearing the map does not need to forget anything: a repeated question on a longer list counts", () => {
    const { port, replies } = setup();
    composerCycle(port, "q", "Deterministic answer");
    // the visitor clears the map (the bridge is not told) and asks again
    composerCycle(port, "q", "Deterministic answer");
    assert.deepEqual(port.rows(), ["q", "Deterministic answer", "q", "Deterministic answer"]);
    assert.equal(replies.length, 2);
  });

  test("a throwing, odd or missing rows() delivers nothing and breaks nothing", () => {
    const { bridge, port, replies } = setup();
    port.rows = () => {
      throw new Error("boom");
    };
    assert.doesNotThrow(() => composerCycle(port, "a", "Same"));
    port.rows = () => "many";
    assert.doesNotThrow(() => composerCycle(port, "b", "Same"));
    port.rows = () => null;
    assert.doesNotThrow(() => composerCycle(port, "c", "Same"));
    assert.deepEqual(replies, []);
    assert.equal(bridge.status().canSend, true);
    // rows that are not strings read as blank rows
    port.rows = () => ["d", 42, null, { text: "x" }, "Fine"];
    composerCycle(port, "d", "ignored");
    assert.deepEqual(replies, ["Fine"]);
  });

  test("a port without rows() cannot tie a reply to its question: nothing is delivered, nothing breaks", () => {
    const { bridge, port, replies } = setup();
    port.rows = undefined;
    composerCycle(port, "a", "Same");
    composerCycle(port, "b", "Other");
    assert.deepEqual(replies, []);
    assert.equal(bridge.status().canSend, true);
  });

  test("lastReply and rowCount are no longer what the bridge reads", () => {
    const { port, replies } = setup();
    port.lastReply = () => {
      throw new Error("boom");
    };
    port.rowCount = () => {
      throw new Error("boom");
    };
    composerCycle(port, "q", "answer");
    assert.deepEqual(replies, ["answer"]);
  });
});

/* ---------- a submit that goes nowhere, and a chat that never boots ---------- */

describe("a submit that never shows a busy phase", () => {
  test("after NO_PROGRESS_MS suggestions work again and the status says the last question did not go through", () => {
    const { bridge, clock, changes } = setup();
    assert.equal(bridge.sendTeaser("Question").sent, true);
    clock.advance(NO_PROGRESS_MS);
    const status = bridge.status();
    assert.equal(status.canSend, true);
    assert.equal(status.reason, "noprogress");
    assert.equal(status.message, "The last question did not go through.");
    assert.equal(status.resumeAt, null);
    assert.equal(changes.at(-1).reason, "noprogress", "onChange reported it by itself, through the timer");
  });

  test("it is a notice, not a block: the next teaser is sent and clears the notice", () => {
    const { bridge, port, clock } = setup();
    bridge.sendTeaser("Question");
    clock.advance(NO_PROGRESS_MS);
    assert.deepEqual(bridge.sendTeaser("Another question"), { sent: true, reason: "" });
    assert.deepEqual(port.submitted, ["Question", "Another question"]);
    assert.equal(bridge.status().reason, "busy");
    port.setPhase("running");
    port.say("Answer");
    port.setPhase("ready");
    assert.deepEqual(bridge.status(), { canSend: true, reason: "", message: "", resumeAt: null });
  });

  test("a message the visitor typed still outranks the notice", () => {
    const { bridge, port, clock } = setup();
    bridge.sendTeaser("Question");
    clock.advance(NO_PROGRESS_MS);
    port.draft = "my own words";
    assert.equal(bridge.status().reason, "draft");
    port.draft = "";
    assert.equal(bridge.status().reason, "noprogress");
  });

  test("the notice goes away by itself after STALE_SUBMIT_MS", () => {
    const { bridge, clock, changes } = setup();
    bridge.sendTeaser("Question");
    clock.advance(NO_PROGRESS_MS);
    assert.equal(bridge.status().reason, "noprogress");
    clock.advance(STALE_SUBMIT_MS + 1);
    assert.deepEqual(bridge.status(), { canSend: true, reason: "", message: "", resumeAt: null });
    assert.equal(changes.at(-1).reason, "");
  });

  test("a busy phase that shows up after all (slow acceptance) picks the run up again", () => {
    const { bridge, port, clock, replies } = setup();
    bridge.sendTeaser("Slow question");
    clock.advance(NO_PROGRESS_MS + 5000);
    assert.equal(bridge.status().reason, "noprogress");
    port.setPhase("running");
    assert.equal(bridge.status().reason, "busy");
    port.say("A real answer");
    port.setPhase("ready");
    assert.deepEqual(replies, ["A real answer"]);
    assert.equal(bridge.status().canSend, true);
    assert.equal(bridge.status().reason, "");
  });

  test("a run that did go busy keeps blocking for far longer than NO_PROGRESS_MS", () => {
    const { bridge, port, clock } = setup();
    bridge.sendTeaser("Question");
    port.setPhase("running");
    clock.advance(NO_PROGRESS_MS * 4);
    assert.equal(bridge.status().reason, "busy");
    port.setPhase("recovering");
    clock.advance(NO_PROGRESS_MS * 4);
    assert.equal(bridge.status().reason, "busy");
  });

  test("a run that did go busy is never reported as one that did not go through", () => {
    const { bridge, port, clock } = setup({}, { timings: { staleSubmitMs: 40000, noProgressMs: 5000 } });
    bridge.sendTeaser("Question");
    port.setPhase("running");
    port.setPhase("mystery"); // the chat paints something the bridge does not know: busy, whatever the clock says
    clock.advance(39999);
    assert.equal(bridge.status().reason, "busy");
    clock.advance(1);
    assert.equal(bridge.status().reason, "busy");
    port.setPhase("ready"); // the wait was given up silently: no reply to deliver, and no notice either
    assert.deepEqual(bridge.status(), { canSend: true, reason: "", message: "", resumeAt: null });
  });

  test("the timings are injectable", () => {
    const { bridge, clock } = setup({}, { timings: { noProgressMs: 1000 } });
    bridge.sendTeaser("Question");
    clock.advance(999);
    assert.equal(bridge.status().reason, "busy");
    clock.advance(1);
    assert.equal(bridge.status().reason, "noprogress");
  });

  test("nonsense timings fall back to the defaults", () => {
    const { bridge, clock } = setup({}, { timings: { noProgressMs: -5, startGiveUpMs: "soon", lateSettleMs: NaN } });
    bridge.sendTeaser("Question");
    clock.advance(NO_PROGRESS_MS - 1);
    assert.equal(bridge.status().reason, "busy");
    clock.advance(1);
    assert.equal(bridge.status().reason, "noprogress");
  });

  test("dispose forgets the notice", () => {
    const { bridge, clock } = setup();
    bridge.sendTeaser("Question");
    clock.advance(NO_PROGRESS_MS);
    bridge.dispose();
    assert.equal(bridge.status().reason, "unavailable");
    assert.equal(clock.pending(), 0);
  });
});

describe("a chat that never boots", () => {
  test("an empty phase says starting, then unavailable after START_GIVE_UP_MS through the timer", () => {
    const { bridge, port, clock, changes } = setup({ phase: "" });
    assert.equal(bridge.status().reason, "starting");
    clock.advance(START_GIVE_UP_MS - 1);
    assert.equal(bridge.status().reason, "starting");
    const seen = changes.length;
    clock.advance(1);
    assert.equal(changes.length, seen + 1, "onChange fires by itself at the deadline");
    const status = bridge.status();
    assert.equal(status.canSend, false);
    assert.equal(status.reason, "unavailable");
    assert.equal(status.message, "The chat is not available right now.");
    assert.deepEqual(bridge.sendTeaser("hello"), { sent: false, reason: "unavailable" });
    assert.deepEqual(port.submitted, []);
  });

  test("it recovers if the phase shows up later", () => {
    const { bridge, port, clock, changes } = setup({ phase: "" });
    clock.advance(START_GIVE_UP_MS * 3);
    assert.equal(bridge.status().reason, "unavailable");
    port.setPhase("ready");
    assert.equal(bridge.status().canSend, true);
    assert.equal(changes.at(-1).canSend, true);
    assert.deepEqual(bridge.sendTeaser("hello"), { sent: true, reason: "" });
  });

  test("a chat that boots in time never reports unavailable, and no deadline timer is left", () => {
    const { bridge, port, clock } = setup({ phase: "" });
    clock.advance(START_GIVE_UP_MS - 1000);
    port.setPhase("ready");
    assert.equal(clock.pending(), 0);
    clock.advance(START_GIVE_UP_MS * 2);
    assert.equal(bridge.status().canSend, true);
  });

  test("the give-up time is injectable", () => {
    const { bridge, clock } = setup({ phase: "" }, { timings: { startGiveUpMs: 2500 } });
    clock.advance(2499);
    assert.equal(bridge.status().reason, "starting");
    clock.advance(1);
    assert.equal(bridge.status().reason, "unavailable");
  });

  test("a busy chat is not mistaken for one that never booted", () => {
    const { bridge, clock } = setup({ phase: "running" });
    clock.advance(START_GIVE_UP_MS * 3);
    assert.equal(bridge.status().reason, "busy");
  });
});

describe("rejected runs", () => {
  test("a run that ends rejected pauses teasers, then resumes through the injected timer", () => {
    const { bridge, port, clock, replies, changes } = setup();
    bridge.sendTeaser("Question");
    port.setPhase("running");
    const rejectedAt = clock.now();
    port.setPhase("rejected");
    const status = bridge.status();
    assert.equal(status.canSend, false);
    assert.equal(status.reason, "rejected");
    assert.equal(status.resumeAt, rejectedAt + REJECT_PAUSE_MS);
    assert.ok(status.message.length > 0);
    assert.deepEqual(bridge.sendTeaser("Another"), { sent: false, reason: "rejected" });
    assert.deepEqual(replies, []);
    assert.equal(clock.pending(), 1);

    const before = changes.length;
    clock.advance(REJECT_PAUSE_MS - 1);
    assert.equal(changes.length, before, "no onChange before the pause is over");
    assert.equal(bridge.status().reason, "rejected");
    clock.advance(1);
    assert.equal(changes.length, before + 1, "onChange fires once at resume");
    assert.equal(changes.at(-1).canSend, true);
    assert.equal(bridge.status().canSend, true);
    assert.equal(clock.pending(), 0);

    // The chat still paints "rejected" (it only leaves that phase on the next submit) and accepts sends.
    assert.equal(port.phase, "rejected");
    assert.deepEqual(bridge.sendTeaser("Another"), { sent: true, reason: "" });
    assert.deepEqual(port.submitted, ["Question", "Another"]);
  });

  test("a retry that is rejected again restarts the pause and ends the in-flight submit", () => {
    const { bridge, port, clock } = setup();
    bridge.sendTeaser("Question");
    port.setPhase("rejected");
    clock.advance(REJECT_PAUSE_MS);
    assert.equal(bridge.status().canSend, true);

    port.composerSubmit("typed retry"); // the page still reads "rejected" until its next paint
    assert.equal(bridge.status().reason, "busy");
    clock.advance(1000);
    const secondRejection = clock.now();
    port.setPhase("rejected"); // same phase text painted again
    const status = bridge.status();
    assert.equal(status.reason, "rejected");
    assert.equal(status.resumeAt, secondRejection + REJECT_PAUSE_MS);
    clock.advance(REJECT_PAUSE_MS);
    assert.equal(bridge.status().canSend, true);
  });

  test("a rejected phase present at start also pauses", () => {
    const { bridge, clock } = setup({ phase: "rejected" });
    assert.equal(bridge.status().reason, "rejected");
    clock.advance(REJECT_PAUSE_MS);
    assert.equal(bridge.status().canSend, true);
  });

  test("a repeated paint of rejected without a new submit does not extend the pause", () => {
    const { bridge, port, clock } = setup();
    port.setPhase("rejected");
    const first = bridge.status().resumeAt;
    clock.advance(10000);
    port.setPhase("rejected");
    assert.equal(bridge.status().resumeAt, first);
  });
});

describe("the draft box and the bridge's own text", () => {
  /** What the chat does with a refused teaser: the rejected phase, with the text put back into the box. */
  function rejectTeaser(port, text) {
    port.setPhase("running");
    port.setPhase("rejected");
    port.draft = text;
  }

  for (const [label, pause] of [
    ["409/429", REJECT_PAUSE_MS],
    ["a later tap", REJECT_PAUSE_MS + 5000],
  ]) {
    test(`after a rejected teaser (${label}) its own text in the box no longer blocks a new teaser`, () => {
      const { bridge, port, clock } = setup();
      assert.deepEqual(bridge.sendTeaser("First teaser?"), { sent: true, reason: "" });
      rejectTeaser(port, "First teaser?");
      assert.equal(bridge.status().reason, "rejected", "the pause comes first");
      assert.deepEqual(bridge.sendTeaser("Second teaser?"), { sent: false, reason: "rejected" });

      clock.advance(pause);
      assert.equal(port.draft, "First teaser?", "the refused text is still in the box");
      assert.deepEqual(bridge.status(), { canSend: true, reason: "", message: "", resumeAt: null });
      assert.deepEqual(bridge.sendTeaser("Second teaser?"), { sent: true, reason: "" });
      assert.deepEqual(port.submitted, ["First teaser?", "Second teaser?"]);
    });
  }

  test("the same teaser tapped again after the pause is allowed too", () => {
    const { bridge, port, clock } = setup();
    bridge.sendTeaser("Same teaser?");
    rejectTeaser(port, "Same teaser?");
    clock.advance(REJECT_PAUSE_MS);
    assert.deepEqual(bridge.sendTeaser("Same teaser?"), { sent: true, reason: "" });
    assert.deepEqual(port.submitted, ["Same teaser?", "Same teaser?"]);
  });

  test("the comparison trims and squashes whitespace (a textarea may reflow the text)", () => {
    const { bridge, port, clock } = setup();
    bridge.sendTeaser("  Why do I pay my ISP\n instead of each app?  ");
    rejectTeaser(port, "  Why do I pay my ISP instead of  each app?\r\n");
    clock.advance(REJECT_PAUSE_MS);
    assert.equal(bridge.status().canSend, true);
  });

  test("a draft the visitor typed still blocks, whatever it is", () => {
    const { bridge, port, clock } = setup();
    bridge.sendTeaser("First teaser?");
    rejectTeaser(port, "First teaser?");
    clock.advance(REJECT_PAUSE_MS);
    assert.equal(bridge.status().canSend, true);

    for (const typed of ["something else entirely", "First teaser? and a bit more", "First teaser", "irst teaser?", "x"]) {
      port.draft = typed;
      const status = bridge.status();
      assert.equal(status.canSend, false, typed);
      assert.equal(status.reason, "draft", typed);
      assert.ok(status.message.length > 0, typed);
      assert.deepEqual(bridge.sendTeaser("Second teaser?"), { sent: false, reason: "draft" }, typed);
    }
    assert.deepEqual(port.submitted, ["First teaser?"], "nothing was overwritten");
    port.draft = "";
    assert.equal(bridge.status().canSend, true);
  });

  test("text that is not one of the Atlas's own suggestions blocks, whether or not the bridge sent anything", () => {
    const { bridge, port } = setup({ draft: "my own half-written question" });
    assert.equal(bridge.status().reason, "draft");
    assert.deepEqual(bridge.sendTeaser("Teaser?"), { sent: false, reason: "draft" });
    assert.deepEqual(port.submitted, []);
  });

  test("only the LAST teaser counts as own text", () => {
    const { bridge, port, clock } = setup();
    assert.equal(bridge.sendTeaser("Teaser one?").sent, true);
    port.setPhase("running");
    port.say("an answer");
    port.setPhase("ready");
    assert.equal(bridge.sendTeaser("Teaser two?").sent, true);
    rejectTeaser(port, "Teaser two?");
    clock.advance(REJECT_PAUSE_MS);

    port.draft = "Teaser one?"; // an older teaser is not what the bridge last put in the box
    assert.equal(bridge.status().reason, "draft");
    port.draft = "Teaser two?";
    assert.equal(bridge.status().canSend, true);
  });

  test("a teaser's text in the box is not special once the visitor has sent something of their own", () => {
    const { bridge, port } = setup();
    assert.equal(bridge.sendTeaser("Teaser one?").sent, true);
    port.setPhase("running");
    port.say("answer one");
    port.setPhase("ready");
    assert.equal(bridge.status().canSend, true);

    port.composerSubmit("my own question");
    port.setPhase("running");
    port.say("answer two");
    port.setPhase("ready");
    port.draft = "Teaser one?"; // the visitor happens to type the same words
    assert.equal(bridge.status().reason, "draft");
  });

  test("an accepted teaser leaves an empty box and nothing changes for the visitor's typing", () => {
    const { bridge, port } = setup();
    bridge.sendTeaser("Teaser one?");
    port.draft = ""; // the chat clears the box once the send is accepted
    port.setPhase("running");
    port.say("answer");
    port.setPhase("ready");
    assert.equal(bridge.status().canSend, true);
    port.draft = "typed after";
    assert.equal(bridge.status().reason, "draft");
  });

  test("a refused submit (throwing port) does not make the old text own text", () => {
    const { bridge, port } = setup();
    port.submit = () => {
      throw new Error("composer unavailable");
    };
    assert.deepEqual(bridge.sendTeaser("Never sent?"), { sent: false, reason: "unavailable" });
    port.draft = "Never sent?";
    assert.equal(bridge.status().reason, "draft");
  });
});

describe("a refused suggestion restored into the box after a reload (F16)", () => {
  const graphTeasers = () => ISLANDS.map((island) => island.teaser).filter((teaser) => typeof teaser === "string" && teaser.trim() !== "");

  test("the graph really has suggestions to test with", () => {
    assert.ok(typeof FIRST_SUGGESTION === "string" && FIRST_SUGGESTION.trim() !== "");
    assert.ok(graphTeasers().length >= 40);
  });

  test("a fresh bridge (a reload) does not block on the first-load suggestion left in the box", () => {
    // 409/429 + reload: the chat restored the refused text into the box, the bridge remembers nothing.
    const { bridge, port } = setup({ draft: FIRST_SUGGESTION });
    assert.deepEqual(bridge.status(), { canSend: true, reason: "", message: "", resumeAt: null });
    assert.deepEqual(bridge.sendTeaser("Another suggestion?"), { sent: true, reason: "" });
    assert.deepEqual(port.submitted, ["Another suggestion?"]);
  });

  test("every teaser of the graph counts as the bridge's own text, whitespace aside", () => {
    for (const teaser of graphTeasers()) {
      const { bridge } = setup({ draft: `  ${teaser.replace(/ /g, "  ")}\n` });
      assert.equal(bridge.status().canSend, true, teaser);
    }
  });

  test("the same suggestion tapped again after a reload is sent, over the restored text", () => {
    const teaser = graphTeasers()[1];
    const { bridge, port } = setup({ draft: teaser });
    assert.deepEqual(bridge.sendTeaser(teaser), { sent: true, reason: "" });
    assert.deepEqual(port.submitted, [teaser]);
  });

  test("typed text still blocks: a suggestion with a word added or removed, another case, or anything else", () => {
    const teaser = graphTeasers()[2];
    const typed = [
      `${teaser} And what else?`,
      `Hey, ${teaser}`,
      teaser.slice(0, -1),
      teaser.slice(1),
      teaser.toUpperCase() === teaser ? teaser.toLowerCase() : teaser.toUpperCase(),
      "my own question",
      "x",
    ];
    for (const draft of typed) {
      const { bridge, port } = setup({ draft });
      const status = bridge.status();
      assert.equal(status.canSend, false, draft);
      assert.equal(status.reason, "draft", draft);
      assert.deepEqual(bridge.sendTeaser("Another suggestion?"), { sent: false, reason: "draft" }, draft);
      assert.deepEqual(port.submitted, [], draft);
    }
  });

  test("the suggestions are read from the graph when asked, not copied once", (t) => {
    if (Object.isFrozen(ISLANDS)) {
      t.skip("ISLANDS is frozen, so a suggestion cannot be added for this check");
      return;
    }
    const added = { id: "test-only-island", teaser: "A suggestion added after the bridge was made?" };
    const { bridge, port } = setup({ draft: added.teaser });
    assert.equal(bridge.status().reason, "draft", "not a suggestion yet");
    ISLANDS.push(added);
    try {
      assert.equal(bridge.status().canSend, true, "now it is");
      port.draft = "A suggestion added after the bridge was made?";
      assert.deepEqual(bridge.sendTeaser("Next?"), { sent: true, reason: "" });
    } finally {
      ISLANDS.splice(ISLANDS.indexOf(added), 1);
    }
    const again = setup({ draft: added.teaser });
    assert.equal(again.bridge.status().reason, "draft", "gone again");
  });

  test("a suggestion in the box is the bridge's own text only in the box, never a reason to skip the pauses", () => {
    const { bridge } = setup({ phase: "rejected", draft: FIRST_SUGGESTION });
    assert.equal(bridge.status().reason, "rejected");
    const busy = setup({ phase: "running", draft: FIRST_SUGGESTION });
    assert.equal(busy.bridge.status().reason, "busy");
  });

  test("on a fake page: the refused suggestion restored by the chat after a reload does not block the next one", () => {
    // Everything but the bridge survives the reload (the box, the list); the bridge starts empty.
    const fake = makeFakeDocument();
    fake.phase.textContent = "ready";
    fake.draft.value = FIRST_SUGGESTION;
    const port = createDomPort(fake.doc, { MutationObserver: FakeMutationObserver });
    const bridge = createChatBridge({ port });
    assert.equal(bridge.status().canSend, true);
    assert.equal(bridge.sendTeaser("Another suggestion?").sent, true);
    assert.equal(fake.draft.value, "Another suggestion?");
    bridge.dispose();
  });
});

describe("rate limit", () => {
  test("20 composer submits inside 60 s disable teasers until the oldest ages out", () => {
    const { bridge, port, clock, changes } = setup();
    const first = clock.now();
    for (let i = 0; i < MAX_SENDS_PER_WINDOW; i += 1) {
      if (i > 0) clock.advance(2000);
      assert.equal(bridge.status().canSend, true, `send ${i}`);
      composerCycle(port, `question ${i}`, `answer ${i}`);
    }
    const status = bridge.status();
    assert.equal(status.canSend, false);
    assert.equal(status.reason, "rate");
    assert.equal(status.resumeAt, first + SEND_WINDOW_MS);
    assert.ok(status.message.length > 0);
    assert.deepEqual(bridge.sendTeaser("one more"), { sent: false, reason: "rate" });
    assert.deepEqual(port.submitted, []);

    // 20 sends spanned 38 s, so the oldest leaves the window at first + 60 s.
    const resumeIn = first + SEND_WINDOW_MS - clock.now();
    assert.equal(resumeIn, SEND_WINDOW_MS - 38000);
    const before = changes.length;
    clock.advance(resumeIn - 1);
    assert.equal(bridge.status().reason, "rate");
    assert.equal(changes.length, before);
    clock.advance(1);
    assert.equal(bridge.status().canSend, true);
    assert.equal(changes.length, before + 1);
    assert.equal(changes.at(-1).canSend, true);
    assert.deepEqual(bridge.sendTeaser("now it works"), { sent: true, reason: "" });
  });

  test("19 composer submits do not disable teasers", () => {
    const { bridge, port, clock } = setup();
    for (let i = 0; i < MAX_SENDS_PER_WINDOW - 1; i += 1) {
      composerCycle(port, `question ${i}`, `answer ${i}`);
      clock.advance(100);
    }
    assert.equal(bridge.status().canSend, true);
  });

  test("teaser sends count toward the window", () => {
    const { bridge, port, clock } = setup();
    const first = clock.now();
    for (let i = 0; i < MAX_SENDS_PER_WINDOW; i += 1) {
      if (i > 0) clock.advance(1000);
      assert.deepEqual(bridge.sendTeaser(`teaser ${i}`), { sent: true, reason: "" }, `teaser ${i}`);
      port.setPhase("running");
      port.say(`answer ${i}`);
      port.setPhase("ready");
    }
    assert.equal(port.submitted.length, MAX_SENDS_PER_WINDOW);
    assert.deepEqual(bridge.sendTeaser("one too many"), { sent: false, reason: "rate" });
    assert.equal(port.submitted.length, MAX_SENDS_PER_WINDOW);
    assert.equal(bridge.status().resumeAt, first + SEND_WINDOW_MS);
    clock.advance(SEND_WINDOW_MS);
    assert.equal(bridge.sendTeaser("later").sent, true);
  });

  test("a mix of composer and teaser sends adds up", () => {
    const { bridge, port, clock } = setup();
    for (let i = 0; i < 10; i += 1) composerCycle(port, `typed ${i}`, `typed answer ${i}`);
    for (let i = 0; i < 10; i += 1) {
      clock.advance(10);
      assert.equal(bridge.sendTeaser(`teaser ${i}`).sent, true);
      port.setPhase("running");
      port.say(`teaser answer ${i}`);
      port.setPhase("ready");
    }
    assert.equal(bridge.status().reason, "rate");
  });

  test("more than 20 recent sends wait until enough of them aged out", () => {
    const { bridge, port, clock } = setup();
    const start = clock.now();
    for (let i = 0; i < 23; i += 1) {
      composerCycle(port, `q ${i}`, `a ${i}`);
      clock.advance(1000);
    }
    // sends at start..start+22 s; dropping 4 of them leaves 19, so the 4th oldest decides.
    assert.equal(bridge.status().reason, "rate");
    assert.equal(bridge.status().resumeAt, start + 3000 + SEND_WINDOW_MS);
    clock.advance(start + 3000 + SEND_WINDOW_MS - clock.now());
    assert.equal(bridge.status().canSend, true);
  });

  test("rejected and rate together report the later resume time", () => {
    const { bridge, port, clock } = setup();
    for (let i = 0; i < MAX_SENDS_PER_WINDOW; i += 1) composerCycle(port, `q ${i}`, `a ${i}`);
    const start = clock.now();
    port.composerSubmit("q rejected");
    port.setPhase("rejected");
    const status = bridge.status();
    assert.equal(status.reason, "rejected");
    assert.equal(status.resumeAt, start + SEND_WINDOW_MS);
  });
});

describe("dispose", () => {
  test("unsubscribes from the port and clears timers", () => {
    const { bridge, port, clock, replies, changes } = setup();
    assert.equal(port.listenerCount(), 3); // phase, submit, history
    port.setPhase("rejected");
    assert.equal(clock.pending(), 1);
    const seen = changes.length;
    bridge.dispose();
    assert.equal(port.listenerCount(), 0);
    assert.equal(clock.pending(), 0);

    port.composerSubmit("q");
    port.setPhase("running");
    port.say("answer");
    port.setPhase("ready");
    clock.advance(SEND_WINDOW_MS * 2);
    assert.deepEqual(replies, []);
    assert.equal(changes.length, seen);
    assert.equal(clock.pending(), 0);
  });

  test("a disposed bridge refuses to send and dispose is idempotent", () => {
    const { bridge, port } = setup();
    bridge.dispose();
    bridge.dispose();
    assert.deepEqual(bridge.sendTeaser("hello"), { sent: false, reason: "unavailable" });
    assert.equal(bridge.status().canSend, false);
    assert.deepEqual(port.submitted, []);
  });

  test("dispose clears a pending rate-limit timer", () => {
    const { bridge, port, clock } = setup();
    for (let i = 0; i < MAX_SENDS_PER_WINDOW; i += 1) composerCycle(port, `q ${i}`, `a ${i}`);
    assert.equal(clock.pending(), 1);
    bridge.dispose();
    assert.equal(clock.pending(), 0);
  });
});

describe("hostile ports and listeners", () => {
  const boom = () => {
    throw new Error("boom");
  };

  test("throwing readPhase never crashes the bridge", () => {
    const { bridge, port } = setup();
    port.readPhase = boom;
    assert.doesNotThrow(() => bridge.status());
    assert.equal(bridge.status().canSend, false);
    assert.deepEqual(bridge.sendTeaser("hello"), { sent: false, reason: "unavailable" });
    assert.doesNotThrow(() => port.setPhase("running"));
    assert.doesNotThrow(() => bridge.dispose());
  });

  test("throwing readDraft never crashes the bridge", () => {
    const { bridge, port } = setup();
    port.readDraft = boom;
    assert.doesNotThrow(() => bridge.status());
    assert.deepEqual(bridge.sendTeaser("hello"), { sent: false, reason: "unavailable" });
    assert.deepEqual(port.submitted, []);
  });

  test("throwing submit never crashes the bridge and is not counted as sent", () => {
    const { bridge, port } = setup();
    port.submit = boom;
    assert.doesNotThrow(() => bridge.sendTeaser("hello"));
    assert.deepEqual(bridge.sendTeaser("hello"), { sent: false, reason: "unavailable" });
    assert.equal(bridge.status().canSend, true);
  });

  test("a submit that throws after the form already fired still counts as sent", () => {
    const { bridge, port } = setup();
    port.submit = (text) => {
      port.composerSubmit(text);
      throw new Error("late failure");
    };
    assert.deepEqual(bridge.sendTeaser("hello"), { sent: true, reason: "" });
    assert.equal(bridge.status().reason, "busy");
  });

  test("throwing rows() delivers nothing and keeps the bridge usable", () => {
    const { bridge, port, replies } = setup();
    port.rows = boom;
    assert.doesNotThrow(() => composerCycle(port, "q", "ignored"));
    assert.deepEqual(replies, []);
    assert.equal(bridge.status().canSend, true);
  });

  test("throwing onPhase / onSubmit registration leaves a working, polling bridge", () => {
    const clock = makeClock();
    const port = makeFakePort();
    port.onPhase = boom;
    port.onSubmit = () => 42; // not a function: no unsubscribe
    let bridge;
    assert.doesNotThrow(() => {
      bridge = createChatBridge({ port, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    });
    assert.equal(bridge.status().canSend, true);
    assert.doesNotThrow(() => bridge.dispose());
  });

  test("throwing unsubscribe functions are tolerated by dispose", () => {
    const clock = makeClock();
    const port = makeFakePort();
    port.onPhase = () => boom;
    port.onSubmit = () => boom;
    const bridge = createChatBridge({ port, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    assert.doesNotThrow(() => bridge.dispose());
  });

  test("throwing onReply / onChange callbacks never crash the bridge", () => {
    const { bridge, port } = setup({}, { onReply: boom, onChange: boom });
    assert.doesNotThrow(() => bridge.sendTeaser("q"));
    assert.doesNotThrow(() => {
      port.setPhase("running");
      port.say("answer");
      port.setPhase("ready");
    });
    assert.equal(bridge.status().canSend, true);
  });

  test("throwing setTimer / clearTimer never crash the bridge", () => {
    const { bridge, port } = setup({}, { setTimer: boom, clearTimer: boom });
    assert.doesNotThrow(() => port.setPhase("rejected"));
    assert.equal(bridge.status().reason, "rejected");
    assert.doesNotThrow(() => bridge.dispose());
  });

  test("works without callbacks and with default timers", () => {
    const port = makeFakePort();
    const bridge = createChatBridge({ port });
    assert.equal(bridge.sendTeaser("q").sent, true);
    port.setPhase("running");
    port.say("answer");
    assert.doesNotThrow(() => port.setPhase("ready"));
    port.setPhase("rejected");
    bridge.dispose(); // clears the real timeout so the test process can exit
  });
});

/* ---------- DOM port with a hand-rolled fake document ---------- */

function makeFakeElement(name, extra = {}) {
  const element = {
    name,
    textContent: "",
    value: "",
    listeners: [],
    removed: [],
    addEventListener(type, fn, options) {
      element.listeners.push({ type, fn, capture: options === true || Boolean(options && options.capture) });
    },
    removeEventListener(type, fn, options) {
      const capture = options === true || Boolean(options && options.capture);
      const index = element.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
      if (index >= 0) element.listeners.splice(index, 1);
      element.removed.push({ type, capture });
    },
    ...extra,
  };
  return element;
}

/** Dispatch like a browser: capture listeners first, then the rest. */
function dispatchLikeBrowser(element, event) {
  const order = [
    ...element.listeners.filter((l) => l.type === event.type && l.capture),
    ...element.listeners.filter((l) => l.type === event.type && !l.capture),
  ];
  for (const l of order) l.fn(event);
}

function makeFakeHistory() {
  const rows = [];
  const history = makeFakeElement("history", {
    rows,
    sourcePanels: [],
    querySelectorAll(selector) {
      // Only the row paragraphs match; a source panel's paragraphs are not "li > p".
      return selector === "li > p" ? rows.map((row) => row.p) : [];
    },
    setRows(texts) {
      rows.length = 0;
      for (const text of texts) rows.push({ p: makeFakeElement("p", { textContent: text }) });
    },
  });
  return history;
}

class FakeMutationObserver {
  static instances = [];
  constructor(callback) {
    this.callback = callback;
    this.target = null;
    this.options = null;
    this.disconnected = false;
    FakeMutationObserver.instances.push(this);
  }
  observe(target, options) {
    this.target = target;
    this.options = options;
  }
  disconnect() {
    this.disconnected = true;
  }
  trigger() {
    if (!this.disconnected) this.callback([{ type: "childList" }], this);
  }
}

function makeFakeDocument({ withRequestSubmit = true } = {}) {
  const queried = [];
  const phase = makeFakeElement("phase");
  const draft = makeFakeElement("draft", {
    blurred: 0,
    blur() {
      draft.blurred += 1;
      if (doc.activeElement === draft) doc.activeElement = null;
    },
  });
  const history = makeFakeHistory();
  const dispatched = [];
  const form = makeFakeElement("composer", { dispatched });
  if (withRequestSubmit) {
    form.requestSubmitCalls = 0;
    form.requestSubmit = () => {
      form.requestSubmitCalls += 1;
      dispatchLikeBrowser(form, { type: "submit", target: form, bubbles: true, cancelable: true });
    };
  } else {
    form.dispatchEvent = (event) => {
      dispatched.push(event);
      dispatchLikeBrowser(form, event);
      return true;
    };
  }
  const elements = { "#phase": phase, "#draft": draft, "#composer": form, "#history": history };
  const doc = {
    activeElement: null,
    querySelector(selector) {
      queried.push(selector);
      return Object.hasOwn(elements, selector) ? elements[selector] : null;
    },
  };
  return { doc, queried, phase, draft, form, history, elements, dispatched };
}

describe("createDomPort", () => {
  test("only looks up the four documented selectors", () => {
    const fake = makeFakeDocument();
    const port = createDomPort(fake.doc, { MutationObserver: FakeMutationObserver });
    port.readPhase();
    port.readDraft();
    port.rows();
    port.lastReply();
    port.rowCount();
    port.onPhase(() => {});
    port.onHistory(() => {});
    port.onSubmit(() => {});
    port.submit("hi");
    const allowed = new Set(["#phase", "#draft", "#composer", "#history"]);
    for (const selector of fake.queried) assert.ok(allowed.has(selector), `unexpected selector ${selector}`);
    for (const selector of allowed) assert.ok(fake.queried.includes(selector), `never queried ${selector}`);
  });

  test("readPhase trims the status line; a missing status line reads unavailable", () => {
    const fake = makeFakeDocument();
    const port = createDomPort(fake.doc);
    assert.equal(port.readPhase(), "");
    fake.phase.textContent = "  running\n";
    assert.equal(port.readPhase(), "running");
    delete fake.elements["#phase"];
    assert.equal(port.readPhase(), "unavailable");
  });

  test("readDraft returns the textarea value", () => {
    const fake = makeFakeDocument();
    const port = createDomPort(fake.doc);
    assert.equal(port.readDraft(), "");
    fake.draft.value = "typing";
    assert.equal(port.readDraft(), "typing");
    delete fake.elements["#draft"];
    assert.equal(port.readDraft(), "");
  });

  test("lastReply reads the last li > p row with textContent only", () => {
    const fake = makeFakeDocument();
    const port = createDomPort(fake.doc);
    assert.equal(port.lastReply(), "");
    fake.history.setRows(["the question", "the answer <b>not html</b>"]);
    assert.equal(port.lastReply(), "the answer <b>not html</b>");
    fake.history.setRows(["only the question"]);
    assert.equal(port.lastReply(), "only the question");
    delete fake.elements["#history"];
    assert.equal(port.lastReply(), "");
  });

  test("lastReply skips blank rows, but never skips an echo of the visitor's text", () => {
    const fake = makeFakeDocument();
    const port = createDomPort(fake.doc);
    fake.history.setRows(["the question", "the answer", "  \n "]);
    assert.equal(port.lastReply(), "the answer");
    fake.history.setRows(["the question", "the answer", "", " "]);
    assert.equal(port.lastReply(), "the answer");
    fake.history.setRows([" ", "\n"]);
    assert.equal(port.lastReply(), "", "only blank rows: no reply at all");
    fake.history.setRows(["first question", "second question"]);
    assert.equal(port.lastReply(), "second question", "an echo row is not skipped");
  });

  test("rowCount counts the rows that have text, via li > p only", () => {
    const fake = makeFakeDocument();
    const port = createDomPort(fake.doc);
    assert.equal(port.rowCount(), 0);
    fake.history.setRows(["q", "a"]);
    assert.equal(port.rowCount(), 2);
    fake.history.setRows(["q", "a", "  \n"]);
    assert.equal(port.rowCount(), 2, "a blank row is not a row");
    delete fake.elements["#history"];
    assert.equal(port.rowCount(), 0);
    const bare = makeFakeDocument();
    delete bare.history.querySelectorAll;
    assert.equal(createDomPort(bare.doc).rowCount(), 0);
  });

  test("rows() lists every li > p row in order, blank ones included, as text and nothing else", () => {
    const fake = makeFakeDocument();
    const port = createDomPort(fake.doc);
    assert.deepEqual(port.rows(), []);
    fake.history.setRows(["the question", "", "the answer <b>not html</b>", "  \n "]);
    assert.deepEqual(port.rows(), ["the question", "", "the answer <b>not html</b>", "  \n "]);
    fake.history.setRows(["only"]);
    assert.deepEqual(port.rows(), ["only"]);
    const first = port.rows();
    first.push("changing the copy changes nothing");
    assert.deepEqual(port.rows(), ["only"]);
  });

  test("rows() copes with a missing, unqueryable or throwing history element", () => {
    const missing = makeFakeDocument();
    delete missing.elements["#history"];
    assert.deepEqual(createDomPort(missing.doc).rows(), []);
    const bare = makeFakeDocument();
    delete bare.history.querySelectorAll;
    assert.deepEqual(createDomPort(bare.doc).rows(), []);
    const hostile = makeFakeDocument();
    hostile.history.querySelectorAll = () => {
      throw new Error("boom");
    };
    assert.deepEqual(createDomPort(hostile.doc).rows(), []);
    assert.deepEqual(createDomPort(null).rows(), []);
  });

  test("rows(), lastReply() and rowCount() agree on the same list", () => {
    const fake = makeFakeDocument();
    const port = createDomPort(fake.doc);
    fake.history.setRows(["q", "", "a", " "]);
    const texts = port.rows().filter((text) => text.trim() !== "");
    assert.equal(port.rowCount(), texts.length);
    assert.equal(port.lastReply(), texts.at(-1));
  });

  test("onHistory observes #history with a MutationObserver and passes no data", () => {
    FakeMutationObserver.instances.length = 0;
    const fake = makeFakeDocument();
    const port = createDomPort(fake.doc, { MutationObserver: FakeMutationObserver });
    const calls = [];
    const off = port.onHistory((...args) => calls.push(args));
    assert.equal(FakeMutationObserver.instances.length, 1);
    const [observer] = FakeMutationObserver.instances;
    assert.equal(observer.target, fake.history);
    assert.equal(observer.options.childList, true);
    assert.equal(observer.options.characterData, true);
    assert.equal(observer.options.subtree, true);
    assert.equal(Object.keys(observer.options).length, 3, "no attributes, no old values");

    observer.trigger();
    observer.trigger();
    assert.deepEqual(calls, [[], []], "the page's nodes never reach the bridge");

    off();
    assert.equal(observer.disconnected, true);
    observer.callback([], observer); // a record that was already queued must not reach the listener
    assert.equal(calls.length, 2);
  });

  test("onHistory tolerates a throwing listener and a missing element or MutationObserver", () => {
    FakeMutationObserver.instances.length = 0;
    const fake = makeFakeDocument();
    const port = createDomPort(fake.doc, { MutationObserver: FakeMutationObserver });
    port.onHistory(() => {
      throw new Error("boom");
    });
    assert.doesNotThrow(() => FakeMutationObserver.instances[0].trigger());

    delete fake.elements["#history"];
    const none = createDomPort(fake.doc, { MutationObserver: FakeMutationObserver }).onHistory(() => {});
    assert.equal(typeof none, "function");
    assert.doesNotThrow(none);

    const original = globalThis.MutationObserver;
    delete globalThis.MutationObserver;
    try {
      const other = makeFakeDocument();
      const off = createDomPort(other.doc).onHistory(() => {});
      assert.equal(typeof off, "function");
      assert.doesNotThrow(off);
    } finally {
      if (original !== undefined) globalThis.MutationObserver = original;
    }
  });

  test("lastReply copes with a history element that cannot be queried", () => {
    const fake = makeFakeDocument();
    delete fake.history.querySelectorAll;
    assert.equal(createDomPort(fake.doc).lastReply(), "");
  });

  test("submit sets the draft, then uses form.requestSubmit and releases focus", () => {
    const fake = makeFakeDocument();
    const port = createDomPort(fake.doc);
    let valueAtSubmit = null;
    fake.form.addEventListener("submit", () => {
      valueAtSubmit = fake.draft.value;
    });
    fake.doc.activeElement = fake.draft;
    port.submit("Who pays the apps?");
    assert.equal(fake.draft.value, "Who pays the apps?");
    assert.equal(fake.form.requestSubmitCalls, 1);
    assert.equal(valueAtSubmit, "Who pays the apps?");
    assert.equal(fake.draft.blurred, 1, "a focused textarea is blurred so the chat can clear it later");
  });

  test("submit does not blur the textarea when it is not focused", () => {
    const fake = makeFakeDocument();
    createDomPort(fake.doc).submit("hello");
    assert.equal(fake.draft.blurred, 0);
  });

  test("submit falls back to a cancelable bubbling submit event without requestSubmit", () => {
    const fake = makeFakeDocument({ withRequestSubmit: false });
    const port = createDomPort(fake.doc);
    let seen = null;
    fake.form.addEventListener("submit", (event) => {
      seen = event;
    });
    port.submit("fallback question");
    assert.equal(fake.dispatched.length, 1);
    assert.equal(fake.dispatched[0].type, "submit");
    assert.equal(fake.dispatched[0].bubbles, true);
    assert.equal(fake.dispatched[0].cancelable, true);
    assert.equal(seen, fake.dispatched[0]);
    assert.equal(fake.draft.value, "fallback question");
  });

  test("submit throws a plain error when the composer is missing (the bridge absorbs it)", () => {
    const fake = makeFakeDocument();
    delete fake.elements["#composer"];
    const port = createDomPort(fake.doc);
    assert.throws(() => port.submit("x"), /composer unavailable/);
    const bridge = createChatBridge({ port: { ...port, readPhase: () => "ready" } });
    assert.deepEqual(bridge.sendTeaser("x"), { sent: false, reason: "unavailable" });
    bridge.dispose();
  });

  test("onSubmit registers a capture-phase listener that sees the draft before the chat does", () => {
    const fake = makeFakeDocument();
    const port = createDomPort(fake.doc);
    const order = [];
    const seen = [];
    // The chat's own handler (bubble phase) is registered first, like app.js does at load.
    fake.form.addEventListener("submit", () => {
      order.push("chat");
      fake.draft.value = ""; // the chat may rewrite the draft while handling the submit
    });
    const off = port.onSubmit((text) => {
      order.push("atlas");
      seen.push(text);
    });
    const atlasListener = fake.form.listeners.at(-1);
    assert.equal(atlasListener.type, "submit");
    assert.equal(atlasListener.capture, true);

    fake.draft.value = "typed by hand";
    fake.form.requestSubmit();
    assert.deepEqual(order, ["atlas", "chat"]);
    assert.deepEqual(seen, ["typed by hand"]);

    off();
    assert.equal(fake.form.listeners.some((l) => l.capture), false, "capture listener removed");
    assert.deepEqual(fake.form.removed, [{ type: "submit", capture: true }]);
    fake.draft.value = "after";
    fake.form.requestSubmit();
    assert.deepEqual(seen, ["typed by hand"]);
  });

  test("onSubmit callback exceptions do not stop the chat's own handler", () => {
    const fake = makeFakeDocument();
    const port = createDomPort(fake.doc);
    let chatRan = false;
    fake.form.addEventListener("submit", () => {
      chatRan = true;
    });
    port.onSubmit(() => {
      throw new Error("boom");
    });
    assert.doesNotThrow(() => fake.form.requestSubmit());
    assert.equal(chatRan, true);
  });

  test("onPhase observes #phase through a MutationObserver passed in options", () => {
    FakeMutationObserver.instances.length = 0;
    const fake = makeFakeDocument();
    const port = createDomPort(fake.doc, { MutationObserver: FakeMutationObserver });
    const seen = [];
    const off = port.onPhase((phase) => seen.push(phase));
    assert.equal(FakeMutationObserver.instances.length, 1);
    const [observer] = FakeMutationObserver.instances;
    assert.equal(observer.target, fake.phase);
    assert.equal(observer.options.childList, true);
    assert.equal(observer.options.characterData, true);
    assert.equal(observer.options.subtree, true);

    fake.phase.textContent = "running";
    observer.trigger();
    fake.phase.textContent = " ready ";
    observer.trigger();
    assert.deepEqual(seen, ["running", "ready"]);

    off();
    assert.equal(observer.disconnected, true);
    fake.phase.textContent = "rejected";
    observer.callback([], observer); // a record that was already queued must not reach the listener
    assert.deepEqual(seen, ["running", "ready"]);
  });

  test("onPhase falls back to globalThis.MutationObserver", () => {
    FakeMutationObserver.instances.length = 0;
    const original = globalThis.MutationObserver;
    globalThis.MutationObserver = FakeMutationObserver;
    try {
      const fake = makeFakeDocument();
      const port = createDomPort(fake.doc);
      const seen = [];
      port.onPhase((phase) => seen.push(phase));
      fake.phase.textContent = "reconciling";
      FakeMutationObserver.instances[0].trigger();
      assert.deepEqual(seen, ["reconciling"]);
    } finally {
      if (original === undefined) delete globalThis.MutationObserver;
      else globalThis.MutationObserver = original;
    }
  });

  test("onPhase prefers the document's own window MutationObserver over the global", () => {
    class WindowObserver extends FakeMutationObserver {}
    FakeMutationObserver.instances.length = 0;
    const fake = makeFakeDocument();
    fake.doc.defaultView = { MutationObserver: WindowObserver };
    createDomPort(fake.doc).onPhase(() => {});
    assert.ok(FakeMutationObserver.instances[0] instanceof WindowObserver);
  });

  test("without a MutationObserver or elements, onPhase / onSubmit return harmless no-ops", () => {
    const original = globalThis.MutationObserver;
    delete globalThis.MutationObserver;
    try {
      const fake = makeFakeDocument();
      const port = createDomPort(fake.doc);
      const off = port.onPhase(() => {});
      assert.equal(typeof off, "function");
      assert.doesNotThrow(off);
      delete fake.elements["#composer"];
      const offSubmit = port.onSubmit(() => {});
      assert.equal(typeof offSubmit, "function");
      assert.doesNotThrow(offSubmit);
    } finally {
      if (original !== undefined) globalThis.MutationObserver = original;
    }
  });

  test("a null document never throws", () => {
    const port = createDomPort(null);
    assert.equal(port.readPhase(), "unavailable");
    assert.equal(port.readDraft(), "");
    assert.equal(port.lastReply(), "");
    assert.equal(port.rowCount(), 0);
    assert.deepEqual(port.rows(), []);
    assert.equal(typeof port.onPhase(() => {}), "function");
    assert.equal(typeof port.onHistory(() => {}), "function");
    assert.equal(typeof port.onSubmit(() => {}), "function");
    assert.throws(() => port.submit("x"));
  });
});

/* ---------- bridge + DOM port together, replaying how app.js paints ---------- */

describe("bridge on a fake page", () => {
  function startPage() {
    FakeMutationObserver.instances.length = 0;
    const fake = makeFakeDocument();
    const clock = makeClock();
    const replies = [];
    const port = createDomPort(fake.doc, { MutationObserver: FakeMutationObserver });
    const bridge = createChatBridge({
      port,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onReply: (text) => replies.push(text),
    });
    const observer = FakeMutationObserver.instances[0];
    const historyObserver = FakeMutationObserver.instances[1];
    // app.js showHistory(): replace the whole list from /history.
    const rewrite = (rows) => {
      fake.history.setRows(rows);
      historyObserver.trigger();
    };
    // app.js paint(): phase.textContent = view.phase, then draft.value = view.draft (when not focused).
    const paint = (phase, draft) => {
      fake.phase.textContent = phase;
      if (draft !== undefined) fake.draft.value = draft;
      observer.trigger();
    };
    // app.js: the chat's own bubble-phase handler appends the user row synchronously.
    fake.form.addEventListener("submit", () => {
      if (fake.draft.value) {
        const rows = fake.history.rows.map((row) => row.p.textContent);
        fake.history.setRows([...rows, fake.draft.value]);
      }
    });
    return { fake, clock, replies, port, bridge, paint, rewrite, historyObserver };
  }

  test("boot -> teaser -> reply is delivered once with the last history row", () => {
    const { fake, replies, bridge, paint } = startPage();
    assert.equal(bridge.status().reason, "starting");
    paint("ready");
    assert.equal(bridge.status().canSend, true);

    assert.deepEqual(bridge.sendTeaser("Who actually pays the apps I use?"), { sent: true, reason: "" });
    assert.equal(fake.form.requestSubmitCalls, 1);
    assert.equal(bridge.status().reason, "busy");
    paint("running", ""); // accepted: the chat clears its draft
    // streaming then the replaced history, as showHistory() does
    fake.history.setRows(["Who actually pays the apps I use?", "Your bill pays the carriers."]);
    paint("ready");
    assert.deepEqual(replies, ["Your bill pays the carriers."]);
    assert.equal(bridge.status().canSend, true);
  });

  test("a typed question with a draft left behind blocks teasers and delivers on completion", () => {
    const { fake, replies, bridge, paint } = startPage();
    paint("ready");
    fake.draft.value = "a typed question";
    assert.equal(bridge.status().reason, "draft");
    fake.form.requestSubmit(); // the user presses Send: the capture listener records it
    assert.equal(bridge.status().reason, "busy");
    paint("running", "");
    fake.history.setRows(["a typed question", "the typed answer"]);
    paint("ready");
    assert.deepEqual(replies, ["the typed answer"]);
  });

  test("a rejected teaser pauses, keeps the question as the last row and delivers nothing", () => {
    const { fake, clock, replies, bridge, paint } = startPage();
    paint("ready");
    bridge.sendTeaser("Teaser question");
    paint("rejected", "Teaser question"); // a rejected send keeps its text in the draft box
    assert.equal(bridge.status().reason, "rejected");
    clock.advance(REJECT_PAUSE_MS);
    // the chat leaves the refused text in the box for a manual retry: it is the bridge's own text,
    // so it does not block the next teaser
    assert.equal(fake.draft.value, "Teaser question");
    assert.equal(bridge.status().canSend, true);
    assert.equal(bridge.sendTeaser("Another teaser").sent, true);
    assert.equal(fake.draft.value, "Another teaser", "a new teaser overwrites the refused text");
    assert.equal(fake.form.requestSubmitCalls, 2);
  });

  test("a rejected teaser followed by the visitor's own edit of the text blocks teasers", () => {
    const { fake, clock, bridge, paint } = startPage();
    paint("ready");
    bridge.sendTeaser("Teaser question");
    paint("rejected", "Teaser question");
    clock.advance(REJECT_PAUSE_MS);
    assert.equal(bridge.status().canSend, true);
    fake.draft.value = "Teaser question, but about my own bill";
    assert.equal(bridge.status().reason, "draft");
    assert.deepEqual(bridge.sendTeaser("Another teaser"), { sent: false, reason: "draft" });
    assert.equal(fake.form.requestSubmitCalls, 1);
    fake.draft.value = "";
    assert.equal(bridge.status().canSend, true);
  });

  test("the page's observers are the phase line first and the history second", () => {
    const { fake, historyObserver } = startPage();
    assert.equal(FakeMutationObserver.instances.length, 2);
    assert.equal(FakeMutationObserver.instances[0].target, fake.phase);
    assert.equal(historyObserver.target, fake.history);
  });

  test("the message box gets focus while the chat still polls: the reply is found when the list is rewritten", () => {
    const { fake, clock, replies, bridge, paint, rewrite } = startPage();
    paint("ready");
    assert.equal(bridge.sendTeaser("Who actually pays the apps I use?").sent, true);
    paint("running", ""); // accepted
    // the visitor clicks into the message box: the chat repaints `ready` although it still polls /history
    paint("ready");
    assert.deepEqual(fake.history.rows.map((row) => row.p.textContent), ["Who actually pays the apps I use?"]);
    assert.deepEqual(replies, []);
    clock.advance(30000);
    assert.deepEqual(replies, [], "nothing to find yet");
    // /history catches up: the list is replaced, and the chat paints ready once more
    rewrite(["Who actually pays the apps I use?", "Your bill pays the carriers."]);
    paint("ready");
    assert.deepEqual(replies, [], "not at the rewrite itself");
    clock.advance(LATE_SETTLE_MS);
    assert.deepEqual(replies, ["Your bill pays the carriers."]);
    clock.advance(STALE_SUBMIT_MS);
    assert.deepEqual(replies, ["Your bill pays the carriers."], "once only");
  });

  test("turn 2 on an older /history snapshot: nothing false is delivered, the real reply is when it arrives", () => {
    const { fake, clock, replies, paint, rewrite } = startPage();
    paint("ready");
    // turn 1 as usual
    fake.draft.value = "question one";
    fake.form.requestSubmit();
    paint("running", "");
    rewrite(["question one", "answer one"]);
    paint("ready");
    assert.deepEqual(replies, ["answer one"]);
    // turn 2: the chat swaps in an older snapshot of the list and paints ready 150 ms later
    fake.draft.value = "question two";
    fake.form.requestSubmit();
    paint("running", "");
    clock.advance(150);
    rewrite(["question one", "answer one"]);
    paint("ready");
    clock.advance(LATE_SETTLE_MS * 3);
    assert.deepEqual(replies, ["answer one"], "neither the old reply nor the question is a new reply");
    // the list is rewritten with the real turn
    rewrite(["question one", "answer one", "question two", "answer two"]);
    clock.advance(LATE_SETTLE_MS);
    assert.deepEqual(replies, ["answer one", "answer two"]);
  });

  test("after a reload the chat shows the list of before Q2: nothing is lit until the list holds Q2 and its reply", () => {
    const { fake, clock, replies, paint, rewrite } = startPage();
    // The reload: the page restores the earlier turn into the list; the bridge starts with no memory.
    fake.history.setRows(["Who actually pays the apps I use?", "Your bill pays the carriers."]);
    paint("ready");
    fake.draft.value = "How does the pot work?";
    fake.form.requestSubmit(); // the chat appends the visitor's row
    paint("running", "");
    assert.equal(fake.history.rows.length, 3);
    // the late /history snapshot is the one from before the question
    rewrite(["Who actually pays the apps I use?", "Your bill pays the carriers."]);
    paint("ready");
    clock.advance(LATE_SETTLE_MS * 4);
    assert.deepEqual(replies, [], "the old reply is not the reply to the new question");
    rewrite([
      "Who actually pays the apps I use?",
      "Your bill pays the carriers.",
      "How does the pot work?",
      "The pot is shared.",
    ]);
    clock.advance(LATE_SETTLE_MS);
    assert.deepEqual(replies, ["The pot is shared."]);
    clock.advance(STALE_SUBMIT_MS);
    assert.deepEqual(replies, ["The pot is shared."], "once only");
  });

  test("after a reload a list that ends with the visitor's own earlier teaser lights nothing", () => {
    const { fake, clock, replies, paint, rewrite } = startPage();
    fake.history.setRows(["Who actually pays the apps I use?", "Your bill pays the carriers.", "What is the pot?"]);
    paint("ready");
    fake.draft.value = "Something new";
    fake.form.requestSubmit();
    paint("running", "");
    rewrite(["Who actually pays the apps I use?", "Your bill pays the carriers.", "What is the pot?"]);
    paint("ready");
    clock.advance(LATE_SETTLE_MS * 4);
    assert.deepEqual(replies, []);
  });

  test("a reply that streams into the list is taken only when it has stopped growing", () => {
    const { fake, clock, replies, paint, rewrite } = startPage();
    paint("ready");
    fake.draft.value = "question";
    fake.form.requestSubmit();
    paint("running", "");
    paint("ready"); // premature
    rewrite(["question", "The pot"]);
    clock.advance(1000);
    fake.history.rows[1].p.textContent = "The pot is shared"; // characterData / childList inside a row
    FakeMutationObserver.instances[1].trigger();
    clock.advance(1000);
    fake.history.rows[1].p.textContent = "The pot is shared by the household.";
    FakeMutationObserver.instances[1].trigger();
    clock.advance(LATE_SETTLE_MS - 1);
    assert.deepEqual(replies, []);
    clock.advance(1);
    assert.deepEqual(replies, ["The pot is shared by the household."]);
  });

  test("the same canned answer in a later turn is delivered again on the longer list", () => {
    const { fake, replies, paint, rewrite } = startPage();
    paint("ready");
    fake.draft.value = "weather?";
    fake.form.requestSubmit();
    paint("running", "");
    rewrite(["weather?", "I can only talk about the ESP design."]);
    paint("ready");
    fake.draft.value = "sports?";
    fake.form.requestSubmit();
    paint("running", "");
    rewrite(["weather?", "I can only talk about the ESP design.", "sports?", "I can only talk about the ESP design."]);
    paint("ready");
    assert.deepEqual(replies, ["I can only talk about the ESP design.", "I can only talk about the ESP design."]);
  });

  test("dispose disconnects the observer and removes the capture listener", () => {
    const { fake, bridge } = startPage();
    const [observer, historyObserver] = FakeMutationObserver.instances;
    const captureBefore = fake.form.listeners.filter((l) => l.capture).length;
    assert.equal(captureBefore, 1);
    bridge.dispose();
    assert.equal(observer.disconnected, true);
    assert.equal(historyObserver.disconnected, true);
    assert.equal(fake.form.listeners.filter((l) => l.capture).length, 0);
  });
});
