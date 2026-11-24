/**
 * Atlas chat bridge.
 *
 * The Atlas never changes the existing chat (app.js). It only observes the DOM that app.js
 * paints (#phase, #history, #draft) and submits through the existing #composer form.
 *
 * - createDomPort(doc) adapts the real page to a small port interface that tests can fake.
 * - createChatBridge({ port, ... }) turns the port into "can a suggestion be sent right now"
 *   plus a one-shot "the assistant's final reply arrived" notification.
 *
 * Text read from the page is only ever read with .textContent. Nothing here parses HTML.
 *
 * Reliability notes (the chat paints from the outside, so the bridge has to be forgiving):
 * - The usual signal for "the final reply is here" is #phase going from a busy phase to `ready`.
 *   The chat can paint `ready` too early (the message box got focus while it still polls
 *   /history, or /history returned an older snapshot). When that transition yields nothing new
 *   the bridge keeps a `late` record and watches #history; once the list has been quiet for a
 *   moment it looks again and delivers the reply, once.
 * - A reply is tied to its question. The bridge remembers the text that was submitted and, whenever
 *   it looks for the reply, takes the rows with text AFTER the last row that equals that text, up to
 *   (not including) the first row that is an echo of a question the visitor submitted. The chat's
 *   history can hold one turn as several rows (a preamble, then the answer: the adapter starts a new
 *   history item whenever the message id changes), so those rows are delivered together, joined by a
 *   blank line (each row is a paragraph of its own to the matcher, so the end of one row and the start
 *   of the next never make a phrase: F43); a row that is an echo, and anything after it, belongs to a
 *   later turn. If the question is not in the list (a reload, or the chat showing an older snapshot)
 *   there is nothing to deliver yet and the bridge keeps waiting. A row is never taken merely because
 *   it is the last one.
 * - The chat paints more phases than ready/running: `cancelling` is busy; `failed` and `cancelled` are
 *   outcomes of a question that has NO reply (suggestions work again, nothing is delivered, and a failure says
 *   "the last question did not go through"); `unresolved` means the chat could not confirm what became of the
 *   question (it is not sent again), so suggestions wait and the question stays awaited: if it is resolved later
 *   its reply is still delivered. A row the chat marks `data-role="error"` is a message about a problem, never a reply.
 * - A reply that arrives after a reload (the chat shows `reconciling` again and then `ready`) has no `awaiting`
 *   in memory. It is delivered from the rows after the last question this tab ever submitted (the stored
 *   fingerprints), once, unless its key was delivered before.
 * - A delivered reply is remembered as `${position of its first row}:${hash of its squashed text}`, so an
 *   identical canned answer in a later turn still counts while a second read of the very same list does not.
 * - That memory also lives in sessionStorage (SEEN_KEY, passed in as `storage`), because a reload
 *   empties the page's memory while the chat can still show an OLDER list: Clear map, then the same
 *   first suggestion again, and the chat's /history still says [Q1, A1]. Without the memory the old
 *   A1 would be taken for the new answer and light its places. The same array also holds a short
 *   fingerprint (`q:` and 8 hex digits) of every question submitted, so after a reload the visitor's own
 *   earlier questions are still recognised as echoes in a stale list such as [T1, Q2, A2]. Only short
 *   hashes are stored, never a reply, a row or a question. Replies and questions are capped SEPARATELY, at
 *   200 entries of each kind (about 6 KB in all), the oldest of a kind dropped first (F44): a turn leaves one
 *   entry of each kind, so a shared cap of 200 would have forgotten turn 1 after 100 turns, and a stale
 *   read of an old list could then hand on a whole old turn.
 */

import { FIRST_SUGGESTION, ISLANDS } from "./atlas-graph.js";

export const SEND_WINDOW_MS = 60000;
export const MAX_SENDS_PER_WINDOW = 20;
export const REJECT_PAUSE_MS = 30000;
/**
 * A run that did show a busy phase but never came back (the chat stopped painting) must not
 * block suggestions forever. After this long without a busy phase the bridge stops waiting.
 * Also the longest the bridge keeps watching for a late reply after the chat painted `ready`.
 */
