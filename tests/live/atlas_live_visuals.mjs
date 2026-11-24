/**
 * Live visual checks of findings F04 (reading an answer), F06 (the inspector while scrolling), F05 (phone
 * navigation) and F08 (the first screen), through the real page and the real backend:
 *
 *   ATLAS_CHROME_ARGS="--ignore-certificate-errors" node tests/live/atlas_live_visuals.mjs --out <dir> [--url https://127.0.0.1:8766/]
 *
 *  1. the first screen at 1440x900, 1366x768, 1280x800, 390x844 and 320x740: the question button is on screen, the
 *     Gate 1 sentence is not visible text, nothing scrolls sideways;
 *  2. 1440x1000: the first real answer is laid out as paragraphs with speaker labels, its start is on screen; hovering a
 *     place and scrolling down with the mouse wheel keeps the place's card;
 *  3. 390x844 and 320x740: the first answer, the dock to the map, the List view with its filters, no sideways scroll.
 *
 * Real mouse, wheel, touch and typed events only. Screenshots and the measurements go to <out>.
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
const OUT = path.resolve(argv.get("out") || `/tmp/atlas-live-visuals-${Date.now()}`);
fs.mkdirSync(path.join(OUT, "screenshots"), { recursive: true });

const results = [];
const measurements = {};
const diagnostics = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 500) });
  log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
}
const shot = async (page, name) => {
  const file = path.join(OUT, "screenshots", name);
  await page.screenshot(file);
  return `screenshots/${name}`;
};

async function ready(page, timeout = 40000) {
  await page.waitFor(`document.querySelector("#phase") && document.querySelector("#phase").textContent.trim() === "ready"`, { timeout, what: "chat ready" });
}

async function openFresh(browser, label, { width, height, mobile = false }) {
  const page = await browser.openPage({ label, diagnostics, width, height });
  if (mobile) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  }
  await page.goto(URL);
  await ready(page);
  await sleep(700);
  return page;
}

async function answered(page, assistantBefore = 0, timeout = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await page.eval(`(() => ({ phase: document.querySelector("#phase").textContent.trim(), a: document.querySelectorAll('#history li[data-role="assistant"]').length }))()`);
    if (s.phase === "ready" && s.a > assistantBefore) {
      await sleep(1500);
      return true;
    }
    if (["failed", "unavailable", "cancelled", "rejected"].includes(s.phase)) return false;
    await sleep(800);
  }
  return false;
}

const FIRST_SCREEN = `(() => {
  const vh = innerHeight;
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.closest("[hidden]") && !el.closest("details:not([open]) > :not(summary)"); };
  const ask = document.querySelector(".hero-ask");
  const r = ask ? ask.getBoundingClientRect() : null;
  const gate = [...document.querySelectorAll("body *")].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && /Gate\\s*1/i.test(n.textContent)) && visible(el)).map((el) => el.tagName + "." + el.className);
  const h1 = document.querySelector("h1");
  return {
    h1: h1 ? h1.textContent.trim() : null,
    askText: ask ? ask.textContent.trim() : null,
    askInFirstScreen: Boolean(r) && r.top >= 0 && r.bottom <= vh && r.width > 0,
    askBottom: r ? Math.round(r.bottom) : null,
    innerHeight: vh,
    visibleGateText: gate,
    docWidth: document.documentElement.scrollWidth,
    innerWidth,
  };
})()`;

async function main() {
  const browser = await launchBrowser(findChrome().path);
  try {
    // ---------- 1. the first screen ----------
    for (const [w, h, mobile] of [[1440, 900, false], [1366, 768, false], [1280, 800, false], [390, 844, true], [320, 740, true]]) {
      const page = await openFresh(browser, `first-${w}x${h}`, { width: w, height: h, mobile });
      const m = JSON.parse(JSON.stringify(await page.eval(FIRST_SCREEN)));
      measurements[`first-screen-${w}x${h}`] = { ...m, screenshot: await shot(page, `first-screen-${w}x${h}.png`) };
      check(`${w}x${h}: the question button is in the first screen`, m.askInFirstScreen, JSON.stringify(m));
      check(`${w}x${h}: no Gate 1 wording is visible text`, m.visibleGateText.length === 0, JSON.stringify(m.visibleGateText));
      check(`${w}x${h}: the page does not scroll sideways`, m.docWidth <= m.innerWidth + 1, `${m.docWidth} vs ${m.innerWidth}`);
      await page.close();
    }

    // ---------- 2. desktop: reading the first answer, and the inspector while scrolling ----------
    let page = await openFresh(browser, "desktop-reading", { width: 1440, height: 1000 });
    await page.click(".hero-ask");
    const ok = await answered(page, 0);
    check("desktop: the first live answer arrives", ok);
    if (ok) {
      const read = JSON.parse(JSON.stringify(await page.eval(`(() => {
        const rows = [...document.querySelectorAll("#history li")];
        const a = [...document.querySelectorAll('#history li[data-role="assistant"]')].at(-1);
        const p = a.querySelector("p");
        const history = document.querySelector("#history");
        const hr = history.getBoundingClientRect();
        const ar = a.getBoundingClientRect();
        return {
          rows: rows.map((li) => ({ role: li.getAttribute("data-role"), label: (li.querySelector(".speaker") || {}).textContent || null })),
          whiteSpace: getComputedStyle(p).whiteSpace,
          paragraphBreaks: (p.textContent.match(/\\n\\n/g) || []).length,
          words: p.textContent.trim().split(/\\s+/).length,
          historyHeight: Math.round(hr.height),
          answerTopInHistory: Math.round(ar.top - hr.top),
          answerStartInView: ar.top >= 0 && ar.top < innerHeight,
          historyScrollTop: Math.round(history.scrollTop),
          mapWidth: Math.round(document.querySelector("#atlas-map").getBoundingClientRect().width),
          chatWidth: Math.round(document.querySelector("#conversation").getBoundingClientRect().width),
        };
      })()`)));
      measurements["desktop-reading"] = { ...read, screenshot: await shot(page, "desktop-first-answer.png") };
      check("desktop: speakers are labelled", read.rows.length >= 2 && read.rows.every((r) => r.label), JSON.stringify(read.rows));
      check("desktop: the answer keeps its paragraph breaks", read.whiteSpace.startsWith("pre-") && read.paragraphBreaks >= 2, JSON.stringify({ ws: read.whiteSpace, breaks: read.paragraphBreaks }));
      check("desktop: the start of the answer is on screen", read.answerStartInView, JSON.stringify(read));
    }
    // F06: hover a place near the top of the map, then scroll the page with the wheel; the place's card must remain.
    await page.eval(`window.scrollTo({ top: 0, behavior: "instant" })`);
    await sleep(500);
    const spot = JSON.parse(JSON.stringify(await page.eval(`(() => { const g = document.querySelector('#atlas-map [data-id="internet-bill"] .atlas-hit'); g.scrollIntoView({ block: "start", behavior: "instant" }); const r = g.getBoundingClientRect(); const ins = document.querySelector("#atlas-inspector").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, inspectorTop: Math.round(ins.top), innerHeight }; })()`)));
    await sleep(400);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x, y: spot.y, button: "none", clickCount: 0 });
    await sleep(600);
    const hovered = await page.eval(`(document.querySelector("#atlas-inspector .atlas-inspector-name") || {}).textContent || null`);
    for (let i = 0; i < 6; i += 1) {
      await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: spot.x, y: spot.y, deltaX: 0, deltaY: 120 });
      await sleep(80);
    }
    await sleep(800);
    const afterScroll = JSON.parse(JSON.stringify(await page.eval(`(() => { const n = document.querySelector("#atlas-inspector .atlas-inspector-name"); const ins = document.querySelector("#atlas-inspector").getBoundingClientRect(); return { name: n ? n.textContent : null, text: document.querySelector("#atlas-inspector").textContent.replace(/\\s+/g, " ").trim().slice(0, 240), top: Math.round(ins.top), bottom: Math.round(ins.bottom), innerHeight, scrollY: Math.round(scrollY) }; })()`)));
    measurements["inspector-hover-scroll"] = { before: spot, hovered, afterScroll, screenshot: await shot(page, "desktop-inspector-after-scroll.png") };
    check("desktop: hovering a place shows its card", Boolean(hovered), String(hovered));
    check("desktop: after scrolling down the card still describes that place", afterScroll.name === hovered && afterScroll.scrollY > 100, JSON.stringify(afterScroll));
    check("desktop: the card is within reach on screen after the scroll", afterScroll.top < afterScroll.innerHeight && afterScroll.bottom > 0, JSON.stringify(afterScroll));
    await page.close();

    // ---------- 3. phones ----------
    for (const [w, h] of [[390, 844], [320, 740]]) {
      page = await openFresh(browser, `phone-${w}`, { width: w, height: h, mobile: true });
      await page.click(".hero-ask");
      const okPhone = await answered(page, 0);
      check(`${w}x${h}: the first live answer arrives on a touch screen`, okPhone);
      if (!okPhone) {
        await page.close();
        continue;
      }
      const state = JSON.parse(JSON.stringify(await page.eval(`(() => {
        const a = [...document.querySelectorAll('#history li[data-role="assistant"]')].at(-1);
        const r = a.getBoundingClientRect();
        const dock = document.querySelector(".atlas-dock");
        return { answerTop: Math.round(r.top), innerHeight, dock: dock ? [...dock.querySelectorAll("button, a")].map((b) => b.textContent.trim()) : null, docWidth: document.documentElement.scrollWidth, innerWidth };
      })()`)));
      const afterAnswer = await shot(page, `phone-${w}-after-answer.png`);
      check(`${w}x${h}: no sideways scroll after an answer`, state.docWidth <= state.innerWidth + 1, JSON.stringify(state));
      check(`${w}x${h}: a dock leads from the answer to the map`, state.dock && state.dock.length >= 2, JSON.stringify(state.dock));
      // The dock's map button, then the List view.
      const mapButton = await page.eval(`(() => { const b = [...document.querySelectorAll(".atlas-dock button, .atlas-dock a")].find((x) => /map|new|places/i.test(x.textContent)); if (!b) return false; b.setAttribute("data-live-dock", "1"); return b.textContent.trim(); })()`);
      if (mapButton) {
        await page.click('[data-live-dock="1"]');
        await sleep(900);
      }
      const mapScreen = await shot(page, `phone-${w}-map.png`);
      await page.click("#atlas-view-list");
      await sleep(700);
      const list = JSON.parse(JSON.stringify(await page.eval(`(() => ({
        items: document.querySelectorAll("#atlas-list li.atlas-list-item").length,
        controls: [...document.querySelectorAll("#atlas-list button, #atlas-list select, #atlas-list input, #atlas-list a")].slice(0, 14).map((b) => (b.textContent || b.getAttribute("aria-label") || b.type || "").trim().slice(0, 40)),
        docHeight: document.documentElement.scrollHeight, docWidth: document.documentElement.scrollWidth, innerWidth,
      }))()`)));
      measurements[`phone-${w}`] = { afterAnswer: state, dockButton: mapButton, list, screenshots: [afterAnswer, mapScreen] };
      check(`${w}x${h}: the List keeps every concept reachable`, list.items === 65, JSON.stringify(list));
      check(`${w}x${h}: the List does not scroll sideways`, list.docWidth <= list.innerWidth + 1, JSON.stringify(list));
      measurements[`phone-${w}`].screenshots.push(await shot(page, `phone-${w}-list.png`));
      await page.close();
    }
  } catch (error) {
    check("live visual checks ran to the end", false, error && error.stack ? error.stack : error);
  } finally {
    fs.writeFileSync(
      path.join(OUT, "live-visuals.json"),
      JSON.stringify({ url: URL, finished: new Date().toISOString(), results, measurements, console: diagnostics.filter((d) => d.level === "error" || d.kind === "exception").map((d) => `${d.kind}:${d.text}`.slice(0, 160)) }, null, 2),
    );
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
