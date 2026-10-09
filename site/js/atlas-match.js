/**
 * Atlas matcher: decides which islands of the concept graph a reply mentions.
 *
 * Matching is deliberately conservative. A reply must use the same words the design uses:
 * - an ACRONYM term (AtS, IsHEC, HEIDs, FUP) is matched case-sensitively as a whole token;
 * - a PHRASE term ("the pot", "spend-ahead") is matched case-insensitively, with spaces and
 *   hyphens interchangeable;
 * - a single plain WORD term is only allowed when it is a distinctive ESP word listed in
 *   DISTINCT_WORDS. Common words (pot, base, debt, fund, plan, bill, freeze, commitment, audit)
 *   never light an island on their own: they only count inside a fixed phrase.
 * Nothing ever matches inside a longer word. Pure functions, no DOM, no storage, no network.
 *
 * Word boundaries are written without RegExp lookbehind (Safari before 16.4 throws on it): the
 * character before a term is consumed by a leading group, `(^|[^\p{L}\p{N}])`, and only the
 * character after it is looked at with a lookahead.
 */

import { ISLANDS } from "./atlas-graph.js";

/**
 * Lowercase single words that may be used as terms. This is exactly the set of plain
 * single-word terms the shipped graph uses; a test keeps it in step with atlas-graph.js.
 * Add a word here only if it is a genuinely distinctive ESP term, never a common word.
 */
export const DISTINCT_WORDS = new Set([
  "counterparty",
  "spotify",
  "faucet",
  "fungible",
  "prepays",
  "overdraft",
  "underfunding",
  "slashing",
  "slashed",
  "collateral",
  "hoarding",
  "bilateral",
  "immutable",
  "finality",
]);

/** @typedef {"acronym"|"phrase"|"word"|"rejected"} TermKind */

/** Start of text, or one character that is not a letter or digit. Consumed, so no lookbehind is needed. */
const BEFORE = "(?:^|[^\\p{L}\\p{N}])";
const AFTER = "(?![\\p{L}\\p{N}])";
const SEPARATOR = "[\\s\\-]+";

/**
 * Curly quotes to straight, typographic hyphens to "-", NBSP and newlines to a space,
 * whitespace collapsed and trimmed.
 * @param {unknown} text
 * @returns {string}
 */
export function normaliseReply(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/** @param {string} term already normalised */
function phraseTokens(term) {
  return term.split(/[\s-]+/).filter(Boolean);
}

/**
 * @param {unknown} term
 * @returns {TermKind}
 */
export function classifyTerm(term) {
  if (typeof term !== "string") return "rejected";
  const text = normaliseReply(term);
  if (!text) return "rejected";
  if (/[\s-]/.test(text)) {
    // A phrase needs at least two real words: "debt-" must not behave like the word "debt".
    return phraseTokens(text).length >= 2 ? "phrase" : "rejected";
  }
  // All caps (AtS-style mixed case is covered by the second test): FUP, ZK, HEEA.
  if (/^[\p{Lu}\p{N}]{2,}$/u.test(text) && /\p{Lu}/u.test(text)) return "acronym";
  // An uppercase letter after the first character: AtS, IsHEC, RtgP, ConRec, HEIDs.
  if (/\p{Lu}/u.test(Array.from(text).slice(1).join(""))) return "acronym";
  return DISTINCT_WORDS.has(text.toLowerCase()) ? "word" : "rejected";
}

/**
 * @param {string} term already normalised
 * @param {TermKind} kind
 * @returns {RegExp}
 */
function buildPattern(term, kind) {
  if (kind === "acronym") {
    return new RegExp(`${BEFORE}${escapeRegExp(term)}s?${AFTER}`, "u");
  }
  if (kind === "phrase") {
    const body = phraseTokens(term).map(escapeRegExp).join(SEPARATOR);
    return new RegExp(`${BEFORE}${body}s?${AFTER}`, "iu");
  }
  return new RegExp(`${BEFORE}${escapeRegExp(term)}${AFTER}`, "iu");
}

/**
 * @typedef {object} GlossaryTest
 * @property {string} term
 * @property {"acronym"|"phrase"|"word"} kind
 * @property {RegExp} re
 * @typedef {object} Glossary
 * @property {{id: string, tests: GlossaryTest[]}[]} entries
 * @property {{id: string, term: unknown}[]} rejected
 */

/**
 * Compile the terms of every island. Never throws: a term that cannot be classified or compiled
 * is reported in `rejected` and simply never matches.
 * @param {{id: string, terms?: unknown[]}[]} [islands]
 * @returns {Glossary}
 */
export function compileGlossary(islands = ISLANDS) {
  const entries = [];
  const rejected = [];
  for (const island of Array.isArray(islands) ? islands : []) {
    if (!island || typeof island.id !== "string") continue;
    const tests = [];
    const seen = new Set();
    for (const term of Array.isArray(island.terms) ? island.terms : []) {
      const kind = classifyTerm(term);
      if (kind === "rejected") {
        rejected.push({ id: island.id, term });
        continue;
      }
      const text = normaliseReply(term);
      const dedupeKey = `${kind}:${kind === "acronym" ? text : text.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      try {
        tests.push({ term: text, kind, re: buildPattern(text, kind) });
      } catch {
        // For example an engine without lookbehind support: never crash the page.
        rejected.push({ id: island.id, term });
      }
    }
    entries.push({ id: island.id, tests });
  }
  return { entries, rejected };
}

/**
 * Island ids whose terms occur in the reply, in graph order, without duplicates.
 * @param {unknown} text
 * @param {Glossary} glossary
 * @returns {string[]}
 */
export function matchReply(text, glossary) {
  const reply = normaliseReply(text);
  if (!reply || !glossary || !Array.isArray(glossary.entries)) return [];
  const ids = [];
  for (const entry of glossary.entries) {
    if (ids.includes(entry.id)) continue;
    if (entry.tests.some((test) => test.re.test(reply))) ids.push(entry.id);
  }
  return ids;
}

/**
 * How many compiled term tests the glossary holds. Zero means no reply can ever light an island
 * (for example an engine that cannot compile Unicode property classes).
 * @param {Glossary|null|undefined} glossary
 * @returns {number}
 */
export function glossarySize(glossary) {
  if (!glossary || !Array.isArray(glossary.entries)) return 0;
  return glossary.entries.reduce((total, entry) => total + (Array.isArray(entry.tests) ? entry.tests.length : 0), 0);
}

/** A short text that touches an acronym, a phrase, a word and a non-Latin code point. */
export const WARM_SAMPLE = "AtS the pot common fund 🧠 IsHEC with an overdraft and a financial counterparty";

/**
 * Run the matcher over a short sample so the engine compiles and tiers up the patterns before the
 * first real reply (the first runs cost a few hundred milliseconds, later ones a few). Twice,
 * because V8 optimises on the second execution. The result is thrown away; never throws.
 * @param {Glossary|null|undefined} glossary
 * @param {number} [rounds]
 */
export function warmGlossary(glossary, rounds = 2) {
  try {
    for (let i = 0; i < rounds; i += 1) matchReply(WARM_SAMPLE, glossary);
  } catch {
    // Warming is an optimisation only.
  }
}
