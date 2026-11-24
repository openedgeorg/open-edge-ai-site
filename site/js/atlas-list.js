/**
 * The Atlas as a plain list: every place, grouped by region, for readers who prefer text to a map.
 *
 * The DOM is built once and updated in place, so render() can be called after every reply
 * without losing keyboard focus. Everything from the graph goes in through textContent.
 * Trace anchors are never shown: only section numbers.
 *
 * The list is long (65 places), so it is meant to be steered, not read top to bottom:
 * - every region is a disclosure (a button in its heading). The regions around what the visitor has just
 *   been told about (the places the latest reply lit, and the places next to explore beside them) open by
 *   themselves; a visitor's own choice always wins;
 * - three filters (all, visited, next to explore) and a "Jump to region" menu;
 * - "Expand all" / "Collapse all".
 * Nothing is ever removed from the DOM: all 65 rows stay in the page, collapsed or filtered rows are
 * only hidden, and "All places" with every region open shows each one.
 *
 * While the chat is paused an "Ask" button is `aria-disabled="true"` (not `disabled`, so a focused
 * button keeps focus) and points at the page's notice; the reason itself is shown in one place only.
 * A place on the designers' open list reads "open, not ratified" until it is visited, never "next
 * to explore" or "not reached yet". A visited place offers "Ask again": visited means an answer
 * mentioned it, not that anything was understood.
 */

import { buildIndex, edgeKey } from "./atlas-graph.js";
import { formatSections, regionHeading, statusWord } from "./atlas-panel.js";

/** The views of the list a visitor can choose. */
export const LIST_FILTERS = Object.freeze([
  Object.freeze({ id: "all", label: "All places" }),
  Object.freeze({ id: "visited", label: "Visited" }),
  Object.freeze({ id: "frontier", label: "Next to explore" }),
]);

/** What is said when a filter has nothing to show. */
export const LIST_EMPTY = Object.freeze({
  visited: "No place has been visited yet.",
  frontier: "Nothing is next to explore right now. The designers' open list is under \"Here be dragons\" in All places.",
});

/**
 * Whether a place belongs to a filter. "Next to explore" never holds a place from the designers' open
 * list (a dragon): an open item is not a next step, whatever its state.
 * @param {string} filter "all" | "visited" | "frontier"
 * @param {"visited"|"frontier"|"fogged"} status
 * @param {{status?: string}} island
 */
export function matchesFilter(filter, status, island) {
  if (filter === "visited") return status === "visited";
  if (filter === "frontier") return status === "frontier" && !(island && island.status === "open");
  return true;
}

/**
 * "2 of 5 visited · 1 next to explore": what a closed region still tells its visitor.
 * @param {{visited: number, total: number, next: number}} counts
 */
