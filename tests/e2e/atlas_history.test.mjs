import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { followHistory } from "../../site/js/atlas.js";

/**
 * followHistory keeps the conversation history scrolled to its newest row. These tests drive it
 * with a fake page; tests/e2e/atlas_browser.test.mjs checks the same thing in a real browser.
 */

function makeTarget(extra = {}) {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, handler, options) {
      listeners.push({ type, handler, options });
    },
    removeEventListener(type, handler) {
      const at = listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
      if (at >= 0) listeners.splice(at, 1);
    },
    fire(type) {
      for (const entry of [...listeners]) if (entry.type === type) entry.handler({ type });
    },
    ...extra,
  };
}

class FakeObserver {
  static instances = [];
  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnected = false;
    FakeObserver.instances.push(this);
  }
  observe(target, options) {
    this.observed.push({ target, options });
  }
  disconnect() {
    this.disconnected = true;
  }
  trigger() {
    this.callback([]);
  }
}
class FakeMutationObserver extends FakeObserver {}
class FakeResizeObserver extends FakeObserver {}

function makePage({ withHistory = true, observers = true } = {}) {
  FakeObserver.instances.length = 0;
  // Scrolled to the end, as a history that has been following its newest row is.
  const history = makeTarget({ scrollTop: 300, scrollHeight: 500, clientHeight: 200 });
  const form = makeTarget();
  const view = observers ? { MutationObserver: FakeMutationObserver, ResizeObserver: FakeResizeObserver } : {};
  const elements = { "#history": withHistory ? history : null, "#composer": form };
  const doc = { defaultView: view, querySelector: (selector) => elements[selector] || null };
  const mutation = () => FakeObserver.instances.find((entry) => entry instanceof FakeMutationObserver);
  const resize = () => FakeObserver.instances.find((entry) => entry instanceof FakeResizeObserver);
  return { history, form, doc, mutation, resize };
}

