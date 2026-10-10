import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";

import { EDGES, ISLANDS, START_ID, buildIndex, edgeKey } from "../../site/js/atlas-graph.js";
import {
  ATLAS_KEY,
  atlasMemory,
  deriveView,
  initialAtlasState,
  persistAtlas,
  reduceAtlas,
  restoreAtlas,
} from "../../site/js/atlas-state.js";

const GRAPH_ORDER = ISLANDS.map((island) => island.id);
const inGraphOrder = (ids) => [...ids].sort((a, b) => GRAPH_ORDER.indexOf(a) - GRAPH_ORDER.indexOf(b));
const byId = new Map(ISLANDS.map((island) => [island.id, island]));

/** The islands one path away from `id`, read straight from EDGES (not from buildIndex, which the code under test uses). */
const neighboursOf = (id) =>
  EDGES.filter((edge) => edge.a === id || edge.b === id).map((edge) => (edge.a === id ? edge.b : edge.a));
const START_NEIGHBOURS = neighboursOf(START_ID);

/**
 * Three ordinary islands (not the start, not open, not contested), found from the graph at run time.
 * The tests below need a few real ids that the reducer accepts; they do not care which islands they are.
 */
const [ISLE_A, ISLE_B, ISLE_C] = ISLANDS.filter(
  (island) => island.id !== START_ID && island.status === undefined,
).map((island) => island.id);

beforeEach(() => atlasMemory().clear());
afterEach(() => atlasMemory().clear());

/** A Storage stand-in that records every call. */
function fakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  const calls = [];
  return {
    data,
    calls,
    getItem(key) {
      calls.push(["getItem", key]);
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      calls.push(["setItem", key]);
      data.set(key, String(value));
    },
    removeItem(key) {
      calls.push(["removeItem", key]);
      data.delete(key);
    },
    clear() {
      calls.push(["clear"]);
      data.clear();
    },
    key() {
      calls.push(["key"]);
      return null;
    },
  };
}

