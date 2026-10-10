/**
 * Generic rules of the Atlas matcher, tested on small hand-made island lists.
 *
 * Nothing in this file depends on what the shipped graph says: every assertion that does (the hook
 * example, per-island recall, "the graph compiles with no rejected term") is in
 * atlas_match_graph.test.mjs. Here the rules are pinned with synthetic islands, and a differential
 * test proves the tokenising matcher equals a plain regex reference (tests/e2e/atlas_match_reference.mjs).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  DISTINCT_WORDS,
  REVIEWED_WORDS,
  WARM_SAMPLE,
  classifyTerm,
  compileGlossary,
  glossarySize,
  matchReply,
  normaliseReply,
  warmGlossary,
} from "../../site/js/atlas-match.js";
import {
  coldFirstMatchMs,
  referenceClassify,
  referenceCompile,
  referenceMatch,
  seededRandom,
} from "./atlas_match_reference.mjs";

/**
 * The reviewed allowlist of single words, pinned HERE (not read back from the matcher or from the
 * graph). Changing the list means changing this constant in a reviewed commit. "slashing" and
 * "slashed" left the list in round 3 (F34): no island uses them as a single-word term.
 */
const REVIEWED = [
  "counterparty",
  "faucet",
  "fungible",
  "hoarding",
  "overdraft",
  "prepays",
  "spotify",
];

/** A small hand-made graph that exercises every rule. The ids say what the island is about. */
const SAMPLE = [
  { id: "ats", terms: ["AtS", "Allowance to Spend"] },
  { id: "heid", terms: ["HEID", "epoch ID"] },
  { id: "hsat", terms: ["HSAT"] },
  { id: "hsatm", terms: ["HSATM"] },
  { id: "conrec", terms: ["ConRec", "Consumption Record"] },
  { id: "ishec", terms: ["IsHEC"] },
  { id: "heea", terms: ["HEEA"] },
  { id: "zk", terms: ["ZK"] },
  { id: "pot", terms: ["the pot"] },
  { id: "fund", terms: ["common fund"] },
  { id: "commitment", terms: ["monthly commitment", "ISP commitment", "prepays"] },
  { id: "plan", terms: ["standing plan"] },
  { id: "freeze", terms: ["the freeze"] },
  { id: "bill", terms: ["ISP bill", "your bill"] },
  { id: "overdraft", terms: ["overdraft"] },
  { id: "counterparty", terms: ["counterparty"] },
  { id: "ahead", terms: ["spend-ahead"] },
  { id: "faucet", terms: ["FUP faucet", "faucet"] },
  { id: "hoarding", terms: ["hoarding"] },
  { id: "topups", terms: ["conditional top-ups"] },
  { id: "offchain", terms: ["off-chain"] },
  { id: "epoch", terms: ["ESP epoch", "monthly epochs"] },
  { id: "spotify", terms: ["Spotify", "app set prices"] },
];
const glossary = compileGlossary(SAMPLE);
const match = (text) => matchReply(text, glossary);
const ORDER = SAMPLE.map((island) => island.id);
const inOrder = (ids) => [...ids].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

/** A glossary of one island whose terms are given, to test single terms in isolation. */
function glossaryOf(terms) {
  return compileGlossary([{ id: "x", terms }]);
}

test("the sample graph compiles with no rejected term", () => {
  assert.deepEqual(glossary.rejected, []);
  assert.deepEqual(glossary.entries.map((entry) => entry.id), ORDER);
  for (const entry of glossary.entries) {
    assert.ok(entry.tests.length > 0, entry.id);
    for (const t of entry.tests) {
      assert.ok(["acronym", "phrase", "word"].includes(t.kind));
      assert.equal(typeof t.caseSensitive, "boolean");
      assert.equal(t.via, "tokens");
      assert.equal(t.re, undefined, "an ordinary term has no regex of its own");
    }
  }
});

// ---------------------------------------------------------------- the reviewed word list (F10)

test("REVIEWED_WORDS is exactly the reviewed list pinned in this file", () => {
  assert.deepEqual([...REVIEWED_WORDS].sort(), [...REVIEWED].sort());
  assert.equal(REVIEWED_WORDS.size, REVIEWED.length);
  for (const word of REVIEWED_WORDS) {
    assert.match(word, /^[a-z]+$/, `${word} is one plain lowercase word`);
  }
});

test("DISTINCT_WORDS is only the old name of REVIEWED_WORDS", () => {
  assert.equal(DISTINCT_WORDS, REVIEWED_WORDS);
});

test("the reviewed list holds no common word", () => {
  for (const word of [
    "pot", "base", "debt", "fund", "plan", "bill", "freeze", "commitment", "audit", "price",
    "app", "apps", "isp", "fee", "money", "allowance", "month", "claim", "round", "key", "tag",
    // the generic back doors the round-1 review found
    "collateral", "immutable", "finality", "bilateral", "underfunding", "epoch", "epochs",
    "diary", "timetable", "optimistically", "clawback", "expulsion", "settlement", "escrow",
    // dropped in round 3 (F34): deferred machinery in the summary, used by no island as a single word
    "slashing", "slashed", "slash",
  ]) {
    assert.equal(REVIEWED_WORDS.has(word), false, word);
  }
});

test("a single word that is not on the reviewed list is rejected, in a phrase it is fine", () => {
  const compiled = compileGlossary([
    {
      id: "x",
      terms: [
        "collateral", "immutable", "finality", "bilateral", "underfunding", "epoch",
        "slashing", "overdraft",
        "posted collateral", "immutable once posted", "settlement finality", "bilateral audit",
      ],
    },
  ]);
  assert.deepEqual(
    compiled.rejected.map((r) => r.term),
    ["collateral", "immutable", "finality", "bilateral", "underfunding", "epoch", "slashing"],
  );
  assert.deepEqual(matchReply("the collateral", compiled), []);
  assert.deepEqual(matchReply("it is immutable", compiled), []);
  assert.deepEqual(matchReply("settlement finality", compiled), ["x"]);
  assert.deepEqual(matchReply("Posted Collateral", compiled), ["x"]);
  assert.deepEqual(matchReply("a slashing", compiled), [], "slashing is not a reviewed word (F34)");
  assert.deepEqual(matchReply("an overdraft", compiled), ["x"]);
});

