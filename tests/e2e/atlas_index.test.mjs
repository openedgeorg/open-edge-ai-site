import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BEGIN_MARKER, END_MARKER, applyIndex, isInSync } from "../../scripts/atlas_index.mjs";
import * as graph from "../../site/js/atlas-graph.js";
import { formatSections, renderCount, suggestionItems } from "../../site/js/atlas-panel.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "atlas_index.mjs");
const HTML_PATH = join(ROOT, "site", "index.html");
const html = readFileSync(HTML_PATH, "utf8");

function noscriptIndex() {
  const begin = html.indexOf(BEGIN_MARKER);
  const end = html.indexOf(END_MARKER);
  assert.ok(begin !== -1 && end > begin, "index markers present and in order");
  return html.slice(begin + BEGIN_MARKER.length, end);
}

function decodeEntities(text) {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

test("the generator --check exits 0 for the shipped index.html", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(isInSync(html), true);
});

test("the generator --check exits non-zero when the index is stale, and --write repairs it", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-index-"));
  try {
    const file = join(dir, "index.html");
    const stale = html.replace("<strong>Overdraft</strong>", "<strong>Overdraught</strong>");
    assert.notEqual(stale, html);
    writeFileSync(file, stale);
    const check = spawnSync(process.execPath, [SCRIPT, "--check", "--html", file], { cwd: ROOT, encoding: "utf8" });
    assert.equal(check.status, 1, check.stderr);
    const write = spawnSync(process.execPath, [SCRIPT, "--write", "--html", file], { cwd: ROOT, encoding: "utf8" });
    assert.equal(write.status, 0, write.stderr);
    assert.equal(readFileSync(file, "utf8"), html);
    const again = spawnSync(process.execPath, [SCRIPT, "--check", "--html", file], { cwd: ROOT, encoding: "utf8" });
    assert.equal(again.status, 0, again.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the generator refuses a page without markers or without a flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-index-"));
  try {
    const file = join(dir, "index.html");
    writeFileSync(file, "<!DOCTYPE html><html><body><noscript></noscript></body></html>");
    const check = spawnSync(process.execPath, [SCRIPT, "--check", "--html", file], { cwd: ROOT, encoding: "utf8" });
    assert.equal(check.status, 2);
    const bare = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
    assert.equal(bare.status, 2);
    assert.throws(() => applyIndex(`${BEGIN_MARKER}\n${END_MARKER}`), /noscript/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("index.html has no inline scripts, no inline styles and no external URLs", () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 2, "app.js and atlas.js module tags");
  for (const [, attrs, body] of scripts) {
    assert.equal(body.trim(), "", "no inline <script> body");
    assert.match(attrs, /\bsrc="js\/[a-z-]+\.js"/);
  }
  assert.doesNotMatch(html, /<style\b/i, "no <style> element");
  assert.doesNotMatch(html, /\sstyle\s*=/i, "no style attribute");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline event handler");
  const external = html.match(/(?:src|href|action|content)\s*=\s*"\s*(?:https?:)?\/\/[^"]*"/gi) || [];
  assert.deepEqual(external, [], "no external http(s) or protocol-relative URL");
  assert.doesNotMatch(html, /https?:\/\//i, "no http(s) URL anywhere in the page");
});

test("index.html keeps the CSP meta tag, the stylesheet links and the module scripts", () => {
  assert.match(
    html,
    /<meta http-equiv="Content-Security-Policy" content="default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'">/,
  );
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((match) => match[1]);
  assert.deepEqual(links, ["css/main.css", "css/atlas.css", "css/atlas-panel.css"]);
  assert.match(html, /<script type="module" src="js\/app\.js"><\/script>\s*<script type="module" src="js\/atlas\.js"><\/script>/);
});

test("index.html contains every id of the page contract exactly once", () => {
  const ids = [
    "explore", "atlas", "atlas-title", "atlas-toolbar", "atlas-count", "atlas-view-map", "atlas-view-list",
    "atlas-reset", "atlas-map", "atlas-list", "atlas-inspector", "atlas-notice", "atlas-announce", "atlas-suggest",
    "conversation", "composer", "provider", "draft", "send", "cancel", "phase", "history",
  ];
  for (const id of ids) {
    const found = html.match(new RegExp(`\\sid="${id}"`, "g")) || [];
    assert.equal(found.length, 1, `id ${id} appears once`);
  }
  const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(all).size, all.length, "ids are unique");
  for (const name of [
    "atlas-section", "atlas-layout", "atlas-intro", "atlas-honesty", "atlas-toolbar", "atlas-count", "atlas-tabs",
    "atlas-map-wrap", "atlas-list-wrap", "atlas-inspector", "atlas-notice", "atlas-legend", "atlas-chat", "atlas-suggest",
  ]) {
    assert.match(html, new RegExp(`class="[^"]*\\b${name}\\b[^"]*"`), `class ${name} present`);
  }
  assert.match(html, /<section id="explore" class="section section-alt atlas-section" aria-labelledby="atlas-title">/);
  assert.match(html, /<div class="atlas-toolbar" id="atlas-toolbar" hidden>/, "toolbar is hidden until JS reveals it");
  assert.match(html, /<div id="atlas-list" class="atlas-list-wrap" hidden><\/div>/);
  assert.match(html, /<button type="button" id="atlas-view-map" aria-pressed="true">Map<\/button>/);
  assert.match(html, /<button type="button" id="atlas-view-list" aria-pressed="false">List<\/button>/);
  assert.match(html, /<button type="button" id="atlas-reset" class="atlas-reset">Clear map<\/button>/);
});

test("index.html uses the honest wording and the legend entries", () => {
  assert.match(html, /illustrative/);
  assert.match(html, /not company-approved/);
  assert.match(html, /&ldquo;Visited&rdquo; means an answer mentioned a place, not that it is understood or verified/);
  for (const phrase of ["visited", "next to explore", "awaits incorporation", "dashed outline", "open, not ratified"]) {
    assert.ok(html.includes(phrase), `legend mentions ${phrase}`);
  }
  assert.doesNotMatch(html, /\blearned\b/i);
});

test("every island appears in the no-JS index, in graph order, with its sections and label", () => {
  const index = decodeEntities(noscriptIndex());
  let cursor = 0;
  for (const island of graph.ISLANDS) {
    const position = index.indexOf(`<strong>${island.name}</strong>`, cursor);
    assert.ok(position >= 0, `island ${island.name} listed after the previous one`);
    cursor = position;
    const line = index.slice(position, index.indexOf("</li>", position));
    const sections = formatSections(island);
    assert.ok(sections && line.includes(sections), `${island.name} shows ${sections}`);
    if (island.label) assert.ok(line.includes(island.label), `${island.name} shows its label`);
    if (island.note) assert.ok(line.includes(island.note), `${island.name} shows its note`);
    assert.ok(line.includes(island.teaser), `${island.name} shows its teaser`);
  }
  for (const region of graph.REGIONS) {
    assert.ok(index.includes(`${region.name} · ${region.level} · ${region.subtitle}`), `region ${region.id} heading`);
  }
  assert.equal((index.match(/<li>/g) || []).length, graph.ISLANDS.length);
  assert.equal((html.match(/<noscript>/g) || []).length, 2, "atlas and conversation noscript blocks");
  assert.ok(html.lastIndexOf("<noscript>", html.indexOf(BEGIN_MARKER)) > html.indexOf('id="atlas"'));
});

test("no trace anchor text leaks into the page", () => {
  const page = decodeEntities(html);
  const anchors = new Set();
  for (const island of graph.ISLANDS) for (const entry of island.trace) anchors.add(entry.anchor);
  for (const edge of graph.EDGES) anchors.add(edge.trace.anchor);
  for (const anchor of anchors) {
    assert.ok(!page.includes(anchor), `anchor leaked: ${anchor}`);
  }
});

test("formatSections gives unique sorted section marks and never anchor text", () => {
  assert.equal(formatSections({ trace: [{ section: 3, anchor: "x" }, { section: 1, anchor: "y" }, { section: 3, anchor: "z" }] }), "§1, §3");
  assert.equal(
    formatSections(graph.ISLANDS.find((island) => island.id === "price-catalogue")),
    "§ status note, §4",
  );
  assert.equal(formatSections({ trace: [{ section: 10, anchor: "a" }, { section: 2, anchor: "b" }] }), "§2, §10");
  assert.equal(formatSections({ trace: { section: 6, anchor: "secret words" } }), "§6");
  assert.equal(formatSections({ trace: [] }), "");
  assert.equal(formatSections(null), "");
  for (const island of graph.ISLANDS) {
    for (const entry of island.trace) assert.ok(!formatSections(island).includes(entry.anchor));
    assert.match(formatSections(island), /^(§ status note|§\d+)(, §\d+)*$/);
  }
});

test("renderCount and suggestionItems follow the contract", () => {
  const el = { textContent: "" };
  renderCount(el, { visitedCount: 1, total: 60 });
  assert.equal(el.textContent, "1 of 60 visited");
  assert.deepEqual(suggestionItems({ replies: 0, frontier: [] }), [graph.FIRST_SUGGESTION]);
  const items = suggestionItems({
    replies: 2,
    frontier: ["tariff-format", "isp-counterparty", "standing-plan", "funding-pressure", "overdraft"],
  });
  assert.equal(items.length, 3);
  assert.deepEqual(items, [
    "Why do I pay my ISP instead of billing each app separately?",
    "Why a fixed monthly plan instead of paying per app?",
    "Can app price rises end up in my plan price?",
  ]);
  const dragonsLast = suggestionItems({ replies: 1, frontier: ["tariff-format", "overdraft"] });
  assert.equal(dragonsLast[0], graph.ISLANDS.find((island) => island.id === "overdraft").teaser);
  assert.deepEqual(suggestionItems({ replies: 3, frontier: [] }), []);
});

/** The opening tag (attributes included) of the first element matching a regex. */
function tagOf(pattern) {
  const found = html.match(pattern);
  assert.ok(found, `${pattern} is in the page`);
  return found[0];
}

test("the nav and the hero lead to the Atlas, and the page sections keep their order", () => {
  const nav = html.slice(html.indexOf('<ul class="nav-links">'), html.indexOf("</ul>", html.indexOf('<ul class="nav-links">')));
  const links = [...nav.matchAll(/<li><a href="([^"]+)">([^<]+)<\/a><\/li>/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(links, [["#about", "About"], ["#esp", "ESP"], ["#clear-ledger", "Clear Ledger"], ["#explore", "The Atlas"]]);
  const hero = html.slice(html.indexOf('<section class="hero">'), html.indexOf("</section>"));
  assert.match(hero, /<a class="hero-cta-link" href="#explore">Explore the design<\/a>/);
  assert.match(hero, /<span class="hero-cta-note" hidden>Ask a question and watch a map of the design light up\.<\/span>/, "the sentence about asking is hidden until the script runs");
  const order = ["about", "esp", "clear-ledger", "explore"].map((id) => html.indexOf(`<section id="${id}"`));
  assert.ok(order.every((at) => at > 0) && [...order].sort((a, b) => a - b).join() === order.join(), "About, ESP, Clear Ledger, then the Atlas");
});

test("the suggestion chips live in the Atlas card, under the honesty note and above the toolbar", () => {
  const atlas = html.indexOf('<div id="atlas" class="atlas">');
  const chat = html.indexOf('<div id="conversation" class="atlas-chat">');
  const suggest = html.indexOf('<div id="atlas-suggest" class="atlas-suggest"></div>');
  assert.ok(atlas < suggest && suggest < chat, "inside #atlas, before the chat card");
  assert.equal((html.match(/id="atlas-suggest"/g) || []).length, 1);
  assert.ok(html.indexOf('class="atlas-honesty"') < suggest && suggest < html.indexOf('id="atlas-toolbar"'));
  assert.ok(!html.slice(chat).includes("atlas-suggest"), "no chips in the chat card");
});

test("without JavaScript only the honesty note and the plain index describe the Atlas", () => {
  for (const pattern of [/<p class="atlas-intro"[^>]*>/, /<ul class="atlas-legend"[^>]*>/, /<p id="atlas-notice"[^>]*>/, /<div class="atlas-toolbar"[^>]*>/, /<span class="hero-cta-note"[^>]*>/]) {
    assert.match(tagOf(pattern), /\shidden[\s>]/, `${pattern} is hidden until the script runs`);
  }
  assert.doesNotMatch(tagOf(/<p class="atlas-honesty"[^>]*>/), /hidden/, "the honesty note is always shown");
  assert.match(html, /Glowing places are next to explore: tap one to ask about it\./);
});

test("the status elements: one polite notice, one spoken summary, and no live region on the inspector", () => {
  assert.match(tagOf(/<p id="atlas-notice"[^>]*>/), /role="status"/);
  assert.match(tagOf(/<p id="atlas-announce"[^>]*>/), /role="status"/);
  assert.doesNotMatch(tagOf(/<div id="atlas-inspector"[^>]*>/), /aria-live|role=/, "keyboard focus already announces a place");
  assert.doesNotMatch(tagOf(/<p id="atlas-count"[^>]*>/), /aria-live|role=/, "the spoken summary carries the count");
});

test("the chat card copy no longer points at sections 'above' it", () => {
  const chat = html.slice(html.indexOf('<div id="conversation"'));
  assert.match(chat, /<p>The rest of the page stays available without JavaScript\. This conversation is a development client and is not a Gate 1 claim\.<\/p>/);
  assert.doesNotMatch(html, /The sections above/);
});

test("the generated no-JS index is made of bulleted lists, never numbered ones", () => {
  const index = noscriptIndex();
  assert.doesNotMatch(index, /<ol[\s>]/, "a numbered list would read the dragons as a ranked to-do list");
  assert.equal((index.match(/<ul>/g) || []).length, graph.REGIONS.filter((region) => graph.ISLANDS.some((island) => island.region === region.id)).length);
  assert.doesNotMatch(decodeEntities(index), /next to explore|not reached yet/i, "no goal wording in the plain index");
});
