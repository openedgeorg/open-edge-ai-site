/**
 * What the visitor is told about a question, and how a history snapshot is tied to the question
 * that was just sent. Pure functions: no DOM, no network, no clock (the caller passes the time).
 *
 * Text is always handed to the page as text nodes. A server message is quoted at most once and
 * only as plain text.
 */

export const PROVIDER_LABELS = { openai: "OpenAI", xai: "xAI" };
export const PROVIDER_ORDER = ["openai", "xai"];

/** UX targets, not model latency guarantees and never a reason to resend (see the handoff). */
export const STILL_WORKING_MS = 15000;
export const LONG_WAIT_MS = 60000;

export function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || "The selected provider";
}

function clip(text, limit = 280) {
  const plain = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain;
}

/**
 * The status line for a request that is still being worked on.
 * @param {{phase: string}} state
 * @param {{elapsedMs: number, hint?: string|null, lastCheck?: string|null}} context
 * @returns {{kind: string, text: string}}
 */
export function describeBusy(state, { elapsedMs, hint = null, lastCheck = null }) {
  const long = elapsedMs >= LONG_WAIT_MS;
  const still = elapsedMs >= STILL_WORKING_MS;
  const check = lastCheck ? ` ${lastCheck}` : "";
  const longTail = " This is taking longer than usual. You can keep waiting, check the status, or start a new conversation.";
  switch (state.phase) {
    case "submitting":
      if (hint === "previous_finishing") {
        return { kind: "working", text: "The previous answer is just being wrapped up. Your question will go out in a moment." };
      }
      if (long) {
        return { kind: "long", text: `Your question is still being handed to the AI. A first question can take a minute or more to be accepted.${longTail}${check}` };
      }
      if (still) {
        return { kind: "waiting", text: `Still sending your question. Accepting a question can take up to a minute; it will not be sent twice.${check}` };
      }
      return { kind: "working", text: "Sending your question…" };
    case "cancelling":
      return {
        kind: "warning",
        text: `A stop was requested. Waiting for it to be confirmed; the AI may still finish this answer.${check}`,
      };
    case "recovering":
      return {
        kind: "warning",
        text: `The service is recovering. Your question is still being tracked, so there is no need to send it again.${check}`,
      };
    default:
      break;
  }
  if (hint === "answer_loading") {
    return { kind: "working", text: `The answer is finished and is being loaded.${check}` };
  }
  if (hint === "history_unavailable") {
    return { kind: "warning", text: `The answer may be ready, but the conversation cannot be read right now. Trying again shortly.${check}` };
  }
  if (state.phase === "reconciling") {
    let lead;
    if (hint === "stream_interrupted") {
      lead = "The live connection for this answer was interrupted. Your question was not lost; checking where it stands.";
    } else if (hint === "status_unavailable") {
      lead = "The status cannot be checked right now. Trying again shortly. Your question will not be sent again.";
    } else {
      lead =
        "We could not confirm that your question arrived. It may already be on its way, so it will not be sent again. Checking its status.";
    }
    return { kind: long ? "long" : "warning", text: `${lead}${long ? longTail : ""}${check}` };
  }
  const unreadable = hint === "status_unavailable" ? " Its status cannot be checked right now; trying again shortly." : "";
  if (long) return { kind: "long", text: `This is taking longer than usual. You can keep waiting, check the status, or start a new conversation.${unreadable}${check}` };
  if (still) {
    return {
      kind: "waiting",
      text: `Still working on your answer. This can take a minute or two; you can keep exploring the map meanwhile.${unreadable}${check}`,
    };
  }
  return { kind: "working", text: `Your question was received. The answer is being prepared.${unreadable}${check}` };
}

export const UNRESOLVED_TEXT =
  "We could not confirm what happened to your last question. It may or may not have been received, so it is not sent again. " +
  "You can check its status again or start a new conversation.";

export const ARRIVED_UNRESOLVED_TEXT =
  "Your question arrived, but no answer has come back yet. It is not sent again. " +
  "You can check again, keep exploring the map, or start a new conversation.";

export const COMPLETED_UNREADABLE_TEXT =
  "Your answer is finished, but the conversation could not be read to show it. It was not lost. " +
  "You can check again, or reload the page.";