test("the round-1 back-door replies light nothing", () => {
  // A faithful overdraft answer that mentions collateral, and "immutable once posted".
  const islands = [
    { id: "penalties", terms: ["posted collateral", "collateral slashing"] },
    { id: "finality", terms: ["settlement finality"] },
  ];
  const g = compileGlossary(islands);
  assert.deepEqual(g.rejected, []);
  assert.deepEqual(matchReply("Collateral, debt limits and repayment rules are not yet defined.", g), []);
  assert.deepEqual(matchReply("It is immutable once posted.", g), []);
  assert.deepEqual(matchReply("Each month your household gets an allowance to spend across apps.", glossary), []);
});

// ---------------------------------------------------------------- classification

test("classifyTerm", () => {
  const cases = {
    AtS: "acronym",
    IsHEC: "acronym",
    RtgP: "acronym",
    CfEfA: "acronym",
    IPtD: "acronym",
    ConRec: "acronym",
    HEIDs: "acronym",
    HSATM: "acronym",
    FUP: "acronym",
    ZK: "acronym",
    HEEA: "acronym",
    "the pot": "phrase",
    "spend-ahead": "phrase",
    "off-chain": "phrase",
    "Allowance to Spend": "phrase",
    "Consumption Record": "phrase",
    "ISP bill": "phrase",
    overdraft: "word",
    Overdraft: "word",
    Spotify: "word",
    prepays: "word",
    counterparty: "word",
    slashing: "rejected",
    Slashed: "rejected",
    pot: "rejected",
    base: "rejected",
    debt: "rejected",
    fund: "rejected",
    plan: "rejected",
    bill: "rejected",
    freeze: "rejected",
    commitment: "rejected",
    audit: "rejected",
    collateral: "rejected",
    immutable: "rejected",
    finality: "rejected",
    bilateral: "rejected",
    underfunding: "rejected",
    epoch: "rejected",
    Plan: "rejected",
    "debt-": "rejected",
    "-": "rejected",
    "  ": "rejected",
    "": "rejected",
    A: "rejected",
    2026: "rejected",
  };
  for (const [term, kind] of Object.entries(cases)) assert.equal(classifyTerm(term), kind, JSON.stringify(term));
  for (const bad of [null, undefined, 42, {}, [], true]) assert.equal(classifyTerm(bad), "rejected");
});

test("classifyTerm agrees with the regex reference on generated terms", () => {
  const rnd = seededRandom(20261010);
  const atoms = ["pot", "Pot", "AtS", "ats", "HEID", "ZK", "x", "é", "Éa", "9", "overdraft", "Spotify", "faucet", "collateral", "ISP's", "C++", "a.b"];
  const joins = [" ", "-", "  ", " - ", "\n", ""];
  for (let i = 0; i < 400; i += 1) {
    let term = atoms[Math.floor(rnd() * atoms.length)];
    for (let n = Math.floor(rnd() * 3); n > 0; n -= 1) {
      term += joins[Math.floor(rnd() * joins.length)] + atoms[Math.floor(rnd() * atoms.length)];
    }
    assert.equal(classifyTerm(term), referenceClassify(term, REVIEWED), JSON.stringify(term));
  }
});

test("normaliseReply", () => {
  assert.equal(normaliseReply("It’s “the” pot’s"), "It's \"the\" pot's");
  assert.equal(normaliseReply("a b\nc\r\nd\te"), "a b c d e");
  assert.equal(normaliseReply("  a   b \n\n  c  "), "a b c");
  assert.equal(normaliseReply("spend‑ahead"), "spend-ahead");
  // F35: the en dash and the minus sign are hyphens; the em dash is sentence punctuation and stays.
  assert.equal(normaliseReply("spend\u2013ahead"), "spend-ahead");
  assert.equal(normaliseReply("spend\u2212ahead"), "spend-ahead");
  assert.equal(normaliseReply("spend\u2010ahead spend\u2011ahead"), "spend-ahead spend-ahead");
  assert.equal(normaliseReply("spend\u2014ahead"), "spend\u2014ahead");
  assert.equal(normaliseReply(""), "");
  for (const bad of [null, undefined, 7, {}, []]) assert.equal(normaliseReply(bad), "");
});

// ---------------------------------------------------------------- acronyms

test("acronyms are case-sensitive whole tokens", () => {
  assert.deepEqual(match("the AtS"), ["ats"]);
  assert.deepEqual(match("AtS"), ["ats"]);
  assert.deepEqual(match("The public AtS, in full."), ["ats"]);
  assert.deepEqual(match("(AtS)"), ["ats"]);
  assert.deepEqual(match("the AtS's list"), ["ats"]);
  assert.deepEqual(match("non-AtS"), ["ats"]);
  for (const text of ["ats", "ATS", "Ats", "aTS", "cats", "the cats", "Stats", "stats", "ATSC", "XAtS", "AtSx", "AtS1", "1AtS", "AtSé", "éAtS"]) {
    assert.deepEqual(match(text), [], text);
  }
});

test("acronyms match through a plural s", () => {
  assert.deepEqual(match("each household has HEIDs"), ["heid"]);
  assert.deepEqual(match("HEID"), ["heid"]);
  assert.deepEqual(match("the ConRecs"), ["conrec"]);
  assert.deepEqual(match("the HEEAs"), ["heea"]);
  assert.deepEqual(match("the ZKs"), ["zk"]);
  assert.deepEqual(match("HEIDS"), [], "an uppercase S is a different token");
  assert.deepEqual(match("HEIDx"), []);
  assert.deepEqual(match("HEIDss"), []);
});

test("every acronym lights only when written with its own case", () => {
  for (const acronym of ["IsHEC", "ConRec", "HEEA", "HEID", "AtS", "ZK"]) {
    const only = glossaryOf([acronym]);
    assert.deepEqual(matchReply(`Then the ${acronym} is checked.`, only), ["x"], acronym);
    for (const wrong of [acronym.toLowerCase(), acronym.toUpperCase()]) {
      if (wrong === acronym) continue;
      assert.deepEqual(matchReply(`Then the ${wrong} is checked.`, only), [], wrong);
    }
  }
});

test("HSAT does not match inside HSATM, nor the reverse", () => {
  const only = glossaryOf(["HSAT"]);
  assert.deepEqual(matchReply("the HSAT total", only), ["x"]);
  assert.deepEqual(matchReply("the HSATs", only), ["x"]);
  assert.deepEqual(matchReply("the HSATM", only), []);
  assert.deepEqual(matchReply("the HSATMs", only), []);
  assert.deepEqual(match("the HSAT and the HSATM"), ["hsat", "hsatm"]);
  assert.deepEqual(match("the HSATM"), ["hsatm"]);
  assert.deepEqual(match("the HSAT"), ["hsat"]);
});

// ---------------------------------------------------------------- phrases

