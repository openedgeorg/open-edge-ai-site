/**
 * Atlas side panels: the inspector card, the suggestion chips and small text helpers.
 *
 * Everything the graph supplies is inserted with textContent. Trace anchors (the raw summary
 * text behind each island and path) are never read here: only section numbers are shown.
 * Island words are "visited", "next to explore" and "not reached yet". Nothing is "learned".
 */

import { FIRST_SUGGESTION, ISLANDS, buildIndex, edgeKey } from "./atlas-graph.js";

export const STATUS_WORDS = Object.freeze({
  visited: "visited",
  frontier: "next to explore",
  fogged: "not reached yet",
});

const INSPECTOR_HINT = "Point at or focus a lit place on the map to read about it here.";
const OPEN_LIST_NOTE = "On the designers' own open list. No answer has been ratified yet.";

/**
 * The status word for a view status ("visited" | "frontier" | "fogged").
 * @param {string|undefined} status
 */
export function statusWord(status) {
  return STATUS_WORDS[status] || STATUS_WORDS.fogged;
}

/**
 * Section references for an island or an edge, for example "§1, §3". The preamble is shown as
 * "§ status note" and sorts first (document order). Duplicates are dropped. Anchor text is
 * never returned.
 * @param {{trace?: Array<{section: number|string}>|{section: number|string}}|null|undefined} subject
 * @returns {string}
 */
export function formatSections(subject) {
  const trace = subject && subject.trace;
  const list = Array.isArray(trace) ? trace : trace ? [trace] : [];
  const numbers = new Set();
  let preamble = false;
  for (const entry of list) {
    const section = entry ? entry.section : undefined;
    if (section === "preamble") preamble = true;
    else if (typeof section === "number" && Number.isInteger(section)) numbers.add(section);
    else if (typeof section === "string" && /^\d{1,2}$/.test(section)) numbers.add(Number(section));
  }
  const parts = [];
  if (preamble) parts.push("§ status note");
  for (const number of [...numbers].sort((a, b) => a - b)) parts.push(`§${number}`);
  return parts.join(", ");
}

/**
 * "<visitedCount> of <total> visited".
 * @param {{textContent: string}} el
 * @param {{visitedCount: number, total: number}} view
 */
export function renderCount(el, view) {
  const visited = Number.isFinite(view && view.visitedCount) ? view.visitedCount : 0;
  const total = Number.isFinite(view && view.total) ? view.total : 0;
  setText(el, `${visited} of ${total} visited`);
}

/**
 * Suggestion chip texts. First load: the single first question. Afterwards up to `max` teasers
 * of next-to-explore places in graph order; places on the designers' open list come last.
 * @param {{replies?: number, frontier?: string[]}} view
 * @param {{islands?: typeof ISLANDS, max?: number}} [options]
 * @returns {string[]}
 */
export function suggestionItems(view, { islands = ISLANDS, max = 3 } = {}) {
  if (!view || !(view.replies > 0)) return [FIRST_SUGGESTION];
  const frontier = new Set(Array.isArray(view.frontier) ? view.frontier : []);
  const ordinary = [];
  const open = [];
  for (const island of islands) {
    if (!frontier.has(island.id) || !island.teaser) continue;
    (island.status === "open" ? open : ordinary).push(island.teaser);
  }
  return [...ordinary, ...open].slice(0, max);
}

/**
 * Region heading text: "The Coast · L0 · The promise".
 * @param {{name: string, level: string, subtitle: string}} region
 */
