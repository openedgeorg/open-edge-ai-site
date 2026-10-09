/**
 * The Atlas map: a DOM-built SVG of the concept graph with fog of war.
 *
 * The module owns only the picture. State (which islands are visited) comes in through
 * render(view, opts); interaction goes out through onSelect / onSelectEdge / onActivate.
 *
 * Rules kept here (the Atlas module contract):
 * - No inline style attributes, no inline scripts: positions are SVG attributes, looks live
 *   in css/atlas.css.
 * - Every string from the graph is set with textContent or setAttribute. Trace anchors
 *   (raw summary text) are never read.
 * - Fogged islands are small dim dots: aria-hidden, no label, no tabindex.
 * - An island is only ever "visited" (an answer mentioned it); open islands are never styled
 *   as a goal or a next step.
 */

import { buildIndex, edgeKey } from "./atlas-graph.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Geometry in viewBox units. */
const BODY_R = 11;
const HIT_R = 31;
const LABEL_Y0 = 33;
const LINE_H = 17;
const SUB_GAP = 15.5;
const NAME_CHARS = 20;
const EDGE_TIP_CHARS = 34;
const TIP_LINE_H = 17;
const FLARE_MS = 1800;
const BAND_TOP = 10;
const BAND_BOTTOM = 742;
const CAPTION_Y = { level: 36, name: 54, sub: 70 };
const PAUSE_NOTE_MAX = 72;
/** An arrow key only follows a path that lies within about 66 degrees of its direction. */
const ARROW_MIN_COS = 0.4;

/** Dragon glyph for open islands, drawn as dashed strokes around (0, 0). */
const DRAGON_GLYPH = [
  // back line, neck, head with open jaw, belly
  "M -21 4 C -17 9 -12 9 -9 4 C -7 1 -4 -1 0 -1 C 5 -1 7 -5 8 -9 C 9 -12 12 -13 15 -12 L 21 -10 L 17 -8 L 20 -6 L 13 -6 C 11 -3 8 3 3 5 C -1 7 -5 8 -9 8",
  // raised wing
  "M 1 -1 L -5 -13 L -2 -10 L 0 -16 L 3 -10 L 7 -14 L 7 -3",
  // legs
  "M -2 6 L -4 11 L -1 11 M 4 4 L 5 9 L 8 9",
  // horn
  "M 14 -12 L 12 -16",
];

/** Edge dragon at the far edge of the map (bottom right): a sea serpent in the bottom strip. */
const EDGE_DRAGON = {
  body: "M 876 764 c 13 -12 25 -12 38 0 c 13 12 25 12 38 0 c 13 -12 25 -12 38 0 c 13 12 25 12 38 0 c 13 -12 25 -12 38 0 c 13 12 25 12 38 0 c 13 -12 25 -12 38 0 c 13 12 25 12 38 0 C 1190 764 1192 757 1195 753",
  fins: "M 891 755.5 L 895 747 L 899 755.5 M 967 755.5 L 971 747 L 975 755.5 M 1043 755.5 L 1047 747 L 1051 755.5 M 1119 755.5 L 1123 747 L 1127 755.5",
  head: "M 1195 753 L 1203 746 L 1226 748 L 1217 753 L 1227 759 L 1206 760 L 1197 758",
  eye: { cx: 1207, cy: 751, r: 1.8 },
  horn: "M 1201 747 L 1198 741",
};

/**
 * Create an SVG element with attributes.
 * @param {Document} doc
 * @param {string} tag
 * @param {Record<string, string|number>} [attrs]
 * @param {string} [className]
 */
function svgEl(doc, tag, attrs = {}, className = "") {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  if (className) node.setAttribute("class", className);
  return node;
}

/** Round to 1 decimal so the attribute text stays short. */
function r1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Split a name into at most three balanced lines.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string[]}
 */
