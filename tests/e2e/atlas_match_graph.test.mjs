/**
 * Matcher assertions that depend on what the SHIPPED graph says: its terms, its islands, the hook
 * example. The generic rules (case sensitivity, plural s, boundaries, the reviewed word list itself,
 * speed on a synthetic glossary, the differential test on synthetic islands) are in
 * atlas_match.test.mjs.
 *
 * Wherever possible the islands are read from the graph at runtime instead of being named here, so
 * a re-grounded graph does not need this file re-pinned. The few ids that ARE named are the ones the
 * hook example of the proposal is built on (isp-counterparty, standing-plan, common-fund,
 * isp-commitment, base-and-topups, the-pot, overdraft); if the graph renames a concept those tests
 * say so by name.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { ISLANDS, START_ID } from "../../site/js/atlas-graph.js";
import {
  REVIEWED_WORDS,
  classifyTerm,
  compileGlossary,
  glossarySize,
  matchReply,
  normaliseReply,
} from "../../site/js/atlas-match.js";
import { deriveView, initialAtlasState, reduceAtlas } from "../../site/js/atlas-state.js";
import { coldFirstMatchMs, referenceCompile, referenceMatch, seededRandom } from "./atlas_match_reference.mjs";

const glossary = compileGlossary(ISLANDS);
const GRAPH_ORDER = ISLANDS.map((island) => island.id);
const inGraphOrder = (ids) => [...ids].sort((a, b) => GRAPH_ORDER.indexOf(a) - GRAPH_ORDER.indexOf(b));
const match = (text) => matchReply(text, glossary);
const byId = new Map(ISLANDS.map((island) => [island.id, island]));

const FIXTURE = new URL("../fixtures/atlas-trace.json", import.meta.url);

/**
 * The anchors of an island, from the unserved fixture when it exists (round 2 moved them out of
 * site/), else from the trace entries of the graph itself (the round-1 format).
 */
function anchorsOf(island) {
  if (existsSync(FIXTURE)) {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
    return (fixture.islands?.[island.id] ?? []).filter((anchor) => typeof anchor === "string");
  }
  return (island.trace ?? []).map((entry) => entry.anchor).filter((anchor) => typeof anchor === "string");
}

const isAcronymTerm = (term) => /^[\p{Lu}\p{N}]{2,}$/u.test(term) || /\p{Lu}/u.test(Array.from(term).slice(1).join(""));
const isSingleToken = (term) => !/[\s-]/.test(term);

// ---------------------------------------------------------------- the glossary of the shipped graph

test("the shipped graph compiles with no rejected term, every island has a usable term", () => {
  assert.deepEqual(glossary.rejected, []);
  assert.deepEqual(glossary.entries.map((entry) => entry.id), GRAPH_ORDER);
  for (const entry of glossary.entries) {
    assert.ok(entry.tests.length > 0, `${entry.id} has at least one usable term`);
  }
  const terms = glossarySize(glossary);
  assert.ok(terms >= ISLANDS.length * 3, `${terms} usable terms for ${ISLANDS.length} islands is too few to recognise a reply`);
});

test("every term of the shipped graph is matched from tokens: no per-term regex is built", () => {
  const withRegex = [];
  for (const entry of glossary.entries) {
    for (const t of entry.tests) {
      assert.ok(["acronym", "phrase", "word"].includes(t.kind));
      if (t.via !== "tokens") withRegex.push(`${entry.id}: ${t.term}`);
    }
  }
  assert.deepEqual(withRegex, [], "a term that starts or ends with punctuation needs a regex of its own: rewrite it");
});