test("common single words never light an island alone", () => {
  for (const word of ["pot", "base", "debt", "fund", "plan", "bill", "freeze", "commitment", "audit", "collateral", "immutable", "finality", "epoch", "allowance", "spend"]) {
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
});

test("fixed phrases light their island", () => {
  assert.deepEqual(match("the pot"), ["pot"]);
  assert.deepEqual(match("The pot is spending authority, not money transferred."), ["pot"]);
  assert.deepEqual(match("a common fund"), ["fund"]);
  assert.deepEqual(match("Common Fund"), ["fund"]);
  assert.deepEqual(match("a monthly commitment"), ["commitment"]);
  assert.deepEqual(match("one standing plan"), ["plan"]);
  assert.deepEqual(match("the freeze"), ["freeze"]);
  assert.deepEqual(match("your bill"), ["bill"]);
  assert.deepEqual(match("the pots"), ["pot"], "plural s on the last word");
  assert.deepEqual(match("two common funds"), ["fund"]);
});

test("phrases are case-insensitive and hyphen and space are interchangeable", () => {
  for (const text of [
    "spend ahead",
    "spend-ahead",
    "Spend-Ahead",
    "SPEND AHEAD",
    "spend   ahead",
    "spend\nahead",
    "spend ahead",
    "spend‑ahead",
    "spend - ahead",
  ]) {
    assert.deepEqual(match(`It is ${text} behaviour.`), ["ahead"], JSON.stringify(text));
  }
  assert.deepEqual(match("app set prices"), ["spotify"]);
  assert.deepEqual(match("App-Set Prices"), ["spotify"]);
  assert.deepEqual(match("off chain"), ["offchain"]);
  assert.deepEqual(match("conditional top-ups"), ["topups"]);
  assert.deepEqual(match("Conditional top ups"), ["topups"]);
  assert.deepEqual(match("a top up"), [], "a bare top-up is everyday talk and lights nothing");
  assert.deepEqual(match("top-ups"), []);
  assert.deepEqual(match("spendahead"), []);
});

// ---------------------------------------------------------------- Markdown marks and dashes are gaps (F35)

test("Markdown emphasis marks between the words of a phrase are one gap: the **pot** is the pot", () => {
  for (const text of [
    "the **pot**",
    "the _pot_",
    "the *pot*",
    "the `pot`",
    "**the pot**",
    "**the** **pot**",
    "the ** pot",
    "the\n\n**pot**",
    "The   _POT_",
    "the__pot",
    "the-**pot**",
    "the --pot",
    "the pot's",
    "the pot\u2019s",
    "the **pots**",
    "the ***pot***",
  ]) {
    assert.deepEqual(match(`It is ${text} here.`), ["pot"], JSON.stringify(text));
  }
  assert.deepEqual(match("a common **fund**"), ["fund"]);
  assert.deepEqual(match("a **common fund**"), ["fund"]);
  assert.deepEqual(match("it is **spend-ahead**"), ["ahead"]);
  assert.deepEqual(match("a _monthly_ **commitment**"), ["commitment"]);
  assert.deepEqual(match("an `ESP` `epoch`"), ["epoch"], "a case-sensitive phrase still matches through the marks");
  assert.deepEqual(match("**Allowance** to **Spend**"), ["ats"]);
  assert.deepEqual(match("**allowance** to **spend**"), [], "the marks do not relax the case rule");
  for (const acronym of ["**AtS**", "_AtS_", "`AtS`", "*AtS*", "(**AtS**)"]) {
    assert.deepEqual(match(`the ${acronym} list`), ["ats"], acronym);
  }
});

test("only spaces, hyphens and Markdown marks are a gap: other punctuation still breaks a phrase", () => {
  for (const text of [
    "He said \"the\". Pot roast followed.",
    "and then the.\n\n**Pot** roast",
    "the. **pot**",
    "the, **pot**",
    "the (pot)",
    "the \"pot\"",
    "the: pot",
    "the; pot",
    "the \u2014 pot",
    "the / pot",
    "the ** . ** pot",
    "the '*pot*",
    "the p**ot**",
    "the po*t",
    "the p_ot",
    "the potash and **the** thing",
    "stray the. Another sentence about a pot.",
    "spend, ahead",
    "spend\u2014ahead",
    "spend. **ahead**",
  ]) {
    assert.deepEqual(match(text), [], JSON.stringify(text));
  }
  assert.deepEqual(match("the pot's"), ["pot"], "a possessive after the phrase is fine");
});

test("an en dash and a minus sign read as hyphens in a reply, an em dash does not", () => {
  for (const text of [
    "spend\u2013ahead",
    "spend \u2013 ahead",
    "spend\u2212ahead",
    "spend \u2212 ahead",
    "Spend\u2013Ahead",
    "spend\u2010ahead",
    "spend\u2011ahead",
  ]) {
    assert.deepEqual(match(`It is ${text} behaviour.`), ["ahead"], JSON.stringify(text));
  }
  assert.deepEqual(match("Allowance\u2013to\u2013Spend"), ["ats"]);
  assert.deepEqual(match("allowance\u2013to\u2013spend"), []);
  assert.deepEqual(match("conditional top\u2013ups"), ["topups"]);
  assert.deepEqual(match("off\u2212chain"), ["offchain"]);
  assert.deepEqual(match("It is spend\u2014ahead behaviour."), [], "an em dash is sentence punctuation, not a hyphen");
});

test("a term written with Markdown marks or dashes is the same phrase as the plain one", () => {
  for (const term of ["the_pot", "the*pot", "the`pot`", "the\u2013pot", "the\u2212pot", "the  --  pot"]) {
    const g = glossaryOf([term]);
    assert.equal(g.entries[0].tests.length, 1, term);
    assert.equal(g.entries[0].tests[0].kind, "phrase", term);
    for (const reply of ["the pot", "the-pot", "the **pot**", "THE _POT_"]) {
      assert.deepEqual(matchReply(`see ${reply} now`, g), ["x"], `${term} <- ${reply}`);
    }
    assert.deepEqual(matchReply("see the. pot now", g), [], term);
  }
  // A lone mark, or a mark at an end, is not a second word.
  for (const term of ["pot*", "_pot", "`pot`", "***", "_", "-*-"]) {
    assert.equal(classifyTerm(term), "rejected", term);
  }
});

// ---------------------------------------------------------------- acronym expansions are case-sensitive (F10)

test("a phrase whose first character is uppercase is matched case-sensitively", () => {
  assert.deepEqual(match("The Allowance to Spend is public."), ["ats"]);
  assert.deepEqual(match("each Allowance to Spends"), ["ats"], "a plural s is still allowed");
  assert.deepEqual(match("a Consumption Record per request"), ["conrec"]);
  // The reply that lit the AtS island in the round-1 review: ordinary words, not the expansion.
  assert.deepEqual(match("Each month your household gets an allowance to spend across apps."), []);
  for (const text of [
    "allowance to spend",
    "Allowance To Spend",
    "ALLOWANCE TO SPEND",
    "allowance-to-spend",
    "a consumption record",
    "Consumption record",
    "consumption Record",
  ]) {
    assert.deepEqual(match(text), [], text);
  }
  // Space and hyphen are still interchangeable inside the case-sensitive phrase.
  assert.deepEqual(match("Allowance-to-Spend"), ["ats"]);
  assert.deepEqual(match("Allowance  to\nSpend"), ["ats"]);
  // "ISP bill" starts with an uppercase letter: it is case-sensitive too.
  assert.deepEqual(match("the ISP bill"), ["bill"]);
  assert.deepEqual(match("the isp bill"), []);
  assert.deepEqual(match("the ISP Bill"), []);
  assert.deepEqual(match("the FUP faucet"), ["faucet"]);
});

test("an all-lowercase phrase, or one that starts with a digit or a symbol, stays case-insensitive", () => {
  const g = compileGlossary([
    { id: "a", terms: ["the pot"] },
    { id: "b", terms: ["2FA code"] },
    { id: "c", terms: ["'s pot"] },
    { id: "d", terms: ["the ISP bill"] },
  ]);
  const flags = Object.fromEntries(g.entries.map((e) => [e.id, e.tests.map((t) => t.caseSensitive)]));
  assert.deepEqual(flags, { a: [false], b: [false], c: [false], d: [false] });
  assert.deepEqual(matchReply("THE POT", g), ["a"]);
  assert.deepEqual(matchReply("a 2fa CODE", g), ["b"]);
  assert.deepEqual(matchReply("the isp BILL", g), ["d"]);
});

test("a case-sensitive and a case-insensitive spelling of one phrase are two different terms", () => {
  const g = compileGlossary([{ id: "x", terms: ["The Pot", "the pot", "The  Pot", "the POT"] }]);
  assert.deepEqual(g.entries[0].tests.map((t) => [t.term, t.caseSensitive]), [
    ["The Pot", true],
    ["the pot", false],
  ]);
  assert.deepEqual(matchReply("THE POT", g), ["x"]);
  assert.deepEqual(matchReply("The Pot", g), ["x"]);
});

// ---------------------------------------------------------------- words

test("reviewed words match as whole words, case-insensitively, without a plural", () => {
  assert.deepEqual(match("overdraft"), ["overdraft"]);
  assert.deepEqual(match("An Overdraft."), ["overdraft"]);
  assert.deepEqual(match("the faucet"), ["faucet"]);
  assert.deepEqual(match("Spotify"), ["spotify"]);
  assert.deepEqual(match("like spotify does"), ["spotify"]);
  assert.deepEqual(match("the counterparty"), ["counterparty"]);
  assert.deepEqual(match("hoarding"), ["hoarding"]);
  assert.deepEqual(match("it prepays"), ["commitment"]);
  assert.deepEqual(match("overdrafts"), [], "words take no plural s");
  assert.deepEqual(match("two counterparties"), []);
  assert.deepEqual(match("each ESP epoch"), ["epoch"]);
  assert.deepEqual(match("many monthly epochs"), ["epoch"]);
  assert.deepEqual(match("each epoch"), [], "a bare epoch is in almost every ESP sentence and lights nothing");
  assert.deepEqual(match("many epochs"), []);
  assert.deepEqual(match("the epoch ID"), ["heid"]);
});

test("nothing matches inside a longer word", () => {
  for (const text of [
    "overdrafting",
    "overdrafted",
    "preoverdraft",
    "Spotifyish",
    "Spotify2",
    "xfaucet",
    "counterpartying",
    "monthly epochal",
    "hoardings",
    "the potash",
    "breathe pot",
    "common fundamental",
    "the freezer",
    "standing planets",
    "monthly commitmentx",
    "prespend ahead",
    "spend aheadx",
    "your billing",
    "acquired HEIDx",
    "2AtS",
  ]) {
    assert.deepEqual(match(text), [], text);
  }
});

test("curly apostrophes are normalised on both sides", () => {
  const fromStraight = glossaryOf(["ISP's pot"]);
  assert.deepEqual(matchReply("the ISP’s pot", fromStraight), ["x"]);
  assert.deepEqual(matchReply("the ISP's pot", fromStraight), ["x"]);
  const fromCurly = glossaryOf(["ISP’s pot"]);
  assert.deepEqual(matchReply("the ISP's pot", fromCurly), ["x"]);
  assert.deepEqual(matchReply("the ISP’s pot", fromCurly), ["x"]);
  assert.deepEqual(matchReply("the ISPs pot", fromCurly), []);
});

// ---------------------------------------------------------------- results

test("matchReply returns graph order, each id once", () => {
  const text = "The ConRec, then the AtS, then the pot, then the common fund, then the ConRec and the AtS again. Spend ahead, spend-ahead.";
  const ids = match(text);
  assert.deepEqual(ids, inOrder(ids));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ["ats", "conrec", "pot", "fund", "ahead"]);
  assert.deepEqual(match(text), ids, "repeated calls give the same answer");
});

