import * as graph from "./atlas-graph.js";
import { createChatBridge, createDomPort } from "./atlas-chat.js";
import { createAtlasList } from "./atlas-list.js";
import { createAtlasMap } from "./atlas-map.js";
import { createAtlasNav, dockLabels } from "./atlas-nav.js";
import { compileGlossary, glossarySize, matchReply, warmGlossary } from "./atlas-match.js";
import { createInspector, createSuggestions, renderCount, suggestionPlan } from "./atlas-panel.js";
import { deriveView, persistAtlas, reduceAtlas, restoreAtlas } from "./atlas-state.js";

/** How far from the end (px) the history may be and still count as "reading the newest row". */
const PIN_SLACK = 24;
/** When a long answer is brought into view, its first line sits this far (px) below the top edge of the history. */
const ANSWER_TOP_GAP = 8;
/** The two buttons that appear under the history when the visitor is away from the newest answer. */
export const HISTORY_START_LABEL = "Back to start of answer";
export const HISTORY_LATEST_LABEL = "Jump to latest";
/** How long "Clear map" waits for its second press before it goes back to being a plain button. */
export const CLEAR_CONFIRM_MS = 4000;
/** Names listed in the spoken summary of a reply; the rest is counted. */
export const ANNOUNCE_NAMES = 5;
/** Shown when no answer can ever light the map (for example a browser that cannot compile the matcher). */
export const NO_GLOSSARY_NOTICE = "This browser cannot read answers for the map; the list still works.";
export const CLEAR_LABEL = "Clear map";
export const CLEAR_CONFIRM_LABEL = "Confirm: clear map";
/** The page is two columns (map left, chat right) from this width up; below it, one column. */
export const TWO_COLUMNS_QUERY = "(min-width: 1180px)";
/** At least this much of the conversation card (px) must be on screen to count as "the visitor is reading it". */
export const CHAT_IN_VIEW_PX = 120;
/** At least this much of the Atlas card (px) must be on screen to count as "the visitor is still looking at the map". */
export const ATLAS_IN_VIEW_PX = 120;
/** A visitor who has scrolled this fraction of a screen (or more) since asking has gone elsewhere. */
export const SCROLLED_AWAY_SCREENS = 0.5;
/** The words of the question on the first screen: before the first answer, and once the visitor has started. */
export const HERO_LABEL_START = "Start with one question";
export const HERO_LABEL_RESUME = "Pick up where you left off";
export const HERO_RESUME = "Keep exploring the map";
/** How long the Atlas waits after a scroll before it checks whether the places a reply lit have been seen (ms). */
export const SEEN_CHECK_MS = 300;

/**
 * Whether the visitor is looking at the conversation card, which means they are reading an answer
 * and the page must not be scrolled away from it.
 * @param {{top: number, bottom: number}|null} box the card's rectangle in viewport pixels
 * @param {number} viewHeight the window's height
 * @param {number} [minVisible]
 */
export function conversationInView(box, viewHeight, minVisible = CHAT_IN_VIEW_PX) {
  if (!box) return false;
  return Math.min(box.bottom, viewHeight) - Math.max(box.top, 0) >= minVisible;
}

/**
 * Whether the page may be scrolled down to the map once a reply has lit it (the one-column layout):
 * only for a visitor who is still around the map. That is the case while the Atlas card is on screen,
 * or while the page has not moved half a screen from where it was when the question was sent. A
 * visitor who scrolled away while waiting (to the top, to the footer, anywhere) is left where they are.
 * When the position at sending is not known (the question went out before a reload) only the first
 * test applies.
 * @param {{top: number, bottom: number}|null} card the Atlas card's rectangle in viewport pixels
 * @param {number} viewHeight the window's height
 * @param {number} scrollY the page's scroll position now
 * @param {number|null|undefined} sentScrollY the page's scroll position when the question was sent
 * @param {number} [minVisible]
 */
