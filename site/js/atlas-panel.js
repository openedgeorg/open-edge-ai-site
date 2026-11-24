/**
 * Atlas side panels: the inspector card, the suggestion chips and small text helpers.
 *
 * Everything the graph supplies is inserted with textContent. Trace anchors (the raw summary
 * text behind each island and path) are never read here: only section numbers are shown.
 * Island words are "visited", "next to explore" and "not reached yet"; a place on the designers'
 * open list is "open, not ratified" until it is visited. Nothing is "learned".
 */

import { FIRST_SUGGESTION, ISLANDS, OPEN_LABEL, buildIndex, edgeKey } from "./atlas-graph.js";

export const STATUS_WORDS = Object.freeze({
  visited: "visited",
  frontier: "next to explore",
  fogged: "not reached yet",
});

/**
 * What a place on the designers' open list (a dragon) is called until an answer mentions it. It is
 * never "next to explore" or "not reached yet": an open item is not a goal and not a next step.
 */
export const OPEN_STATUS_WORD = OPEN_LABEL;

const INSPECTOR_HINT = "Point at, tap or focus a lit place on the map to read about it here. It stays here until you pick another.";
/** Said on the card of the start place: the counter starts at 1 because of it, not because anything was learned. */
export const START_NOTE = "Starting point: this place is marked visited so the map has somewhere to begin, whether or not an answer has mentioned it.";
const OPEN_LIST_NOTE = "On the designers' own open list: what is described here is open or undecided.";

/**
 * The status word for a view status ("visited" | "frontier" | "fogged"). For a place on the open
 * list (`island.status === "open"`) the two unvisited states both read "open, not ratified", so a
 * dragon never looks like a goal or a roadmap; a visited dragon is "visited" like any other place
 * (its label line keeps "open, not ratified").
 * @param {string|undefined} status
 * @param {{status?: string}|null} [island]
 */
