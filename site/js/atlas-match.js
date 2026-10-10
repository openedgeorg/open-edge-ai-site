/**
 * Atlas matcher: decides which islands of the concept graph a reply mentions.
 *
 * Matching is deliberately conservative. A reply must use the same words the design uses:
 * - an ACRONYM term (AtS, IsHEC, HEIDs, FUP) is matched case-sensitively as a whole token;
 * - a PHRASE term ("the pot", "spend-ahead") is matched case-insensitively, with spaces and
 *   hyphens interchangeable, EXCEPT a phrase whose first character is uppercase ("Allowance to
 *   Spend", "Consumption Record"): that is an acronym expansion written out, and it is matched
 *   case-sensitively, so a reply that merely says "allowance to spend" in passing lights nothing;
 * - a single plain WORD term is only allowed when it is listed in REVIEWED_WORDS, a short list
 *   somebody has read and decided is distinctive ESP vocabulary. Every other single word (pot,
 *   base, debt, fund, plan, bill, freeze, commitment, audit, collateral, immutable, finality,
 *   epoch ...) never lights an island on its own: it only counts inside a fixed phrase.
 * Nothing ever matches inside a longer word. Pure functions, no DOM, no storage, no network.
 *
 * How it runs. The reply is tokenised once into runs of letters and digits, with the (canonical)
 * text between two runs kept as the "gap". Acronyms and words are looked up in a Map by token;
 * phrases in a Map from their first token to the candidate token sequences that start with it.
 * So the cost of a reply is proportional to its length, not to the size of the glossary, and no
 * regular expression is compiled per term. A term that does not start and end with a letter or a
 * digit (for example "IsHEC(1)") cannot be expressed as tokens; it keeps a small boundary regex of
 * its own. The shipped graph has no such term (a test pins that).
 *
 * Word boundaries never need RegExp lookbehind (Safari before 16.4 throws on it).
 */

import { ISLANDS } from "./atlas-graph.js";

/**
 * The reviewed allowlist of single plain words that may be used as terms. Add a word here only
 * after reading it: it must be a genuinely distinctive ESP word that a faithful answer about the
 * island uses and that almost no other answer about ESP does. Never a common word.
 */
export const REVIEWED_WORDS = new Set([
  "counterparty",
  "faucet",
  "fungible",
  "hoarding",
  "overdraft",
  "spotify",
  "prepays",
  "slashing",
  "slashed",
]);

/** The old name of REVIEWED_WORDS; the same Set. */
export const DISTINCT_WORDS = REVIEWED_WORDS;

/** @typedef {"acronym"|"phrase"|"word"|"rejected"} TermKind */

/** Start of text, or one character that is not a letter or digit. Only used by the regex fallback. */
const BEFORE = "(?:^|[^\\p{L}\\p{N}])";
const AFTER = "(?![\\p{L}\\p{N}])";
const SEPARATOR = "[\\s\\-]+";
/** A run of letters and digits: the unit of tokenisation. */
const TOKEN_SOURCE = "[\\p{L}\\p{N}]+";

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
  return REVIEWED_WORDS.has(text.toLowerCase()) ? "word" : "rejected";
}

/**
 * Acronyms are always case-sensitive. A phrase is case-insensitive unless its first character is
 * uppercase (an acronym expansion written out). A word is case-insensitive.
 * @param {string} text normalised
 * @param {Exclude<TermKind, "rejected">} kind
 */
function isCaseSensitive(text, kind) {
  if (kind === "acronym") return true;
  if (kind === "phrase") return /^\p{Lu}/u.test(text);
  return false;
}

/**
 * Separator runs (spaces and hyphens) between two tokens all count the same.
 * @param {string} gap
 */
function canonicalGap(gap) {
  return gap === " " ? gap : gap.replace(/[ -]+/g, " ");
}

/**
 * Split a normalised text into its runs of letters and digits and the canonical gaps between them.
 * @param {string} text
 * @param {RegExp} tokenRe global
 * @returns {{runs: string[], gaps: string[]}}
 */
function splitRuns(text, tokenRe) {
  const runs = [];
  const gaps = [];
  let last = 0;
  for (const found of text.matchAll(tokenRe)) {
    if (runs.length > 0) gaps.push(canonicalGap(text.slice(last, found.index)));
    runs.push(found[0]);
    last = found.index + found[0].length;
  }
  return { runs, gaps };
}