export function mapStillWanted(card, viewHeight, scrollY, sentScrollY, minVisible = ATLAS_IN_VIEW_PX) {
  if (card && Math.min(card.bottom, viewHeight) - Math.max(card.top, 0) >= minVisible) return true;
  if (!Number.isFinite(sentScrollY) || !Number.isFinite(scrollY) || !(viewHeight > 0)) return false;
  return Math.abs(scrollY - sentScrollY) < viewHeight * SCROLLED_AWAY_SCREENS;
}

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
 * Keeps the conversation history readable while answers arrive.
 *
 * - The visitor's own message scrolls the history to its end, so they see what they asked and the
 *   answer that follows.
 * - While an answer streams in, the history follows its end, but only for a visitor who is already
 *   at the end. Someone who scrolled up to re-read is left exactly where they are (also when the
 *   rows are replaced from /history or the box is resized) until they send again or press
 *   "Jump to latest".
 * - When an answer is complete (answerDone), a visitor who was following lands on its FIRST line if
 *   it is taller than the history, so a long answer is read from its beginning; a short one is shown
 *   whole, with the question above it when there is room.
 * - Two buttons appear under the history when they are relevant: "Back to start of answer" while the
 *   first line of the newest answer is out of sight above, and "Jump to latest" while the end of the
 *   history is out of sight below. Pressing one moves focus to the history; nothing else here does.
 * Nothing animates.
 * @param {Document} doc
 * @returns {{toEnd: () => void, answerDone: () => void, dispose: () => void}}
 */
