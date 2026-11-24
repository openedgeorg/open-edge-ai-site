/**
 * Moving about the Atlas on a phone: the dock.
 *
 * In the one-column layout the map (or the list) and the conversation lie a screen or more apart, and
 * a question asked on one is answered on the other. The dock is a bar that stays at the bottom of the
 * window for as long as the Atlas is on screen, with a switch between the two:
 *
 * - "Map" (or "List") returns to the place the visitor was looking at, not to the section heading: the
 *   window's position, the map panel's sideways position and the view are remembered where the window came
 *   to rest with the map in it (a window still moving is on its way somewhere), and put back;
 * - "Conversation" goes to the answer (the start of the history), says "waiting" while a question runs
 *   and "new answer" when one arrived while the visitor was elsewhere;
 * - "New places" appears when a reply lit places that are not on screen, and brings the first of them into
 *   view. Nothing here moves keyboard focus except the visitor's own press on a button of the dock: "Map"
 *   and "Conversation" take the keyboard along (focus goes to the map or the history, without scrolling), since
 *   the dock is the last thing on the page and Tab would otherwise have to walk all the way back.
 *
 * The dock is the last item of the layout and sticks to the bottom edge (see atlas-panel.css), so it needs no
 * observer to appear and disappear and never covers the end of the page. It is built here, so a page without
 * JavaScript has none. While a text field of the conversation has focus (the on-screen keyboard is up) it steps
 * out of the way, so it never covers the composer.
 *
 * The geometry (readerPlace, dockLabels) is plain functions, so node can test it.
 */

/** The dock is shown while the page is one column; the same query atlas.js and atlas-panel.css use. */
export const DOCK_QUERY = "(max-width: 1179px)";
/** At least this much of the map or the conversation (px) must be on screen to count as "being looked at". */
export const PLACE_MIN_PX = 120;
/** A place is only remembered when this much of the map area is on screen (px, or a third of the window if smaller). */
export const SPOT_MIN_PX = 240;
/** The window has come to rest when no scroll event has come for this long (ms): only a resting place is remembered. */
export const SCROLL_IDLE_MS = 200;

/**
 * How many pixels of a box lie between two heights of the window.
 * @param {{top: number, bottom: number}|null} box
 * @param {number} top
 * @param {number} bottom
 */
export function overlapPx(box, top, bottom) {
  if (!box) return 0;
  return Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top));
}

/**
 * Which part of the page the visitor is looking at: "map" (the map or list area), "answer" (the conversation)
 * or "elsewhere". Whichever shows more of itself wins, provided it shows at least PLACE_MIN_PX.
 * @param {{top: number, bottom: number}|null} mapBox the visible one of the map and the list
 * @param {{top: number, bottom: number}|null} chatBox the conversation card
 * @param {{top?: number, height: number}} view the window: where the sticky header ends, and its height
 */
export function readerPlace(mapBox, chatBox, { top = 0, height }) {
  const onMap = overlapPx(mapBox, top, height);
  const onChat = overlapPx(chatBox, top, height);
  if (onChat >= PLACE_MIN_PX && onChat >= onMap) return "answer";
  if (onMap >= PLACE_MIN_PX) return "map";
  return "elsewhere";
}

/**
 * Whether the visitor looks at enough of the map area for the place to be worth remembering.
 * @param {{top: number, bottom: number}|null} mapBox
 * @param {{top?: number, height: number}} view
 */
export function worthRemembering(mapBox, { top = 0, height }) {
  return overlapPx(mapBox, top, height) >= Math.min(SPOT_MIN_PX, (height - top) / 3);
}

/**
 * The words on the dock.
 * @param {{waiting?: boolean, unread?: boolean, news?: number, view?: string}} state
 * @returns {{map: string, answer: string, note: string, news: string}}
 */
export function dockLabels({ waiting = false, unread = false, news = 0, view = "map" } = {}) {
  const count = Number.isFinite(news) && news > 0 ? Math.floor(news) : 0;
  return {
    map: view === "list" ? "List" : "Map",
    answer: "Conversation",
    // What is going on now comes first: a question that runs says so even while an earlier answer is unread.
    note: waiting ? "waiting…" : unread ? "new answer" : "",
    news: count === 0 ? "" : count === 1 ? "Show 1 new place" : `Show ${count} new places`,
  };
}

