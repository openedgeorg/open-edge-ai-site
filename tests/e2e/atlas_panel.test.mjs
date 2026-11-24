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
import { LIST_EMPTY, LIST_FILTERS, createAtlasList, matchesFilter, regionCountsText } from "../../site/js/atlas-list.js";
import {
  OPEN_STATUS_WORD,
  START_NOTE,
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

// ---------------------------------------------------------------------------------------------
// the inspector keeps what was looked at (F06)
// ---------------------------------------------------------------------------------------------

describe("inspector: the card is the place being read, not a tooltip (F06)", () => {
  const edgeOf = (a, b) => index.byKey.get([a, b].sort().join("|"));

  function inspectorWith(visited, options = {}) {
    const doc = makeDoc();
    const mount = mountIn(doc);
    const log = { asked: [], paths: [], shown: [] };
    const inspector = createInspector({
      document: doc,
      graph,
      index,
      mount,
      onAsk: (id) => log.asked.push(id),
      onPath: (key) => log.paths.push(key),
      onShow: (id) => log.shown.push(id),
      ...options,
    });
    const view = deriveView({ visited, replies: 2 }, index);
    return { doc, mount, inspector, view, log };
  }
  const buttons = (mount, className) => mount.all(className);

  it("keeps the place it shows when the page refreshes it (a reply, a pause, a scroll): only showIsland(null) puts the hint back", () => {
    const { inspector, mount, view } = inspectorWith([graph.START_ID, NEXT_TO_START]);
    inspector.showIsland(graph.START_ID, view);
    assert.equal(mount.all("atlas-inspector-name")[0].textContent, index.byId.get(graph.START_ID).name);
    inspector.refresh(view, { paused: true });
    inspector.refresh(deriveView({ visited: [graph.START_ID, NEXT_TO_START, NOT_NEXT], replies: 3 }, index), { paused: false });
    assert.equal(mount.all("atlas-inspector-name")[0].textContent, index.byId.get(graph.START_ID).name, "still the same place");
    assert.equal(mount.all("is-hint").length, 0);
    assert.deepEqual(inspector.current(), { island: graph.START_ID, edge: null });
    inspector.showIsland(null, view);
    assert.equal(mount.all("is-hint").length, 1, "told to let go, it shows the hint");
    assert.deepEqual(inspector.current(), { island: null, edge: null });
  });

  it("the hint says that the card stays", () => {
    const { mount } = inspectorWith([graph.START_ID]);
    assert.match(mount.all("atlas-inspector-hint")[0].textContent, /stays here until you pick another/);
  });

  it("the start place says it is only a starting marker, and no other place does", () => {
    const { inspector, mount, view } = inspectorWith([graph.START_ID]);
    inspector.showIsland(graph.START_ID, view);
    assert.equal(mount.all("atlas-inspector-start")[0].textContent, START_NOTE);
    assert.match(START_NOTE, /starting point/i);
    assert.match(START_NOTE, /whether or not an answer has mentioned it/);
    assert.doesNotMatch(START_NOTE, /learned|understood|verified|mastered|ratified/i, "never as something known");
    inspector.showIsland(NEXT_TO_START, view);
    assert.equal(mount.all("atlas-inspector-start").length, 0);
  });

  it("offers to ask about a visited place again and to ask a place that is next to explore, and about no other", () => {
    const { inspector, mount, view, log } = inspectorWith([graph.START_ID]);
    const start = index.byId.get(graph.START_ID);
    inspector.showIsland(graph.START_ID, view);
    const again = buttons(mount, "atlas-inspector-ask")[0];
    assert.equal(again.textContent, "Ask about this again");
    assert.equal(again.getAttribute("aria-label"), `Ask about this again: ${start.teaser}`);
    assert.equal(again.type, "button");
    again.click();
    assert.deepEqual(log.asked, [graph.START_ID]);

    inspector.showIsland(NEXT_TO_START, view);
    const ask = buttons(mount, "atlas-inspector-ask")[0];
    assert.equal(ask.textContent, "Ask this question");
    ask.click();
    assert.deepEqual(log.asked, [graph.START_ID, NEXT_TO_START]);

    inspector.showIsland(NOT_NEXT, view);
    assert.equal(mount.all("is-hint").length, 1, "a place in the fog is not described at all");
    assert.equal(buttons(mount, "atlas-inspector-ask").length, 0);
  });

  it("draws no Ask button when no handler is given (the card is then only a reading)", () => {
    const { inspector, mount, view } = inspectorWith([graph.START_ID], { onAsk: undefined });
    inspector.showIsland(graph.START_ID, view);
    assert.equal(buttons(mount, "atlas-inspector-ask").length, 0);
    assert.match(mount.all("atlas-inspector-teaser")[0].textContent, /^Ask: /, "the question itself is still shown");
  });

  it("locks the Ask button while a question runs with aria-disabled, in place, so focus survives", () => {
    const { doc, inspector, mount, view, log } = inspectorWith([graph.START_ID]);
    inspector.showIsland(graph.START_ID, view);
    const button = buttons(mount, "atlas-inspector-ask")[0];
    button.focus();
    inspector.refresh(view, { paused: true });
    assert.equal(buttons(mount, "atlas-inspector-ask")[0], button, "the same element");
    assert.equal(doc.activeElement, button, "still focused");
    assert.equal(button.getAttribute("aria-disabled"), "true");
    assert.equal(button.getAttribute("aria-describedby"), "atlas-notice");
    assert.equal(button.hasAttribute("disabled"), false, "never the disabled attribute: it would drop focus");
    button.click();
    assert.deepEqual(log.asked, [], "a paused button asks nothing");
    inspector.refresh(view, { paused: false });
    assert.equal(button.getAttribute("aria-disabled"), null);
    assert.equal(button.getAttribute("aria-describedby"), null);
    button.click();
    assert.deepEqual(log.asked, [graph.START_ID]);
    // A card shown while paused is locked from the start.
    inspector.refresh(view, { paused: true });
    inspector.showIsland(NEXT_TO_START, view);
    assert.equal(buttons(mount, "atlas-inspector-ask")[0].getAttribute("aria-disabled"), "true");
  });

  it("hands the focus on when the card it holds is rebuilt (the place asked about has just been visited)", () => {
    const { doc, inspector, mount } = inspectorWith([graph.START_ID]);
    const before = deriveView({ visited: [graph.START_ID], replies: 1 }, index);
    inspector.showIsland(NEXT_TO_START, before);
    const ask = buttons(mount, "atlas-inspector-ask")[0];
    ask.focus();
    assert.equal(doc.activeElement, ask);
    inspector.refresh(deriveView({ visited: [graph.START_ID, NEXT_TO_START], replies: 2 }, index));
    const now = buttons(mount, "atlas-inspector-ask")[0];
    assert.notEqual(now, ask, "the card was rebuilt");
    assert.equal(now.textContent, "Ask about this again", "as a visited place");
    assert.equal(doc.activeElement, now, "and focus is on the new Ask button, not dropped to the page");
  });

  it("makes every lit path of a visited place a button that names the path, and tells the owner which was chosen", () => {
    const { inspector, mount, log } = inspectorWith([graph.START_ID, NEXT_TO_START]);
    const view = deriveView({ visited: [graph.START_ID, NEXT_TO_START], replies: 2 }, index);
    inspector.showIsland(graph.START_ID, view);
    const edge = edgeOf(graph.START_ID, NEXT_TO_START);
    const found = buttons(mount, "atlas-inspector-path-button");
    assert.ok(found.length >= 1);
    const wanted = `→ ${index.byId.get(NEXT_TO_START).name}: ${edge.label}`;
    const mine = found.find((node) => node.textContent === wanted);
    assert.ok(mine, `a button reads "${wanted}"`);
    assert.equal(mine.type, "button");
    mine.click();
    assert.deepEqual(log.paths, [[graph.START_ID, NEXT_TO_START].sort().join("|")]);
  });

  it("keeps the paths as plain lines when nobody listens", () => {
    const { inspector, mount } = inspectorWith([graph.START_ID, NEXT_TO_START], { onPath: undefined });
    const view = deriveView({ visited: [graph.START_ID, NEXT_TO_START], replies: 2 }, index);
    inspector.showIsland(graph.START_ID, view);
    assert.equal(buttons(mount, "atlas-inspector-path-button").length, 0);
    assert.match(mount.all("atlas-inspector-path")[0].textContent, /^→ /);
  });

  it("describes a lit path with both of its places as buttons, and not a path that is not lit", () => {
    const { inspector, mount, view, log } = inspectorWith([graph.START_ID, NEXT_TO_START]);
    const edge = edgeOf(graph.START_ID, NEXT_TO_START);
    const key = [graph.START_ID, NEXT_TO_START].sort().join("|");
    inspector.showEdge(key, view);
    assert.equal(mount.all("atlas-inspector-name")[0].textContent, `${index.byId.get(edge.a).name} ↔ ${index.byId.get(edge.b).name}`);
    assert.equal(mount.all("atlas-inspector-label-path")[0].textContent, edge.label);
    const ends = buttons(mount, "atlas-inspector-end");
    assert.deepEqual(ends.map((node) => node.textContent), [`Show ${index.byId.get(edge.a).name}`, `Show ${index.byId.get(edge.b).name}`]);
    ends[1].click();
    assert.deepEqual(log.shown, [edge.b]);
    assert.deepEqual(inspector.current(), { island: null, edge: key });
    // Letting go of the path falls back to the place that was showing before it.
    inspector.showIsland(graph.START_ID, view);
    inspector.showEdge(key, view);
    inspector.showEdge(null, view);
    assert.equal(mount.all("atlas-inspector-name")[0].textContent, index.byId.get(graph.START_ID).name);
    // A path with an unvisited end is not lit and is not described.
    const dim = deriveView({ visited: [graph.START_ID], replies: 1 }, index);
    inspector.showEdge(key, dim);
    assert.equal(mount.all("is-hint").length === 1 || mount.all("atlas-inspector-label-path").length === 0, true);
  });
});

// ---------------------------------------------------------------------------------------------
// the list is steered, not read top to bottom (F05)
// ---------------------------------------------------------------------------------------------

describe("list view: regions, filters and a jump (F05)", () => {
  function steered(visited, options = {}) {
    const doc = makeDoc();
    const asked = [];
    const said = [];
    const list = createAtlasList({
      document: doc,
      graph,
      index,
      onActivate: (id) => asked.push(id),
      onAnnounce: (text) => said.push(text),
      ...options,
    });
    doc.root.appendChild(list.element);
    const view = deriveView({ visited, replies: visited.length > 1 ? 2 : 0 }, index);
    return { doc, list, view, asked, said };
  }
  const rowOf = (list, id) => {
    const island = index.byId.get(id);
    return list.element.find((node) => node.classList.contains("atlas-list-item") && node.all("atlas-list-name")[0].textContent === island.name)[0];
  };
  const shownRows = (list) => list.element.find((node) => node.classList.contains("atlas-list-item") && !node.hidden && list.isShown(nameToId(node.all("atlas-list-name")[0].textContent)));
  const nameToId = (name) => graph.ISLANDS.find((island) => island.name === name).id;
  const toggleOf = (list, regionId) => list.element.find((node) => node.tag === "button" && node.getAttribute("aria-controls") === `atlas-list-items-${regionId}`)[0];
  const regionIds = graph.REGIONS.map((region) => region.id);
  const regionOf = (id) => index.byId.get(id).region;
  const ordinaryFrontier = (view) => view.frontier.filter((id) => index.byId.get(id).status !== "open");

  it("matchesFilter: all lets everything through, visited only visited, next to explore only an ordinary place on the frontier", () => {
    const ordinaryPlace = { status: undefined };
    const dragon = { status: "open" };
    for (const status of ["visited", "frontier", "fogged"]) assert.equal(matchesFilter("all", status, ordinaryPlace), true);
    assert.deepEqual(["visited", "frontier", "fogged"].map((status) => matchesFilter("visited", status, ordinaryPlace)), [true, false, false]);
    assert.deepEqual(["visited", "frontier", "fogged"].map((status) => matchesFilter("frontier", status, ordinaryPlace)), [false, true, false]);
    assert.equal(matchesFilter("frontier", "frontier", dragon), false, "a dragon is never a next step, even on the frontier");
    assert.equal(matchesFilter("visited", "visited", dragon), true, "a visited dragon is visited like any other place");
    assert.deepEqual(LIST_FILTERS.map((entry) => entry.id), ["all", "visited", "frontier"]);
    assert.deepEqual(LIST_FILTERS.map((entry) => entry.label), ["All places", "Visited", "Next to explore"]);
    assert.match(LIST_EMPTY.frontier, /Here be dragons/);
    assert.equal(regionCountsText({ visited: 2, total: 5, next: 0 }), "2 of 5 visited");
    assert.equal(regionCountsText({ visited: 2, total: 5, next: 3 }), "2 of 5 visited · 3 next to explore");
  });

  it("keeps all 65 rows in the page, one disclosure per region, whatever is open", () => {
    const { list, view } = steered([graph.START_ID]);
    list.render(view, { focus: [graph.START_ID] });
    assert.equal(list.element.all("atlas-list-item").length, graph.ISLANDS.length);
    assert.equal(list.element.find((node) => node.tag === "h3").length, graph.REGIONS.length);
    for (const region of graph.REGIONS) {
      const h3 = list.element.find((node) => node.tag === "h3" && node.id === `atlas-list-region-${region.id}`)[0];
      assert.equal(h3.textContent, `${region.name} · ${region.level} · ${region.subtitle}`, "the heading holds only its own words");
      assert.equal(h3.children[0].tag, "button", "and the button that opens the region");
    }
  });

  it("opens by itself the regions around the places the visitor was last told about, and closes the rest", () => {
    const { list, view } = steered([graph.START_ID]);
    list.render(view, { focus: [graph.START_ID] });
    const around = new Set([regionOf(graph.START_ID), ...ordinaryFrontier(view).map(regionOf), ...view.frontier.map(regionOf)]);
    for (const id of regionIds) assert.equal(list.isOpen(id), around.has(id), `${id} is ${around.has(id) ? "open" : "closed"}`);
    assert.ok(regionIds.some((id) => !list.isOpen(id)), "some region is closed");
    for (const id of regionIds) {
      const open = list.isOpen(id);
      assert.equal(toggleOf(list, id).getAttribute("aria-expanded"), String(open));
      const items = list.element.find((node) => node.id === `atlas-list-items-${id}`)[0];
      assert.equal(items.hidden, !open);
    }
    // A frontier row of an open region is on show: its Ask button can be used.
    const next = ordinaryFrontier(view)[0];
    assert.equal(list.isShown(next), true);
    assert.equal(rowOf(list, next).all("atlas-list-ask")[0].hidden, false);
  });

  it("follows the latest reply: new places are marked 'new' and their regions are open", () => {
    const { list } = steered([graph.START_ID]);
    const far = graph.ISLANDS.find((island) => island.region === "badlands" && island.status !== "open");
    const near = graph.START_ID;
    const view = deriveView({ visited: [near, far.id], replies: 2 }, index);
    list.render(view, { fresh: [far.id], focus: [far.id] });
    assert.equal(list.isOpen("badlands"), true);
    const row = rowOf(list, far.id);
    assert.equal(row.all("atlas-list-new")[0].hidden, false);
    assert.equal(row.classList.contains("is-new"), true);
    assert.equal(rowOf(list, near).all("atlas-list-new")[0].hidden, true);
    list.render(view, { fresh: [], focus: [far.id] });
    assert.equal(row.all("atlas-list-new")[0].hidden, true, "the mark goes with the next reply");
    assert.equal(list.isOpen("badlands"), true, "the region stays while the focus is the same");
  });

  it("the visitor's own choice beats the automatic rule, and a toggle button opens and closes", () => {
    const { list, view } = steered([graph.START_ID]);
    list.render(view, { focus: [graph.START_ID] });
    const home = regionOf(graph.START_ID);
    const far = regionIds.find((id) => !list.isOpen(id));
    toggleOf(list, far).click();
    assert.equal(list.isOpen(far), true);
    assert.equal(toggleOf(list, far).getAttribute("aria-expanded"), "true");
    toggleOf(list, home).click();
    assert.equal(list.isOpen(home), false);
    // A new render with the same focus leaves both choices alone; a new focus does not undo them either.
    list.render(view, { focus: [graph.START_ID] });
    assert.equal(list.isOpen(far), true);
    assert.equal(list.isOpen(home), false);
    list.render(deriveView({ visited: [graph.START_ID, NEXT_TO_START], replies: 2 }, index), { focus: [NEXT_TO_START] });
    assert.equal(list.isOpen(far), true, "a region the visitor opened stays open");
    assert.equal(list.isOpen(home), false, "and one they closed stays closed");
  });

  it("a region the visitor is working in is not closed by a new reply", () => {
    const { doc, list, view } = steered([graph.START_ID]);
    list.render(view, { focus: [graph.START_ID] });
    const next = ordinaryFrontier(view)[0];
    const row = rowOf(list, next);
    row.all("atlas-list-ask")[0].focus();
    const farPlace = graph.ISLANDS.find((island) => island.region === "valley" && island.status !== "open");
    list.render(deriveView({ visited: [graph.START_ID, farPlace.id], replies: 2 }, index), { fresh: [farPlace.id], focus: [farPlace.id] });
    assert.equal(list.isOpen(regionOf(next)), true, "the region that holds the focused button stays");
    assert.ok(list.element.contains(doc.activeElement));
  });

  it("filters: Visited and Next to explore hide the rest, hide regions with nothing in them, open the rest and count honestly", () => {
    const { list, view, said } = steered([graph.START_ID, NEXT_TO_START]);
    const full = deriveView({ visited: [graph.START_ID, NEXT_TO_START], replies: 2 }, index);
    list.render(full, { focus: [NEXT_TO_START] });
    const labels = list.element.all("atlas-list-filter").map((node) => node.textContent);
    assert.deepEqual(labels, [`All places (${graph.ISLANDS.length})`, "Visited (2)", `Next to explore (${ordinaryFrontier(full).length})`]);
    assert.equal(list.filter(), "all");

    list.setFilter("visited");
    assert.equal(list.filter(), "visited");
    assert.deepEqual(new Set(list.element.all("atlas-list-item").filter((node) => !node.hidden).map((node) => node.all("atlas-list-name")[0].textContent)), new Set([graph.START_ID, NEXT_TO_START].map((id) => index.byId.get(id).name)));
    const sections = list.element.find((node) => node.tag === "section");
    assert.equal(sections.filter((node) => !node.hidden).length, new Set([regionOf(graph.START_ID), regionOf(NEXT_TO_START)]).size, "only regions with a visited place stay");
    assert.equal(list.element.all("atlas-list-filter")[1].getAttribute("aria-pressed"), "true");
    assert.equal(list.element.all("atlas-list-filter")[0].getAttribute("aria-pressed"), "false");
    assert.match(said.at(-1), /Visited: 2 of 65 places/);

    list.setFilter("frontier");
    const shown = list.element.all("atlas-list-item").filter((node) => !node.hidden).map((node) => node.all("atlas-list-name")[0].textContent);
    assert.deepEqual(new Set(shown), new Set(ordinaryFrontier(full).map((id) => index.byId.get(id).name)));
    for (const name of shown) assert.equal(rowOf(list, nameToId(name)).all("atlas-list-ask")[0].hidden, false, `${name} can be asked`);
    for (const id of new Set(ordinaryFrontier(full).map(regionOf))) assert.equal(list.isOpen(id), true, `${id} is open under the filter`);

    assert.equal(list.setFilter("nonsense"), false, "an unknown filter is refused");
    assert.equal(list.filter(), "frontier");
    list.setFilter("all");
    assert.equal(list.element.all("atlas-list-item").filter((node) => node.hidden).length, 0, "All shows every row again");
  });

  it("Next to explore never lists a dragon; with nothing else left it says where the open list is", () => {
    const { list } = steered([]);
    const everythingButDragons = deriveView({ visited: ORDINARY, replies: 3 }, index);
    list.render(everythingButDragons, {});
    assert.equal(ordinaryFrontier(everythingButDragons).length, 0);
    assert.ok(everythingButDragons.frontier.length >= 1, "dragons are on the frontier");
    list.setFilter("frontier");
    assert.equal(list.element.all("atlas-list-item").filter((node) => !node.hidden).length, 0);
    const message = list.element.all("atlas-list-empty")[0];
    assert.equal(message.hidden, false);
    assert.equal(message.textContent, LIST_EMPTY.frontier);
    assert.equal(list.element.all("atlas-list-filter")[2].textContent, "Next to explore (0)");
    list.setFilter("visited");
    assert.equal(list.element.all("atlas-list-empty")[0].hidden, true, "Visited has rows");
  });

  it("jumps to a region: it opens, the heading is brought up, the menu is for the visitor to choose again, and it is said", () => {
    const { list, view, said } = steered([graph.START_ID]);
    list.render(view, { focus: [graph.START_ID] });
    const select = list.element.find((node) => node.tag === "select")[0];
    assert.deepEqual(select.children.map((option) => option.value), ["", ...regionIds], "every region is offered, after a prompt");
    assert.match(select.children[1].textContent, /^The Coast · L0 · The promise \(1 of 5 visited/);
    assert.equal(list.element.find((node) => node.tag === "label")[0].getAttribute("for"), select.id);
    const scrolled = [];
    const heading = list.element.find((node) => node.id === "atlas-list-region-dragons")[0];
    heading.scrollIntoView = (options) => scrolled.push(options);
    assert.equal(list.isOpen("dragons"), false);
    select.value = "dragons";
    select.fire("change");
    assert.equal(list.isOpen("dragons"), true, "the region opened");
    assert.deepEqual(scrolled, [{ block: "start", behavior: "auto" }], "and its heading was brought to the top");
    assert.equal(select.value, "", "the menu is ready for the next jump");
    assert.match(said.at(-1), /^Here be dragons · L7 · Open, not ratified: 0 of 16 visited\.$/);
    assert.equal(list.jumpToRegion("nowhere"), false);
  });

  it("the jump menu only offers regions that show something under the current filter, and a jump out of the filter goes back to all places", () => {
    const { list, view } = steered([graph.START_ID]);
    list.render(view, { focus: [graph.START_ID] });
    const select = list.element.find((node) => node.tag === "select")[0];
    list.setFilter("visited");
    assert.deepEqual(select.children.map((option) => option.value), ["", regionOf(graph.START_ID)]);
    assert.equal(list.jumpToRegion("valley"), true, "a region the filter hides can still be asked for");
    assert.equal(list.filter(), "all", "which shows all places again");
    assert.equal(list.isOpen("valley"), true);
  });

  it("Expand all opens every region and becomes Collapse all, and back; every row stays in the page", () => {
    const { list, view, said } = steered([graph.START_ID]);
    list.render(view, { focus: [graph.START_ID] });
    const bulk = list.element.all("atlas-list-bulk")[0];
    assert.equal(bulk.textContent, "Expand all");
    bulk.click();
    for (const id of regionIds) assert.equal(list.isOpen(id), true, id);
    assert.equal(bulk.textContent, "Collapse all");
    assert.equal(graph.ISLANDS.filter((island) => list.isShown(island.id)).length, graph.ISLANDS.length, "all 65 places are on show");
    assert.match(said.at(-1), /expanded/);
    bulk.click();
    for (const id of regionIds) assert.equal(list.isOpen(id), false, id);
    assert.equal(bulk.textContent, "Expand all");
    assert.equal(list.element.all("atlas-list-item").length, graph.ISLANDS.length, "collapsed rows are hidden, never removed");
    list.render(view, { focus: [graph.START_ID] });
    for (const id of regionIds) assert.equal(list.isOpen(id), false, "a new render does not undo the visitor's collapse");
  });

  it("reveal opens the region, drops a filter that hides the place, and centres the row", () => {
    const { list, view } = steered([graph.START_ID]);
    list.render(view, { focus: [graph.START_ID] });
    const target = graph.ISLANDS.find((island) => island.region === "mountains");
    const row = rowOf(list, target.id);
    const scrolled = [];
    row.scrollIntoView = (options) => scrolled.push(options);
    list.setFilter("visited");
    assert.equal(list.reveal(target.id, { behavior: "smooth" }), true);
    assert.equal(list.filter(), "all", "the filter that hid it is dropped");
    assert.equal(list.isOpen("mountains"), true);
    assert.deepEqual(scrolled, [{ block: "center", behavior: "smooth" }]);
    assert.equal(list.reveal("nowhere"), false);
    assert.equal(list.box("nowhere"), null);
  });

  it("offers Ask again on a visited place, Ask on a place next to explore, and neither in the fog; both lock while paused", () => {
    const { list, asked } = steered([graph.START_ID]);
    const view = deriveView({ visited: [graph.START_ID], replies: 1 }, index);
    list.render(view, { focus: [graph.START_ID] });
    const startRow = rowOf(list, graph.START_ID);
    const nextRow = rowOf(list, NEXT_TO_START);
    const fogRow = rowOf(list, NOT_NEXT);
    const again = startRow.all("atlas-list-again")[0];
    assert.equal(again.hidden, false);
    assert.equal(again.textContent, index.byId.get(graph.START_ID).teaser, "the question itself (the label is drawn by the style sheet)");
    assert.equal(startRow.all("atlas-list-ask")[0].hidden, true, "a visited place has no Ask button, only the quieter one");
    assert.equal(nextRow.all("atlas-list-again")[0].hidden, true);
    assert.equal(nextRow.all("atlas-list-ask")[0].hidden, false);
    for (const className of ["atlas-list-ask", "atlas-list-again"]) assert.equal(fogRow.all(className)[0].hidden, true, `${className} in the fog`);
    again.click();
    assert.deepEqual(asked, [graph.START_ID]);

    list.render(view, { paused: true, focus: [graph.START_ID] });
    assert.equal(again.getAttribute("aria-disabled"), "true");
    assert.equal(again.getAttribute("aria-describedby"), "atlas-notice");
    assert.equal(again.hasAttribute("disabled"), false);
    again.click();
    assert.deepEqual(asked, [graph.START_ID], "paused: nothing is asked");
    list.render(view, { paused: false, focus: [graph.START_ID] });
    assert.equal(again.getAttribute("aria-disabled"), null);
  });

  it("moves focus to the row, not to the page, when the place a focused Ask again button belongs to goes back into the fog", () => {
    const { doc, list } = steered([graph.START_ID]);
    list.render(deriveView({ visited: [graph.START_ID], replies: 1 }, index), { focus: [graph.START_ID] });
    const row = rowOf(list, graph.START_ID);
    const again = row.all("atlas-list-again")[0];
    again.focus();
    assert.equal(doc.activeElement, again);
    list.render(deriveView({ visited: [], replies: 0 }, index), { focus: [] });
    assert.equal(again.hidden, true);
    assert.equal(doc.activeElement, row);
  });

  it("hands focus to the filter when the row that holds it leaves a filtered list (the place asked about was visited)", () => {
    const { doc, list } = steered([graph.START_ID]);
    list.render(deriveView({ visited: [graph.START_ID], replies: 1 }, index), { focus: [graph.START_ID] });
    list.setFilter("frontier");
    const ask = rowOf(list, NEXT_TO_START).all("atlas-list-ask")[0];
    ask.focus();
    assert.equal(doc.activeElement, ask);
    list.render(deriveView({ visited: [graph.START_ID, NEXT_TO_START], replies: 2 }, index), { focus: [NEXT_TO_START] });
    assert.equal(rowOf(list, NEXT_TO_START).hidden, true, "a visited place is not next to explore");
    assert.equal(doc.activeElement, list.element.all("atlas-list-filter")[2], "focus is on the filter, not on the page");
  });

  it("never calls a dragon next to explore in the filters either", () => {
    const { list } = steered([]);
    list.render(deriveView({ visited: ORDINARY, replies: 3 }, index), {});
    for (const filter of ["all", "visited", "frontier"]) {
      list.setFilter(filter);
      for (const node of list.element.all("atlas-list-item").filter((row) => !row.hidden && row.classList.contains("is-open"))) {
        assert.doesNotMatch(node.textContent, FORBIDDEN_FOR_DRAGONS, `${filter}: ${node.all("atlas-list-name")[0].textContent}`);
      }
      assert.doesNotMatch(list.element.all("atlas-list-counts").map((node) => node.textContent).join(" | ").replace(/\d+ next to explore/g, ""), FORBIDDEN_FOR_DRAGONS);
    }
    const dragonRegionCounts = list.element.all("atlas-list-counts").at(-1).textContent;
    assert.doesNotMatch(dragonRegionCounts, /next to explore/, "the open list's region does not count next steps");
  });
});