export function followHistory(doc) {
  const list = doc.querySelector("#history");
  const none = { toEnd() {}, answerDone() {}, dispose() {} };
  if (!list) return none;
  const view = doc.defaultView || globalThis;
  let pinned = true;
  let frame = null;
  // Where the history was last scrolled to, by us or by the visitor. A scroll event reaches the page a frame
  // after the scroll, when more text may already be there or the card may have changed height: judged by its
  // distance from the end alone, our own scroll would look like the visitor leaving the end. Only a move UP,
  // away from the end, says that the visitor left it.
  let last = list.scrollTop;

  const distanceFromEnd = () => list.scrollHeight - list.scrollTop - list.clientHeight;

  function scrollTo(top) {
    list.scrollTop = top;
    last = list.scrollTop;
  }

  /** Has the visitor scrolled up since we last moved the history, with the scroll event still on its way? */
  const movedUp = () => list.scrollTop < last - 1 && distanceFromEnd() > PIN_SLACK;

  /** The last row labelled "assistant"; the last row at all when no row carries a role. */
  function newestAnswer() {
    const rows = list.children;
    if (!rows || !rows.length) return null;
    let labelled = false;
    for (let at = rows.length - 1; at >= 0; at -= 1) {
      const role = typeof rows[at].getAttribute === "function" ? rows[at].getAttribute("data-role") : null;
      if (role === "assistant") return rows[at];
      if (role) labelled = true;
    }
    return labelled ? null : rows[rows.length - 1];
  }

  /** Where a row starts, in the history's own scroll coordinates (null when the page cannot measure). */
  function startOf(row) {
    if (typeof row.getBoundingClientRect !== "function" || typeof list.getBoundingClientRect !== "function") return null;
    return row.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientTop + list.scrollTop;
  }

  function scrollToStartOf(row) {
    const at = startOf(row);
    if (at === null) return false;
    scrollTo(Math.max(0, at - ANSWER_TOP_GAP));
    return true;
  }

  function toEnd() {
    pinned = true;
    scrollTo(list.scrollHeight);
    syncNav();
  }

  function follow() {
    if (!pinned) return;
    if (movedUp()) pinned = false;
    else scrollTo(list.scrollHeight);
  }

  /** A final reply was applied. Only a visitor who is following the end is moved. */
  function answerDone() {
    if (pinned && movedUp()) pinned = false;
    if (pinned) {
      const answer = newestAnswer();
      const height = answer && typeof answer.getBoundingClientRect === "function" ? answer.getBoundingClientRect().height : 0;
      if (list.clientHeight > 0 && height + ANSWER_TOP_GAP > list.clientHeight && scrollToStartOf(answer)) pinned = false;
      else scrollTo(list.scrollHeight);
    }
    syncNav();
  }

  /** Run `fn` before the next frame. A resize callback must not change the size it is told about in the same frame. */
  function later(fn) {
    if (typeof view.requestAnimationFrame !== "function") {
      fn();
      return;
    }
    if (frame !== null) return;
    frame = view.requestAnimationFrame(() => {
      frame = null;
      fn();
    });
  }

  function buildNav() {
    if (typeof doc.createElement !== "function" || typeof list.after !== "function") return null;
    const bar = doc.createElement("div");
    bar.id = "history-nav";
    bar.className = "history-nav";
    bar.hidden = true;
    const make = (id, label, action) => {
      const button = doc.createElement("button");
      button.type = "button";
      button.id = id;
      button.textContent = label;
      button.hidden = true;
      button.addEventListener("click", () => {
        action();
        if (typeof list.focus === "function") list.focus({ preventScroll: true });
        syncNav();
      });
      bar.appendChild(button);
      return button;
    };
    const start = make("history-start", HISTORY_START_LABEL, () => {
      const answer = newestAnswer();
      if (answer && scrollToStartOf(answer)) pinned = false;
    });
    const latest = make("history-latest", HISTORY_LATEST_LABEL, toEnd);
    list.after(bar);
    return { bar, start, latest };
  }

  /** Show "Back to start of answer" and "Jump to latest" exactly while they are of use. */
  function syncNav() {
    if (!nav) return;
    const answer = newestAnswer();
    const at = answer && answer === list.lastElementChild ? startOf(answer) : null;
    const awayFromStart = at !== null && at - list.scrollTop < -PIN_SLACK;
    const awayFromEnd = distanceFromEnd() > PIN_SLACK;
    nav.start.hidden = !awayFromStart;
    nav.latest.hidden = !awayFromEnd;
    nav.bar.hidden = !(awayFromStart || awayFromEnd);
  }

  const nav = buildNav();

  const onScroll = () => {
    const up = list.scrollTop < last - 1;
    last = list.scrollTop;
    if (distanceFromEnd() <= PIN_SLACK) pinned = true;
    else if (up) pinned = false;
    syncNav();
  };
  const onSubmit = () => toEnd();
  list.addEventListener("scroll", onScroll, { passive: true });
  // Bubble phase on the form: the chat's own handler (registered earlier) has added the visitor's row by now.
  const form = doc.querySelector("#composer");
  if (form) form.addEventListener("submit", onSubmit);

  const observers = [];
  if (typeof view.MutationObserver === "function") {
    const mutations = new view.MutationObserver(() => {
      follow();
      syncNav();
    });
    mutations.observe(list, { childList: true, subtree: true, characterData: true });
    observers.push(mutations);
  }
  if (typeof view.ResizeObserver === "function") {
    // The card gives the history whatever height is left, so it changes size when the chips do.
    const resizes = new view.ResizeObserver(() => {
      follow();
      later(syncNav);
    });
    resizes.observe(list);
    observers.push(resizes);
  }

  return {
    toEnd,
    answerDone,
    dispose() {
      list.removeEventListener("scroll", onScroll);
      if (form) form.removeEventListener("submit", onSubmit);
      for (const observer of observers) observer.disconnect();
      if (frame !== null && typeof view.cancelAnimationFrame === "function") view.cancelAnimationFrame(frame);
      frame = null;
      if (nav) nav.bar.remove();
    },
  };
}