export function wrapText(text, maxChars = NAME_CHARS) {
  const clean = String(text ?? "").trim().replace(/\s+/g, " ");
  if (clean.length <= maxChars) return [clean];
  const words = clean.split(" ");
  if (words.length === 1) return [clean];
  let best = null;
  for (let cut = 1; cut < words.length; cut += 1) {
    const a = words.slice(0, cut).join(" ");
    const b = words.slice(cut).join(" ");
    const widest = Math.max(a.length, b.length);
    if (!best || widest < best.widest) best = { lines: [a, b], widest };
  }
  if (best && best.widest <= maxChars + 3) return best.lines;
  // Greedy fill for the rare long case, still capped at three lines by merging the tail.
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  while (lines.length > 3) {
    const tail = lines.pop();
    lines[lines.length - 1] = `${lines[lines.length - 1]} ${tail}`;
  }
  return lines;
}

/** Small stable hash so edge bends do not change between renders. */
function hashKey(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * A gently bent path between two islands, plus its midpoint (for the path label).
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @param {string} key
 */
export function edgeGeometry(a, b, key) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const bend = Math.min(22, len * 0.09) * (hashKey(key) % 2 === 0 ? 1 : -1);
  const cx = (a.x + b.x) / 2 + (-dy / len) * bend;
  const cy = (a.y + b.y) / 2 + (dx / len) * bend;
  return {
    d: `M ${a.x} ${a.y} Q ${r1(cx)} ${r1(cy)} ${b.x} ${b.y}`,
    mid: { x: r1(0.25 * a.x + 0.5 * cx + 0.25 * b.x), y: r1(0.25 * a.y + 0.5 * cy + 0.25 * b.y) },
  };
}

/** Walk up from a node to the first ancestor (or self) matching the predicate. */
function findUp(node, test) {
  let cursor = node;
  while (cursor) {
    if (cursor.nodeType === 1 && test(cursor)) return cursor;
    cursor = cursor.parentNode;
  }
  return null;
}

function hasClass(node, name) {
  return Boolean(node.classList && node.classList.contains(name));
}

