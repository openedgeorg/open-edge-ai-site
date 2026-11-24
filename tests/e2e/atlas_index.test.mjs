import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BEGIN_MARKER, END_MARKER, OPEN_FRAMING, applyIndex, indexLines, isInSync } from "../../scripts/atlas_index.mjs";
import * as graph from "../../site/js/atlas-graph.js";
import { formatSections, renderCount, suggestionItems } from "../../site/js/atlas-panel.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "atlas_index.mjs");
const HTML_PATH = join(ROOT, "site", "index.html");
const SITE = join(ROOT, "site");
const TRACE_FIXTURE = join(ROOT, "tests", "fixtures", "atlas-trace.json");
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
    const name = graph.ISLANDS.map((island) => island.name).find((candidate) => /^[A-Za-z ]+$/.test(candidate));
    const stale = html.replace(`<strong>${name}</strong>`, `<strong>${name}s</strong>`);
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
  assert.deepEqual(links, ["css/main.css", "css/atlas.css", "css/atlas-panel.css", "css/chat.css"]);
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

/**
 * The one phrase of the summary the page is allowed to print: the label of the contested item, in the
 * proposal's own words. An anchor that is part of it is not a leak.
 */
const PUBLIC_LABEL = "awaits incorporation into the authoritative design and message catalogue";

/** Every anchor of the unserved trace fixture (island traces and edge traces), and the ones a graph might still carry. */
function allAnchors() {
  const anchors = new Set();
  if (existsSync(TRACE_FIXTURE)) {
    const fixture = JSON.parse(readFileSync(TRACE_FIXTURE, "utf8"));
    for (const list of Object.values(fixture.islands || {})) for (const anchor of list) anchors.add(anchor);
    for (const anchor of Object.values(fixture.edges || {})) anchors.add(anchor);
  }
  for (const island of graph.ISLANDS) for (const entry of island.trace) if (entry.anchor) anchors.add(entry.anchor);
  for (const edge of graph.EDGES) if (edge.trace && edge.trace.anchor) anchors.add(edge.trace.anchor);
  return [...anchors].filter((anchor) => !PUBLIC_LABEL.includes(anchor));
}

test("no trace anchor text leaks into the page", () => {
  const page = decodeEntities(html);
  const anchors = allAnchors();
  assert.ok(anchors.length > 0, "there are anchors to look for (tests/fixtures/atlas-trace.json)");
  for (const anchor of anchors) {
    assert.ok(!page.includes(anchor), `anchor leaked: ${anchor}`);
  }
});

/** Every file under site/ that a browser can be sent: html, js, css, json, svg, text. */
function servedFiles(dir = SITE) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...servedFiles(full));
    else if (/\.(html|js|mjs|css|json|svg|txt)$/i.test(name)) files.push(full);
  }
  return files;
}

test("no verbatim anchor is served from site/ at all: they live in the unserved fixture", () => {
  const anchors = allAnchors();
  assert.ok(anchors.length > 0, "there are anchors to look for");
  const squash = (text) => text.replace(/\s+/g, " ");
  const leaks = [];
  for (const file of servedFiles()) {
    const text = squash(decodeEntities(readFileSync(file, "utf8")));
    for (const anchor of anchors) if (text.includes(squash(anchor))) leaks.push(`${file.slice(SITE.length + 1)}: ${anchor}`);
  }
  assert.deepEqual(leaks.slice(0, 5), [], `${leaks.length} anchors are served`);
});

test("formatSections gives unique sorted section marks and never anchor text", () => {
  assert.equal(formatSections({ trace: [{ section: 3, anchor: "x" }, { section: 1, anchor: "y" }, { section: 3, anchor: "z" }] }), "§1, §3");
  assert.equal(formatSections({ trace: [{ section: 3 }, { section: 1 }, { section: 3 }] }), "§1, §3", "the section is all an entry needs");
  assert.equal(formatSections({ trace: [{ section: "preamble" }, { section: 4 }] }), "§ status note, §4");
  assert.equal(formatSections({ trace: [{ section: 4 }, { section: "preamble" }] }), "§ status note, §4", "the status note sorts first");
  assert.equal(formatSections({ trace: [{ section: 10, anchor: "a" }, { section: 2, anchor: "b" }] }), "§2, §10");
  assert.equal(formatSections({ trace: { section: 6, anchor: "secret words" } }), "§6");
  assert.equal(formatSections({ trace: { section: 6 } }), "§6", "an edge has one entry, not a list");
  assert.equal(formatSections({ trace: [] }), "");
  assert.equal(formatSections(null), "");
  for (const island of graph.ISLANDS) {
    assert.match(formatSections(island), /^(§ status note|§\d+)(, §\d+)*$/);
    for (const entry of island.trace) if (entry.anchor) assert.ok(!formatSections(island).includes(entry.anchor));
  }
  for (const edge of graph.EDGES) assert.match(formatSections(edge), /^(§ status note|§\d+)$/, `${edge.a} <-> ${edge.b}`);
});