describe("followHistory", () => {
  test("toEnd scrolls the history to its last row", () => {
    const page = makePage();
    const follow = followHistory(page.doc);
    follow.toEnd();
    assert.equal(page.history.scrollTop, 500);
  });

  test("the visitor's own submit scrolls to the end, also after they scrolled up", () => {
    const page = makePage();
    followHistory(page.doc);
    page.history.scrollTop = 50;
    page.history.fire("scroll");
    page.form.fire("submit");
    assert.equal(page.history.scrollTop, 500);
  });

  test("the submit listener is a bubble-phase one (the chat's own handler runs first)", () => {
    const page = makePage();
    followHistory(page.doc);
    const submit = page.form.listeners.find((entry) => entry.type === "submit");
    assert.ok(submit, "a submit listener is registered on the form");
    assert.ok(!submit.options, "no capture flag");
  });

  test("new rows and streamed text keep the end in view while the visitor is at the end", () => {
    const page = makePage();
    followHistory(page.doc);
    page.history.scrollHeight = 800; // an answer streamed in
    page.mutation().trigger();
    assert.equal(page.history.scrollTop, 800);
    page.history.scrollHeight = 950;
    page.mutation().trigger();
    assert.equal(page.history.scrollTop, 950);
  });

  test("a history that is a few pixels short of the end still counts as at the end", () => {
    const page = makePage();
    followHistory(page.doc);
    page.history.scrollTop = 500 - 200 - 20; // 20 px above the end
    page.history.fire("scroll");
    page.history.scrollHeight = 700;
    page.mutation().trigger();
    assert.equal(page.history.scrollTop, 700);
  });

  test("a visitor who scrolled up to re-read is not pulled down by new text", () => {
    const page = makePage();
    followHistory(page.doc);
    page.history.scrollTop = 100; // 200 px above the end
    page.history.fire("scroll");
    page.history.scrollHeight = 900;
    page.mutation().trigger();
    assert.equal(page.history.scrollTop, 100, "left alone");
    page.resize().trigger();
    assert.equal(page.history.scrollTop, 100, "also when the box is resized");
    page.form.fire("submit"); // their next question brings them back
    assert.equal(page.history.scrollTop, 900);
    page.history.scrollHeight = 1000;
    page.mutation().trigger();
    assert.equal(page.history.scrollTop, 1000, "and they follow again");
  });

  test("a resize of the history (the card gives it whatever height is left) re-pins it", () => {
    const page = makePage();
    followHistory(page.doc);
    page.history.clientHeight = 150;
    page.resize().trigger();
    assert.equal(page.history.scrollTop, 500);
  });

  test("the observers watch only the history, and its rows and text", () => {
    const page = makePage();
    followHistory(page.doc);
    assert.equal(page.mutation().observed.length, 1);
    assert.equal(page.mutation().observed[0].target, page.history);
    assert.deepEqual(page.mutation().observed[0].options, { childList: true, subtree: true, characterData: true });
    assert.equal(page.resize().observed[0].target, page.history);
  });

  test("dispose removes the listeners and disconnects the observers", () => {
    const page = makePage();
    const follow = followHistory(page.doc);
    assert.equal(page.history.listeners.length, 1);
    assert.equal(page.form.listeners.length, 1);
    follow.dispose();
    assert.equal(page.history.listeners.length, 0);
    assert.equal(page.form.listeners.length, 0);
    assert.ok(page.mutation().disconnected && page.resize().disconnected);
  });

  test("it never moves focus", () => {
    const page = makePage();
    let focused = 0;
    page.history.focus = () => {
      focused += 1;
    };
    const follow = followHistory(page.doc);
    follow.toEnd();
    page.form.fire("submit");
    page.mutation().trigger();
    assert.equal(focused, 0);
  });

  test("without a history element it does nothing and never throws", () => {
    const page = makePage({ withHistory: false });
    const follow = followHistory(page.doc);
    assert.doesNotThrow(() => follow.toEnd());
    assert.doesNotThrow(() => follow.dispose());
    assert.equal(page.form.listeners.length, 0);
  });

  test("without MutationObserver or ResizeObserver it still follows submits and toEnd", () => {
    const page = makePage({ observers: false });
    const follow = followHistory(page.doc);
    page.form.fire("submit");
    assert.equal(page.history.scrollTop, 500);
    page.history.scrollHeight = 600;
    follow.toEnd();
    assert.equal(page.history.scrollTop, 600);
    assert.doesNotThrow(() => follow.dispose());
  });
});

/**
 * Rows, geometry and the two buttons under the history. The fake list answers getBoundingClientRect() the way a
 * page does: a row's top moves with the list's scrollTop.
 */
function makeRows(specs) {
  // specs: [{ role, offset, height }] in the list's scroll coordinates.
  return specs.map((spec) => ({
    ...spec,
    getAttribute: (name) => (name === "data-role" && spec.role ? spec.role : null),
  }));
}

function makeReadingPage({ rows, clientHeight = 200, scrollHeight, labelled = true } = {}) {
  FakeObserver.instances.length = 0;
  const created = [];
  const history = makeTarget({
    scrollTop: Math.max(0, (scrollHeight ?? rows.reduce((end, row) => Math.max(end, row.offset + row.height), 0)) - clientHeight),
    scrollHeight: scrollHeight ?? rows.reduce((end, row) => Math.max(end, row.offset + row.height), 0),
    clientHeight,
    clientTop: 1,
    children: rows,
    focusCalls: [],
    focus(options) {
      this.focusCalls.push(options);
      doc.activeElement = this;
    },
    getBoundingClientRect() {
      return { top: 100, height: clientHeight };
    },
    after(node) {
      this.nextSibling = node;
      node.parent = "form";
    },
  });
  Object.defineProperty(history, "lastElementChild", { get: () => rows[rows.length - 1] || null });
  for (const row of rows) {
    row.getBoundingClientRect = () => ({ top: 100 + history.clientTop + row.offset - history.scrollTop, height: row.height });
    if (!labelled) row.getAttribute = () => null;
  }
  const form = makeTarget();
  const view = { MutationObserver: FakeMutationObserver, ResizeObserver: FakeResizeObserver };
  const elements = { "#history": history, "#composer": form };
  const doc = {
    defaultView: view,
    activeElement: null,
    querySelector: (selector) => elements[selector] || null,
    createElement(name) {
      const node = makeTarget({
        name,
        hidden: false,
        id: "",
        className: "",
        textContent: "",
        children: [],
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        remove() {
          this.removed = true;
        },
      });
      created.push(node);
      return node;
    },
  };
  const bar = () => created.find((node) => node.id === "history-nav");
  const button = (id) => created.find((node) => node.id === id);
  const mutation = () => FakeObserver.instances.find((entry) => entry instanceof FakeMutationObserver);
  const resize = () => FakeObserver.instances.find((entry) => entry instanceof FakeResizeObserver);
  return { history, form, doc, bar, button, mutation, resize, rows };
}