const ARROWS = {
  ArrowRight: { x: 1, y: 0 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowDown: { x: 0, y: 1 },
  ArrowUp: { x: 0, y: -1 },
};

/**
 * @param {object} config
 * @param {Document} config.document
 * @param {{REGIONS:any[], ISLANDS:any[], EDGES:any[], VIEWBOX:{width:number,height:number}, EDGE_DRAGON_CAPTION:string, OPEN_LABEL:string, CONTESTED_LABEL:string}} config.graph
 * @param {ReturnType<typeof buildIndex>} [config.index]
 * @param {(id: string|null) => void} [config.onSelect] hover / focus / click of an island
 * @param {(key: string|null) => void} [config.onSelectEdge] hover of a lit path
 * @param {(id: string) => void} [config.onActivate] click / Enter / Space on a frontier island
 * @param {(fn: () => void, ms: number) => any} [config.setTimer]
 * @param {(handle: any) => void} [config.clearTimer]
 */
export function createAtlasMap({
  document: doc = globalThis.document,
  graph,
  index = buildIndex(graph.ISLANDS, graph.EDGES),
  onSelect = () => {},
  onSelectEdge = () => {},
  onActivate = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
}) {
  const { REGIONS, ISLANDS, EDGES, VIEWBOX } = graph;
  const openLabel = graph.OPEN_LABEL || "open, not ratified";
  const contestedLabel = graph.CONTESTED_LABEL || "awaits incorporation";

  const svg = svgEl(doc, "svg", {
    viewBox: `0 0 ${VIEWBOX.width} ${VIEWBOX.height}`,
    role: "group",
    "aria-label": "Atlas map of the ESP design",
    "aria-describedby": "atlas-map-desc",
    preserveAspectRatio: "xMidYMid meet",
    // The focusin/focusout listeners below would otherwise make the bare svg a tab stop.
    tabindex: "-1",
  }, "atlas-svg");

  /** @type {Map<string, {island:any, g:Element, sig:string}>} */
  const nodes = new Map();
  /** @type {Map<string, {edge:any, g:Element, state:string, mid:{x:number,y:number}}>} */
  const edgeNodes = new Map();

  let current = { status: {}, edges: {} };
  let paused = false;
  let pausedMessage = "";
  let rovingId = null;
  let hoverId = null;
  let hoverEdgeKey = null;
  let focusId = null;
  let selectedId = null;
  let dismissed = false;
  let lastShown = null;
  const flareTimers = new Map();
  const flared = new Set();

  const statusOf = (id) => current.status[id] || "fogged";
  const revealed = (id) => nodes.has(id) && statusOf(id) !== "fogged";
  const edgeState = (key) => current.edges[key] || "hidden";

  // ---- static structure ----

  const desc = svgEl(doc, "desc", { id: "atlas-map-desc" });
  desc.textContent = "Tab reaches the map. Arrow keys follow a path to a neighbouring place. Page Down and Page Up step through every visible place in order. Enter or Space selects a visited place or asks about a place that is next to explore. Escape clears the selection.";
  svg.appendChild(desc);

  svg.appendChild(svgEl(doc, "rect", { x: 0, y: 0, width: VIEWBOX.width, height: VIEWBOX.height }, "atlas-sea"));

  // Region bands and captions: always visible, dim.
  const regionLayer = svgEl(doc, "g", {}, "atlas-regions");
  REGIONS.forEach((region, i) => {
    const prev = REGIONS[i - 1];
    const next = REGIONS[i + 1];
    const left = prev ? (prev.x + region.x) / 2 : Math.max(8, region.x - (next ? (next.x - region.x) / 2 : 70));
    const right = next ? (region.x + next.x) / 2 : Math.min(VIEWBOX.width - 8, region.x + (prev ? (region.x - prev.x) / 2 : 70));
    const group = svgEl(doc, "g", { "data-region": region.id }, "atlas-region");
    group.appendChild(svgEl(doc, "rect", {
      x: r1(left + 1.5),
      y: BAND_TOP,
      width: r1(right - left - 3),
      height: BAND_BOTTOM - BAND_TOP,
      rx: 12,
    }, i % 2 === 0 ? "atlas-band" : "atlas-band is-alt"));
    const level = svgEl(doc, "text", { x: region.x, y: CAPTION_Y.level }, "atlas-region-level");
    level.textContent = region.level;
    const name = svgEl(doc, "text", { x: region.x, y: CAPTION_Y.name }, "atlas-region-name");
    name.textContent = region.name;
    const sub = svgEl(doc, "text", { x: region.x, y: CAPTION_Y.sub }, "atlas-region-sub");
    sub.textContent = region.subtitle;
    group.appendChild(level);
    group.appendChild(name);
    group.appendChild(sub);
    regionLayer.appendChild(group);
  });
  svg.appendChild(regionLayer);

  // Edge dragon: the unfinished edge of the map. Inked once the visitor has asked something.
  const dragonGroup = svgEl(doc, "g", {}, "atlas-edge-dragon");
  dragonGroup.appendChild(svgEl(doc, "path", { d: EDGE_DRAGON.body }, "atlas-ed-body"));
  dragonGroup.appendChild(svgEl(doc, "path", { d: EDGE_DRAGON.fins }, "atlas-ed-fins"));
  dragonGroup.appendChild(svgEl(doc, "path", { d: EDGE_DRAGON.head }, "atlas-ed-head"));
  dragonGroup.appendChild(svgEl(doc, "path", { d: EDGE_DRAGON.horn }, "atlas-ed-horn"));
  dragonGroup.appendChild(svgEl(doc, "circle", EDGE_DRAGON.eye, "atlas-ed-eye"));
  const dragonCaption = svgEl(doc, "text", { x: 864, y: 769 }, "atlas-ed-caption");
  dragonCaption.textContent = graph.EDGE_DRAGON_CAPTION || "Unfinished. You will get here.";
  dragonGroup.appendChild(dragonCaption);
  svg.appendChild(dragonGroup);

  const pauseNote = svgEl(doc, "text", { x: 24, y: 769 }, "atlas-pause-note");
  svg.appendChild(pauseNote);

  // Edges (paths). Lit when both ends are visited; faint dashed stubs when one end is.
  const edgeLayer = svgEl(doc, "g", { "aria-hidden": "true" }, "atlas-edges");
  for (const edge of EDGES) {
    const a = index.byId.get(edge.a);
    const b = index.byId.get(edge.b);
    if (!a || !b) continue;
    const key = edgeKey(edge.a, edge.b);
    const geo = edgeGeometry(a, b, key);
    const group = svgEl(doc, "g", { "data-edge": key }, "atlas-edge is-hidden");
    group.appendChild(svgEl(doc, "path", { d: geo.d }, "atlas-edge-glow"));
    group.appendChild(svgEl(doc, "path", { d: geo.d }, "atlas-edge-line"));
    group.appendChild(svgEl(doc, "path", { d: geo.d }, "atlas-edge-hit"));
    edgeLayer.appendChild(group);
    edgeNodes.set(key, { edge, g: group, state: "hidden", mid: geo.mid });
  }
  svg.appendChild(edgeLayer);

  // Islands.
  const islandLayer = svgEl(doc, "g", {}, "atlas-islands");
  for (const island of ISLANDS) {
    const classes = ["atlas-island", "is-fogged"];
    if (island.status === "contested") classes.push("is-contested");
    if (island.status === "open") classes.push("is-open");
    const group = svgEl(doc, "g", {
      "data-id": island.id,
      transform: `translate(${island.x} ${island.y})`,
      "aria-hidden": "true",
    }, classes.join(" "));
    group.appendChild(svgEl(doc, "circle", { r: HIT_R }, "atlas-hit"));
    group.appendChild(svgEl(doc, "circle", { r: BODY_R + 1 }, "atlas-flare-ring"));
    group.appendChild(svgEl(doc, "circle", { r: BODY_R + 12 }, "atlas-focus-ring"));
    group.appendChild(svgEl(doc, "circle", { r: 3.5 }, "atlas-fog-dot"));

    const body = svgEl(doc, "g", {}, "atlas-body");
    body.appendChild(svgEl(doc, "circle", { r: BODY_R + 8 }, "atlas-halo"));
    if (island.status === "contested") body.appendChild(svgEl(doc, "circle", { r: BODY_R + 8.5 }, "atlas-contest-ring"));
    if (island.status === "open") {
      const glyph = svgEl(doc, "g", { transform: "translate(0 3)" }, "atlas-dragon");
      for (const d of DRAGON_GLYPH) glyph.appendChild(svgEl(doc, "path", { d }, "atlas-dragon-line"));
      body.appendChild(glyph);
    } else {
      body.appendChild(svgEl(doc, "circle", { r: BODY_R }, "atlas-disc"));
      body.appendChild(svgEl(doc, "circle", { r: 3.6 }, "atlas-pip"));
    }
    group.appendChild(body);

    const lines = wrapText(island.name);
    const label = svgEl(doc, "text", {}, "atlas-label");
    lines.forEach((line, i) => {
      const tspan = svgEl(doc, "tspan", { x: 0, y: r1(LABEL_Y0 + i * LINE_H) });
      tspan.textContent = line;
      label.appendChild(tspan);
    });
    group.appendChild(label);

    const subText = island.status === "open"
      ? island.label || openLabel
      : island.status === "contested"
        ? island.label || contestedLabel
        : "";
    if (subText) {
      const sub = svgEl(doc, "text", { x: 0, y: r1(LABEL_Y0 + (lines.length - 1) * LINE_H + SUB_GAP) }, "atlas-sublabel");
      sub.textContent = subText;
      group.appendChild(sub);
    }

    islandLayer.appendChild(group);
    nodes.set(island.id, { island, g: group, sig: "" });
  }
  svg.appendChild(islandLayer);

  // Path label for the hovered path.
  const tip = svgEl(doc, "g", { "aria-hidden": "true" }, "atlas-edge-tip");
  const tipBg = svgEl(doc, "rect", { rx: 7 }, "atlas-edge-tip-bg");
  const tipText = svgEl(doc, "text", {}, "atlas-edge-tip-text");
  tip.appendChild(tipBg);
  tip.appendChild(tipText);
  svg.appendChild(tip);

  // ---- painting ----

  function labelFor(node, status) {
    const { island } = node;
    const name = island.name;
    let text;
    if (status === "visited") {
      text = `${name}, visited`;
      if (island.status === "contested") text = `${name}, ${island.label || contestedLabel}, visited`;
      if (island.status === "open") text = `${name}, ${island.label || openLabel}, visited`;
    } else if (island.status === "open") {
      // A dragon is an open item of the designers, never a goal: do not say "next to explore".
      text = `${name}, ${island.label || openLabel}. ${island.teaser}`;
    } else if (island.status === "contested") {
      text = `${name}, ${island.label || contestedLabel}, next to explore. ${island.teaser}`;
    } else {
      text = `${name}, next to explore. ${island.teaser}`;
    }
    if (status === "frontier" && paused && pausedMessage) text = `${text} ${pausedMessage}`;
    return text;
  }

  function paintIsland(node) {
    const status = statusOf(node.island.id);
    const sig = `${status}|${paused ? 1 : 0}|${paused ? pausedMessage : ""}`;
    if (node.sig === sig) return;
    node.sig = sig;
    const g = node.g;
    g.classList.toggle("is-visited", status === "visited");
    g.classList.toggle("is-frontier", status === "frontier");
    g.classList.toggle("is-fogged", status === "fogged");
    if (status === "fogged") {
      g.setAttribute("aria-hidden", "true");
      g.removeAttribute("role");
      g.removeAttribute("aria-label");
      g.removeAttribute("aria-disabled");
      g.removeAttribute("tabindex");
      return;
    }
    g.removeAttribute("aria-hidden");
    g.setAttribute("role", "button");
    g.setAttribute("aria-label", labelFor(node, status));
    if (status === "frontier" && paused) g.setAttribute("aria-disabled", "true");
    else g.removeAttribute("aria-disabled");
    g.setAttribute("tabindex", node.island.id === rovingId ? "0" : "-1");
  }

  function paintEdge(node, key) {
    const state = edgeState(key);
    if (node.state === state) return;
    node.state = state;
    node.g.classList.toggle("is-lit", state === "lit");
    node.g.classList.toggle("is-stub", state === "stub");
    node.g.classList.toggle("is-hidden", state !== "lit" && state !== "stub");
  }

  /** What the caption should show: hover wins, then keyboard focus, then the clicked island. */
  function shownNow() {
    if (hoverId) return hoverId;
    if (dismissed) return null;
    return focusId || selectedId || null;
  }

  function paintActive() {
    const shown = shownNow();
    for (const [id, node] of nodes) {
      node.g.classList.toggle("is-active", id === shown);
      node.g.classList.toggle("is-selected", id === selectedId);
    }
    for (const [key, node] of edgeNodes) {
      const touches = shown !== null && (node.edge.a === shown || node.edge.b === shown);
      node.g.classList.toggle("is-active", (touches && node.state === "lit") || key === hoverEdgeKey);
    }
  }

  function notifyShown() {
    const next = shownNow();
    paintActive();
    if (next === lastShown) return;
    lastShown = next;
    onSelect(next);
  }

  function showTip(key) {
    const node = key ? edgeNodes.get(key) : null;
    if (!node || node.state !== "lit") {
      tip.classList.remove("is-visible");
      return;
    }
    while (tipText.firstChild) tipText.removeChild(tipText.firstChild);
    const lines = wrapText(node.edge.label, EDGE_TIP_CHARS);
    const spans = lines.map((line, i) => {
      const tspan = svgEl(doc, "tspan", { x: 0, y: i * TIP_LINE_H });
      tspan.textContent = line;
      tipText.appendChild(tspan);
      return tspan;
    });
    tip.classList.add("is-visible");
    // Measure once visible; fall back to an estimate where layout is unavailable.
    let width = Math.max(...lines.map((line) => line.length)) * 7.6;
    try {
      const box = tipText.getBBox();
      if (box && box.width > 0) width = box.width;
    } catch (error) {
      // No layout engine: keep the estimate.
    }
    const height = lines.length * TIP_LINE_H;
    const x = Math.min(Math.max(node.mid.x, width / 2 + 16), VIEWBOX.width - width / 2 - 16);
    const top = Math.min(Math.max(node.mid.y - 14 - height, 84), VIEWBOX.height - height - 40);
    spans.forEach((tspan, i) => {
      tspan.setAttribute("x", String(r1(x)));
      tspan.setAttribute("y", String(r1(top + 11 + i * TIP_LINE_H)));
    });
    tipBg.setAttribute("x", String(r1(x - width / 2 - 9)));
    tipBg.setAttribute("y", String(r1(top - 4)));
    tipBg.setAttribute("width", String(r1(width + 18)));
    tipBg.setAttribute("height", String(r1(height + 8)));
  }

  function setHoverEdge(key) {
    if (key === hoverEdgeKey) return;
    hoverEdgeKey = key;
    showTip(key);
    paintActive();
    onSelectEdge(key);
    // Leaving a path hands the caption back to the island that was showing.
    if (key === null && lastShown !== null) onSelect(lastShown);
  }

  function setRoving(id) {
    if (rovingId === id) return;
    rovingId = id;
    for (const [nodeId, node] of nodes) {
      if (statusOf(nodeId) === "fogged") continue;
      node.g.setAttribute("tabindex", nodeId === id ? "0" : "-1");
    }
  }

  function chooseRoving(flare) {
    if (focusId && revealed(focusId)) return focusId;
    for (let i = flare.length - 1; i >= 0; i -= 1) {
      if (statusOf(flare[i]) === "visited" && nodes.has(flare[i])) return flare[i];
    }
    if (rovingId && revealed(rovingId)) return rovingId;
    const start = ISLANDS.find((island) => island.start && statusOf(island.id) === "visited");
    if (start) return start.id;
    let lastVisited = null;
    let firstFrontier = null;
    for (const island of ISLANDS) {
      const status = statusOf(island.id);
      if (status === "visited") lastVisited = island.id;
      else if (status === "frontier" && firstFrontier === null) firstFrontier = island.id;
    }
    return lastVisited ?? firstFrontier;
  }

  function startFlare(id) {
    const node = nodes.get(id);
    if (!node) return;
    node.g.classList.add("is-flare");
    if (flareTimers.has(id)) clearTimer(flareTimers.get(id));
    flareTimers.set(id, setTimer(() => endFlare(id), FLARE_MS));
  }

  function endFlare(id) {
    const node = nodes.get(id);
    if (node) node.g.classList.remove("is-flare");
    if (flareTimers.has(id)) clearTimer(flareTimers.get(id));
    flareTimers.delete(id);
  }

  function setPauseNote() {
    const text = paused && pausedMessage
      ? (pausedMessage.length > PAUSE_NOTE_MAX ? `${pausedMessage.slice(0, PAUSE_NOTE_MAX - 1)}…` : pausedMessage)
      : "";
    pauseNote.textContent = text;
    pauseNote.classList.toggle("is-visible", Boolean(text));
  }

  // ---- public API ----

  function render(view, opts = {}) {
    current = {
      status: (view && view.status) || {},
      edges: (view && view.edges) || {},
    };
    paused = Boolean(opts.paused);
    pausedMessage = paused ? String(opts.pausedMessage || "") : "";
    const flare = Array.isArray(opts.flare) ? opts.flare : [];

    // A reset (or any island dropping back to fog) forgets its flare and selection state.
    for (const id of [...flared]) {
      if (statusOf(id) !== "visited") {
        flared.delete(id);
        endFlare(id);
      }
    }
    if (selectedId && !revealed(selectedId)) selectedId = null;
    if (hoverId && !revealed(hoverId)) hoverId = null;
    if (focusId && !revealed(focusId)) focusId = null;

    svg.classList.toggle("is-paused", paused);
    svg.classList.toggle("has-replies", Number(opts.replies) > 0);
    dragonGroup.classList.toggle("is-inked", Number(opts.replies) > 0);
    setPauseNote();

    for (const edgeNode of edgeNodes.values()) {
      paintEdge(edgeNode, edgeKey(edgeNode.edge.a, edgeNode.edge.b));
    }
    const nextRoving = chooseRoving(flare);
    rovingId = nextRoving;
    for (const node of nodes.values()) paintIsland(node);
    for (const [id, node] of nodes) {
      if (statusOf(id) !== "fogged") node.g.setAttribute("tabindex", id === rovingId ? "0" : "-1");
    }
    for (const id of flare) {
      if (statusOf(id) === "visited" && !flared.has(id)) {
        flared.add(id);
        startFlare(id);
      }
    }
    if (hoverEdgeKey) showTip(hoverEdgeKey);
    notifyShown();
  }

  function focusIsland(id) {
    if (!revealed(id)) return false;
    setRoving(id);
    const node = nodes.get(id);
    if (node && typeof node.g.focus === "function") node.g.focus();
    return true;
  }

  function select(id) {
    selectedId = id && revealed(id) ? id : null;
    dismissed = false;
    lastShown = shownNow();
    paintActive();
  }

  // ---- interaction ----

  function islandOf(target) {
    const g = findUp(target, (node) => hasClass(node, "atlas-island"));
    if (!g) return null;
    const id = g.getAttribute("data-id");
    return id && revealed(id) ? id : null;
  }

  function edgeOf(target) {
    const g = findUp(target, (node) => hasClass(node, "atlas-edge"));
    if (!g) return null;
    const key = g.getAttribute("data-edge");
    return key && edgeState(key) === "lit" ? key : null;
  }

  function activate(id) {
    const status = statusOf(id);
    if (status === "fogged") return;
    selectedId = id;
    dismissed = false;
    notifyShown();
    if (status === "frontier" && !paused) onActivate(id);
  }

  function neighbourInDirection(id, dir) {
    const from = index.byId.get(id);
    if (!from) return null;
    let best = null;
    for (const otherId of index.neighbours.get(id) || []) {
      if (!revealed(otherId)) continue;
      // Only follow drawn paths: at least one end must be visited.
      if (statusOf(id) !== "visited" && statusOf(otherId) !== "visited") continue;
      const other = index.byId.get(otherId);
      const dx = other.x - from.x;
      const dy = other.y - from.y;
      const dist = Math.hypot(dx, dy) || 1;
      const cos = (dx * dir.x + dy * dir.y) / dist;
      if (cos < ARROW_MIN_COS) continue;
      const better = !best || cos > best.cos + 0.02 || (Math.abs(cos - best.cos) <= 0.02 && dist < best.dist);
      if (better) best = { id: otherId, cos, dist };
    }
    return best ? best.id : null;
  }

  function stepVisible(id, delta) {
    const order = ISLANDS.filter((island) => revealed(island.id)).map((island) => island.id);
    const at = order.indexOf(id);
    if (at < 0) return null;
    return order[at + delta] ?? null;
  }

  svg.addEventListener("click", (event) => {
    const id = islandOf(event.target);
    if (id) {
      activate(id);
      return;
    }
    if (edgeOf(event.target)) return;
    selectedId = null;
    notifyShown();
  });

  svg.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === "Escape") {
      // Escape always reports a cleared selection, even if nothing was shown.
      selectedId = null;
      hoverId = null;
      dismissed = true;
      if (hoverEdgeKey) {
        hoverEdgeKey = null;
        showTip(null);
        onSelectEdge(null);
      }
      paintActive();
      lastShown = null;
      onSelect(null);
      return;
    }
    const id = islandOf(event.target);
    if (!id) return;
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      activate(id);
      return;
    }
    if (event.key === "PageDown" || event.key === "PageUp") {
      // A guaranteed route to every visible place, in region order.
      event.preventDefault();
      const next = stepVisible(id, event.key === "PageDown" ? 1 : -1);
      if (next) focusIsland(next);
      return;
    }
    const dir = ARROWS[event.key];
    if (!dir) return;
    event.preventDefault();
    const next = neighbourInDirection(id, dir);
    if (next) focusIsland(next);
  });

  svg.addEventListener("focusin", (event) => {
    const id = islandOf(event.target);
    if (!id) return;
    focusId = id;
    dismissed = false;
    setRoving(id);
    notifyShown();
  });

  svg.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (next && islandOf(next)) return;
    focusId = null;
    notifyShown();
  });

  svg.addEventListener("mouseover", (event) => {
    const id = islandOf(event.target);
    const key = id ? null : edgeOf(event.target);
    if (id !== hoverId) {
      hoverId = id;
      if (id) dismissed = false;
      notifyShown();
    }
    setHoverEdge(key);
  });

  svg.addEventListener("mouseleave", () => {
    hoverId = null;
    notifyShown();
    setHoverEdge(null);
  });

  svg.addEventListener("animationend", (event) => {
    if (event.animationName !== "atlas-flare") return;
    const g = findUp(event.target, (node) => hasClass(node, "atlas-island"));
    if (g) endFlare(g.getAttribute("data-id"));
  });

  // First paint: everything fogged until the caller renders a view.
  for (const node of nodes.values()) paintIsland(node);

  return { element: svg, render, focusIsland, select, selected: () => selectedId };
}
