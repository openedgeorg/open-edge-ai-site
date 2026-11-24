/**
 * Support code for the Atlas browser tests (tests/e2e/atlas_browser*.test.mjs; not a test file itself).
 *
 * Node built-ins only: a tiny Chrome DevTools Protocol client over the global WebSocket, a
 * headless Chrome launcher, and one node:http server that serves the repo's site/ directory
 * and, on the same origin, a stub of the chat API the page's conversation client calls.
 *
 * Which conversation client runs in the page (ATLAS_CHAT, read once at import, see CHAT_SETUP):
 *  - "double" (the default): tests/fixtures/atlas_chat_double/app.js is served at /js/app.js in
 *    place of site/js/app.js. It is a self-contained port of the working-tree client (see its header for the source hashes) that paints the way the live client
 *    does (stream follow, history fill, settled phase, CSRF header, the early "ready" quirk) and
 *    imports nothing from site/js/. The suites then depend only on what is committed in site/js/atlas*.js
 *    and on the tests, never on the state of the chat client files, so they pass on a clean checkout.
 *  - "real": site/js/app.js (with api.js, state.js, sse.js, render.js) is served as it is. This
 *    needs a working tree whose chat client can follow a stream, fill the history, settle and send the
 *    CSRF header (see realChatCapability). Without those the suites skip, saying why.
 *  - "auto": real when the working tree has those capabilities, else double.
 * What the two modes do and do not cover is written down in tests/fixtures/atlas_chat_double/app.js.
 *
 * Load: `node --test` runs test FILES in parallel, and every browser file starts its own Chrome.
 * Run the browser files one at a time (node --test --test-concurrency=1 tests/e2e/atlas_browser*.test.mjs,
 * which is what tests/e2e/test_atlas.py does) or the timing-sensitive scenarios can flake on a busy
 * machine. Tests inside one file share one Chrome; BROWSER_CONCURRENCY (ATLAS_BROWSER_CONCURRENCY,
 * default 2) is the number of those that run side by side.
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The stand-in conversation client (never part of the served site). */
export const CHAT_DOUBLE_FILE = path.resolve(HERE, "..", "fixtures", "atlas_chat_double", "app.js");

/** How many tests of one browser file run side by side (they share one Chrome). */
export const BROWSER_CONCURRENCY = Math.max(1, Number.parseInt(process.env.ATLAS_BROWSER_CONCURRENCY || "", 10) || 2);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export { sleep };

// ---------------------------------------------------------------------------------------------
// Which conversation client runs in the page
// ---------------------------------------------------------------------------------------------

/**
 * Can the working tree's own chat client (site/js/app.js, api.js, state.js) do what the Atlas
 * tests need from it? The browser tests need a client that follows /events into the list, fills
 * the list from /history, settles back to `ready` and sends the CSRF header. A tree without those
 * can only show "The chat is not available right now." and never posts a question.
 * @returns {{ok: boolean, missing: string[]}}
 */
export function realChatCapability() {
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(SITE_DIR, "js", name), "utf8");
    } catch {
      return "";
    }
  };
  const app = read("app.js");
  const api = read("api.js");
  const state = read("state.js");
  const missing = [];
  if (!/showHistory/.test(app)) missing.push("site/js/app.js has no showHistory (the list is never filled from /history)");
  if (!/follow/.test(app)) missing.push("site/js/app.js has no follow (the event stream is never followed)");
  if (!/csrf/i.test(api)) missing.push("site/js/api.js sends no CSRF header");
  if (!/settled/.test(state)) missing.push("site/js/state.js has no settled phase (the chat never returns to ready)");
  return { ok: missing.length === 0, missing };
}

/**
 * The conversation client of this run, from ATLAS_CHAT=double|real|auto (default: double).
 * `skip` is a reason string when the run asked for the real client and the tree cannot provide it
 * (pass it to describe({skip})), else false.
 * @returns {{requested: string, mode: "double"|"real", capable: boolean, missing: string[], skip: string|false, label: string}}
 */
export function resolveChatSetup(env = process.env) {
  const requested = String(env.ATLAS_CHAT || "double").trim().toLowerCase() || "double";
  if (!["double", "real", "auto"].includes(requested)) {
    throw new Error(`ATLAS_CHAT must be double, real or auto (got ${JSON.stringify(env.ATLAS_CHAT)})`);
  }
  const capability = realChatCapability();
  const mode = requested === "auto" ? (capability.ok ? "real" : "double") : requested;
  const skip =
    mode === "real" && !capability.ok
      ? `ATLAS_CHAT=real needs the working tree's own chat client, which lacks: ${capability.missing.join("; ")}`
      : false;
  const label =
    mode === "double"
      ? "chat client: test double (tests/fixtures/atlas_chat_double/app.js)"
      : "chat client: the working tree's site/js/app.js";
  return { requested, mode, capable: capability.ok, missing: capability.missing, skip, label };
}