/** What the last status check said, in one short sentence (shown beside the busy text). */
export function describeCheck(outcome) {
  switch (outcome) {
    case "running":
      return "Last check: the AI is still working on it.";
    case "accepted":
      return "Last check: your question was received and is waiting to start.";
    case "submission_unconfirmed":
      return "Last check: still not confirmed.";
    case "not_started":
      return "Last check: the question has not started yet.";
    case "unavailable":
      return "Last check: the status service did not answer.";
    default:
      return null;
  }
}

/**
 * A message the service refused before doing any work.
 * @param {{status?: number, code?: string, message?: string, retryAfter?: number|null, provider?: string|null, alternative?: string|null}} refusal
 */
export function rejectionNotice({ status = 0, code = "", message = "", retryAfter = null, provider = null, alternative = null } = {}) {
  const label = providerLabel(provider);
  const other = alternative ? ` Or start a new conversation with ${providerLabel(alternative)}.` : "";
  switch (code) {
    case "conversation_busy":
      return {
        kind: "error",
        text:
          "This conversation is still working on another message, so yours was not sent. Wait for that to finish and send it again, " +
          "or start a new conversation. Your message is back in the box.",
      };
    case "rate_limited": {
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? `about ${Math.ceil(retryAfter)} seconds` : "a moment";
      return { kind: "error", text: `You are sending messages too quickly. Nothing was sent. Wait ${wait}, then press Send again.` };
    }
    case "capacity_unavailable":
      return {
        kind: "error",
        text: `${label} has no capacity for another message right now, so yours was not sent. Try again in a moment.${other}`,
      };
    case "service_unavailable":
      return {
        kind: "error",
        text: `${label} or the conversation service is not available right now, so your message was not sent. Try again in a moment.${other}`,
      };
    case "provider_not_eligible":
      return {
        kind: "error",
        text: `${label} cannot take this conversation right now, so your message was not sent. Start a new conversation with another provider.${other}`,
      };
    case "not_found":
      return {
        kind: "gone",
        text:
          "This conversation is no longer available (it may belong to an earlier visit). Nothing was sent. " +
          "Start a new conversation to continue. Your message is still in the box.",
      };
    case "message_too_large":
    case "payload_too_large":
      return { kind: "error", text: "That message is too long to send (the limit is 8,192 bytes). Shorten it and press Send again." };
    case "unauthenticated":
    case "csrf_rejected":
    case "origin_rejected":
      return {
        kind: "error",
        text:
          "Your session could not be verified, so nothing was sent. It has been renewed. Press Send to try again; " +
          "if this keeps happening, reload the page.",
      };
    default: {
      const detail = clip(message, 160);
      const lead = status === 413 ? "That message is too long to send." : "The service did not accept that message, so nothing was sent.";
      return { kind: "error", text: `${lead}${detail ? ` (${detail})` : ""} Your message is back in the box.` };
    }
  }
}

/** A conversation could not be created: nothing was sent either. */
export function creationNotice({ kind, code = "", provider = null, alternative = null } = {}) {
  const label = providerLabel(provider);
  const other = alternative ? ` Or choose ${providerLabel(alternative)} instead.` : "";
  if (kind === "refused" || code === "provider_not_eligible") {
    return {
      kind: "error",
      text: `${label} cannot start a new conversation right now, so nothing was sent. Choose another provider, or try ${label} again later.${other}`,
    };
  }
  return {
    kind: "error",
    text: `A conversation with ${label} could not be started, so nothing was sent. Check your connection and press Send to try again.${other}`,
  };
}

export const SESSION_FAILED_TEXT =
  "The conversation service could not be reached. Nothing was sent. Check your connection and press Send to try again.";

/** The turn did not deliver an answer. `restored`: the question is back in the message box. */
export function failedNotice({ source = "status", message = "", restored = false } = {}) {
  const lead =
    source === "stream" && message
      ? `The answer could not be completed: ${clip(message, 200)}`
      : "The AI could not finish an answer to this question. Nothing more is happening for it.";
  const tail = restored
    ? " Your question is back in the message box; you can send it again or ask something else."
    : " You can send it again or ask something else.";
  return { kind: "error", text: `${lead}${tail}` };
}