/**
 * The Atlas controller. It watches the existing chat from the outside: it reads each final
 * assistant reply as text, lights the islands the reply mentions and sends teaser questions
 * through the same composer form. The model is never told that the map exists, and nothing in
 * the chat client, the API or the prompt changes.
 *
 * Progress lives in sessionStorage only: island ids, and short fingerprints (hashes) of the replies already
 * read and of the questions already sent (so an older chat list after a reload is not read twice, and the
 * visitor's own question is not taken for a reply), never transcripts.
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
    layout: doc.querySelector(".atlas-layout"),
    chat: doc.querySelector("#conversation"),
    explore: doc.querySelector("#explore"),
    heroWrap: doc.querySelector(".hero-ask-wrap"),
    heroAsk: doc.querySelector(".hero-ask"),
    heroText: doc.querySelector(".hero-ask-text"),
    heroLabel: doc.querySelector(".hero-ask-label"),
    heroCount: doc.querySelector(".hero-count"),
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
  // Where the page was scrolled to when the last question went out (typed or tapped: both submit the form).
  let sentScrollY = null;
  const history = followHistory(doc);
  let currentView = "map";
  /** Where the window and the map panel were when each view was left, so switching back finds the place again. */
  const viewSpots = { map: null, list: null };
  /** Places a reply lit that are not on screen yet, in the order they were lit; each is brought into view on request. */
  let newPlaces = [];
  /** The places the latest reply lit: the list marks them "new" until the next reply. */
  let lastLit = [];
  let seenTimer = null;
  let nav = null;
  let newButton = null;
  let panHint = null;

  const inspector = createInspector({
    document: doc,
    graph,
    index,
    mount: mounts.inspector,
    onAsk: (id) => ask(id),
    onPath: (key) => map.pinEdge(key),
    // "Show <place>" on the card of a path: read about that end of it. Nothing scrolls and focus stays where it is.
    onShow: (id) => {
      map.select(id);
      inspector.showIsland(id, view);
    },
  });
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
    onAnnounce: (text) => say(text),
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
    return { paused: !status.canSend, notice, waiting: status.reason === "busy" };
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
    const { paused, notice, waiting } = pause();
    map.render(view, { flare, paused, replies: state.replies });
    flare = [];
    list.render(view, { paused, fresh: lastLit, focus: lastLit.length ? lastLit : state.visited.slice(-1) });
    if (mounts.count) renderCount(mounts.count, view);
    if (suggestions) suggestions.render(suggestionPlan(view, { visited: state.visited, index }), { paused });
    inspector.refresh(view, { paused });
    renderHero(paused);
    if (nav) nav.update({ waiting, news: newPlaces.length });
    // The only place a pause is explained. It sits in the heading row: beside the heading where there
    // is room (the row is no taller than the heading, so nothing moves), under it where there is not.
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

  function matches(query) {
    try {
      return typeof win.matchMedia === "function" && win.matchMedia(query).matches;
    } catch {
      return false;
    }
  }

  /** "smooth", or "instant" for a visitor who asked for less motion. */
  const scrollBehavior = () => (matches("(prefers-reduced-motion: reduce)") ? "instant" : "smooth");

  /** Where the sticky site header ends, and where the part of the window the dock leaves free ends (px). */
  const headerBottom = () => {
    const header = doc.querySelector(".site-header");
    return header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
  };
  const windowBottom = () => (nav ? nav.visibleBottom() : win.innerHeight || 0);

  /** The question on the first screen. Before the first answer it asks the first question; after, it only leads back to the map. */
  function renderHero(paused) {
    const { heroAsk: button, heroText: text, heroLabel: label, heroWrap: wrap } = mounts;
    if (!button || !wrap) return;
    const started = view.replies > 0;
    const words = started ? HERO_RESUME : graph.FIRST_SUGGESTION;
    if (text && text.textContent !== words) text.textContent = words;
    const heading = started ? HERO_LABEL_RESUME : HERO_LABEL_START;
    if (label && label.textContent !== heading) label.textContent = heading;
    wrap.setAttribute("data-mode", started ? "resume" : "start");
    // Paused like a chip: still focusable, and it points at the notice. Pressing it then only leads to the Atlas.
    const locked = !started && paused;
    if (locked) {
      button.setAttribute("aria-disabled", "true");
      button.setAttribute("aria-describedby", "atlas-notice");
    } else {
      button.removeAttribute("aria-disabled");
      button.removeAttribute("aria-describedby");
    }
    if (mounts.heroCount) renderCount(mounts.heroCount, view);
  }

  /** Bring the Atlas section to the top of the window (what the "Explore the design" link does, for a button). */
  function goToAtlas() {
    const target = mounts.explore;
    if (target && typeof target.scrollIntoView === "function") {
      try {
        target.scrollIntoView({ block: "start", behavior: scrollBehavior() });
      } catch {
        target.scrollIntoView(true);
      }
    }
  }

  function pressHero() {
    const button = mounts.heroAsk;
    if (view.replies === 0 && button && button.getAttribute("aria-disabled") !== "true") send(graph.FIRST_SUGGESTION);
    goToAtlas();
  }

  /** Whether a place the visitor was told about is on screen: inside the window (above the dock) and inside the map panel. */
  function placeOnScreen(id) {
    const rect = currentView === "list" ? list.box(id) : map.box(id);
    if (!rect || (rect.width === 0 && rect.height === 0)) return false;
    if (rect.top < headerBottom() || rect.bottom > windowBottom()) return false;
    if (currentView === "map") {
      const panel = mounts.map.getBoundingClientRect();
      return rect.left >= panel.left - 1 && rect.right <= panel.right + 1;
    }
    return true;
  }

  /** The "new places" buttons (the toolbar's and the dock's) follow the places that are lit but not yet seen. */
  function syncNews() {
    if (newButton) {
      const words = dockLabels({ news: newPlaces.length }).news;
      // A button that goes away under the keyboard hands focus to the view switch beside it.
      if (words === "" && doc.activeElement === newButton) (currentView === "list" ? mounts.listButton : mounts.mapButton)?.focus({ preventScroll: true });
      newButton.hidden = words === "";
      if (newButton.textContent !== words) newButton.textContent = words;
    }
    if (nav) nav.update({ news: newPlaces.length });
  }

  /** Keyboard focus to the map (its roving place) or, in the list, to the first row on screen. Nothing scrolls. */
  function focusMapArea() {
    if (currentView === "map") {
      const id = map.inspected() || map.roving();
      if (id) map.focusIsland(id, { preventScroll: true });
      return;
    }
    const top = headerBottom();
    const bottom = windowBottom();
    for (const row of mounts.list.querySelectorAll(".atlas-list-item")) {
      const rect = row.getBoundingClientRect();
      if (rect.height > 0 && rect.top >= top && rect.bottom <= bottom) {
        row.focus({ preventScroll: true });
        return;
      }
    }
  }

  function checkSeen() {
    seenTimer = null;
    if (!newPlaces.length) return;
    const rest = newPlaces.filter((id) => !placeOnScreen(id));
    if (rest.length === newPlaces.length) return;
    newPlaces = rest;
    syncNews();
  }

  function scheduleSeen() {
    if (!newPlaces.length || seenTimer !== null) return;
    seenTimer = timers.set(checkSeen, SEEN_CHECK_MS);
  }

  /** Bring the next place a reply lit into view. Only the window and the map panel move: focus stays where it is. */
  function showNew() {
    const id = newPlaces[0];
    if (!id) return;
    const behavior = scrollBehavior();
    if (currentView === "list") list.reveal(id, { behavior });
    else map.reveal(id, { behavior, vertical: true });
    newPlaces = newPlaces.slice(1);
    syncNews();
    say(`Showing ${(index.byId.get(id) || { name: id }).name}.`);
  }

  /** The place the dock goes back to when nothing was remembered: what the visitor looked at last, else the newest place. */
  function revealRelevant() {
    const id = map.inspected() || state.visited[state.visited.length - 1] || graph.START_ID;
    const behavior = scrollBehavior();
    if (currentView === "list") return list.reveal(id, { behavior });
    return map.reveal(id, { behavior, vertical: true });
  }

  /**
   * After a reply, show where the map lit up: the map panel scrolls sideways to the first place
   * the reply lit (the map is wider than the panel on a phone), and, in the one-column layout, the
   * page scrolls to it unless the visitor is looking at the conversation card (they are reading the
   * answer) or has scrolled away from the map while waiting (see mapStillWanted); either way they
   * keep their place. Instant under reduced motion, smooth otherwise. Focus never moves.
   * @param {string[]} fresh the places the reply lit for the first time, in graph order
   * @returns {boolean} whether that first place is now on screen (or on its way): when it is not, the
   *   visitor is offered a "Show new places" button instead
   */
  function showLit(fresh) {
    if (!fresh.length || mounts.map.hidden) return false;
    const behavior = scrollBehavior();
    const viewHeight = win.innerHeight || 0;
    const chat = doc.querySelector("#conversation");
    const reading = conversationInView(chat ? chat.getBoundingClientRect() : null, viewHeight);
    const atlasCard = doc.querySelector("#atlas");
    const around = mapStillWanted(atlasCard ? atlasCard.getBoundingClientRect() : null, viewHeight, win.scrollY, sentScrollY);
    const vertical = !matches(TWO_COLUMNS_QUERY) && !reading && around;
    const before = map.box(fresh[0]);
    map.reveal(fresh[0], { behavior, vertical });
    return vertical || Boolean(before && before.top >= headerBottom() && before.bottom <= windowBottom());
  }

  /** @param {string} text the final assistant reply */
  function applyReply(text) {
    const ids = matchReply(text, glossary);
    const before = new Set(state.visited);
    state = reduceAtlas(state, { type: "reply", ids }, index);
    flare = ids.filter((id) => !before.has(id));
    const fresh = flare.slice();
    const lit = flare.map((id) => (index.byId.get(id) || { name: id }).name);
    persistAtlas(storage, state);
    lastLit = fresh;
    render();
    history.answerDone();
    const brought = showLit(fresh);
    // Places the reply lit that the visitor cannot see (they are reading the answer, or the list is open) wait
    // behind a button; they never move the window by themselves.
    newPlaces = [...newPlaces.filter((id) => !fresh.includes(id)), ...(brought ? [] : fresh)];
    syncNews();
    if (nav) nav.answerArrived();
    scheduleSeen();
    say(describeLit(lit, view.visitedCount, view.total));
    return ids;
  }

  function reset() {
    state = reduceAtlas(state, { type: "reset" }, index);
    flare = [];
    lastLit = [];
    newPlaces = [];
    viewSpots.map = null;
    viewSpots.list = null;
    persistAtlas(storage, state);
    inspector.showIsland(null, deriveView(state, index));
    if (nav) nav.forget();
    syncNews();
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
    currentView = showMap ? "map" : "list";
    mounts.map.hidden = !showMap;
    mounts.list.hidden = showMap;
    mounts.mapButton?.setAttribute("aria-pressed", String(showMap));
    mounts.listButton?.setAttribute("aria-pressed", String(!showMap));
    if (panHint) panHint.hidden = !showMap;
    if (nav) nav.refresh();
  }

  /** The visitor pressed Map or List: each view keeps the place the window was at when it was left. */
  function switchView(which) {
    const next = which === "list" ? "list" : "map";
    if (next === currentView) return;
    viewSpots[currentView] = { y: win.scrollY, left: mounts.map.scrollLeft };
    showView(next);
    const back = viewSpots[next];
    if (back) {
      if (next === "map") mounts.map.scrollLeft = back.left;
      win.scrollTo({ top: back.y, behavior: "instant" });
    } else if (mounts.toolbar && !mounts.toolbar.hidden) {
      // First time here: the toolbar (and so the top of the view) must not be left above the window.
      const gap = mounts.toolbar.getBoundingClientRect().top - headerBottom();
      if (gap < 0) win.scrollTo({ top: win.scrollY + gap - 8, behavior: "instant" });
    }
    scheduleSeen();
  }

  mounts.mapButton?.addEventListener("click", () => switchView("map"));
  mounts.listButton?.addEventListener("click", () => switchView("list"));
  mounts.heroAsk?.addEventListener("click", pressHero);
  win.addEventListener("scroll", scheduleSeen, { passive: true });
  mounts.map.addEventListener("scroll", scheduleSeen, { passive: true });
  if (mounts.toolbar && mounts.count) {
    newButton = doc.createElement("button");
    newButton.type = "button";
    newButton.className = "atlas-new-places";
    newButton.hidden = true;
    newButton.addEventListener("click", showNew);
    mounts.toolbar.insertBefore(newButton, mounts.count.nextSibling);
  }
  // The map is wider than a phone (and a narrow window): say so, and name the way round it.
  if (mounts.toolbar) {
    panHint = doc.createElement("p");
    panHint.className = "atlas-pan-hint";
    panHint.textContent = "The map is wider than the screen: scroll it sideways, or switch to List.";
    panHint.hidden = currentView !== "map";
    mounts.toolbar.appendChild(panHint);
  }
  if (mounts.layout && mounts.chat) {
    nav = createAtlasNav({
      document: doc,
      mount: mounts.layout,
      chat: mounts.chat,
      card: doc.querySelector("#atlas"),
      mapArea: () => (currentView === "list" ? mounts.list : mounts.map),
      hooks: {
        view: () => currentView,
        showView,
        panelLeft: () => mounts.map.scrollLeft,
        setPanelLeft: (left) => {
          mounts.map.scrollLeft = left;
        },
        reveal: revealRelevant,
        showNew,
        answerStart: () => {
          const rows = doc.querySelector("#history");
          return rows && rows.getBoundingClientRect().height > 0 ? rows : null;
        },
        focusMap: focusMapArea,
        focusAnswer: () => {
          const rows = doc.querySelector("#history");
          if (rows && rows.getBoundingClientRect().height > 0 && typeof rows.focus === "function") rows.focus({ preventScroll: true });
        },
      },
      behavior: scrollBehavior,
      setTimer,
      clearTimer,
    });
  }
  mounts.resetButton?.addEventListener("click", pressClear);
  mounts.resetButton?.addEventListener("blur", () => {
    if (confirming) setConfirming(false);
  });
  doc.querySelector("#draft")?.addEventListener("input", () => render());
  doc.querySelector("#composer")?.addEventListener("submit", () => {
    sentScrollY = Number.isFinite(win.scrollY) ? win.scrollY : null;
  });

  bridge = createChatBridge({
    port: port || createDomPort(doc),
    now,
    setTimer,
    clearTimer,
    storage,
    onReply: applyReply,
    onChange: () => render(),
  });

  // Everything that describes the map, the chips or the chat stays hidden until this script runs,
  // so a visitor without JavaScript sees the honesty note and the plain index only.
  if (mounts.toolbar) mounts.toolbar.hidden = false;
  if (mounts.notice) mounts.notice.hidden = false;
  for (const el of doc.querySelectorAll(".atlas-intro, .atlas-legend, .hero-cta-note, .hero-ask-wrap, .atlas-to-chat")) el.hidden = false;
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
    newPlaces: () => newPlaces.slice(),
    glossaryProblems: () => glossary.rejected.slice(),
    dispose() {
      if (bridge) bridge.dispose();
      history.dispose();
      if (nav) nav.dispose();
      win.removeEventListener("scroll", scheduleSeen);
      if (seenTimer !== null) timers.clear(seenTimer);
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