export function regionCountsText({ visited, total, next }) {
  return next > 0 ? `${visited} of ${total} visited · ${next} next to explore` : `${visited} of ${total} visited`;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setHidden(node, hidden) {
  if (node.hidden !== hidden) node.hidden = hidden;
}

function setClass(node, name, on) {
  if (node.classList.contains(name) !== on) node.classList.toggle(name, on);
}

function setAttr(node, name, value) {
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else if (node.getAttribute(name) !== value) {
    node.setAttribute(name, value);
  }
}

function make(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {{document: Document, graph: object, index?: ReturnType<typeof buildIndex>,
 *   onActivate?: (id: string) => void, onSelect?: (id: string|null) => void, describedBy?: string,
 *   onAnnounce?: (text: string) => void}} options onAnnounce is told, in words, what a filter or a jump did
 * @returns {{element: HTMLElement, render: (view: object, opts?: {paused?: boolean, fresh?: string[], pausedMessage?: string}) => void,
 *   reveal: (id: string, opts?: {behavior?: string}) => boolean, jumpToRegion: (id: string, opts?: {behavior?: string}) => boolean,
 *   setFilter: (id: string) => boolean, filter: () => string, isOpen: (regionId: string) => boolean,
 *   isShown: (id: string) => boolean}}
 */
export function createAtlasList({ document: doc, graph, index = buildIndex(), onActivate, onSelect, describedBy = "atlas-notice", onAnnounce }) {
  const element = make(doc, "div", "atlas-list");
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "All places in the Atlas");

  /** @type {Map<string, {island: object, region: string, item: HTMLElement, status: HTMLElement, fresh: HTMLElement, meta: HTMLElement, ask: HTMLButtonElement, again: HTMLButtonElement, paths: HTMLUListElement, pathsKey: string, current: string}>} */
  const rows = new Map();
  /** @type {Map<string, {region: object, section: HTMLElement, heading: HTMLElement, toggle: HTMLButtonElement, countsEl: HTMLElement, counts: {visited: number, total: number, next: number}, items: HTMLUListElement, ids: string[], matching: number}>} */
  const regions = new Map();

  let filter = "all";
  let lastFresh = new Set();
  let jumpSignature = "";
  /** Regions that open by themselves: those around the places the visitor was last told about. */
  let autoOpen = new Set();
  let focusKey = null;
  /** A visitor's own choice per region; it beats the automatic rule. */
  const chosen = new Map();

  const announce = (text) => {
    if (typeof onAnnounce === "function") onAnnounce(text);
  };

  // ---- the tools: filters, jump menu, expand / collapse all ----

  const tools = make(doc, "div", "atlas-list-tools");
  const filterBar = make(doc, "div", "atlas-list-filters");
  filterBar.setAttribute("role", "group");
  filterBar.setAttribute("aria-label", "Show places");
  /** @type {Map<string, HTMLButtonElement>} */
  const filterButtons = new Map();
  for (const entry of LIST_FILTERS) {
    const button = make(doc, "button", "atlas-list-filter", entry.label);
    button.type = "button";
    button.setAttribute("aria-pressed", entry.id === filter ? "true" : "false");
    button.addEventListener("click", () => setFilter(entry.id, true));
    filterButtons.set(entry.id, button);
    filterBar.appendChild(button);
  }

  const jump = make(doc, "div", "atlas-list-jump");
  const jumpLabel = make(doc, "label", "atlas-list-jump-label", "Jump to region");
  const jumpSelect = make(doc, "select", "atlas-list-select");
  jumpSelect.id = "atlas-list-jump";
  jumpLabel.setAttribute("for", jumpSelect.id);
  jump.append(jumpLabel, jumpSelect);
  jumpSelect.addEventListener("change", () => {
    const id = jumpSelect.value;
    if (id) jumpToRegion(id, { behavior: "auto" });
    jumpSelect.value = "";
  });

  const bulk = make(doc, "button", "atlas-list-bulk", "Expand all");
  bulk.type = "button";
  bulk.addEventListener("click", () => {
    const open = !allShownOpen();
    for (const entry of regions.values()) if (entry.matching > 0) chosen.set(entry.region.id, open);
    apply();
    announce(open ? "All regions expanded." : "All regions collapsed.");
  });

  const empty = make(doc, "p", "atlas-list-empty");
  empty.hidden = true;

  tools.append(filterBar, jump, bulk);
  element.append(tools, empty);

  // ---- the regions and their rows ----

  for (const region of graph.REGIONS || []) {
    const islands = (graph.ISLANDS || []).filter((island) => island.region === region.id);
    if (!islands.length) continue;
    const section = make(doc, "section", "atlas-list-region");
    const bar = make(doc, "div", "atlas-list-bar");
    const heading = make(doc, "h3", "atlas-list-heading");
    heading.id = `atlas-list-region-${region.id}`;
    const toggle = make(doc, "button", "atlas-list-toggle", regionHeading(region));
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    heading.appendChild(toggle);
    const countsEl = make(doc, "span", "atlas-list-counts", "");
    bar.append(heading, countsEl);
    section.setAttribute("aria-labelledby", heading.id);
    const list = make(doc, "ul", "atlas-list-items");
    list.id = `atlas-list-items-${region.id}`;
    toggle.setAttribute("aria-controls", list.id);
    toggle.addEventListener("click", () => {
      chosen.set(region.id, !isOpen(region.id));
      apply();
    });

    for (const island of islands) {
      const item = make(doc, "li", "atlas-list-item is-fogged");
      item.tabIndex = -1;
      const head = make(doc, "p", "atlas-list-head");
      const name = make(doc, "span", "atlas-list-name", island.name);
      const status = make(doc, "span", "atlas-list-status", statusWord("fogged", island));
      const fresh = make(doc, "span", "atlas-list-new", "new");
      fresh.hidden = true;
      head.append(name, " ", status, " ", fresh);
      const meta = make(doc, "p", "atlas-list-meta");
      const ask = make(doc, "button", "atlas-list-ask", island.teaser || "");
      ask.type = "button";
      ask.hidden = true;
      ask.addEventListener("click", () => {
        if (ask.getAttribute("aria-disabled") === "true" || typeof onActivate !== "function") return;
        onActivate(island.id);
      });
      // A visited place can be asked about again: the same question, a quieter button.
      const again = make(doc, "button", "atlas-list-again", island.teaser || "");
      again.type = "button";
      again.hidden = true;
      again.addEventListener("click", () => {
        if (again.getAttribute("aria-disabled") === "true" || typeof onActivate !== "function") return;
        onActivate(island.id);
      });
      const paths = make(doc, "ul", "atlas-list-paths");
      paths.hidden = true;
      item.append(head, meta, ask, again, paths);
      const row = { island, region: region.id, item, status, fresh, meta, ask, again, paths, pathsKey: "", current: "fogged" };
      const reveal = () => {
        if (typeof onSelect === "function" && row.current !== "fogged") onSelect(island.id);
      };
      item.addEventListener("focusin", reveal);
      item.addEventListener("click", reveal);
      rows.set(island.id, row);
      list.appendChild(item);
    }
    section.append(bar, list);
    element.appendChild(section);
    const ids = islands.map((island) => island.id);
    regions.set(region.id, { region, section, heading, toggle, countsEl, counts: { visited: 0, total: ids.length, next: 0 }, items: list, ids, matching: 0 });
  }

  // ---- state ----

  function isOpen(regionId) {
    return chosen.has(regionId) ? chosen.get(regionId) : autoOpen.has(regionId);
  }

  function allShownOpen() {
    let any = false;
    for (const entry of regions.values()) {
      if (entry.matching === 0) continue;
      any = true;
      if (!isOpen(entry.region.id)) return false;
    }
    return any;
  }

  function statusOf(id) {
    return rows.get(id).current;
  }

  function matchingCount(filterId, ids) {
    let count = 0;
    for (const id of ids) {
      const row = rows.get(id);
      if (matchesFilter(filterId, row.current, row.island)) count += 1;
    }
    return count;
  }

  function metaText(island, status) {
    const parts = [];
    const sections = formatSections(island);
    if (sections) parts.push(sections);
    // The status word already says it for an unvisited dragon: do not repeat the same words.
    if (island.label && island.label !== statusWord(status, island)) parts.push(island.label);
    if (island.note) parts.push(island.note);
    return parts.join(" · ");
  }

  function renderPaths(row, view, status) {
    const edges = status === "visited"
      ? (index.edgesOf.get(row.island.id) || []).filter(
        (edge) => view.edges && view.edges[edgeKey(edge.a, edge.b)] === "lit",
      )
      : [];
    const key = edges.map((edge) => edgeKey(edge.a, edge.b)).join(",");
    if (key === row.pathsKey) return;
    row.pathsKey = key;
    setHidden(row.paths, edges.length === 0);
    row.paths.replaceChildren(
      ...edges.map((edge) => {
        const other = index.byId.get(edge.a === row.island.id ? edge.b : edge.a);
        return make(doc, "li", "atlas-list-path", `→ ${other ? other.name : ""}: ${edge.label}`);
      }),
    );
  }

  /** The jump menu offers the regions that show something under the current filter. */
  function renderJump() {
    const shown = [...regions.values()].filter((entry) => entry.matching > 0);
    const signature = shown.map((entry) => `${entry.region.id}:${regionCountsText(entry.counts)}`).join("|");
    if (jumpSignature === signature) return;
    jumpSignature = signature;
    const placeholder = make(doc, "option", "", "Choose a region");
    placeholder.value = "";
    const options = shown.map((entry) => {
      const option = make(doc, "option", "", `${regionHeading(entry.region)} (${regionCountsText(entry.counts)})`);
      option.value = entry.region.id;
      return option;
    });
    jumpSelect.replaceChildren(placeholder, ...options);
    jumpSelect.value = "";
  }

  function apply() {
    let total = 0;
    for (const entry of regions.values()) {
      const counts = { visited: 0, total: entry.ids.length, next: 0 };
      for (const id of entry.ids) {
        const row = rows.get(id);
        if (row.current === "visited") counts.visited += 1;
        else if (row.current === "frontier" && row.island.status !== "open") counts.next += 1;
      }
      entry.counts = counts;
      entry.matching = matchingCount(filter, entry.ids);
      total += entry.matching;
      for (const id of entry.ids) {
        const row = rows.get(id);
        const hide = !matchesFilter(filter, row.current, row.island);
        // A row that goes away under the keyboard (the place asked about is visited and the filter is "next to
        // explore") hands focus to the filter, instead of dropping it to the page.
        if (hide && !row.item.hidden && row.item.contains(doc.activeElement)) filterButtons.get(filter).focus();
        setHidden(row.item, hide);
      }
      const open = isOpen(entry.region.id);
      setHidden(entry.section, entry.matching === 0);
      setClass(entry.section, "is-collapsed", !open);
      setAttr(entry.toggle, "aria-expanded", open ? "true" : "false");
      setHidden(entry.items, !open);
      setText(entry.countsEl, regionCountsText(counts));
    }
    for (const [id, button] of filterButtons) {
      const count = matchingCountAll(id);
      const label = LIST_FILTERS.find((entry) => entry.id === id).label;
      setText(button, `${label} (${count})`);
      setAttr(button, "aria-pressed", id === filter ? "true" : "false");
    }
    setText(bulk, allShownOpen() ? "Collapse all" : "Expand all");
    setHidden(bulk, total === 0);
    const message = total === 0 ? LIST_EMPTY[filter] || "" : "";
    setText(empty, message);
    setHidden(empty, message === "");
    renderJump();
  }

  function matchingCountAll(filterId) {
    let count = 0;
    for (const row of rows.values()) if (matchesFilter(filterId, row.current, row.island)) count += 1;
    return count;
  }

  /**
   * @param {string} id "all" | "visited" | "frontier"
   * @param {boolean} [spoken] say what the list shows now (a visitor chose it)
   */
  function setFilter(id, spoken = false) {
    if (!filterButtons.has(id)) return false;
    filter = id;
    // A filter opens the regions it has something in; going back to all places forgets those choices.
    if (id === "all") chosen.clear();
    else for (const entry of regions.values()) if (matchingCount(id, entry.ids) > 0) chosen.set(entry.region.id, true);
    apply();
    if (spoken) {
      const label = LIST_FILTERS.find((entry) => entry.id === id).label;
      announce(`${label}: ${matchingCountAll(id)} of ${rows.size} places.`);
    }
    return true;
  }

  function scrollTo(node, behavior, block) {
    if (!node || typeof node.scrollIntoView !== "function") return;
    try {
      node.scrollIntoView({ block, behavior });
    } catch {
      node.scrollIntoView({ block });
    }
  }

  /**
   * Open a region and bring its heading to the top of the window. Focus does not move.
   * @param {string} id region id
   * @param {{behavior?: string}} [options]
   */
  function jumpToRegion(id, { behavior = "auto" } = {}) {
    const entry = regions.get(id);
    if (!entry) return false;
    if (filter !== "all" && entry.matching === 0) setFilter("all");
    chosen.set(id, true);
    apply();
    scrollTo(entry.heading, behavior, "start");
    announce(`${regionHeading(entry.region)}: ${regionCountsText(entry.counts)}.`);
    return true;
  }

  /**
   * Bring one place into view: its region opens, a filter that hides it goes back to all places, and the
   * row is centred. Focus does not move.
   * @param {string} id
   * @param {{behavior?: string}} [options]
   */
  function reveal(id, { behavior = "auto" } = {}) {
    const row = rows.get(id);
    if (!row) return false;
    if (!matchesFilter(filter, row.current, row.island)) setFilter("all");
    chosen.set(row.region, true);
    apply();
    scrollTo(row.item, behavior, "center");
    return true;
  }

  return {
    element,
    /**
     * @param {object} view the deriveView() result
     * @param {{paused?: boolean, fresh?: string[], focus?: string[], pausedMessage?: string}} [opts] fresh: the
     *   places the latest reply lit (they carry a "new" mark until the next reply); focus: the places the list
     *   is about now (the places of the latest reply, else the newest visited place): their regions, and those
     *   of the next-to-explore places beside them, open by themselves; pausedMessage is accepted for
     *   compatibility and ignored: the reason is shown in one place, the page's notice
     */
    render(view, { paused = false, fresh = [], focus = [] } = {}) {
      lastFresh = new Set(Array.isArray(fresh) ? fresh : []);
      const statuses = (view && view.status) || {};
      for (const row of rows.values()) {
        const { island, item, ask, again } = row;
        const status = statuses[island.id] === "visited" || statuses[island.id] === "frontier"
          ? statuses[island.id]
          : "fogged";
        row.current = status;
        setClass(item, "is-visited", status === "visited");
        setClass(item, "is-frontier", status === "frontier");
        setClass(item, "is-fogged", status === "fogged");
        setClass(item, "is-open", island.status === "open");
        setClass(item, "is-contested", island.status === "contested");
        const isNew = lastFresh.has(island.id) && status === "visited";
        setClass(item, "is-new", isNew);
        setHidden(row.fresh, !isNew);
        setText(row.status, statusWord(status, island));
        setText(row.meta, metaText(island, status));
        setHidden(row.meta, row.meta.textContent === "");

        const showAsk = status === "frontier";
        const showAgain = status === "visited" && Boolean(island.teaser);
        if (!showAsk && !ask.hidden && doc.activeElement === ask) item.focus();
        if (!showAgain && !again.hidden && doc.activeElement === again) item.focus();
        setHidden(ask, !showAsk);
        setHidden(again, !showAgain);
        const locked = Boolean(paused);
        setAttr(ask, "aria-disabled", showAsk && locked ? "true" : null);
        setAttr(ask, "aria-describedby", showAsk && locked && describedBy ? describedBy : null);
        setAttr(again, "aria-disabled", showAgain && locked ? "true" : null);
        setAttr(again, "aria-describedby", showAgain && locked && describedBy ? describedBy : null);

        renderPaths(row, view || {}, status);
      }
      // The regions around what the visitor was last told about open by themselves; a visitor who is working
      // inside a region keeps it, and one they chose themselves is theirs.
      const around = (Array.isArray(focus) && focus.length ? focus : [...lastFresh]).filter((id) => rows.has(id));
      const key = around.join(",");
      if (key !== focusKey) {
        focusKey = key;
        const next = new Set();
        for (const id of around) {
          next.add(rows.get(id).region);
          for (const neighbour of index.neighbours.get(id) || []) {
            const row = rows.get(neighbour);
            if (row && row.current === "frontier") next.add(row.region);
          }
        }
        for (const entry of regions.values()) {
          if (autoOpen.has(entry.region.id) && entry.items.contains(doc.activeElement)) next.add(entry.region.id);
        }
        autoOpen = next;
      }
      apply();
    },
    reveal,
    jumpToRegion,
    setFilter: (id) => setFilter(id, true),
    filter: () => filter,
    isOpen,
    /** Whether a place's row is on show (its region is open and the filter lets it through). */
    isShown: (id) => {
      const row = rows.get(id);
      return Boolean(row) && isOpen(row.region) && matchesFilter(filter, row.current, row.island);
    },
    statusOf,
    /** Where a row is on screen (viewport pixels), or null while it is hidden (closed region, filter). */
    box: (id) => {
      const row = rows.get(id);
      if (!row || !isOpen(row.region) || !matchesFilter(filter, row.current, row.island)) return null;
      return typeof row.item.getBoundingClientRect === "function" ? row.item.getBoundingClientRect() : null;
    },
  };
}
