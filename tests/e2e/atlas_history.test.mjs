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
  const history = makeTarget({ scrollTop: 0, scrollHeight: 500, clientHeight: 200 });
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