test("every single-word term of the shipped graph is on the reviewed list", () => {
  const offenders = [];
  for (const island of ISLANDS) {
    for (const term of island.terms) {
      if (!isSingleToken(term) || isAcronymTerm(term)) continue;
      if (!REVIEWED_WORDS.has(term.toLowerCase())) offenders.push(`${island.id}: ${term}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a single plain word that is not on the reviewed list can never light an island: use it inside a fixed phrase",
  );
  // The matcher agrees: the words it accepts are exactly these.
  for (const island of ISLANDS) {
    for (const term of island.terms) {
      if (isSingleToken(term) && !isAcronymTerm(term)) assert.equal(classifyTerm(term), "word", `${island.id}: ${term}`);
    }
  }
});

test("the generic phrases the round-1 reviewers flagged are not terms", () => {
  const flagged = new Set(["your bill", "one allowance", "user experience", "parent isp"]);
  const offenders = [];
  for (const island of ISLANDS) {
    for (const term of island.terms) {
      if (flagged.has(normaliseReply(term).toLowerCase())) offenders.push(`${island.id}: ${term}`);
    }
  }
  assert.deepEqual(offenders, []);
  for (const text of flagged) assert.deepEqual(match(`We talked about ${text}.`), [], text);
});

test("no two islands share a term", () => {
  const owner = new Map();
  const shared = [];
  for (const island of ISLANDS) {
    for (const term of island.terms) {
      const text = normaliseReply(term);
      const kind = classifyTerm(term);
      const sensitive = kind === "acronym" || (kind === "phrase" && /^\p{Lu}/u.test(text));
      const key = sensitive ? `exact:${text}` : `any:${text.toLowerCase()}`;
      if (owner.has(key) && owner.get(key) !== island.id) shared.push(`${text}: ${owner.get(key)} and ${island.id}`);
      owner.set(key, island.id);
    }
  }
  assert.deepEqual(shared, []);
});

test("a term of the shipped graph lights its island when it stands in a sentence, and few others", () => {
  for (const island of ISLANDS) {
    for (const term of island.terms) {
      assert.notEqual(classifyTerm(term), "rejected", `${island.id}: ${term}`);
      const lit = match(`We discussed ${term} in the answer.`);
      assert.ok(lit.includes(island.id), `${island.id}: "${term}" lights ${JSON.stringify(lit)}`);
      assert.ok(lit.length <= 3, `"${term}" lights ${lit.length} islands: it is too generic (${lit.join(", ")})`);
    }
  }
});

test("case rules hold for every term of the shipped graph", () => {
  for (const island of ISLANDS) {
    for (const term of island.terms) {
      const kind = classifyTerm(term);
      const text = normaliseReply(term);
      const only = compileGlossary([{ id: island.id, terms: [term] }]);
      const exact = kind === "acronym" || (kind === "phrase" && /^\p{Lu}/u.test(text));
      assert.deepEqual(matchReply(`a ${text} b`, only), [island.id], `${island.id}: ${term}`);
      if (exact) {
        for (const wrong of [text.toLowerCase(), text.toUpperCase()]) {
          if (wrong === text) continue;
          assert.deepEqual(matchReply(`a ${wrong} b`, only), [], `${island.id}: "${term}" must not match "${wrong}"`);
        }
      } else {
        for (const other of [text.toUpperCase(), text.toLowerCase()]) {
          assert.deepEqual(matchReply(`a ${other} b`, only), [island.id], `${island.id}: "${term}" matches "${other}"`);
        }
      }
    }
  }
});

test("bare common words never light an island of the shipped graph", () => {
  const common = [
    "pot", "base", "debt", "fund", "plan", "bill", "freeze", "commitment", "audit", "price", "allowance", "app", "apps",
    "money", "month", "claim", "round", "key", "tag", "fee", "collateral", "immutable", "finality", "bilateral",
    "underfunding", "epoch", "epochs", "timetable", "diary", "clawback", "expulsion", "settlement", "escrow", "optimistic",
  ];
  for (const word of common) {
    for (const text of [
      word,
      word.toUpperCase(),
      `${word[0].toUpperCase()}${word.slice(1)}.`,
      `A ${word}, then another ${word}!`,
      `There is a ${word} here and ${word}s there.`,
    ]) {
      assert.deepEqual(match(text), [], JSON.stringify(text));
    }
  }
  assert.deepEqual(match("The debt grows. The bill is large. The plan is old. The audit ends. Fund the base."), []);
  assert.deepEqual(
    match("A pot of tea, a base camp, a debt of gratitude, a fund raiser, a plan B, an audit trail, a freeze frame, a commitment to quality."),
    [],
  );
});

test("the allowance-to-spend sentence of the round-1 review does not light the AtS island", () => {
  const atsIslands = ISLANDS.filter((island) => island.terms.includes("AtS")).map((island) => island.id);
  assert.ok(atsIslands.length >= 1, "an island carries the acronym AtS");
  const ids = match("Each month your household gets an allowance to spend across apps, and the apps spend against it.");
  for (const id of atsIslands) assert.equal(ids.includes(id), false, `${id} lit by ordinary words`);
  // The expansion written out in full (the capitalised form the design uses) still lights it.
  for (const island of ISLANDS) {
    if (island.terms.includes("Allowance to Spend")) {
      assert.ok(match("The Allowance to Spend is public.").includes(island.id), island.id);
    }
  }
});

// ---------------------------------------------------------------- recall

test("every island lights from its own name or from one of its own anchors", () => {
  const unlit = [];
  const byAnchorOnly = [];
  for (const island of ISLANDS) {
    const fromName = match(island.name).includes(island.id);
    const fromAnchor = anchorsOf(island).some((anchor) => match(anchor).includes(island.id));
    if (!fromName && !fromAnchor) unlit.push(`${island.id} (${island.name})`);
    else if (!fromName) byAnchorOnly.push(island.id);
  }
  assert.deepEqual(unlit, [], "islands that neither their name nor any anchor lights: fix their terms");
  // Most islands should light from the name the map shows; a few are named differently from the
  // summary's own wording and are lit by that wording instead.
  assert.ok(
    byAnchorOnly.length <= Math.ceil(ISLANDS.length * 0.2),
    `${byAnchorOnly.length} islands rely on an anchor because their name does not light them: ${byAnchorOnly.join(", ")}`,
  );
});

test("an island's own name lights at most three islands", () => {
  for (const island of ISLANDS) {
    const lit = match(island.name);
    assert.ok(lit.length <= 3, `"${island.name}" lights ${lit.join(", ")}`);
  }
});

test("replies built from the graph's own names and anchors light only islands that exist, in graph order", () => {
  for (const island of ISLANDS) {
    for (const text of [island.name, island.teaser, ...anchorsOf(island)]) {
      const ids = match(text);
      assert.deepEqual(ids, inGraphOrder(ids));
      assert.equal(new Set(ids).size, ids.length);
      for (const id of ids) assert.ok(byId.has(id), id);
    }
  }
});

// ---------------------------------------------------------------- the hook example

test("the hook example: a faithful first answer lights five islands and puts the pot and the overdraft on the frontier", () => {
  for (const id of ["isp-counterparty", "standing-plan", "common-fund", "isp-commitment", "base-and-topups", "the-pot", "overdraft"]) {
    assert.ok(byId.has(id), `the hook example needs the island ${id}; if it was renamed, update this test and the proposal's example`);
  }
  const reply = "Your ISP, as your financial counterparty. You pay it under one standing plan, and apps earn through the protocol. Its monthly commitment for your household enters a common fund and funds your guaranteed base allowance.";
  const ids = match(reply);
  assert.deepEqual(
    ids,
    inGraphOrder(["isp-counterparty", "standing-plan", "common-fund", "isp-commitment", "base-and-topups"]),
  );
  const state = reduceAtlas(initialAtlasState(), { type: "reply", ids });
  assert.equal(state.replies, 1);
  const view = deriveView(state);
  assert.equal(view.visitedCount, 1 + ids.filter((id) => id !== START_ID).length);
  assert.equal(view.status["the-pot"], "frontier");
  assert.equal(view.status.overdraft, "frontier");
  assert.equal(view.dragonsReached, false);
  const next = reduceAtlas(state, { type: "reply", ids: match("The pot is spending authority, not money.") });
  assert.deepEqual(next.visited.slice(-1), ["the-pot"]);
  assert.equal(deriveView(next).status["the-pot"], "visited");
});

// ---------------------------------------------------------------- differential test on the shipped graph

test("differential: the tokenising matcher equals the regex reference on replies built from the shipped graph", () => {
  const reference = referenceCompile(ISLANDS, new Set(REVIEWED_WORDS));
  assert.deepEqual(glossary.rejected, reference.rejected);
  const rnd = seededRandom(20261010);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const pieces = [];
  for (const island of ISLANDS) {
    pieces.push(island.name, island.teaser, ...anchorsOf(island), ...island.terms.map((term) => `We discussed ${term} in the answer.`));
  }
  const perturb = (text) => {
    const r = rnd();
    if (r < 0.12) return text.toUpperCase();
    if (r < 0.24) return text.toLowerCase();
    if (r < 0.34) return text.replace(/\s+/g, "  ");
    if (r < 0.44) return text.replace(/ /g, "-");
    if (r < 0.52) return text.replace(/\b(\w+)\b/g, "$1s");
    if (r < 0.6) return text.replace(/'/g, "’");
    return text;
  };
  const replies = [...pieces];
  for (let i = 0; i < 700; i += 1) {
    const parts = [];
    for (let n = 1 + Math.floor(rnd() * 5); n > 0; n -= 1) parts.push(perturb(pick(pieces)));
    replies.push(parts.join(pick([" ", ". ", ", ", "\n", " and "])));
  }
  replies.push(pieces.join(" "));
  let lit = 0;
  for (const reply of replies) {
    const got = match(reply);
    assert.deepEqual(got, referenceMatch(reply, reference), JSON.stringify(reply));
    if (got.length > 0) lit += 1;
  }
  assert.ok(lit > replies.length * 0.5, `${lit} of ${replies.length} generated replies light something`);
});

// ---------------------------------------------------------------- speed on the shipped glossary

function replyOfSize(size) {
  const sentences = [];
  for (const island of ISLANDS) sentences.push(`${island.name} is discussed; ${island.terms.join(" and ")}, the household and the ISP.`);
  let text = "";
  for (let i = 0; text.length < size; i += 1) text += `${sentences[i % sentences.length]} `;
  return text.slice(0, size);
}

test("performance: the first reply on the shipped glossary is fast even cold (5 KB < 20 ms, 50 KB < 100 ms)", () => {
  const islands = ISLANDS.map(({ id, terms }) => ({ id, terms }));
  const small = coldFirstMatchMs(islands, replyOfSize(5 * 1024));
  assert.ok(small.ids.length > 0);
  assert.ok(small.ms < 20, `first matchReply on 5 KB took ${small.ms.toFixed(2)} ms`);
  const large = coldFirstMatchMs(islands, replyOfSize(50 * 1024));
  assert.ok(large.ids.length > 0);
  assert.ok(large.ms < 100, `first matchReply on 50 KB took ${large.ms.toFixed(2)} ms`);
});

test("compiling the shipped glossary is cheap", () => {
  const start = performance.now();
  compileGlossary(ISLANDS);
  const ms = performance.now() - start;
  assert.ok(ms < 100, `compileGlossary took ${ms.toFixed(1)} ms`);
});
