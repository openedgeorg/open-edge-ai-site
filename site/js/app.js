import { createClient } from "./api.js";
import {
  LONG_WAIT_MS,
  PROVIDER_ORDER,
  STILL_WORKING_MS,
  ARRIVED_UNRESOLVED_TEXT,
  COMPLETED_UNREADABLE_TEXT,
  SESSION_FAILED_TEXT,
  UNRESOLVED_TEXT,
  answerReadyNotice,
  baselineOf,
  cancelUnconfirmedText,
  cancelledNotice,
  creationNotice,
  describeBusy,
  describeCheck,
  failedNotice,
  findAnswer,
  goneNotice,
  historyFailedText,
  historyLoadingText,
  itemsSince,
  listsQuestion,
  newConversationConfirmText,
  newConversationNotice,
  notStartedNotice,
  rejectionNotice,
} from "./outcomes.js";
import { renderHistoryItem } from "./render.js";
import { parseSse } from "./sse.js";
import { BUSY_PHASES, PENDING_PHASES, persistSession, reduceClientState, restoreSession, sendBlocked, validProvider } from "./state.js";

export { renderHistoryItem };

/**
 * The waits of the conversation client. The service runs a question for at most 300 seconds
 * (RUN_DEADLINE_SECONDS), so automatic checking stops a little after that and a manual Check status
 * starts another bounded round. None of these is ever a reason to send a question again.
 */
export const TIMING = {
  pollWindowMs: 330000,
  manualWindowMs: 120000,
  streamOpenMs: 15000,
  streamIdleMs: 60000,
  sessionFreshMs: 300000,
  doneGraceMs: 20000,
  pollDelaysMs: [1000, 1500, 2000, 3000, 4000, 5000],
  bootRetryDelaysMs: [3000, 8000, 20000, 45000],
};

export const MAX_MESSAGE_BYTES = 8192;

const IDLE = Symbol("idle");
const OPEN_TIMEOUT = Symbol("open timeout");

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

function newRequestId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* fall through to the manual form */
  }
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Development conversation controller. It does not claim Gate 1.
 *
 * Every submitted question ends in a visible outcome that says what is known: an answer, a failure,
 * a cancellation, a clean refusal (nothing was sent) or an unresolved status (it may have been
 * received, so it is never sent again). The controller paints through the `view` it is given:
 * `phase`, `draft`, `sendDisabled`, `providerFixed` (the original fields) and `status`, `actions`,
 * `rows`, `historyState`, `providers`, `provider`, `retryText`. `view.onChange(view)` is called after
 * each change, also for changes that come from timers and from the network.
 *
 * @param {{fetchImpl?: typeof fetch, baseUrl?: string, storage?: Storage|null, now?: () => number,
 *   setTimer?: Function, clearTimer?: Function, timing?: Partial<typeof TIMING>, newId?: () => string}} options
 */
