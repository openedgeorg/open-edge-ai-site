/** @typedef {"ready"|"submitting"|"running"|"reconciling"|"recovering"|"cancelling"|"rejected"|"failed"|"cancelled"|"unresolved"|"unavailable"} Phase */

/**
 * @typedef {object} ClientState
 * @property {Phase} phase
 * @property {string|null} identity  the visitor's subject id when the service reports one; never invented
 * @property {string|null} provider  the provider of the current conversation, null before it exists
 * @property {string|null} conversationId
 * @property {string} draft  what the visitor is typing and has not sent
 * @property {string|null} requestId  the client request id of the question being tracked
 * @property {string} submitted  the text of that question (distinct from the draft)
 * @property {string|null} nativeWorkRef
 * @property {string|null} runId  the active agent run, when it is known (needed to cancel)
 * @property {{count: number, lastKey: string|null}|null} baseline  where the history stood when the question was sent
 * @property {number|null} sentAt  epoch ms of the submit; the wait thresholds are measured from it, also after a reload
 * @property {boolean} resubmission  the status said the question never started and may be sent again
 * @property {{kind: string, text: string}|null} notice  the outcome shown in the status line
 * @property {boolean} sendDisabled
 */

const SESSION_KEY = "esp-client";
const STATE_VERSION = 2;
const memory = new Map();

/** Phases in which a question is submitted or being tracked: another one must not be sent. */
export const BUSY_PHASES = new Set(["submitting", "running", "reconciling", "recovering", "cancelling"]);
/** Phases in which the tracked question has no known outcome. */
export const PENDING_PHASES = new Set([...BUSY_PHASES, "unresolved"]);
/** Phases that survive a reload as they are. */
const RESTORED_PHASES = new Set(["ready", "rejected", "failed", "cancelled", "unavailable"]);
const PROVIDERS = new Set(["openai", "xai"]);
const NOTICE_KINDS = new Set(["working", "waiting", "long", "warning", "error", "gone", "info", "done", "confirm"]);

/** Whether the composer must refuse another question in this phase. */
export function sendBlocked(phase) {
  return PENDING_PHASES.has(phase);
}

/**
 * An identifier from storage or from a response, or null. A value that was once serialised from
 * `undefined` (the string "undefined") is not an identity.
 * @param {unknown} value
 * @param {number} [max]
 */
export function validId(value, max = 200) {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > max) return null;
  if (!/^[A-Za-z0-9._:~-]+$/.test(value)) return null;
  if (/^(undefined|null|nan|true|false)$/i.test(value)) return null;
  return value;
}

export function validProvider(value) {
  return typeof value === "string" && PROVIDERS.has(value) ? value : null;
}

function validNotice(value) {
  if (!value || typeof value !== "object") return null;
  const kind = typeof value.kind === "string" && NOTICE_KINDS.has(value.kind) ? value.kind : null;
  const text = typeof value.text === "string" ? value.text.slice(0, 600) : "";
  return kind && text ? { kind, text } : null;
}

function validBaseline(value) {
  if (!value || typeof value !== "object") return null;
  const count = Number.isInteger(value.count) && value.count >= 0 && value.count < 1e7 ? value.count : null;
  if (count === null) return null;
  const lastKey = typeof value.lastKey === "string" && value.lastKey.length > 0 && value.lastKey.length <= 400 ? value.lastKey : null;
  if (count > 0 && lastKey === null) return null;
  return { count, lastKey: count > 0 ? lastKey : null };
}

/** @returns {ClientState} */
export function initialClientState() {
  return {
    phase: "ready",
    identity: null,
    provider: null,
    conversationId: null,
    draft: "",
    requestId: null,
    submitted: "",
    nativeWorkRef: null,
    runId: null,
    baseline: null,
    sentAt: null,
    resubmission: false,
    notice: null,
    sendDisabled: false,
  };
}

function cleared(state) {
  return { ...state, requestId: null, submitted: "", nativeWorkRef: null, runId: null, baseline: null, sentAt: null, resubmission: false };
}

/** The question goes back into the message box unless the visitor has already typed something else. */
function withRestoredDraft(state, restore) {
  if (!restore || !state.submitted) return state;
  return state.draft === "" ? { ...state, draft: state.submitted } : state;
}

function correlated(state, action) {
  return {
    ...state,
    runId: validId(action.runId) || state.runId,
    nativeWorkRef: validId(action.nativeWorkRef, 400) || state.nativeWorkRef,
  };
}

/**
 * @param {ClientState} state
 * @param {{type: string, [key: string]: unknown}} action
 * @returns {ClientState}
 */