export function notStartedNotice() {
  return {
    kind: "error",
    text: "Your question never reached the AI, so nothing was lost. You can send it again.",
  };
}

export function cancelledNotice() {
  return { kind: "info", text: "Cancelled. This question has no answer. Your earlier answers are unchanged." };
}

export function answerReadyNotice() {
  return { kind: "done", text: "The answer is ready." };
}

export function goneNotice() {
  return {
    kind: "gone",
    text: "This conversation is no longer available (it may belong to an earlier visit). Start a new conversation to continue.",
  };
}

export function newConversationConfirmText(pending = false) {
  const abandoned = pending ? " The question still waiting for an answer is abandoned." : "";
  return (
    "Starting a new conversation clears the answers shown here (they stay with the old conversation) and lets you pick a provider." +
    `${abandoned} Your map progress is kept. Press the button again to confirm.`
  );
}

export function newConversationNotice() {
  return {
    kind: "info",
    text: "New conversation. The earlier answers are no longer shown; your map progress is kept. Choose a provider and ask your first question.",
  };
}

export function historyLoadingText() {
  return "Loading the conversation so far…";
}

export function historyFailedText({ gone = false } = {}) {
  if (gone) return "This conversation is no longer available. Start a new conversation to continue.";
  return "The earlier messages could not be loaded. They are not lost; only the display failed.";
}

export function cancelUnconfirmedText() {
  return "We asked the AI to stop but could not confirm it yet. It may still finish this answer.";
}

/* ---------------- history correlation ---------------- */

function squash(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

/**
 * Where the history stood when a question was sent: how many items there were and the key of the
 * last one. Items are told apart by their native id, or by position when a history has none.
 * @param {Array<{key: string}>|null} items null when the history is not known
 */
export function baselineOf(items) {
  if (!Array.isArray(items)) return null;
  return { count: items.length, lastKey: items.length ? items[items.length - 1].key : null };
}

/**
 * The items that came after the baseline: the turn just sent and whatever answered it. With no
 * baseline (the history was unknown when the question was sent) the question itself is looked up
 * by its text, newest first; with no match nothing is new.
 */
export function itemsSince(items, baseline, submitted = "") {
  if (!Array.isArray(items)) return [];
  if (baseline && typeof baseline === "object") {
    if (baseline.lastKey == null) return baseline.count > 0 ? items.slice(baseline.count) : items.slice();
    const at = items.findIndex((item) => item.key === baseline.lastKey);
    if (at >= 0) return items.slice(at + 1);
    return items.slice(baseline.count);
  }
  const question = squash(submitted);
  if (!question) return [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].role === "user" && squash(items[i].text) === question) return items.slice(i);
  }
  return [];
}

/**
 * The final assistant rows of the pending turn, or null. An older answer never counts: only items
 * newer than the baseline do, and an item that is still provisional or empty is not final. When the
 * native work reference is known, an item that names another work is not this turn's.
 *
 * `authoritative`: the status said this very request completed. If then no item carries its work
 * reference at all (this history may name its works differently from the status), the question's own
 * position decides: the assistant rows after the newest user item with the question's text.
 * @param {Array<{key: string, role: string, text: string, provisional: boolean, workRef: string|null}>} items
 * @param {{baseline: object|null, submitted: string, nativeWorkRef: string|null}} pending
 * @param {{authoritative?: boolean}} [options]
 */
export function findAnswer(items, pending, { authoritative = false } = {}) {
  const final = (item) => item.role === "assistant" && item.text.trim() !== "" && !item.provisional;
  const answers = itemsSince(items, pending.baseline, pending.submitted).filter(final);
  if (!pending.nativeWorkRef) return answers.length ? answers : null;
  const ours = answers.filter((item) => !item.workRef || item.workRef === pending.nativeWorkRef);
  if (ours.length) return ours;
  if (!authoritative || answers.length === 0) return null;
  const byQuestion = itemsSince(items, null, pending.submitted).filter(final);
  return byQuestion.length ? byQuestion : null;
}

/** Whether the snapshot already lists the pending question as a user item newer than the baseline. */
export function listsQuestion(items, pending) {
  const question = squash(pending.submitted);
  return itemsSince(items, pending.baseline, pending.submitted).some(
    (item) => item.role === "user" && squash(item.text) === question,
  );
}
