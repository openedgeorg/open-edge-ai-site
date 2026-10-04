/** @typedef {"ready"|"submitting"|"running"|"reconciling"|"rejected"|"recovering"|"unavailable"} Phase */

/**
 * @typedef {object} ClientState
 * @property {Phase} phase
 * @property {string|null} identity
 * @property {string|null} provider
 * @property {string|null} conversationId
 * @property {string} draft
 * @property {string|null} requestId
 * @property {boolean} sendDisabled
 */

const SESSION_KEY = "esp-client";
const memory = new Map();

/** @returns {ClientState} */
export function initialClientState() {
  return {
    phase: "ready",
    identity: null,
    provider: null,
    conversationId: null,
    draft: "",
    requestId: null,
    sendDisabled: false,
  };
}

/**
 * @param {ClientState} state
 * @param {{type: string, [key: string]: unknown}} action
 * @returns {ClientState}
 */
export function reduceClientState(state, action) {
  switch (action.type) {
    case "identity":
      if (state.identity) return state;
      return { ...state, identity: String(action.subjectId) };
    case "choose_provider":
      if (state.provider) return state;
      return { ...state, provider: String(action.provider), conversationId: null };
    case "edit_draft":
      if (state.phase === "submitting" || state.phase === "reconciling" || state.phase === "running") {
        return state;
      }
      return { ...state, draft: String(action.text) };
    case "submit":
      return { ...state, phase: "submitting", requestId: String(action.requestId), sendDisabled: true };
    case "accepted":
      return { ...state, phase: "running", draft: "", requestId: null, sendDisabled: true };
    case "acceptance_lost":
      return { ...state, phase: "reconciling", sendDisabled: true };
    case "status_checked":
      return { ...state, phase: "reconciling", sendDisabled: true };
    case "rejected":
      return { ...state, phase: "rejected", sendDisabled: false };
    case "manual_retry":
      if (state.phase !== "rejected") return state;
      return { ...state, phase: "ready", sendDisabled: false };
    case "recovering":
      return { ...state, phase: "recovering", sendDisabled: true };
    case "unavailable":
      return { ...state, phase: "unavailable", sendDisabled: true };
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
    identity: state.identity,
    provider: state.provider,
    conversationId: state.conversationId,
    draft: state.draft,
    requestId: state.requestId,
    phase: state.phase,
  });
  try {
    if (storage && typeof storage.setItem === "function") {
      storage.setItem(SESSION_KEY, payload);
      return;
    }
  } catch {
    /* sessionStorage disabled: keep the tab draft in memory only */
  }
  memory.set(SESSION_KEY, payload);
}

/**
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
  const saved = JSON.parse(String(raw));
  const state = initialClientState();
  state.identity = saved.identity ?? null;
  state.provider = saved.provider ?? null;
  state.conversationId = saved.conversationId ?? null;
  state.draft = typeof saved.draft === "string" ? saved.draft : "";
  state.requestId = saved.requestId ?? null;
  if (saved.phase === "rejected") {
    state.phase = "rejected";
    state.sendDisabled = false;
  } else if (saved.phase === "submitting" || saved.phase === "reconciling" || state.requestId) {
    state.phase = "reconciling";
    state.sendDisabled = true;
  }
  return state;
}

export function sessionMemory() {
  return memory;
}
