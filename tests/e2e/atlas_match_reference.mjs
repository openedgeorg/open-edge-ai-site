/**
 * Reference matcher for the differential tests of site/js/atlas-match.js.
 *
 * This is the matcher as it was before round 2: one boundary regular expression per term, tested
 * against the whole reply. It is slow (hundreds of ms for the shipped glossary) but obviously
 * correct, which is exactly what a reference is for. It lives ONLY in tests/: the shipped matcher
 * tokenises the reply once and never builds a regex per term.
 *
 * The only differences from the old matcher are the F10 rules, the F35 gap rule and the F43 break
 * rule, which the shipped matcher also has: a phrase whose first character is uppercase (an acronym
 * expansion written out) is matched case-sensitively; a run of spaces, hyphens, asterisks,
 * underscores and backticks between two words of a phrase is one gap; the en dash and the minus sign
 * read as hyphens; and the single-word allowlist is a parameter (the reviewed list is pinned in the
 * test files, not read from the matcher).
 *
 * The possessive rule (an apostrophe and a lone "s" that end a word are not read: "ISP's debt" is "ISP debt")
 * is done here with one regular expression over the text, on the reply and on every term alike. The
 * shipped matcher does it while tokenising, by dropping the token "s" that follows a gap of exactly one
 * apostrophe; the two agree because both need the apostrophe to touch a letter or digit on its left and
 * the "s" to be a whole run (no letter or digit after it).
 *
 * The F43 rule is done here a different way from the shipped matcher on purpose, so that the
 * differential test compares two implementations. The reply is cut into SEGMENTS before anything
 * else, every term is tested against every segment on its own, and an island is lit when any segment
 * lights it. A segment ends at a blank line (a line with nothing but whitespace between two
 * newlines) and before a line that starts a Markdown list item ("- ", "* ", "+ ", "1. ", "1) ") or
 * a heading (a run of "#" and a space). A single newline anywhere else stays inside its segment,
 * where it is whitespace like any other. The shipped matcher marks the same places in the text with
 * one character instead.
 *
 * Not a test file (no .test.mjs suffix): node --test ignores it, other test files import it.
 */

import { spawnSync } from "node:child_process";

const BEFORE = "(?:^|[^\\p{L}\\p{N}])";
const AFTER = "(?![\\p{L}\\p{N}])";
const SEPARATOR = "[\\s\\-*_`]+";