const throwingStorage = () => ({
  getItem() {
    throw new Error("SecurityError: storage is disabled");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
});

/** A four-island chain a - b - c - d, plus an open island x that hangs off d. */
function tinyGraph() {
  const islands = [
    { id: "a", name: "A", region: "r", x: 0, y: 0, terms: [] },
    { id: "b", name: "B", region: "r", x: 0, y: 0, terms: [] },
    { id: "x", name: "X", region: "r", x: 0, y: 0, terms: [], status: "open" },
    { id: "c", name: "C", region: "r", x: 0, y: 0, terms: [] },
    { id: "d", name: "D", region: "r", x: 0, y: 0, terms: [] },
  ];
  const edges = [
    { a: "a", b: "b", label: "ab" },
    { a: "c", b: "b", label: "bc" },
    { a: "c", b: "d", label: "cd" },
    { a: "d", b: "x", label: "dx" },
  ];
  return buildIndex(islands, edges);
}

test("initial state starts on the first island with no replies", () => {
  assert.equal(ATLAS_KEY, "esp-atlas");
  assert.deepEqual(initialAtlasState(), { visited: [START_ID], replies: 0 });
  assert.equal(START_ID, "internet-bill");
  assert.deepEqual(initialAtlasState("somewhere"), { visited: ["somewhere"], replies: 0 });
  assert.notEqual(initialAtlasState(), initialAtlasState(), "a fresh object each time");
  assert.notEqual(initialAtlasState().visited, initialAtlasState().visited);
});

test("initial view: one visited island, its neighbours on the frontier, dragons unreached", () => {
  const view = deriveView(initialAtlasState());
  const index = buildIndex();
  assert.equal(view.visitedCount, 1);
  assert.equal(view.total, ISLANDS.length);
  assert.equal(view.replies, 0);
  assert.equal(view.dragonsReached, false);
  const around = START_NEIGHBOURS.length;
  assert.ok(around >= 3, `the start island has ${around} neighbours`);
  assert.equal(new Set(START_NEIGHBOURS).size, around, "a path is listed twice");
  assert.deepEqual(view.frontier, inGraphOrder(START_NEIGHBOURS));
  assert.deepEqual([...index.neighbours.get(START_ID)].sort(), [...view.frontier].sort());
  assert.deepEqual(Object.keys(view.status), GRAPH_ORDER);
  assert.equal(view.status[START_ID], "visited");
  const counts = { visited: 0, frontier: 0, fogged: 0 };
  for (const value of Object.values(view.status)) counts[value] += 1;
  assert.deepEqual(counts, { visited: 1, frontier: around, fogged: ISLANDS.length - 1 - around });
  for (const id of view.frontier) assert.equal(view.status[id], "frontier");
  // Only the paths out of the start are visible, as faint stubs.
  const edgeCounts = { lit: 0, stub: 0, hidden: 0 };
  for (const value of Object.values(view.edges)) edgeCounts[value] += 1;
  assert.deepEqual(edgeCounts, { lit: 0, stub: around, hidden: EDGES.length - around });
  for (const other of view.frontier) {
    assert.equal(view.edges[edgeKey(START_ID, other)], "stub");
  }
});

test("reduce: a reply adds known ids in order and counts the reply", () => {
  const start = initialAtlasState();
  const next = reduceAtlas(start, { type: "reply", ids: [ISLE_A, ISLE_B] });
  assert.deepEqual(next, { visited: [START_ID, ISLE_A, ISLE_B], replies: 1 });
  assert.deepEqual(start, { visited: [START_ID], replies: 0 }, "the old state is not mutated");
  const again = reduceAtlas(next, { type: "reply", ids: [ISLE_C, ISLE_A] });
  assert.deepEqual(again.visited, [START_ID, ISLE_A, ISLE_B, ISLE_C]);
  assert.equal(again.replies, 2);
});

test("reduce: duplicates are dropped, within an action and across actions", () => {
  const state = reduceAtlas(initialAtlasState(), {
    type: "reply",
    ids: [ISLE_A, ISLE_A, START_ID, ISLE_B, ISLE_A],
  });
  assert.deepEqual(state.visited, [START_ID, ISLE_A, ISLE_B]);
  const same = reduceAtlas(state, { type: "reply", ids: [ISLE_B, ISLE_A] });
  assert.deepEqual(same.visited, state.visited);
  assert.equal(same.replies, 2);
});

test("reduce: unknown ids and bad payloads are ignored", () => {
  const state = reduceAtlas(initialAtlasState(), {
    type: "reply",
    ids: ["nope", "", "__proto__", "constructor", "toString", 7, null, undefined, {}, [ISLE_A], ISLE_A],
  });
  assert.deepEqual(state.visited, [START_ID, ISLE_A]);
  assert.equal(state.replies, 1);
  for (const ids of [undefined, null, ISLE_A, 5, {}, { length: 1, 0: ISLE_A }]) {
    const out = reduceAtlas(initialAtlasState(), { type: "reply", ids });
    assert.deepEqual(out, { visited: [START_ID], replies: 1 });
  }
  assert.deepEqual(reduceAtlas(initialAtlasState(), { type: "reply" }), { visited: [START_ID], replies: 1 });
});

test("reduce: an empty reply still counts and never removes anything", () => {
  let state = reduceAtlas(initialAtlasState(), { type: "reply", ids: [ISLE_A] });
  state = reduceAtlas(state, { type: "reply", ids: [] });
  state = reduceAtlas(state, { type: "reply", ids: ["unknown"] });
  assert.deepEqual(state, { visited: [START_ID, ISLE_A], replies: 3 });
});

test("reduce: frozen input is never mutated", () => {
  const frozen = Object.freeze({ visited: Object.freeze([START_ID]), replies: 0 });
  const ids = Object.freeze([ISLE_A]);
  const next = reduceAtlas(frozen, Object.freeze({ type: "reply", ids }));
  assert.deepEqual(next, { visited: [START_ID, ISLE_A], replies: 1 });
  assert.notEqual(next.visited, frozen.visited);
});

test("reduce: reset returns the initial state", () => {
  let state = reduceAtlas(initialAtlasState(), { type: "reply", ids: [ISLE_A, ISLE_B] });
  state = reduceAtlas(state, { type: "reset" });
  assert.deepEqual(state, initialAtlasState());
  assert.deepEqual(reduceAtlas(initialAtlasState(), { type: "reset" }), initialAtlasState());
});

test("reduce: an unknown action returns the very same state object", () => {
  const state = initialAtlasState();
  for (const action of [{ type: "nope" }, { type: "" }, {}, null, undefined, "reply", 3]) {
    assert.equal(reduceAtlas(state, action), state);
  }
});

test("reduce and view accept a custom index", () => {
  const index = tinyGraph();
  const state = reduceAtlas({ visited: ["a"], replies: 0 }, { type: "reply", ids: ["b", START_ID, ISLE_A, "c"] }, index);
  assert.deepEqual(state, { visited: ["a", "b", "c"], replies: 1 });
});

test("deriveView: island and edge states on a small graph", () => {
  const index = tinyGraph();
  const view = deriveView({ visited: ["a", "b"], replies: 4 }, index);
  assert.deepEqual(view.status, { a: "visited", b: "visited", x: "fogged", c: "frontier", d: "fogged" });
  assert.deepEqual(view.edges, { "a|b": "lit", "b|c": "stub", "c|d": "hidden", "d|x": "hidden" });
  assert.deepEqual(view.frontier, ["c"]);
  assert.equal(view.visitedCount, 2);
  assert.equal(view.total, 5);
  assert.equal(view.replies, 4);
  assert.equal(view.dragonsReached, false);
});

test("deriveView: frontier is in graph order and lists an island once", () => {
  const index = tinyGraph();
  // c borders both b and d, so it has two visited neighbours; x borders d.
  const view = deriveView({ visited: ["b", "d"], replies: 0 }, index);
  assert.deepEqual(view.frontier, ["a", "x", "c"]);
  assert.deepEqual(view.edges, { "a|b": "stub", "b|c": "stub", "c|d": "stub", "d|x": "stub" });
  const lit = deriveView({ visited: ["b", "c", "d"], replies: 0 }, index);
  assert.deepEqual(lit.edges, { "a|b": "stub", "b|c": "lit", "c|d": "lit", "d|x": "stub" });
  assert.deepEqual(lit.frontier, ["a", "x"]);
});

test("deriveView: dragons are reached when an open island is on the frontier or visited", () => {
  const index = tinyGraph();
  assert.equal(deriveView({ visited: ["a"], replies: 0 }, index).dragonsReached, false);
  assert.equal(deriveView({ visited: ["a", "b", "c"], replies: 0 }, index).dragonsReached, false);
  assert.equal(deriveView({ visited: ["d"], replies: 0 }, index).dragonsReached, true, "frontier");
  assert.equal(deriveView({ visited: ["d", "x"], replies: 0 }, index).dragonsReached, true, "visited");
  assert.equal(deriveView({ visited: ["x"], replies: 0 }, index).dragonsReached, true, "visited alone");
});

test("deriveView: dragons on the shipped graph", () => {
  const open = ISLANDS.filter((island) => island.status === "open").map((island) => island.id);
  assert.ok(open.length >= 1);
  // A path from an ordinary island to a dragon: visiting the ordinary island puts the dragon on the frontier.
  const toDragon = EDGES.find((edge) => {
    const ends = [byId.get(edge.a), byId.get(edge.b)];
    return ends.filter((island) => island.status === "open").length === 1 && ends.every((island) => island.id !== START_ID);
  });
  assert.ok(toDragon, "no path leads from an ordinary island to a dragon");
  const [dragon, plain] = byId.get(toDragon.a).status === "open" ? [toDragon.a, toDragon.b] : [toDragon.b, toDragon.a];
  assert.equal(deriveView({ visited: [START_ID, plain], replies: 1 }).dragonsReached, true);
  assert.equal(deriveView({ visited: [START_ID, plain], replies: 1 }).status[dragon], "frontier");
  assert.equal(deriveView({ visited: [START_ID, dragon], replies: 1 }).dragonsReached, true);
  // A contested island is not a dragon: reaching it, or its frontier, does not reach the dragons.
  const contested = ISLANDS.find((island) => island.status === "contested");
  assert.ok(contested, "the graph has no contested island");
  const calm = neighboursOf(contested.id).find(
    (id) => byId.get(id).status === undefined && neighboursOf(id).every((other) => byId.get(other).status !== "open"),
  );
  assert.ok(calm, "no ordinary neighbour of the contested island is free of dragons");
  assert.ok(START_NEIGHBOURS.every((id) => byId.get(id).status !== "open"), "a dragon borders the start island");
  const view = deriveView({ visited: [START_ID, calm], replies: 1 });
  assert.equal(view.status[contested.id], "frontier");
  assert.equal(view.dragonsReached, false);
  for (const id of open) {
    assert.equal(deriveView({ visited: [START_ID], replies: 0 }).status[id], "fogged", id);
  }
});

test("deriveView: ignores ids that are not in the graph and survives bad state", () => {
  const view = deriveView({ visited: [START_ID, "nope", "nope", START_ID, 4, null], replies: "many" });
  assert.equal(view.visitedCount, 1);
  assert.equal(view.replies, 0);
  assert.deepEqual(view.frontier, deriveView(initialAtlasState()).frontier);
  for (const bad of [null, undefined, {}, { visited: "x" }, { visited: null }, 5]) {
    const out = deriveView(bad);
    assert.equal(out.visitedCount, 0);
    assert.equal(out.total, ISLANDS.length);
    assert.deepEqual(out.frontier, []);
    assert.equal(out.dragonsReached, false);
  }
});

test("deriveView: everything visited lights every path and empties the frontier", () => {
  const view = deriveView({ visited: GRAPH_ORDER, replies: 9 });
  assert.equal(view.visitedCount, ISLANDS.length);
  assert.deepEqual(view.frontier, []);
  assert.equal(view.dragonsReached, true);
  assert.ok(Object.values(view.edges).every((value) => value === "lit"));
  assert.ok(Object.values(view.status).every((value) => value === "visited"));
  assert.deepEqual(Object.keys(view.edges).sort(), [...buildIndex().byKey.keys()].sort());
});

test("deriveView: a path is lit only when both ends are visited", () => {
  const next = inGraphOrder(START_NEIGHBOURS)[0];
  const visited = [START_ID, next];
  const view = deriveView({ visited, replies: 1 });
  assert.equal(view.edges[edgeKey(START_ID, next)], "lit");
  let lit = 0;
  let hidden = 0;
  for (const edge of EDGES) {
    const key = edgeKey(edge.a, edge.b);
    const ends = [visited.includes(edge.a), visited.includes(edge.b)].filter(Boolean).length;
    assert.equal(view.edges[key], ["hidden", "stub", "lit"][ends], key);
    if (ends === 2) lit += 1;
    if (ends === 0) hidden += 1;
  }
  assert.equal(lit, 1);
  assert.ok(hidden >= 1, "every path is at least a stub after one step");
  assert.equal(view.visitedCount, 2);
  const around = new Set([...START_NEIGHBOURS, ...neighboursOf(next)]);
  assert.deepEqual(view.frontier, inGraphOrder([...around].filter((id) => !visited.includes(id))));
});

test("deriveView: islands and paths follow the visited set, whatever the set is", () => {
  // A small deterministic generator, so a failure names the same subset every run.
  let seed = 20261010;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let round = 0; round < 40; round += 1) {
    const share = random();
    const visited = [START_ID, ...GRAPH_ORDER.filter((id) => id !== START_ID && random() < share)];
    const view = deriveView({ visited, replies: round });
    const seen = new Set(visited);
    for (const island of ISLANDS) {
      const touches = neighboursOf(island.id).some((id) => seen.has(id));
      const expected = seen.has(island.id) ? "visited" : touches ? "frontier" : "fogged";
      assert.equal(view.status[island.id], expected, `round ${round}: ${island.id}`);
    }
    assert.deepEqual(view.frontier, GRAPH_ORDER.filter((id) => view.status[id] === "frontier"));
    for (const edge of EDGES) {
      const ends = (seen.has(edge.a) ? 1 : 0) + (seen.has(edge.b) ? 1 : 0);
      assert.equal(view.edges[edgeKey(edge.a, edge.b)], ["hidden", "stub", "lit"][ends], `round ${round}: ${edge.a}|${edge.b}`);
    }
    const reached = ISLANDS.some((island) => island.status === "open" && view.status[island.id] !== "fogged");
    assert.equal(view.dragonsReached, reached, `round ${round}: dragonsReached`);
  }
});

