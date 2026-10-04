/**
 * @param {{fetchImpl?: typeof fetch, baseUrl?: string}} options
 */
export function createClient({ fetchImpl = fetch, baseUrl = "" } = {}) {
  const root = baseUrl.replace(/\/$/, "");

  async function request(path, options = {}) {
    const response = await fetchImpl(`${root}${path}`, {
      credentials: "same-origin",
      ...options,
      headers: { accept: "application/json", ...(options.headers || {}) },
    });
    return response;
  }

  return {
    async visitorSession() {
      const response = await request("/visitor-session", { method: "POST" });
      return response.json();
    },
    async providers() {
      const response = await request("/providers");
      return response.json();
    },
    async createConversation(provider) {
      const response = await request("/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (!response.ok) return { kind: "rejected", status: response.status };
      const body = await response.json();
      return { kind: "created", id: body.id };
    },
    async sendMessage({ conversationId, requestId, message }) {
      let response;
      try {
        response = await request(`/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversationId,
            client_request_id: requestId,
            message,
          }),
        });
      } catch {
        return { kind: "lost" };
      }
      if (response.status === 200) {
        const accepted = response.headers.get("X-ESP-Acceptance") === "accepted";
        return accepted ? { kind: "accepted" } : { kind: "lost" };
      }
      if (response.status === 409) {
        const body = await response.json().catch(() => ({}));
        if (body.error && body.error.code === "submission_unconfirmed") return { kind: "lost" };
        return { kind: "rejected", code: body.error ? body.error.code : "conflict" };
      }
      if (response.status === 429 || response.status === 503) {
        const body = await response.json().catch(() => ({}));
        return { kind: "rejected", code: body.error ? body.error.code : "unavailable" };
      }
      return { kind: "unavailable" };
    },
    async status({ conversationId, requestId }) {
      const query = new URLSearchParams({ client_request_id: requestId });
      const response = await request(`/conversations/${conversationId}/status?${query}`);
      return response.json();
    },
    async history(conversationId) {
      const response = await request(`/conversations/${conversationId}/history`);
      return response.json();
    },
    async cancel({ conversationId, runId }) {
      return request(`/conversations/${conversationId}/runs/${runId}/cancel`, { method: "POST" });
    },
  };
}