export function regionHeading(region) {
  return `${region.name} · ${region.level} · ${region.subtitle}`;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function make(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function litEdgesOf(index, view, id) {
  const edges = index.edgesOf.get(id) || [];
  return edges.filter((edge) => view && view.edges && view.edges[edgeKey(edge.a, edge.b)] === "lit");
}

/**
 * The inspector card inside `mount` (an aria-live region). It repaints only when the content
 * changes, so repeated hover events do not make a screen reader repeat itself.
 * @param {{document: Document, graph: object, index?: ReturnType<typeof buildIndex>, mount: HTMLElement}} options
 */
export function createInspector({ document: doc, graph, index = buildIndex(), mount }) {
  const regions = new Map((graph.REGIONS || []).map((region) => [region.id, region]));
  const openLabel = graph.OPEN_LABEL || "open, not ratified";
  let selectedIsland = null;
  let selectedEdge = null;
  let lastView = null;
  let lastSignature = null;

  function add(card, tag, className, text) {
    const node = make(doc, tag, className, text);
    card.appendChild(node);
    return node;
  }

  function nameOf(id) {
    const island = index.byId.get(id);
    return island ? island.name : id;
  }

  function hint() {
    const card = make(doc, "div", "atlas-inspector-card is-hint");
    add(card, "p", "atlas-inspector-hint", INSPECTOR_HINT);
    return card;
  }

  function islandCard(island, status, view) {
    const card = make(doc, "div", `atlas-inspector-card is-${status}`);
    if (island.status === "open") card.classList.add("is-open");
    if (island.status === "contested") card.classList.add("is-contested");
    add(card, "h3", "atlas-inspector-name", island.name);
    const region = regions.get(island.region);
    if (region) add(card, "p", "atlas-inspector-where", regionHeading(region));
    add(card, "p", `atlas-inspector-status is-${status}`, `Status: ${statusWord(status)}`);
    const sections = formatSections(island);
    if (sections) add(card, "p", "atlas-inspector-sections", `In the draft summary: ${sections}`);
    if (island.label) {
      add(card, "p", `atlas-inspector-label ${island.status === "open" ? "is-open" : "is-contested"}`, island.label);
    }
    if (island.status === "open") add(card, "p", "atlas-inspector-open", OPEN_LIST_NOTE);
    if (island.note) add(card, "p", "atlas-inspector-note", island.note);
    if (island.teaser) add(card, "p", "atlas-inspector-teaser", `Ask: ${island.teaser}`);
    if (status === "visited") {
      const paths = litEdgesOf(index, view, island.id);
      if (paths.length) {
        add(card, "h4", "atlas-inspector-paths-title", "Lit paths");
        const list = add(card, "ul", "atlas-inspector-paths");
        for (const edge of paths) {
          const other = edge.a === island.id ? edge.b : edge.a;
          add(list, "li", "atlas-inspector-path", `→ ${nameOf(other)}: ${edge.label}`);
        }
      }
    } else if (status === "frontier") {
      const from = [...(index.neighbours.get(island.id) || [])]
        .filter((id) => view && view.status && view.status[id] === "visited")
        .map(nameOf);
      if (from.length) add(card, "p", "atlas-inspector-from", `Next to: ${from.join(", ")}`);
    }
    return card;
  }

  function edgeCard(edge) {
    const card = make(doc, "div", "atlas-inspector-card is-edge");
    add(card, "h3", "atlas-inspector-name", `${nameOf(edge.a)} ↔ ${nameOf(edge.b)}`);
    add(card, "p", "atlas-inspector-label-path", edge.label);
    const sections = formatSections(edge);
    if (sections) add(card, "p", "atlas-inspector-sections", `In the draft summary: ${sections}`);
    return card;
  }

  function paint() {
    const view = lastView;
    let signature = "hint";
    let build = hint;
    const edge = selectedEdge ? index.byKey.get(selectedEdge) : null;
    const edgeLit = Boolean(edge && view && view.edges && view.edges[selectedEdge] === "lit");
    const island = selectedIsland ? index.byId.get(selectedIsland) : null;
    const status = island && view && view.status ? view.status[island.id] : null;
    if (edgeLit) {
      signature = `edge:${selectedEdge}`;
      build = () => edgeCard(edge);
    } else if (island && (status === "visited" || status === "frontier")) {
      const paths = status === "visited" ? litEdgesOf(index, view, island.id).map((e) => edgeKey(e.a, e.b)).join(",") : "";
      const from = status === "frontier"
        ? [...(index.neighbours.get(island.id) || [])].filter((id) => view.status[id] === "visited").join(",")
        : "";
      signature = `island:${island.id}:${status}:${paths}:${from}`;
      build = () => islandCard(island, status, view);
    }
    if (signature === lastSignature) return;
    lastSignature = signature;
    mount.replaceChildren(build());
  }

  paint();

  return {
    /**
     * @param {string|null} id
     * @param {object} [view] the latest deriveView() result
     */
    showIsland(id, view) {
      selectedIsland = id || null;
      selectedEdge = null;
      if (view) lastView = view;
      paint();
    },
    /**
     * @param {string|null} key an edgeKey(); only lit paths are described
     * @param {object} [view]
     */
    showEdge(key, view) {
      selectedEdge = key || null;
      if (view) lastView = view;
      paint();
    },
    /** Repaint the current selection against a new view. */
    refresh(view) {
      if (view) lastView = view;
      paint();
    },
  };
}

/**
 * Suggestion chips inside `mount`. Idempotent: the same items and pause state leave the DOM alone.
 * @param {{document: Document, mount: HTMLElement, onPick?: (text: string) => void}} options
 */
export function createSuggestions({ document: doc, mount, onPick }) {
  let lastSignature = null;
  mount.setAttribute("role", "group");
  mount.setAttribute("aria-label", "Suggested questions");

  return {
    /**
     * @param {string[]} items
     * @param {{paused?: boolean, pausedMessage?: string}} [options]
     */
    render(items, { paused = false, pausedMessage = "" } = {}) {
      const texts = (Array.isArray(items) ? items : []).filter((item) => typeof item === "string" && item);
      const signature = JSON.stringify([texts, Boolean(paused), paused ? String(pausedMessage || "") : ""]);
      if (signature === lastSignature) return;
      lastSignature = signature;

      const active = doc.activeElement;
      const focusedText = active && mount.contains(active) && active.classList.contains("atlas-chip")
        ? active.textContent
        : null;

      mount.hidden = texts.length === 0;
      if (!texts.length) {
        mount.replaceChildren();
        return;
      }
      const label = make(doc, "p", "atlas-suggest-label", "Try asking");
      const list = make(doc, "ul", "atlas-suggest-list");
      let refocus = null;
      for (const text of texts) {
        const item = make(doc, "li", "atlas-suggest-item");
        const chip = make(doc, "button", "atlas-chip", text);
        chip.type = "button";
        if (paused) {
          chip.disabled = true;
          chip.setAttribute("aria-disabled", "true");
        }
        chip.addEventListener("click", () => {
          if (chip.disabled || typeof onPick !== "function") return;
          onPick(text);
        });
        item.appendChild(chip);
        list.appendChild(item);
        if (!paused && focusedText === text) refocus = chip;
      }
      const children = [label, list];
      if (paused && pausedMessage) children.push(make(doc, "p", "atlas-suggest-paused", String(pausedMessage)));
      mount.replaceChildren(...children);
      if (refocus) refocus.focus();
    },
  };
}
