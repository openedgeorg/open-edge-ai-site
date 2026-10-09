/**
 * Support code for tests/e2e/atlas_browser.test.mjs (not a test file itself).
 *
 * Node built-ins only: a tiny Chrome DevTools Protocol client over the global WebSocket, a
 * headless Chrome launcher, and one node:http server that serves the repo's site/ directory
 * and, on the same origin, a stub of the chat API the real js/app.js calls.
 *
 * The server never adds a Content-Security-Policy header: the meta tag inside index.html is
 * what ships, and it is what Chrome has to enforce.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "site");
export const OUT_DIR = process.env.ATLAS_E2E_OUT || "/tmp/atlas-e2e";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export { sleep };

// ---------------------------------------------------------------------------------------------
// Chrome discovery and launch
// ---------------------------------------------------------------------------------------------

/**
 * @returns {{path: string|null, reason: string}} the Chrome binary to use, or why there is none.
 */
export function findChrome() {
  const explicit = process.env.ATLAS_CHROME;
  const candidates = explicit
    ? [explicit]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return { path: candidate, reason: "" };
    } catch {
      /* try the next candidate */
    }
  }
  return {
    path: null,
    reason: `no Chrome binary found (tried ${candidates.join(", ")}); set ATLAS_CHROME to a Chrome or Chromium executable to run the browser tests`,
  };
}

/**
 * Start headless Chrome with a fresh profile and connect to its browser DevTools endpoint.
 * @param {string} binary
 */