export function reduceClientState(state, action) {
  switch (action.type) {
    case "identity": {
      const subject = validId(action.subjectId);
      if (state.identity || !subject) return state;
      return { ...state, identity: subject };
    }
    case "choose_provider": {
      const provider = validProvider(action.provider);
      if (state.provider || !provider) return state;
      return { ...state, provider, conversationId: null };
    }
    case "conversation_created": {
      const id = validId(action.id);
      const provider = validProvider(action.provider);
      if (!id || !provider) return state;
      return { ...state, conversationId: id, provider };
    }
    case "edit_draft":
      // The draft is always the visitor's: a pending question lives in `submitted`, never here.
      return { ...state, draft: String(action.text ?? "") };
    case "submit": {
      const text = action.text == null ? state.draft : String(action.text);
      return {
        ...cleared(state),
        phase: "submitting",
        requestId: String(action.requestId),
        submitted: text,
        draft: state.draft === text ? "" : state.draft,
        baseline: action.baseline === undefined ? null : validBaseline(action.baseline),
        sentAt: Number.isFinite(action.at) ? action.at : null,
        notice: null,
        sendDisabled: true,
      };
    }
    case "resubmit":
      // The same logical question, sent again because the status said it never started.
      return {
        ...state,
        phase: "submitting",
        nativeWorkRef: null,
        runId: null,
        resubmission: false,
        sentAt: Number.isFinite(action.at) ? action.at : state.sentAt,
        notice: null,
        sendDisabled: true,
      };
    case "accepted":
      return { ...correlated(state, action), phase: "running", notice: null, sendDisabled: true };
    case "correlation":
      return correlated(state, action);
    case "baseline_known":
      // Where the history stood before the question went out, learnt late (it could not be read at first).
      if (state.baseline !== null || !state.requestId) return state;
      return { ...state, baseline: validBaseline(action.baseline) };
    case "acceptance_lost":
      return { ...state, phase: "reconciling", notice: null, sendDisabled: true };
    case "status_checked": {
      // The real status response decides the next phase; a check is not another reconciling.
      const next = correlated(state, action);
      const cancelling = state.phase === "cancelling";
      switch (action.outcome) {
        case "accepted":
        case "running": {
          const recovering = action.runtimeState === "recovering" || action.runtimeState === "suspect";
          return { ...next, phase: cancelling ? "cancelling" : recovering ? "recovering" : "running", sendDisabled: true };
        }
        case "submission_unconfirmed":
          return { ...next, phase: cancelling ? "cancelling" : "reconciling", sendDisabled: true };
        case "not_started":
          if (action.resubmissionAllowed === true) {
            return { ...next, phase: "failed", resubmission: true, notice: action.notice ?? null, sendDisabled: false };
          }
          return { ...next, phase: cancelling ? "cancelling" : "reconciling", sendDisabled: true };
        case "completed":
          return next;
        case "failed": {
          const restored = withRestoredDraft(next, action.restoreDraft === true);
          return { ...cleared(restored), phase: "failed", notice: action.notice ?? null, sendDisabled: false };
        }
        case "cancelled":
          return { ...cleared(next), phase: "cancelled", notice: action.notice ?? null, sendDisabled: false };
        default:
          return next;
      }
    }
    case "settled": {
      if (!PENDING_PHASES.has(state.phase)) return state;
      return { ...cleared(state), phase: "ready", notice: action.notice ?? null, sendDisabled: false };
    }
    case "failed": {
      const restored = withRestoredDraft(state, action.restoreDraft === true);
      return { ...cleared(restored), phase: "failed", notice: action.notice ?? null, sendDisabled: false };
    }
    case "cancelled":
      return { ...cleared(state), phase: "cancelled", notice: action.notice ?? null, sendDisabled: false };
    case "cancel_requested":
      if (!state.runId || !PENDING_PHASES.has(state.phase)) return state;
      return { ...state, phase: "cancelling", notice: null, sendDisabled: true };
    case "rejected": {
      // A clean refusal: nothing was submitted, so the question goes back to the draft.
      const restored = withRestoredDraft(state, action.restoreDraft !== false);
      return { ...cleared(restored), phase: "rejected", notice: action.notice ?? null, sendDisabled: false };
    }
    case "manual_retry":
      if (state.phase !== "rejected") return state;
      return { ...state, phase: "ready", sendDisabled: false };
    case "recovering":
      return { ...state, phase: "recovering", sendDisabled: true };
    case "unavailable": {
      const restored = withRestoredDraft(state, action.restoreDraft !== false);
      return { ...cleared(restored), phase: "unavailable", notice: action.notice ?? null, sendDisabled: false };
    }
    case "unresolved":
      return { ...state, phase: "unresolved", notice: null, sendDisabled: true };
    case "recovered":
      // The chat that could not start can, now.
      if (state.phase !== "unavailable") return state;
      return { ...state, phase: "ready", notice: null, sendDisabled: false };
    case "notice":
      return { ...state, notice: action.notice ?? null };
    case "new_conversation":
      // The provider is chosen again for the next conversation. The visitor's draft and the map are theirs.
      return {
        ...cleared(state),
        phase: "ready",
        provider: null,
        conversationId: null,
        notice: action.notice ?? null,
        sendDisabled: false,
      };
    case "focus":
    case "timer":
    case "capacity_returned":
      return state;
    default:
      return state;
  }
}