test("two entries with one id give that id once, at its first position", () => {
  const g = compileGlossary([
    { id: "a", terms: ["the pot"] },
    { id: "b", terms: ["AtS"] },
    { id: "a", terms: ["AtS", "common fund"] },
  ]);
  assert.deepEqual(matchReply("AtS and the pot", g), ["a", "b"]);
  assert.deepEqual(matchReply("common fund", g), ["a"]);
});

test("matchReply is safe on odd input", () => {
  for (const bad of [null, undefined, 42, {}, [], "", "   ", "\n\n"]) assert.deepEqual(match(bad), []);
  for (const badGlossary of [null, undefined, {}, { entries: null }, { entries: [] }, "x", { entries: [{ id: "x", tests: [] }] }]) {
    assert.deepEqual(matchReply("the pot", badGlossary), []);
  }
});

test("compileGlossary never throws and reports what it rejects", () => {
  const compiled = compileGlossary([
    { id: "a", terms: ["pot", "base", "the pot", "debt-", "-", "", "  ", 42, null, "AtS", "overdraft"] },
    { id: "b" },
    { id: "c", terms: "not an array" },
    { id: "d", terms: ["AtS", "ats ", "AtS", "the pot", "The  Pot"] },
    null,
    undefined,
    { terms: ["AtS"] },
    { id: 7, terms: ["AtS"] },
  ]);
  assert.deepEqual(compiled.entries.map((entry) => entry.id), ["a", "b", "c", "d"]);
  assert.deepEqual(compiled.rejected, [
    { id: "a", term: "pot" },
    { id: "a", term: "base" },
    { id: "a", term: "debt-" },
    { id: "a", term: "-" },
    { id: "a", term: "" },
    { id: "a", term: "  " },
    { id: "a", term: 42 },
    { id: "a", term: null },
    { id: "d", term: "ats " },
  ]);
  assert.deepEqual(compiled.entries[0].tests.map((t) => [t.term, t.kind]), [
    ["the pot", "phrase"],
    ["AtS", "acronym"],
    ["overdraft", "word"],
  ]);
  assert.deepEqual(compiled.entries[1].tests, []);
  assert.deepEqual(
    compiled.entries[3].tests.map((t) => t.term),
    ["AtS", "the pot", "The Pot"],
    "exact duplicates are dropped; the capitalised spelling is a different (case-sensitive) term",
  );
  for (const bad of [null, undefined, "x", 3, {}]) {
    assert.doesNotThrow(() => compileGlossary(bad));
  }
  assert.deepEqual(compileGlossary(null), { entries: [], rejected: [] });
});