test("persist and restore round trip through a Storage", () => {
  const storage = fakeStorage();
  const state = reduceAtlas(initialAtlasState(), { type: "reply", ids: [ISLE_A, ISLE_B, ISLE_C] });
  persistAtlas(storage, state);
  assert.deepEqual([...storage.data.keys()], [ATLAS_KEY]);
  assert.deepEqual(JSON.parse(storage.data.get(ATLAS_KEY)), {
    v: 1,
    visited: [START_ID, ISLE_A, ISLE_B, ISLE_C],
    replies: 1,
  });
  assert.deepEqual(restoreAtlas(storage), state);
  assert.equal(atlasMemory().size, 0, "nothing in the memory fallback when storage works");
  const reset = reduceAtlas(state, { type: "reset" });
  persistAtlas(storage, reset);
  assert.deepEqual(restoreAtlas(storage), initialAtlasState());
});

test("restore with nothing saved gives the initial state", () => {
  assert.deepEqual(restoreAtlas(fakeStorage()), initialAtlasState());
  assert.deepEqual(restoreAtlas(undefined), initialAtlasState());
  assert.deepEqual(restoreAtlas(null), initialAtlasState());
  assert.deepEqual(restoreAtlas({}), initialAtlasState());
});

test("restore: bad JSON and wrong shapes give the initial state", () => {
  for (const raw of [
    "",
    "not json",
    "{",
    "null",
    "[]",
    "7",
    '"text"',
    "true",
    '{"v":2,"visited":[ISLE_A],"replies":3}',
    '{"visited":[ISLE_A],"replies":3}',
    '{"v":"1","visited":[ISLE_A],"replies":3}',
  ]) {
    assert.deepEqual(restoreAtlas(fakeStorage({ [ATLAS_KEY]: raw })), initialAtlasState(), JSON.stringify(raw));
  }
});

