/**
 * Unit tests for the geometry of the Atlas map that needs no DOM: which place an arrow key follows
 * (near neighbours beat far near-axis ones, every path can be followed), and how far to scroll to
 * bring a lit place into view. The map itself is driven in Chrome by atlas_browser_ui.test.mjs.
 *
 * Run: node --test tests/e2e/atlas_map.test.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as graph from "../../site/js/atlas-graph.js";
import {
  ARROW_KEYS,
  ARROW_MIN_COS,
  EDGE_STRIP,
  createArrowNav,
  pickNeighbour,
  rankInDirection,
  revealDeltas,
} from "../../site/js/atlas-map.js";

const index = graph.buildIndex();
const RIGHT = ARROW_KEYS.ArrowRight;
const OPPOSITE = { ArrowRight: "ArrowLeft", ArrowLeft: "ArrowRight", ArrowDown: "ArrowUp", ArrowUp: "ArrowDown" };

/** A tiny graph for the navigation machine: a hub and three places to its right, one above. */
function tiny() {
  const islands = [
    { id: "hub", x: 100, y: 300 },
    { id: "near", x: 200, y: 300 },
    { id: "mid", x: 300, y: 330 },
    { id: "far", x: 500, y: 290 },
    { id: "up", x: 100, y: 100 },
  ];
  const edges = [["hub", "near"], ["hub", "mid"], ["hub", "far"], ["hub", "up"]];
  const byId = new Map(islands.map((island) => [island.id, island]));
  const neighbours = new Map(islands.map((island) => [island.id, new Set()]));
  for (const [a, b] of edges) {
    neighbours.get(a).add(b);
    neighbours.get(b).add(a);
  }
  return { byId, neighbours };
}

describe("rankInDirection: angle and distance together", () => {
  const from = { x: 0, y: 0 };

  it("a near neighbour a little off the axis beats a far one dead on the axis", () => {
    const candidates = [
      { id: "far-on-axis", x: 400, y: 4 },
      { id: "near-off-axis", x: 70, y: 40 },
    ];
    assert.deepEqual(rankInDirection(from, candidates, RIGHT), ["near-off-axis", "far-on-axis"]);
    assert.equal(pickNeighbour(from, candidates, RIGHT), "near-off-axis");
  });

  it("at equal distance the better aimed neighbour wins", () => {
    const candidates = [
      { id: "leaning", x: 80, y: 60 },
      { id: "straight", x: 100, y: 0 },
    ];
    assert.equal(pickNeighbour(from, candidates, RIGHT), "straight");
  });

  it("ignores a path outside the cone and says null when nothing lies that way", () => {
    assert.equal(ARROW_MIN_COS, 0.4);
    const candidates = [
      { id: "steeply-below", x: 20, y: 100 },
      { id: "behind", x: -100, y: 0 },
    ];
    assert.equal(pickNeighbour(from, candidates, RIGHT), null);
    assert.deepEqual(rankInDirection(from, candidates, RIGHT), []);
    assert.equal(pickNeighbour(from, [{ id: "just-inside", x: 100, y: 190 }], RIGHT), "just-inside", "cos 0.47");
    assert.equal(pickNeighbour(from, [{ id: "just-outside", x: 100, y: 250 }], RIGHT), null, "cos 0.37");
  });

  it("breaks an exact tie by id, so the answer never depends on the order of the list", () => {
    const candidates = [
      { id: "b", x: 100, y: 0 },
      { id: "a", x: 100, y: 0 },
    ];
    assert.deepEqual(rankInDirection(from, candidates, RIGHT), ["a", "b"]);
    assert.deepEqual(rankInDirection(from, [...candidates].reverse(), RIGHT), ["a", "b"]);
  });
});