/**
 * The token form of a term, or null when the term cannot be matched that way (it does not start
 * and end with a letter or a digit).
 * @param {string} text normalised
 * @param {Exclude<TermKind, "rejected">} kind
 * @param {boolean} caseSensitive
 * @param {RegExp|null} tokenRe
 * @returns {Candidate|null}
 */
function buildCandidate(text, kind, caseSensitive, tokenRe) {
  if (!tokenRe || !/^[\p{L}\p{N}]/u.test(text) || !/[\p{L}\p{N}]$/u.test(text)) return null;
  const { runs, gaps } = splitRuns(text, tokenRe);
  if (runs.length === 0) return null;
  return {
    entry: -1,
    runs: caseSensitive ? runs : runs.map((run) => run.toLowerCase()),
    gaps,
    fold: !caseSensitive,
    plural: kind !== "word",
  };
}

/**
 * The regex form of a term, for the rare term that has no token form.
 * @param {string} term already normalised
 * @param {Exclude<TermKind, "rejected">} kind
 * @param {boolean} caseSensitive
 * @returns {RegExp}
 */
function buildPattern(term, kind, caseSensitive) {
  const flags = caseSensitive ? "u" : "iu";
  if (kind === "acronym") {
    return new RegExp(`${BEFORE}${escapeRegExp(term)}s?${AFTER}`, flags);
  }
  if (kind === "phrase") {
    const body = phraseTokens(term).map(escapeRegExp).join(SEPARATOR);
    return new RegExp(`${BEFORE}${body}s?${AFTER}`, flags);
  }
  return new RegExp(`${BEFORE}${escapeRegExp(term)}${AFTER}`, flags);
}

/**
 * @typedef {object} Candidate
 * @property {number} entry index into Glossary.entries
 * @property {string[]} runs the term's letter/digit runs (lowercased when `fold`)
 * @property {string[]} gaps canonical text between two runs (runs.length - 1 of them)
 * @property {boolean} fold compare case-insensitively
 * @property {boolean} plural the last run may carry one extra "s"
 *
 * @typedef {object} GlossaryTest
 * @property {string} term
 * @property {"acronym"|"phrase"|"word"} kind
 * @property {boolean} caseSensitive
 * @property {"tokens"|"pattern"} via "tokens" for every ordinary term; "pattern" for a term that needs its own regex
 * @property {RegExp} [re] only when `via` is "pattern"
 *
 * @typedef {object} Glossary
 * @property {{id: string, tests: GlossaryTest[]}[]} entries
 * @property {{id: string, term: unknown}[]} rejected
 */

/**
 * @typedef {object} Lookup
 * @property {RegExp|null} tokenRe
 * @property {Map<string, Candidate[]>} sensitive candidates by exact first run
 * @property {Map<string, Candidate[]>} folded candidates by lowercased first run
 * @property {{entry: number, re: RegExp}[]} patterns
 */

/** @type {WeakMap<object, Lookup>} */
const LOOKUPS = new WeakMap();

/**
 * Compile the terms of every island. Never throws: a term that cannot be classified or compiled
 * is reported in `rejected` and simply never matches.
 * @param {{id: string, terms?: unknown[]}[]} [islands]
 * @returns {Glossary}
 */