export const CHAT_SETUP = resolveChatSetup();

/**
 * Where a request path is served from. Everything comes from site/, except that in double mode
 * /js/app.js is the test double. Returns null for a path outside site/.
 * @param {string} pathname decoded URL path
 * @param {"double"|"real"} [mode] defaults to the mode of this run (CHAT_SETUP)
 * @returns {string|null}
 */
export function siteFileFor(pathname, mode = CHAT_SETUP.mode) {
  let relative = pathname;
  if (relative.endsWith("/")) relative += "index.html";
  const full = path.normalize(path.join(SITE_DIR, relative));
  if (full !== SITE_DIR && !full.startsWith(SITE_DIR + path.sep)) return null;
  if (mode === "double" && full === path.join(SITE_DIR, "js", "app.js")) return CHAT_DOUBLE_FILE;
  return full;
}

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
 * A start that fails (Chrome slow to print its DevTools URL on a busy machine, or dying early) is
 * tried once more with a new profile before the error is given to the test.
 * @param {string} binary
 * @param {{attempts?: number}} [options]
 */
export async function launchBrowser(binary, { attempts = 2 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await launchBrowserOnce(binary);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(750);
    }
  }
  throw new Error(`Chrome did not start after ${attempts} attempts: ${lastError && lastError.message}`);
}

