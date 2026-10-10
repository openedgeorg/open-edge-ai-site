/**
 * A test double for the conversation client, mounted by the Atlas browser tests at /js/app.js
 * in place of site/js/app.js (see CHAT_SETUP in tests/e2e/atlas_browser_support.mjs). It lives
 * under tests/ and is never served by the site.
 *
 * Why it exists: the Atlas does not talk to the chat API. It watches what the conversation client
 * paints (#phase, #history, #draft) and works from that. To test the Atlas in a real browser the
 * page needs a client that paints in the same way, with the same awkward timing, on any checkout
 * of the repository. This file is that client, written as a single self-contained module from the
 * observable behaviour only. It imports nothing: not api.js, state.js, sse.js or render.js.
 *
 * What it reproduces (the things the Atlas bridge depends on):
 *  - the element ids #composer #provider #draft #send #cancel #phase #history;
 *  - #phase is empty until the first boot has finished, then shows the controller phase:
 *    ready, submitting, running, reconciling, rejected, recovering or unavailable;
 *  - boot: POST /visitor-session (JSON {subject_id, csrf_token}); every later POST carries the
 *    token in x-esp-csrf; /visitor-session is asked again before each send;
 *  - submit: the visitor's text is appended at once as a li>p row; POST /conversations once
 *    ({provider}); then POST /conversations/{id}/messages {conversation_id, client_request_id,
 *    message}. 200 with X-ESP-Acceptance: accepted means running; 409 (other than
 *    submission_unconfirmed), 429 and 503 mean rejected, and the text is kept as the draft; a lost
 *    answer or a 409 submission_unconfirmed means reconciling; anything else means unavailable;
 *  - then GET /conversations/{id}/events is followed (SSE frames data:{"type":"text_delta",...},
 *    ending at done or error) into an assistant li>p row, and the controller settles to ready;
 *  - then /history is polled (up to 30 times, 2 s apart) until ANY assistant item with text
 *    exists, and the whole list is replaced by the history items (li>p, text only);
 *  - #phase is only written after that whole cycle and when the message box gets focus. The
 *    controller is already "ready" while /history is still being polled, so a focus in between
 *    paints a premature "ready": the quirk the Atlas has to cope with;
 *  - the unfocused #draft is overwritten with the controller's draft at each paint;
 *  - the state is kept in sessionStorage under "esp-client" (ids and the draft, never replies).
 *    After a reload a pending request id or a "submitting"/"reconciling" phase comes back as
 *    reconciling, "rejected" comes back as rejected, everything else as ready;
 *  - createController({fetchImpl, storage}) returns boot, send, reload, focus, stream, showHistory
 *    and follow, because tests import it.
 *
 * What it is not: a model of the real client's source. It has none of its source rendering
 * (citation buttons, the source panel). Rows are text only.
 */

const STORAGE_KEY = "esp-client";
const HISTORY_TRIES = 30;
const HISTORY_GAP_MS = 2000;
const loose = new Map(); // used when sessionStorage is missing or throws

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- the controller's state -------------------------------------------------------------------

const fresh = () => ({
  phase: "ready",
  identity: null,
  provider: null,
  conversationId: null,
  draft: "",
  requestId: null,
  sendDisabled: false,
});

const BUSY = new Set(["submitting", "running", "reconciling"]);

/** Every way the state can change. Unknown names and ignored cases leave it as it was. */
const moves = {
  identity: (s, subject) => (s.identity ? s : { ...s, identity: String(subject) }),
  provider: (s, name) => (s.provider ? s : { ...s, provider: String(name), conversationId: null }),
  draft: (s, text) => (BUSY.has(s.phase) ? s : { ...s, draft: String(text) }),
  submit: (s, id) => ({ ...s, phase: "submitting", requestId: String(id), sendDisabled: true }),
  accepted: (s) => ({ ...s, phase: "running", draft: "", requestId: null, sendDisabled: true }),
  settled: (s) => (s.phase === "running" || s.phase === "reconciling" ? { ...s, phase: "ready", requestId: null, sendDisabled: false } : s),
  lost: (s) => ({ ...s, phase: "reconciling", sendDisabled: true }),
  checked: (s) => ({ ...s, phase: "reconciling", sendDisabled: true }),
  rejected: (s) => ({ ...s, phase: "rejected", sendDisabled: false }),
  unavailable: (s) => ({ ...s, phase: "unavailable", sendDisabled: true }),
};