export function createController({ fetchImpl, baseUrl = "", storage = null, now = () => Date.now(), setTimer, clearTimer, timing = {}, newId } = {}) {
  const wait = { ...TIMING, ...timing };
  // Background waits never keep a Node process alive (a page does not care).
  const startTimer =
    setTimer ||
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      if (handle && typeof handle.unref === "function") handle.unref();
      return handle;
    });
  const stopTimer = clearTimer || ((handle) => clearTimeout(handle));
  const client = createClient({ fetchImpl, baseUrl, setTimer: startTimer, clearTimer: stopTimer });
  const makeRequestId = newId || newRequestId;
  let state = restoreSession(storage);

  let lastView = null;
  let booted = false;
  /** Generation of the tracked turn. Anything started under an older one stops doing anything. */
  let turn = 0;
  const sleepers = new Set();
  let loop = null;
  let streaming = false;
  let tickerToken = null;
  let sending = false;
  let sessionAt = null;
  let sessionPromise = null;
  /** The service's own history of this conversation (normalized), or null when it is not known. */
  let serverItems = null;
  let historyState = { kind: "idle", text: "" };
  let historySeq = 0;
  let historyApplied = 0;
  let streamText = "";
  let lastStream = { kind: "none" };
  let lastStreamAt = -Infinity;
  let doneAt = null;
  let hint = null;
  let lastCheck = null;
  /** The status said the work completed; only the reading of the answer is missing. */
  let knownCompleted = false;
  let questionArrived = false; // the history lists the pending question, so it did arrive
  // The service frees a conversation's run a moment after the answer can be read (its supervisor runs every 2 s, and a busy
  // service takes longer). A question sent in that gap is cleanly refused ("conversation_busy": nothing was sent), so it is
  // offered again a few times, about 30 seconds in all.
  const BUSY_RETRY_DELAYS_MS = [1500, 3000, 5000, 8000, 12000];
  const BUSY_GRACE_MS = 60000;
  let lastSettledAt = -Infinity;
  let draftRevision = 0;
  let providers = null;
  let chosen = null;
  let confirmingNew = false;

  /* ---------------- small helpers ---------------- */

  function apply(action) {
    const before = state;
    state = reduceClientState(state, action);
    if (state.draft !== before.draft && action.type !== "edit_draft") draftRevision += 1;
    persistSession(storage, state);
  }

  function pendingContext() {
    if (!state.requestId || !state.conversationId) return null;
    return { baseline: state.baseline, submitted: state.submitted, nativeWorkRef: state.nativeWorkRef };
  }

  function providerChoices() {
    return PROVIDER_ORDER.map((provider) => {
      if (!providers) return { provider, available: true, reason: "" };
      const info = providers.find((entry) => entry.provider === provider);
      if (!info) return { provider, available: false, reason: "not offered here" };
      if (info.available) return { provider, available: true, reason: "" };
      return { provider, available: false, reason: info.eligible ? "unavailable right now" : "not open to new conversations" };
    });
  }

  function currentProvider() {
    if (state.conversationId && state.provider) return state.provider;
    const choices = providerChoices();
    const usable = (provider) => choices.some((choice) => choice.provider === provider && choice.available);
    if (chosen && usable(chosen)) return chosen;
    const first = choices.find((choice) => choice.available);
    return first ? first.provider : chosen || PROVIDER_ORDER[0];
  }

  function otherAvailable(provider) {
    const other = providerChoices().find((choice) => choice.provider !== provider && choice.available);
    return providers && other ? other.provider : null;
  }

  function computeRows() {
    const rows = [];
    const items = serverItems || [];
    for (const item of items) {
      if (item.text !== "") rows.push({ key: `h:${item.key}`, role: item.role, text: item.text, provisional: item.provisional, pending: false });
    }
    const pending = state.requestId && state.submitted ? { baseline: state.baseline, submitted: state.submitted, nativeWorkRef: state.nativeWorkRef } : null;
    if (pending) {
      if (!listsQuestion(items, pending)) rows.push({ key: "pending-user", role: "user", text: state.submitted, provisional: false, pending: true });
      const fresh = itemsSince(items, pending.baseline, pending.submitted);
      const answered = fresh.some((item) => item.role === "assistant" && item.text.trim() !== "");
      if (streamText && !answered) rows.push({ key: "stream", role: "assistant", text: streamText, provisional: true, pending: true });
    }
    return rows;
  }

  function describe() {
    if (confirmingNew) return { kind: "confirm", text: newConversationConfirmText(PENDING_PHASES.has(state.phase)) };
    const elapsedMs = state.sentAt == null ? 0 : Math.max(0, now() - state.sentAt);
    if (BUSY_PHASES.has(state.phase)) {
      const busy = describeBusy(state, { elapsedMs, hint, lastCheck });
      if (state.phase === "cancelling" && hint === "cancel_unconfirmed") {
        return { kind: "warning", text: `${cancelUnconfirmedText()}${lastCheck ? ` ${lastCheck}` : ""}` };
      }
      return busy;
    }
    if (state.phase === "unresolved") {
      const text = knownCompleted ? COMPLETED_UNREADABLE_TEXT : questionArrived ? ARRIVED_UNRESOLVED_TEXT : UNRESOLVED_TEXT;
      return { kind: "warning", text: `${text}${lastCheck ? ` ${lastCheck}` : ""}` };
    }
    return state.notice || { kind: "", text: "" };
  }

  function actions() {
    const pending = Boolean(state.requestId && state.conversationId);
    const elapsedMs = state.sentAt == null ? 0 : Math.max(0, now() - state.sentAt);
    const phase = state.phase;
    return {
      cancel: Boolean(state.runId) && PENDING_PHASES.has(phase) && phase !== "submitting",
      cancelDisabled: phase === "cancelling",
      checkStatus:
        pending && (["reconciling", "recovering", "unresolved", "cancelling"].includes(phase) || (phase === "running" && elapsedMs >= STILL_WORKING_MS)),
      retry: phase === "failed" && state.resubmission && pending && state.submitted !== "",
      newConversation: Boolean(state.conversationId) && phase !== "submitting",
      newConversationLabel: confirmingNew ? "Confirm: start a new conversation" : "New conversation",
    };
  }

  function render(view) {
    if (view) lastView = view;
    const target = view || lastView;
    if (!target) return;
    target.booted = booted;
    target.phase = state.phase;
    target.draft = state.draft;
    target.draftRevision = draftRevision;
    target.sendDisabled = sendBlocked(state.phase) || sending;
    target.providerFixed = state.conversationId != null;
    target.provider = currentProvider();
    target.providers = providerChoices();
    target.status = describe();
    target.actions = actions();
    target.historyState = historyState;
    target.rows = computeRows();
    target.retryText = target.actions.retry ? state.submitted : null;
    if (typeof target.onChange === "function") {
      try {
        target.onChange(target);
      } catch {
        /* a failing painter must not break the conversation */
      }
    }
  }

  /* ---------------- waiting ---------------- */

  function invalidate() {
    turn += 1;
    for (const sleeper of [...sleepers]) sleeper.finish(false);
  }

  /** Sleep `ms`; resolves false when the turn changed (or the sleeper was woken on purpose), true when the time passed. */
  function sleep(ms, token, tag = "") {
    return new Promise((resolve) => {
      if (token !== turn) {
        resolve(false);
        return;
      }
      const sleeper = { tag, done: false, handle: null, finish: null };
      sleeper.finish = (value) => {
        if (sleeper.done) return;
        sleeper.done = true;
        sleepers.delete(sleeper);
        stopTimer(sleeper.handle);
        resolve(value);
      };
      sleeper.handle = startTimer(() => sleeper.finish(true), Math.max(0, ms));
      sleepers.add(sleeper);
    });
  }

  function wake(tag) {
    for (const sleeper of [...sleepers]) if (sleeper.tag === tag) sleeper.finish(false);
  }

  function pollDelay(attempt, elapsedMs) {
    const delays = wait.pollDelaysMs;
    const base = delays[Math.min(attempt - 1, delays.length - 1)];
    if (elapsedMs > 150000) return Math.max(base, 15000);
    if (elapsedMs > 60000) return Math.max(base, 8000);
    return base;
  }

  /* ---------------- session, providers, history ---------------- */

  async function ensureSession(force = false) {
    if (!force && sessionAt !== null && now() - sessionAt < wait.sessionFreshMs) return;
    if (!sessionPromise) {
      sessionPromise = client
        .visitorSession()
        .then((session) => {
          sessionAt = now();
          if (session.subjectId && !state.identity) apply({ type: "identity", subjectId: session.subjectId });
        })
        .finally(() => {
          sessionPromise = null;
        });
    }
    await sessionPromise;
  }

  /** A read that the service answered with 401 (the visitor cookie ran out): renew the session once and ask again. */
  async function afterRenewingTheSession(again, failed) {
    try {
      await ensureSession(true);
    } catch {
      return failed;
    }
    return again();
  }

  async function loadProviders() {
    const result = await client.providers();
    if (result.kind === "ok") providers = result.providers;
    render();
  }

  /** Read the conversation so far from the service. The result is applied only if no newer read has been applied. */
  async function loadHistory({ quiet = false } = {}) {
    const id = state.conversationId;
    if (!id) return null;
    const seq = (historySeq += 1);
    if (!quiet) {
      historyState = { kind: "loading", text: historyLoadingText() };
      render();
    }
    let result = await client.history(id);
    if (result.kind === "unavailable" && result.status === 401) result = await afterRenewingTheSession(() => client.history(id), result);
    if (id !== state.conversationId) return null;
    if (result.kind === "ok") {
      if (seq > historyApplied) {
        historyApplied = seq;
        serverItems = result.items;
      }
      if (seq === historySeq) historyState = { kind: "idle", text: "" };
    } else if (seq === historySeq && (!quiet || result.kind === "gone")) {
      // A refresh in the background keeps what is shown; only a gone conversation is worth saying.
      const gone = result.kind === "gone";
      historyState = { kind: "failed", text: historyFailedText({ gone }), gone };
      if (gone && !PENDING_PHASES.has(state.phase) && state.notice?.kind !== "gone") apply({ type: "notice", notice: goneNotice() });
    } else if (seq === historySeq) {
      historyState = { kind: "idle", text: "" };
    }
    render();
    return result;
  }

  /* ---------------- turn outcomes ---------------- */

  function endTurn() {
    streamText = "";
    hint = null;
    lastCheck = null;
    knownCompleted = false;
    questionArrived = false;
    invalidate();
  }

  function settleTurn() {
    lastSettledAt = now();
    apply({ type: "settled", notice: answerReadyNotice() });
    endTurn();
    render();
  }

  async function failTurn({ source, message = "" }) {
    const restored = state.draft === "" && state.submitted !== "";
    apply({ type: "failed", restoreDraft: true, notice: failedNotice({ source, message, restored }) });
    endTurn();
    render();
    await loadHistory({ quiet: true });
  }

  async function cancelTurn() {
    apply({ type: "cancelled", notice: cancelledNotice() });
    endTurn();
    render();
    await loadHistory({ quiet: true });
  }

  function conversationGone() {
    apply({ type: "failed", restoreDraft: true, notice: goneNotice() });
    endTurn();
    render();
  }

  function goUnresolved() {
    apply({ type: "unresolved" });
    hint = null;
    invalidate();
    render();
  }

  /** The stream said the answer was delivered but the history never shows it: keep what was streamed. */
  function adoptStreamedAnswer(items) {
    const pending = pendingContext();
    const next = items.slice();
    if (!listsQuestion(items, pending)) {
      next.push({ key: `local:${state.requestId}:question`, role: "user", text: state.submitted, workRef: null, provisional: false });
    }
    next.push({ key: `local:${state.requestId}:answer`, role: "assistant", text: streamText, workRef: state.nativeWorkRef, provisional: false });
    serverItems = next;
  }

  function adoptItems(items) {
    historySeq += 1;
    historyApplied = historySeq;
    serverItems = items;
    // The conversation has been read: a "could not be loaded" line from an earlier try is out of date.
    if (!historyState.gone) historyState = { kind: "idle", text: "" };
  }

  /* ---------------- checking a request ---------------- */

  /**
   * Fetch the history and settle the turn if its own answer is in it. `authoritative`: the status
   * said the work completed, so only the history is missing. Returns "terminal" or "continue".
   */
  async function answerFromHistory(token, { authoritative, loaded = null, explain = true }) {
    const id = state.conversationId;
    const result = loaded || (await client.history(id));
    if (token !== turn) return "terminal";
    if (result.kind === "gone") {
      conversationGone();
      return "terminal";
    }
    if (result.kind !== "ok") {
      if (explain) hint = "history_unavailable";
      render();
      return "continue";
    }
    adoptItems(result.items);
    const pending = pendingContext();
    if (!pending) return "terminal";
    const info = result.status;
    if (info && info.requestId === state.requestId && info.nativeWorkRef && !state.nativeWorkRef) {
      apply({ type: "correlation", nativeWorkRef: info.nativeWorkRef });
    }
    // Without a baseline (the history could not be read before the question went out) a list alone cannot tell
    // this turn's answer from an older one: it needs the stream's "done", the history's own status or the work reference.
    const current = pendingContext();
    const proven =
      authoritative ||
      current.baseline !== null ||
      current.nativeWorkRef !== null ||
      lastStream.kind === "done" ||
      Boolean(info && info.requestId === state.requestId && info.status === "completed");
    if (proven && findAnswer(result.items, current, { authoritative })) {
      settleTurn();
      return "terminal";
    }
    if (!authoritative && info && info.requestId === state.requestId && info.status === "failed") {
      await failTurn({ source: lastStream.kind === "error" ? "stream" : "status", message: lastStream.message });
      return "terminal";
    }
    // The stream said the answer was delivered, yet the history keeps not listing it: keep what was streamed.
    // (Never when the status only says "completed": a streamed text may then be a part of the answer.)
    if (!authoritative && lastStream.kind === "done" && streamText) {
      if (doneAt === null) doneAt = now();
      if (now() - doneAt > wait.doneGraceMs) {
        adoptStreamedAnswer(result.items);
        settleTurn();
        return "terminal";
      }
    }
    if (explain) hint = authoritative ? "answer_loading" : "status_unavailable";
    render();
    return "continue";
  }

  /** Act on a real status response. Returns "terminal" or "continue". */
  async function applyStatus(token, view) {
    lastCheck = describeCheck(view.outcome);
    switch (view.outcome) {
      case "completed":
        knownCompleted = true;
        apply({ type: "status_checked", outcome: "completed", runId: view.runId, nativeWorkRef: view.nativeWorkRef });
        return answerFromHistory(token, { authoritative: true });
      case "failed":
        apply({ type: "correlation", runId: view.runId, nativeWorkRef: view.nativeWorkRef });
        await failTurn({ source: lastStream.kind === "error" ? "stream" : "status", message: lastStream.message });
        return "terminal";
      case "cancelled":
        await cancelTurn();
        return "terminal";
      case "not_started":
        if (view.resubmissionAllowed) {
          apply({ type: "status_checked", outcome: "not_started", resubmissionAllowed: true, notice: notStartedNotice() });
          endTurn();
          render();
          return "terminal";
        }
        break;
      default:
        break;
    }
    if (view.outcome === "submission_unconfirmed" || view.outcome === "unknown") {
      // The status can stay "unconfirmed" after the work is done (the request id is not recorded when the sender gave up
      // waiting for the answer to its POST). The history is the other witness: a listed question did arrive, and an
      // answer after it ends the turn. Nothing is sent.
      const verdict = await answerFromHistory(token, { authoritative: false, explain: false });
      if (verdict === "terminal" || token !== turn) return "terminal";
      const pending = pendingContext();
      if (pending && Array.isArray(serverItems) && listsQuestion(serverItems, pending)) {
        questionArrived = true;
        apply({ type: "status_checked", outcome: "running", runId: view.runId, nativeWorkRef: view.nativeWorkRef, runtimeState: view.runtimeState });
        hint = null;
        render();
        return "continue";
      }
    }
    apply({
      type: "status_checked",
      outcome: view.outcome,
      runId: view.runId,
      nativeWorkRef: view.nativeWorkRef,
      runtimeState: view.runtimeState,
    });
    // A stop that is still not confirmed stays said until the service settles it.
    if (state.phase !== "cancelling") hint = null;
    render();
    return "continue";
  }

  async function checkOnce(token) {
    const id = state.conversationId;
    const requestId = state.requestId;
    if (!id || !requestId) return "terminal";
    let result = await client.status({ conversationId: id, requestId });
    if (result.kind === "unavailable" && result.status === 401) {
      result = await afterRenewingTheSession(() => client.status({ conversationId: id, requestId }), result);
    }
    if (token !== turn) return "terminal";
    if (result.kind === "gone") {
      conversationGone();
      return "terminal";
    }
    if (result.kind === "view") {
      const verdict = await applyStatus(token, result.view);
      if (verdict === "continue" && token === turn && ["running", "accepted"].includes(result.view.outcome)) {
        // The events are a snapshot of what is queued: looking again now and then shows the answer growing.
        if (["none", "eof"].includes(lastStream.kind) && now() - lastStreamAt >= 1000) {
          await streamTurn(token);
          if (token === turn && ["done", "error"].includes(lastStream.kind)) return "again";
        }
      }
      return token === turn ? verdict : "terminal";
    }
    // The status could not be read (the service is in trouble, or its answer is not a status):
    // the history may still tell, otherwise the next round tries again.
    lastCheck = describeCheck("unavailable");
    const verdict = await answerFromHistory(token, { authoritative: false });
    if (verdict === "continue" && token === turn) {
      if (lastStream.kind === "error") {
        await failTurn({ source: "stream", message: lastStream.message });
        return "terminal";
      }
      if (hint !== "history_unavailable") hint = "status_unavailable";
      render();
    }
    return verdict;
  }

  async function safeCheck(token) {
    try {
      return await checkOnce(token);
    } catch {
      if (token !== turn) return "terminal";
      hint = "status_unavailable";
      render();
      return "continue";
    }
  }

  async function runLoop(entry) {
    const token = entry.token;
    let attempt = 0;
    for (;;) {
      if (token !== turn) return;
      const verdict = await safeCheck(token);
      entry.releaseFirst();
      if (token !== turn || verdict === "terminal") return;
      if (now() >= entry.deadline) {
        goUnresolved();
        return;
      }
      if (verdict === "again") continue;
      attempt += 1;
      const elapsedMs = state.sentAt == null ? 0 : Math.max(0, now() - state.sentAt);
      await sleep(Math.min(pollDelay(attempt, elapsedMs), Math.max(0, entry.deadline - now())), token, "loop");
      if (entry.kicked) {
        entry.kicked = false;
        attempt = 0;
      }
    }
  }

  /** Start (or wake) the bounded checking of the tracked request. Resolves after the first check. */
  function startLoop(token, { manual = false } = {}) {
    if (loop && loop.token === token) {
      if (manual) {
        loop.kicked = true;
        loop.deadline = Math.max(loop.deadline, now() + wait.manualWindowMs);
        wake("loop");
      }
      return loop.first;
    }
    const entry = { token, kicked: false, deadline: 0, first: null, releaseFirst: null };
    entry.first = new Promise((resolve) => {
      entry.releaseFirst = resolve;
    });
    const started = state.sentAt ?? now();
    entry.deadline = manual ? now() + wait.manualWindowMs : Math.max(started + wait.pollWindowMs, now());
    loop = entry;
    void runLoop(entry)
      .catch(() => {})
      .finally(() => {
        entry.releaseFirst();
        if (loop === entry) loop = null;
      });
    return entry.first;
  }

  /** Tell the visitor how long this has been going on, at the 15 and 60 second marks. */
  async function ticker(token) {
    if (tickerToken === token) return;
    tickerToken = token;
    try {
      for (const mark of [STILL_WORKING_MS, LONG_WAIT_MS]) {
        for (;;) {
          if (token !== turn || !PENDING_PHASES.has(state.phase) || state.sentAt == null) return;
          const remaining = state.sentAt + mark - now();
          if (remaining <= 0) break;
          if (!(await sleep(remaining, token, "tick"))) return;
        }
        render();
      }
    } finally {
      if (tickerToken === token) tickerToken = null;
    }
  }

  /* ---------------- the event stream ---------------- */

  async function readWithIdle(reader, token) {
    const idle = sleep(wait.streamIdleMs, token, "idle").then((elapsed) => (elapsed ? IDLE : null));
    try {
      const winner = await Promise.race([reader.read(), idle]);
      return winner;
    } finally {
      wake("idle");
    }
  }

  /**
   * Whether an envelope belongs to the turn being tracked. One that names another run or another
   * native work (a former connection, an older answer) is not this turn's and is ignored.
   */
  function isCurrentEnvelope(envelope) {
    if (!envelope || typeof envelope !== "object") return true;
    const { activeAgentRunId: runId, nativeWorkRef } = envelope;
    if (typeof runId === "string" && state.runId && runId !== state.runId) return false;
    if (typeof nativeWorkRef === "string" && state.nativeWorkRef && nativeWorkRef !== state.nativeWorkRef) return false;
    return true;
  }

  /** The first envelopes of a turn tell its run and native work when the accepted response did not. */
  function noteEnvelope(envelope) {
    if (!envelope || typeof envelope !== "object") return;
    const known = { runId: state.runId, nativeWorkRef: state.nativeWorkRef };
    const runId = state.runId ? null : envelope.activeAgentRunId;
    const nativeWorkRef = state.nativeWorkRef ? null : envelope.nativeWorkRef;
    if ((runId && runId !== known.runId) || (nativeWorkRef && nativeWorkRef !== known.nativeWorkRef)) {
      apply({ type: "correlation", runId, nativeWorkRef });
    }
  }

  /**
   * Follow the events of the running turn into the answer row. Returns how the stream ended:
   * "done" or "error" (the stream said so), "eof" (it ended without saying), "interrupted" (it broke
   * or went silent), "unavailable" (there is none). Nothing here decides the outcome of the turn.
   */
  async function streamTurn(token) {
    const id = state.conversationId;
    if (!id || token !== turn || streaming) return { kind: "unavailable" };
    streaming = true;
    let result = { kind: "eof" };
    let reader = null;
    try {
      let response;
      const abort = typeof AbortController === "function" ? new AbortController() : null;
      try {
        // A connection that never answers must not stop the checking of the turn.
        const opening = client.events(id, { signal: abort ? abort.signal : undefined });
        const timeout = sleep(wait.streamOpenMs, token, "open").then((passed) => (passed ? OPEN_TIMEOUT : null));
        response = await Promise.race([opening, timeout]);
        wake("open");
        if (response === OPEN_TIMEOUT || response === null) {
          if (abort) abort.abort();
          void opening.then((late) => late && late.body && late.body.cancel && late.body.cancel(), () => {}).catch(() => {});
          result = response === null ? { kind: "stale" } : { kind: "interrupted" };
          return result;
        }
      } catch {
        wake("open");
        result = { kind: "interrupted" };
        return result;
      }
      if (token !== turn) return { kind: "stale" };
      if (!response || !response.ok || !response.body || typeof response.body.getReader !== "function") {
        result = { kind: "unavailable" };
        return result;
      }
      reader = response.body.getReader();
      const seen = new Set();
      const chunks = (async function* read() {
        for (;;) {
          const next = await readWithIdle(reader, token);
          if (next === IDLE) {
            result = { kind: "interrupted" };
            return;
          }
          if (next === null || next.done) return;
          yield next.value;
        }
      })();
      try {
        for await (const event of parseSse(chunks)) {
          if (token !== turn) {
            result = { kind: "stale" };
            break;
          }
          const envelope = event && typeof event === "object" ? event : null;
          const payload = envelope && envelope.event && typeof envelope.event === "object" ? envelope.event : envelope;
          if (!payload || typeof payload.type !== "string") continue;
          if (envelope.connection_id != null && Number.isInteger(envelope.sequence)) {
            const frameId = `${envelope.connection_id}:${envelope.sequence}`;
            if (seen.has(frameId)) continue;
            seen.add(frameId);
          }
          if (!isCurrentEnvelope(envelope)) continue;
          noteEnvelope(envelope);
          if (payload.type === "text_delta") {
            streamText += typeof payload.text === "string" ? payload.text : "";
            render();
          } else if (payload.type === "output_reset") {
            streamText = "";
            render();
          } else if (payload.type === "session_status") {
            if (["recovering", "restoring"].includes(payload.status) && state.phase === "running") apply({ type: "recovering" });
            else if (["running", "starting", "warm_idle"].includes(payload.status) && state.phase === "recovering") {
              apply({ type: "status_checked", outcome: "running" });
            }
            render();
          } else if (payload.type === "done") {
            result = { kind: "done" };
            break;
          } else if (payload.type === "error") {
            result = { kind: "error", code: String(payload.code || ""), message: String(payload.message || ""), retryable: payload.retryable === true };
            break;
          }
        }
      } catch {
        result = { kind: "interrupted" };
      }
      return result;
    } finally {
      streaming = false;
      if (reader) void Promise.resolve(reader.cancel()).catch(() => {});
      if (token === turn) {
        lastStream = result;
        lastStreamAt = now();
        if (result.kind === "interrupted" && PENDING_PHASES.has(state.phase) && state.phase !== "cancelling") {
          hint = "stream_interrupted";
          apply({ type: "acceptance_lost" });
        }
        render();
      }
    }
  }

  /* ---------------- tracking a turn ---------------- */

  /** The tracked turn is accepted or being recovered: say how long it takes, follow it, check it. */
  function beginTurn(token, { attach }) {
    hint = null;
    lastCheck = null;
    streamText = "";
    lastStream = { kind: "none" };
    lastStreamAt = -Infinity;
    doneAt = null;
    knownCompleted = false;
    questionArrived = false;
    void ticker(token);
    return (async () => {
      try {
        if (attach) await streamTurn(token);
      } catch {
        /* the checks below decide the outcome */
      }
      if (token !== turn) return;
      await startLoop(token);
    })();
  }

  /* ---------------- sending ---------------- */

  function refuseBeforeSend(result, provider) {
    const alternative = otherAvailable(provider);
    if (result.status === 401 || result.status === 403) sessionAt = null;
    const unauth = ["unauthenticated", "csrf_rejected", "origin_rejected"].includes(result.code);
    // Nothing was sent in any of these cases, so the question goes back into the box and the pause is the usual one.
    const notice = unauth
      ? rejectionNotice({ code: result.code })
      : creationNotice({ kind: result.kind, code: result.code, provider, alternative });
    apply({ type: "rejected", notice, restoreDraft: true });
    render();
  }

  function refuseMessage(result) {
    if (result.status === 401 || result.status === 403) sessionAt = null;
    const notice = rejectionNotice({
      status: result.status,
      code: result.code,
      message: result.message,
      retryAfter: result.retryAfter,
      provider: state.provider,
      alternative: otherAvailable(state.provider),
    });
    apply({ type: "rejected", notice, restoreDraft: true });
    render();
  }

  /**
   * The chat could not start (no visitor session): ask again a few times with growing gaps, so the
   * page leaves "unavailable" by itself when the service comes back. A send tries the session too.
   */
  async function retryBoot(token) {
    for (const delay of wait.bootRetryDelaysMs) {
      if (!(await sleep(delay, token, "boot"))) return;
      if (state.phase !== "unavailable") return;
      try {
        await ensureSession(true);
      } catch {
        continue;
      }
      if (token !== turn || state.phase !== "unavailable") return;
      apply({ type: "recovered" });
      render();
      await Promise.allSettled([loadProviders(), state.conversationId ? loadHistory() : null]);
      render();
      return;
    }
  }

  /** The service may have the question and nobody knows: track it, never resend it. */
  async function trackUnconfirmed(token) {
    hint = null;
    apply({ type: "acceptance_lost" });
    render();
    await beginTurn(token, { attach: false });
  }

  function dropNewConfirmation() {
    confirmingNew = false;
  }

  const controller = {
    async boot(view) {
      if (view) lastView = view;
      invalidate();
      const token = turn;
      let sessionOk = true;
      try {
        await ensureSession(true);
      } catch {
        sessionOk = false;
      }
      if (token !== turn) return;
      // A chat that could not start before the reload starts now; one that cannot start says so and keeps trying.
      if (sessionOk && state.phase === "unavailable") apply({ type: "recovered" });
      const unavailable = !sessionOk && (state.phase === "ready" || state.phase === "unavailable");
      if (unavailable && state.phase === "ready") {
        apply({ type: "unavailable", notice: { kind: "error", text: SESSION_FAILED_TEXT }, restoreDraft: false });
      }
      booted = true;
      render();
      if (unavailable) void retryBoot(token);
      const jobs = [loadProviders()];
      if (state.conversationId) jobs.push(loadHistory());
      if (state.conversationId && state.requestId && state.phase === "reconciling") jobs.push(beginTurn(token, { attach: false }));
      await Promise.allSettled(jobs);
      render();
    },

    /**
     * One activation is at most one logical question. `options.retry` sends the pending question
     * again with its own request id, and only when the status said it never started.
     */
    async send(view, text, options = {}) {
      if (view) lastView = view;
      const retrying = options.retry === true;
      if (sending || sendBlocked(state.phase)) {
        render();
        return { sent: false, reason: "busy" };
      }
      if (retrying && !(state.phase === "failed" && state.resubmission && state.requestId && state.submitted)) {
        render();
        return { sent: false, reason: "not_allowed" };
      }
      const body = retrying ? state.submitted : String(text ?? "");
      if (body.trim() === "") {
        apply({ type: "notice", notice: { kind: "info", text: "Write a question first, then press Send." } });
        render();
        return { sent: false, reason: "empty" };
      }
      if (byteLength(body) > MAX_MESSAGE_BYTES) {
        apply({ type: "notice", notice: rejectionNotice({ code: "message_too_large" }) });
        render();
        return { sent: false, reason: "too_large" };
      }
      sending = true;
      dropNewConfirmation();
      invalidate();
      const token = turn;
      let posted = false;
      try {
        if (retrying) apply({ type: "resubmit", at: now() });
        else {
          apply({
            type: "submit",
            requestId: makeRequestId(),
            text: body,
            baseline: baselineOf(state.conversationId ? serverItems : []),
            at: now(),
          });
        }
        streamText = "";
        hint = null;
        lastCheck = null;
        render();
        // The service can take 20 to 40 s to accept a first question: the line must keep up while the POST is open.
        void ticker(token);
        try {
          await ensureSession();
        } catch {
          if (token !== turn) return { sent: false, reason: "stale" };
          apply({ type: "rejected", notice: { kind: "error", text: SESSION_FAILED_TEXT }, restoreDraft: true });
          render();
          return { sent: false, reason: "session" };
        }
        if (token !== turn) return { sent: false, reason: "stale" };
        if (!state.conversationId) {
          const provider = options.provider && validProvider(options.provider) ? options.provider : currentProvider();
          const created = await client.createConversation(provider);
          if (token !== turn) return { sent: false, reason: "stale" };
          if (created.kind !== "created") {
            refuseBeforeSend(created, provider);
            return { sent: false, reason: created.kind };
          }
          apply({ type: "conversation_created", id: created.id, provider: created.provider || provider });
          serverItems = [];
          historyState = { kind: "idle", text: "" };
          render();
        }
        if (!retrying && state.baseline === null && serverItems === null) {
          // The history could not be read before: learn where it stands now, before the question goes out,
          // or this turn's answer could not be told from an older one later.
          const before = await client.history(state.conversationId);
          if (token !== turn) return { sent: false, reason: "stale" };
          if (before.kind === "ok") {
            adoptItems(before.items);
            apply({ type: "baseline_known", baseline: baselineOf(before.items) });
          }
        }
        posted = true;
        let result = await client.sendMessage({ conversationId: state.conversationId, requestId: state.requestId, message: body });
        for (let again = 0; again < BUSY_RETRY_DELAYS_MS.length && result.kind === "rejected" && result.code === "conversation_busy" && now() - lastSettledAt < BUSY_GRACE_MS; again += 1) {
          if (token !== turn) return { sent: false, reason: "stale" };
          hint = "previous_finishing";
          render();
          if (!(await sleep(BUSY_RETRY_DELAYS_MS[again], token, "busy"))) return { sent: false, reason: "stale" };
          result = await client.sendMessage({ conversationId: state.conversationId, requestId: state.requestId, message: body });
        }
        hint = hint === "previous_finishing" ? null : hint;
        if (token !== turn) return { sent: true, reason: "stale" };
        if (result.kind === "accepted") {
          apply({ type: "accepted", runId: result.runId, nativeWorkRef: result.nativeWorkRef });
          render();
          void beginTurn(token, { attach: true });
          return { sent: true, reason: "" };
        }
        if (result.kind === "rejected") {
          refuseMessage(result);
          return { sent: false, reason: result.code || "rejected" };
        }
        // "lost" (no answer, or an unconfirmed acceptance) and "duplicate" (already current): ask, never resend.
        await trackUnconfirmed(token);
        return { sent: true, reason: result.kind };
      } catch {
        if (token !== turn) return { sent: false, reason: "stale" };
        if (posted) {
          await trackUnconfirmed(token);
          return { sent: true, reason: "lost" };
        }
        apply({ type: "rejected", notice: { kind: "error", text: SESSION_FAILED_TEXT }, restoreDraft: true });
        render();
        return { sent: false, reason: "error" };
      } finally {
        sending = false;
        render();
      }
    },

    async reload(view) {
      invalidate();
      loop = null;
      streaming = false;
      tickerToken = null;
      sending = false;
      serverItems = null;
      historyState = { kind: "idle", text: "" };
      streamText = "";
      lastStream = { kind: "none" };
      hint = null;
      lastCheck = null;
      confirmingNew = false;
      booted = false;
      state = restoreSession(storage);
      render(view);
      await this.boot(view);
    },

    focus(view) {
      state = reduceClientState(state, { type: "focus" });
      render(view);
    },

    stream(chunks) {
      return parseSse(chunks);
    },

    /** The visitor's unsent text, saved as it changes. A late response never writes over it. */
    editDraft(view, text) {
      if (view) lastView = view;
      const value = String(text ?? "");
      if (value === state.draft) return;
      apply({ type: "edit_draft", text: value });
      if (lastView) lastView.draft = state.draft;
    },

    selectProvider(view, provider) {
      if (view) lastView = view;
      const value = validProvider(provider);
      if (value && !state.conversationId && providerChoices().some((choice) => choice.provider === value && choice.available)) chosen = value;
      render();
    },

    /**
     * Read the conversation again (after an error, by the history retry button). A pending question is
     * finished only by an answer NEWER than it, never by any assistant row the list happens to hold.
     */
    async showHistory(view) {
      if (view) lastView = view;
      const result = await loadHistory();
      if (result && result.kind === "ok" && pendingContext() && PENDING_PHASES.has(state.phase)) {
        await answerFromHistory(turn, { authoritative: false, loaded: result, explain: false });
      }
      render();
      return result;
    },

    retryHistory(view) {
      return this.showHistory(view);
    },

    /** Follow the running turn's events. The outcome is decided by the status and the history, not here. */
    async follow(view) {
      if (view) lastView = view;
      const result = await streamTurn(turn);
      render();
      return result;
    },

    /** Check the tracked question's status now, then keep checking for another bounded round. */
    async checkStatus(view) {
      if (view) lastView = view;
      dropNewConfirmation();
      if (!state.requestId || !state.conversationId || state.phase === "submitting" || sending) {
        render();
        return;
      }
      if (state.phase === "unresolved") {
        apply({ type: "acceptance_lost" });
        hint = null;
        invalidate();
      }
      render();
      await startLoop(turn, { manual: true });
    },

    /** Ask the service to stop the running turn. The result shown is the one it returned. */
    async cancel(view) {
      if (view) lastView = view;
      dropNewConfirmation();
      if (!state.runId || !state.conversationId || !PENDING_PHASES.has(state.phase) || state.phase === "cancelling" || state.phase === "submitting") {
        render();
        return;
      }
      const token = turn;
      const { conversationId, runId } = state;
      apply({ type: "cancel_requested" });
      hint = null;
      render();
      const result = await client.cancel({ conversationId, runId });
      if (token !== turn) return;
      if (result.kind === "gone") {
        conversationGone();
        return;
      }
      if (result.kind === "view") {
        lastCheck = describeCheck(result.view.outcome);
        if (result.view.outcome === "cancelled") {
          await cancelTurn();
          return;
        }
        if (result.view.outcome === "failed") {
          await failTurn({ source: "status" });
          return;
        }
        if (result.view.outcome === "completed") {
          knownCompleted = true;
          const verdict = await answerFromHistory(token, { authoritative: true });
          if (verdict === "terminal") return;
        }
      }
      // A stop was requested; whether it took effect is not known yet.
      hint = "cancel_unconfirmed";
      render();
      void startLoop(token, { manual: true });
    },

    /** The first activation explains what a new conversation clears; the second one starts it. */
    newConversation(view) {
      if (view) lastView = view;
      if (!state.conversationId && !state.requestId) {
        render();
        return { confirmed: false };
      }
      if (sending) return { confirmed: false };
      if (!confirmingNew) {
        confirmingNew = true;
        render();
        return { confirmed: false };
      }
      confirmingNew = false;
      invalidate();
      loop = null;
      serverItems = null;
      historyState = { kind: "idle", text: "" };
      streamText = "";
      lastStream = { kind: "none" };
      hint = null;
      lastCheck = null;
      apply({ type: "new_conversation", notice: newConversationNotice() });
      render();
      return { confirmed: true };
    },

    cancelNewConversation(view) {
      if (view) lastView = view;
      if (!confirmingNew) return;
      confirmingNew = false;
      render();
    },

    /** Stop everything this controller is doing in the background (tests, and a page that is going away). */
    dispose() {
      invalidate();
      loop = null;
    },

    /** For tests: how many background jobs are alive, and a copy of what the controller knows. */
    activity() {
      return { loop: loop !== null, streaming, ticking: tickerToken !== null, sending, sleepers: sleepers.size };
    },

    inspect() {
      return {
        state: JSON.parse(JSON.stringify(state)),
        items: serverItems ? JSON.parse(JSON.stringify(serverItems)) : null,
        streamText,
        hint,
        lastStream,
        historyState,
        providers: providers ? JSON.parse(JSON.stringify(providers)) : null,
      };
    },
  };

  return controller;
}

function browserStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The DOM side: it paints what the controller says and forwards the visitor's actions. */
function wire() {
  const form = document.querySelector("#composer");
  if (!form) return;
  const find = (selector) => document.querySelector(selector);
  const draft = find("#draft");
  const send = find("#send");
  const cancel = find("#cancel");
  const checkStatus = find("#check-status");
  const retry = find("#retry");
  const newConversation = find("#new-conversation");
  const phase = find("#phase");
  const provider = find("#provider");
  const history = find("#history");
  const status = find("#chat-status");
  const historyState = find("#history-state");
  const historyText = find("#history-state-text");
  const historyRetry = find("#history-retry");
  const view = { phase: "", draft: "", sendDisabled: false, providerFixed: false, booted: false };
  const controller = createController({ storage: browserStorage() });
  let paintedRevision = -1;
  let retrying = false;

  function show(element, visible) {
    if (element) element.hidden = !visible;
  }

  function paintRows() {
    if (!history || !Array.isArray(view.rows)) return;
    const rows = view.rows;
    const items = Array.from(history.children);
    let at = 0;
    while (at < rows.length && at < items.length && items[at].dataset.key === rows[at].key && items[at].dataset.role === rows[at].role) {
      const text = items[at].querySelector("p");
      if (text && text.textContent !== rows[at].text) text.textContent = rows[at].text;
      at += 1;
    }
    for (let i = items.length - 1; i >= at; i -= 1) items[i].remove();
    for (let i = at; i < rows.length; i += 1) {
      const li = renderHistoryItem({ text: rows[i].text, role: rows[i].role }, history);
      li.dataset.key = rows[i].key;
      li.dataset.role = rows[i].role;
      if (rows[i].provisional) li.dataset.provisional = "true";
      if (rows[i].pending) li.dataset.pending = "true";
    }
  }

  function paintProviders() {
    if (!provider || !Array.isArray(view.providers)) return;
    for (const option of Array.from(provider.options)) {
      const choice = view.providers.find((entry) => entry.provider === option.value);
      if (!choice) continue;
      if (!option.dataset.label) option.dataset.label = option.textContent.trim();
      option.disabled = !choice.available;
      const label = choice.available ? option.dataset.label : `${option.dataset.label} (${choice.reason})`;
      if (option.textContent !== label) option.textContent = label;
    }
    if (view.provider && provider.value !== view.provider) provider.value = view.provider;
    provider.disabled = view.providerFixed;
  }

  function paint() {
    if (phase && view.booted && phase.textContent !== view.phase) phase.textContent = view.phase;
    if (send) send.disabled = view.sendDisabled;
    const actions = view.actions || {};
    if (cancel) {
      show(cancel, Boolean(actions.cancel));
      cancel.disabled = Boolean(actions.cancelDisabled);
    }
    show(checkStatus, Boolean(actions.checkStatus));
    show(retry, Boolean(actions.retry));
    if (newConversation) {
      show(newConversation, Boolean(actions.newConversation));
      if (actions.newConversationLabel && newConversation.textContent !== actions.newConversationLabel) {
        newConversation.textContent = actions.newConversationLabel;
      }
    }
    if (status && view.status) {
      if (status.textContent !== view.status.text) status.textContent = view.status.text;
      status.hidden = view.status.text === "";
      if (view.status.kind) status.dataset.kind = view.status.kind;
      else delete status.dataset.kind;
    }
    if (historyState && view.historyState) {
      const state = view.historyState;
      show(historyState, state.kind !== "idle");
      historyState.dataset.kind = state.kind;
      if (historyText && historyText.textContent !== state.text) historyText.textContent = state.text;
      show(historyRetry, state.kind === "failed" && !state.gone);
      if (history) history.setAttribute("aria-busy", state.kind === "loading" ? "true" : "false");
    }
    paintProviders();
    if (draft && view.draftRevision !== paintedRevision) {
      paintedRevision = view.draftRevision;
      if (draft.value !== view.draft) draft.value = view.draft;
    }
    paintRows();
  }

  view.onChange = paint;

  function saveDraft() {
    if (draft && !retrying) controller.editDraft(view, draft.value);
  }

  if (draft) {
    for (const type of ["input", "change", "blur", "cut", "keyup", "compositionupdate", "compositionend"]) draft.addEventListener(type, saveDraft);
    draft.addEventListener("paste", () => setTimeout(saveDraft, 0));
    draft.addEventListener("focus", () => {
      controller.focus(view);
    });
  }
  window.addEventListener("pagehide", saveDraft);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveDraft();
  });

  provider?.addEventListener("change", () => controller.selectProvider(view, provider.value));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (retrying) {
      void controller.send(view, "", { retry: true });
      return;
    }
    saveDraft();
    void controller.send(view, draft ? draft.value : "", { provider: provider ? provider.value : undefined });
  });

  cancel?.addEventListener("click", () => void controller.cancel(view));
  checkStatus?.addEventListener("click", () => void controller.checkStatus(view));
  retry?.addEventListener("click", () => {
    // The retry goes through the form like any question, so the Atlas sees it. The box shows the
    // question for that moment only; what the visitor has typed is put back right after.
    const typed = draft ? draft.value : "";
    if (draft) draft.value = view.retryText || "";
    retrying = true;
    try {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    } finally {
      retrying = false;
      if (draft) draft.value = typed;
    }
  });
  newConversation?.addEventListener("click", () => {
    const result = controller.newConversation(view);
    if (result.confirmed && draft) draft.focus();
  });
  newConversation?.addEventListener("blur", () => controller.cancelNewConversation(view));
  historyRetry?.addEventListener("click", () => void controller.retryHistory(view));

  void controller.boot(view);
}

if (typeof document !== "undefined") wire();
