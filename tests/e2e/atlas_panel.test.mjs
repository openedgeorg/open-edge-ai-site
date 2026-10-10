/**
 * Unit tests for the Atlas panels: status words, the inspector card, the list view and the
 * suggestion chips. They run on a tiny fake DOM (no browser, no jsdom); tests/e2e/atlas_browser.test.mjs
 * checks the same behaviour in real Chrome.
 *
 * Run: node --test tests/e2e/atlas_panel.test.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as graph from "../../site/js/atlas-graph.js";
import { createAtlasList } from "../../site/js/atlas-list.js";
import {
  OPEN_STATUS_WORD,
  STATUS_WORDS,
  createInspector,
  createSuggestions,
  statusWord,
  suggestionItems,
  suggestionPlan,
} from "../../site/js/atlas-panel.js";
import { deriveView } from "../../site/js/atlas-state.js";

// ---------------------------------------------------------------------------------------------
// a very small DOM
// ---------------------------------------------------------------------------------------------

class FakeNode {
  constructor(doc, tag, text = "") {
    this.doc = doc;
    this.tag = tag;
    this.children = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.listeners = new Map();
    this.own = text;
    this.hidden = false;
    this.id = "";
    this.tabIndex = 0;
    this.type = "";
    const names = new Set();
    this.names = names;
    this.classList = {
      add: (name) => names.add(name),
      remove: (name) => names.delete(name),
      contains: (name) => names.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !names.has(name) : Boolean(force);
        if (on) names.add(name);
        else names.delete(name);
        return on;
      },
    };
  }

  get className() {
    return [...this.names].join(" ");
  }

  set className(value) {
    this.names.clear();
    for (const name of String(value).split(/\s+/).filter(Boolean)) this.names.add(name);
  }

  get textContent() {
    return this.tag === "#text" || this.children.length === 0 ? this.own : this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.own = String(value);
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(typeof node === "string" ? new FakeNode(this.doc, "#text", node) : node);
  }

  removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parentNode = null;
    this.doc.dropFocusIfInside(child);
  }

  replaceChildren(...nodes) {
    for (const child of [...this.children]) this.removeChild(child);
    this.append(...nodes);
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(node) {
    for (let cursor = node; cursor; cursor = cursor.parentNode) if (cursor === this) return true;
    return false;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  fire(type) {
    for (const handler of this.listeners.get(type) || []) handler({ type, target: this });
    // Like the real DOM: focusin and click bubble up.
    if (this.parentNode && (type === "click" || type === "focusin")) this.parentNode.fire(type);
  }

  click() {
    this.fire("click");
  }

  focus() {
    if (!this.doc.attached(this)) return;
    this.doc.activeElement = this;
    this.fire("focusin");
  }

  find(predicate, found = []) {
    if (predicate(this)) found.push(this);
    for (const child of this.children) child.find(predicate, found);
    return found;
  }

  all(className) {
    return this.find((node) => node.classList.contains(className));
  }
}

function makeDoc() {
  const doc = {
    root: null,
    activeElement: null,
    createElement: (tag) => new FakeNode(doc, tag),
    attached: (node) => doc.root.contains(node),
    dropFocusIfInside(node) {
      if (doc.activeElement && node.contains(doc.activeElement)) doc.activeElement = doc.root;
    },
  };
  doc.root = new FakeNode(doc, "body");
  doc.activeElement = doc.root;
  return doc;
}

function mountIn(doc, tag = "div") {
  const node = doc.createElement(tag);
  doc.root.appendChild(node);
  return node;
}

const index = graph.buildIndex();
const DRAGONS = graph.ISLANDS.filter((island) => island.status === "open");
const ORDINARY = graph.ISLANDS.filter((island) => island.status !== "open").map((island) => island.id);
const FORBIDDEN_FOR_DRAGONS = /next to explore|not reached yet/i;

// The graph is read, never remembered: a place next to the start, one that is not, and one well away.
const isOrdinary = (id) => index.byId.get(id).status !== "open";
const NEXT_TO_START = [...index.neighbours.get(graph.START_ID)].find(isOrdinary);
const NOT_NEXT = graph.ISLANDS.map((island) => island.id).find((id) => id !== graph.START_ID && !index.neighbours.get(graph.START_ID).has(id) && isOrdinary(id));

// ---------------------------------------------------------------------------------------------
// status words
// ---------------------------------------------------------------------------------------------

describe("statusWord", () => {
  it("keeps the ordinary words for ordinary places", () => {
    const place = index.byId.get(NEXT_TO_START);
    assert.equal(statusWord("visited", place), "visited");
    assert.equal(statusWord("frontier", place), "next to explore");
    assert.equal(statusWord("fogged", place), "not reached yet");
    assert.equal(statusWord("frontier"), "next to explore");
    assert.equal(statusWord("fogged"), "not reached yet");
    assert.equal(statusWord(undefined), "not reached yet");
    assert.equal(statusWord("frontier", null), "next to explore");
    assert.equal(statusWord("frontier", { status: "contested" }), "next to explore", "a contested place is still an ordinary place");
    assert.deepEqual({ ...STATUS_WORDS }, { visited: "visited", frontier: "next to explore", fogged: "not reached yet" });
  });

  it("says \"open, not ratified\" for a dragon until it is visited", () => {
    assert.equal(OPEN_STATUS_WORD, "open, not ratified");
    assert.ok(DRAGONS.length >= 9);
    for (const island of DRAGONS) {
      assert.equal(statusWord("frontier", island), "open, not ratified", island.id);
      assert.equal(statusWord("fogged", island), "open, not ratified", island.id);
      assert.equal(statusWord("visited", island), "visited", island.id);
      assert.equal(statusWord(undefined, island), "open, not ratified", island.id);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// the inspector
// ---------------------------------------------------------------------------------------------

describe("inspector", () => {
  function inspectorFor(visited) {
    const doc = makeDoc();
    const mount = mountIn(doc);
    const inspector = createInspector({ document: doc, graph, index, mount });
    const view = deriveView({ visited, replies: 2 }, index);
    return { inspector, mount, view };
  }

  it("is not a live region: it carries no aria-live", () => {
    const { mount } = inspectorFor([graph.START_ID]);
    assert.equal(mount.hasAttribute("aria-live"), false);
  });

  it("describes a frontier dragon as open, not ratified, never as next to explore", () => {
    const { inspector, mount, view } = inspectorFor(ORDINARY);
    const frontier = DRAGONS.filter((island) => view.status[island.id] === "frontier");
    assert.ok(frontier.length >= 1);
    for (const island of frontier) {
      inspector.showIsland(island.id, view);
      assert.match(mount.textContent, /Status: open, not ratified/, island.id);
      assert.doesNotMatch(mount.textContent, FORBIDDEN_FOR_DRAGONS, `${island.id} card`);
      assert.match(mount.textContent, /open list/i);
      assert.doesNotMatch(mount.textContent, /roadmap|learned/i);
      assert.equal(mount.all("atlas-inspector-label").length, 0, "the words are not repeated as a badge");
      assert.equal(mount.all("atlas-inspector-status")[0].classList.contains("is-frontier"), false, "never the teal next-step colour");
      assert.ok(mount.all("atlas-inspector-status")[0].classList.contains("is-open"));
    }
  });

  it("calls a visited dragon visited and keeps its open-list label", () => {
    const target = DRAGONS[0];
    const { inspector, mount, view } = inspectorFor([...ORDINARY, target.id]);
    inspector.showIsland(target.id, view);
    assert.match(mount.textContent, /Status: visited/);
    assert.equal(mount.all("atlas-inspector-label").length, 1);
    assert.equal(mount.all("atlas-inspector-label")[0].textContent, "open, not ratified");
    assert.doesNotMatch(mount.textContent, FORBIDDEN_FOR_DRAGONS);
  });

  it("keeps ordinary wording for ordinary places", () => {
    const { inspector, mount, view } = inspectorFor([graph.START_ID]);
    inspector.showIsland(NEXT_TO_START, view);
    assert.match(mount.textContent, /Status: next to explore/);
    inspector.showIsland(graph.START_ID, view);
    assert.match(mount.textContent, /Status: visited/);
  });
});

// ---------------------------------------------------------------------------------------------
// the list view
// ---------------------------------------------------------------------------------------------

describe("list view", () => {
  function listFor(visited, options = {}) {
    const doc = makeDoc();
    const asked = [];
    const selected = [];
    const list = createAtlasList({
      document: doc,
      graph,
      index,
      onActivate: (id) => asked.push(id),
      onSelect: (id) => selected.push(id),
      ...options,
    });
    doc.root.appendChild(list.element);
    const view = deriveView({ visited, replies: 2 }, index);
    return { doc, list, view, asked, selected };
  }
  const rowOf = (list, id) => {
    const island = index.byId.get(id);
    return list.element.find((node) => node.classList.contains("atlas-list-item") && node.all("atlas-list-name")[0].textContent === island.name)[0];
  };

  it("never calls a dragon next to explore or not reached yet, in any state", () => {
    for (const visited of [[graph.START_ID], ORDINARY, [...ORDINARY, DRAGONS[0].id], graph.ISLANDS.map((island) => island.id)]) {
      const { list, view } = listFor(visited);
      list.render(view, { paused: false });
      for (const island of DRAGONS) {
        const row = rowOf(list, island.id);
        const status = view.status[island.id];
        assert.equal(row.all("atlas-list-status")[0].textContent, status === "visited" ? "visited" : "open, not ratified", `${island.id} (${status})`);
        if (status !== "visited") assert.doesNotMatch(row.textContent, FORBIDDEN_FOR_DRAGONS, `${island.id} (${status}) row`);
        else assert.match(row.all("atlas-list-meta")[0].textContent, /open, not ratified/, "a visited dragon keeps its label");
      }
    }
  });

  it("does not repeat \"open, not ratified\" in the meta line of an unvisited dragon", () => {
    const { list, view } = listFor(ORDINARY);
    list.render(view);
    const target = DRAGONS.find((island) => view.status[island.id] === "frontier");
    const meta = rowOf(list, target.id).all("atlas-list-meta")[0].textContent;
    assert.doesNotMatch(meta, /open, not ratified/);
    assert.match(meta, /^§/);
  });

  it("keeps the ordinary words for ordinary places", () => {
    const { list, view } = listFor([graph.START_ID]);
    list.render(view);
    assert.equal(rowOf(list, graph.START_ID).all("atlas-list-status")[0].textContent, "visited");
    assert.equal(rowOf(list, NEXT_TO_START).all("atlas-list-status")[0].textContent, "next to explore");
    assert.equal(rowOf(list, NOT_NEXT).all("atlas-list-status")[0].textContent, "not reached yet");
  });

  it("pauses an Ask button with aria-disabled, never the disabled attribute, and points it at the notice", () => {
    const { list, view, asked } = listFor([graph.START_ID]);
    list.render(view, { paused: false });
    const button = rowOf(list, NEXT_TO_START).all("atlas-list-ask")[0];
    assert.equal(button.hidden, false);
    assert.equal(button.getAttribute("aria-disabled"), null);
    button.click();
    assert.deepEqual(asked, [NEXT_TO_START]);

    list.render(view, { paused: true, pausedMessage: "The chat is busy with a question." });
    assert.equal(button.getAttribute("aria-disabled"), "true");
    assert.equal(button.getAttribute("aria-describedby"), "atlas-notice");
    assert.equal(button.disabled, undefined, "the disabled property is never set");
    assert.equal(button.hasAttribute("disabled"), false);
    assert.equal(button.hasAttribute("title"), false, "no tooltip repeats the pause message");
    button.click();
    assert.deepEqual(asked, [NEXT_TO_START], "an aria-disabled button does nothing");

    list.render(view, { paused: false });
    assert.equal(button.getAttribute("aria-disabled"), null);
    assert.equal(button.getAttribute("aria-describedby"), null);
    button.click();
    assert.deepEqual(asked, [NEXT_TO_START, NEXT_TO_START]);
  });

  it("writes no copy of the pause message anywhere in the list", () => {
    const { list, view } = listFor([graph.START_ID]);
    const message = "The chat is busy with a question.";
    list.render(view, { paused: true, pausedMessage: message });
    assert.equal(list.element.textContent.includes(message), false);
    assert.equal(list.element.all("atlas-list-paused").length, 0);
    assert.ok(!list.element.find((node) => [...node.attrs.values()].some((value) => value.includes(message))).length);
  });

  it("updates in place: the focused Ask button survives pauses and renders", () => {
    const { doc, list, view } = listFor([graph.START_ID]);
    list.render(view);
    const button = rowOf(list, NEXT_TO_START).all("atlas-list-ask")[0];
    button.focus();
    assert.equal(doc.activeElement, button);
    list.render(view, { paused: true, pausedMessage: "x" });
    assert.equal(doc.activeElement, button, "still focused while paused");
    list.render(view, { paused: false });
    assert.equal(doc.activeElement, button, "and after the pause");
    assert.ok(list.element.contains(button));
  });

  it("moves focus to the row, not to the page, when the asked place is visited and its button goes away", () => {
    const { doc, list, view } = listFor([graph.START_ID]);
    list.render(view);
    const row = rowOf(list, NEXT_TO_START);
    const button = row.all("atlas-list-ask")[0];
    button.focus();
    list.render(deriveView({ visited: [graph.START_ID, NEXT_TO_START], replies: 3 }, index));
    assert.equal(button.hidden, true);
    assert.equal(doc.activeElement, row, "focus lands on the row");
  });
});

// ---------------------------------------------------------------------------------------------
// the suggestion chips
// ---------------------------------------------------------------------------------------------

describe("suggestion chips", () => {
  function chipsFor(options = {}) {
    const doc = makeDoc();
    const mount = mountIn(doc);
    const picked = [];
    const chips = createSuggestions({ document: doc, mount, onPick: (text) => picked.push(text), ...options });
    const buttons = () => mount.find((node) => node.tag === "button");
    return { doc, mount, chips, picked, buttons };
  }
  const THREE = ["Question one?", "Question two?", "Question three?"];

  it("renders a labelled group of buttons", () => {
    const { mount, chips, buttons } = chipsFor();
    chips.render(["Who actually pays the apps I use?"]);
    assert.equal(mount.getAttribute("role"), "group");
    assert.equal(mount.getAttribute("aria-label"), "Suggested questions");
    assert.equal(mount.hidden, false);
    assert.deepEqual(buttons().map((node) => node.textContent), ["Who actually pays the apps I use?"]);
    assert.equal(buttons()[0].type, "button");
  });

  it("picks a question on click, and not while paused", () => {
    const { chips, picked, buttons } = chipsFor();
    chips.render(["A?"], { paused: false });
    buttons()[0].click();
    assert.deepEqual(picked, ["A?"]);
    chips.render(["A?"], { paused: true, pausedMessage: "The chat is busy with a question." });
    const chip = buttons()[0];
    assert.equal(chip.getAttribute("aria-disabled"), "true");
    assert.equal(chip.getAttribute("aria-describedby"), "atlas-notice");
    assert.equal(chip.hasAttribute("disabled"), false, "never the disabled attribute: it would drop focus");
    chip.click();
    assert.deepEqual(picked, ["A?"], "an aria-disabled chip does nothing");
    chips.render(["A?"], { paused: false });
    assert.equal(chip.getAttribute("aria-disabled"), null);
    assert.equal(chip.getAttribute("aria-describedby"), null);
    chip.click();
    assert.deepEqual(picked, ["A?", "A?"]);
  });

  it("writes no paragraph for the pause: the reason lives in the page's notice", () => {
    const { mount, chips } = chipsFor();
    chips.render(["A?"], { paused: true, pausedMessage: "The chat is busy with a question." });
    assert.equal(mount.textContent.includes("busy"), false);
    assert.equal(mount.all("atlas-suggest-paused").length, 0);
    assert.deepEqual(mount.find((node) => node.tag === "p").map((node) => node.textContent), ["Try asking"]);
  });

  it("keeps the same chip elements across pauses and renders, so focus survives", () => {
    const { doc, chips, buttons } = chipsFor();
    chips.render(["A?"]);
    const chip = buttons()[0];
    chip.focus();
    chips.render(["A?"], { paused: true });
    assert.equal(buttons()[0], chip);
    assert.equal(doc.activeElement, chip);
    chips.render(["A?"], { paused: false });
    assert.equal(doc.activeElement, chip);
  });

  it("when the reply brings new suggestions, the focused chip stays and only its text changes", () => {
    const { doc, chips, buttons } = chipsFor();
    chips.render(["First question?"], { paused: true });
    const chip = buttons()[0];
    chip.focus();
    chips.render(THREE, { paused: false });
    assert.equal(buttons().length, 3);
    assert.equal(buttons()[0], chip, "the same element");
    assert.equal(chip.textContent, "Question one?");
    assert.equal(doc.activeElement, chip, "focus did not move");
    assert.deepEqual(buttons().map((node) => node.textContent), THREE);
  });

  it("when the list shrinks past the focused chip, focus moves to the first chip, not to the page", () => {
    const { doc, chips, buttons } = chipsFor();
    chips.render(THREE);
    buttons()[2].focus();
    chips.render(["Only one?"]);
    assert.equal(buttons().length, 1);
    assert.equal(doc.activeElement, buttons()[0]);
  });

  it("when nothing is left to suggest the group is hidden and focus goes to the fallback", () => {
    const doc = makeDoc();
    const mount = mountIn(doc);
    const fallback = mountIn(doc, "button");
    const chips = createSuggestions({ document: doc, mount, onPick() {}, fallbackFocus: () => fallback });
    chips.render(["A?"]);
    mount.find((node) => node.tag === "button")[0].focus();
    chips.render([]);
    assert.equal(mount.hidden, true);
    assert.equal(doc.activeElement, fallback);
    chips.render(["B?"]);
    assert.equal(mount.hidden, false);
    assert.deepEqual(mount.find((node) => node.tag === "button").map((node) => node.textContent), ["B?"]);
  });

  it("is idempotent: the same input leaves the DOM alone", () => {
    const { chips, buttons } = chipsFor();
    chips.render(THREE, { paused: true, pausedMessage: "a" });
    const before = buttons();
    chips.render(THREE, { paused: true, pausedMessage: "a different message" });
    assert.deepEqual(buttons(), before);
  });

  it("shows what suggestionItems chooses: the first question, then up to three teasers", () => {
    const first = suggestionItems({ replies: 0, frontier: [] });
    assert.deepEqual(first, [graph.FIRST_SUGGESTION]);
    const view = deriveView({ visited: [graph.START_ID, NEXT_TO_START], replies: 1 }, index);
    const items = suggestionItems(view);
    assert.ok(items.length >= 1 && items.length <= 3);
    const { chips, buttons } = chipsFor();
    chips.render(first);
    chips.render(items);
    assert.deepEqual(buttons().map((node) => node.textContent), items);
  });
});

// ---------------------------------------------------------------------------------------------
// which suggestions, in which order (F17)
// ---------------------------------------------------------------------------------------------

describe("suggestionPlan: the chips follow the latest reply, and the open list stays out of the way", () => {
  const teaser = (id) => index.byId.get(id).teaser;
  const viewOf = (visited) => deriveView({ visited, replies: visited.length }, index);

  /**
   * Two places A and B (not the start), each with a next-to-explore neighbour of its own that is not
   * next to the other, to the start or to any dragon: so the order of the chips can only come from
   * which of A and B was reached last.
   */
  function twoTrails() {
    const ids = graph.ISLANDS.map((island) => island.id).filter((id) => id !== graph.START_ID && isOrdinary(id));
    const own = (a, others) => [...index.neighbours.get(a)].filter(
      (id) => isOrdinary(id) && id !== graph.START_ID && ![a, ...others].includes(id) && others.every((other) => !index.neighbours.get(other).has(id)),
    );
    for (const a of ids) {
      for (const b of ids) {
        if (a === b || index.neighbours.get(a).has(b)) continue;
        const forA = own(a, [b, graph.START_ID]);
        const forB = own(b, [a, graph.START_ID]);
        const fresh = (id) => !index.neighbours.get(graph.START_ID).has(id);
        const fa = forA.find(fresh);
        const fb = forB.find((id) => fresh(id) && id !== fa);
        if (fa && fb) return { a, b, fa, fb };
      }
    }
    throw new Error("the graph has no two separate trails to test with");
  }

  it("is the first question on the first load and nothing else", () => {
    assert.deepEqual(suggestionPlan({ replies: 0, frontier: [] }), [{ text: graph.FIRST_SUGGESTION, open: false }]);
    assert.deepEqual(suggestionPlan(null), [{ text: graph.FIRST_SUGGESTION, open: false }]);
  });

  it("without the order the places were reached in, keeps graph order (as before)", () => {
    const view = viewOf([graph.START_ID]);
    const ordinary = graph.ISLANDS.filter((island) => view.frontier.includes(island.id) && island.status !== "open");
    assert.ok(ordinary.length >= 2);
    assert.deepEqual(suggestionItems(view, { max: 99 }), ordinary.map((island) => island.teaser));
  });

  it("puts the neighbours of the newest visited place first, whichever place that is", () => {
    const { a, b, fa, fb } = twoTrails();
    const view = viewOf([graph.START_ID, a, b]);
    const aThenB = suggestionItems(view, { visited: [graph.START_ID, a, b], max: 99 });
    assert.ok(aThenB.indexOf(teaser(fb)) >= 0 && aThenB.indexOf(teaser(fa)) >= 0, "both trails are offered");
    assert.ok(aThenB.indexOf(teaser(fb)) < aThenB.indexOf(teaser(fa)), `${b} was reached last, so its neighbour ${fb} comes before ${fa}`);
    const bThenA = suggestionItems(view, { visited: [graph.START_ID, b, a], max: 99 });
    assert.ok(bThenA.indexOf(teaser(fa)) < bThenA.indexOf(teaser(fb)), `and the other way round`);
  });

  it("keeps at most three chips by default, the closest ones", () => {
    const { a, b } = twoTrails();
    const visited = [graph.START_ID, a, b];
    const items = suggestionItems(viewOf(visited), { visited });
    assert.ok(items.length >= 1 && items.length <= 3);
    const first = graph.ISLANDS.find((island) => island.teaser === items[0]);
    assert.ok(index.neighbours.get(b).has(first.id), `the first chip (${first.id}) is next to ${b}, the place reached last`);
  });

  it("offers no place from the open list while an ordinary place is next to explore", () => {
    const dragon = DRAGONS[0];
    const view = { replies: 3, frontier: [NEXT_TO_START, dragon.id] };
    assert.deepEqual(suggestionPlan(view, { max: 99 }), [{ text: teaser(NEXT_TO_START), open: false }]);
    assert.deepEqual(suggestionItems(view, { max: 99 }), [teaser(NEXT_TO_START)]);
  });

  it("offers the open list only when nothing else is left, and then marks every chip as open", () => {
    const view = { replies: 3, frontier: DRAGONS.slice(0, 4).map((island) => island.id) };
    const plan = suggestionPlan(view);
    assert.equal(plan.length, 3, "still at most three");
    assert.ok(plan.every((item) => item.open === true));
    assert.deepEqual(plan.map((item) => item.text), DRAGONS.slice(0, 3).map((island) => island.teaser));
    assert.deepEqual(suggestionPlan({ replies: 3, frontier: [] }), []);
  });

  it("never offers a place without a teaser", () => {
    const islands = [{ id: "x", teaser: "", status: undefined }, { id: "y", teaser: "Why y?" }];
    assert.deepEqual(suggestionItems({ replies: 1, frontier: ["x", "y"] }, { islands }), ["Why y?"]);
  });
});