function readSaved(storage) {
  let raw = null;
  try {
    if (storage && typeof storage.getItem === "function") raw = storage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw == null) raw = loose.get(STORAGE_KEY) ?? null;
  if (raw == null) return fresh();
  const saved = JSON.parse(String(raw));
  const s = fresh();
  s.identity = saved.identity ?? null;
  s.provider = saved.provider ?? null;
  s.conversationId = saved.conversationId ?? null;
  s.draft = typeof saved.draft === "string" ? saved.draft : "";
  s.requestId = saved.requestId ?? null;
  if (saved.phase === "rejected") {
    s.phase = "rejected";
  } else if (saved.phase === "submitting" || saved.phase === "reconciling" || s.requestId) {
    s.phase = "reconciling";
    s.sendDisabled = true;
  }
  return s;
}

function writeSaved(storage, s) {
  const text = JSON.stringify({
    identity: s.identity,
    provider: s.provider,
    conversationId: s.conversationId,
    draft: s.draft,
    requestId: s.requestId,
    phase: s.phase,
  });
  try {
    if (storage && typeof storage.setItem === "function") {
      storage.setItem(STORAGE_KEY, text);
      return;
    }
  } catch {
    /* storage refused: keep it for this page only */
  }
  loose.set(STORAGE_KEY, text);
}

// ---- reading an event stream ------------------------------------------------------------------

/** Yield the JSON payload of each `data:` frame of a byte stream (or of strings). */
async function* frames(source) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let pending = "";
  for await (const piece of source) {
    pending += typeof piece === "string" ? piece : decoder.decode(piece, { stream: true });
    pending = pending.replace(/\r\n/g, "\n");
    for (let cut = pending.indexOf("\n\n"); cut !== -1; cut = pending.indexOf("\n\n")) {
      const block = pending.slice(0, cut);
      pending = pending.slice(cut + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^\s+/, ""));
      if (data.length) yield JSON.parse(data.join("\n"));
    }
  }
}