/** A visitor's question, then a long answer (700 px in a 200 px window). */
const LONG_EXCHANGE = () =>
  makeRows([
    { role: "user", offset: 0, height: 60 },
    { role: "assistant", offset: 70, height: 700 },
  ]);

describe("followHistory and the scroll the page reports for its own scrolls", () => {
  test("a scroll event that arrives after more text was added does not unpin a visitor who is following", () => {
    const page = makePage();
    followHistory(page.doc);
    page.history.scrollHeight = 800;
    page.mutation().trigger(); // follows to the end of 800
    assert.equal(page.history.scrollTop, 800);
    page.history.scrollHeight = 1300; // more text, before the browser delivers the scroll event of the follow above
    page.history.fire("scroll");
    page.history.scrollHeight = 1400;
    page.mutation().trigger();
    assert.equal(page.history.scrollTop, 1400, "still following");
  });

  test("a scroll event that carries the history DOWN but not to the end (the card changed height) does not unpin either", () => {
    const page = makePage();
    followHistory(page.doc).toEnd();
    page.history.scrollHeight = 900;
    page.history.scrollTop = 520; // the browser moved it, 180 px short of the new end
    page.history.fire("scroll");
    page.mutation().trigger();
    assert.equal(page.history.scrollTop, 900, "still following");
  });

  test("a visitor who scrolled up is not dragged back when new text arrives before the scroll event does", () => {
    const page = makePage();
    followHistory(page.doc).toEnd();
    page.history.scrollTop = 350; // the wheel turn; its scroll event is still on its way
    page.history.scrollHeight = 700;
    page.mutation().trigger();
    assert.equal(page.history.scrollTop, 350, "left alone");
    page.history.fire("scroll");
    page.history.scrollHeight = 800;
    page.mutation().trigger();
    assert.equal(page.history.scrollTop, 350, "and still alone once the event has arrived");
  });

  test("a finished answer does not move a visitor who has already scrolled up, scroll event or not", () => {
    const page = makeReadingPage({ rows: LONG_EXCHANGE() });
    const follow = followHistory(page.doc);
    page.history.scrollTop = 100; // away from the end of 570; the event is still on its way
    follow.answerDone();
    assert.equal(page.history.scrollTop, 100);
  });

  test("a scroll to a place of the visitor's own choosing unpins even right after one of ours", () => {
    const page = makePage();
    followHistory(page.doc).toEnd();
    page.history.scrollTop = 120;
    page.history.fire("scroll");
    page.history.scrollHeight = 900;
    page.mutation().trigger();
    assert.equal(page.history.scrollTop, 120);
  });
});

