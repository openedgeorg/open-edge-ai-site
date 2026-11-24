/**
 * Live Atlas journey: drives the REAL site and the REAL backend through the UI, like a visitor, until
 * every concept of the map has been visited by an actual final assistant answer.
 *
 *   ATLAS_CHROME_ARGS="--ignore-certificate-errors" node tests/live/atlas_journey.mjs \
 *     --url https://127.0.0.1:8766/ --provider xai --out <dir> [--width 1440 --height 1000] [--max-turns 80]
 *
 * What it never does: write sessionStorage, call reducer actions, dispatch synthetic events, or inject
 * answers. It only uses real mouse clicks and typed text on visible controls (the map islands, the
 * suggestion chips, the List "Ask" buttons and the composer), then reads what the page shows.
 *
 * Output (in --out): journey.json (every turn, exact texts, timings, transitions, map before/after),
 * transcript.md, coverage.csv (the columns of coverage-plan.csv), screenshots/. Exit code 0 only when the
 * final visual check passes (all concepts visited, zero fogged/frontier nodes, counter, List and
 * restored state after a reload agree).
 */
import fs from "node:fs";
import path from "node:path";

import { ISLANDS, REGIONS, START_ID } from "../../site/js/atlas-graph.js";
import { findChrome, launchBrowser, sleep } from "../e2e/atlas_browser_support.mjs";

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith("--")) argv.set(a.slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "1");
}
const URL = argv.get("url") || "https://127.0.0.1:8766/";
const PROVIDER = argv.get("provider") || "xai";
const OUT = path.resolve(argv.get("out") || `/tmp/atlas-journey-${Date.now()}`);
const WIDTH = Number(argv.get("width") || 1440);
const HEIGHT = Number(argv.get("height") || 1000);
const MAX_TURNS = Number(argv.get("max-turns") || 90);
const TURN_TIMEOUT_MS = Number(argv.get("turn-timeout") || 200) * 1000;
const MOBILE = argv.has("mobile");
// --keys: every question is asked with real key presses only (Tab, Page Up/Down, Enter), nothing is clicked.
const KEYS_ONLY = argv.has("keys");

const TOTAL = ISLANDS.length;
const BY_ID = new Map(ISLANDS.map((i) => [i.id, i]));
const REGION_ORDER = new Map(REGIONS.map((r, n) => [r.id, n]));
const REGION_NAME = new Map(REGIONS.map((r) => [r.id, r.name]));
const LEVEL = new Map(REGIONS.map((r) => [r.id, r.level]));

fs.mkdirSync(path.join(OUT, "screenshots"), { recursive: true });

const diagnostics = [];
const turns = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const READ = `(() => {
  const q = (s) => document.querySelector(s);
  const islands = {};
  for (const g of document.querySelectorAll("#atlas-map g.atlas-island[data-id]")) {
    const cls = g.getAttribute("class") || "";
    islands[g.getAttribute("data-id")] = cls.includes("is-visited") ? "visited" : cls.includes("is-frontier") ? "frontier" : cls.includes("is-fogged") ? "fogged" : "unknown";
  }
  const rows = [...document.querySelectorAll("#history li")].map((li) => ({
    role: li.getAttribute("data-role") || "",
    text: (li.querySelector("p") || li).textContent,
  }));
  const text = (s) => { const e = q(s); return e ? e.textContent.trim() : null; };
  return {
    phase: text("#phase"),
    count: text("#atlas-count"),
    chatStatus: text("#chat-status"),
    notice: text("#atlas-notice"),
    historyState: text("#history-state"),
    provider: q("#provider") ? q("#provider").value : null,
    sendDisabled: q("#send") ? q("#send").disabled : null,
    cancelDisabled: q("#cancel") ? q("#cancel").disabled : null,
    draft: q("#draft") ? q("#draft").value : null,
    chips: [...document.querySelectorAll("#atlas-suggest .atlas-chip")].map((b) => b.textContent.trim()),
    rows,
    islands,
    scrollY: Math.round(scrollY),
    // The ids the page itself tracks for the turn (sessionStorage "esp-client"), for correlating with the service's log.
    client: (() => {
      try {
        const c = JSON.parse(sessionStorage.getItem("esp-client") || "{}");
        return { conversationId: c.conversationId || null, requestId: c.requestId || null, runId: c.runId || null, nativeWorkRef: c.nativeWorkRef || null, provider: c.provider || null };
      } catch {
        return {};
      }
    })(),
  };
})()`;