async function* bodyChunks(body) {
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

// ---- rows -------------------------------------------------------------------------------------

/** One history row: li > p, text only. Nothing a model says is ever parsed as markup. */
export function renderHistoryItem(item, list) {
  const row = document.createElement("li");
  const p = document.createElement("p");
  p.textContent = String((item && item.text) ?? "");
  row.appendChild(p);
  list.appendChild(row);
  return row;
}

// ---- the controller ---------------------------------------------------------------------------

/**
 * @param {{fetchImpl?: typeof fetch, baseUrl?: string, storage?: Storage|null}} options
 */
export function createController({ fetchImpl, baseUrl = "", storage = null } = {}) {
  const net = fetchImpl || ((...args) => globalThis.fetch(...args));
  const root = String(baseUrl).replace(/\/$/, "");
  let csrf = "";
  let st = readSaved(storage);

  const apply = (name, arg) => {
    st = moves[name](st, arg);
  };
  const keep = () => writeSaved(storage, st);
  const sync = (view) => {
    view.phase = st.phase;
    view.draft = st.draft;
    view.sendDisabled = st.sendDisabled || st.phase === "submitting" || st.phase === "reconciling";
    view.providerFixed = st.provider != null && st.identity != null;
  };

  async function call(path, init = {}) {
    const verb = init.method || "GET";
    const headers = { accept: "application/json", ...(init.headers || {}) };
    if (csrf && verb !== "GET") headers["x-esp-csrf"] = csrf;
    return net(root + path, { credentials: "same-origin", ...init, headers });
  }

  const postJson = (path, payload) =>
    call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

  async function identify() {
    const reply = await call("/visitor-session", { method: "POST" });
    const body = await reply.json();
    if (body && typeof body.csrf_token === "string") csrf = body.csrf_token;
    if (st.identity) return;
    apply("identity", body.subject_id || body.subjectId);
    keep();
  }

  function pickedProvider() {
    if (typeof document === "undefined") return "openai";
    const select = document.querySelector("#provider");
    return select && select.value === "xai" ? "xai" : "openai";
  }

  async function openConversation() {
    if (st.conversationId) return;
    if (!st.provider) apply("provider", pickedProvider());
    const reply = await postJson("/conversations", { provider: st.provider });
    if (!reply.ok) {
      apply("unavailable");
      keep();
      return;
    }
    const body = await reply.json();
    st = { ...st, conversationId: body.id };
    keep();
  }

  async function recheck() {
    if (!st.conversationId || !st.requestId) return;
    const query = new URLSearchParams({ client_request_id: st.requestId });
    const reply = await call(`/conversations/${st.conversationId}/status?${query}`);
    await reply.json();
    apply("checked");
    keep();
  }

  /** Post the message and say how it went: accepted, lost, rejected or unavailable. */
  async function deliver(conversationId, requestId, message) {
    let reply;
    try {
      reply = await postJson(`/conversations/${conversationId}/messages`, {
        conversation_id: conversationId,
        client_request_id: requestId,
        message,
      });
    } catch {
      return "lost";
    }
    if (reply.status === 200) {
      if (reply.body && typeof reply.body.cancel === "function") void reply.body.cancel();
      return reply.headers.get("X-ESP-Acceptance") === "accepted" ? "accepted" : "lost";
    }
    if (reply.status === 409) {
      const body = await reply.json().catch(() => ({}));
      return body.error && body.error.code === "submission_unconfirmed" ? "lost" : "rejected";
    }
    if (reply.status === 429 || reply.status === 503) {
      await reply.json().catch(() => ({}));
      return "rejected";
    }
    return "unavailable";
  }

  const controller = {
    async boot(view) {
      await identify();
      if (st.phase === "reconciling" && st.requestId) await recheck();
      sync(view);
    },

    async send(view, text) {
      sync(view);
      if (view.sendDisabled) return;
      await identify();
      await openConversation();
      if (st.phase === "unavailable") {
        sync(view);
        return;
      }
      const requestId = st.requestId || crypto.randomUUID();
      apply("draft", text);
      apply("submit", requestId);
      keep();
      sync(view);
      const outcome = await deliver(st.conversationId, requestId, text);
      if (outcome === "lost") {
        apply("lost");
        await recheck();
      } else {
        apply(outcome);
      }
      keep();
      sync(view);
    },

    async reload(view) {
      st = readSaved(storage);
      sync(view);
      await controller.boot(view);
    },

    focus(view) {
      sync(view);
    },

    stream(chunks) {
      return frames(chunks);
    },

    /** Replace the list with the stored history, once an assistant reply is in it. */
    async showHistory() {
      if (!st.conversationId || typeof document === "undefined") return;
      for (let attempt = 1; attempt <= HISTORY_TRIES; attempt += 1) {
        let items = null;
        try {
          const reply = await call(`/conversations/${st.conversationId}/history`);
          const body = await reply.json();
          items = body && Array.isArray(body.items) ? body.items : null;
        } catch {
          items = null;
        }
        const withText = (it) => it && typeof it.text === "string" && it.text !== "";
        if (items && items.some((it) => it && it.role === "assistant" && withText(it))) {
          const list = document.querySelector("#history");
          if (list) {
            list.replaceChildren();
            for (const it of items) if (withText(it)) renderHistoryItem(it, list);
          }
          apply("settled");
          keep();
          return;
        }
        if (attempt < HISTORY_TRIES) await wait(HISTORY_GAP_MS);
      }
    },

    /** Follow the event stream into an assistant row, then settle (also when there is none). */
    async follow(view) {
      if (!st.conversationId || typeof document === "undefined") return;
      const reply = await call(`/conversations/${st.conversationId}/events`);
      const list = document.querySelector("#history");
      if (reply.ok && reply.body && list) {
        let text = "";
        let row = null;
        for await (const frame of frames(bodyChunks(reply.body))) {
          const payload = frame && frame.event ? frame.event : frame;
          if (payload && (payload.type === "done" || payload.type === "error")) break;
          if (!payload || payload.type !== "text_delta") continue;
          text += payload.text || "";
          if (row) row.querySelector("p").textContent = text;
          else row = renderHistoryItem({ text }, list);
        }
      }
      apply("settled");
      keep();
      sync(view);
    },
  };
  return controller;
}

// ---- the page ---------------------------------------------------------------------------------

function pageStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function mount() {
  const form = document.querySelector("#composer");
  if (!form) return;
  const draft = document.querySelector("#draft");
  const send = document.querySelector("#send");
  const phase = document.querySelector("#phase");
  const provider = document.querySelector("#provider");
  const view = { phase: "ready", draft: "", sendDisabled: false, providerFixed: false };
  const controller = createController({ storage: pageStorage() });

  const paint = () => {
    if (phase) phase.textContent = view.phase;
    if (send) send.disabled = view.sendDisabled;
    if (provider) provider.disabled = view.providerFixed;
    if (draft && document.activeElement !== draft) draft.value = view.draft;
  };

  if (draft) {
    draft.addEventListener("focus", () => {
      controller.focus(view);
      paint();
    });
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = draft ? draft.value : "";
    const list = document.querySelector("#history");
    if (list && text) renderHistoryItem({ text }, list);
    void controller.send(view, text).then(async () => {
      paint();
      if (view.phase === "running" || view.phase === "reconciling") await controller.follow(view);
      await controller.showHistory();
      paint();
    });
  });
  void controller.boot(view).then(paint);
}

if (typeof document !== "undefined") mount();