describe("followHistory.answerDone: a finished answer is read from its first line", () => {
  test("a follower lands on the first line of an answer that is taller than the window, a little below the top edge", () => {
    const page = makeReadingPage({ rows: LONG_EXCHANGE() });
    const follow = followHistory(page.doc);
    page.history.scrollTop = 600; // streamed to the end
    page.history.fire("scroll");
    follow.answerDone();
    assert.equal(page.history.scrollTop, 70 - 8, "the answer's first line, 8 px under the top edge");
  });

  test("after that the visitor is not pulled back to the end by the next change", () => {
    const page = makeReadingPage({ rows: LONG_EXCHANGE() });
    const follow = followHistory(page.doc);
    page.history.scrollTop = 600;
    page.history.fire("scroll");
    follow.answerDone();
    page.history.fire("scroll"); // the scroll event of the move above
    page.mutation().trigger();
    page.resize().trigger();
    assert.equal(page.history.scrollTop, 62);
  });

  test("an answer that fits in the window is shown whole at the end, with its question above it when there is room", () => {
    const rows = makeRows([
      { role: "user", offset: 0, height: 40 },
      { role: "assistant", offset: 50, height: 120 },
    ]);
    const page = makeReadingPage({ rows, clientHeight: 200, scrollHeight: 400 });
    const follow = followHistory(page.doc);
    follow.answerDone();
    assert.equal(page.history.scrollTop, 400, "the end");
  });

  test("a visitor who scrolled up to re-read is not moved", () => {
    const page = makeReadingPage({ rows: LONG_EXCHANGE() });
    const follow = followHistory(page.doc);
    page.history.scrollTop = 300;
    page.history.fire("scroll");
    follow.answerDone();
    assert.equal(page.history.scrollTop, 300);
  });

  test("the newest answer is the last row labelled assistant, not the visitor's newer question", () => {
    const rows = makeRows([
      { role: "assistant", offset: 0, height: 700 },
      { role: "user", offset: 710, height: 40 },
    ]);
    const page = makeReadingPage({ rows });
    const follow = followHistory(page.doc);
    page.history.scrollTop = 550;
    page.history.fire("scroll");
    follow.answerDone();
    assert.equal(page.history.scrollTop, 0, "the answer starts at the top (never a negative scroll)");
  });

  test("rows without a role (an older client) count the last row as the answer", () => {
    const page = makeReadingPage({ rows: LONG_EXCHANGE(), labelled: false });
    const follow = followHistory(page.doc);
    page.history.scrollTop = 600;
    page.history.fire("scroll");
    follow.answerDone();
    assert.equal(page.history.scrollTop, 62);
  });

  test("a history that cannot be measured is simply followed to its end", () => {
    const page = makePage();
    const follow = followHistory(page.doc);
    follow.answerDone();
    assert.equal(page.history.scrollTop, 500);
  });

  test("it never moves focus", () => {
    const page = makeReadingPage({ rows: LONG_EXCHANGE() });
    const follow = followHistory(page.doc);
    follow.answerDone();
    page.mutation().trigger();
    assert.deepEqual(page.history.focusCalls, []);
  });
});

