import * as graph from "./atlas-graph.js";
import { createChatBridge, createDomPort } from "./atlas-chat.js";
import { createAtlasList } from "./atlas-list.js";
import { createAtlasMap } from "./atlas-map.js";
import { compileGlossary, glossarySize, matchReply, warmGlossary } from "./atlas-match.js";
import { createInspector, createSuggestions, renderCount, suggestionItems } from "./atlas-panel.js";
import { deriveView, persistAtlas, reduceAtlas, restoreAtlas } from "./atlas-state.js";

/** How far from the end (px) the history may be and still count as "reading the newest row". */
const PIN_SLACK = 24;
/** How long "Clear map" waits for its second press before it goes back to being a plain button. */
export const CLEAR_CONFIRM_MS = 4000;
/** Names listed in the spoken summary of a reply; the rest is counted. */
export const ANNOUNCE_NAMES = 5;
/** Shown when no answer can ever light the map (for example a browser that cannot compile the matcher). */
export const NO_GLOSSARY_NOTICE = "This browser cannot read answers for the map; the list still works.";
export const CLEAR_LABEL = "Clear map";
export const CLEAR_CONFIRM_LABEL = "Confirm: clear map";

/**
 * The polite one-line summary of a reply for screen readers.
 * @param {string[]} names display names of the places a reply lit for the first time
 * @param {number} visited places visited now
 * @param {number} total places on the map
 * @param {number} [cap]
 */
export function describeLit(names, visited, total, cap = ANNOUNCE_NAMES) {
  if (!names.length) return "No new places lit.";
  const shown = names.slice(0, cap);
  const more = names.length - shown.length;
  return `Lit: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}. ${visited} of ${total} visited.`;
}

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
    announce: doc.querySelector("#atlas-announce"),
    suggest: doc.querySelector("#atlas-suggest"),
    mapButton: doc.querySelector("#atlas-view-map"),
    listButton: doc.querySelector("#atlas-view-list"),
    resetButton: doc.querySelector("#atlas-reset"),
  };
  if (!mounts.map || !mounts.list || !mounts.inspector) return null;

  const timers = {
    set: setTimer || ((fn, ms) => setTimeout(fn, ms)),
    clear: clearTimer || ((handle) => clearTimeout(handle)),
  };
  const win = doc.defaultView || globalThis;
  const index = graph.buildIndex();
  const glossary = compileGlossary(graph.ISLANDS);
  // A glossary with no usable term (an engine that cannot compile the patterns) means the map can
  // never light: say so, once, in the notice, instead of failing silently.
  const standingNotice = glossarySize(glossary) === 0 ? NO_GLOSSARY_NOTICE : "";
  let state = restoreAtlas(storage, index);
  let view = deriveView(state, index);
  let flare = [];
  let bridge = null;
  let confirming = false;
  let confirmTimer = null;
  let warmHandle = null;
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
    ? createSuggestions({
      document: doc,
      mount: mounts.suggest,
      onPick: (text) => send(text),
      fallbackFocus: () => mounts.mapButton,
    })
    : null;
  mounts.map.replaceChildren(map.element);
  mounts.list.replaceChildren(list.element);

  /**
   * Whether teasers are paused, and the one sentence that says why. A draft in the message box is
   * the visitor's own doing: the controls just show they are unavailable, no text is added (so
   * nothing moves while they type).
   */
  function pause() {
    const status = bridge ? bridge.status() : { canSend: false, reason: "starting", message: "" };
    const notice = status.reason === "draft" ? "" : String(status.message || "");
    return { paused: !status.canSend, notice };
  }

  /** Speak a sentence through the polite status element. The same sentence twice is spoken twice. */
  function say(text) {
    const el = mounts.announce;
    if (!el) return;
    if (el.textContent !== text) {
      el.textContent = text;
      return;
    }
    el.textContent = "";
    timers.set(() => {
      if (el.textContent === "") el.textContent = text;
    }, 60);
  }

  /** Repaints everything from the current state. Safe to call at any time. */
  function render() {
    view = deriveView(state, index);
    const { paused, notice } = pause();
    map.render(view, { flare, paused, replies: state.replies });
    flare = [];
    list.render(view, { paused });
    if (mounts.count) renderCount(mounts.count, view);
    if (suggestions) suggestions.render(suggestionItems(view), { paused });
    inspector.refresh(view);
    // The only place a pause is explained. Its box is always there (two lines high), so a message
    // appearing or going moves nothing.
    const text = notice || standingNotice;
    if (mounts.notice && mounts.notice.textContent !== text) mounts.notice.textContent = text;
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
    const lit = flare.map((id) => (index.byId.get(id) || { name: id }).name);
    persistAtlas(storage, state);
    render();
    history.toEnd();
    say(describeLit(lit, view.visitedCount, view.total));
    return ids;
  }

  function reset() {
    state = reduceAtlas(state, { type: "reset" }, index);
    flare = [];
    persistAtlas(storage, state);
    inspector.showIsland(null, deriveView(state, index));
    render();
    say(`Map cleared. ${view.visitedCount} of ${view.total} visited.`);
  }

  /** Clearing is one press to arm and one to confirm; left alone, the button goes back after a moment. */
  function setConfirming(on) {
    confirming = on;
    if (confirmTimer !== null) {
      timers.clear(confirmTimer);
      confirmTimer = null;
    }
    const button = mounts.resetButton;
    if (button) {
      button.textContent = on ? CLEAR_CONFIRM_LABEL : CLEAR_LABEL;
      button.classList.toggle("is-confirming", on);
    }
    if (on) confirmTimer = timers.set(() => setConfirming(false), CLEAR_CONFIRM_MS);
  }

  function pressClear() {
    if (!confirming) {
      setConfirming(true);
      say("Press the button again within a few seconds to clear the map.");
      return;
    }
    setConfirming(false);
    reset();
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
  mounts.resetButton?.addEventListener("click", pressClear);
  mounts.resetButton?.addEventListener("blur", () => {
    if (confirming) setConfirming(false);
  });
  doc.querySelector("#draft")?.addEventListener("input", () => render());

  bridge = createChatBridge({
    port: port || createDomPort(doc),
    now,
    setTimer,
    clearTimer,
    onReply: applyReply,
    onChange: () => render(),
  });

  // Everything that describes the map, the chips or the chat stays hidden until this script runs,
  // so a visitor without JavaScript sees the honesty note and the plain index only.
  if (mounts.toolbar) mounts.toolbar.hidden = false;
  if (mounts.notice) mounts.notice.hidden = false;
  for (const el of doc.querySelectorAll(".atlas-intro, .atlas-legend, .hero-cta-note")) el.hidden = false;
  showView("map");
  render();

  // Compile and tier up the matcher in idle time, so the first real reply does not stall the page.
  const warm = () => {
    warmHandle = null;
    warmGlossary(glossary, 2);
  };
  warmHandle = typeof win.requestIdleCallback === "function"
    ? { idle: win.requestIdleCallback(warm, { timeout: 3000 }) }
    : { timer: timers.set(warm, 250) };

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
      if (confirmTimer !== null) timers.clear(confirmTimer);
      if (warmHandle) {
        if (warmHandle.timer !== undefined) timers.clear(warmHandle.timer);
        else if (typeof win.cancelIdleCallback === "function") win.cancelIdleCallback(warmHandle.idle);
      }
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
    if (notice) {
      notice.hidden = false;
      notice.textContent = "The map could not start. The conversation still works.";
    }
    console.error(error);
  }
}

if (typeof document !== "undefined") wire();