export function compileGlossary(islands = ISLANDS) {
  const entries = [];
  const rejected = [];
  /** @type {RegExp|null} */
  let tokenRe = null;
  try {
    tokenRe = new RegExp(TOKEN_SOURCE, "gu");
  } catch {
    // An engine without Unicode property classes: no term can be matched, and every one is reported.
  }
  /** @type {Lookup} */
  const lookup = { tokenRe, sensitive: new Map(), folded: new Map(), patterns: [] };
  for (const island of Array.isArray(islands) ? islands : []) {
    if (!island || typeof island.id !== "string") continue;
    const tests = [];
    const seen = new Set();
    const entryIndex = entries.length;
    for (const term of Array.isArray(island.terms) ? island.terms : []) {
      const kind = classifyTerm(term);
      if (kind === "rejected") {
        rejected.push({ id: island.id, term });
        continue;
      }
      const text = normaliseReply(term);
      const caseSensitive = isCaseSensitive(text, kind);
      const dedupeKey = `${kind}:${caseSensitive ? `exact:${text}` : `any:${text.toLowerCase()}`}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      try {
        const candidate = buildCandidate(text, kind, caseSensitive, tokenRe);
        if (candidate) {
          candidate.entry = entryIndex;
          const bucket = candidate.fold ? lookup.folded : lookup.sensitive;
          const list = bucket.get(candidate.runs[0]);
          if (list) list.push(candidate);
          else bucket.set(candidate.runs[0], [candidate]);
          tests.push({ term: text, kind, caseSensitive, via: "tokens" });
        } else {
          const re = buildPattern(text, kind, caseSensitive);
          lookup.patterns.push({ entry: entryIndex, re });
          tests.push({ term: text, kind, caseSensitive, via: "pattern", re });
        }
      } catch {
        // For example an engine without Unicode property support: never crash the page.
        rejected.push({ id: island.id, term });
      }
    }
    entries.push({ id: island.id, tests });
  }
  const glossary = { entries, rejected };
  LOOKUPS.set(glossary, lookup);
  return glossary;
}

/**
 * Does the candidate occur starting at reply token `at`?
 * @param {Candidate} candidate
 * @param {number} at
 * @param {string[]} tokens
 * @param {string[]} lowered
 * @param {string[]} gaps gaps[k] is the canonical text between tokens[k] and tokens[k + 1]
 */
function occursAt(candidate, at, tokens, lowered, gaps) {
  const { runs } = candidate;
  const last = runs.length - 1;
  if (at + last >= tokens.length) return false;
  const have = candidate.fold ? lowered : tokens;
  for (let j = 0; j <= last; j += 1) {
    if (j > 0 && gaps[at + j - 1] !== candidate.gaps[j - 1]) return false;
    const found = have[at + j];
    if (found === runs[j]) continue;
    // Only the final run may carry a plural "s", and only for acronyms and phrases.
    if (j === last && candidate.plural && found === `${runs[j]}s`) continue;
    return false;
  }
  return true;
}

/**
 * Island ids whose terms occur in the reply, in graph order, without duplicates. `glossary` must be
 * the object compileGlossary returned (its lookup tables are kept beside it, not inside it, so a
 * copy of the object or a hand-made one matches nothing).
 * @param {unknown} text
 * @param {Glossary} glossary
 * @returns {string[]}
 */
export function matchReply(text, glossary) {
  const reply = normaliseReply(text);
  if (!reply || !glossary || !Array.isArray(glossary.entries)) return [];
  const lookup = LOOKUPS.get(glossary);
  if (!lookup || !lookup.tokenRe) return [];
  const hit = new Uint8Array(glossary.entries.length);

  const tokens = [];
  const gaps = [];
  let previousEnd = 0;
  for (const found of reply.matchAll(lookup.tokenRe)) {
    if (tokens.length > 0) gaps.push(canonicalGap(reply.slice(previousEnd, found.index)));
    tokens.push(found[0]);
    previousEnd = found.index + found[0].length;
  }
  const lowered = tokens.map((token) => token.toLowerCase());

  const probe = (list, at) => {
    if (!list) return;
    for (const candidate of list) {
      if (hit[candidate.entry] === 0 && occursAt(candidate, at, tokens, lowered, gaps)) hit[candidate.entry] = 1;
    }
  };
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    const low = lowered[at];
    probe(lookup.sensitive.get(token), at);
    probe(lookup.folded.get(low), at);
    // A plural "s": the token "HEIDs" can be the term "HEID" (its only one-token form).
    if (token.length > 1 && token.endsWith("s")) {
      probe(lookup.sensitive.get(token.slice(0, -1)), at);
    }
    if (low.length > 1 && low.endsWith("s")) {
      probe(lookup.folded.get(low.slice(0, -1)), at);
    }
  }
  for (const { entry, re } of lookup.patterns) {
    if (hit[entry] === 0 && re.test(reply)) hit[entry] = 1;
  }

  const ids = [];
  glossary.entries.forEach((entry, index) => {
    if (hit[index] === 1 && !ids.includes(entry.id)) ids.push(entry.id);
  });
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
 * Run the matcher once or twice over a short sample. The tokenising matcher has nothing to compile
 * per term, so this is cheap (microseconds); it is kept so the page can still touch the engine
 * (regex tokeniser, Map lookups) before the first real reply. The result is thrown away; never throws.
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
