import { validId, validProvider } from "./state.js";

/** The longest the page waits for one answer from the service before it treats the outcome as unknown. */
// `send` must outlast the service's own acceptance budget (90 s): a first question of a new conversation takes 20 to 40 s
// to be accepted, and a sender that gives up earlier leaves the service unable to match the request id to the work later.
export const TIMEOUTS = { session: 15000, read: 12000, create: 20000, send: 100000, cancel: 20000 };

const OUTCOMES = new Set(["accepted", "running", "completed", "not_started", "submission_unconfirmed", "cancelled", "failed"]);

function header(response, name) {
  try {
    const headers = response && response.headers;
    return headers && typeof headers.get === "function" ? headers.get(name) : null;
  } catch {
    return null;
  }
}

async function readJson(response) {
  try {
    const body = await response.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

function releaseBody(response) {
  try {
    const body = response && response.body;
    if (body && typeof body.cancel === "function") void Promise.resolve(body.cancel()).catch(() => {});
  } catch {
    /* nothing left to release */
  }
}

function errorOf(body) {
  const error = body && typeof body.error === "object" && body.error ? body.error : {};
  return {
    code: typeof error.code === "string" ? error.code : "",
    message: typeof error.message === "string" ? error.message : "",
    retryable: error.retryable === true,
  };
}

function retryAfterOf(response) {
  const value = Number.parseInt(String(header(response, "retry-after") ?? ""), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** A SubmissionView from the service, or null when the body is not one. */
export function normalizeView(body) {
  if (!body || typeof body.outcome !== "string" || !OUTCOMES.has(body.outcome)) return null;
  return {
    outcome: body.outcome,
    runId: validId(body.active_agent_run_id),
    nativeWorkRef: validId(body.native_work_ref, 400),
    resubmissionAllowed: body.resubmission_allowed === true,
    runtimeState: typeof body.runtime_state === "string" ? body.runtime_state : null,
  };
}

/**
 * The items of a /history body: native id (or null), the work they belong to, role, text and
 * whether they are still provisional. An item without a native id is told apart by its position.
 */
export function normalizeHistory(body) {
  if (!body || !Array.isArray(body.items)) return null;
  const items = [];
  const seen = new Set();
  for (const raw of body.items) {
    if (!raw || typeof raw !== "object") continue;
    const role = raw.role === "user" || raw.role === "assistant" ? raw.role : null;
    if (!role) continue;
    const id = typeof raw.native_item_id === "string" && raw.native_item_id.length > 0 && raw.native_item_id.length <= 400 ? raw.native_item_id : null;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    items.push({
      key: id || `#${items.length}`,
      role,
      text: typeof raw.text === "string" ? raw.text : "",
      workRef: typeof raw.native_work_ref === "string" && raw.native_work_ref ? raw.native_work_ref : null,
      provisional: raw.provisional === true,
    });
  }
  const raw = body.status && typeof body.status === "object" ? body.status : null;
  const status = raw
    ? {
        status: typeof raw.status === "string" ? raw.status : null,
        requestId: typeof raw.request_id === "string" ? raw.request_id : null,
        nativeWorkRef: typeof raw.native_work_ref === "string" && raw.native_work_ref ? raw.native_work_ref : null,
      }
    : null;
  return { items, status };
}

/**
 * The first server-sent frame of the accepted response names the run and the native work. The
 * rest of that response is not needed: it is released.
 */
async function acceptedDetails(response) {
  const none = { runId: null, nativeWorkRef: null };
  const type = String(header(response, "content-type") || "");
  const body = response.body;
  if (!/text\/event-stream/i.test(type) || !body || typeof body.getReader !== "function") {
    releaseBody(response);
    return none;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  try {
    for (let reads = 0; reads < 8 && !text.includes("\n\n"); reads += 1) {
      const next = await reader.read();
      if (next.done) break;
      text += typeof next.value === "string" ? next.value : decoder.decode(next.value, { stream: true });
      text = text.replaceAll("\r\n", "\n");
    }
  } catch {
    /* the frame is a convenience; the acceptance already stands */
  } finally {
    void Promise.resolve(reader.cancel()).catch(() => {});
  }
  const frame = text.split("\n\n")[0] || "";
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return none;
  try {
    const envelope = JSON.parse(data);
    return {
      runId: validId(envelope && envelope.activeAgentRunId),
      nativeWorkRef: validId(envelope && envelope.nativeWorkRef, 400),
    };
  } catch {
    return none;
  }
}

/**
 * @param {{fetchImpl?: typeof fetch, baseUrl?: string, setTimer?: Function, clearTimer?: Function, timeouts?: Partial<typeof TIMEOUTS>}} options
 */
export function createClient({ fetchImpl, baseUrl = "", setTimer, clearTimer, timeouts = {} } = {}) {
  const root = baseUrl.replace(/\/$/, "");
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const startTimer =
    setTimer ||
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      if (handle && typeof handle.unref === "function") handle.unref();
      return handle;
    });
  const stopTimer = clearTimer || ((handle) => clearTimeout(handle));
  const limit = { ...TIMEOUTS, ...timeouts };
  let csrfToken = "";

  /**
   * One request, with the answer read inside the same time limit. A request that hangs ends as an
   * error, which every caller treats as "outcome unknown", never as "not sent".
   */
  async function call(path, options, read) {
    const { timeoutMs = 0, ...init } = options;
    const headers = { accept: "application/json", ...(init.headers || {}) };
    if (csrfToken && (init.method || "GET") !== "GET") headers["x-esp-csrf"] = csrfToken;
    const controller = timeoutMs > 0 && typeof AbortController === "function" ? new AbortController() : null;
    const handle = controller ? startTimer(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await doFetch(`${root}${path}`, {
        credentials: "same-origin",
        ...init,
        headers,
        ...(controller ? { signal: controller.signal } : {}),
      });
      return await read(response);
    } finally {
      if (handle !== null) stopTimer(handle);
    }
  }

  const conversationPath = (id) => `/conversations/${encodeURIComponent(id)}`;

  return {
    /** Establish the visitor session and its CSRF token. Throws when the service cannot be reached or answers badly. */
    async visitorSession() {
      return call("/visitor-session", { method: "POST", timeoutMs: limit.session }, async (response) => {
        const body = await readJson(response);
        if (!response.ok || !body) throw new Error(`visitor session failed (${response.status})`);
        if (typeof body.csrf_token === "string" && body.csrf_token) csrfToken = body.csrf_token;
        // The service need not name the subject; an absent or invalid id is simply not known.
        return { subjectId: validId(body.subject_id ?? body.subjectId) };
      });
    },

    async providers() {
      try {
        return await call("/providers", { timeoutMs: limit.read }, async (response) => {
          const body = await readJson(response);
          if (!response.ok || !body || !Array.isArray(body.providers)) return { kind: "unavailable" };
          const providers = [];
          for (const entry of body.providers) {
            const provider = validProvider(entry && entry.provider);
            if (!provider) continue;
            providers.push({
              provider,
              available: entry.available === true,
              eligible: entry.eligible !== false,
              model: typeof entry.display_model === "string" ? entry.display_model : "",
            });
          }
          return { kind: "ok", providers };
        });
      } catch {
        return { kind: "unavailable" };
      }
    },

    async createConversation(provider) {
      try {
        return await call(
          "/conversations",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider }),
            timeoutMs: limit.create,
          },
          async (response) => {
            const body = await readJson(response);
            if (response.ok) {
              const id = validId(body && body.id);
              return id ? { kind: "created", id, provider: validProvider(body.provider) || provider } : { kind: "unavailable", status: response.status };
            }
            const error = errorOf(body);
            if (response.status === 503 && error.code === "provider_not_eligible") {
              return { kind: "refused", status: 503, code: error.code, message: error.message };
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408) {
              return { kind: "rejected", status: response.status, code: error.code, message: error.message };
            }
            return { kind: "unavailable", status: response.status, code: error.code };
          },
        );
      } catch {
        return { kind: "unavailable", status: 0 };
      }
    },

    /**
     * One submission. The result tells what is KNOWN about it:
     * - accepted: the service took the question (run and native work are named when it said so);
     * - duplicate: this request id was already current; `view` is its status;
     * - rejected: nothing was submitted (a clean refusal);
     * - lost: the outcome is unknown. It may have been received; it is never assumed not sent.
     */
    async sendMessage({ conversationId, requestId, message }) {
      try {
        return await call(
          `${conversationPath(conversationId)}/messages`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversation_id: conversationId, client_request_id: requestId, message }),
            timeoutMs: limit.send,
          },
          async (response) => {
            const acceptance = String(header(response, "x-esp-acceptance") || "").toLowerCase();
            if (response.status === 200) {
              if (acceptance === "accepted") return { kind: "accepted", ...(await acceptedDetails(response)) };
              if (acceptance === "duplicate") return { kind: "duplicate", view: normalizeView(await readJson(response)) };
              releaseBody(response);
              return { kind: "lost", reason: "no_acceptance" };
            }
            const body = await readJson(response);
            const error = errorOf(body);
            const status = response.status;
            if (status === 409 && error.code === "submission_unconfirmed") return { kind: "lost", reason: "unconfirmed" };
            const refusal = {
              kind: "rejected",
              status,
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              retryAfter: retryAfterOf(response),
            };
            // 409 and 429 are admission refusals; other 4xx are refused before anything is admitted.
            if (status === 409 || status === 429) return refusal;
            if (status >= 400 && status < 500 && status !== 408) return refusal;
            // A 503 that carries the service's own error body says "not submitted"; a bare gateway page does not.
            if (status === 503 && error.code && !(body && body.submitted === null)) return refusal;
            return { kind: "lost", reason: "server_error", status };
          },
        );
      } catch {
        return { kind: "lost", reason: "network" };
      }
    },

    /** The status of one request: `view` (normalized SubmissionView), `gone`, `unavailable` or `unreadable`. */
    async status({ conversationId, requestId }) {
      try {
        const query = new URLSearchParams({ client_request_id: requestId });
        return await call(`${conversationPath(conversationId)}/status?${query}`, { timeoutMs: limit.read }, async (response) => {
          const body = await readJson(response);
          if (response.status === 404) return { kind: "gone" };
          if (!response.ok) return { kind: "unavailable", status: response.status, code: errorOf(body).code };
          const view = normalizeView(body);
          return view ? { kind: "view", view } : { kind: "unreadable" };
        });
      } catch {
        return { kind: "unavailable", status: 0 };
      }
    },

    /** The conversation so far, from the service's own history: `ok`, `gone`, `unavailable` or `unreadable`. */
    async history(conversationId) {
      try {
        return await call(`${conversationPath(conversationId)}/history`, { timeoutMs: limit.read }, async (response) => {
          const body = await readJson(response);
          if (response.status === 404) return { kind: "gone" };
          if (!response.ok) {
            const error = errorOf(body);
            return { kind: "unavailable", status: response.status, code: error.code, retryable: error.retryable || response.status >= 500 };
          }
          const history = normalizeHistory(body);
          return history ? { kind: "ok", ...history } : { kind: "unreadable" };
        });
      } catch {
        return { kind: "unavailable", status: 0, retryable: true };
      }
    },

    /** Ask the service to stop a run. `view` carries the real result; a request that did not return is `lost`. */
    async cancel({ conversationId, runId }) {
      try {
        return await call(
          `${conversationPath(conversationId)}/runs/${encodeURIComponent(runId)}/cancel`,
          { method: "POST", timeoutMs: limit.cancel },
          async (response) => {
            const body = await readJson(response);
            if (response.status === 404) return { kind: "gone" };
            if (!response.ok) return { kind: "failed", status: response.status, code: errorOf(body).code };
            const view = normalizeView(body);
            return view ? { kind: "view", view } : { kind: "failed", status: response.status, code: "" };
          },
        );
      } catch {
        return { kind: "lost" };
      }
    },

    /** The event stream response (the caller reads it and may abort it with `signal`). A network failure throws. */
    async events(conversationId, { signal } = {}) {
      const headers = { accept: "text/event-stream" };
      return doFetch(`${root}${conversationPath(conversationId)}/events`, { credentials: "same-origin", headers, ...(signal ? { signal } : {}) });
    },
  };
}