test("restore: partial or odd fields are repaired", () => {
  const restore = (payload) => restoreAtlas(fakeStorage({ [ATLAS_KEY]: JSON.stringify(payload) }));
  assert.deepEqual(restore({ v: 1 }), { visited: [START_ID], replies: 0 });
  assert.deepEqual(restore({ v: 1, visited: ISLE_A, replies: 2 }), { visited: [START_ID], replies: 2 });
  assert.deepEqual(restore({ v: 1, visited: { 0: ISLE_A }, replies: 2 }), { visited: [START_ID], replies: 2 });
  for (const replies of [-1, 1.5, "3", null, NaN, true, [], {}]) {
    assert.equal(restore({ v: 1, visited: [START_ID], replies }).replies, 0, JSON.stringify(replies));
  }
  assert.equal(restore({ v: 1, visited: [START_ID], replies: 12 }).replies, 12);
});

test("restore: ids not in the graph are dropped, duplicates removed, order kept", () => {
  const storage = fakeStorage({
    [ATLAS_KEY]: JSON.stringify({
      v: 1,
      visited: [START_ID, "ghost", ISLE_A, 3, null, ISLE_A, "__proto__", ISLE_B, "also-ghost"],
      replies: 5,
    }),
  });
  assert.deepEqual(restoreAtlas(storage), { visited: [START_ID, ISLE_A, ISLE_B], replies: 5 });
});

