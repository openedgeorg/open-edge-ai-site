import * as graph from "./atlas-graph.js";
import { createChatBridge, createDomPort } from "./atlas-chat.js";
import { createAtlasList } from "./atlas-list.js";
import { createAtlasMap } from "./atlas-map.js";
import { compileGlossary, matchReply } from "./atlas-match.js";
import { createInspector, createSuggestions, renderCount, suggestionItems } from "./atlas-panel.js";
import { deriveView, persistAtlas, reduceAtlas, restoreAtlas } from "./atlas-state.js";

/** How far from the end (px) the history may be and still count as "reading the newest row". */
const PIN_SLACK = 24;

/**
 * Keeps the conversation history scrolled to its newest row: after the visitor sends something,
 * while an answer streams in, and when a final reply is applied. A visitor who scrolls up to
 * re-read is left alone until they send again. Scrolling never moves keyboard focus.
 * @param {Document} doc
 * @returns {{toEnd: () => void, dispose: () => void}}
 */
export function followHistory(doc) {
  const list = doc.querySelector("#history");
  const none = { toEnd() {}, dispose() {} };
  if (!list) return none;
  const view = doc.defaultView || globalThis;
  let pinned = true;

  function toEnd() {
    pinned = true;
    list.scrollTop = list.scrollHeight;
  }

  function follow() {
    if (pinned) list.scrollTop = list.scrollHeight;
  }

  const onScroll = () => {
    pinned = list.scrollHeight - list.scrollTop - list.clientHeight <= PIN_SLACK;
  };
  const onSubmit = () => toEnd();
  list.addEventListener("scroll", onScroll, { passive: true });
  // Bubble phase on the form: the chat's own handler (registered earlier) has added the visitor's row by now.
  const form = doc.querySelector("#composer");
  if (form) form.addEventListener("submit", onSubmit);

  const observers = [];
  if (typeof view.MutationObserver === "function") {
    const mutations = new view.MutationObserver(follow);
    mutations.observe(list, { childList: true, subtree: true, characterData: true });
    observers.push(mutations);
  }
  if (typeof view.ResizeObserver === "function") {
    // The card gives the history whatever height is left, so it changes size when the chips do.
    const resizes = new view.ResizeObserver(follow);
    resizes.observe(list);
    observers.push(resizes);
  }

  return {
    toEnd,
    dispose() {
      list.removeEventListener("scroll", onScroll);
      if (form) form.removeEventListener("submit", onSubmit);
      for (const observer of observers) observer.disconnect();
    },
  };
}

/**
 * The Atlas controller. It watches the existing chat from the outside: it reads each final
 * assistant reply as text, lights the islands the reply mentions and sends teaser questions
 * through the same composer form. The model is never told that the map exists, and nothing in
 * the chat client, the API or the prompt changes.
 *
 * Progress lives in sessionStorage only (island ids, never transcripts).
 * @param {{document?: Document, storage?: Storage|null, port?: object, now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (handle: any) => void}} options
 */
