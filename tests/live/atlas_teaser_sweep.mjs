/**
 * Live sweep of the matcher's recall: ask the live assistant the question every place of the map offers, one after the
 * other, and record whether the finished answer lights the place it was about. A development tool, not a verification:
 * the answers are the model's own and differ from run to run, so this finds wordings the term lists have not seen.
 *
 *   ATLAS_CHROME_ARGS="--ignore-certificate-errors" node tests/live/atlas_teaser_sweep.mjs --out <file.json> \
 *     [--workers 3] [--per-conversation 8] [--only id,id] [--url https://127.0.0.1:8766/]
 *
 * Each worker is one browser page. It types the question in the message box and presses Send like a visitor (the map
 * is not used, so every question is asked whether or not the place is reachable), starts a fresh conversation after
 * --per-conversation questions, and presses Send again after a "still working on another message" or "not sent"
 * refusal, as the page says. Output: a JSON list of { id, question, answer, lights, ownLit, seconds }.
 */
import fs from "node:fs";
import path from "node:path";

import { ISLANDS } from "../../site/js/atlas-graph.js";
import { compileGlossary, matchReply } from "../../site/js/atlas-match.js";
import { findChrome, launchBrowser, sleep } from "../e2e/atlas_browser_support.mjs";

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith("--")) argv.set(a.slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "1");
}
const URL = argv.get("url") || "https://127.0.0.1:8766/";
const OUT = path.resolve(argv.get("out") || `/tmp/atlas-teaser-sweep-${Date.now()}.json`);
const WORKERS = Number(argv.get("workers") || 3);
const PER_CONVERSATION = Number(argv.get("per-conversation") || 8);
const only = argv.has("only") ? new Set(argv.get("only").split(",")) : null;

const glossary = compileGlossary(ISLANDS);
const queue = ISLANDS.filter((island) => !only || only.has(island.id)).map((island) => ({ id: island.id, question: island.teaser }));
const results = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const STATE = `(() => {
  const text = (s) => { const e = document.querySelector(s); return e ? e.textContent.trim() : ""; };
  const rows = [...document.querySelectorAll("#history li")].map((li) => ({ role: li.getAttribute("data-role") || "", text: (li.querySelector("p") || li).textContent }));
  return { phase: text("#phase"), status: text("#chat-status"), rows };
})()`;

async function ask(page, question) {
  const before = await page.eval(STATE);
  const assistantBefore = before.rows.filter((r) => r.role === "assistant").length;
  await page.click("#draft");
  await page.type(question);
  await page.click("#send");
  const t0 = Date.now();
  let refusals = 0;
  while (Date.now() - t0 < 400000) {
    await sleep(800);
    const s = await page.eval(STATE);
    const answers = s.rows.filter((r) => r.role === "assistant");
    if (s.phase === "ready" && answers.length > assistantBefore) return { answer: answers[answers.length - 1].text, seconds: (Date.now() - t0) / 1000, refusals };
    if (s.phase === "rejected" && /still working on another message|not sent|try again in a moment/i.test(s.status) && refusals < 4) {
      refusals += 1;
      await sleep(15000);
      await page.click("#send");
    } else if (["failed", "cancelled", "unavailable", "rejected"].includes(s.phase) && Date.now() - t0 > 3000) {
      return { answer: null, seconds: (Date.now() - t0) / 1000, refusals, failure: `${s.phase}: ${s.status}` };
    } else if (s.phase === "unresolved") {
      // The page polled for as long as the service can run a question (about 5.5 minutes), could not tell, and says so.
      return { answer: null, seconds: (Date.now() - t0) / 1000, refusals, failure: `unresolved: ${s.status}` };
    } else if (s.phase === "ready" && answers.length === assistantBefore && Date.now() - t0 > 20000) {
      // The page gave up honestly ("we could not confirm that your question arrived ... it will not be sent again").
      return { answer: null, seconds: (Date.now() - t0) / 1000, refusals, failure: `ready without an answer: ${s.status}` };
    }
  }
  return { answer: null, seconds: (Date.now() - t0) / 1000, refusals, failure: "timeout" };
}

const browser = await launchBrowser(findChrome().path);
async function worker(n) {
  const page = await browser.openPage({ label: `sweep-${n}`, diagnostics: [], width: 1440, height: 1000 });
  let asked = 0;
  for (;;) {
    const item = queue.shift();
    if (!item) break;
    if (asked % PER_CONVERSATION === 0) {
      await page.goto(URL);
      await page.eval("sessionStorage.clear()");
      await page.goto(URL);
      await page.waitFor(`document.querySelector("#phase") && document.querySelector("#phase").textContent.trim() === "ready"`, { timeout: 40000 });
      await sleep(1500);
    }
    asked += 1;
    const r = await ask(page, item.question);
    const lights = r.answer ? matchReply(r.answer, glossary) : [];
    results.push({ id: item.id, question: item.question, answer: r.answer, lights, ownLit: lights.includes(item.id), seconds: Number(r.seconds.toFixed(1)), refusals: r.refusals, failure: r.failure || null });
    log(`worker ${n}: ${item.id} ${r.answer ? (lights.includes(item.id) ? "own place lit" : "OWN PLACE NOT LIT") : "NO ANSWER " + r.failure} (${r.seconds.toFixed(0)}s, ${lights.length} lit)`);
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    // A page that gave up (unresolved, failed) cannot send again: the next question starts a fresh conversation.
    if (r.failure) asked = 0;
  }
  await page.close();
}
await Promise.all(Array.from({ length: WORKERS }, (_, n) => worker(n + 1)));
await browser.close();
const answered = results.filter((r) => r.answer);
const missed = answered.filter((r) => !r.ownLit);
log(`asked ${results.length}, answered ${answered.length}, own place lit in ${answered.length - missed.length}`);
for (const r of missed) log("MISS", r.id);
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