export async function launchBrowser(binary) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-chrome-"));
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-dev-shm-usage",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };
  const onExit = () => killGroup("SIGKILL");
  process.once("exit", onExit);

  async function dispose() {
    process.removeListener("exit", onExit);
    if (!exited) {
      killGroup("SIGTERM");
      const deadline = Date.now() + 4000;
      while (!exited && Date.now() < deadline) await sleep(25);
      if (!exited) killGroup("SIGKILL");
    }
    // Renderer helpers can outlive the main process for a moment: make sure none are left.
    killGroup("SIGKILL");
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  let wsUrl;
  try {
    wsUrl = await new Promise((resolve, reject) => {
      let tail = "";
      const timer = setTimeout(
        () => reject(new Error(`Chrome did not print a DevTools URL within 20 s. stderr tail:\n${tail}`)),
        20000,
      );
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        tail = (tail + chunk).slice(-4000);
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(tail);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Chrome exited early (code ${code}, signal ${signal}). stderr tail:\n${tail}`));
      });
    });
  } catch (error) {
    await dispose();
    throw error;
  }

  let cdp;
  try {
    cdp = await Cdp.connect(wsUrl);
  } catch (error) {
    await dispose();
    throw error;
  }
  return new Browser(cdp, dispose);
}

// ---------------------------------------------------------------------------------------------
// DevTools protocol client
// ---------------------------------------------------------------------------------------------

export class Cdp {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map(); // sessionId -> Set<(method, params) => void>
    ws.addEventListener("message", (event) => this.#onMessage(event.data));
    ws.addEventListener("close", () => this.#rejectAll(new Error("DevTools connection closed")));
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`could not open ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  #rejectAll(error) {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  #onMessage(raw) {
    const message = JSON.parse(String(raw));
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(`${entry.method}: ${message.error.message} (${message.error.code})`));
      } else {
        entry.resolve(message.result || {});
      }
      return;
    }
    const set = this.handlers.get(message.sessionId || "");
    if (set) for (const handler of [...set]) handler(message.method, message.params || {});
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId]
   * @param {number} [timeoutMs]
   */
  send(method, params = {}, sessionId = "", timeoutMs = 20000) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** @returns {() => void} unsubscribe */
  subscribe(sessionId, handler) {
    const key = sessionId || "";
    if (!this.handlers.has(key)) this.handlers.set(key, new Set());
    this.handlers.get(key).add(handler);
    return () => this.handlers.get(key)?.delete(handler);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Two test hooks installed before any page script runs:
 * - time travel: the Atlas chat bridge reads Date.now() for its pauses and its rate window, so a
 *   test can move the clock on instead of waiting 30 or 60 seconds;
 * - a record of every securitypolicyviolation event (what Chrome blocked under the page's CSP);
 * - a count of requestIdleCallback calls (window.__idle), so a test can see that the Atlas
 *   warms its matcher in idle time.
 */
const PAGE_HOOKS_SOURCE = `(() => {
  const realNow = Date.now.bind(Date);
  let skew = 0;
  Date.now = () => realNow() + skew;
  Object.defineProperty(window, "__atlasSkew", { value: (ms) => { skew += ms; return skew; } });
  Object.defineProperty(window, "__cspViolations", { value: [] });
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__cspViolations.push({ directive: event.violatedDirective, blocked: event.blockedURI, sample: event.sample });
  }, true);
  const idle = { scheduled: 0, ran: 0 };
  Object.defineProperty(window, "__idle", { value: idle });
  const realIdle = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback.bind(window) : null;
  if (realIdle) {
    window.requestIdleCallback = (callback, options) => {
      idle.scheduled += 1;
      return realIdle((deadline) => { idle.ran += 1; return callback(deadline); }, options);
    };
  }
})();`;

const KEYS = {
  Tab: { code: "Tab", vk: 9 },
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Escape: { code: "Escape", vk: 27 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  " ": { code: "Space", vk: 32, text: " " },
  PageDown: { code: "PageDown", vk: 34 },
  PageUp: { code: "PageUp", vk: 33 },
  Delete: { code: "Delete", vk: 46 },
  Backspace: { code: "Backspace", vk: 8 },
  Shift: { code: "ShiftLeft", vk: 16 },
};

export class Browser {
  constructor(cdp, dispose) {
    this.cdp = cdp;
    this.disposeProcess = dispose;
  }

  /**
   * A fresh incognito-like context with one tab. Nothing is shared with other tests.
   * @param {{label: string, diagnostics: object[], width?: number, height?: number,
   *   scriptsDisabled?: boolean, reducedMotion?: boolean}} options
   */
  async openPage({ label, diagnostics, width = 1400, height = 1000, scriptsDisabled = false, reducedMotion = false }) {
    const { browserContextId } = await this.cdp.send("Target.createBrowserContext");
    const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this.cdp, { sessionId, targetId, browserContextId, label, diagnostics });
    await page.setup({ width, height, scriptsDisabled, reducedMotion });
    return page;
  }

  async close() {
    this.cdp.close();
    await this.disposeProcess();
  }
}

export class Page {
  constructor(cdp, { sessionId, targetId, browserContextId, label, diagnostics }) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.browserContextId = browserContextId;
    this.label = label;
    /** Everything this page logged: console errors, Log entries, uncaught exceptions. */
    this.diagnostics = diagnostics;
    this.closed = false;
    this.waiters = [];
    this.unsubscribe = cdp.subscribe(sessionId, (method, params) => this.#onEvent(method, params));
  }

  #push(entry) {
    this.diagnostics.push({ test: this.label, ...entry });
  }

  #onEvent(method, params) {
    if (method === "Runtime.consoleAPICalled") {
      const text = (params.args || []).map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type)).join(" ");
      this.#push({ kind: "console", level: params.type, text });
    } else if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails || {};
      const text = (details.exception && (details.exception.description || details.exception.value)) || details.text || "exception";
      this.#push({ kind: "exception", level: "error", text: String(text) });
    } else if (method === "Log.entryAdded") {
      const entry = params.entry || {};
      this.#push({ kind: "log", level: entry.level, source: entry.source, text: String(entry.text || ""), url: entry.url || "" });
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.method === method) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(params);
      }
    }
  }

  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }

  once(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const waiter = { method, resolve };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      waiter.resolve = (params) => {
        clearTimeout(timer);
        resolve(params);
      };
      this.waiters.push(waiter);
    });
  }

  async setup({ width, height, scriptsDisabled, reducedMotion }) {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Log.enable");
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HOOKS_SOURCE });
    if (reducedMotion) await this.setReducedMotion(true);
    if (scriptsDisabled) await this.send("Emulation.setScriptExecutionDisabled", { value: true });
  }

  setReducedMotion(on) {
    return this.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "no-preference" }],
    });
  }

  async goto(url) {
    const loaded = this.once("Page.loadEventFired", 20000);
    await this.send("Page.navigate", { url });
    await loaded;
  }

  async reload() {
    const loaded = this.once("Page.loadEventFired", 20000);
    await this.send("Page.reload", { ignoreCache: true });
    await loaded;
  }

  /**
   * Evaluate an expression in the page and return its JSON-able value.
   * @param {string} expression
   */
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const text = (details.exception && (details.exception.description || details.exception.value)) || details.text;
      throw new Error(`page evaluation failed: ${text}\n  expression: ${expression.slice(0, 300)}`);
    }
    return result.result ? result.result.value : undefined;
  }

  /**
   * Poll an expression until it is truthy. Resolves to the truthy value.
   * @param {string} expression
   * @param {{timeout?: number, interval?: number, what?: string}} [options]
   */
  async waitFor(expression, { timeout = 10000, interval = 25, what = "" } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    let lastError = null;
    for (;;) {
      try {
        last = await this.eval(expression);
        lastError = null;
        if (last) return last;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `timed out after ${timeout} ms waiting for ${what || expression.slice(0, 200)}` +
            `\n  last value: ${JSON.stringify(last)}${lastError ? `\n  last error: ${lastError.message}` : ""}`,
        );
      }
      await sleep(interval);
    }
  }

  // ---- input ----

  async #mouse(type, x, y, extra = {}) {
    await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
  }

  /**
   * Real mouse click at the centre of an element. Throws if another element covers that point.
   * @param {string} selector
   * @param {{within?: string}} [options] within: a selector; a hit inside the same closest(within) counts
   */
  async click(selector, { within = "" } = {}) {
    const target = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: "no element for " + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (r.width === 0 || r.height === 0) return { error: "zero-size element " + ${JSON.stringify(selector)} };
      const hit = document.elementFromPoint(x, y);
      const within = ${JSON.stringify(within)};
      const ok = !!hit && (el === hit || el.contains(hit) || (within && hit.closest(within) && hit.closest(within) === el.closest(within)));
      const describe = (n) => n ? n.tagName + (n.id ? "#" + n.id : "") + "." + (n.getAttribute("class") || "") : "nothing";
      return { x, y, ok, hit: describe(hit) };
    })()`);
    if (target.error) throw new Error(target.error);
    if (!target.ok) throw new Error(`click on ${selector} would hit ${target.hit} instead (covered at ${target.x},${target.y})`);
    await this.#mouse("mouseMoved", target.x, target.y, { button: "none", clickCount: 0 });
    await this.#mouse("mousePressed", target.x, target.y);
    await this.#mouse("mouseReleased", target.x, target.y);
  }

  /** Click the circular hit area of an island on the map. */
  clickIsland(id) {
    return this.click(`#atlas-map [data-id="${id}"] .atlas-hit`, { within: ".atlas-island" });
  }

  /**
   * Real mouse click at the centre of an element WITHOUT scrolling anything first, like a
   * visitor who taps what is already on screen. Throws if the element is not fully in view or
   * another element covers its centre.
   * @param {string} selector
   * @param {{within?: string}} [options]
   */
  async clickInView(selector, { within = "" } = {}) {
    const target = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: "no element for " + ${JSON.stringify(selector)} };
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { error: ${JSON.stringify(selector)} + " is not on screen at " + Math.round(x) + "," + Math.round(y) };
      const hit = document.elementFromPoint(x, y);
      const within = ${JSON.stringify(within)};
      const ok = !!hit && (el === hit || el.contains(hit) || (within && hit.closest(within) && hit.closest(within) === el.closest(within)));
      return { x, y, ok, hit: hit ? hit.tagName + "." + (hit.getAttribute("class") || "") : "nothing" };
    })()`);
    if (target.error) throw new Error(target.error);
    if (!target.ok) throw new Error(`click on ${selector} would hit ${target.hit} instead`);
    await this.#mouse("mouseMoved", target.x, target.y, { button: "none", clickCount: 0 });
    await this.#mouse("mousePressed", target.x, target.y);
    await this.#mouse("mouseReleased", target.x, target.y);
  }

  /** Real mouse click at a point of the viewport (for empty parts of the map). */
  async clickPoint(x, y) {
    await this.#mouse("mouseMoved", x, y, { button: "none", clickCount: 0 });
    await this.#mouse("mousePressed", x, y);
    await this.#mouse("mouseReleased", x, y);
  }

  async press(key, { modifiers = 0 } = {}) {
    const spec = KEYS[key];
    if (!spec) throw new Error(`unknown key ${key}`);
    const base = { key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(spec.text ? { text: spec.text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Insert text into the focused control, like a paste or an IME commit. */
  type(text) {
    return this.send("Input.insertText", { text });
  }

  /** Focus a control the way a visitor would, then type into it. */
  async typeInto(selector, text) {
    await this.click(selector);
    await this.type(text);
  }

  /** Empty the focused textarea with real select-all + Delete keys. */
  async clearFocused() {
    await this.eval(`(() => { const el = document.activeElement; if (el && "select" in el) el.select(); return true; })()`);
    await this.press("Delete");
  }

  async screenshot(file, { clipSelector = "" } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const params = { format: "png", captureBeyondViewport: false };
    if (clipSelector) {
      // From the top of the page, so the sticky header and the sticky chat are not drawn over the clip.
      const box = await this.eval(`(() => {
        window.scrollTo({ top: 0, left: 0, behavior: "instant" });
        const el = document.querySelector(${JSON.stringify(clipSelector)});
        const r = el.getBoundingClientRect();
        return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
      })()`);
      params.clip = { ...box, scale: 1 };
      params.captureBeyondViewport = true;
    }
    const { data } = await this.send("Page.captureScreenshot", params);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    try {
      await this.cdp.send("Target.closeTarget", { targetId: this.targetId }, "", 5000);
    } catch {
      /* the tab is already gone */
    }
    try {
      await this.cdp.send("Target.disposeBrowserContext", { browserContextId: this.browserContextId }, "", 5000);
    } catch {
      /* the context is already gone */
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Site + stub chat API server
// ---------------------------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/** Split a reply into 2-3 SSE deltas (on code points, so no character is cut in half). */
export function splitDeltas(text) {
  const chars = Array.from(String(text));
  if (chars.length < 3) return [chars.join("")];
  const parts = chars.length > 80 ? 3 : 2;
  const size = Math.ceil(chars.length / parts);
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

/**
 * The mutable state of one stub chat API. Tests change `reply`, `outcome` and the delays.
 */
export function createStub() {
  const stub = {
    /**
     * Every request the server saw: { method, path, url, headers, body }. `url` keeps the query
     * string, `headers` holds the lower-case header NAMES only, `body` is the parsed JSON body of a
     * POST (null for anything else). Used to prove that the Atlas adds nothing to the chat traffic.
     */
    requests: [],
    /** Every POST /conversations/conv-1/messages: { message, status }. */
    posts: [],
    /** { user, assistant|null, streamed } for each accepted message. */
    turns: [],
    /** How many SSE streams ran to their done frame. */
    completed: 0,
    /** Requests for paths that do not exist in site/. */
    notFound: [],
    /** POSTs whose x-esp-csrf header was wrong. */
    csrfFailures: [],
    /** Delay before the first text delta of the next streams, in ms. */
    sseDelayMs: 0,
    /** When set, streams wait for this promise before the first delta (see holdStreams). */
    gate: null,
    /** Make every stream wait until the returned function is called: a reply that is "in flight" for as long as a test needs. */
    holdStreams() {
      let release;
      stub.gate = new Promise((resolve) => {
        release = () => {
          stub.gate = null;
          resolve();
        };
      });
      return release;
    },
    deltaGapMs: 5,
    /** (userMessage, turnNumber) => assistant reply text. */
    reply: (message, n) => `Plain reply number ${n}.`,
    /** (postNumber, message) => "accept" | 409 | 429. */
    outcome: () => "accept",
    async waitFor(predicate, { timeout = 10000, what = "stub condition" } = {}) {
      const deadline = Date.now() + timeout;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(20);
      }
    },
  };
  return stub;
}

function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

function serveStatic(req, res, pathname, stub) {
  let relative = decodeURIComponent(pathname);
  if (relative.endsWith("/")) relative += "index.html";
  const full = path.normalize(path.join(SITE_DIR, relative));
  if (full !== SITE_DIR && !full.startsWith(SITE_DIR + path.sep)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(full, (error, data) => {
    if (error) {
      stub.notFound.push(pathname);
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  });
}

async function streamEvents(req, res, stub) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  const turn = [...stub.turns].reverse().find((candidate) => !candidate.streamed);
  if (!turn) {
    res.write('data: {"type":"done"}\n\n');
    res.end();
    return;
  }
  turn.streamed = true;
  if (stub.gate) await stub.gate;
  if (stub.sseDelayMs > 0) await sleep(stub.sseDelayMs);
  for (const delta of splitDeltas(turn.reply)) {
    if (closed) return;
    res.write(`data: ${JSON.stringify({ type: "text_delta", text: delta })}\n\n`);
    await sleep(stub.deltaGapMs);
  }
  if (closed) return;
  turn.assistant = turn.reply;
  res.write('data: {"type":"done"}\n\n');
  res.end();
  stub.completed += 1;
}

async function handle(req, res, stub) {
  const url = new URL(req.url, "http://stub.invalid");
  const pathname = url.pathname;
  const method = req.method || "GET";
  // The body of a POST is read once, up front, and recorded whole.
  const parsedBody = method === "POST" ? await readJson(req) : null;
  stub.requests.push({ method, path: pathname, url: req.url || "", headers: Object.keys(req.headers).sort(), body: parsedBody });

  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (method === "POST" && pathname === "/visitor-session") {
    json(res, 200, { subject_id: "s-1", csrf_token: "t-1" });
    return;
  }
  if (method === "POST" && pathname === "/conversations") {
    if (req.headers["x-esp-csrf"] !== "t-1") {
      stub.csrfFailures.push(pathname);
      json(res, 403, { error: { code: "csrf", message: "bad csrf" } });
      return;
    }
    json(res, 201, { id: "conv-1" });
    return;
  }
  if (method === "POST" && pathname === "/conversations/conv-1/messages") {
    const body = parsedBody || {};
    if (req.headers["x-esp-csrf"] !== "t-1") {
      stub.csrfFailures.push(pathname);
      json(res, 403, { error: { code: "csrf", message: "bad csrf" } });
      return;
    }
    const message = String(body.message ?? "");
    const number = stub.posts.length + 1;
    const decision = stub.outcome(number, message);
    if (decision === 409) {
      stub.posts.push({ message, status: 409 });
      json(res, 409, { error: { code: "run_active", message: "busy" } });
      return;
    }
    if (decision === 429) {
      stub.posts.push({ message, status: 429 });
      json(res, 429, { error: { code: "rate_limited", message: "slow down" } });
      return;
    }
    stub.posts.push({ message, status: 200 });
    const turnNumber = stub.turns.length + 1;
    stub.turns.push({ user: message, reply: String(stub.reply(message, turnNumber)), assistant: null, streamed: false });
    json(res, 200, { accepted: true }, { "X-ESP-Acceptance": "accepted" });
    return;
  }
  if (method === "GET" && pathname === "/conversations/conv-1/events") {
    await streamEvents(req, res, stub);
    return;
  }
  if (method === "GET" && pathname === "/conversations/conv-1/history") {
    const items = [];
    for (const turn of stub.turns) {
      items.push({ role: "user", text: turn.user });
      if (turn.assistant !== null) items.push({ role: "assistant", text: turn.assistant });
    }
    json(res, 200, { items });
    return;
  }
  if (pathname.startsWith("/conversations/conv-1/status")) {
    json(res, 200, { state: "idle" });
    return;
  }
  if (method === "GET" || method === "HEAD") {
    serveStatic(req, res, pathname, stub);
    return;
  }
  res.writeHead(404);
  res.end();
}

/**
 * Serve site/ and the stub chat API on 127.0.0.1:<random port>.
 * @returns {Promise<{origin: string, stub: ReturnType<typeof createStub>, close: () => Promise<void>}>}
 */
export async function startSite() {
  const stub = createStub();
  const server = http.createServer((req, res) => {
    handle(req, res, stub).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error && error.message));
    });
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    stub,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