export const STALE_SUBMIT_MS = 120000;
/**
 * A submit that never shows ANY busy phase (for example the request failed before the chat
 * painted anything) is dropped after this long: suggestions work again and the status says the
 * last question did not go through.
 */
export const NO_PROGRESS_MS = 15000;
/** An empty #phase (the chat never booted) is reported as unavailable after this long. */
export const START_GIVE_UP_MS = 10000;
/** A late reply is delivered only after #history has been quiet for this long (a stream may still be growing). */
export const LATE_SETTLE_MS = 1500;

const BUSY_PHASES = new Set(["submitting", "running", "reconciling", "recovering", "cancelling"]);
/** Phases in which the last question has no reply and nothing is going on: suggestions work again. */
const FAILED_PHASES = new Set(["failed", "cancelled"]);
/** The chat could not confirm what became of the last question. It is neither busy nor settled. */
const UNRESOLVED_PHASE = "unresolved";
/**
 * The most entries the stored memory holds of EACH kind (reply keys, and `q:` question keys); the
 * oldest of a kind goes first. A turn adds one of each, so this is also the number of turns the
 * bridge can recognise a stale read of.
 */
const SEEN_LIMIT = 200;
const ECHO_LIMIT = 100;
/**
 * The sessionStorage key of the memory: one JSON array of fingerprints, oldest first. A delivered
 * reply is `${position}:${8 hex digits}`, a submitted question is `q:${8 hex digits}`.
 */
export const SEEN_KEY = "esp-atlas-seen";
/** What one stored entry must look like (a reply, or a question); anything else in the array is ignored. */
const SEEN_REPLY_ENTRY = /^\d{1,9}:[0-9a-f]{8}$/;
const SEEN_QUESTION_ENTRY = /^q:[0-9a-f]{8}$/;
/** A stored value longer than this is not even parsed (the full 400 entries need about 6 KB). */
const SEEN_MAX_CHARS = 65536;

const MESSAGES = {
  starting: "The chat is still starting.",
  busy: "The chat is busy with a question.",
  draft: "The message box has text. Send it or clear it to use a suggestion.",
  rejected: "The chat asked for a pause. Suggestions will be back shortly.",
  rate: "You are sending quickly. Suggestions will be back shortly.",
  unavailable: "The chat is not available right now.",
  noprogress: "The last question did not go through.",
  unresolved: "The chat is still checking on your last question.",
};