test("restore: the start island is always there and always first", () => {
  const restore = (visited) =>
    restoreAtlas(fakeStorage({ [ATLAS_KEY]: JSON.stringify({ v: 1, visited, replies: 1 }) })).visited;
  assert.deepEqual(restore([]), [START_ID]);
  assert.deepEqual(restore([ISLE_A, ISLE_B]), [START_ID, ISLE_A, ISLE_B]);
  assert.deepEqual(restore([ISLE_A, START_ID, ISLE_B]), [START_ID, ISLE_A, ISLE_B]);
  assert.deepEqual(restore(["ghost"]), [START_ID]);
  assert.deepEqual(restore([START_ID, START_ID]), [START_ID]);
});

test("restore: a custom index decides which ids are valid", () => {
  const index = tinyGraph();
  const storage = fakeStorage({ [ATLAS_KEY]: JSON.stringify({ v: 1, visited: ["a", "b", ISLE_A], replies: 2 }) });
  assert.deepEqual(restoreAtlas(storage, index).visited, [START_ID, "a", "b"]);
});

test("a storage that throws falls back to memory and never throws", () => {
  const bad = throwingStorage();
  const state = reduceAtlas(initialAtlasState(), { type: "reply", ids: [ISLE_A] });
  assert.doesNotThrow(() => persistAtlas(bad, state));
  assert.equal(atlasMemory().has(ATLAS_KEY), true);
  assert.deepEqual(restoreAtlas(bad), state, "read from memory when getItem throws");
  assert.deepEqual(restoreAtlas(undefined), state, "read from memory when there is no storage");
  assert.deepEqual(restoreAtlas({ getItem: () => "{}" }), initialAtlasState(), "a readable storage wins over memory");
});