export function statusWord(status, island = null) {
  if (island && island.status === "open" && status !== "visited") return OPEN_STATUS_WORD;
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

let shippedIndex = null;

/**
 * The suggestion chips: what each says and whether it is a place on the designers' open list.
 *
 * First load: the single first question. Afterwards up to `max` teasers of next-to-explore places.
 * With `visited` (the ids in the order they were first reached, as the Atlas state keeps them) the
 * places next to the NEWEST visited places come first, so the chips follow the last answer; without
 * it they come in graph order. A place on the open list (a dragon) is never a next step: it is
 * offered only when no ordinary place is next to explore, and then it carries `open: true` so the
 * chip says "open, not ratified".
 * @param {{replies?: number, frontier?: string[]}} view
 * @param {{islands?: typeof ISLANDS, max?: number, visited?: string[]|null,
 *   index?: ReturnType<typeof buildIndex>|null}} [options]
 * @returns {Array<{text: string, open: boolean}>}
 */
export function suggestionPlan(view, { islands = ISLANDS, max = 3, visited = null, index = null } = {}) {
  if (!view || !(view.replies > 0)) return [{ text: FIRST_SUGGESTION, open: false }];
  const frontier = new Set(Array.isArray(view.frontier) ? view.frontier : []);
  const order = Array.isArray(visited) ? visited : null;
  const graph = order ? index || (shippedIndex ||= buildIndex()) : null;
  const newest = new Map(order ? order.map((id, at) => [id, at]) : []);
  /** How recently a neighbour of this place was reached: the higher, the closer to the latest reply. */
  const recency = (island) => {
    let latest = -1;
    for (const neighbour of (graph && graph.neighbours.get(island.id)) || []) {
      if (newest.has(neighbour) && newest.get(neighbour) > latest) latest = newest.get(neighbour);
    }
    return latest;
  };
  const ordinary = [];
  const open = [];
  islands.forEach((island, at) => {
    if (!frontier.has(island.id) || !island.teaser) return;
    (island.status === "open" ? open : ordinary).push({ island, at, recent: order ? recency(island) : 0 });
  });
  const ranked = (list) => list.sort((p, q) => q.recent - p.recent || p.at - q.at);
  const chosen = ordinary.length ? ranked(ordinary) : ranked(open);
  return chosen.slice(0, max).map(({ island }) => ({ text: island.teaser, open: island.status === "open" }));
}

/**
 * Suggestion chip texts (see suggestionPlan).
 * @param {{replies?: number, frontier?: string[]}} view
 * @param {Parameters<typeof suggestionPlan>[1]} [options]
 * @returns {string[]}
 */
export function suggestionItems(view, options = {}) {
  return suggestionPlan(view, options).map((item) => item.text);
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
 * The inspector card inside `mount`. It is not a live region (keyboard focus on an island already
 * announces it); it repaints only when the content changes, so repeated hover events stay quiet.
 *
 * The card is the place being read, not a tooltip: the owner decides when it changes. It shows the
 * last place or path that was looked at (the map passes hover, focus and clicks to showIsland and
 * showEdge) and keeps it when the pointer leaves, when focus moves into the card or when the page is
 * scrolled; only showIsland(null) (Escape, a Clear map) puts the hint back. A visited or next-to-explore
 * place carries an Ask button (the same question as its teaser), and every lit path of a visited place is
 * a button too, so a path can be read by touch and keyboard as well as by pointer.
 *
 * @param {{document: Document, graph: object, index?: ReturnType<typeof buildIndex>, mount: HTMLElement,
 *   onAsk?: (id: string) => void, onPath?: (key: string) => void, onShow?: (id: string) => void,
 *   describedBy?: string}} options onAsk sends a place's teaser, onPath is told which path a visitor chose,
 *   onShow which of a path's two places
 */
export function createInspector({ document: doc, graph, index = buildIndex(), mount, onAsk, onPath, onShow, describedBy = "atlas-notice" }) {
  const regions = new Map((graph.REGIONS || []).map((region) => [region.id, region]));
  let selectedIsland = null;
  let selectedEdge = null;
  let lastView = null;
  let lastSignature = null;
  let paused = false;
  /** The buttons of the card on show that a pause must lock. */
  let lockable = [];

  function add(card, tag, className, text) {
    const node = make(doc, tag, className, text);
    card.appendChild(node);
    return node;
  }

  function button(className, text, onClick) {
    const node = make(doc, "button", className, text);
    node.type = "button";
    node.addEventListener("click", () => {
      if (node.getAttribute("aria-disabled") === "true") return;
      onClick();
    });
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
    const word = statusWord(status, island);
    add(card, "p", `atlas-inspector-status is-${island.status === "open" && status !== "visited" ? "open" : status}`, `Status: ${word}`);
    if (island.start) add(card, "p", "atlas-inspector-start", START_NOTE);
    const sections = formatSections(island);
    if (sections) add(card, "p", "atlas-inspector-sections", `In the draft summary: ${sections}`);
    // The status line already says it for an unvisited dragon: do not repeat the same words as a badge.
    if (island.label && island.label !== word) {
      add(card, "p", `atlas-inspector-label ${island.status === "open" ? "is-open" : "is-contested"}`, island.label);
    }
    if (island.status === "open") add(card, "p", "atlas-inspector-open", OPEN_LIST_NOTE);
    if (island.note) add(card, "p", "atlas-inspector-note", island.note);
    if (island.teaser) {
      add(card, "p", "atlas-inspector-teaser", `Ask: ${island.teaser}`);
      if (typeof onAsk === "function" && (status === "visited" || status === "frontier")) {
        const ask = button("atlas-inspector-ask", status === "visited" ? "Ask about this again" : "Ask this question", () => onAsk(island.id));
        ask.setAttribute("aria-label", `${status === "visited" ? "Ask about this again" : "Ask this question"}: ${island.teaser}`);
        card.appendChild(ask);
        lockable.push(ask);
      }
    }
    if (status === "visited") {
      const paths = litEdgesOf(index, view, island.id);
      if (paths.length) {
        add(card, "h4", "atlas-inspector-paths-title", "Lit paths");
        const list = add(card, "ul", "atlas-inspector-paths");
        for (const edge of paths) {
          const other = edge.a === island.id ? edge.b : edge.a;
          const text = `→ ${nameOf(other)}: ${edge.label}`;
          const item = add(list, "li", "atlas-inspector-path");
          if (typeof onPath === "function") {
            const key = edgeKey(edge.a, edge.b);
            item.appendChild(button("atlas-inspector-path-button", text, () => onPath(key)));
          } else {
            item.textContent = text;
          }
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
    if (typeof onShow === "function") {
      const ends = add(card, "div", "atlas-inspector-ends");
      for (const id of [edge.a, edge.b]) ends.appendChild(button("atlas-inspector-end", `Show ${nameOf(id)}`, () => onShow(id)));
    }
    return card;
  }

  function applyPause() {
    for (const node of lockable) {
      if (paused) {
        node.setAttribute("aria-disabled", "true");
        if (describedBy) node.setAttribute("aria-describedby", describedBy);
      } else {
        node.removeAttribute("aria-disabled");
        node.removeAttribute("aria-describedby");
      }
    }
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
    if (signature === lastSignature) {
      applyPause();
      return;
    }
    lastSignature = signature;
    // A card that is rebuilt under the visitor's focus (the place they asked about has just been visited) hands
    // the focus on to its own Ask button, or to the card, instead of dropping it to the page.
    const active = doc.activeElement;
    const hadFocus = Boolean(active && active !== mount && mount.contains(active));
    lockable = [];
    const card = build();
    mount.replaceChildren(card);
    applyPause();
    if (hadFocus) {
      const target = lockable[0] || card;
      if (target === card) card.tabIndex = -1;
      if (typeof target.focus === "function") target.focus();
    }
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
    /**
     * Repaint the current selection against a new view.
     * @param {object} [view]
     * @param {{paused?: boolean}} [options] whether the Ask button is locked (a question is running)
     */
    refresh(view, options = {}) {
      if (view) lastView = view;
      if (typeof options.paused === "boolean") paused = options.paused;
      paint();
    },
    /** What the card shows now: a place id, a path key, or neither. */
    current: () => ({ island: selectedIsland, edge: selectedEdge }),
  };
}

/**
 * Suggestion chips inside `mount`. Idempotent: the same items and pause state leave the DOM alone.
 *
 * The chips are updated in place, never rebuilt: a chip keeps keyboard focus through a tap, the
 * pause that follows it and the reply (its text changes, the element stays). While paused a chip
 * is `aria-disabled="true"` (not `disabled`, which would drop focus) and points at the notice that
 * says why; its click does nothing. When the new list is shorter, the surplus chips are removed and
 * focus moves to the first chip that is left.
 *
 * An item is a question (string) or `{text, open}`; an `open` chip adds "open, not ratified" under
 * its question. The question is what a tap sends: the label is never part of it.
 * @param {{document: Document, mount: HTMLElement, onPick?: (text: string) => void,
 *   describedBy?: string, openLabel?: string, fallbackFocus?: () => (HTMLElement|null|undefined)}} options
 */
export function createSuggestions({ document: doc, mount, onPick, describedBy = "atlas-notice", openLabel = OPEN_LABEL, fallbackFocus }) {
  let lastSignature = null;
  let label = null;
  let list = null;
  /** One record per chip: its list item, its button and the two texts inside the button. */
  const chips = [];
  mount.setAttribute("role", "group");
  mount.setAttribute("aria-label", "Suggested questions");

  function setAttr(node, name, value) {
    if (value === null) {
      if (node.hasAttribute(name)) node.removeAttribute(name);
    } else if (node.getAttribute(name) !== value) {
      node.setAttribute(name, value);
    }
  }

  function addChip() {
    const item = make(doc, "li", "atlas-suggest-item");
    const button = make(doc, "button", "atlas-chip");
    button.type = "button";
    const question = make(doc, "span", "atlas-chip-text", "");
    const tag = make(doc, "span", "atlas-chip-tag", "");
    tag.hidden = true;
    button.append(question, tag);
    button.addEventListener("click", () => {
      if (button.getAttribute("aria-disabled") === "true" || typeof onPick !== "function") return;
      onPick(question.textContent);
    });
    item.appendChild(button);
    list.appendChild(item);
    chips.push({ item, button, question, tag });
  }

  return {
    /**
     * @param {Array<string|{text: string, open?: boolean}>} items
     * @param {{paused?: boolean, pausedMessage?: string}} [options] pausedMessage is accepted for
     *   compatibility and ignored: the reason is shown in one place, the page's notice
     */
    render(items, { paused = false } = {}) {
      const entries = (Array.isArray(items) ? items : [])
        .map((item) => (typeof item === "string" ? { text: item, open: false } : { text: item && item.text, open: Boolean(item && item.open) }))
        .filter((item) => typeof item.text === "string" && item.text);
      const signature = JSON.stringify([entries, Boolean(paused)]);
      if (signature === lastSignature) return;
      lastSignature = signature;

      const active = doc.activeElement;
      const hadFocus = Boolean(active && mount.contains(active));
      const focusedAt = hadFocus ? chips.findIndex((chip) => chip.button === active) : -1;

      mount.hidden = entries.length === 0;
      if (!entries.length) {
        for (const chip of chips.splice(0)) chip.item.remove();
        if (hadFocus && typeof fallbackFocus === "function") {
          const target = fallbackFocus();
          if (target && typeof target.focus === "function") target.focus();
        }
        return;
      }
      if (!list) {
        label = make(doc, "p", "atlas-suggest-label", "Try asking");
        list = make(doc, "ul", "atlas-suggest-list");
        mount.replaceChildren(label, list);
      }
      while (chips.length < entries.length) addChip();
      while (chips.length > entries.length) chips.pop().item.remove();
      entries.forEach((entry, at) => {
        const chip = chips[at];
        setText(chip.question, entry.text);
        setText(chip.tag, entry.open ? openLabel : "");
        if (chip.tag.hidden === entry.open) chip.tag.hidden = !entry.open;
        setAttr(chip.button, "aria-disabled", paused ? "true" : null);
        setAttr(chip.button, "aria-describedby", paused && describedBy ? describedBy : null);
      });
      if (hadFocus && focusedAt >= entries.length) chips[0].button.focus();
    },
  };
}
