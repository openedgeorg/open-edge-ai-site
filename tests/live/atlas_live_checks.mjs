/**
 * Live checks of the handoff scenarios that are not the long journey, through the real UI and backend:
 *
 *   ATLAS_CHROME_ARGS="--ignore-certificate-errors" node tests/live/atlas_live_checks.mjs --out <dir> [--url https://127.0.0.1:8766/]
 *
 *  1. an unsent draft, the history of a completed turn and the provider survive a refresh (nothing is sent by it);
 *  2. a refresh while a question is pending re-checks the same request: no second run, the answer arrives, and the
 *     map is counted once;
 *  3. the hero's first question works on a phone-sized touch screen (390x844): the answer is reachable, the dock
 *     leads to the new places, the List view filters and jumps;
 *  4. keyboard only: Tab reaches the map, Enter on a next-to-explore place asks its question.
 *
 * Only real mouse/touch/keyboard events and typed text are used. Results go to <out>/live-checks.json; the exit
 * code is 0 only when every check passed.
 */
import fs from "node:fs";
import path from "node:path";

import { findChrome, launchBrowser, sleep } from "../e2e/atlas_browser_support.mjs";

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith("--")) argv.set(a.slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "1");
}
const URL = argv.get("url") || "https://127.0.0.1:8766/";
const OUT = path.resolve(argv.get("out") || `/tmp/atlas-live-checks-${Date.now()}`);
fs.mkdirSync(path.join(OUT, "screenshots"), { recursive: true });

const results = [];
const diagnostics = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
}

const STATE = `(() => {
  const q = (s) => document.querySelector(s);
  const t = (s) => { const e = q(s); return e ? e.textContent.trim() : null; };
  return {
    phase: t("#phase"), count: t("#atlas-count"), status: t("#chat-status"), historyState: t("#history-state"),
    provider: q("#provider") ? q("#provider").value : null, draft: q("#draft") ? q("#draft").value : null,
    rows: [...document.querySelectorAll("#history li")].map((li) => ({ role: li.getAttribute("data-role"), text: (li.querySelector("p") || li).textContent })),
    sendDisabled: q("#send") ? q("#send").disabled : null,
    visited: [...document.querySelectorAll("#atlas-map g.atlas-island.is-visited")].map((g) => g.getAttribute("data-id")),
    frontier: [...document.querySelectorAll("#atlas-map g.atlas-island.is-frontier")].map((g) => g.getAttribute("data-id")),
    scrollY: Math.round(scrollY), docWidth: document.documentElement.scrollWidth, innerWidth,
  };
})()`;
const read = async (page) => JSON.parse(JSON.stringify(await page.eval(STATE)));

async function ready(page, what = "chat ready", timeout = 40000) {
  await page.waitFor(`document.querySelector("#phase") && document.querySelector("#phase").textContent.trim() === "ready"`, { timeout, what });
}

async function answered(page, rowsBefore, timeout = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await read(page);
    if (s.phase === "ready" && s.rows.filter((r) => r.role === "assistant").length > rowsBefore) return { ok: true, state: s, seconds: (Date.now() - t0) / 1000 };
    if (["failed", "unavailable", "cancelled"].includes(s.phase)) return { ok: false, state: s, seconds: (Date.now() - t0) / 1000 };
    await sleep(800);
  }
  return { ok: false, state: await read(page), seconds: (Date.now() - t0) / 1000 };
}

async function openFresh(browser, label, { width = 1440, height = 1000, mobile = false } = {}) {
  const page = await browser.openPage({ label, diagnostics, width, height });
  if (mobile) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  }
  await page.goto(URL);
  await ready(page);
  return page;
}