test("compileGlossary rejects a common word term but keeps matching its phrases", () => {
  const compiled = compileGlossary([{ id: "x", terms: ["pot", "the pot"] }]);
  assert.deepEqual(compiled.rejected, [{ id: "x", term: "pot" }]);
  assert.deepEqual(matchReply("a pot", compiled), []);
  assert.deepEqual(matchReply("the pot", compiled), ["x"]);
});

test("a plain reply that merely uses common words lights nothing", () => {
  const plain = [
    "The base of the plan is a bill that you pay each month, and the debt, the fund and the audit are separate. Freeze the commitment.",
    "A pot of tea, a base camp, a debt of gratitude, a fund raiser, a plan B, the bill, an audit trail, a freeze frame, a commitment to quality.",
  ];
  for (const text of plain) assert.deepEqual(match(text), [], text);
});

// ---------------------------------------------------------------- terms with punctuation

test("regex special characters in a term are matched literally", () => {
  const odd = glossaryOf(["C++ rules", "a.b c", "IsHEC(1)"]);
  assert.deepEqual(matchReply("C++ rules", odd), ["x"]);
  assert.deepEqual(matchReply("a.b c", odd), ["x"]);
  assert.deepEqual(matchReply("IsHEC(1)", odd), ["x"]);
  assert.deepEqual(matchReply("C rules", odd), []);
  assert.deepEqual(matchReply("axb c", odd), []);
  assert.deepEqual(matchReply("C+ + rules", odd), []);
  assert.deepEqual(matchReply("C++-rules", odd), ["x"], "a hyphen is a separator");
  assert.deepEqual(matchReply("aXb c", odd), []);
});

