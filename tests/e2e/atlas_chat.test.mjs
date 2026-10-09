import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MAX_SENDS_PER_WINDOW,
  REJECT_PAUSE_MS,
  SEND_WINDOW_MS,
  STALE_SUBMIT_MS,
  createChatBridge,
  createDomPort,
} from "../../site/js/atlas-chat.js";

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

/** A port that behaves like the real form: submit() reports itself through onSubmit. */
function makeFakePort({ phase = "ready", draft = "", reply = "", reportsSubmit = true } = {}) {
  const phaseListeners = new Set();
  const submitListeners = new Set();
  const port = {
    phase,
    draft,
    reply,
    submitted: [],
    readPhase: () => port.phase,
    readDraft: () => port.draft,
    lastReply: () => port.reply,
    submit(text) {
      port.submitted.push(text);
      if (reportsSubmit) port.composerSubmit(text);
    },
    onPhase(callback) {
      phaseListeners.add(callback);
      return () => phaseListeners.delete(callback);
    },
    onSubmit(callback) {
      submitListeners.add(callback);
      return () => submitListeners.delete(callback);
    },
    setPhase(next) {
      port.phase = next;
      for (const callback of [...phaseListeners]) callback(next);
    },
    composerSubmit(text) {
      for (const callback of [...submitListeners]) callback(text);
    },
    listenerCount: () => phaseListeners.size + submitListeners.size,
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

/** One full chat cycle as the real page paints it: ready -> running -> ready with a new last row. */
function composerCycle(port, question, answer) {
  port.composerSubmit(question);
  port.setPhase("running");
  port.reply = answer;
  port.setPhase("ready");
}

/* ---------- bridge ---------- */

describe("constants", () => {
  test("match the contract", () => {
    assert.equal(SEND_WINDOW_MS, 60000);
    assert.equal(MAX_SENDS_PER_WINDOW, 20);
    assert.equal(REJECT_PAUSE_MS, 30000);
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
    port.reply = "Answer";
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

  test("a submit that never reaches a busy phase stops blocking after STALE_SUBMIT_MS", () => {
    const { bridge, clock, changes } = setup();
    bridge.sendTeaser("Question");
    assert.equal(bridge.status().reason, "busy");
    clock.advance(STALE_SUBMIT_MS - 1);
    assert.equal(bridge.status().reason, "busy");
    const seen = changes.length;
    clock.advance(1);
    assert.equal(bridge.status().canSend, true);
    assert.ok(changes.length > seen, "onChange fires when the stale submit is dropped");
  });

  test("a long busy phase does not make the submit stale: the reply is still delivered", () => {
    const { bridge, port, clock, replies } = setup();
    bridge.sendTeaser("Question");
    port.setPhase("running");
    clock.advance(STALE_SUBMIT_MS * 3);
    assert.equal(bridge.status().reason, "busy");
    port.reply = "A long answer";
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
    port.reply = "A pot is a shared account.";
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
    port.reply = "recovered answer";
    port.setPhase("ready");
    assert.deepEqual(replies, ["recovered answer"]);
  });

  test("a failed run whose last row is still the question delivers nothing", () => {
    const { bridge, port, replies } = setup();
    port.reply = "";
    bridge.sendTeaser("Why is the sky blue?");
    port.setPhase("running");
    port.reply = "Why is the sky blue?";
    port.setPhase("ready");
    assert.deepEqual(replies, []);
    assert.equal(bridge.status().canSend, true);
  });

  test("the failed-run comparison ignores whitespace differences", () => {
    const { port, replies } = setup();
    port.composerSubmit("Why   is the sky blue?\n");
    port.setPhase("running");
    port.reply = "Why is the sky blue?";
    port.setPhase("ready");
    assert.deepEqual(replies, []);
  });

  test("an empty last row delivers nothing", () => {
    const { port, replies } = setup();
    composerCycle(port, "q", "   ");
    assert.deepEqual(replies, []);
  });

  test("the same reply text is not delivered twice", () => {
    const { port, replies } = setup();
    composerCycle(port, "first", "Same answer");
    composerCycle(port, "second", "Same answer");
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
    port.setPhase("ready");
    assert.deepEqual(replies, ["Old answer"]);
  });

  test("a transition into ready without a submit delivers nothing", () => {
    const { port, replies } = setup({ phase: "" });
    port.reply = "stale text from before";
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
    port.reply = "Answer";
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

  test("text that merely equals a teaser the bridge never sent still blocks", () => {
    const { bridge, port } = setup({ draft: "Who actually pays the apps I use?" });
    assert.equal(bridge.status().reason, "draft");
    assert.deepEqual(bridge.sendTeaser("Who actually pays the apps I use?"), { sent: false, reason: "draft" });
    assert.deepEqual(port.submitted, []);
  });

  test("only the LAST teaser counts as own text", () => {
    const { bridge, port, clock } = setup();
    assert.equal(bridge.sendTeaser("Teaser one?").sent, true);
    port.setPhase("running");
    port.reply = "an answer";
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
    port.reply = "answer one";
    port.setPhase("ready");
    assert.equal(bridge.status().canSend, true);

    port.composerSubmit("my own question");
    port.setPhase("running");
    port.reply = "answer two";
    port.setPhase("ready");
    port.draft = "Teaser one?"; // the visitor happens to type the same words
    assert.equal(bridge.status().reason, "draft");
  });

  test("an accepted teaser leaves an empty box and nothing changes for the visitor's typing", () => {
    const { bridge, port } = setup();
    bridge.sendTeaser("Teaser one?");
    port.draft = ""; // the chat clears the box once the send is accepted
    port.setPhase("running");
    port.reply = "answer";
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
      port.reply = `answer ${i}`;
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
      port.reply = `teaser answer ${i}`;
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
    assert.equal(port.listenerCount(), 2);
    port.setPhase("rejected");
    assert.equal(clock.pending(), 1);
    const seen = changes.length;
    bridge.dispose();
    assert.equal(port.listenerCount(), 0);
    assert.equal(clock.pending(), 0);

    port.composerSubmit("q");
    port.setPhase("running");
    port.reply = "answer";
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

  test("throwing lastReply delivers nothing and keeps the bridge usable", () => {
    const { bridge, port, replies } = setup();
    port.lastReply = boom;
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
      port.reply = "answer";
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
    port.reply = "answer";
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
    port.lastReply();
    port.onPhase(() => {});
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
    assert.equal(typeof port.onPhase(() => {}), "function");
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
    return { fake, clock, replies, port, bridge, paint };
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

  test("dispose disconnects the observer and removes the capture listener", () => {
    const { fake, bridge } = startPage();
    const [observer] = FakeMutationObserver.instances;
    const captureBefore = fake.form.listeners.filter((l) => l.capture).length;
    assert.equal(captureBefore, 1);
    bridge.dispose();
    assert.equal(observer.disconnected, true);
    assert.equal(fake.form.listeners.filter((l) => l.capture).length, 0);
  });
});