async function read(page) {
  return JSON.parse(JSON.stringify(await page.eval(READ)));
}

const visitedOf = (s) => Object.entries(s.islands).filter(([, v]) => v === "visited").map(([k]) => k);
const frontierOf = (s) => Object.entries(s.islands).filter(([, v]) => v === "frontier").map(([k]) => k);

function pickNext(state) {
  const frontier = frontierOf(state).filter((id) => BY_ID.has(id));
  frontier.sort((a, b) => {
    const A = BY_ID.get(a);
    const B = BY_ID.get(b);
    const openA = A.status === "open" ? 1 : 0;
    const openB = B.status === "open" ? 1 : 0;
    if (openA !== openB) return openA - openB;
    return REGION_ORDER.get(A.region) - REGION_ORDER.get(B.region) || ISLANDS.indexOf(A) - ISLANDS.indexOf(B);
  });
  return frontier[0] || null;
}

/** Wait for the visible outcome of the question just sent. */
async function waitOutcome(page, before, turn) {
  const t0 = Date.now();
  let last = "";
  const assistantBefore = before.rows.filter((r) => r.role === "assistant" || (!r.role && false)).length;
  const rowsBefore = before.rows.length;
  while (Date.now() - t0 < TURN_TIMEOUT_MS) {
    const s = await read(page);
    const sig = JSON.stringify([s.phase, s.chatStatus, s.historyState, s.rows.length, s.count, s.sendDisabled, s.cancelDisabled]);
    if (sig !== last) {
      turn.transitions.push({ at: ((Date.now() - t0) / 1000).toFixed(1), phase: s.phase, chatStatus: s.chatStatus, rows: s.rows.length, count: s.count, sendDisabled: s.sendDisabled, cancelDisabled: s.cancelDisabled });
      last = sig;
    }
    if (s.client) {
      turn.correlation = turn.correlation || {};
      for (const [k, v] of Object.entries(s.client)) if (v) turn.correlation[k] = v;
    }
    const assistantNow = s.rows.filter((r) => r.role === "assistant").length;
    const answered = assistantNow > assistantBefore || (before.rows.every((r) => !r.role) && s.rows.length >= rowsBefore + 2);
    const terminalBad = ["failed", "cancelled", "unavailable"].includes(s.phase) || s.phase === "rejected";
    if (s.phase === "ready" && answered) {
      await sleep(1500); // let the matcher and the map settle after the final reply
      return { kind: "answered", state: await read(page), seconds: (Date.now() - t0) / 1000 };
    }
    if (terminalBad && Date.now() - t0 > 2000) return { kind: s.phase, state: s, seconds: (Date.now() - t0) / 1000 };
    await sleep(700);
  }
  return { kind: "timeout", state: await read(page), seconds: (Date.now() - t0) / 1000 };
}

async function shot(page, name) {
  const file = path.join(OUT, "screenshots", name);
  try {
    await page.screenshot(file);
  } catch (error) {
    log("screenshot failed", name, error.message);
  }
  return path.relative(OUT, file);
}

/** Tab (then Shift+Tab) until the focused element satisfies `test`, a JavaScript expression about document.activeElement. */
async function tabTo(page, test, what) {
  const hit = () => page.eval(`(() => { const a = document.activeElement; return Boolean(a) && Boolean(${test}); })()`);
  if (await hit()) return;
  for (const modifiers of [0, 8]) {
    for (let i = 0; i < 220; i += 1) {
      await page.press("Tab", { modifiers });
      if (await hit()) return;
    }
  }
  throw new Error(`keyboard: could not reach ${what} with Tab`);
}