test("a term that starts or ends with punctuation keeps a regex of its own, and only that term", () => {
  const g = glossaryOf(["IsHEC(1)", "the pot", "(AtS)"]);
  const via = Object.fromEntries(g.entries[0].tests.map((t) => [t.term, t.via]));
  assert.deepEqual(via, { "IsHEC(1)": "pattern", "the pot": "tokens", "(AtS)": "pattern" });
  for (const t of g.entries[0].tests) {
    if (t.via === "pattern") {
      assert.ok(t.re instanceof RegExp);
      assert.equal(t.re.global, false);
      assert.equal(t.re.sticky, false);
      assert.doesNotMatch(t.re.source, /\(\?<[!=]/, "no lookbehind");
    }
  }
  assert.deepEqual(matchReply("x (AtS) y", g), ["x"]);
  assert.deepEqual(matchReply("x(AtS) y", g), [], "a letter before the term is a longer word");
});

test("boundaries without lookbehind: start of text, punctuation and non-ASCII neighbours", () => {
  const g = glossaryOf(["the pot", "AtS", "faucet"]);
  assert.deepEqual(matchReply("the pot", g), ["x"], "start and end of the text");
  assert.deepEqual(matchReply("(the pot)", g), ["x"], "punctuation neighbours");
  assert.deepEqual(matchReply("\"AtS\"", g), ["x"]);
  assert.deepEqual(matchReply("see AtS.", g), ["x"]);
  assert.deepEqual(matchReply("the faucet", g), ["x"]);
  assert.deepEqual(matchReply("bathe pot", g), [], "no match inside a longer word on the left");
  assert.deepEqual(matchReply("the potion", g), [], "no match inside a longer word on the right");
  assert.deepEqual(matchReply("éthe pot", g), [], "a non-ASCII letter on the left is a letter");
  assert.deepEqual(matchReply("the potä", g), [], "a non-ASCII letter on the right is a letter");
  assert.deepEqual(matchReply("9the pot", g), [], "a digit on the left");
  assert.deepEqual(matchReply("🧠the pot", g), ["x"], "an emoji is a boundary");
  assert.deepEqual(matchReply("xAtS", g), []);
  assert.deepEqual(matchReply("AtSx", g), []);
  assert.deepEqual(matchReply("AtSs", g), ["x"], "a plural s is still allowed");
  assert.deepEqual(matchReply("faucetfaucet", g), []);
  assert.deepEqual(matchReply("the pot the pot", g), ["x"]);
  assert.deepEqual(matchReply("日本AtS", g), [], "a CJK letter is a letter");
  assert.deepEqual(matchReply("٣AtS", g), [], "a non-ASCII digit is a digit");
});

test("a multi-word term at the very end of the reply, or cut short, does not match or throw", () => {
  const g = glossaryOf(["the pot of gold"]);
  assert.deepEqual(matchReply("the pot of", g), []);
  assert.deepEqual(matchReply("the", g), []);
  assert.deepEqual(matchReply("the pot of gold", g), ["x"]);
  assert.deepEqual(matchReply("the pot of golds", g), ["x"]);
  assert.deepEqual(matchReply("the the pot of gold", g), ["x"]);
  assert.deepEqual(matchReply("the pot, of gold", g), [], "punctuation inside a phrase breaks it");
});

// ---------------------------------------------------------------- how it runs (F15)

test("the glossary builds one regex in all, whatever its size, and matching builds none", () => {
  const RealRegExp = globalThis.RegExp;
  let constructed = 0;
  const islands = Array.from({ length: 60 }, (_, i) => ({
    id: `island-${i}`,
    terms: [`Ac${i}X`, `Zz${i}Q`, `alpha${i} beta`, `Gamma Delta${i}`, `common fund${i}`],
  }));
  let compiled;
  try {
    globalThis.RegExp = new Proxy(RealRegExp, {
      construct(target, args, newTarget) {
        constructed += 1;
        return Reflect.construct(target, args, newTarget);
      },
    });
    compiled = compileGlossary(islands);
    assert.equal(constructed, 1, "one tokeniser regex for the whole glossary");
    constructed = 0;
    assert.deepEqual(matchReply("the Ac3X and alpha4 beta, Gamma Delta5 and common funds6.", compiled), ["island-3", "island-4", "island-5"]);
    assert.equal(constructed, 0);
  } finally {
    globalThis.RegExp = RealRegExp;
  }
  assert.equal(compiled.rejected.length, 0);
  assert.equal(glossarySize(compiled), 300);
});

/** A synthetic 60-island glossary of 300 terms, and a text built from them. */
function syntheticGlossary() {
  const islands = Array.from({ length: 60 }, (_, i) => ({
    id: `island-${i}`,
    terms: [`Ac${i}X`, `Zz${i}Q`, `alpha${i} beta`, `Gamma Delta${i}`, `the common fund${i}`],
  }));
  const words = [];
  for (let i = 0; i < 60; i += 1) {
    words.push(`the household ISP pays Ac${i}X each month`, `and alpha${i} beta settles`, `Gamma Delta${i} plus`, "while the pot stays solvent;");
  }
  return { islands, words };
}

function textOfSize(words, size) {
  let text = "";
  for (let i = 0; text.length < size; i += 1) text += `${words[i % words.length]} `;
  return text.slice(0, size);
}

test("performance: a cold first reply on a 60-island, 300-term glossary stays fast (5 KB < 20 ms, 50 KB < 100 ms)", () => {
  const { islands, words } = syntheticGlossary();
  const small = coldFirstMatchMs(islands, textOfSize(words, 5 * 1024));
  assert.ok(small.ids.length >= 20, `the reply lights ${small.ids.length} islands`);
  assert.ok(small.ms < 20, `first matchReply on 5 KB took ${small.ms.toFixed(2)} ms`);
  const large = coldFirstMatchMs(islands, textOfSize(words, 50 * 1024));
  assert.equal(large.ids.length, 60);
  assert.ok(large.ms < 100, `first matchReply on 50 KB took ${large.ms.toFixed(2)} ms`);
});

test("performance: the cost grows with the reply, not with the glossary", () => {
  const { islands, words } = syntheticGlossary();
  const reply = textOfSize(words, 20 * 1024);
  const small = compileGlossary(islands.slice(0, 6));
  const large = compileGlossary(islands);
  const time = (g) => {
    matchReply(reply, g);
    let best = Infinity;
    for (let trial = 0; trial < 3; trial += 1) {
      const start = performance.now();
      for (let i = 0; i < 5; i += 1) matchReply(reply, g);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };
  const a = time(small);
  const b = time(large);
  // The regex matcher was about ten times slower with ten times the terms; this one is about level.
  assert.ok(b < a * 3 + 10, `10x the islands took ${b.toFixed(1)} ms against ${a.toFixed(1)} ms`);
});

test("performance: separator-heavy and repetitive input does not blow up", () => {
  const g = compileGlossary([
    ...SAMPLE,
    ...Array.from({ length: 60 }, (_, i) => ({ id: `the-${i}`, terms: [`the ${"pot ".repeat(i % 5)}x${i}`] })),
  ]);
  const hostile = [
    "the ".repeat(1300),
    "spend - ".repeat(650),
    "- ".repeat(2600),
    " ".repeat(5000),
    "AtS".repeat(1700),
    "common fund ".repeat(430),
    "the pot ".repeat(650),
    "a".repeat(50000),
    "x ".repeat(25000),
    "́".repeat(5000),
    "é".repeat(5000),
  ];
  const start = performance.now();
  for (const text of hostile) matchReply(text, g);
  const ms = performance.now() - start;
  assert.ok(ms < 300, `hostile inputs took ${ms.toFixed(1)} ms`);
});

test("the matcher touches no browser storage or DOM, and is built without RegExp lookbehind", () => {
  const source = readFileSync(new URL("../../site/js/atlas-match.js", import.meta.url), "utf8");
  for (const forbidden of ["localStorage", "sessionStorage", "document", "innerHTML", "eval(", "fetch("]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\(\?<[!=]/, "no lookbehind group in the code (Safari before 16.4 throws on it)");
});

test("glossarySize counts the compiled tests and is zero when nothing compiled", () => {
  assert.equal(glossarySize(glossary), glossary.entries.reduce((total, entry) => total + entry.tests.length, 0));
  assert.ok(glossarySize(glossary) >= 30);
  assert.equal(glossarySize({ entries: [] }), 0);
  assert.equal(glossarySize({ entries: [{ id: "x", tests: [] }] }), 0);
  assert.equal(glossarySize(null), 0);
  assert.equal(glossarySize(undefined), 0);
  assert.equal(glossarySize({}), 0);
  // An engine that cannot compile the patterns ends up with an empty glossary and a list of rejects.
  const RealRegExp = globalThis.RegExp;
  try {
    globalThis.RegExp = class {
      constructor() {
        throw new SyntaxError("Invalid regular expression: unsupported");
      }
    };
    const broken = compileGlossary(SAMPLE);
    globalThis.RegExp = RealRegExp;
    assert.equal(glossarySize(broken), 0);
    const terms = SAMPLE.reduce((total, island) => total + island.terms.length, 0);
    assert.equal(broken.rejected.length, terms, "every term is reported");
    assert.deepEqual(matchReply("the pot and the common fund", broken), []);
  } finally {
    globalThis.RegExp = RealRegExp;
  }
});

test("warmGlossary is cheap, repeatable and never throws", () => {
  assert.ok(WARM_SAMPLE.length > 10 && WARM_SAMPLE.length < 200, "a short sample");
  assert.ok(matchReply(WARM_SAMPLE, glossary).length >= 4, "the sample touches an acronym, phrases and a word");
  const before = match(WARM_SAMPLE);
  assert.equal(warmGlossary(glossary), undefined);
  assert.equal(warmGlossary(glossary, 5), undefined);
  assert.doesNotThrow(() => warmGlossary(null));
  assert.doesNotThrow(() => warmGlossary(undefined, 0));
  assert.doesNotThrow(() => warmGlossary({ entries: [{ id: "x", tests: [{ re: { test() { throw new Error("boom"); } } }] }] }));
  assert.deepEqual(match(WARM_SAMPLE), before, "warming leaves no state behind");
  const start = performance.now();
  warmGlossary(glossary, 2);
  assert.ok(performance.now() - start < 20, "warming is not a long task any more");
});

// ---------------------------------------------------------------- differential test against the regex reference

const reference = referenceCompile(SAMPLE, new Set(REVIEWED));

function assertSameAsReference(islands, replies, label) {
  const g = compileGlossary(islands);
  const ref = referenceCompile(islands, new Set(REVIEWED));
  assert.deepEqual(g.rejected, ref.rejected, `${label}: rejected terms`);
  assert.deepEqual(g.entries.map((e) => e.id), ref.entries.map((e) => e.id), `${label}: entries`);
  for (const reply of replies) {
    assert.deepEqual(matchReply(reply, g), referenceMatch(reply, ref), `${label}: ${JSON.stringify(reply)}`);
  }
}

const HANDWRITTEN_REPLIES = [
  "",
  " ",
  "the",
  "the pot",
  "THE POT",
  "The Pot.",
  "(the pot)",
  "the pots, the potS and the POTS",
  "the potion",
  "bathe pot",
  "a common fund, a common-fund, a common   fund, a common\nfund, a common fund",
  "Common Fund; COMMON FUND; common fundS",
  "AtS ats ATS Ats AtSs AtSS (AtS) \"AtS\" non-AtS AtS's xAtS AtSx",
  "Allowance to Spend; allowance to spend; Allowance To Spend; Allowance-to-Spend",
  "Each month your household gets an allowance to spend across apps.",
  "the HSAT and the HSATM, the HSATs, the HSATMs",
  "HEID HEIDs HEIDS HEIDx the epoch ID, the epoch IDs, the Epoch ID",
  "ISP bill, isp bill, ISP Bill, the ISP-bill, ISP  bill",
  "the FUP faucet and the FUP-faucet and the fup faucet; faucet; FAUCET; Faucets",
  "Spotify spotify SPOTIFY Spotifys Spotify2 xSpotify",
  "prepays prepay prepaid Prepays PREPAYS",
  "overdraft overdrafts overdrafted Overdraft",
  "monthly epochs, monthly epoch, ESP epoch, ESP epochs, esp epoch",
  "conditional top-ups, conditional top ups, Conditional Top-Ups, top-ups",
  "off-chain off chain Off-Chain offchain",
  "spend ahead spend-ahead spend - ahead spend--ahead spend‑ahead spend ahead",
  "app set prices, app-set-prices, App Set Price",
  "ZK zk ZKs Zk ZKp",
  "ConRec ConRecs Conrec conrec CONREC; a Consumption Record, Consumption Records, consumption record",
  "日本 the pot 日本the pot the pot日本",
  "٣ AtS ٣AtS AtS٣",
  "😀the pot😀 🧠AtS🧠",
  "the pot's the pot’s the pot”",
  "- - - the pot - - -",
  "thé pot",
  "the pot́",
  "É the pot é AtS é",
  "x".repeat(300),
  "the ".repeat(100) + "pot",
  "the **pot**, the _pot_, the `pot`, **the pot**, the *pot*, the ***pots***",
  "the. **pot** and the, _pot_ and the (pot) and the \"pot\" and the p**ot**",
  "spend\u2013ahead spend \u2212 ahead spend\u2014ahead spend\u2010ahead spend ** ahead spend_ahead",
  "Allowance\u2013to\u2013Spend allowance\u2013to\u2013spend **Allowance** to **Spend** `Allowance to Spend`",
  "ISP **bill** **ISP bill** `ISP` `bill` isp _bill_ ISP_bill",
  "a_b c, a b c, a**b c, a_b-c, A_B C",
  "common __fund__ common _*fund*_ common ** fund common.fund",
  "**AtS** _AtS_ `AtS` *AtS* AtS_ _AtS non_AtS AtS**s",
];

test("differential: the tokenising matcher equals the regex reference on handwritten replies", () => {
  assertSameAsReference(SAMPLE, HANDWRITTEN_REPLIES, "sample");
  // The same replies against each island on its own, so one island's hit cannot hide another's miss.
  for (const island of SAMPLE) assertSameAsReference([island], HANDWRITTEN_REPLIES, island.id);
  assert.ok(reference.entries.length === SAMPLE.length);
});

test("differential: terms with punctuation, accents, digits and odd separators", () => {
  const odd = [
    { id: "a", terms: ["C++ rules", "a.b c", "IsHEC(1)", "(AtS)", "ISP's pot", "x - y", "x--y z"] },
    { id: "b", terms: ["é-à", "É à", "9 lives", "2FA code", "日本 語", "٣ days", "ß-test", "a_b c"] },
    { id: "c", terms: ["the pot", "THE POT", "The Pot", "tHe pOt", "A.B.C", "a.b.c"] },
    { id: "d", terms: ["+", "+ +", "a +", "+ a", "-x", "x-", ".", "a. b"] },
    { id: "e", terms: ["FUP", "FUPs", "fupS", "ISP", "ISPs"] },
  ];
  const replies = [
    "C++ rules", "c++ rules", "C++-rules", "C+ +rules", "C++ rulesS", "xC++ rules",
    "a.b c", "A.B c", "a.b  c", "a.b-c", "a.bc",
    "IsHEC(1)", "IsHEC(1)s", "IsHEC(1)x", "xIsHEC(1)", "IsHEC (1)", "IsHEC(1",
    "(AtS)", "x(AtS)", "x (AtS)", "(AtS)x", "(AtS) x", "((AtS))",
    "the ISP's pot", "the isp's pot", "the ISPs pot", "ISP’s pot", "ISP's Pot",
    "x - y", "x-y", "x   y", "x--y z", "x - y z", "x-y-z",
    "é-à", "É-À", "é à", "É à", "É  à", "e-a",
    "9 lives", "9lives", "99 lives", "2FA code", "2fa CODE", "2FA codes",
    "日本 語", "日本語", "日本-語", "٣ days", "٣days",
    "ß-test", "SS-test", "ẞ-test",
    "a_b c", "a b c", "a_b-c",
    "THE POT", "the pot", "The Pot", "tHe pOt", "The POT", "the Pot",
    "A.B.C", "a.b.c", "A.B.Cs", "A.B.C.", "A-B-C",
    "+", "a +", "+ a", "a + b", "+ +", "++", "-x", "x-", "-x-", ".", "a. b", "a.b", "a. b.", "a.  b",
    "FUP", "FUPs", "FUPS", "fups", "fupS", "ISP ISPs", "isp",
    "random words with nothing in them",
  ];
  assertSameAsReference(odd, replies, "odd terms");
  for (const island of odd) assertSameAsReference([island], replies, `odd ${island.id}`);
});

/**
 * Random replies and terms from a vocabulary that is full of near misses. Seeds are fixed so a
 * failure replays. With `markdown`, the separators between words also include the Markdown marks
 * (asterisk, underscore, backtick), the en dash and the minus sign (F35); without it the generator
 * is exactly the round-2 one.
 */
function fuzz(seed, rounds, repliesPerRound, markdown = false) {
  const atoms = [
    "pot", "Pot", "POT", "the", "The", "AtS", "ats", "ATS", "HEID", "HEIDs", "HEIDS", "fund", "funds", "Fund", "common",
    "Common", "bill", "x", "s", "é", "Éa", "9", "42", "overdraft", "Overdraft", "Spotify", "spotify", "ISP", "ISP's", "isp",
    "C++", "a.b", "IsHEC", "IsHEC(1)", "(AtS)", "+", "FUP", "faucet", "spend", "ahead", "Allowance", "to", "Spend",
    "Consumption", "Record", "Records", "ß", "ẞ", "Ä", "ä", "日本", "٣", "½", "a_b", "hoarding", "prepays", "counterparty",
  ];
  const separators = [" ", "-", " - ", "  ", "\n", ", ", ".", "(", ")", "'", "++", "'s ", " — ", "🧠", " ", "‑", "’", "“", "/", " ,"];
  const termJoins = [" ", "-", " ", " - ", "  ", "‑", "\n"];
  const gapMix = [" ", "-", " - ", "\n"];
  if (markdown) {
    separators.push(" **", "** ", "_", " _", "`", "*", "\u2013", " \u2013 ", "\u2212", " ** ", "_ ", "**", " `");
    termJoins.push("_", "*", "`", "\u2013", " **", "** ", "\u2212", "*_");
    gapMix.push("**", " _", "`", "\u2013", "\u2212", "* ", "_");
  }
  const rnd = seededRandom(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const randomTerm = () => {
    let term = pick(atoms);
    for (let n = Math.floor(rnd() * 4); n > 0; n -= 1) term += pick(termJoins) + pick(atoms);
    if (rnd() < 0.08) term = pick(["(", "+", "-", " ", "."]) + term;
    if (rnd() < 0.08) term += pick([")", "+", "-", " ", "."]);
    return term;
  };
  const perturb = (text) => {
    const r = rnd();
    if (r < 0.15) return text.toUpperCase();
    if (r < 0.3) return text.toLowerCase();
    if (r < 0.4) return `${text}s`;
    if (r < 0.5) return text.replace(/[ -]/g, () => pick(gapMix));
    if (r < 0.58) return `x${text}`;
    if (r < 0.66) return `${text}x`;
    if (r < 0.72) return text.slice(1);
    if (r < 0.78) return text.slice(0, -1);
    if (r < 0.84) return text.replace(/^./, (c) => c.toUpperCase());
    return text;
  };
  let compared = 0;
  let lit = 0;
  for (let round = 0; round < rounds; round += 1) {
    const islands = [];
    const terms = [];
    for (let i = 1 + Math.floor(rnd() * 8); i > 0; i -= 1) {
      const own = [];
      for (let j = Math.floor(rnd() * 6); j > 0; j -= 1) {
        const term = randomTerm();
        own.push(term);
        terms.push(term);
      }
      islands.push({ id: rnd() < 0.05 ? "dup" : `i${islands.length}`, terms: own });
    }
    const g = compileGlossary(islands);
    const ref = referenceCompile(islands, new Set(REVIEWED));
    assert.deepEqual(g.rejected, ref.rejected, `seed ${seed} round ${round}: rejected`);
    for (let k = 0; k < repliesPerRound; k += 1) {
      let reply = rnd() < 0.5 ? pick(separators) : "";
      for (let n = 1 + Math.floor(rnd() * 8); n > 0; n -= 1) {
        reply += (rnd() < 0.35 && terms.length > 0 ? perturb(pick(terms)) : pick(atoms)) + pick(separators);
      }
      const got = matchReply(reply, g);
      assert.deepEqual(got, referenceMatch(reply, ref), `seed ${seed} round ${round}: ${JSON.stringify({ reply, islands })}`);
      compared += 1;
      if (got.length > 0) lit += 1;
    }
  }
  return { compared, lit };
}

test("differential: 12,000 generated replies against generated glossaries", () => {
  let compared = 0;
  let lit = 0;
  for (const seed of [1, 2, 20261010]) {
    const result = fuzz(seed, 80, 50);
    compared += result.compared;
    lit += result.lit;
  }
  assert.equal(compared, 12000);
  assert.ok(lit > compared * 0.3, `the generated replies light something often enough to mean something (${lit} of ${compared})`);
});

test("differential: 6,000 generated replies whose words are joined by Markdown marks, en dashes and minus signs", () => {
  let compared = 0;
  let lit = 0;
  for (const seed of [3, 4, 20261011]) {
    const result = fuzz(seed, 40, 50, true);
    compared += result.compared;
    lit += result.lit;
  }
  assert.equal(compared, 6000);
  assert.ok(lit > compared * 0.3, `the generated replies light something often enough to mean something (${lit} of ${compared})`);
});

test("the differential test has teeth: a matcher that ignores case, plurals, gaps, Markdown marks or dashes would be caught", () => {
  // The reference is only worth something if a wrong matcher disagrees with it. Check the three
  // rules that most easily go wrong on a handwritten pair each.
  const ref = referenceCompile([{ id: "x", terms: ["AtS", "the pot", "spend-ahead", "Allowance to Spend"] }], new Set(REVIEWED));
  const g = compileGlossary([{ id: "x", terms: ["AtS", "the pot", "spend-ahead", "Allowance to Spend"] }]);
  for (const [reply, expected] of [
    ["ats", []],
    ["AtSs", ["x"]],
    ["THE POTS", ["x"]],
    ["spend  -  ahead", ["x"]],
    ["spend, ahead", []],
    ["allowance to spend", []],
    ["THE **POT**", ["x"]],
    ["the _pot_s", ["x"]],
    ["the. pot", []],
    ["the p**ot**", []],
    ["spend\u2013ahead", ["x"]],
    ["spend\u2212 ahead", ["x"]],
    ["spend\u2014ahead", []],
    ["**Allowance** to **Spend**", ["x"]],
  ]) {
    assert.deepEqual(referenceMatch(reply, ref), expected, `reference: ${reply}`);
    assert.deepEqual(matchReply(reply, g), expected, `matcher: ${reply}`);
  }
});