export function createAtlas({ document: doc = globalThis.document, storage = null, port, now, setTimer, clearTimer } = {}) {
  const mounts = {
    toolbar: doc.querySelector("#atlas-toolbar"),
    count: doc.querySelector("#atlas-count"),
    map: doc.querySelector("#atlas-map"),
    list: doc.querySelector("#atlas-list"),
    inspector: doc.querySelector("#atlas-inspector"),
    notice: doc.querySelector("#atlas-notice"),
    suggest: doc.querySelector("#atlas-suggest"),
    mapButton: doc.querySelector("#atlas-view-map"),
    listButton: doc.querySelector("#atlas-view-list"),
    resetButton: doc.querySelector("#atlas-reset"),
  };
  if (!mounts.map || !mounts.list || !mounts.inspector) return null;

  const index = graph.buildIndex();
  const glossary = compileGlossary(graph.ISLANDS);
  let state = restoreAtlas(storage, index);
  let view = deriveView(state, index);
  let flare = [];
  let bridge = null;
  const history = followHistory(doc);

  const inspector = createInspector({ document: doc, graph, index, mount: mounts.inspector });
  const map = createAtlasMap({
    document: doc,
    graph,
    index,
    onSelect: (id) => inspector.showIsland(id, view),
    onSelectEdge: (key) => inspector.showEdge(key, view),
    onActivate: (id) => ask(id),
  });
  const list = createAtlasList({
    document: doc,
    graph,
    index,
    onSelect: (id) => inspector.showIsland(id, view),
    onActivate: (id) => ask(id),
  });
  const suggestions = mounts.suggest
    ? createSuggestions({ document: doc, mount: mounts.suggest, onPick: (text) => send(text) })
    : null;
  mounts.map.replaceChildren(map.element);
  mounts.list.replaceChildren(list.element);

  function pause() {
    const status = bridge ? bridge.status() : { canSend: false, message: "" };
    return { paused: !status.canSend, pausedMessage: status.canSend ? "" : status.message || "" };
  }

  /** Repaints everything from the current state. Safe to call at any time. */
  function render() {
    view = deriveView(state, index);
    const { paused, pausedMessage } = pause();
    map.render(view, { flare, paused, pausedMessage, replies: state.replies });
    flare = [];
    list.render(view, { paused, pausedMessage });
    if (mounts.count) renderCount(mounts.count, view);
    if (suggestions) suggestions.render(suggestionItems(view), { paused, pausedMessage });
    inspector.refresh(view);
    if (mounts.notice && mounts.notice.textContent !== pausedMessage) mounts.notice.textContent = pausedMessage;
  }

  function send(text) {
    if (!bridge) return { sent: false, reason: "starting" };
    const outcome = bridge.sendTeaser(text);
    render();
    return outcome;
  }

  function ask(id) {
    const island = index.byId.get(id);
    return island ? send(island.teaser) : { sent: false, reason: "unknown" };
  }

  /** @param {string} text the final assistant reply */
  function applyReply(text) {
    const ids = matchReply(text, glossary);
    const before = new Set(state.visited);
    state = reduceAtlas(state, { type: "reply", ids }, index);
    flare = ids.filter((id) => !before.has(id));
    persistAtlas(storage, state);
    render();
    history.toEnd();
    return ids;
  }

  function reset() {
    state = reduceAtlas(state, { type: "reset" }, index);
    flare = [];
    persistAtlas(storage, state);
    inspector.showIsland(null, deriveView(state, index));
    render();
  }

  function showView(which) {
    const showMap = which !== "list";
    mounts.map.hidden = !showMap;
    mounts.list.hidden = showMap;
    mounts.mapButton?.setAttribute("aria-pressed", String(showMap));
    mounts.listButton?.setAttribute("aria-pressed", String(!showMap));
  }

  mounts.mapButton?.addEventListener("click", () => showView("map"));
  mounts.listButton?.addEventListener("click", () => showView("list"));
  mounts.resetButton?.addEventListener("click", reset);
  doc.querySelector("#draft")?.addEventListener("input", () => render());

  bridge = createChatBridge({
    port: port || createDomPort(doc),
    now,
    setTimer,
    clearTimer,
    onReply: applyReply,
    onChange: () => render(),
  });

  if (mounts.toolbar) mounts.toolbar.hidden = false;
  showView("map");
  render();

  return {
    applyReply,
    reset,
    render,
    showView,
    ask,
    state: () => state,
    view: () => view,
    glossaryProblems: () => glossary.rejected.slice(),
    dispose() {
      if (bridge) bridge.dispose();
      history.dispose();
    },
  };
}

function browserStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function wire() {
  if (!document.querySelector("#atlas")) return;
  try {
    createAtlas({ document, storage: browserStorage() });
  } catch (error) {
    const notice = document.querySelector("#atlas-notice");
    if (notice) notice.textContent = "The map could not start. The conversation still works.";
    console.error(error);
  }
}

if (typeof document !== "undefined") wire();