test("renderCount and suggestionItems follow the contract", () => {
  const el = { textContent: "" };
  renderCount(el, { visitedCount: 1, total: 60 });
  assert.equal(el.textContent, "1 of 60 visited");
  renderCount(el, { visitedCount: 7, total: graph.ISLANDS.length });
  assert.equal(el.textContent, `7 of ${graph.ISLANDS.length} visited`);
  assert.deepEqual(suggestionItems({ replies: 0, frontier: [] }), [graph.FIRST_SUGGESTION]);

  const dragons = graph.ISLANDS.filter((island) => island.status === "open");
  const ordinary = graph.ISLANDS.filter((island) => island.status !== "open" && island.id !== graph.START_ID);
  assert.ok(dragons.length >= 1 && ordinary.length >= 4);
  const mixed = suggestionItems({
    replies: 2,
    frontier: [dragons[0].id, ...ordinary.slice(0, 5).map((island) => island.id)],
  });
  assert.deepEqual(mixed, ordinary.slice(0, 3).map((island) => island.teaser), "three ordinary teasers in graph order, no dragon among them");
  const dragonsAlone = suggestionItems({ replies: 1, frontier: dragons.map((island) => island.id) });
  assert.deepEqual(dragonsAlone, dragons.slice(0, 3).map((island) => island.teaser), "dragons only when nothing else is left");
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

test("the hero gives the household premise in plain words with its caveats, and hides the question until the script runs (F08)", () => {
  const hero = html.slice(html.indexOf('<section class="hero">'), html.indexOf("</section>"));
  const text = (pattern) => (hero.match(pattern) || [])[1] || "";
  const headline = text(/<h1>([^<]*)<\/h1>/);
  const premise = text(/<p class="hero-tagline">([^<]*)<\/p>/);
  assert.match(headline, /internet bill/i, "the headline is about the household's bill");
  assert.doesNotMatch(headline, /\bESP\b/, "and needs no acronym");
  for (const pattern of [/internet provider/, /standing monthly plan/, /proposed design/, /draft/, /not a product/, /illustrative/]) {
    assert.match(premise, pattern, `the premise says ${pattern}`);
  }
  assert.doesNotMatch(premise, /guarantee|settled|will pay|saves? you|cheaper/i, "and promises nothing");
  assert.doesNotMatch(hero, /gate 1|development client|\blearned\b/i, "no release-gate wording and no claim of learning");
  assert.match(hero, /<div class="hero-ask-wrap" hidden>\s*<p class="hero-ask-label">Start with one question<\/p>\s*<button type="button" class="hero-ask"><span class="hero-ask-text"><\/span><\/button>/, "the question is built by the script and hidden without it");
  assert.match(hero, /That is only a starting marker \(<span class="hero-count"><\/span>\)/, "the counter is explained as a starting marker");
  assert.ok(hero.indexOf("hero-ask-wrap") < hero.indexOf("hero-cta-link"), "the question comes before the link");
  assert.ok(!html.includes('class="hero-ask-text">'.concat(graph.FIRST_SUGGESTION)), "the question text is the graph's, written by the script, not copied into the page");
});

test("no visitor-facing text outside the conversation card mentions Gate 1 or a development client (F08)", () => {
  const outside = html
    .replace(/<div id="conversation"[\s\S]*?<\/form>(\s*<details[\s\S]*?<\/details>)?\s*<\/div>/, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(outside, /gate 1|development client/i);
});

test("the legend says that the start place is lit as a starting marker (F08)", () => {
  assert.match(html, /<strong>visited<\/strong>: an answer mentioned this place \(Your internet bill starts lit as a starting marker\)/);
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
  for (const pattern of [/<p class="atlas-intro"[^>]*>/, /<ul class="atlas-legend"[^>]*>/, /<p id="atlas-notice"[^>]*>/, /<div class="atlas-toolbar"[^>]*>/, /<span class="hero-cta-note"[^>]*>/, /<a class="atlas-to-chat"[^>]*>/]) {
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
  assert.match(chat, /<p>The rest of the page stays available without JavaScript\.<\/p>/);
  // The release-gate wording is developer-facing: it sits in a collapsed details element, not in the visible intro.
  assert.match(chat, /<details class="atlas-dev-note">\s*<summary>Developer details<\/summary>\s*<p>This conversation is a development client and is not a Gate 1 claim\.<\/p>\s*<\/details>/);
  assert.doesNotMatch(html, /The sections above/);
});

test("the generated no-JS index is made of bulleted lists, never numbered ones", () => {
  const index = noscriptIndex();
  assert.doesNotMatch(index, /<ol[\s>]/, "a numbered list would read the dragons as a ranked to-do list");
  assert.equal((index.match(/<ul>/g) || []).length, graph.REGIONS.filter((region) => graph.ISLANDS.some((island) => island.region === region.id)).length);
  assert.doesNotMatch(decodeEntities(index), /next to explore|not reached yet/i, "no goal wording in the plain index");
});

// ---------------------------------------------------------------------------------------------
// the plain index says in place what the (hidden) legend says
// ---------------------------------------------------------------------------------------------

/** The generated index as plain text: tags dropped, entities decoded. */
const plainIndex = () => decodeEntities(noscriptIndex());

test("the generated index frames the open list under the heading of every region that holds open items", () => {
  assert.equal(OPEN_FRAMING, "Open, not ratified: the designers' own open list, not a roadmap.");
  const index = plainIndex();
  const holders = graph.REGIONS.filter((region) => graph.ISLANDS.some((island) => island.region === region.id && island.status === "open"));
  assert.ok(holders.length >= 1, "the graph has a region of open items");
  for (const region of graph.REGIONS) {
    const heading = `<h3>${region.name} · ${region.level} · ${region.subtitle}</h3>`;
    const at = index.indexOf(heading);
    if (!graph.ISLANDS.some((island) => island.region === region.id)) continue;
    assert.ok(at >= 0, `heading of ${region.id}`);
    const next = index.indexOf("</ul>", at);
    const section = index.slice(at, next);
    const framed = holders.includes(region);
    assert.equal(section.includes("<p>Open, not ratified: the designers' own open list, not a roadmap.</p>"), framed, `${region.id}: framing ${framed ? "present" : "absent"}`);
    if (framed) {
      assert.ok(index.indexOf("<p>", at) < index.indexOf("<ul>", at), "the sentence comes before the list, right under the heading");
      assert.equal(index.slice(at + heading.length).trimStart().startsWith("<p>Open, not ratified"), true, "directly under the heading");
    }
  }
});

test("the dragons' index never reads as a plan: it says open and not ratified, never next, goal or roadmap-as-promise", () => {
  const index = plainIndex();
  const open = index.slice(index.indexOf("Open, not ratified: the designers'"));
  assert.match(open, /not a roadmap/);
  assert.doesNotMatch(open.replace(OPEN_FRAMING, ""), /roadmap|next step|will be|planned/i);
  for (const island of graph.ISLANDS.filter((candidate) => candidate.status === "open")) {
    const line = index.slice(index.indexOf(`<strong>${island.name}</strong>`));
    assert.ok(line.slice(0, line.indexOf("</li>")).includes("<em>open, not ratified</em>"), `${island.name} carries its label`);
  }
});

test("the contested item shows its whole label in the plain index, not only the short one", () => {
  const index = plainIndex();
  const contested = graph.ISLANDS.filter((island) => island.status === "contested");
  assert.ok(contested.length >= 1);
  for (const island of contested) {
    const line = index.slice(index.indexOf(`<strong>${island.name}</strong>`));
    const item = line.slice(0, line.indexOf("</li>"));
    assert.ok(
      item.includes("<em>awaits incorporation into the authoritative design and message catalogue</em>"),
      `${island.name}: ${item}`,
    );
  }
  assert.equal(indexLines().filter((line) => line.includes("awaits incorporation")).length, contested.length, "only the contested items say it");
});

test("the page keeps the legend wording the plain index mirrors, and the way back to the conversation", () => {
  assert.match(html, /<strong>open, not ratified<\/strong>: the designers&rsquo; own open list, not a roadmap/);
  const toolbar = html.slice(html.indexOf('<div class="atlas-toolbar"'), html.indexOf('<div id="atlas-map"'));
  assert.match(toolbar, /<a class="atlas-to-chat" href="#conversation" hidden>Go to the conversation<\/a>/, "a way down to the conversation for the one-column layout");
  assert.ok(html.includes('id="conversation"'), "its target exists");
});
