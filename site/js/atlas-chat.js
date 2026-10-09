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
 */

export const SEND_WINDOW_MS = 60000;
export const MAX_SENDS_PER_WINDOW = 20;
export const REJECT_PAUSE_MS = 30000;
/**
 * A submit whose run never shows a busy phase (for example the request failed before the
 * chat painted anything) must not block suggestions forever. After this long without any
 * busy phase the bridge stops waiting for it.
 */
export const STALE_SUBMIT_MS = 120000;

const BUSY_PHASES = new Set(["submitting", "running", "reconciling", "recovering"]);
const DELIVERED_LIMIT = 200;

const MESSAGES = {
  starting: "The chat is still starting.",
  busy: "The chat is busy with a question.",
  draft: "The message box has text. Send it or clear it to use a suggestion.",
  rejected: "The chat asked for a pause. Suggestions will be back shortly.",
  rate: "You are sending quickly. Suggestions will be back shortly.",
  unavailable: "The chat is not available right now.",
};

function normPhase(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function squash(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
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

  function lastReply() {
    const history = find("#history");
    if (!history) return "";
    let rows = [];
    try {
      if (typeof history.querySelectorAll === "function") rows = Array.from(history.querySelectorAll("li > p"));
    } catch {
      rows = [];
    }
    if (!rows.length) return "";
    const last = rows[rows.length - 1];
    return String(last && last.textContent != null ? last.textContent : "");
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

  function onPhase(callback) {
    const element = find("#phase");
    const Observer = observerClass();
    if (!element || !Observer) return () => {};
    let live = true;
    const observer = new Observer(() => {
      if (!live) return;
      try {
        callback(readPhase());
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

  return { readPhase, readDraft, submit, lastReply, onPhase, onSubmit };
}

/**
 * @typedef {object} ChatStatus
 * @property {boolean} canSend
 * @property {"" | "starting" | "busy" | "draft" | "rejected" | "rate" | "unavailable"} reason
 * @property {string} message
 * @property {number|null} resumeAt epoch ms when a time-based block ends, else null
 */

/**
 * @param {{
 *   port: {readPhase(): string, readDraft(): string, submit(text: string): void, lastReply(): string,
 *          onPhase(cb: (phase: string) => void): () => void, onSubmit(cb: (text: string) => void): () => void},
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   onReply?: (text: string) => void,
 *   onChange?: (status: ChatStatus) => void,
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
} = {}) {
  let disposed = false;
  let phase = "";
  let awaiting = null; // {text, at}: a submit whose run has not finished yet
  let rejectUntil = 0;
  let submitEvents = 0;
  // The last teaser this bridge submitted (whitespace squashed), so its own text coming back is not
  // mistaken for something the visitor typed: after a 409/429 the chat puts the refused text back
  // into the message box, and without this the teasers would stay blocked until it was cleared.
  let ownText = "";
  let sendingTeaser = false;
  let timer = null;
  let timerSet = false;
  const sends = []; // submit timestamps inside the rate window, ascending
  const delivered = new Set();
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
    if (awaiting && !BUSY_PHASES.has(readPhase()) && t - awaiting.at >= STALE_SUBMIT_MS) awaiting = null;
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
    if (current === "") return block("starting");
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
    return { canSend: true, reason: "", message: "", resumeAt: null };
  }

  function nextDeadline(t) {
    let deadline = Infinity;
    if (rejectUntil > t) deadline = Math.min(deadline, rejectUntil);
    const rate = rateResumeAt();
    if (rate != null) deadline = Math.min(deadline, rate);
    if (awaiting && !BUSY_PHASES.has(readPhase())) deadline = Math.min(deadline, awaiting.at + STALE_SUBMIT_MS);
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

  function pickReply(submitted) {
    let text;
    try {
      text = port.lastReply();
    } catch {
      return null;
    }
    if (typeof text !== "string") return null;
    const key = squash(text);
    if (!key) return null;
    if (key === squash(submitted)) return null; // the run failed: the last row is still the question
    if (delivered.has(key)) return null;
    delivered.add(key);
    if (delivered.size > DELIVERED_LIMIT) delivered.delete(delivered.values().next().value);
    return text;
  }

  function onSubmitEvent(text) {
    if (disposed) return;
    const t = now();
    submitEvents += 1;
    sends.push(t);
    // A submit that did not come from sendTeaser is the visitor's own: their text is theirs from now on.
    if (!sendingTeaser) ownText = "";
    awaiting = { text: typeof text === "string" ? text : "", at: t };
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
        dirty = true;
      }
    } else if (BUSY_PHASES.has(next) && awaiting) {
      awaiting.at = t;
    }
    if (reply !== null && typeof onReply === "function") {
      try {
        onReply(reply);
      } catch {
        /* a failing listener must not break the bridge */
      }
    }
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
      awaiting = null;
      sends.length = 0;
    },
  };
}