export function referenceNormalise(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[\u2010\u2011\u2013\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Drop every possessive "'s": an apostrophe and a lone s or S, straight after a letter or digit and not
 * followed by one. Lookbehind is fine here (this file only runs under node); the shipped matcher has none.
 */
export const referencePossessive = (text) => text.replace(/(?<=[\p{L}\p{N}])'[sS](?![\p{L}\p{N}])/gu, "");

const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
const phraseTokens = (term) => term.split(/[\s\-*_`]+/).filter(Boolean);

/** @param {Set<string>|string[]} allowed lowercase single words that are valid terms */
export function referenceClassify(term, allowed) {
  const words = allowed instanceof Set ? allowed : new Set(allowed);
  if (typeof term !== "string") return "rejected";
  const text = referenceNormalise(term);
  if (!text) return "rejected";
  if (/[\s\-*_`]/.test(text)) return phraseTokens(text).length >= 2 ? "phrase" : "rejected";
  if (/^[\p{Lu}\p{N}]{2,}$/u.test(text) && /\p{Lu}/u.test(text)) return "acronym";
  if (/\p{Lu}/u.test(Array.from(text).slice(1).join(""))) return "acronym";
  return words.has(text.toLowerCase()) ? "word" : "rejected";
}

export function referenceCaseSensitive(text, kind) {
  if (kind === "acronym") return true;
  if (kind === "phrase") return /^\p{Lu}/u.test(text);
  return false;
}

function pattern(term, kind) {
  const exact = referenceCaseSensitive(term, kind);
  if (kind === "acronym") return new RegExp(`${BEFORE}${escapeRegExp(term)}s?${AFTER}`, "u");
  if (kind === "phrase") {
    const body = phraseTokens(term).map(escapeRegExp).join(SEPARATOR);
    return new RegExp(`${BEFORE}${body}s?${AFTER}`, exact ? "u" : "iu");
  }
  return new RegExp(`${BEFORE}${escapeRegExp(term)}${AFTER}`, "iu");
}

/** @returns {{entries: {id: string, res: RegExp[]}[], rejected: {id: string, term: unknown}[]}} */
export function referenceCompile(islands, allowed) {
  const entries = [];
  const rejected = [];
  for (const island of Array.isArray(islands) ? islands : []) {
    if (!island || typeof island.id !== "string") continue;
    const res = [];
    const seen = new Set();
    for (const term of Array.isArray(island.terms) ? island.terms : []) {
      const kind = referenceClassify(term, allowed);
      if (kind === "rejected") {
        rejected.push({ id: island.id, term });
        continue;
      }
      const text = referencePossessive(referenceNormalise(term));
      const exact = referenceCaseSensitive(text, kind);
      const key = `${kind}:${exact ? `exact:${text}` : `any:${text.toLowerCase()}`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      res.push(pattern(text, kind));
    }
    entries.push({ id: island.id, res });
  }
  return { entries, rejected };
}

/** A line that starts a Markdown list item or a heading (after any indentation). */
const STARTS_BLOCK = /^[^\S\n]*(?:[-*+]|\d{1,9}[.)]|#+)[ \t]/;

/**
 * The segments of a reply (F43), each still raw. Line by line: a whitespace-only line ends the
 * segment before it, and a line that starts a list item or a heading starts a new one.
 * @param {string} text
 * @returns {string[]}
 */
export function referenceSegments(text) {
  const segments = [];
  let current = [];
  const close = () => {
    segments.push(current.join("\n"));
    current = [];
  };
  text.split("\n").forEach((line, index) => {
    if (/^\s*$/.test(line)) {
      // A blank line is the break. (A blank first or last line separates nothing, which is harmless:
      // it only leaves an empty segment.)
      close();
    } else {
      if (index > 0 && STARTS_BLOCK.test(line)) close();
      current.push(line);
    }
  });
  close();
  return segments;
}

export function referenceMatch(text, reference) {
  if (typeof text !== "string") return [];
  const replies = referenceSegments(text)
    .map((segment) => referencePossessive(referenceNormalise(segment)))
    .filter((reply) => reply !== "");
  const ids = [];
  for (const entry of reference.entries) {
    if (ids.includes(entry.id)) continue;
    if (replies.some((reply) => entry.res.some((re) => re.test(reply)))) ids.push(entry.id);
  }
  return ids;
}

/** A small deterministic generator (mulberry32), so a failing case can be replayed from its seed. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Time the FIRST matchReply of a fresh node process (cold engine, nothing warmed): the number the
 * page actually pays for its first reply. The child compiles the glossary first and times only the
 * match. Returns milliseconds, or the best of `attempts` runs so that a busy host does not fail a
 * bound that the code meets (the bound itself is not relaxed).
 * @param {{id: string, terms: string[]}[]} islands
 * @param {string} reply
 * @param {number} [attempts]
 */
export function coldFirstMatchMs(islands, reply, attempts = 3) {
  const script = `
    import { readFileSync } from "node:fs";
    const { islands, reply, matcher } = JSON.parse(readFileSync(0, "utf8"));
    const { compileGlossary, matchReply } = await import(matcher);
    const glossary = compileGlossary(islands);
    const start = performance.now();
    const ids = matchReply(reply, glossary);
    process.stdout.write(JSON.stringify({ ms: performance.now() - start, ids }));
  `;
  const matcher = new URL("../../site/js/atlas-match.js", import.meta.url).href;
  let best = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const done = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      input: JSON.stringify({ islands, reply, matcher }),
      encoding: "utf8",
      timeout: 60000,
    });
    if (done.status !== 0) throw new Error(`cold benchmark child failed: ${done.stderr}`);
    const measured = JSON.parse(done.stdout);
    if (best === null || measured.ms < best.ms) best = measured;
    if (best.ms < 5) break;
  }
  return best;
}