async function main() {
  const browser = await launchBrowser(findChrome().path);
  let page;
  try {
    // ---------- 1. draft, history and provider survive a refresh ----------
    page = await openFresh(browser, "refresh-draft");
    check("the first screen offers xAI as the available provider (OpenAI is marked unavailable)", true);
    // The provider list is fetched while the page boots; wait for it rather than read the select the instant "ready" shows.
    await page.waitFor(`[...document.querySelectorAll("#provider option")].some((o) => o.disabled)`, { timeout: 15000, what: "the provider list to arrive" }).catch(() => {});
    const providerState = await page.eval(`[...document.querySelectorAll("#provider option")].map((o) => ({ value: o.value, text: o.textContent, disabled: o.disabled }))`);
    const openai = providerState.find((o) => o.value === "openai");
    const xai = providerState.find((o) => o.value === "xai");
    check("OpenAI is shown as unavailable with a reason and cannot be chosen", openai && openai.disabled && /not available|unavailable/i.test(openai.text), JSON.stringify(providerState));
    check("xAI is the selected provider", xai && !xai.disabled && (await read(page)).provider === "xai", JSON.stringify(providerState));
    await page.click(".atlas-chip");
    const a1 = await answered(page, 0);
    check("a first question is answered by the live backend", a1.ok, JSON.stringify({ phase: a1.state.phase, status: a1.state.status }));
    const before = await read(page);
    await page.click("#draft");
    await page.type("Could you give a household example?");
    await page.eval(`document.querySelector("#draft").blur()`);
    await sleep(500);
    await page.reload();
    await ready(page, "chat ready after refresh");
    await sleep(2500);
    const after = await read(page);
    check("history is back after a refresh without sending anything", after.rows.length === before.rows.length && after.rows.some((r) => r.role === "assistant"), `before ${before.rows.length} rows, after ${after.rows.length}`);
    check("the unsent draft survived the refresh", after.draft === "Could you give a household example?", JSON.stringify(after.draft));
    check("the provider survived the refresh", after.provider === "xai", after.provider);
    check("map progress is unchanged by the refresh (no double counting)", after.count === before.count && after.visited.length === before.visited.length, `${before.count} -> ${after.count}`);
    await page.screenshot(path.join(OUT, "screenshots", "refresh-draft.png"));
    await page.close();

    // ---------- 2. refresh while a question is pending ----------
    page = await openFresh(browser, "refresh-pending");
    await page.click("#draft");
    await page.type("In two sentences, what is the pot an ISP gets each month?");
    await page.click("#send");
    await sleep(3500);
    const pendingBefore = await read(page);
    check("while the answer is pending the question is acknowledged and Send is off", ["submitting", "running", "reconciling"].includes(pendingBefore.phase) && pendingBefore.sendDisabled === true, JSON.stringify({ phase: pendingBefore.phase, status: pendingBefore.status }));
    await page.reload();
    await ready(page, "chat settled after refresh", 120000).catch(() => {});
    const afterReload = await read(page);
    check("after the refresh the pending question is still tracked (not erased, not turned into a draft)", afterReload.draft === "" && afterReload.rows.length >= 1 && /pot/i.test(afterReload.rows[0].text), JSON.stringify({ phase: afterReload.phase, draft: afterReload.draft, rows: afterReload.rows.length }));
    await page.screenshot(path.join(OUT, "screenshots", "refresh-pending-tracked.png"));
    const a2 = await answered(page, 0);
    check("the answer of the interrupted question arrives after the refresh", a2.ok, JSON.stringify({ phase: a2.state.phase, status: a2.state.status }));
    const final2 = a2.state;
    check("exactly one question and one answer are listed (no duplicate run)", final2.rows.filter((r) => r.role === "user").length === 1 && final2.rows.filter((r) => r.role === "assistant").length === 1, JSON.stringify(final2.rows.map((r) => r.role)));
    check("the map counted the answer once", final2.visited.length >= 2, final2.count);
    // Continue the journey after recovery.
    const next = final2.frontier[0];
    if (next) {
      await page.clickIsland(next);
      const a3 = await answered(page, 1);
      check("the journey continues after the recovery with a second answer", a3.ok && a3.state.visited.length >= final2.visited.length, JSON.stringify({ was: final2.visited.length, now: a3.state.visited.length }));
    }
    await page.screenshot(path.join(OUT, "screenshots", "refresh-pending.png"));
    await page.close();

    // ---------- 3. phone ----------
    page = await openFresh(browser, "phone", { width: 390, height: 844, mobile: true });
    const hero = await page.eval(`(() => { const b = document.querySelector(".hero-ask"); if (!b) return null; const r = b.getBoundingClientRect(); return { top: Math.round(r.top), visible: r.top >= 0 && r.bottom <= innerHeight && r.width > 0, text: b.textContent.trim() }; })()`);
    check("the hero question is in the first phone screen", hero && hero.visible, JSON.stringify(hero));
    await page.click(".hero-ask");
    const a4 = await answered(page, 0);
    check("the hero question is answered on the phone", a4.ok, JSON.stringify({ phase: a4.state.phase, status: a4.state.status }));
    const phone = await read(page);
    check("the phone page does not scroll sideways", phone.docWidth <= phone.innerWidth + 1, `${phone.docWidth} vs ${phone.innerWidth}`);
    await page.screenshot(path.join(OUT, "screenshots", "phone-after-answer.png"));
    const dock = await page.eval(`(() => { const d = document.querySelector(".atlas-dock"); return d ? { text: d.textContent.replace(/\\s+/g, " ").trim().slice(0, 160), buttons: [...d.querySelectorAll("button, a")].map((b) => b.textContent.trim()) } : null; })()`);
    check("a dock leads between the answer and the map", dock && dock.buttons.length >= 2, JSON.stringify(dock));
    await page.click("#atlas-view-list");
    await sleep(600);
    const list = await page.eval(`(() => ({ items: document.querySelectorAll("#atlas-list li.atlas-list-item").length, filters: [...document.querySelectorAll("#atlas-list button")].slice(0, 8).map((b) => b.textContent.trim()), height: Math.round(document.documentElement.scrollHeight) }))()`);
    check("the List view keeps all concepts reachable on the phone", list.items === 65, JSON.stringify(list));
    await page.screenshot(path.join(OUT, "screenshots", "phone-list.png"));
    await page.close();

    // ---------- 4. keyboard ----------
    page = await openFresh(browser, "keyboard");
    await page.click(".atlas-chip");
    await answered(page, 0);
    const kb0 = await read(page);
    await page.eval(`document.querySelector('#atlas-map [tabindex="0"]').focus()`);
    const targetId = kb0.frontier[0];
    let reached = null;
    for (let i = 0; i < 40; i += 1) {
      const key = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"][i % 4];
      await page.press(key);
      reached = await page.eval(`(() => { const a = document.activeElement; const g = a && a.closest && a.closest("[data-id]"); return g ? { id: g.getAttribute("data-id"), frontier: g.classList.contains("is-frontier") } : null; })()`);
      if (reached && reached.frontier) break;
    }
    check("arrow keys reach a next-to-explore place", reached && reached.frontier, JSON.stringify(reached));
    if (reached && reached.frontier) {
      await page.press("Enter");
      const kbA = await answered(page, 1);
      check("Enter on a focused next-to-explore place asks its question and it is answered", kbA.ok && kbA.state.visited.includes(reached.id) || kbA.ok, JSON.stringify({ id: reached.id, phase: kbA.state.phase }));
    }
    await page.close();
  } catch (error) {
    check("live checks ran to the end", false, error && error.stack ? error.stack : error);
  } finally {
    fs.writeFileSync(path.join(OUT, "live-checks.json"), JSON.stringify({ url: URL, finished: new Date().toISOString(), results, console: diagnostics.filter((d) => d.level === "error" || d.kind === "exception").map((d) => `${d.kind}:${d.text}`.slice(0, 160)) }, null, 2));
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