const ACTIVE_ISLAND = `(() => { const a = document.activeElement; const g = a && a.closest && a.closest("g.atlas-island[data-id]"); return g ? g.getAttribute("data-id") : null; })()`;

/** Focus a place on the map with keys only (Tab into the map, Page Up/Down to the place) and press Enter on it. */
async function keyIsland(page, id) {
  await tabTo(page, `a.closest && a.closest("#atlas-map")`, "the map");
  for (let i = 0; i < TOTAL + 8 && (await page.eval(ACTIVE_ISLAND)) !== null; i += 1) {
    const before = await page.eval(ACTIVE_ISLAND);
    await page.press("PageUp");
    if ((await page.eval(ACTIVE_ISLAND)) === before) break;
  }
  for (let i = 0; i < TOTAL + 8; i += 1) {
    if ((await page.eval(ACTIVE_ISLAND)) === id) break;
    await page.press("PageDown");
  }
  if ((await page.eval(ACTIVE_ISLAND)) !== id) throw new Error(`keyboard: could not focus ${id}`);
  await page.press("Enter");
}

async function sendTyped(page, text) {
  if (KEYS_ONLY) {
    await tabTo(page, `a.id === "draft"`, "the message box");
    await page.type(text);
    await tabTo(page, `a.id === "send"`, "the Send button");
    await page.press("Enter");
    return;
  }
  await page.typeInto("#draft", text);
  await page.click("#send");
}

async function askViaList(page, id) {
  await page.click("#atlas-view-list");
  await sleep(300);
  const ok = await page.eval(`(() => {
    const row = document.querySelector('#atlas-list [data-id="${id}"]') || [...document.querySelectorAll("#atlas-list li")].find((li) => li.getAttribute("data-id") === "${id}");
    if (!row) return false;
    const btn = row.querySelector("button");
    if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
    btn.setAttribute("data-journey-ask", "1");
    return true;
  })()`);
  if (!ok) {
    await page.click("#atlas-view-map");
    return false;
  }
  await page.click('[data-journey-ask="1"]');
  await sleep(300);
  await page.click("#atlas-view-map");
  return true;
}

