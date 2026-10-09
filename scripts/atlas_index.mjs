#!/usr/bin/env node
/**
 * Generates the no-JavaScript Atlas index inside site/index.html.
 *
 *   node scripts/atlas_index.mjs --write   rewrite the region between the markers
 *   node scripts/atlas_index.mjs --check   exit 1 when index.html is out of sync
 *
 * The region sits inside the <noscript> of the Atlas, between
 *   <!-- atlas-index:begin -->  and  <!-- atlas-index:end -->
 * and is built from site/js/atlas-graph.js: per region an <h3>, then an <ol> with one <li> per
 * island (name, section references, label, note, teaser). Trace anchors are never written.
 * An alternative page can be named with --html <path> (used by tests).
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as graph from "../site/js/atlas-graph.js";
import { formatSections, regionHeading } from "../site/js/atlas-panel.js";

export const BEGIN_MARKER = "<!-- atlas-index:begin -->";
export const END_MARKER = "<!-- atlas-index:end -->";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_HTML = resolve(ROOT, "site", "index.html");

/** @param {string} text */
export function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The lines of the generated region (no indentation, no markers).
 * @param {{REGIONS: object[], ISLANDS: object[]}} source
 * @returns {string[]}
 */
export function indexLines(source = graph) {
  const lines = [];
  for (const region of source.REGIONS) {
    const islands = source.ISLANDS.filter((island) => island.region === region.id);
    if (!islands.length) continue;
    lines.push(`<h3>${escapeHtml(regionHeading(region))}</h3>`);
    lines.push("<ol>");
    for (const island of islands) {
      const parts = [`<strong>${escapeHtml(island.name)}</strong>`];
      const sections = formatSections(island);
      if (sections) parts.push(escapeHtml(sections));
      if (island.label) parts.push(`<em>${escapeHtml(island.label)}</em>`);
      if (island.note) parts.push(escapeHtml(island.note));
      if (island.teaser) parts.push(escapeHtml(island.teaser));
      lines.push(`    <li>${parts.join(" · ")}</li>`);
    }
    lines.push("</ol>");
  }
  return lines;
}

/**
 * Replace the marked region of `html` with the index built from `source`.
 * @param {string} html
 * @param {{REGIONS: object[], ISLANDS: object[]}} [source]
 * @returns {string}
 * @throws {Error} when the markers are missing, repeated, out of order or outside a <noscript>
 */
export function applyIndex(html, source = graph) {
  const begin = html.indexOf(BEGIN_MARKER);
  const end = html.indexOf(END_MARKER);
  if (begin === -1 || end === -1) throw new Error(`index.html needs ${BEGIN_MARKER} and ${END_MARKER}`);
  if (html.indexOf(BEGIN_MARKER, begin + 1) !== -1 || html.indexOf(END_MARKER, end + 1) !== -1) {
    throw new Error("atlas-index markers must each appear exactly once");
  }
  if (end < begin) throw new Error("atlas-index:end comes before atlas-index:begin");
  if (html.lastIndexOf("<noscript", begin) <= html.lastIndexOf("</noscript>", begin) || html.indexOf("</noscript>", end) === -1) {
    throw new Error("the atlas-index region must sit inside a <noscript>");
  }
  const lineStart = html.lastIndexOf("\n", begin) + 1;
  const indent = html.slice(lineStart, begin);
  if (indent.trim() !== "") throw new Error("atlas-index:begin must start its own line");
  const body = indexLines(source).map((line) => `${indent}${line}`);
  const region = [`${indent}${BEGIN_MARKER}`, ...body, `${indent}${END_MARKER}`].join("\n");
  return html.slice(0, lineStart) + region + html.slice(end + END_MARKER.length);
}

/**
 * @param {string} html
 * @param {{REGIONS: object[], ISLANDS: object[]}} [source]
 * @returns {boolean} true when the page already holds the generated index
 */
export function isInSync(html, source = graph) {
  return applyIndex(html, source) === html;
}

/**
 * @param {string[]} argv arguments after the script name
 * @param {{log?: (line: string) => void, error?: (line: string) => void}} [io]
 * @returns {number} the process exit code
 */
export function main(argv, { log = console.log, error = console.error } = {}) {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  const htmlFlag = argv.indexOf("--html");
  const htmlPath = htmlFlag === -1 ? DEFAULT_HTML : resolve(argv[htmlFlag + 1] || "");
  if (write === check || (htmlFlag !== -1 && !argv[htmlFlag + 1])) {
    error("usage: node scripts/atlas_index.mjs (--write | --check) [--html <path>]");
    return 2;
  }
  let html;
  let next;
  try {
    html = readFileSync(htmlPath, "utf8");
    next = applyIndex(html);
  } catch (problem) {
    error(`atlas_index: ${problem.message}`);
    return 2;
  }
  if (check) {
    if (next === html) {
      log("atlas index is in sync");
      return 0;
    }
    error("atlas index is out of sync with site/js/atlas-graph.js; run: node scripts/atlas_index.mjs --write");
    return 1;
  }
  if (next === html) {
    log("atlas index already up to date");
    return 0;
  }
  writeFileSync(htmlPath, next);
  log("atlas index written");
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === entry) process.exitCode = main(process.argv.slice(2));