/**
 * @param {Storage|null|undefined} storage
 * @param {ClientState} state
 */
export function persistSession(storage, state) {
  const payload = JSON.stringify({
    v: STATE_VERSION,
    identity: state.identity,
    provider: state.provider,
    conversationId: state.conversationId,
    draft: state.draft,
    requestId: state.requestId,
    submitted: state.submitted,
    nativeWorkRef: state.nativeWorkRef,
    runId: state.runId,
    baseline: state.baseline,
    sentAt: state.sentAt,
    resubmission: state.resubmission,
    notice: state.notice,
    phase: state.phase,
  });
  try {
    if (storage && typeof storage.setItem === "function") {
      storage.setItem(SESSION_KEY, payload);
      return;
    }
  } catch {
    /* sessionStorage disabled or full: keep the tab's state in memory only */
  }
  memory.set(SESSION_KEY, payload);
}

function parseSaved(raw) {
  try {
    const saved = JSON.parse(String(raw));
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : null;
  } catch {
    return null;
  }
}

/**
 * The state of this tab from storage. Whatever is wrong with what is stored (missing, not JSON,
 * the wrong shape, an identifier that is not one) is ignored: the visitor then starts from a clean
 * state and nothing is invented.
 * @param {Storage|null|undefined} storage
 * @returns {ClientState}
 */
export function restoreSession(storage) {
  let raw = null;
  try {
    if (storage && typeof storage.getItem === "function") raw = storage.getItem(SESSION_KEY);
  } catch {
    raw = null;
  }
  if (raw == null) raw = memory.get(SESSION_KEY) ?? null;
  if (raw == null) return initialClientState();
  const saved = parseSaved(raw);
  if (!saved) return initialClientState();
  const state = initialClientState();
  state.identity = validId(saved.identity);
  state.provider = validProvider(saved.provider);
  state.conversationId = validId(saved.conversationId);
  // A conversation always has its provider: one without the other is not a conversation.
  if (!state.conversationId || !state.provider) {
    state.conversationId = null;
    state.provider = null;
  }
  state.draft = typeof saved.draft === "string" ? saved.draft : "";
  state.notice = validNotice(saved.notice);
  const requestId = validId(saved.requestId);
  const submitted = typeof saved.submitted === "string" ? saved.submitted : "";
  const phase = typeof saved.phase === "string" ? saved.phase : "ready";
  // A refusal, a cancellation and a failure that may not be resent are over: their request id is history.
  // Everything else with a request id (also an old "unavailable") might have been received, so it is re-checked.
  const settled = phase === "rejected" || phase === "cancelled" || (phase === "failed" && saved.resubmission !== true);
  const tracked = requestId !== null && state.conversationId !== null && !settled;
  if (tracked) {
    state.requestId = requestId;
    state.submitted = submitted;
    state.nativeWorkRef = validId(saved.nativeWorkRef, 400);
    state.runId = validId(saved.runId);
    state.baseline = validBaseline(saved.baseline);
    state.sentAt = Number.isFinite(saved.sentAt) ? saved.sentAt : null;
  } else if (requestId !== null && submitted && state.draft === "") {
    // A question that never reached a conversation was never sent: it goes back to the draft.
    state.draft = submitted;
  }
  if (tracked && phase === "failed" && saved.resubmission === true) {
    state.phase = "failed";
    state.resubmission = true;
    state.sendDisabled = false;
  } else if (tracked) {
    // Whatever was happening, the request is re-checked, never sent again.
    state.phase = "reconciling";
    state.sendDisabled = true;
    state.notice = null;
  } else if (RESTORED_PHASES.has(phase)) {
    state.phase = phase;
    state.sendDisabled = false;
    // "The answer is ready" is no news after a reload.
    if (phase === "ready") state.notice = null;
  } else {
    state.notice = null;
  }
  return state;
}

export function sessionMemory() {
  return memory;
}