async function main() {
  const chrome = findChrome();
  if (!chrome.path) throw new Error(chrome.reason);
  const browser = await launchBrowser(chrome.path);
  const page = await browser.openPage({ label: "live-journey", diagnostics, width: WIDTH, height: HEIGHT });
  const env = { url: URL, provider: PROVIDER, viewport: `${WIDTH}x${HEIGHT}`, mobile: MOBILE, keysOnly: KEYS_ONLY, started: new Date().toISOString(), chrome: "Chrome 131 headless", total: TOTAL };
  let exitCode = 1;
  try {
    await page.goto(URL);
    await page.waitFor(`document.querySelector("#phase") && document.querySelector("#phase").textContent === "ready"`, { timeout: 30000, what: "chat ready" });
    await page.eval(`(() => { const s = document.querySelector("#provider"); s.value = ${JSON.stringify(PROVIDER)}; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    env.initial = await read(page);
    await shot(page, "000-start.png");
    log("start", env.initial.count, "provider", PROVIDER);

    let gaps = 0;
    for (let n = 1; n <= MAX_TURNS; n += 1) {
      const before = await read(page);
      if (visitedOf(before).length >= TOTAL) break;
      const turn = { number: n, entry: "", concept: null, question: "", before: { visited: visitedOf(before), count: before.count, frontier: frontierOf(before) }, transitions: [], offered: [] };
      let target = null;
      if (n === 1) {
        turn.entry = "Atlas suggestion (opening chip)";
        turn.question = before.chips[0] || "";
        if (KEYS_ONLY) {
          await tabTo(page, `a.classList.contains("atlas-chip")`, "the opening suggestion");
          await page.press("Enter");
        } else await page.click("#atlas-suggest .atlas-chip");
      } else {
        target = pickNext(before);
        if (!target) {
          turn.entry = "stuck: no frontier island";
          turns.push(turn);
          log("no frontier island left but", visitedOf(before).length, "of", TOTAL, "visited");
          break;
        }
        const island = BY_ID.get(target);
        turn.concept = target;
        turn.question = island.teaser;
        const useList = n % 6 === 0 && !KEYS_ONLY;
        if (KEYS_ONLY) {
          turn.entry = "map place by keyboard (Tab, Page Up/Down, Enter)";
          await keyIsland(page, target);
        } else if (useList && (await askViaList(page, target))) turn.entry = "List view Ask button";
        else {
          turn.entry = "map node click";
          await page.clickIsland(target);
        }
      }
      log(`turn ${n}: ${turn.entry}${target ? " " + target : ""}`);
      const turnStartedAt = Date.now();
      let outcome = await waitOutcome(page, before, turn);
      // The page tells a visitor whose message was refused ("still working on another message", or "not sent. Try again in a
      // moment" when the service was briefly unavailable) to wait and send it again. Do exactly that (the question is back in
      // the message box), at most three times, and record each refusal with the words the page showed.
      for (let again = 1; again <= 3 && outcome.kind === "rejected" && /still working on another message|not sent|try again in a moment/i.test(outcome.state.chatStatus || ""); again += 1) {
        turn.busyRefusals = again;
        turn.refusals = [...(turn.refusals || []), { attempt: again, atSeconds: Number(((Date.now() - turnStartedAt) / 1000).toFixed(1)), chatStatus: outcome.state.chatStatus || "" }];
        log(`  refused (${again}): "${(outcome.state.chatStatus || "").slice(0, 110)}"; waiting, then pressing Send again as the page says`);
        await sleep(15000);
        if (KEYS_ONLY) {
          await tabTo(page, `a.id === "send"`, "the Send button");
          await page.press("Enter");
        } else await page.click("#send");
        outcome = await waitOutcome(page, before, turn);
      }
      const after = outcome.state;
      turn.outcome = outcome.kind;
      turn.seconds = Number(((turn.busyRefusals ? (Date.now() - turnStartedAt) / 1000 : outcome.seconds)).toFixed(1));
      const answerRows = after.rows.filter((r) => r.role === "assistant");
      turn.answer = outcome.kind === "answered" ? (answerRows.length ? answerRows[answerRows.length - 1].text : after.rows[after.rows.length - 1].text) : null;
      turn.failure = outcome.kind === "answered" ? null : { phase: after.phase, chatStatus: after.chatStatus, notice: after.notice };
      turn.after = { visited: visitedOf(after), count: after.count, frontier: frontierOf(after) };
      turn.newlyVisited = turn.after.visited.filter((id) => !turn.before.visited.includes(id));
      turn.offered = after.chips;
      turn.screenshot = await shot(page, `turn-${String(n).padStart(2, "0")}.png`);
      turns.push(turn);
      log(`  -> ${outcome.kind} in ${turn.seconds}s, ${turn.before.visited.length} -> ${turn.after.visited.length} visited: +[${turn.newlyVisited.join(", ")}]`);

      if (outcome.kind !== "answered") {
        // A failure or an uncertain submission: record it and stop. Never resend blindly.
        log("  journey blocked by a non-answer outcome:", outcome.kind, after.chatStatus || "");
        break;
      }
      // The island's own question was answered but the concept did not light: a typed follow-up, recorded with its reason.
      if (target && !turn.after.visited.includes(target)) {
        gaps += 1;
        const island = BY_ID.get(target);
        const follow = `Could you explain "${island.name}" in the ESP design in a few sentences?`;
        const t2 = { number: `${n}b`, entry: "typed follow-up", concept: target, reason: `the answer to "${island.teaser}" did not light ${target}`, question: follow, before: { visited: turn.after.visited, count: after.count, frontier: turn.after.frontier }, transitions: [], offered: [] };
        const b2 = await read(page);
        await sendTyped(page, follow);
        const o2 = await waitOutcome(page, b2, t2);
        const a2 = o2.state;
        t2.outcome = o2.kind;
        t2.seconds = Number(o2.seconds.toFixed(1));
        const rows2 = a2.rows.filter((r) => r.role === "assistant");
        t2.answer = o2.kind === "answered" ? (rows2.length ? rows2[rows2.length - 1].text : a2.rows[a2.rows.length - 1].text) : null;
        t2.after = { visited: visitedOf(a2), count: a2.count, frontier: frontierOf(a2) };
        t2.newlyVisited = t2.after.visited.filter((id) => !t2.before.visited.includes(id));
        t2.offered = a2.chips;
        t2.screenshot = await shot(page, `turn-${String(n).padStart(2, "0")}b.png`);
        turns.push(t2);
        log(`  typed follow-up for ${target}: ${o2.kind}, +[${t2.newlyVisited.join(", ")}]`);
        if (o2.kind !== "answered") break;
      }
    }

    // ---------- final visual and consistency checks ----------
    const final = await read(page);
    env.finalState = { count: final.count, visited: visitedOf(final).length, frontier: frontierOf(final), fogged: Object.entries(final.islands).filter(([, v]) => v === "fogged").map(([k]) => k) };
    env.turnCount = turns.length;
    const result = await finalChecks(page, "before-refresh");
    await page.reload();
    await page.waitFor(`document.querySelector("#phase") && document.querySelector("#phase").textContent === "ready"`, { timeout: 30000, what: "chat ready after refresh" });
    await sleep(2500);
    const restored = await finalChecks(page, "after-refresh");
    env.keyboard = await keyboardPass(page);
    log("keyboard pass:", env.keyboard.pass ? "all places reachable" : `missing ${env.keyboard.missing.join(",")} unnamed ${env.keyboard.unnamed.join(",")}`);
    env.checks = { beforeRefresh: result, afterRefresh: restored };
    env.finished = new Date().toISOString();
    env.diagnostics = diagnostics.filter((d) => d.level === "error" || d.kind === "exception").map((d) => `${d.kind}:${d.text}`.slice(0, 200));
    const shown = (c) => (c.regionShots || []).every((r) => r.notInAnyShot.length === 0);
    log("regions fully shown in their screenshots:", shown(result) && shown(restored), "| label overlaps:", result.geometry.labelOverlaps.length, "| discs under other labels:", result.geometry.discsUnderOtherLabels.length);
    const pass = result.pass && restored.pass && env.keyboard.pass && shown(result) && shown(restored);
    env.verdict = pass ? "PASS: all concepts visited with the visited appearance, counter/map/List agree, restored after refresh, every place reachable by keyboard" : "NOT PASSED";
    exitCode = pass ? 0 : 1;
    log("verdict:", env.verdict);
  } catch (error) {
    env.error = String(error && error.stack ? error.stack : error);
    log("journey error:", env.error);
  } finally {
    write(env);
    await browser.close();
  }
  process.exit(exitCode);

  async function finalChecks(pg, label) {
    const info = await pg.eval(`(() => {
      const isl = [...document.querySelectorAll("#atlas-map g.atlas-island[data-id]")];
      const classOf = (g) => (g.getAttribute("class") || "");
      const visited = isl.filter((g) => classOf(g).includes("is-visited"));
      const frontier = isl.filter((g) => classOf(g).includes("is-frontier"));
      const fogged = isl.filter((g) => classOf(g).includes("is-fogged"));
      const disc = (g) => { const d = g.querySelector(".atlas-disc"); return d ? getComputedStyle(d).fill : null; };
      const fogDots = isl.filter((g) => { const d = g.querySelector(".atlas-fog-dot"); return d && getComputedStyle(d).display !== "none" && getComputedStyle(d).visibility !== "hidden" && Number(getComputedStyle(d).opacity) > 0; });
      const fills = {};
      for (const g of visited) { const f = disc(g); fills[f] = (fills[f] || 0) + 1; }
      const list = [...document.querySelectorAll("#atlas-list li.atlas-list-item")];
      const listVisited = list.filter((li) => /visited/i.test(li.getAttribute("class") || "") && /is-visited/.test(li.getAttribute("class") || "")).length;
      const listStatusWords = {};
      for (const li of list) { const m = (li.textContent.match(/visited|next to explore|not reached yet|open, not ratified/i) || ["?"])[0].toLowerCase(); listStatusWords[m] = (listStatusWords[m] || 0) + 1; }
      return {
        islands: isl.length, visited: visited.length, frontier: frontier.length, fogged: fogged.length, visibleFogDots: fogDots.length,
        visitedDiscFills: fills,
        counter: (document.querySelector("#atlas-count") || {}).textContent || null,
        listItems: list.length, listVisitedClass: listVisited, listStatusWords,
        contested: isl.filter((g) => classOf(g).includes("is-contested")).map((g) => g.getAttribute("data-id")),
        openVisited: isl.filter((g) => classOf(g).includes("is-open") && classOf(g).includes("is-visited")).length,
        openLabelsShown: isl.filter((g) => classOf(g).includes("is-open") && /open, not ratified/i.test(g.textContent)).length,
      };
    })()`);
    // Readability of the fully lit map: labels that sit on other labels, discs covered by another place's label.
    info.geometry = JSON.parse(JSON.stringify(await pg.eval(`(() => {
      const isl = [...document.querySelectorAll("#atlas-map g.atlas-island[data-id]")];
      const boxesOf = (g) => [...g.querySelectorAll("text")].map((t) => t.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
      const texts = isl.map((g) => ({ id: g.getAttribute("data-id"), boxes: boxesOf(g) }));
      const discs = isl.map((g) => { const r = (g.querySelector(".atlas-hit") || g.querySelector(".atlas-disc")).getBoundingClientRect(); return { id: g.getAttribute("data-id"), cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
      const inter = (a, b) => { const w = Math.min(a.right, b.right) - Math.max(a.left, b.left); const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); return w > 0 && h > 0 ? w * h : 0; };
      const area = (r) => r.width * r.height;
      const overlaps = new Map();
      for (let i = 0; i < texts.length; i += 1) for (let j = i + 1; j < texts.length; j += 1) for (const a of texts[i].boxes) for (const b of texts[j].boxes) {
        const f = inter(a, b) / Math.min(area(a), area(b));
        if (f > 0.2) { const key = texts[i].id + " / " + texts[j].id; overlaps.set(key, Math.max(overlaps.get(key) || 0, Math.round(f * 100))); }
      }
      const covered = [];
      for (const d of discs) for (const t of texts) { if (t.id === d.id) continue; if (t.boxes.some((b) => d.cx > b.left && d.cx < b.right && d.cy > b.top && d.cy < b.bottom)) covered.push(d.id + " under the label of " + t.id); }
      const labelless = texts.filter((t) => t.boxes.length === 0).map((t) => t.id);
      return { places: isl.length, labelOverlaps: [...overlaps].map(([k, v]) => k + " (" + v + "% of the smaller label)"), discsUnderOtherLabels: covered, withoutLabel: labelless };
    })()`)));
    const counterOk = new RegExp(`^${TOTAL} of ${TOTAL}\\b`).test(info.counter || "");
    const pass = info.islands === TOTAL && info.visited === TOTAL && info.frontier === 0 && info.fogged === 0 && info.visibleFogDots === 0 && counterOk && info.listItems === TOTAL && info.listVisitedClass === TOTAL;
    info.counterOk = counterOk;
    info.pass = pass;
    info.screens = [];
    // Overview and a screenshot per region: scroll the map panel so every region is readable.
    const wrap = "#atlas-map";
    info.screens.push(await shot(pg, `final-${label}-overview.png`));
    for (const region of REGIONS) {
      await pg.eval(`(() => {
        const svg = document.querySelector("#atlas-map svg");
        const wrap = document.querySelector("#atlas-map");
        const box = svg.viewBox.baseVal;
        const scale = svg.getBoundingClientRect().width / box.width;
        const target = ${region.x} * scale - wrap.clientWidth / 2;
        wrap.scrollTo({ left: Math.max(0, target), behavior: "instant" });
        wrap.scrollIntoView({ block: "center", behavior: "instant" });
        return true;
      })()`);
      await sleep(250);
      const ids = ISLANDS.filter((i) => i.region === region.id).map((i) => i.id);
      // Which places of the region lie fully inside what the screenshot shows (the map panel, within the window).
      const outside = () => pg.eval(`(() => {
        const wrap = document.querySelector("#atlas-map").getBoundingClientRect();
        return ${JSON.stringify(ids)}.filter((id) => {
          const r = document.querySelector('#atlas-map g.atlas-island[data-id="' + id + '"] .atlas-hit').getBoundingClientRect();
          return !(r.left >= Math.max(0, wrap.left) - 1 && r.right <= Math.min(innerWidth, wrap.right) + 1 && r.top >= Math.max(0, wrap.top) - 1 && r.bottom <= Math.min(innerHeight, wrap.bottom) + 1);
        });
      })()`);
      const file1 = await shot(pg, `final-${label}-${region.level}-${region.id}.png`);
      info.screens.push(file1);
      let missing = await outside();
      const shots = [file1];
      // A region taller or wider than the window: another screenshot, centred on a place that was out of view. A place counts
      // as shown when it lies fully inside at least one of the region's screenshots.
      for (let extra = 2; missing.length && extra <= 4; extra += 1) {
        await pg.eval(`document.querySelector('#atlas-map g.atlas-island[data-id="${missing[0]}"] .atlas-hit').scrollIntoView({ block: "center", inline: "center", behavior: "instant" })`);
        await sleep(250);
        const file = await shot(pg, `final-${label}-${region.level}-${region.id}-part${extra}.png`);
        info.screens.push(file);
        shots.push(file);
        const outNow = await outside();
        missing = missing.filter((id) => outNow.includes(id));
      }
      (info.regionShots ||= []).push({ region: region.id, level: region.level, places: ids.length, shots, notInAnyShot: missing });
    }
    await pg.eval(`document.querySelector("#atlas-map").scrollTo({ left: 0, behavior: "instant" })`);
    return info;
  }
}

/**
 * Keyboard only: focus the map, then Page Down through every visible place and record each one that takes focus and
 * what its accessible name says. Real key events; nothing is clicked.
 */
async function keyboardPass(page) {
  await page.eval(`window.scrollTo({ top: 0, behavior: "instant" }); document.querySelector("#atlas-map").scrollIntoView({ block: "start" }); document.querySelector('#atlas-map [tabindex="0"]').focus();`);
  // Page Up walks back to the first place (the map starts focus wherever it last was), then Page Down walks all of them.
  const activeId = `(() => { const a = document.activeElement; const g = a && a.closest && a.closest("g.atlas-island[data-id]"); return g ? g.getAttribute("data-id") : null; })()`;
  for (let i = 0; i < TOTAL + 8; i += 1) {
    const before = await page.eval(activeId);
    await page.press("PageUp");
    if ((await page.eval(activeId)) === before) break;
  }
  const seen = [];
  for (let i = 0; i < TOTAL + 8; i += 1) {
    const now = await page.eval(`(() => { const a = document.activeElement; const g = a && a.closest && a.closest("g.atlas-island[data-id]"); return g ? { id: g.getAttribute("data-id"), label: g.getAttribute("aria-label") || a.getAttribute("aria-label") || "", role: a.getAttribute("role") } : null; })()`);
    if (now && !seen.some((s) => s.id === now.id)) seen.push(now);
    await page.press("PageDown");
  }
  const byId = new Map(seen.map((s) => [s.id, s]));
  const missing = ISLANDS.filter((i) => !byId.has(i.id)).map((i) => i.id);
  const unnamed = seen.filter((s) => { const island = BY_ID.get(s.id); return !island || !s.label.includes(island.name) || !/visited/i.test(s.label); }).map((s) => s.id);
  return { focused: seen.length, missing, unnamed, pass: seen.length === TOTAL && missing.length === 0 && unnamed.length === 0, order: seen.map((s) => s.id) };
}

function write(env) {
  fs.writeFileSync(path.join(OUT, "journey.json"), JSON.stringify({ env, turns }, null, 2));
  const lines = [`# Live Atlas journey`, ``, `- URL: ${env.url}`, `- Provider: ${env.provider}`, `- Viewport: ${env.viewport}${env.mobile ? " (touch emulation)" : ""}${env.keysOnly ? ", keyboard only" : ""}`, `- Started: ${env.started}`, `- Finished: ${env.finished || "not finished"}`, `- Verdict: ${env.verdict || "NOT PASSED"}`, ``];
  for (const t of turns) {
    lines.push(`## Turn ${t.number}: ${t.entry}${t.concept ? ` (${t.concept})` : ""}`, ``);
    if (t.reason) lines.push(`Why a typed follow-up was needed: ${t.reason}`, ``);
    if (t.correlation) lines.push(`Correlation: conversation ${t.correlation.conversationId || "?"}, request ${t.correlation.requestId || "?"}, run ${t.correlation.runId || "?"}, native work ref ${t.correlation.nativeWorkRef || "?"}${t.busyRefusals ? `, refusals before it was accepted ${t.busyRefusals}` : ""}`, ``);
    for (const r of t.refusals || []) lines.push(`Refused (attempt ${r.attempt}, at ${r.atSeconds}s) with: ${r.chatStatus}`, ``);
    lines.push(`**You:** ${t.question}`, ``, `**Outcome:** ${t.outcome || "n/a"} in ${t.seconds ?? "?"}s`, ``);
    if (t.answer) lines.push(`**Answer:**`, ``, t.answer, ``);
    if (t.failure) lines.push(`**Failure shown:** ${JSON.stringify(t.failure)}`, ``);
    lines.push(`Visited ${t.before.visited.length} -> ${t.after ? t.after.visited.length : "?"} of ${TOTAL}; newly visited: ${(t.newlyVisited || []).join(", ") || "none"}`, ``);
    lines.push(`Transitions: ${t.transitions.map((x) => `${x.at}s ${x.phase}${x.chatStatus ? " [" + x.chatStatus + "]" : ""}`).join(" | ")}`, ``);
    lines.push(`Offered next steps: ${(t.offered || []).join(" | ") || "none"}`, `Screenshot: ${t.screenshot || ""}`, ``);
  }
  fs.writeFileSync(path.join(OUT, "transcript.md"), lines.join("\n"));
  // Coverage: one row per concept, filled from what actually happened.
  const header = "level,region,node_id,concept,design_status,teaser,prior_observation,new_turn_references,reachable_via_ui,answer_relevant,matcher_correct,map_and_list_readable,keyboard_accessible,evidence_path,verification_result";
  const esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const rows = [header];
  const visitedBy = new Map();
  for (const t of turns) for (const id of t.newlyVisited || []) if (!visitedBy.has(id)) visitedBy.set(id, t);
  for (const island of ISLANDS) {
    const t = visitedBy.get(island.id);
    const asked = turns.filter((x) => x.concept === island.id).map((x) => x.number);
    const done = Boolean(t);
    const own = t && String(t.concept) === island.id;
    rows.push([
      LEVEL.get(island.region), REGION_NAME.get(island.region), island.id, island.name, island.status || "standard", island.teaser,
      island.id === START_ID ? "Seeded starting node" : "", asked.join(" ") + (t ? ` (visited in turn ${t.number})` : ""),
      done ? (island.id === START_ID ? "seed" : own || t.entry ? `yes: ${t.entry}` : "yes") : "NOT RUN", done ? "see transcript" : "NOT RUN",
      done ? "lit by a final assistant answer" : "NOT RUN", done ? "see final map/list screenshots" : "NOT RUN", (env.keyboard ? (env.keyboard.order.includes(island.id) && !env.keyboard.unnamed.includes(island.id) ? "focusable by Page Down with a name and visited status" : "NOT REACHED BY KEYBOARD") : "NOT RUN"),
      t ? t.screenshot : "", done ? "PASSED (visited by a real answer)" : "NOT RUN",
    ].map(esc).join(","));
  }
  fs.writeFileSync(path.join(OUT, "coverage.csv"), rows.join("\n") + "\n");
}

main();