describe("the buttons under the history", () => {
  const visible = (page, id) => page.button(id).hidden === false;

  test("they are built right after the history and start hidden", () => {
    const page = makeReadingPage({ rows: LONG_EXCHANGE() });
    followHistory(page.doc);
    const bar = page.bar();
    assert.ok(bar, "a bar is built");
    assert.equal(page.history.nextSibling, bar, "it is placed right under the history");
    assert.equal(bar.className, "history-nav");
    assert.equal(bar.hidden, true);
    assert.equal(page.button("history-start").textContent, "Back to start of answer");
    assert.equal(page.button("history-latest").textContent, "Jump to latest");
    assert.equal(page.button("history-start").type, "button", "never a submit button inside the form");
    assert.equal(visible(page, "history-start") || visible(page, "history-latest"), false);
  });

  test("at the end of a long answer only 'Back to start of answer' is offered", () => {
    const page = makeReadingPage({ rows: LONG_EXCHANGE() });
    followHistory(page.doc);
    page.history.scrollTop = 600;
    page.history.fire("scroll");
    assert.equal(visible(page, "history-start"), true);
    assert.equal(visible(page, "history-latest"), false);
    assert.equal(page.bar().hidden, false);
  });

  test("at the first line of the answer only 'Jump to latest' is offered", () => {
    const page = makeReadingPage({ rows: LONG_EXCHANGE() });
    const follow = followHistory(page.doc);
    page.history.scrollTop = 600;
    page.history.fire("scroll");
    follow.answerDone();
    page.history.fire("scroll");
    assert.equal(visible(page, "history-start"), false);
    assert.equal(visible(page, "history-latest"), true);
  });

  test("in the middle of the answer both are offered", () => {
    const page = makeReadingPage({ rows: LONG_EXCHANGE() });
    followHistory(page.doc);
    page.history.scrollTop = 300;
    page.history.fire("scroll");
    assert.equal(visible(page, "history-start"), true);
    assert.equal(visible(page, "history-latest"), true);
  });

  test("a few pixels short of the end is still the end: 'Jump to latest' needs more than that", () => {
    const page = makeReadingPage({ rows: LONG_EXCHANGE() }); // 770 px of text in a 200 px window: the end is at 570
    followHistory(page.doc);
    page.history.scrollTop = 570 - 20;
    page.history.fire("scroll");
    assert.equal(visible(page, "history-latest"), false, "20 px from the end");
    page.history.scrollTop = 570 - 40;
    page.history.fire("scroll");
    assert.equal(visible(page, "history-latest"), true, "40 px from the end");
  });

  test("when everything fits there is nothing to offer", () => {
    const rows = makeRows([{ role: "assistant", offset: 0, height: 120 }]);
    const page = makeReadingPage({ rows, clientHeight: 200, scrollHeight: 120 });
    followHistory(page.doc);
    page.history.fire("scroll");
    assert.equal(page.bar().hidden, true);
  });

  test("'Back to start of answer' scrolls to the first line, leaves the visitor in charge and focuses the history", () => {
    const page = makeReadingPage({ rows: LONG_EXCHANGE() });
    followHistory(page.doc);
    page.history.scrollTop = 600;
    page.history.fire("scroll");
    page.button("history-start").fire("click");
    assert.equal(page.history.scrollTop, 62);
    assert.deepEqual(page.history.focusCalls, [{ preventScroll: true }], "focus goes to the history, without scrolling the page");
    page.mutation().trigger();
    assert.equal(page.history.scrollTop, 62, "new text does not drag them back down");
    assert.equal(visible(page, "history-start"), false, "the button goes away once it has done its job");
  });

  test("'Jump to latest' scrolls to the end, follows again and focuses the history", () => {
    const page = makeReadingPage({ rows: LONG_EXCHANGE() });
    followHistory(page.doc);
    page.history.scrollTop = 100;
    page.history.fire("scroll");
    page.button("history-latest").fire("click");
    assert.equal(page.history.scrollTop, page.history.scrollHeight);
    assert.deepEqual(page.history.focusCalls, [{ preventScroll: true }]);
    page.history.scrollHeight += 200;
    page.mutation().trigger();
    assert.equal(page.history.scrollTop, page.history.scrollHeight, "following again");
    assert.equal(visible(page, "history-latest"), false);
  });

  test("a new question brings the visitor back to the end and the buttons follow", () => {
    const page = makeReadingPage({ rows: LONG_EXCHANGE() });
    followHistory(page.doc);
    page.history.scrollTop = 300;
    page.history.fire("scroll");
    page.form.fire("submit");
    assert.equal(page.history.scrollTop, page.history.scrollHeight);
    assert.equal(visible(page, "history-latest"), false);
  });

  test("a resize reports the buttons one frame later, never inside the resize callback", () => {
    const frames = [];
    const page = makeReadingPage({ rows: LONG_EXCHANGE() });
    page.doc.defaultView.requestAnimationFrame = (fn) => {
      frames.push(fn);
      return frames.length;
    };
    followHistory(page.doc);
    page.history.scrollTop = 300;
    page.resize().trigger();
    assert.equal(visible(page, "history-start"), false, "not yet");
    assert.equal(frames.length, 1);
    frames[0]();
    assert.equal(visible(page, "history-start"), true);
  });

  test("dispose removes the buttons and cancels a frame that is still waiting", () => {
    const cancelled = [];
    const page = makeReadingPage({ rows: LONG_EXCHANGE() });
    page.doc.defaultView.requestAnimationFrame = () => 7;
    page.doc.defaultView.cancelAnimationFrame = (handle) => cancelled.push(handle);
    const follow = followHistory(page.doc);
    page.resize().trigger();
    follow.dispose();
    assert.equal(page.bar().removed, true);
    assert.deepEqual(cancelled, [7]);
  });

  test("a page that cannot create elements gets the scrolling without the buttons", () => {
    const page = makePage();
    const follow = followHistory(page.doc);
    follow.toEnd();
    assert.equal(page.history.scrollTop, 500);
  });
});
