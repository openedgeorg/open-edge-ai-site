/**
 * Atlas state: which islands an answer has mentioned ("visited") and what the map shows.
 *
 * The state is tiny and plain: { visited: string[], replies: number }. Everything the map and
 * the list draw is derived from it by deriveView(). Persistence is sessionStorage only (the
 * caller passes the Storage object in); if it is missing or throws, a per-page memory copy is
 * used instead. "Visited" means a reply mentioned the island, not that anything is understood.
 */

import { START_ID, buildIndex } from "./atlas-graph.js";

export const ATLAS_KEY = "esp-atlas";

const memory = new Map();
let shared = null;

/** The shipped graph's lookup tables, built once. */
function defaultIndex() {
  if (!shared) shared = buildIndex();
  return shared;
}

/**
 * @typedef {object} AtlasState
 * @property {string[]} visited ids in the order they were first reached; the start island first
 * @property {number} replies how many replies have been scanned
 */

/**
 * @typedef {"visited"|"frontier"|"fogged"} IslandStatus
 * @typedef {"lit"|"stub"|"hidden"} EdgeStatus
 * @typedef {object} AtlasView
 * @property {Record<string, IslandStatus>} status
 * @property {Record<string, EdgeStatus>} edges
 * @property {number} visitedCount
 * @property {number} total
 * @property {string[]} frontier graph order
 * @property {boolean} dragonsReached an open (dragon) island is visited or on the frontier
 * @property {number} replies
 */

/**
 * @param {string} [startId]
 * @returns {AtlasState}
 */
export function initialAtlasState(startId = START_ID) {
  return { visited: [startId], replies: 0 };
}

/**
 * Known, unique string ids from a list, in order.
 * @param {unknown} ids
 * @param {{byId: Map<string, unknown>}} index
 * @returns {string[]}
 */
function knownIds(ids, index) {
  const out = [];
  if (!Array.isArray(ids)) return out;
  for (const id of ids) {
    if (typeof id === "string" && index.byId.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * @param {AtlasState} state
 * @param {{type: string, ids?: string[]}} action
 * @param {ReturnType<typeof buildIndex>} [index]
 * @returns {AtlasState}
 */
export function reduceAtlas(state, action, index = defaultIndex()) {
  switch (action && action.type) {
    case "reply": {
      const base = state && typeof state === "object" ? state : initialAtlasState();
      const visited = Array.isArray(base.visited) ? [...base.visited] : [];
      for (const id of knownIds(action.ids, index)) {
        if (!visited.includes(id)) visited.push(id);
      }
      const replies = Number.isFinite(base.replies) ? base.replies : 0;
      return { visited, replies: replies + 1 };
    }
    case "reset":
      return initialAtlasState();
    default:
      return state;
  }
}

/**
 * @param {AtlasState} state
 * @param {ReturnType<typeof buildIndex>} [index]
 * @returns {AtlasView}
 */
export function deriveView(state, index = defaultIndex()) {
  const visited = new Set(knownIds(state && state.visited, index));
  /** @type {Record<string, IslandStatus>} */
  const status = {};
  const frontier = [];
  let dragonsReached = false;
  for (const [id, island] of index.byId) {
    let value = "fogged";
    if (visited.has(id)) {
      value = "visited";
    } else {
      for (const neighbour of index.neighbours.get(id) || []) {
        if (visited.has(neighbour)) {
          value = "frontier";
          break;
        }
      }
    }
    status[id] = value;
    if (value === "frontier") frontier.push(id);
    if (value !== "fogged" && island.status === "open") dragonsReached = true;
  }
  /** @type {Record<string, EdgeStatus>} */
  const edges = {};
  for (const [key, edge] of index.byKey) {
    const ends = (visited.has(edge.a) ? 1 : 0) + (visited.has(edge.b) ? 1 : 0);
    edges[key] = ends === 2 ? "lit" : ends === 1 ? "stub" : "hidden";
  }
  return {
    status,
    edges,
    visitedCount: visited.size,
    total: index.byId.size,
    frontier,
    dragonsReached,
    replies: state && Number.isFinite(state.replies) ? state.replies : 0,
  };
}

/**
 * Save to sessionStorage (passed in). If it is missing or throws, keep a memory copy instead.
 * @param {Storage|null|undefined} storage
 * @param {AtlasState} state
 */
export function persistAtlas(storage, state) {
  const visited = Array.isArray(state && state.visited)
    ? state.visited.filter((id) => typeof id === "string")
    : [];
  const replies = Number.isInteger(state && state.replies) && state.replies >= 0 ? state.replies : 0;
  const payload = JSON.stringify({ v: 1, visited, replies });
  try {
    if (storage && typeof storage.setItem === "function") {
      storage.setItem(ATLAS_KEY, payload);
      memory.delete(ATLAS_KEY);
      return;
    }
  } catch {
    /* sessionStorage disabled or full: keep the map in memory for this page */
  }
  memory.set(ATLAS_KEY, payload);
}

/**
 * Read the saved map back, checked against the graph. Anything unreadable gives the initial state.
 * @param {Storage|null|undefined} storage
 * @param {ReturnType<typeof buildIndex>} [index]
 * @returns {AtlasState}
 */
export function restoreAtlas(storage, index = defaultIndex()) {
  let raw = null;
  try {
    if (storage && typeof storage.getItem === "function") raw = storage.getItem(ATLAS_KEY);
  } catch {
    raw = null;
  }
  if (raw == null) raw = memory.get(ATLAS_KEY) ?? null;
  if (raw == null) return initialAtlasState();
  let saved;
  try {
    saved = JSON.parse(String(raw));
  } catch {
    return initialAtlasState();
  }
  if (!saved || typeof saved !== "object" || saved.v !== 1) return initialAtlasState();
  const visited = [START_ID, ...knownIds(saved.visited, index).filter((id) => id !== START_ID)];
  const replies = Number.isInteger(saved.replies) && saved.replies >= 0 ? saved.replies : 0;
  return { visited, replies };
}

/** The in-page fallback copy (a test hook, like sessionMemory() in state.js). */
export function atlasMemory() {
  return memory;
}
