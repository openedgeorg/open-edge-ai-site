import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ISLANDS } from "../../site/js/atlas-graph.js";
import {
  DISTINCT_WORDS,
  classifyTerm,
  compileGlossary,
  matchReply,
  normaliseReply,
} from "../../site/js/atlas-match.js";
import { deriveView, initialAtlasState, reduceAtlas } from "../../site/js/atlas-state.js";

const glossary = compileGlossary(ISLANDS);
const GRAPH_ORDER = ISLANDS.map((island) => island.id);
const inGraphOrder = (ids) => [...ids].sort((a, b) => GRAPH_ORDER.indexOf(a) - GRAPH_ORDER.indexOf(b));
const match = (text) => matchReply(text, glossary);

/** A glossary over a tiny hand-made graph, to test single terms in isolation. */
function glossaryOf(terms) {
  return compileGlossary([{ id: "x", terms }]);
}

test("the shipped graph compiles with no rejected term", () => {
  assert.deepEqual(glossary.rejected, []);
  assert.deepEqual(glossary.entries.map((entry) => entry.id), GRAPH_ORDER);
  for (const entry of glossary.entries) {
    assert.ok(entry.tests.length > 0, `${entry.id} has at least one usable term`);
    for (const t of entry.tests) {
      assert.ok(["acronym", "phrase", "word"].includes(t.kind));
      assert.ok(t.re instanceof RegExp);
      assert.equal(t.re.global, false, "no stateful regex flags");
      assert.equal(t.re.sticky, false, "no stateful regex flags");
    }
  }
});

test("DISTINCT_WORDS is exactly the plain single-word terms of the shipped graph", () => {
  const plainWords = new Set();
  for (const island of ISLANDS) {
    for (const term of island.terms) {
      if (/[\s-]/.test(term)) continue;
      const isAcronym = /^[A-Z0-9]{2,}$/.test(term) || /[A-Z]/.test(term.slice(1));
      if (!isAcronym) plainWords.add(term.toLowerCase());
    }
  }
  assert.deepEqual([...DISTINCT_WORDS].sort(), [...plainWords].sort());
  for (const word of [
    "counterparty", "fungible", "faucet", "overdraft", "collateral",
    "hoarding", "slashing", "slashed", "finality", "immutable",
    "underfunding", "bilateral", "spotify", "prepays",
  ]) {
    assert.ok(DISTINCT_WORDS.has(word), word);
  }
  // Words the graph used to list as plain terms but no longer does: they fired on unrelated talk.
  for (const word of ["epoch", "epochs", "diary", "timetable", "optimistically", "clawback", "expulsion"]) {
    assert.equal(DISTINCT_WORDS.has(word), false, word);
  }
  for (const word of DISTINCT_WORDS) assert.equal(word, word.toLowerCase());
});

test("DISTINCT_WORDS holds no common word", () => {
  for (const word of [
    "pot", "base", "debt", "fund", "plan", "bill", "freeze", "commitment", "audit", "price",
    "app", "apps", "isp", "fee", "money", "allowance", "month", "claim", "round", "key", "tag",
  ]) {
    assert.equal(DISTINCT_WORDS.has(word), false, word);
  }
});

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
    overdraft: "word",
    Overdraft: "word",
    Spotify: "word",
    prepays: "word",
    pot: "rejected",
    base: "rejected",
    debt: "rejected",
    fund: "rejected",
    plan: "rejected",
    bill: "rejected",
    freeze: "rejected",
    commitment: "rejected",
    audit: "rejected",
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

test("normaliseReply", () => {
  assert.equal(normaliseReply("It’s “the” pot’s"), "It's \"the\" pot's");
  assert.equal(normaliseReply("a b\nc\r\nd\te"), "a b c d e");
  assert.equal(normaliseReply("  a   b \n\n  c  "), "a b c");
  assert.equal(normaliseReply("spend‑ahead"), "spend-ahead");
  assert.equal(normaliseReply(""), "");
  for (const bad of [null, undefined, 7, {}, []]) assert.equal(normaliseReply(bad), "");
});

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
  assert.deepEqual(match("the HCDs"), ["hcd"]);
  assert.deepEqual(match("several HLAAs"), ["box-hlaa"]);
  assert.deepEqual(match("the RtgPs"), ["rtgp"]);
  assert.deepEqual(match("the IPtDs"), ["iptd"]);
  assert.deepEqual(match("the HEEAs"), ["heea"]);
  assert.deepEqual(match("HEIDS"), [], "an uppercase S is a different token");
  assert.deepEqual(match("HEIDx"), []);
});