async function launchBrowserOnce(binary) {
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
      // Quieter start-up, less background work on a shared machine (none of it changes what a page does).
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-pings",
      "--metrics-recording-only",
      "--disable-features=Translate,MediaRouter,OptimizationHints",
      // Extra flags for live runs against the local HTTPS stack, e.g. ATLAS_CHROME_ARGS="--ignore-certificate-errors".
      ...(process.env.ATLAS_CHROME_ARGS || "").split(/\s+/).filter(Boolean),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.once("error", () => {
    // The binary could not be started at all: there is no process to wait for.
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
 *   warms its matcher in idle time;
 * - a count of pointer and key releases (window.__input), so a click or a key press can be waited
 *   for until the page has really handled it.
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
  // How many pointer releases and key releases the page has seen. Input.dispatchMouseEvent and
  // Input.dispatchKeyEvent can return BEFORE the page has run its handlers (they are only routed to
  // the renderer), so a Runtime.evaluate sent right after can read the page as it was before the
  // click. Page.click / Page.press wait on these counters to close that gap.
  const input = { pointer: 0, key: 0 };
  Object.defineProperty(window, "__input", { value: input });
  for (const type of ["pointerup", "mouseup"]) window.addEventListener(type, () => { input.pointer += 1; }, true);
  window.addEventListener("keyup", () => { input.key += 1; }, true);
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

/**
 * Page-side helper, pasted into the click expressions: wait until the centre of an element has not
 * moved for two animation frames (or 600 ms are over), like a visitor who aims at a page that has
 * stopped moving. Without it a click can land on whatever slid under the pointer after the aim
 * (the chips row changing height after a reply made a click on the List tab hit the map).
 */
const SETTLE_SOURCE = `const settle = async (el) => {
  const centre = () => { const r = el.getBoundingClientRect(); return Math.round((r.left + r.width / 2) * 2) + "," + Math.round((r.top + r.height / 2) * 2); };
  const frame = () => new Promise((resolve) => { const timer = setTimeout(resolve, 50); requestAnimationFrame(() => { clearTimeout(timer); resolve(); }); });
  const until = performance.now() + 600;
  let last = centre();
  let still = 0;
  while (still < 2 && performance.now() < until) {
    await frame();
    const now = centre();
    if (now === last) still += 1; else { still = 0; last = now; }
  }
};`;

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

  /** The page's count of pointer or key releases, or -1 when the page has no hook (scripts off). */
  async #released(kind) {
    try {
      const value = await this.eval(`window.__input ? window.__input.${kind} : -1`);
      return typeof value === "number" ? value : -1;
    } catch {
      return -1;
    }
  }

  /**
   * Wait until the page has seen one more release than `before`. The DevTools input commands can
   * answer before the page has run its handlers, which made a read right after a click see the old
   * page (a flaky "the list is still hidden"). A release that never reaches the page (a click on a
   * disabled control) is given up on after `timeoutMs`.
   */
  async #handled(kind, before, timeoutMs = 1500) {
    if (before < 0) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.#released(kind)) > before) return;
      await sleep(4);
    }
  }

  /** Move, press and release at a point, and return once the page has handled the click. */
  async #tap(x, y) {
    const before = await this.#released("pointer");
    await this.#mouse("mouseMoved", x, y, { button: "none", clickCount: 0 });
    await this.#mouse("mousePressed", x, y);
    await this.#mouse("mouseReleased", x, y);
    await this.#handled("pointer", before);
  }

  /**
   * Real mouse click at the centre of an element. Throws if another element covers that point.
   * @param {string} selector
   * @param {{within?: string}} [options] within: a selector; a hit inside the same closest(within) counts
   */
  async click(selector, { within = "" } = {}) {
    const target = await this.eval(`(async () => {
      ${SETTLE_SOURCE}
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: "no element for " + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      await settle(el);
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
    await this.#tap(target.x, target.y);
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
    const target = await this.eval(`(async () => {
      ${SETTLE_SOURCE}
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: "no element for " + ${JSON.stringify(selector)} };
      await settle(el);
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
    await this.#tap(target.x, target.y);
  }

  /** Real mouse click at a point of the viewport (for empty parts of the map). */
  async clickPoint(x, y) {
    await this.#tap(x, y);
  }

  async press(key, { modifiers = 0 } = {}) {
    const spec = KEYS[key];
    if (!spec) throw new Error(`unknown key ${key}`);
    const base = { key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers };
    const before = await this.#released("key");
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(spec.text ? { text: spec.text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await this.#handled("key", before);
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
    /**
     * (postNumber, message) => "accept" | 409 | 429 | "drop". "drop" cuts the connection before any
     * answer, like a network that loses the acceptance (the chat then reconciles).
     */
    outcome: () => "accept",
    /** "ok" | "html" (a 502 page, the chat never boots) | "reset" (connection dropped) for POST /visitor-session. */
    sessionMode: "ok",
    /**
     * "sse" (the stream runs) | "404" (there is no stream; the reply is in /history at once, so the
     * chat settles from /history alone).
     */
    eventsMode: "sse",
    /** With eventsMode "404": how long after the POST the reply shows up in /history (a lagging history), in ms. */
    historyDelayMs: 0,
    /**
     * During that lag, /history does not list the new turn at all, user row included (a history that is
     * behind the write path: it still answers with the older turns only). Off by default, so /history then
     * lists the new question as soon as it is accepted and only the reply lags.
     */
    historyHidesNewQuestion: false,
    /** What each GET /history answered, in order: a list of "role: text" strings per read. */
    historyReads: [],
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

function serveStatic(req, res, pathname, stub, mode) {
  const full = siteFileFor(decodeURIComponent(pathname), mode);
  if (full === null) {
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

async function handle(req, res, stub, mode) {
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
    if (stub.sessionMode === "reset") {
      req.socket.destroy();
      return;
    }
    if (stub.sessionMode === "html") {
      res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>Bad gateway</body></html>");
      return;
    }
    json(res, 200, { subject_id: "s-1", csrf_token: "t-1" });
    return;
  }
  if (method === "GET" && pathname === "/providers") {
    json(res, 200, { providers: [
      { provider: "openai", harness: "codex", display_model: "m", eligible: true, available: true },
      { provider: "xai", harness: "grok-build", display_model: "m", eligible: true, available: true },
    ] });
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
    if (decision === "drop") {
      stub.posts.push({ message, status: 0 });
      req.socket.destroy();
      return;
    }
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
    const replyText = String(stub.reply(message, turnNumber));
    stub.turns.push({
      user: message,
      reply: replyText,
      assistant: stub.eventsMode === "404" ? replyText : null,
      visibleAt: Date.now() + (stub.eventsMode === "404" ? stub.historyDelayMs : 0),
      streamed: false,
    });
    json(res, 200, { accepted: true }, { "X-ESP-Acceptance": "accepted" });
    return;
  }
  if (method === "GET" && pathname === "/conversations/conv-1/events") {
    if (stub.eventsMode === "404") {
      json(res, 404, { error: { code: "not_found" } });
      return;
    }
    await streamEvents(req, res, stub);
    return;
  }
  if (method === "GET" && pathname === "/conversations/conv-1/history") {
    const items = [];
    for (const turn of stub.turns) {
      if (stub.historyHidesNewQuestion && Date.now() < turn.visibleAt) continue;
      items.push({ role: "user", text: turn.user });
      if (turn.assistant !== null && Date.now() >= turn.visibleAt) items.push({ role: "assistant", text: turn.assistant });
    }
    stub.historyReads.push(items.map((item) => `${item.role}: ${item.text}`));
    json(res, 200, { items });
    return;
  }
  if (pathname.startsWith("/conversations/conv-1/status")) {
    json(res, 200, { state: "idle" });
    return;
  }
  if (method === "GET" || method === "HEAD") {
    serveStatic(req, res, pathname, stub, mode);
    return;
  }
  res.writeHead(404);
  res.end();
}

/**
 * Serve site/ and the stub chat API on 127.0.0.1:<random port>.
 * @param {{chat?: "double"|"real"}} [options] the conversation client to serve at /js/app.js;
 *   defaults to the client of this run (CHAT_SETUP.mode)
 * @returns {Promise<{origin: string, stub: ReturnType<typeof createStub>, close: () => Promise<void>}>}
 */
export async function startSite({ chat = CHAT_SETUP.mode } = {}) {
  const stub = createStub();
  const server = http.createServer((req, res) => {
    handle(req, res, stub, chat).catch((error) => {
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