function normPhase(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function squash(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

/**
 * Whether `plain` (already squashed) is the text of one of the Atlas's own suggestions: any island's
 * teaser or the first-load suggestion. Read from the graph on every call, never cached.
 */
function isGraphTeaser(plain) {
  if (plain === "") return false;
  if (typeof FIRST_SUGGESTION === "string" && squash(FIRST_SUGGESTION) === plain) return true;
  if (!Array.isArray(ISLANDS)) return false;
  for (const island of ISLANDS) {
    if (island && typeof island.teaser === "string" && squash(island.teaser) === plain) return true;
  }
  return false;
}

/**
 * FNV-1a, 32 bit, over the UTF-16 code units of `text`, as 8 lowercase hex digits. A short fingerprint,
 * not a secret: it is what the bridge keeps of a delivered reply, so no part of the text is stored.
 * @param {string} text
 */
export function fnv1a32(text) {
  const value = String(text == null ? "" : text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function duration(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Adapt the live page to the bridge's port interface.
 *
 * Selectors: #phase (status line), #draft (textarea), #composer (form), #history (list of
 * li > p rows). Elements are looked up lazily, so a late or missing element never throws.
 *
 * @param {Document} doc
 * @param {{MutationObserver?: Function}} [options] MutationObserver override (tests).
 */
export function createDomPort(doc, options = {}) {
  function find(selector) {
    try {
      return doc && typeof doc.querySelector === "function" ? doc.querySelector(selector) || null : null;
    } catch {
      return null;
    }
  }

  function observerClass() {
    if (options && typeof options.MutationObserver === "function") return options.MutationObserver;
    const view = doc && doc.defaultView;
    if (view && typeof view.MutationObserver === "function") return view.MutationObserver;
    return typeof globalThis.MutationObserver === "function" ? globalThis.MutationObserver : null;
  }

  function readPhase() {
    const element = find("#phase");
    if (!element) return "unavailable";
    return String(element.textContent == null ? "" : element.textContent).trim();
  }

  function readDraft() {
    const element = find("#draft");
    return element && typeof element.value === "string" ? element.value : "";
  }

  /** A row the chat marks as a message about a problem is not part of any reply. */
  function isProblemRow(row) {
    try {
      const item = row && row.parentElement;
      return Boolean(item && typeof item.getAttribute === "function" && item.getAttribute("data-role") === "error");
    } catch {
      return false;
    }
  }

  /** The text of every `#history li > p` row, in order, blank rows included (text only, never markup). */
  function rowTexts() {
    const history = find("#history");
    if (!history) return [];
    try {
      if (typeof history.querySelectorAll !== "function") return [];
      return Array.from(history.querySelectorAll("li > p"))
        .filter((row) => !isProblemRow(row))
        .map((row) => String(row && row.textContent != null ? row.textContent : ""));
    } catch {
      return [];
    }
  }

  /** Every row's text, in order. The bridge ties the reply to the question with this. */
  function rows() {
    return rowTexts();
  }

  /** The last row that has any text. Blank rows are skipped; an echo of the visitor's text is not. */
  function lastReply() {
    const texts = rowTexts();
    for (let i = texts.length - 1; i >= 0; i -= 1) {
      if (squash(texts[i]) !== "") return texts[i];
    }
    return "";
  }

  /** How many rows with text the list has now. */
  function rowCount() {
    return rowTexts().filter((text) => squash(text) !== "").length;
  }

  function submit(text) {
    const draft = find("#draft");
    const form = find("#composer");
    if (!draft || !form) throw new Error("composer unavailable");
    draft.value = String(text);
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else {
      const view = doc && doc.defaultView;
      const EventClass = view && typeof view.Event === "function" ? view.Event : globalThis.Event;
      form.dispatchEvent(new EventClass("submit", { bubbles: true, cancelable: true }));
    }
    // The chat only rewrites the textarea after a run when it is not focused.
    if (doc && doc.activeElement === draft && typeof draft.blur === "function") draft.blur();
  }

  /** Call back (with no arguments) whenever `selector` changes in any way; returns an unsubscribe. */
  function observe(selector, deliver) {
    const element = find(selector);
    const Observer = observerClass();
    if (!element || !Observer) return () => {};
    let live = true;
    const observer = new Observer(() => {
      if (!live) return;
      try {
        deliver();
      } catch {
        /* a failing listener must not break the page's own painting */
      }
    });
    observer.observe(element, { childList: true, characterData: true, subtree: true });
    return () => {
      live = false;
      try {
        observer.disconnect();
      } catch {
        /* already disconnected */
      }
    };
  }

  function onPhase(callback) {
    return observe("#phase", () => callback(readPhase()));
  }

  /** Fires after #history changes (rows added, replaced or edited). The callback gets no data. */
  function onHistory(callback) {
    return observe("#history", () => callback());
  }

  function onSubmit(callback) {
    const form = find("#composer");
    if (!form || typeof form.addEventListener !== "function") return () => {};
    let live = true;
    // Capture phase: runs before the chat's own submit handler, so the draft is still intact.
    const handler = () => {
      if (!live) return;
      try {
        callback(readDraft());
      } catch {
        /* a failing listener must not stop the chat from sending */
      }
    };
    form.addEventListener("submit", handler, true);
    return () => {
      live = false;
      try {
        if (typeof form.removeEventListener === "function") form.removeEventListener("submit", handler, true);
      } catch {
        /* element gone */
      }
    };
  }

  return { readPhase, readDraft, submit, rows, lastReply, rowCount, onPhase, onHistory, onSubmit };
}

/**
 * @typedef {object} ChatStatus
 * @property {boolean} canSend
 * @property {"" | "starting" | "busy" | "draft" | "rejected" | "rate" | "unavailable" | "noprogress" | "unresolved"} reason
 *   "noprogress" is informational: canSend is true again, and `message` says the last question did not go through.
 * @property {string} message
 * @property {number|null} resumeAt epoch ms when a time-based block ends, else null
 */

/**
 * @param {{
 *   port: {readPhase(): string, readDraft(): string, submit(text: string): void,
 *          rows(): string[],
 *          lastReply?(): string, rowCount?(): number,
 *          onPhase(cb: (phase: string) => void): () => void, onSubmit(cb: (text: string) => void): () => void,
 *          onHistory?(cb: () => void): () => void},
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   storage?: Storage | null,
 *   onReply?: (text: string) => void,
 *   onChange?: (status: ChatStatus) => void,
 *   timings?: {staleSubmitMs?: number, noProgressMs?: number, startGiveUpMs?: number, lateSettleMs?: number},
 * }} deps
 * @returns {{status(): ChatStatus, sendTeaser(text: string): {sent: boolean, reason: string}, dispose(): void}}
 */
export function createChatBridge({
  port,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  storage = null,
  onReply,
  onChange,
  timings = {},
} = {}) {
  const staleSubmitMs = duration(timings && timings.staleSubmitMs, STALE_SUBMIT_MS);
  const noProgressMs = duration(timings && timings.noProgressMs, NO_PROGRESS_MS);
  const startGiveUpMs = duration(timings && timings.startGiveUpMs, START_GIVE_UP_MS);
  const lateSettleMs = duration(timings && timings.lateSettleMs, LATE_SETTLE_MS);

  let disposed = false;
  let phase = "";
  const createdAt = now();
  // {text, at, sawBusy}: a submit whose run has not finished yet. `at` is the submit time until a
  // busy phase is seen, then the time of the latest busy phase.
  let awaiting = null;
  // {text, at}: the chat painted `ready` for a submit but no new reply was in the list yet. #history is
  // watched for it until the next submit (or staleSubmitMs). `at` is the time of that ready.
  let late = null;
  // {text, at}: a submit that never showed a busy phase for noProgressMs and was given up on. If a busy
  // phase shows up after all (a very slow acceptance) the run is picked up again.
  let lost = null;
  let rejectUntil = 0;
  let submitEvents = 0;
  // The last teaser this bridge submitted (whitespace squashed), so its own text coming back is not
  // mistaken for something the visitor typed: after a 409/429 the chat puts the refused text back
  // into the message box, and without this the teasers would stay blocked until it was cleared.
  // This is memory only. After a reload the chat can restore that refused text into the box while this
  // is empty again, so a draft equal to ANY suggestion of the graph (isGraphTeaser) counts as the
  // bridge's own text too. Text the visitor typed is neither, and still blocks.
  let ownText = "";
  let sendingTeaser = false;
  let timer = null;
  let timerSet = false;
  let lateTimer = null;
  let lateTimerSet = false;
  const sends = []; // submit timestamps inside the rate window, ascending
  // The fingerprints this bridge keeps, oldest first (see SEEN_KEY): `${position}:${fnv1a32 of the squashed
  // text}` of every reply handed to onReply (the position is the index of the reply's first row among the
  // rows that have text), and `q:${fnv1a32 of the squashed text}` of every question submitted. Seeded from
  // storage when the bridge is created and written back after each change.
  const seen = new Set();
  const kept = { reply: { count: 0 }, question: { count: 0 } }; // how many of each kind `seen` holds (SEEN_LIMIT applies to each)
  const echoes = new Set(); // squashed text of every submit of this page: a row equal to one is the visitor's echo
  const unsubscribers = [];

  function readPhase() {
    try {
      return normPhase(port.readPhase());
    } catch {
      return "unavailable";
    }
  }

  function settle(t) {
    while (sends.length && sends[0] <= t - SEND_WINDOW_MS) sends.shift();
    if (awaiting && !BUSY_PHASES.has(readPhase()) && readPhase() !== UNRESOLVED_PHASE) {
      if (awaiting.sawBusy) {
        if (t - awaiting.at >= staleSubmitMs) awaiting = null;
      } else if (t - awaiting.at >= noProgressMs) {
        lost = { text: awaiting.text, at: t };
        awaiting = null;
      }
    }
    if (late && t - late.at > staleSubmitMs) {
      late = null;
      cancelLateTimer();
    }
    if (lost && t - lost.at > staleSubmitMs) lost = null;
  }

  function rateResumeAt() {
    if (sends.length < MAX_SENDS_PER_WINDOW) return null;
    return sends[sends.length - MAX_SENDS_PER_WINDOW] + SEND_WINDOW_MS;
  }

  function block(reason, resumeAt = null) {
    return { canSend: false, reason, message: MESSAGES[reason], resumeAt };
  }

  function evaluate() {
    if (disposed) return block("unavailable");
    const t = now();
    settle(t);
    const current = readPhase();
    if (current === "unavailable") return block("unavailable");
    // The chat never painted a phase: it is still booting, or it never will. Say which, honestly.
    if (current === "") return t - createdAt >= startGiveUpMs ? block("unavailable") : block("starting");
    if (current === UNRESOLVED_PHASE) return block("unresolved");
    if (BUSY_PHASES.has(current) || awaiting) return block("busy");
    if (current !== "ready" && current !== "rejected" && !FAILED_PHASES.has(current)) return block("busy");
    const rate = rateResumeAt();
    if (rejectUntil > t) return block("rejected", Math.max(rejectUntil, rate == null ? 0 : rate));
    if (rate != null) return block("rate", rate);
    let draft;
    try {
      draft = port.readDraft();
    } catch {
      return block("unavailable");
    }
    if (typeof draft === "string") {
      const typed = squash(draft);
      if (typed !== "" && typed !== ownText && !isGraphTeaser(typed)) return block("draft");
    }
    if (lost) return { canSend: true, reason: "noprogress", message: MESSAGES.noprogress, resumeAt: null };
    return { canSend: true, reason: "", message: "", resumeAt: null };
  }

  function nextDeadline(t) {
    let deadline = Infinity;
    if (rejectUntil > t) deadline = Math.min(deadline, rejectUntil);
    const rate = rateResumeAt();
    if (rate != null) deadline = Math.min(deadline, rate);
    const current = readPhase();
    if (awaiting && !BUSY_PHASES.has(current) && current !== UNRESOLVED_PHASE) {
      deadline = Math.min(deadline, awaiting.at + (awaiting.sawBusy ? staleSubmitMs : noProgressMs));
    }
    if (current === "" && t - createdAt < startGiveUpMs) deadline = Math.min(deadline, createdAt + startGiveUpMs);
    if (lost) deadline = Math.min(deadline, lost.at + staleSubmitMs + 1);
    return deadline;
  }

  function cancelTimer() {
    if (!timerSet) return;
    const handle = timer;
    timer = null;
    timerSet = false;
    try {
      clearTimer(handle);
    } catch {
      /* timer already gone */
    }
  }

  function cancelLateTimer() {
    if (!lateTimerSet) return;
    const handle = lateTimer;
    lateTimer = null;
    lateTimerSet = false;
    try {
      clearTimer(handle);
    } catch {
      /* timer already gone */
    }
  }

  function schedule() {
    cancelTimer();
    if (disposed) return;
    const t = now();
    settle(t);
    const deadline = nextDeadline(t);
    if (deadline === Infinity) return;
    try {
      timer = setTimer(onTimer, Math.max(0, deadline - t));
      timerSet = true;
    } catch {
      timer = null;
      timerSet = false;
    }
  }

  function notify() {
    if (disposed || typeof onChange !== "function") return;
    try {
      onChange(evaluate());
    } catch {
      /* a failing listener must not break the bridge */
    }
  }

  function changed() {
    schedule();
    notify();
  }

  function onTimer() {
    timer = null;
    timerSet = false;
    if (disposed) return;
    changed();
  }

  /**
   * Add `entry` as the newest (an entry that is already there moves to the end). Past SEEN_LIMIT entries
   * of ITS kind (a reply key, or a `q:` question key) the oldest of that kind go; the other kind is not
   * touched, so a long run of questions never pushes the reply keys out, nor the other way round (F44).
   */
  function remember(entry) {
    const question = entry.startsWith("q:");
    const kind = question ? kept.question : kept.reply;
    if (seen.delete(entry)) kind.count -= 1;
    seen.add(entry);
    kind.count += 1;
    if (kind.count <= SEEN_LIMIT) return;
    for (const old of seen) {
      if (old.startsWith("q:") !== question) continue;
      seen.delete(old);
      kind.count -= 1;
      if (kind.count <= SEEN_LIMIT) break;
    }
  }

  /**
   * Seed `seen` from what an earlier page of this tab stored. Whatever is wrong with the stored
   * value (no storage, a storage that throws, bad JSON, not an array, entries of the wrong shape or
   * size) is ignored: the bridge then simply starts with an empty memory.
   */
  function loadSeen() {
    let raw;
    try {
      if (!storage || typeof storage.getItem !== "function") return;
      raw = storage.getItem(SEEN_KEY);
    } catch {
      return;
    }
    if (typeof raw !== "string" || raw.length === 0 || raw.length > SEEN_MAX_CHARS) return;
    let list;
    try {
      list = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (typeof entry !== "string" || entry.length > 32) continue;
      if (SEEN_REPLY_ENTRY.test(entry) || SEEN_QUESTION_ENTRY.test(entry)) remember(entry);
    }
  }

  /** Write `seen` to storage. Only fingerprints go in; a failure (private mode, quota) keeps the memory-only behaviour. */
  function storeSeen() {
    try {
      if (!storage || typeof storage.setItem !== "function") return;
      storage.setItem(SEEN_KEY, JSON.stringify([...seen]));
    } catch {
      /* storage disabled or full: the memory of this page still works */
    }
  }

  /** The visitor submitted `plain` (squashed): rows with this text are echoes now, also after a reload. */
  function rememberEcho(plain) {
    if (!plain) return;
    echoes.delete(plain);
    echoes.add(plain);
    if (echoes.size > ECHO_LIMIT) echoes.delete(echoes.values().next().value);
    remember(`q:${fnv1a32(plain)}`);
    storeSeen();
  }

  /** Whether the row `plain` (squashed) is the text of a question submitted by this page or, by its fingerprint, an earlier page. */
  function isEcho(plain) {
    return echoes.has(plain) || seen.has(`q:${fnv1a32(plain)}`);
  }

  /**
   * The text of every row of the chat's list, in order, or null when the port cannot show the list
   * (then no reply can be tied to its question and nothing is delivered).
   */
  function readRows() {
    if (typeof port.rows !== "function") return null;
    try {
      const list = port.rows();
      if (!Array.isArray(list)) return null;
      return list.map((row) => (typeof row === "string" ? row : ""));
    } catch {
      return null;
    }
  }

  /**
   * The reply to `submitted`: the rows with text AFTER the last row that equals the submitted text
   * (whitespace squashed), up to the first row that is an echo of a submitted question, joined by a
   * blank line. A turn can be several rows ([Q, preamble, answer]): the xAI adapter starts a new history
   * item whenever the message id changes. With a single row this is that row, as the page shows it.
   * Nothing is returned when
   * - the question is not in the list yet (a reload, or an older snapshot of the list), or it is the
   *   last row (the run is not done), or only blank rows follow it;
   * - the first row after it is an echo of something submitted (the run failed and a question follows
   *   the question). An echo later on ends the reply there: that row and what follows belong to a later turn;
   * - the reply was already handed on (the very same list read again, for a question asked twice, or an
   *   older snapshot of the list that a reload left behind: the memory is kept in sessionStorage).
   * A row is never taken merely because it is the last one in the list. While the list is still growing
   * the late path waits for it to be quiet (see onLateSettled) before it looks here.
   */
  function pickReply(submitted) {
    const question = squash(submitted);
    if (!question) return null;
    const list = readRows();
    if (list === null) return null;
    const rows = [];
    for (const text of list) {
      const plain = squash(text);
      if (plain !== "") rows.push({ text, plain });
    }
    let at = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].plain === question) {
        at = i;
        break;
      }
    }
    if (at < 0) return null;
    const turn = [];
    for (let i = at + 1; i < rows.length; i += 1) {
      if (isEcho(rows[i].plain)) break;
      turn.push(rows[i]);
    }
    if (turn.length === 0) return null;
    // The hash is of the squashed concatenation, so a one-row reply keeps the key it always had.
    const key = `${at + 1}:${fnv1a32(turn.map((row) => row.plain).join(" "))}`;
    if (seen.has(key)) return null;
    remember(key);
    storeSeen();
    // Joined by a blank line: to the matcher each row is a paragraph, so no phrase spans two rows (F43).
    return turn.map((row) => row.text).join("\n\n");
  }

  /**
   * The reply to a question this bridge no longer awaits (the page was reloaded while the chat was still
   * checking on it): the rows after the LAST row that is an echo of a question this tab submitted, up to
   * the end of the list. Nothing when there is no such row, nothing after it, or the reply was handed on already.
   */
  function pickRecovered() {
    const list = readRows();
    if (list === null) return null;
    const rows = [];
    for (const text of list) {
      const plain = squash(text);
      if (plain !== "") rows.push({ text, plain });
    }
    let at = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (isEcho(rows[i].plain)) {
        at = i;
        break;
      }
    }
    if (at < 0) return null;
    const turn = rows.slice(at + 1);
    if (turn.length === 0) return null;
    const key = `${at + 1}:${fnv1a32(turn.map((row) => row.plain).join(" "))}`;
    if (seen.has(key)) return null;
    remember(key);
    storeSeen();
    return turn.map((row) => row.text).join("\n\n");
  }

  function deliver(reply) {
    if (typeof onReply !== "function") return;
    try {
      onReply(reply);
    } catch {
      /* a failing listener must not break the bridge */
    }
  }

  function onSubmitEvent(text) {
    if (disposed) return;
    const t = now();
    submitEvents += 1;
    sends.push(t);
    // A submit that did not come from sendTeaser is the visitor's own: their text is theirs from now on.
    if (!sendingTeaser) ownText = "";
    const body = typeof text === "string" ? text : "";
    rememberEcho(squash(body));
    // A new question closes the books on the previous one.
    late = null;
    lost = null;
    cancelLateTimer();
    awaiting = { text: body, at: t, sawBusy: false };
    changed();
  }

  /** The history changed while a late reply may still be on its way: look again once it is quiet. */
  function armLateWatch() {
    cancelLateTimer();
    if (disposed || !late) return;
    try {
      lateTimer = setTimer(onLateSettled, lateSettleMs);
      lateTimerSet = true;
    } catch {
      lateTimer = null;
      lateTimerSet = false;
    }
  }

  function onHistoryEvent() {
    if (disposed || !late) return;
    if (now() - late.at > staleSubmitMs) {
      late = null;
      cancelLateTimer();
      return;
    }
    if (readPhase() !== "ready") return;
    armLateWatch();
  }

  function onLateSettled() {
    lateTimer = null;
    lateTimerSet = false;
    if (disposed || !late) return;
    if (now() - late.at > staleSubmitMs) {
      late = null;
      return;
    }
    if (readPhase() !== "ready") return;
    // Look again now, not at the first change: a stream that was still growing has finished by here.
    const reply = pickReply(late.text);
    if (reply === null) return; // not there yet: the next change to the list starts another wait
    late = null;
    lost = null;
    deliver(reply);
    changed();
  }

  function onPhaseEvent(value) {
    if (disposed) return;
    const next = typeof value === "string" ? normPhase(value) : readPhase();
    const previous = phase;
    phase = next;
    const t = now();
    let dirty = next !== previous;
    let reply = null;
    if (next === "rejected") {
      // Entering rejected, or a retry that was rejected again: pause suggestions.
      if (previous !== "rejected" || awaiting) {
        rejectUntil = t + REJECT_PAUSE_MS;
        awaiting = null;
        dirty = true;
      }
    } else if (next === "unavailable") {
      if (awaiting) dirty = true;
      awaiting = null;
    } else if (FAILED_PHASES.has(next)) {
      // The question has no reply. A failure is told ("did not go through"); a cancellation is the visitor's own.
      if (awaiting && next === "failed") lost = { text: awaiting.text, at: t };
      awaiting = null;
      late = null;
      cancelLateTimer();
      dirty = true;
    } else if (next === "ready") {
      if (previous !== "ready" && !awaiting && !late && (BUSY_PHASES.has(previous) || previous === UNRESOLVED_PHASE)) {
        reply = pickRecovered();
        if (reply !== null) lost = null;
        dirty = true;
      } else if (previous !== "ready" && awaiting) {
        const submitted = awaiting.text;
        awaiting = null;
        reply = pickReply(submitted);
        // No reply yet although the chat says it is done: keep watching the list for a late one.
        late = reply === null ? { text: submitted, at: t } : null;
        if (reply !== null) lost = null;
        dirty = true;
      } else if (previous !== "ready" && late) {
        armLateWatch();
      }
    } else if (BUSY_PHASES.has(next)) {
      if (awaiting) {
        awaiting.at = t;
        awaiting.sawBusy = true;
      } else if (lost && t - lost.at <= staleSubmitMs) {
        // The acceptance was only slow: this is the run the bridge had given up on.
        awaiting = { text: lost.text, at: t, sawBusy: true };
        lost = null;
        dirty = true;
      }
    }
    if (reply !== null) deliver(reply);
    if (dirty) changed();
    else schedule();
  }

  function subscribe(register, handler) {
    try {
      const off = register(handler);
      if (typeof off === "function") unsubscribers.push(off);
    } catch {
      /* the port cannot observe this: the bridge degrades to polling status() */
    }
  }

  loadSeen();
  phase = readPhase();
  if (phase === "rejected") rejectUntil = now() + REJECT_PAUSE_MS;
  subscribe((handler) => port.onPhase(handler), onPhaseEvent);
  subscribe((handler) => port.onSubmit(handler), onSubmitEvent);
  // Optional: a port without it simply never catches a late reply.
  subscribe((handler) => (typeof port.onHistory === "function" ? port.onHistory(handler) : undefined), onHistoryEvent);
  schedule();

  return {
    status() {
      try {
        return evaluate();
      } catch {
        return block("unavailable");
      }
    },

    sendTeaser(text) {
      if (disposed) return { sent: false, reason: "unavailable" };
      let current;
      try {
        current = evaluate();
      } catch {
        return { sent: false, reason: "unavailable" };
      }
      if (!current.canSend) return { sent: false, reason: current.reason };
      const body = typeof text === "string" ? text.trim() : "";
      if (!body) return { sent: false, reason: "empty" };
      const before = submitEvents;
      const previousOwn = ownText;
      ownText = squash(body);
      sendingTeaser = true;
      try {
        try {
          port.submit(body);
        } catch {
          if (submitEvents === before) {
            ownText = previousOwn;
            return { sent: false, reason: "unavailable" };
          }
        }
        // The port normally reports its own submit through onSubmit. If it did not, count it here
        // so a second tap is still refused as busy.
        if (submitEvents === before) onSubmitEvent(body);
      } finally {
        sendingTeaser = false;
      }
      return { sent: true, reason: "" };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of unsubscribers.splice(0)) {
        try {
          off();
        } catch {
          /* already unsubscribed */
        }
      }
      cancelTimer();
      cancelLateTimer();
      awaiting = null;
      late = null;
      lost = null;
      sends.length = 0;
    },
  };
}