test("a missing or odd storage uses the memory fallback", () => {
  const state = reduceAtlas(initialAtlasState(), { type: "reply", ids: [ISLE_B] });
  for (const storage of [undefined, null, {}, { setItem: "no" }, 5]) {
    atlasMemory().clear();
    assert.doesNotThrow(() => persistAtlas(storage, state));
    assert.deepEqual(restoreAtlas(null), state);
  }
});

test("a throwing getItem on a storage that holds nothing falls back to initial", () => {
  const readOnlyBroken = {
    getItem() {
      throw new Error("boom");
    },
    setItem() {},
  };
  assert.deepEqual(restoreAtlas(readOnlyBroken), initialAtlasState());
});

test("a working write retires an older memory copy", () => {
  const state = reduceAtlas(initialAtlasState(), { type: "reply", ids: [ISLE_A] });
  persistAtlas(throwingStorage(), state);
  assert.equal(atlasMemory().has(ATLAS_KEY), true);
  const storage = fakeStorage();
  persistAtlas(storage, initialAtlasState());
  assert.equal(atlasMemory().has(ATLAS_KEY), false);
  assert.deepEqual(restoreAtlas(storage), initialAtlasState());
  assert.deepEqual(restoreAtlas(undefined), initialAtlasState());
});

test("persist writes only the documented fields, and tolerates odd state", () => {
  const storage = fakeStorage();
  persistAtlas(storage, { visited: [START_ID, ISLE_A, 9, null], replies: 3, secret: "x", draft: "hello" });
  assert.deepEqual(JSON.parse(storage.data.get(ATLAS_KEY)), { v: 1, visited: [START_ID, ISLE_A], replies: 3 });
  for (const odd of [null, undefined, {}, { visited: "x", replies: "y" }]) {
    assert.doesNotThrow(() => persistAtlas(storage, odd));
    assert.deepEqual(JSON.parse(storage.data.get(ATLAS_KEY)), { v: 1, visited: [], replies: 0 });
  }
});

test("only the Storage that is passed in is used: no global browser storage, no stray calls", () => {
  const traps = [];
  const saved = {};
  for (const name of ["localStorage", "sessionStorage"]) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: false,
      get() {
        traps.push(name);
        throw new Error(`${name} must not be touched`);
      },
    });
  }
  try {
    const spy = fakeStorage();
    let state = initialAtlasState();
    state = reduceAtlas(state, { type: "reply", ids: [ISLE_A, ISLE_C] });
    deriveView(state);
    persistAtlas(spy, state);
    restoreAtlas(spy);
    persistAtlas(undefined, state);
    restoreAtlas(undefined);
    persistAtlas(throwingStorage(), state);
    restoreAtlas(throwingStorage());
    state = reduceAtlas(state, { type: "reset" });
    persistAtlas(spy, state);
    assert.deepEqual(traps, []);
    assert.deepEqual(
      [...new Set(spy.calls.map((call) => call.join(":")))].sort(),
      [`getItem:${ATLAS_KEY}`, `setItem:${ATLAS_KEY}`],
      "only getItem and setItem on the atlas key",
    );
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test("the state module's code never names browser storage globals or the DOM", () => {
  const source = readFileSync(new URL("../../site/js/atlas-state.js", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const forbidden of ["localStorage", "sessionStorage", "globalThis", "document", "window", "innerHTML", "eval(", "fetch("]) {
    assert.equal(code.includes(forbidden), false, forbidden);
  }
  assert.equal(source.includes("localStorage"), false, "not even in a comment");
});