function make(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {object} options
 * @param {Document} options.document
 * @param {HTMLElement} options.mount the layout the dock is appended to (its last item)
 * @param {HTMLElement} options.chat the conversation card
 * @param {HTMLElement|null} [options.card] the Atlas card: being in it counts as being at the map
 * @param {() => HTMLElement|null} options.mapArea the map panel or the list, whichever is shown
 * @param {object} options.hooks what the dock asks of the Atlas
 * @param {() => string} options.hooks.view "map" | "list"
 * @param {(which: string) => void} options.hooks.showView switch the view without touching the scroll position
 * @param {() => number} options.hooks.panelLeft the map panel's sideways scroll
 * @param {(left: number) => void} options.hooks.setPanelLeft
 * @param {() => boolean} options.hooks.reveal bring the most relevant place into view (no place remembered yet); true if it did
 * @param {() => void} options.hooks.showNew bring the first new place into view
 * @param {() => HTMLElement|null} options.hooks.answerStart the element whose top is the start of the conversation to read
 * @param {() => void} options.hooks.focusMap move keyboard focus to the map or the list, without scrolling
 * @param {() => void} options.hooks.focusAnswer move keyboard focus to the history, without scrolling
 * @param {() => string} [options.behavior] "smooth" | "instant" | "auto" for the scrolls the dock makes
 * @param {(fn: () => void, ms: number) => any} [options.setTimer]
 * @param {(handle: any) => void} [options.clearTimer]
 */
export function createAtlasNav({ document: doc, mount, chat, card = null, mapArea, hooks, behavior = () => "auto", setTimer, clearTimer }) {
  const win = doc.defaultView || globalThis;
  const timers = {
    set: setTimer || ((fn, ms) => setTimeout(fn, ms)),
    clear: clearTimer || ((handle) => clearTimeout(handle)),
  };

  const dock = make(doc, "nav", "atlas-dock");
  dock.setAttribute("aria-label", "Move between the map and the conversation");
  const mapButton = make(doc, "button", "atlas-dock-button atlas-dock-map", "Map");
  const answerButton = make(doc, "button", "atlas-dock-button atlas-dock-answer");
  const answerLabel = make(doc, "span", "atlas-dock-label", "Conversation");
  const answerNote = make(doc, "span", "atlas-dock-note", "");
  answerNote.hidden = true;
  answerButton.append(answerLabel, answerNote);
  const newButton = make(doc, "button", "atlas-dock-button atlas-dock-new", "");
  newButton.hidden = true;
  for (const button of [mapButton, answerButton, newButton]) button.type = "button";
  dock.append(mapButton, answerButton, newButton);
  mount.appendChild(dock);

  let state = { waiting: false, unread: false, news: 0, place: "elsewhere" };
  /** Where the window last came to rest with the map in it: { y, left, view }. */
  let spot = null;
  /** Where the window last came to rest with the conversation in it: { y }. */
  let chatSpot = null;
  let idleTimer = null;
  let frame = null;

  const matches = () => {
    try {
      return typeof win.matchMedia === "function" && win.matchMedia(DOCK_QUERY).matches;
    } catch {
      return false;
    }
  };

  const headerBottom = () => {
    const header = doc.querySelector(".site-header");
    return header && typeof header.getBoundingClientRect === "function" ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
  };

  /** The window's height not covered by the dock, which sits on its bottom edge while the Atlas is on screen. */
  function viewHeight() {
    const height = win.innerHeight || 0;
    if (typeof dock.getBoundingClientRect !== "function") return height;
    const box = dock.getBoundingClientRect();
    return box.height > 0 && box.top < height && box.bottom >= height - 1 ? box.top : height;
  }

  function measure() {
    const area = mapArea();
    const boxOf = (node) => (node && typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null);
    const mapBox = boxOf(area);
    const view = { top: headerBottom(), height: viewHeight() };
    const place = readerPlace(boxOf(card) || mapBox, chat.getBoundingClientRect(), view);
    // Only a window that shows the map or the list itself leaves a place worth coming back to.
    return { place, remember: place === "map" && worthRemembering(mapBox, view) };
  }

  function paint() {
    const labels = dockLabels({ ...state, view: hooks.view() });
    if (mapButton.textContent !== labels.map) mapButton.textContent = labels.map;
    if (answerNote.textContent !== labels.note) answerNote.textContent = labels.note;
    answerNote.hidden = labels.note === "";
    answerButton.classList.toggle("has-news", state.unread && !state.waiting);
    answerButton.classList.toggle("is-waiting", state.waiting);
    // A button that goes away under the keyboard hands focus to its neighbour.
    if (labels.news === "" && doc.activeElement === newButton) mapButton.focus({ preventScroll: true });
    newButton.hidden = labels.news === "";
    if (newButton.textContent !== labels.news) newButton.textContent = labels.news;
    for (const [button, place] of [[mapButton, "map"], [answerButton, "answer"]]) {
      if (state.place === place) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  }

  /**
   * Read the window: where the visitor is now, and, when it has come to rest (`settled`), the place to
   * go back to.
   * @param {boolean} settled
   */
  function record(settled) {
    if (!matches()) return;
    const now = measure();
    state = { ...state, place: now.place };
    if (now.place === "answer" && state.unread) state = { ...state, unread: false };
    if (settled) {
      if (now.place === "map" && now.remember) spot = { y: win.scrollY, left: hooks.panelLeft(), view: hooks.view() };
      else if (now.place === "answer") chatSpot = { y: win.scrollY };
    }
    paint();
  }

  function onFrame() {
    frame = null;
    record(false);
  }

  function schedule() {
    if (frame !== null) return;
    if (typeof win.requestAnimationFrame === "function") frame = win.requestAnimationFrame(onFrame);
    else frame = timers.set(onFrame, 50);
  }

  function onScroll() {
    schedule();
    if (idleTimer !== null) timers.clear(idleTimer);
    idleTimer = timers.set(() => {
      idleTimer = null;
      record(true);
    }, SCROLL_IDLE_MS);
  }

  function scrollWindow(top) {
    const how = behavior();
    try {
      win.scrollTo({ top, behavior: how });
    } catch {
      win.scrollTo(0, top);
    }
  }

  function goMap() {
    const target = spot;
    if (target) {
      if (hooks.view() !== target.view) hooks.showView(target.view);
      hooks.setPanelLeft(target.left);
      scrollWindow(target.y);
    } else if (!hooks.reveal()) {
      scrollWindow(Math.max(0, mapAreaTop() - headerBottom() - 16));
    }
    hooks.focusMap();
  }

  function mapAreaTop() {
    const area = mapArea();
    return area && typeof area.getBoundingClientRect === "function" ? area.getBoundingClientRect().top + win.scrollY : 0;
  }

  function goAnswer() {
    // Remember where the map was before the window moves.
    const now = measure();
    if (now.place === "map" && now.remember) spot = { y: win.scrollY, left: hooks.panelLeft(), view: hooks.view() };
    // A new or pending answer is read from its start; otherwise the visitor goes back to where they were reading.
    if (state.unread || state.waiting || !chatSpot) {
      const start = hooks.answerStart() || chat;
      scrollWindow(Math.max(0, start.getBoundingClientRect().top + win.scrollY - headerBottom() - 12));
    } else {
      scrollWindow(chatSpot.y);
    }
    state = { ...state, unread: false, place: "answer" };
    paint();
    // The visitor asked to go there: their keyboard goes with them.
    hooks.focusAnswer();
  }

  mapButton.addEventListener("click", goMap);
  answerButton.addEventListener("click", goAnswer);
  newButton.addEventListener("click", () => hooks.showNew());

  // The on-screen keyboard: while a text field of the conversation has focus the dock steps aside.
  const isField = (node) => Boolean(node && node.tagName && /^(TEXTAREA|INPUT|SELECT)$/.test(node.tagName));
  const onFocusIn = (event) => {
    if (isField(event.target) && chat.contains(event.target)) dock.classList.add("is-tucked");
  };
  const onFocusOut = (event) => {
    if (isField(event.target)) dock.classList.remove("is-tucked");
  };
  chat.addEventListener("focusin", onFocusIn);
  chat.addEventListener("focusout", onFocusOut);

  win.addEventListener("scroll", onScroll, { passive: true });
  win.addEventListener("resize", onScroll, { passive: true });
  const panel = mapArea();
  if (panel && panel.addEventListener) panel.addEventListener("scroll", onScroll, { passive: true });

  paint();
  schedule();
  idleTimer = timers.set(() => {
    idleTimer = null;
    record(true);
  }, SCROLL_IDLE_MS);

  return {
    element: dock,
    /**
     * @param {{waiting?: boolean, news?: number}} next
     */
    update(next = {}) {
      const waiting = next.waiting === undefined ? state.waiting : Boolean(next.waiting);
      const news = next.news === undefined ? state.news : next.news;
      if (waiting === state.waiting && news === state.news) {
        paint();
        return;
      }
      state = { ...state, waiting, news };
      paint();
    },
    /** A final reply arrived: it is "new" unless the visitor is reading the conversation right now. */
    answerArrived() {
      record(false);
      if (state.place !== "answer") state = { ...state, unread: true };
      paint();
    },
    /** The map area changed (the view was switched): re-read the window. */
    refresh: onScroll,
    /** The bottom of the part of the window the dock leaves free (px). */
    visibleBottom: viewHeight,
    /** Forget everything remembered (Clear map). */
    forget() {
      spot = null;
      chatSpot = null;
      state = { ...state, unread: false, news: 0 };
      paint();
    },
    spot: () => (spot ? { ...spot } : null),
    place: () => state.place,
    dispose() {
      win.removeEventListener("scroll", onScroll);
      win.removeEventListener("resize", onScroll);
      chat.removeEventListener("focusin", onFocusIn);
      chat.removeEventListener("focusout", onFocusOut);
      if (panel && panel.removeEventListener) panel.removeEventListener("scroll", onScroll);
      if (idleTimer !== null) timers.clear(idleTimer);
      dock.remove();
    },
  };
}