test("every acronym in the graph lights its island, case-sensitively", () => {
  const cases = {
    IsHEC: "ishec",
    RtgP: "rtgp",
    CfEfA: "evidence-round",
    IPtD: "iptd",
    ConRec: "conrec",
    HSATM: "hsatm",
    HEEA: "heea",
    HCD: "hcd",
    ZK: "fup-audit",
    HLAA: "box-hlaa",
    HEID: "heid",
    AtS: "ats",
  };
  for (const [acronym, id] of Object.entries(cases)) {
    assert.deepEqual(match(`Then the ${acronym} is checked.`), [id], acronym);
    for (const wrong of [acronym.toLowerCase(), acronym.toUpperCase()]) {
      if (wrong === acronym) continue;
      assert.deepEqual(match(`Then the ${wrong} is checked.`), [], wrong);
    }
  }
});

test("HSAT does not match inside HSATM, nor the reverse", () => {
  const only = glossaryOf(["HSAT"]);
  assert.deepEqual(matchReply("the HSAT total", only), ["x"]);
  assert.deepEqual(matchReply("the HSATs", only), ["x"]);
  assert.deepEqual(matchReply("the HSATM", only), []);
  assert.deepEqual(matchReply("the HSATMs", only), []);
  // On the shipped graph both spellings land on the same island, exactly once.
  assert.deepEqual(match("the HSAT and the HSATM"), ["hsatm"]);
  assert.deepEqual(match("the HSATM"), ["hsatm"]);
  assert.deepEqual(match("the HSAT"), ["hsatm"]);
});

