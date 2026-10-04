import { createClient } from "./api.js";
import { parseSse } from "./sse.js";
import { persistSession, reduceClientState, restoreSession } from "./state.js";

/**
 * Development conversation controller. It does not claim Gate 1.
 * @param {{fetchImpl?: typeof fetch, baseUrl?: string, storage?: Storage|null}} options
 */
export function createController({ fetchImpl, baseUrl = "", storage = null } = {}) {
  const client = createClient({ fetchImpl, baseUrl });
  let state = restoreSession(storage);

  function render(view) {
    view.phase = state.phase;
    view.draft = state.draft;
    view.sendDisabled = state.sendDisabled || state.phase === "submitting" || state.phase === "reconciling";
    view.providerFixed = state.provider != null && state.identity != null;
  }

  async function ensureIdentity() {
    if (state.identity) return;
    const session = await client.visitorSession();
    state = reduceClientState(state, { type: "identity", subjectId: session.subject_id || session.subjectId });
    persistSession(storage, state);
  }

  async function ensureConversation() {
    if (state.conversationId) return;
    if (!state.provider) state = reduceClientState(state, { type: "choose_provider", provider: "openai" });
    const created = await client.createConversation(state.provider);
    if (created.kind !== "created") {
      state = reduceClientState(state, { type: "unavailable" });
      persistSession(storage, state);
      return;
    }
    state = { ...state, conversationId: created.id };
    persistSession(storage, state);
  }

  async function reconcile() {
    if (!state.conversationId || !state.requestId) return;
    await client.status({ conversationId: state.conversationId, requestId: state.requestId });
    state = reduceClientState(state, { type: "status_checked" });
    persistSession(storage, state);
  }

  return {
    async boot(view) {
      await ensureIdentity();
      if (state.phase === "reconciling" && state.requestId) await reconcile();
      render(view);
    },
    async send(view, text) {
      render(view);
      if (view.sendDisabled) return;
      await ensureIdentity();
      await ensureConversation();
      if (state.phase === "unavailable") {
        render(view);
        return;
      }
      const requestId = state.requestId || crypto.randomUUID();
      state = reduceClientState(state, { type: "edit_draft", text });
      state = reduceClientState(state, { type: "submit", requestId });
      persistSession(storage, state);
      render(view);
      const result = await client.sendMessage({
        conversationId: state.conversationId,
        requestId,
        message: text,
      });
      if (result.kind === "accepted") state = reduceClientState(state, { type: "accepted" });
      else if (result.kind === "lost") {
        state = reduceClientState(state, { type: "acceptance_lost" });
        await reconcile();
      } else if (result.kind === "rejected") state = reduceClientState(state, { type: "rejected" });
      else state = reduceClientState(state, { type: "unavailable" });
      persistSession(storage, state);
      render(view);
    },
    async reload(view) {
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
  };
}

function browserStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function wire() {
  const form = document.querySelector("#composer");
  if (!form) return;
  const draft = document.querySelector("#draft");
  const send = document.querySelector("#send");
  const phase = document.querySelector("#phase");
  const provider = document.querySelector("#provider");
  const view = { phase: "ready", draft: "", sendDisabled: false, providerFixed: false };
  const controller = createController({ storage: browserStorage() });

  function paint() {
    if (phase) phase.textContent = view.phase;
    if (send) send.disabled = view.sendDisabled;
    if (provider) provider.disabled = view.providerFixed;
    if (draft && document.activeElement !== draft) draft.value = view.draft;
  }

  provider?.addEventListener("change", () => {
    /* Provider is fixed once a conversation identity exists. The reducer ignores a second choice. */
  });
  draft?.addEventListener("focus", () => {
    controller.focus(view);
    paint();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = draft ? draft.value : "";
    void controller.send(view, text).then(paint);
  });
  void controller.boot(view).then(paint);
}

if (typeof document !== "undefined") wire();