describe("chips for the open list say so, and the label is never part of the question", () => {
  function chipsFor() {
    const doc = makeDoc();
    const mount = mountIn(doc);
    const picked = [];
    const chips = createSuggestions({ document: doc, mount, onPick: (text) => picked.push(text) });
    const buttons = () => mount.find((node) => node.tag === "button");
    return { doc, mount, chips, picked, buttons };
  }

  it("shows \"open, not ratified\" inside an open chip and sends only the question", () => {
    const { chips, picked, buttons } = chipsFor();
    chips.render([{ text: "What is still open?", open: true }]);
    const [chip] = buttons();
    assert.equal(chip.textContent, "What is still open?open, not ratified");
    const tag = chip.all("atlas-chip-tag")[0];
    assert.equal(tag.textContent, "open, not ratified");
    assert.equal(tag.hidden, false);
    chip.click();
    assert.deepEqual(picked, ["What is still open?"], "the label is not sent");
  });

  it("an ordinary chip shows no label and its text is just the question", () => {
    const { chips, buttons } = chipsFor();
    chips.render(["Plain question?", { text: "Open question?", open: true }]);
    const [plain, open] = buttons();
    assert.equal(plain.textContent, "Plain question?");
    assert.equal(plain.all("atlas-chip-tag")[0].hidden, true);
    assert.equal(open.all("atlas-chip-tag")[0].hidden, false);
  });

  it("the focused chip stays when it turns from open to ordinary", () => {
    const { doc, chips, buttons } = chipsFor();
    chips.render([{ text: "What is still open?", open: true }]);
    const chip = buttons()[0];
    chip.focus();
    chips.render(["Something else?"]);
    assert.equal(buttons()[0], chip);
    assert.equal(doc.activeElement, chip);
    assert.equal(chip.textContent, "Something else?");
    assert.equal(chip.all("atlas-chip-tag")[0].hidden, true);
  });

  it("an open chip is paused like any other", () => {
    const { chips, picked, buttons } = chipsFor();
    chips.render([{ text: "Q?", open: true }], { paused: true });
    const [chip] = buttons();
    assert.equal(chip.getAttribute("aria-disabled"), "true");
    chip.click();
    assert.deepEqual(picked, []);
  });
});
