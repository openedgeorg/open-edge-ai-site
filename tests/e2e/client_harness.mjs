import { createController } from "../../site/js/app.js";

/**
 * Node side of tests/e2e/test_conversation_client.py: the real controller (site/js/app.js) behind a
 * fake fetch, driven one JSON line at a time over stdin and answered on stdout. Real timers; the
 * controller's background checks never keep this process alive on their own.
 */

const session = new Map();
const storage = {
  getItem: (key) => (session.has(key) ? session.get(key) : null),
  setItem: (key, value) => session.set(key, String(value)),
  removeItem: (key) => session.delete(key),
};
const localWrites = [];
const localStorageSpy = {
  setItem: (key, value) => {
    localWrites.push([key, value]);
  },
  getItem: () => null,
};

let posts = 0;
let statusGets = 0;
let mode = "lose";
const postBodies = [];
/** What GET /status answers; a test changes it with `set_status`. */
let statusReply = { outcome: "submission_unconfirmed", resubmission_allowed: false };

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

async function fetchImpl(url, options = {}) {
  const method = options.method || "GET";
  if (url.endsWith("/visitor-session")) return jsonResponse(200, { csrf_token: "csrf-1" });
  if (url.endsWith("/providers")) return jsonResponse(200, { providers: [] });
  if (url.endsWith("/conversations") && method === "POST") return jsonResponse(201, { id: "conv-1" });
  if (url.includes("/messages") && method === "POST") {
    posts += 1;
    postBodies.push(JSON.parse(options.body));
    if (mode === "lose") throw new Error("acceptance response lost");
    if (mode === "rate") {
      return jsonResponse(429, { error: { code: "rate_limited", message: "manual retry" }, submitted: false });
    }
    return jsonResponse(200, {}, { "x-esp-acceptance": "accepted" });
  }
  if (url.includes("/status")) {
    statusGets += 1;
    return jsonResponse(200, statusReply);
  }
  if (url.endsWith("/history")) return jsonResponse(200, { items: [] });
  return jsonResponse(200, {});
}

const view = { phase: "ready", draft: "", sendDisabled: false, providerFixed: false };
const controller = createController({ fetchImpl, storage });

async function handle(message) {
  if (message.method === "lose") {
    mode = "lose";
  } else if (message.method === "accept") {
    mode = "accept";
  } else if (message.method === "rate_limit") {
    mode = "rate";
  } else if (message.method === "set_status") {
    statusReply = message.reply;
  } else if (message.method === "send") {
    await controller.send(view, message.text, message.options || {});
  } else if (message.method === "edit_draft") {
    controller.editDraft(view, message.text);
  } else if (message.method === "check_status") {
    await controller.checkStatus(view);
  } else if (message.method === "reload") {
    await controller.reload(view);
  } else if (message.method === "focus") {
    controller.focus(view);
  } else if (message.method === "post_count") {
    return posts;
  } else if (message.method === "post_bodies") {
    return postBodies;
  } else if (message.method === "status_gets") {
    return statusGets;
  } else if (message.method === "send_disabled") {
    return view.sendDisabled;
  } else if (message.method === "draft") {
    return view.draft;
  } else if (message.method === "phase") {
    return view.phase;
  } else if (message.method === "status_text") {
    return view.status ? view.status.text : "";
  } else if (message.method === "actions") {
    return view.actions;
  } else if (message.method === "saved") {
    return JSON.parse(session.get("esp-client") ?? "null");
  } else if (message.method === "local_writes") {
    return localWrites.length;
  } else if (message.method === "touch_local") {
    localStorageSpy.setItem("esp-secret", "nope");
    return localWrites.length;
  }
  return { posts, statusGets, sendDisabled: view.sendDisabled, draft: view.draft, phase: view.phase };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    void handle(message)
      .then((result) => ({ result }))
      .catch((error) => ({ error: String(error && error.message) }))
      .then((answer) => {
        process.stdout.write(`${JSON.stringify(answer)}\n`);
      });
    newline = buffer.indexOf("\n");
  }
});
