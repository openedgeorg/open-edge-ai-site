/**
 * The Atlas as a plain list: every place, grouped by region, for readers who prefer text to a map.
 *
 * The DOM is built once and updated in place, so render() can be called after every reply
 * without losing keyboard focus. Everything from the graph goes in through textContent.
 * Trace anchors are never shown: only section numbers.
 *
 * While the chat is paused an "Ask" button is `aria-disabled="true"` (not `disabled`, so a focused
 * button keeps focus) and points at the page's notice; the reason itself is shown in one place only.
 * A place on the designers' open list reads "open, not ratified" until it is visited, never "next
 * to explore" or "not reached yet".
 */

import { buildIndex, edgeKey } from "./atlas-graph.js";
import { formatSections, regionHeading, statusWord } from "./atlas-panel.js";

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
 *   onActivate?: (id: string) => void, onSelect?: (id: string|null) => void, describedBy?: string}} options
 * @returns {{element: HTMLElement, render: (view: object, opts?: {paused?: boolean, pausedMessage?: string}) => void}}
 */
export function createAtlasList({ document: doc, graph, index = buildIndex(), onActivate, onSelect, describedBy = "atlas-notice" }) {
  const element = make(doc, "div", "atlas-list");
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "All places in the Atlas");

  /** @type {Map<string, {island: object, item: HTMLElement, status: HTMLElement, meta: HTMLElement, ask: HTMLButtonElement, paths: HTMLUListElement, pathsKey: string, current: string}>} */
  const rows = new Map();

  for (const region of graph.REGIONS || []) {
    const islands = (graph.ISLANDS || []).filter((island) => island.region === region.id);
    if (!islands.length) continue;
    const section = make(doc, "section", "atlas-list-region");
    const heading = make(doc, "h3", "atlas-list-heading", regionHeading(region));
    heading.id = `atlas-list-region-${region.id}`;
    section.setAttribute("aria-labelledby", heading.id);
    const list = make(doc, "ul", "atlas-list-items");
    for (const island of islands) {
      const item = make(doc, "li", "atlas-list-item is-fogged");
      item.tabIndex = -1;
      const head = make(doc, "p", "atlas-list-head");
      const name = make(doc, "span", "atlas-list-name", island.name);
      const status = make(doc, "span", "atlas-list-status", statusWord("fogged", island));
      head.append(name, " ", status);
      const meta = make(doc, "p", "atlas-list-meta");
      const ask = make(doc, "button", "atlas-list-ask", island.teaser || "");
      ask.type = "button";
      ask.hidden = true;
      ask.addEventListener("click", () => {
        if (ask.getAttribute("aria-disabled") === "true" || typeof onActivate !== "function") return;
        onActivate(island.id);
      });
      const paths = make(doc, "ul", "atlas-list-paths");
      paths.hidden = true;
      item.append(head, meta, ask, paths);
      const row = { island, item, status, meta, ask, paths, pathsKey: "", current: "fogged" };
      const reveal = () => {
        if (typeof onSelect === "function" && row.current !== "fogged") onSelect(island.id);
      };
      item.addEventListener("focusin", reveal);
      item.addEventListener("click", reveal);
      rows.set(island.id, row);
      list.appendChild(item);
    }
    section.append(heading, list);
    element.appendChild(section);
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

  return {
    element,
    /**
     * @param {object} view the deriveView() result
     * @param {{paused?: boolean, pausedMessage?: string}} [opts] pausedMessage is accepted for
     *   compatibility and ignored: the reason is shown in one place, the page's notice
     */
    render(view, { paused = false } = {}) {
      const statuses = (view && view.status) || {};
      for (const row of rows.values()) {
        const { island, item, ask } = row;
        const status = statuses[island.id] === "visited" || statuses[island.id] === "frontier"
          ? statuses[island.id]
          : "fogged";
        row.current = status;
        setClass(item, "is-visited", status === "visited");
        setClass(item, "is-frontier", status === "frontier");
        setClass(item, "is-fogged", status === "fogged");
        setClass(item, "is-open", island.status === "open");
        setClass(item, "is-contested", island.status === "contested");
        setText(row.status, statusWord(status, island));
        setText(row.meta, metaText(island, status));
        setHidden(row.meta, row.meta.textContent === "");

        const showAsk = status === "frontier";
        if (!showAsk && !ask.hidden && doc.activeElement === ask) item.focus();
        setHidden(ask, !showAsk);
        const locked = showAsk && Boolean(paused);
        setAttr(ask, "aria-disabled", locked ? "true" : null);
        setAttr(ask, "aria-describedby", locked && describedBy ? describedBy : null);

        renderPaths(row, view || {}, status);
      }
    },
  };
}
