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
 * - A reply is remembered as `${rows}:${text}`, so an identical canned answer in a later turn
 *   still counts while a second read of the very same list does not.
 */

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

const BUSY_PHASES = new Set(["submitting", "running", "reconciling", "recovering"]);
const DELIVERED_LIMIT = 200;
const ECHO_LIMIT = 100;

const MESSAGES = {
  starting: "The chat is still starting.",
  busy: "The chat is busy with a question.",
  draft: "The message box has text. Send it or clear it to use a suggestion.",
  rejected: "The chat asked for a pause. Suggestions will be back shortly.",
  rate: "You are sending quickly. Suggestions will be back shortly.",
  unavailable: "The chat is not available right now.",
  noprogress: "The last question did not go through.",
};

function normPhase(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function squash(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
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

  /** The text of every `#history li > p` row, in order (text only, never markup). */
  function rowTexts() {
    const history = find("#history");
    if (!history) return [];
    try {
      if (typeof history.querySelectorAll !== "function") return [];
      return Array.from(history.querySelectorAll("li > p")).map((row) =>
        String(row && row.textContent != null ? row.textContent : ""),
      );
    } catch {
      return [];
    }
  }

  /** The last row that has any text. Blank rows are skipped; an echo of the visitor's text is not. */
  function lastReply() {
    const rows = rowTexts();
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (squash(rows[i]) !== "") return rows[i];
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

  return { readPhase, readDraft, submit, lastReply, rowCount, onPhase, onHistory, onSubmit };
}

/**
 * @typedef {object} ChatStatus
 * @property {boolean} canSend
 * @property {"" | "starting" | "busy" | "draft" | "rejected" | "rate" | "unavailable" | "noprogress"} reason
 *   "noprogress" is informational: canSend is true again, and `message` says the last question did not go through.
 * @property {string} message
 * @property {number|null} resumeAt epoch ms when a time-based block ends, else null
 */

/**
 * @param {{
 *   port: {readPhase(): string, readDraft(): string, submit(text: string): void, lastReply(): string,
 *          rowCount?(): number,
 *          onPhase(cb: (phase: string) => void): () => void, onSubmit(cb: (text: string) => void): () => void,
 *          onHistory?(cb: () => void): () => void},
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
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
  let ownText = "";
  let sendingTeaser = false;
  let timer = null;
  let timerSet = false;
  let lateTimer = null;
  let lateTimerSet = false;
  const sends = []; // submit timestamps inside the rate window, ascending
  const delivered = new Set(); // `${rows}:${squashed text}` of every reply handed to onReply
  const echoes = new Set(); // squashed text of every submit seen: a row equal to one is the visitor's echo
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
    if (awaiting && !BUSY_PHASES.has(readPhase())) {
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
    if (BUSY_PHASES.has(current) || awaiting) return block("busy");
    if (current !== "ready" && current !== "rejected") return block("busy");
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
      if (typed !== "" && typed !== ownText) return block("draft");
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
    if (awaiting && !BUSY_PHASES.has(current)) {
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

  function rememberDelivered(key) {
    delivered.add(key);
    if (delivered.size > DELIVERED_LIMIT) delivered.delete(delivered.values().next().value);
  }

  function rememberEcho(plain) {
    if (!plain) return;
    echoes.delete(plain);
    echoes.add(plain);
    if (echoes.size > ECHO_LIMIT) echoes.delete(echoes.values().next().value);
  }

  function rowCount() {
    if (typeof port.rowCount !== "function") return 0;
    try {
      const count = port.rowCount();
      return typeof count === "number" && Number.isFinite(count) ? count : 0;
    } catch {
      return 0;
    }
  }

  /**
   * The text of the last row, if it is a reply that has not been delivered: never blank, never an
   * echo of something submitted (the run failed and the list still ends with the question), never
   * a reply already handed on for this very list (the same text on a list of the same length).
   */
  function pickReply(submitted) {
    let text;
    try {
      text = port.lastReply();
    } catch {
      return null;
    }
    if (typeof text !== "string") return null;
    const plain = squash(text);
    if (!plain) return null;
    if (plain === squash(submitted) || echoes.has(plain)) return null;
    const key = `${rowCount()}:${plain}`;
    if (delivered.has(key)) return null;
    rememberDelivered(key);
    return text;
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
    } else if (next === "ready") {
      if (previous !== "ready" && awaiting) {
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