describe("createArrowNav", () => {
  function nav(extra = {}) {
    const { byId, neighbours } = tiny();
    return createArrowNav({ index: { byId, neighbours }, usable: () => true, ...extra });
  }

  it("takes the best place that way first", () => {
    const arrows = nav();
    assert.equal(arrows.press("hub", "ArrowRight"), "near");
    assert.equal(arrows.press("hub", "ArrowUp"), "up");
    assert.equal(arrows.press("hub", "ArrowLeft"), null, "nothing lies to the left");
    assert.equal(arrows.press("hub", "KeyX"), null, "not an arrow key");
  });

  it("the opposite arrow goes back, and the same arrow again takes the next place that way", () => {
    const arrows = nav();
    const seen = [];
    for (let round = 0; round < 4; round += 1) {
      const there = arrows.press("hub", "ArrowRight");
      seen.push(there);
      arrows.observe(there);
      assert.equal(arrows.press(there, "ArrowLeft"), "hub", "back to where the arrow came from");
      arrows.observe("hub");
    }
    assert.deepEqual(seen, ["near", "mid", "far", "near"], "right, left, right, left tries each place to the right in turn, then starts over");
  });

  it("another arrow or a move the arrows did not make ends the back-and-forth", () => {
    const arrows = nav();
    let there = arrows.press("hub", "ArrowRight");
    arrows.observe(there);
    arrows.press(there, "ArrowLeft");
    arrows.observe("hub");
    assert.equal(arrows.press("hub", "ArrowUp"), "up");
    arrows.observe("up");
    assert.equal(arrows.press("hub", "ArrowRight"), "near", "after another arrow the first place comes first again");

    there = arrows.press("hub", "ArrowRight");
    arrows.observe(there);
    arrows.press(there, "ArrowLeft");
    arrows.observe("hub");
    arrows.observe("far"); // focus went elsewhere (a click or Tab), then came back
    arrows.observe("hub");
    assert.equal(arrows.press("hub", "ArrowRight"), "near");
  });

  it("forgets everything on request and skips a path that is not drawn", () => {
    const hidden = new Set(["near"]);
    const arrows = nav({ usable: (from, other) => !hidden.has(other) });
    assert.equal(arrows.press("hub", "ArrowRight"), "mid", "an undrawn path is not offered");
    arrows.forget();
    arrows.observe("mid");
    assert.equal(arrows.press("mid", "ArrowLeft"), "hub", "after forgetting, the opposite arrow is an ordinary arrow again");
  });
});

/** All presses it takes to reach `target` from `from` with `key`, on a fresh state; null if it cannot. */
function reach(arrows, from, key, target) {
  const list = arrows.ranked(from, key);
  const rank = list.indexOf(target);
  if (rank < 0) return null;
  let there = null;
  for (let i = 0; i <= rank; i += 1) {
    there = arrows.press(from, key);
    arrows.observe(there);
    if (i < rank) {
      assert.equal(arrows.press(there, OPPOSITE[key]), from, `${there} goes back to ${from}`);
      arrows.observe(from);
    }
  }
  return there === target ? rank : null;
}