test("common single words never light an island alone", () => {
  for (const word of ["pot", "base", "debt", "fund", "plan", "bill", "freeze", "commitment", "audit"]) {
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
  assert.deepEqual(match("the pot"), ["the-pot"]);
  assert.deepEqual(match("The pot is spending authority, not money transferred."), ["the-pot"]);
  assert.deepEqual(match("a common fund"), ["common-fund"]);
  assert.deepEqual(match("Common Fund"), ["common-fund"]);
  assert.deepEqual(match("a monthly commitment"), ["isp-commitment"]);
  assert.deepEqual(match("one standing plan"), ["standing-plan"]);
  assert.deepEqual(match("the freeze"), ["freeze-settle"]);
  assert.deepEqual(match("your bill"), ["internet-bill"]);
  assert.deepEqual(match("the ISP bill"), ["internet-bill"]);
  assert.deepEqual(match("the pots"), ["the-pot"], "plural s on the last word");
  assert.deepEqual(match("two common funds"), ["common-fund"]);
});

test("phrases are case-insensitive and hyphen and space are interchangeable", () => {
  for (const text of [
    "spend ahead",
    "spend-ahead",
    "Spend-Ahead",
    "SPEND AHEAD",
    "spend   ahead",
    "spend\nahead",
    "spend ahead",
    "spend‑ahead",
    "spend - ahead",
  ]) {
    assert.deepEqual(match(`It is ${text} behaviour.`), ["timing-states"], JSON.stringify(text));
  }
  assert.deepEqual(match("borrow-and-default"), ["borrow-and-default"]);
  assert.deepEqual(match("Borrow and default"), ["borrow-and-default"]);
  assert.deepEqual(match("app set prices"), ["app-set-prices"]);
  assert.deepEqual(match("App-Set Prices"), ["app-set-prices"]);
  assert.deepEqual(match("off chain"), ["evidence-kept"]);
  assert.deepEqual(match("conditional top-ups"), ["base-and-topups"]);
  assert.deepEqual(match("Conditional top ups"), ["base-and-topups"]);
  assert.deepEqual(match("a top up"), [], "a bare top-up is everyday talk and lights nothing");
  assert.deepEqual(match("top-ups"), []);
  assert.deepEqual(match("spendahead"), []);
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

test("distinct words match as whole words, case-insensitively", () => {
  assert.deepEqual(match("overdraft"), ["overdraft"]);
  assert.deepEqual(match("An Overdraft."), ["overdraft"]);
  assert.deepEqual(match("the faucet"), ["fup-faucet"]);
  assert.deepEqual(match("Spotify"), ["app-set-prices"]);
  assert.deepEqual(match("like spotify does"), ["app-set-prices"]);
  assert.deepEqual(match("the counterparty"), ["isp-counterparty"]);
  assert.deepEqual(match("one fungible allowance"), ["base-and-topups"]);
  assert.deepEqual(match("each ESP epoch"), ["monthly-epochs"]);
  assert.deepEqual(match("many monthly epochs"), ["monthly-epochs"]);
  assert.deepEqual(match("each epoch"), [], "a bare epoch is in almost every ESP sentence and lights nothing");
  assert.deepEqual(match("many epochs"), []);
  assert.deepEqual(match("the epoch ID"), ["heid"]);
  assert.deepEqual(match("hoarding"), ["hoarding"]);
  assert.deepEqual(match("the collateral was slashed"), ["slashing-collateral"]);
  assert.deepEqual(match("clawback horizon"), ["finality-horizon"]);
  assert.deepEqual(match("paid in full without any clawback"), [], "a bare clawback is also freeze-and-settle talk");
  assert.deepEqual(match("bilateral"), ["fup-audit"]);
  assert.deepEqual(match("the epoch timetable"), ["epoch-timetable"]);
  assert.deepEqual(match("the timetable"), []);
  assert.deepEqual(match("an unsupported row"), ["escalation-audit"]);
  assert.deepEqual(match("expulsion"), [], "expulsion is a penalty for ISPs and apps alike");
  assert.deepEqual(match("underfunding"), ["commitment-floor"]);
  assert.deepEqual(match("It uses optimistic serving."), ["optimistic-serving"]);
  assert.deepEqual(match("I am optimistically hoping."), []);
  assert.deepEqual(match("it prepays"), ["isp-commitment"]);
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

test("a worked example: the ISP and the common fund", () => {
  const reply = "Your ISP, as your financial counterparty. You pay it under one standing plan, and apps earn through the protocol. Its monthly commitment for your household enters a common fund and funds your guaranteed base allowance.";
  const ids = match(reply);
  assert.deepEqual(
    ids,
    inGraphOrder(["isp-counterparty", "standing-plan", "common-fund", "isp-commitment", "base-and-topups"]),
  );
  const state = reduceAtlas(initialAtlasState(), { type: "reply", ids });
  assert.equal(state.replies, 1);
  const view = deriveView(state);
  assert.equal(view.visitedCount, 6);
  assert.ok(view.frontier.includes("the-pot"), "the pot is next to the commitment and the base allowance");
  // The overdraft borders the common fund, which this reply visited, so it is on the frontier
  // already. Its other neighbours (the pot, the debt, borrow-and-default) are not needed.
  assert.equal(view.status.overdraft, "frontier");
  assert.ok(view.frontier.includes("overdraft"));
  assert.equal(view.dragonsReached, false);
  const next = reduceAtlas(state, { type: "reply", ids: match("The pot is spending authority, not money.") });
  assert.deepEqual(next.visited.slice(-1), ["the-pot"]);
  const nextView = deriveView(next);
  assert.ok(nextView.frontier.includes("overdraft"));
  assert.ok(nextView.frontier.includes("isp-debt"));
  assert.equal(nextView.status["the-pot"], "visited");
});

test("a second worked example: the open list lights the dragons only when the terms appear", () => {
  assert.deepEqual(
    match("A fixed monthly plan keeps access predictable, and the ISP prepays its share."),
    inGraphOrder(["standing-plan", "isp-commitment"]),
  );
  const dragons = match("The designers list borrow-and-default and a durable second instance as open.");
  assert.ok(dragons.includes("borrow-and-default"));
  assert.ok(dragons.includes("durable-second-instance"));
  // "second instance" is also a term of the pilot operator, so that island lights too.
  assert.deepEqual(dragons, inGraphOrder(["pilot-operator", "borrow-and-default", "durable-second-instance"]));
  assert.deepEqual(match("Someone could borrow money and default on it."), []);
  assert.deepEqual(match("It needs a durable instance, not a second one."), []);
  assert.deepEqual(match("A wash app can turn an overdraft into cash."), inGraphOrder(["overdraft", "borrow-and-default"]));
  assert.deepEqual(match("Borrow and default"), ["borrow-and-default"]);
  assert.deepEqual(match("a durable second instance"), inGraphOrder(["pilot-operator", "durable-second-instance"]));
});

test("terms that were too broad no longer light an island on their own", () => {
  for (const text of [
    "the closing allowance",
    "a diary",
    "request-level amounts and timing",
    "a fabricated claim",
    "split pro rata",
    "pro-rata pool sharing",
    "a private mapping",
    "accepted prices",
    "user experience",
    "a service experience",
    "the monthly allowance",
    "the plan price",
    "dishonest refusals",
    "the FUP",
    "usage-based billing",
    "a fixed pot",
    "optimistically",
  ]) {
    assert.deepEqual(match(text), [], text);
  }
  assert.deepEqual(match("the FUP faucet"), ["fup-faucet"]);
  assert.deepEqual(match("household user experience"), ["price-feedback"]);
  assert.deepEqual(match("request-level Consumption Records"), ["conrec", "identity-layers"]);
  assert.deepEqual(match("pro-rata haircuts"), ["household-fraud"]);
  assert.deepEqual(match("the agreed plan price"), ["internet-bill"]);
  assert.deepEqual(match("a signed refusal"), ["signed-refusal"]);
});

test("matchReply returns graph order, each id once", () => {
  const text = "The ConRec, then the AtS, then the pot, then the common fund, then the ConRec and the AtS again. Spend ahead, spend-ahead.";
  const ids = match(text);
  assert.deepEqual(ids, inGraphOrder(ids));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, inGraphOrder(["conrec", "ats", "the-pot", "common-fund", "timing-states"]));
  assert.deepEqual(match(text), ids, "repeated calls give the same answer");
  assert.deepEqual(match(text), ids);
});

test("matchReply is safe on odd input", () => {
  for (const bad of [null, undefined, 42, {}, [], "", "   ", "\n\n"]) assert.deepEqual(match(bad), []);
  for (const badGlossary of [null, undefined, {}, { entries: null }, { entries: [] }, "x"]) {
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
  const entryA = compiled.entries[0];
  assert.deepEqual(entryA.tests.map((t) => [t.term, t.kind]), [
    ["the pot", "phrase"],
    ["AtS", "acronym"],
    ["overdraft", "word"],
  ]);
  assert.deepEqual(compiled.entries[1].tests, []);
  assert.deepEqual(compiled.entries[3].tests.map((t) => t.term), ["AtS", "the pot"], "duplicates are dropped");
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

test("the graph's terms cannot be matched by a plain reply that merely uses common words", () => {
  const plain = [
    "The base of the plan is a bill that you pay each month, and the debt, the fund and the audit are separate. Freeze the commitment.",
    "A pot of tea, a base camp, a debt of gratitude, a fund raiser, a plan B, the bill, an audit trail, a freeze frame, a commitment to quality.",
  ];
  for (const text of plain) assert.deepEqual(match(text), [], text);
});

test("regex special characters in a term are matched literally", () => {
  const odd = glossaryOf(["C++ rules", "a.b c", "IsHEC(1)"]);
  assert.deepEqual(matchReply("C++ rules", odd), ["x"]);
  assert.deepEqual(matchReply("a.b c", odd), ["x"]);
  assert.deepEqual(matchReply("IsHEC(1)", odd), ["x"]);
  assert.deepEqual(matchReply("C rules", odd), []);
  assert.deepEqual(matchReply("axb c", odd), []);
});

test("performance: 60 islands against a 5 KB reply", () => {
  assert.equal(ISLANDS.length, 60);
  const sentence = "The ISP prepays a monthly commitment into the common fund, so the household box can check the ConRec against the AtS and the IsHEC while the pot stays solvent; an overdraft is not debt until use. ";
  const reply = sentence.repeat(Math.ceil(5120 / sentence.length)).slice(0, 5120);
  assert.equal(reply.length, 5120);
  const compileStart = performance.now();
  const fresh = compileGlossary(ISLANDS);
  const compileMs = performance.now() - compileStart;
  const start = performance.now();
  const ids = matchReply(reply, fresh);
  const ms = performance.now() - start;
  assert.ok(ids.length >= 5);
  assert.ok(ms < 200, `matchReply took ${ms.toFixed(1)} ms`);
  assert.ok(compileMs < 200, `compileGlossary took ${compileMs.toFixed(1)} ms`);
});

test("performance: separator-heavy input does not blow up", () => {
  const hostile = [
    "the ".repeat(1300),
    "spend - ".repeat(650),
    "- ".repeat(2600),
    " ".repeat(5000),
    "AtS".repeat(1700),
    "common fund ".repeat(430),
  ];
  const start = performance.now();
  for (const text of hostile) match(text);
  const ms = performance.now() - start;
  assert.ok(ms < 200, `hostile inputs took ${ms.toFixed(1)} ms`);
});

test("the matcher touches no browser storage or DOM", () => {
  const source = readFileSync(new URL("../../site/js/atlas-match.js", import.meta.url), "utf8");
  for (const forbidden of ["localStorage", "sessionStorage", "document", "innerHTML", "eval(", "fetch("]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