describe("every drawn path can be followed by an arrow key (the shipped graph)", () => {
  function reachable(edge, usable) {
    for (const [from, to] of [[edge.a, edge.b], [edge.b, edge.a]]) {
      for (const key of Object.keys(ARROW_KEYS)) {
        const arrows = createArrowNav({ index, usable });
        if (reach(arrows, from, key, to) !== null) return { from, to, key };
      }
    }
    return null;
  }

  it("with every place visited, each path is followable from at least one of its ends", () => {
    const stuck = graph.EDGES.filter((edge) => !reachable(edge, () => true)).map((edge) => `${edge.a} <-> ${edge.b}`);
    assert.deepEqual(stuck, [], "paths no arrow key can follow from either end");
  });

  it("the paths the proposal names as examples are followable too (when the places exist)", () => {
    for (const [a, b] of [["ats", "heea"], ["the-pot", "overdraft"]]) {
      const edge = index.byKey.get(graph.edgeKey(a, b));
      if (edge) assert.ok(reachable(edge, () => true), `${a} <-> ${b}`);
    }
  });

  it("the nearest place that way is one key press away, so most paths need no back-and-forth", () => {
    // A near neighbour wins over a far one: count the paths that are the first choice of some end.
    let first = 0;
    for (const edge of graph.EDGES) {
      const arrows = createArrowNav({ index, usable: () => true });
      const direct = [[edge.a, edge.b], [edge.b, edge.a]].some(([from, to]) => Object.keys(ARROW_KEYS).some((key) => arrows.ranked(from, key)[0] === to));
      if (direct) first += 1;
    }
    assert.ok(first / graph.EDGES.length >= 0.6, `${first} of ${graph.EDGES.length} paths are the first choice of an arrow at one end`);
  });

  it("in a half-explored map every DRAWN path is followable (a path is drawn when an end is visited)", () => {
    // A small deterministic generator, so a failure names a state that can be rebuilt.
    let seed = 20261010;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let round = 0; round < 12; round += 1) {
      const visited = new Set([graph.START_ID]);
      for (const island of graph.ISLANDS) if (random() < 0.15 + round * 0.06) visited.add(island.id);
      const revealed = new Set(visited);
      for (const id of visited) for (const next of index.neighbours.get(id) || []) revealed.add(next);
      const usable = (from, other) => revealed.has(from) && revealed.has(other) && (visited.has(from) || visited.has(other));
      const drawn = graph.EDGES.filter((edge) => revealed.has(edge.a) && revealed.has(edge.b) && (visited.has(edge.a) || visited.has(edge.b)));
      const stuck = drawn.filter((edge) => !reachable(edge, usable)).map((edge) => `${edge.a} <-> ${edge.b}`);
      assert.deepEqual(stuck, [], `state ${round}: ${visited.size} visited`);
    }
  });
});

describe("revealDeltas: where to scroll to a lit place", () => {
  const panel = { left: 16, width: 360 };
  const view = { height: 800 };

  it("centres the place in the panel sideways", () => {
    const { dx, dy } = revealDeltas({ box: { left: 500, top: 300, width: 60, height: 60 }, panel, view });
    assert.equal(dx, 500 + 30 - (16 + 180));
    assert.equal(dy, 0, "no vertical move unless asked");
  });

  it("scrolls back when the place lies left of the panel's centre", () => {
    const { dx } = revealDeltas({ box: { left: -100, top: 300, width: 60, height: 60 }, panel, view });
    assert.ok(dx < 0);
  });

  it("brings a place from below the fold or under the header into the window, and leaves one in view alone", () => {
    const below = revealDeltas({ box: { left: 100, top: 1200, width: 60, height: 60 }, panel, view, top: 80, vertical: true });
    assert.ok(below.dy > 0, "scroll down");
    assert.ok(Math.abs(1200 + 30 - below.dy - (80 + 24 + 800 - 24) / 2) < 1, "to the middle of the free part of the window");
    const above = revealDeltas({ box: { left: 100, top: 20, width: 60, height: 60 }, panel, view, top: 80, vertical: true });
    assert.ok(above.dy < 0, "scroll up, out from under the header");
    const inside = revealDeltas({ box: { left: 100, top: 300, width: 60, height: 60 }, panel, view, top: 80, vertical: true });
    assert.equal(inside.dy, 0);
  });
});

describe("the first screen needs the start place high on the map", () => {
  it("lies in the upper half of the map, so that it is on screen below the hero link on a 1280x800 laptop", () => {
    // Map top 472px, scale 0.73 at that width: the start place's disc ends above the fold only if y <= about 385.
    const start = index.byId.get(graph.START_ID);
    assert.ok(start.y <= 385, `${graph.START_ID} is at y=${start.y}`);
  });
});

describe("the strip of sea above the bands", () => {
  it("is tall enough for the edge dragon and does not touch the first band", () => {
    assert.ok(EDGE_STRIP >= 40 && EDGE_STRIP <= 60, `${EDGE_STRIP}`);
  });
});
