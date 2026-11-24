/**
 * Does the matcher read real answers the way a visitor would? (F07)
 *
 * Fixtures are in tests/fixtures/atlas_answers/:
 * - real-answers.json: the assistant answers captured from the live application on 10 October 2026,
 *   with the reviewed set of places each one lights and the words that justify every place.
 * - real-history.json: the history payloads those answers came from (and two histories of requests that
 *   never got an answer), plus the bodies of the failed requests.
 * - concept-answers.json: for every concept of the shipped graph, answer fragments in the style of the
 *   captured answers that must light it, and look-alike fragments that must not.
 *
 * What is the matcher's job and what is not. The matcher is a pure function from one finished text to a list
 * of places. WHICH text it is given is decided by the conversation bridge (site/js/atlas-chat.js): only the
 * final assistant rows of the turn that was asked, never the visitor's question, a draft, an error or an
 * answer already delivered. That is tested with the bridge. Here the same rule is stated as a small model of
 * the page (answersOf below) and the properties that follow from it are checked on the real captures: the
 * texts that must never add progress add none, the same finished answer lights the same places however it
 * arrives, and a revisit or a replay never raises the count of unique places.
 *
 * The expectations are exact on purpose. When a term is added and a fixture starts lighting one more place,
 * this file fails and says which: read the answer, then either fix the term or update the fixture with the
 * reason.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { EDGES, FIRST_SUGGESTION, ISLANDS, OPEN_LABEL, START_ID } from "../../site/js/atlas-graph.js";
import { classifyTerm, compileGlossary, matchReply, normaliseReply } from "../../site/js/atlas-match.js";
import { deriveView, initialAtlasState, persistAtlas, reduceAtlas, restoreAtlas } from "../../site/js/atlas-state.js";
import { seededRandom } from "./atlas_match_reference.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/atlas_answers/${name}`, import.meta.url), "utf8"));
const REAL = fixture("real-answers.json");
const HISTORY = fixture("real-history.json");
const CONCEPTS = fixture("concept-answers.json").concepts;

const glossary = compileGlossary(ISLANDS);
const lit = (text) => matchReply(text, glossary);
const GRAPH_IDS = ISLANDS.map((island) => island.id);
const byId = new Map(ISLANDS.map((island) => [island.id, island]));
const inGraphOrder = (ids) => [...ids].sort((a, b) => GRAPH_IDS.indexOf(a) - GRAPH_IDS.indexOf(b));

const session = (id) => REAL.sessions.find((candidate) => candidate.id === id);
const answers = (id) => session(id).turns.filter((turn) => turn.role === "assistant");
const allAnswers = REAL.sessions.flatMap((candidate) => candidate.turns.filter((turn) => turn.role === "assistant"));

/** What the page does with a finished answer (applyReply in site/js/atlas.js): match it, add the places. */
function applyReply(state, text, index) {
  return reduceAtlas(state, { type: "reply", ids: lit(text) }, index);
}
const visitedAfter = (texts, from = initialAtlasState()) => texts.reduce((state, text) => applyReply(state, text), from);

/** The rows of a history that are answers: an assistant item that is final (the contract of the bridge). */
const answersOf = (history) => history.items.filter((item) => item.role === "assistant" && item.provisional === false).map((item) => item.text);

// ---------------------------------------------------------------- the fixtures themselves

test("the fixtures are what they say: the captured answers equal the captured history, character for character", () => {
  for (const [id, key] of [["desktop-xai", "desktop-xai"], ["mobile-xai", "mobile-xai"]]) {
    assert.deepEqual(answers(id).map((turn) => turn.text), answersOf(HISTORY.histories[key]), id);
  }
  // 3 + 3 answers were captured; the other 9 user turns got none (or were interrupted), and nothing else was made up.
  assert.equal(allAnswers.length, 6);
  const users = REAL.sessions.flatMap((candidate) => candidate.turns.filter((turn) => turn.role === "user"));
  assert.equal(users.length, 15);
  // The paragraph breaks and the Markdown of the capture are still there: this is the real format.
  assert.ok(allAnswers.every((turn) => /\n\n/.test(turn.text) || turn.text.length < 60), "answers keep their paragraph breaks");
  assert.ok(allAnswers.some((turn) => /\n- /.test(turn.text)), "a captured answer has a bullet list");
  assert.ok(allAnswers.some((turn) => /`[A-Z](?: - [A-Z])?`/.test(turn.text)), "a captured answer has backticked symbols");
  assert.ok(allAnswers.some((turn) => turn.text.includes("’")) && allAnswers.some((turn) => /\w'\w/.test(turn.text)), "both apostrophe forms occur");
});

test("every concept of the shipped graph has a fixture: at least one positive and one negative, and nothing else", () => {
  assert.deepEqual(Object.keys(CONCEPTS).sort(), [...GRAPH_IDS].sort(), "a concept added to or removed from the graph needs its fixture");
  for (const island of ISLANDS) {
    const entry = CONCEPTS[island.id];
    assert.ok(entry.positive.length >= 1, `${island.id} has a positive example`);
    assert.ok(entry.negative.length >= 1, `${island.id} has a negative example`);
    for (const example of [...entry.positive, ...entry.negative]) {
      assert.equal(typeof example.text, "string");
      assert.ok(example.text.trim().length > 20, `${island.id}: a real fragment, not a keyword`);
      assert.ok(Array.isArray(example.lights));
    }
  }
});

test("the positive examples are written in answer style: none is the island's own teaser or name, and none is a bare term", () => {
  const squash = (text) => normaliseReply(text).toLowerCase();
  for (const island of ISLANDS) {
    const terms = new Set(island.terms.map(squash));
    for (const { text } of CONCEPTS[island.id].positive) {
      assert.equal(squash(text).includes(squash(island.teaser)), false, `${island.id}: copies its teaser`);
      assert.notEqual(squash(text), squash(island.name), `${island.id}: is its name`);
      assert.equal(terms.has(squash(text)), false, `${island.id}: is just a term`);
      assert.ok(text.split(/\s+/).length >= 6, `${island.id}: too short to be an answer: ${text}`);
    }
  }
});

// ---------------------------------------------------------------- every concept: positives light it, negatives do not

test("every positive example lights its concept, and exactly the places the reviewed fixture lists", () => {
  for (const island of ISLANDS) {
    for (const { text, lights } of CONCEPTS[island.id].positive) {
      const got = lit(text);
      assert.ok(got.includes(island.id), `${island.id} is not lit by: ${text}\n  lit: ${got.join(", ")}`);
      assert.deepEqual(got, lights, `${island.id}: the places lit by this fragment changed: ${text}`);
    }
  }
});

test("every negative example leaves its concept dark, and lights exactly the places the reviewed fixture lists", () => {
  for (const island of ISLANDS) {
    for (const { text, lights } of CONCEPTS[island.id].negative) {
      const got = lit(text);
      assert.equal(got.includes(island.id), false, `${island.id} is lit by a look-alike: ${text}`);
      assert.deepEqual(got, lights, `${island.id}: the places lit by this fragment changed: ${text}`);
    }
  }
});

test("the positive examples of the 65 concepts, one after the other, reach 65 of 65, and reading them all again changes nothing", () => {
  let state = initialAtlasState();
  const seenCounts = [];
  for (const island of ISLANDS) {
    state = applyReply(state, CONCEPTS[island.id].positive[0].text);
    seenCounts.push(deriveView(state).visitedCount);
  }
  const view = deriveView(state);
  assert.equal(view.visitedCount, ISLANDS.length);
  assert.deepEqual(inGraphOrder(state.visited), GRAPH_IDS);
  assert.ok(seenCounts.every((count, at) => at === 0 || count >= seenCounts[at - 1]), "the count never goes down");
  for (const id of GRAPH_IDS) assert.equal(view.status[id], "visited", id);
  // Every concept is a real answer away: it is lit by wording a faithful answer uses, with no hidden id.
  const again = visitedAfter(ISLANDS.map((island) => CONCEPTS[island.id].positive[0].text), state);
  assert.equal(deriveView(again).visitedCount, ISLANDS.length);
  assert.equal(again.visited.length, state.visited.length);
});

test("a positive example lights the same places however it is dressed: bullet, bold, paragraphs, CRLF, curly quotes, a leading blank line", () => {
  const dress = [
    (text) => `- ${text}`,
    (text) => `**${text}**`,
    (text) => text.replace(/\. /g, ".\n\n"),
    (text) => text.replace(/\n/g, "\r\n"),
    (text) => `\n\n  ${text}  \n`,
    (text) => text.replace(/'/g, "’"),
    (text) => text.replace(/'/g, "’").replace(/ - /g, " – "),
    (text) => `> ${text}`,
    (text) => text.replace(/([,;:]) /g, "$1  "),
  ];
  let checked = 0;
  for (const island of ISLANDS) {
    for (const { text, lights } of CONCEPTS[island.id].positive) {
      for (const [at, f] of dress.entries()) {
        assert.deepEqual(lit(f(text)), lights, `${island.id} dressed #${at}: ${f(text)}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 1000, `${checked} dressed fragments checked`);
});

test("a positive example does not depend on its capital letters: the same sentence in lower case lights the same places, unless it relies on an acronym or a written-out expansion", () => {
  let same = 0;
  let relies = 0;
  for (const island of ISLANDS) {
    for (const { text, lights } of CONCEPTS[island.id].positive) {
      const lower = lit(text.toLowerCase());
      if (JSON.stringify(lower) === JSON.stringify(lights)) same += 1;
      else {
        relies += 1;
        // The only places that may go dark are the ones lit by a case-sensitive term (an acronym, or a phrase that starts with a capital).
        const caseSensitive = new Set(
          ISLANDS.filter((candidate) =>
            candidate.terms.some((term) => classifyTerm(term) === "acronym" || /^\p{Lu}/u.test(normaliseReply(term))),
          ).map((candidate) => candidate.id),
        );
        for (const id of lights.filter((entry) => !lower.includes(entry))) assert.ok(caseSensitive.has(id), `${island.id}: ${id} only goes dark for a reason other than case: ${text}`);
      }
    }
  }
  assert.ok(same > relies, `${same} fragments are case-blind, ${relies} rely on a capital`);
});

// ---------------------------------------------------------------- F07: the captured answers

test("the first mobile answer lights 'One standing plan' and 'Apps set their own prices' (the F07 evidence), and what it lit before", () => {
  const first = answers("mobile-xai")[0].text;
  assert.ok(first.includes("one standing monthly plan"));
  assert.ok(first.includes("Each app sets its own prices"));
  const got = lit(first);
  assert.ok(got.includes("standing-plan"), "one standing monthly plan");
  assert.ok(got.includes("app-set-prices"), "Each app sets its own prices");
  // The three places the answer lit before the fix are still lit: the common fund, the ISP commitment and household fraud.
  for (const id of ["common-fund", "isp-commitment", "household-fraud"]) assert.ok(got.includes(id), id);
  // Each phrase does it on its own, in any dress.
  for (const phrase of ["one standing monthly plan", "one **standing monthly plan**", "ONE STANDING MONTHLY PLANS", "a standing, monthly plan"]) {
    assert.deepEqual(lit(phrase), phrase === "a standing, monthly plan" ? [] : ["standing-plan"], phrase);
  }
  // In its sentence it also says whom you pay, which is another place.
  assert.deepEqual(lit("You pay your ISP under one standing monthly plan."), ["isp-counterparty", "standing-plan"]);
  for (const phrase of ["Each app sets its own prices", "each app sets its own prices.", "**Each app** sets its own prices", "an app sets its own price"]) {
    assert.deepEqual(lit(phrase), ["app-set-prices"], phrase);
  }
  assert.deepEqual(got, ["isp-counterparty", "app-set-prices", "internet-bill", "standing-plan", "common-fund", "isp-commitment", "isp-debt", "hcd", "household-fraud"]);
});

test("every captured answer lights exactly the reviewed places, and every place is justified by words of the answer", () => {
  for (const candidate of REAL.sessions) {
    for (const turn of candidate.turns.filter((entry) => entry.role === "assistant")) {
      const got = lit(turn.text);
      assert.deepEqual(got, turn.lights, `${candidate.id}: ${turn.text.slice(0, 50)}`);
      assert.deepEqual(Object.keys(turn.evidence), turn.lights, "an evidence phrase for every place, in graph order");
      for (const [id, phrase] of Object.entries(turn.evidence)) {
        assert.ok(turn.text.includes(phrase), `${id}: "${phrase}" is not in the answer`);
        // The phrase alone is enough: a place is never lit by something the phrase does not contain.
        assert.ok(lit(phrase).includes(id), `${id} is not lit by its own evidence "${phrase}"`);
      }
      for (const id of turn.stayDark) {
        assert.ok(byId.has(id), id);
        assert.equal(got.includes(id), false, `${id} is lit by everyday words of: ${turn.text.slice(0, 50)}`);
      }
    }
  }
});

test("no captured answer lights a place by generic talk: every lit place has a term that is itself a fixed phrase, an acronym or a reviewed word", () => {
  // False-positive scan. For every answer and every lit place, find the terms that matched and make sure at least one
  // is specific (two or more words, an acronym, or a reviewed word), never one of the bare common words.
  const common = new Set(["pot", "base", "debt", "fund", "plan", "bill", "freeze", "commitment", "audit", "price", "allowance", "app", "apps", "money", "month", "claim", "epoch"]);
  for (const turn of allAnswers) {
    for (const id of lit(turn.text)) {
      const island = byId.get(id);
      const hits = island.terms.filter((term) => compileGlossary([{ id, terms: [term] }]).entries[0].tests.length > 0 && matchReply(turn.text, compileGlossary([{ id, terms: [term] }])).length > 0);
      assert.ok(hits.length >= 1, `${id}: no term found`);
      for (const term of hits) assert.equal(common.has(normaliseReply(term).toLowerCase()), false, `${id} lit by the bare word ${term}`);
    }
  }
});

test("the visitor's questions are not answers: the matcher is blind to who wrote a text, so the page must only ever hand it assistant rows", () => {
  // The real questions. Most light nothing, but three name their own place (the pot twice, the fixed monthly plan once): if
  // one were ever handed to the matcher it WOULD light that place. That is why delivery (the bridge) excludes the question,
  // and why this file never feeds one in.
  const questions = REAL.sessions.flatMap((candidate) => candidate.turns.filter((turn) => turn.role === "user").map((turn) => turn.text));
  const lighting = [...new Set(questions.filter((question) => lit(question).length > 0))];
  assert.deepEqual(lighting.sort(), [
    "Can the pot be bigger than what the ISP committed?",
    "What does a fixed monthly plan give me that separate purchases would not?",
    "What is the pot an ISP gets each month?",
  ].sort());
  assert.deepEqual(lit(FIRST_SUGGESTION), [], "the opening suggestion lights nothing by itself");
  // Every teaser the Atlas offers is a question; most name their own place. Only the answer may light it.
  assert.ok(ISLANDS.filter((island) => lit(island.teaser).length > 0).length >= 10);
});

test("what must never add progress adds none: empty and odd input, unsent drafts, failed-request bodies, the client's own messages", () => {
  for (const text of [undefined, null, 0, {}, [], "", " ", "\n\n", "\t", "¶", "…"]) assert.deepEqual(lit(text), [], JSON.stringify(text));
  // Unsent drafts.
  for (const draft of REAL.unsentDrafts) assert.deepEqual(lit(draft.text), [], draft.label);
  // The body of the 409 'submission_unconfirmed' answer and the status lookup that followed it, as text.
  const message = HISTORY.errors["message-409"].body.error.message;
  assert.equal(message, "Your message may have been received. Check its status before sending it again.");
  assert.deepEqual(lit(message), []);
  assert.deepEqual(lit(JSON.stringify(HISTORY.errors)), [], "even the raw JSON of the failed request");
  assert.deepEqual(lit(JSON.stringify(HISTORY.histories["user-only-unknown"].status)), []);
  // The notes of the capture ('no answer observed') are not answers either.
  for (const turn of REAL.sessions.flatMap((candidate) => candidate.turns).filter((entry) => entry.role === "note")) assert.deepEqual(lit(turn.text), [], turn.text);
  // A state that has seen only these is the state it started in, and the counter stays at the start marker.
  let state = initialAtlasState();
  state = reduceAtlas(state, { type: "reply", ids: [] });
  assert.deepEqual(state.visited, [START_ID]);
  assert.equal(deriveView(state).visitedCount, 1);
});

test("the client's own messages cannot light a place: no text it can show about a failure, a wait or a retry contains a term", () => {
  // Every script of the page except the two that hold the terms themselves (the graph) and their documentation (the matcher).
  const dir = new URL("../../site/js/", import.meta.url);
  const names = readdirSync(dir).filter((name) => name.endsWith(".js") && !["atlas-graph.js", "atlas-match.js"].includes(name));
  assert.ok(["app.js", "api.js", "state.js", "atlas-chat.js"].every((name) => names.includes(name)));
  let checked = 0;
  for (const name of names) {
    const source = readFileSync(new URL(name, dir), "utf8");
    // Every string literal of 12 characters or more: the messages, labels and notices a visitor can read.
    for (const found of source.matchAll(/"((?:[^"\\\n]|\\.){12,})"|`((?:[^`\\]|\\.){12,})`/g)) {
      const text = (found[1] ?? found[2]).replace(/\\n/g, "\n").replace(/\\(["'`\\])/g, "$1");
      assert.deepEqual(lit(text), [], `${name}: "${text}" lights a place`);
      checked += 1;
    }
  }
  assert.ok(checked > 200, `${checked} client strings checked`);
});

test("a history of a request that never got an answer adds nothing; a pending new turn behind old answers adds nothing new", () => {
  for (const key of ["user-only-unknown", "user-only-running"]) {
    const history = HISTORY.histories[key];
    assert.deepEqual(answersOf(history), [], key);
    // Even if the page looked at the visitor's rows, it would be reading questions: none of these two lights a place.
    for (const item of history.items) assert.deepEqual(lit(item.text), [], key);
    const state = visitedAfter(answersOf(history));
    assert.deepEqual(state.visited, [START_ID], key);
    assert.equal(state.replies, 0, "no reply was scanned");
  }
  // The mobile capture ends with a fourth question that has no answer yet: the three old answers are all it holds.
  const mobile = HISTORY.histories["mobile-xai"];
  assert.equal(mobile.items.at(-1).role, "user");
  assert.equal(answersOf(mobile).length, 3);
  const before = visitedAfter(answersOf(mobile));
  const afterPoll = visitedAfter(answersOf(mobile), before); // a poll of /history that returns the same three answers
  assert.equal(deriveView(afterPoll).visitedCount, deriveView(before).visitedCount);
  assert.deepEqual(afterPoll.visited, before.visited);
});

// ---------------------------------------------------------------- the same finished answer, however it arrives

test("a finished answer lights the same places however it was delivered: one piece, many stream deltas, history rows, CRLF, padding", () => {
  const rnd = seededRandom(20261011);
  for (const turn of allAnswers) {
    const expected = turn.lights;
    assert.deepEqual(lit(turn.text), expected, "as one piece");
    // A stream: the deltas are cut anywhere (mid-word, mid-phrase, mid-Markdown) and concatenated back.
    for (let run = 0; run < 25; run += 1) {
      const cuts = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => Math.floor(rnd() * turn.text.length)))].sort((a, b) => a - b);
      const deltas = [];
      let last = 0;
      for (const cut of cuts) {
        deltas.push(turn.text.slice(last, cut));
        last = cut;
      }
      deltas.push(turn.text.slice(last));
      assert.equal(deltas.join(""), turn.text);
      assert.deepEqual(lit(deltas.join("")), expected, `stream of ${deltas.length} deltas`);
    }
    // History recovery: the same text as one row, or as one row per paragraph (the adapter starts a new item when the
    // message id changes) joined by a blank line, which is what the bridge hands over.
    const rows = turn.text.split(/\n\n/);
    assert.deepEqual(lit(rows.join("\n\n")), expected, "rows joined by a blank line");
    assert.deepEqual(lit(rows.map((row) => row.trim()).join("\n\n")), expected, "trimmed rows");
    // Transport differences.
    assert.deepEqual(lit(turn.text.replace(/\n/g, "\r\n")), expected, "CRLF");
    assert.deepEqual(lit(`${turn.text}\n`), expected, "trailing newline");
    assert.deepEqual(lit(`\n\n${turn.text}   `), expected, "leading and trailing white space");
    assert.deepEqual(lit(turn.text.replace(/’/g, "'")), expected, "straight apostrophes");
    assert.deepEqual(lit(turn.text.replace(/'/g, "’")), expected, "curly apostrophes");
    assert.deepEqual(lit(turn.text.normalize("NFD")), expected, "decomposed Unicode");
  }
});

test("one turn that the history holds as several assistant rows lights what the same turn as one row lights", () => {
  // The xAI adapter starts a new history item whenever the message id changes, so a turn can be [preamble, answer].
  // The bridge hands the matcher the rows joined by a blank line; each row is a paragraph.
  for (const turn of allAnswers) {
    const paragraphs = turn.text.split(/\n\n/);
    if (paragraphs.length < 2) continue;
    for (let cut = 1; cut < paragraphs.length; cut += 1) {
      const first = paragraphs.slice(0, cut).join("\n\n");
      const second = paragraphs.slice(cut).join("\n\n");
      const joined = lit([first, second].join("\n\n"));
      assert.deepEqual(joined, turn.lights, "joined rows");
      // Read row by row the same places are reached (a phrase never spans two rows, so nothing is gained or lost).
      const separately = visitedAfter([first, second]);
      assert.deepEqual(inGraphOrder(separately.visited.filter((id) => id !== START_ID)), turn.lights.filter((id) => id !== START_ID), "row by row");
    }
  }
  // A phrase cut by a row boundary does not light: that is the rule, and it is the same for one row with a blank line in it.
  assert.deepEqual(lit(["It is about the", "pot of the ISP."].join("\n\n")), []);
  assert.deepEqual(lit("It is about the\n\npot of the ISP."), []);
  assert.deepEqual(lit(["It is about the pot", "of the ISP."].join("\n\n")), ["the-pot"]);
});

test("but a partial answer can light what the final one does not: only the finished text may be matched", () => {
  // 'the pot' on its way to 'the potential': this is why the page matches the final assistant text once and never a
  // stream in progress.
  assert.deepEqual(lit("It is about the pot"), ["the-pot"]);
  assert.deepEqual(lit("It is about the potential of the design."), []);
  assert.deepEqual(lit("The ISP's"), []);
  assert.deepEqual(lit("The ISP's debt"), ["isp-debt"]);
  assert.deepEqual(lit("Debt-service payments"), ["debt-update"]);
});

test("the captured sessions give the same unique places whether the answers come one by one (stream) or all at once (history), and in any order", () => {
  for (const key of ["desktop-xai", "mobile-xai"]) {
    const texts = answers(key).map((turn) => turn.text);
    const streamed = visitedAfter(texts);
    const recovered = visitedAfter(answersOf(HISTORY.histories[key]));
    assert.deepEqual(recovered.visited, streamed.visited, `${key}: history recovery`);
    assert.equal(recovered.replies, 3);
    const expected = inGraphOrder([...new Set(answers(key).flatMap((turn) => turn.lights))]);
    assert.deepEqual(inGraphOrder(streamed.visited), expected, `${key}: the union of the answers, plus the start`);
    // The order of the answers changes the order places were reached in, never which ones.
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]]) {
      const shuffled = visitedAfter(order.map((at) => texts[at]));
      assert.deepEqual(inGraphOrder(shuffled.visited), expected, `${key} ${order.join("")}`);
      assert.equal(shuffled.visited.length, streamed.visited.length);
    }
  }
});

test("replaying or revisiting never raises the count of unique places, and never counts one twice", () => {
  const texts = answers("mobile-xai").map((turn) => turn.text);
  let state = visitedAfter(texts);
  const unique = new Set(state.visited).size;
  assert.equal(unique, state.visited.length, "no place twice");
  const count = deriveView(state).visitedCount;
  assert.equal(count, unique);
  // A refresh restores the same history: three more scans, no new place.
  for (let round = 0; round < 3; round += 1) {
    state = visitedAfter(texts, state);
    assert.equal(deriveView(state).visitedCount, count, `replay ${round + 1}`);
    assert.equal(new Set(state.visited).size, state.visited.length);
  }
  assert.equal(state.replies, 3 * 4, "the number of scanned replies is not the number of places");
  // The same answer asked again (an identical canned answer) is a revisit.
  const again = visitedAfter([texts[1], texts[1], texts[1]], state);
  assert.equal(deriveView(again).visitedCount, count);
  // An answer that lights only places already visited changes nothing but the reply counter.
  const before = [...state.visited];
  const quiet = applyReply(state, "The pot is spending authority, not money handed to the ISP.");
  assert.deepEqual(quiet.visited, before);
  // Saved and restored through sessionStorage: the same places, once each.
  const store = new Map();
  const storage = { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)) };
  persistAtlas(storage, state);
  const restored = restoreAtlas(storage);
  assert.deepEqual(restored.visited, state.visited);
  assert.equal(deriveView(restored).visitedCount, count);
});

// ---------------------------------------------------------------- status is orthogonal to visited

test("a visited open or contested place stays open or contested: visiting never settles anything", () => {
  const open = ISLANDS.filter((island) => island.status === "open");
  const contested = ISLANDS.filter((island) => island.status === "contested");
  assert.ok(open.length >= 10 && contested.length >= 1);
  const graphBefore = JSON.stringify({ ISLANDS, EDGES });
  let state = initialAtlasState();
  for (const island of [...contested, ...open]) state = applyReply(state, CONCEPTS[island.id].positive[0].text);
  const view = deriveView(state);
  for (const island of [...contested, ...open]) {
    assert.equal(view.status[island.id], "visited", `${island.id} is visited`);
    assert.equal(byId.get(island.id).status, island.status, `${island.id} is still ${island.status}`);
    assert.equal(byId.get(island.id).label, island.label, `${island.id} keeps its label`);
  }
  for (const island of open) assert.equal(byId.get(island.id).label, OPEN_LABEL, island.id);
  assert.equal(view.dragonsReached, true);
  // Matching and reducing never touch the graph, and the state has no place for a 'resolved' mark.
  assert.equal(JSON.stringify({ ISLANDS, EDGES }), graphBefore);
  assert.deepEqual(Object.keys(state).sort(), ["replies", "visited"]);
  assert.deepEqual(new Set(Object.values(view.status)), new Set(["visited", "frontier", "fogged"]));
  // A dragon lit by an answer that DESCRIBES it as unresolved is lit; a settled neighbour lit by the same words does not turn it settled.
  const settled = lit(CONCEPTS["epoch-opening"].positive[0].text);
  assert.ok(settled.includes("epoch-opening") && !settled.includes("epoch-opening-handoff"), "explaining the settled order does not reach the open handoff");
  const unresolved = lit(CONCEPTS["epoch-opening-handoff"].positive[0].text);
  assert.ok(unresolved.includes("epoch-opening-handoff"));
});

test("every open place is lit only by words that say it, never by the settled concept next to it", () => {
  // For each dragon: the settled neighbours' positive examples must not light it. (A dragon is reached by describing what is
  // unresolved; a plain explanation of the settled mechanism is not a mention of the open question.)
  const neighbours = new Map();
  for (const edge of EDGES) {
    for (const [a, b] of [[edge.a, edge.b], [edge.b, edge.a]]) {
      if (!neighbours.has(a)) neighbours.set(a, new Set());
      neighbours.get(a).add(b);
    }
  }
  const leaks = [];
  for (const island of ISLANDS.filter((candidate) => candidate.status === "open")) {
    for (const neighbour of neighbours.get(island.id) ?? []) {
      if (byId.get(neighbour).status === "open") continue;
      for (const { text } of CONCEPTS[neighbour].positive) {
        if (lit(text).includes(island.id)) leaks.push(`${neighbour} -> ${island.id}: ${text}`);
      }
    }
  }
  assert.deepEqual(leaks, []);
});

// ---------------------------------------------------------------- acronyms and everyday words

test("an acronym is never formed across a formatting boundary: split letters, marks, paragraphs and list items do not spell a term", () => {
  const acronymTerms = ISLANDS.flatMap((island) => island.terms.filter((term) => classifyTerm(term) === "acronym").map((term) => ({ id: island.id, term })));
  assert.ok(acronymTerms.length >= 12);
  const glues = [" ", "\n\n", "\n- ", "\n1. ", "\n# ", "**", "** **", "_", "`", " - ", ".", ", ", "\n"];
  let checked = 0;
  for (const { id, term } of acronymTerms) {
    for (let cut = 1; cut < term.length; cut += 1) {
      const left = term.slice(0, cut);
      const right = term.slice(cut);
      for (const glue of glues) {
        const text = `see ${left}${glue}${right} here`;
        const got = lit(text);
        // A half that is itself a term of the island (HSAT in HSATM) lights it legitimately.
        const halfIsTerm = [left, right].some((half) => byId.get(id).terms.includes(half));
        if (!halfIsTerm) assert.equal(got.includes(id), false, `${id}: ${JSON.stringify(text)} spells ${term}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 500, `${checked} splits checked`);
  // And the whole acronym in the same dress does light it.
  for (const { id, term } of acronymTerms) {
    for (const text of [`**${term}**`, `\`${term}\``, `- ${term}\n- other`, `${term}s`, `(${term})`]) assert.ok(lit(text).includes(id), `${id}: ${text}`);
  }
});

test("rows joined into an answer never spell an acronym either: a row that ends in 'HEI' and a row that starts with 'D' are two paragraphs", () => {
  assert.equal(lit("The key is called the HEI\n\nD for short").includes("heid"), false);
  assert.equal(lit("an A\n\ntS entry").includes("ats"), false);
  assert.equal(lit("the Z\n- K proof").includes("audit-design"), false);
  assert.equal(lit("the HEID\n\nis fresh").includes("heid"), true);
});

test("everyday uses of the words behind the places light nothing: price, plan, pot, fund, debt, bill, audit, epoch, claim, identity", () => {
  const everyday = [
    "The price depends on the plan, and the plan depends on your provider.",
    "Every plan has a price, every bill has a due date, and every audit has a scope.",
    "A fund is a pool of money, and a pot is one part of it.",
    "The debt, the base, the claim, the round, the tag, the key and the epoch are all ordinary words.",
    "She kept a pot of tea, a fund for rainy days, a plan for the weekend and a diary of the trip.",
    "The identity of the author is known; the layers are many; the credential is a password.",
    "A catalogue of prices, a list of claims, a round of audits and a freeze on hiring.",
    "Settlement of the argument was reached after an emergency meeting about the household chores.",
    "Mechanical engineers resolve disputes with arithmetic, and the third party decides.",
    "The household routes to work vary, and the app routes traffic through its own server.",
    "He asked for more time, and the answer was a firm no; her refusal was polite.",
    "The app charges a fee. Prices went up; plans changed.",
  ];
  for (const text of everyday) assert.deepEqual(lit(text), [], text);
});

test("common words next to a real term do not widen it: only the term lights its place", () => {
  assert.deepEqual(lit("The plan price is shown. The agreed plan price is not changed."), ["internet-bill"]);
  assert.deepEqual(lit("It is the price of the plan, a fixed price."), []);
  assert.deepEqual(lit("The pot of tea went cold; the ISP's pot did not."), ["the-pot"]);
  assert.deepEqual(lit("The fund is large. The common fund is liquid."), ["common-fund"]);
  assert.deepEqual(lit("Her plan is to build a standing desk."), []);
  assert.deepEqual(lit("The household has a standing plan with its ISP."), ["standing-plan"]);
});

test("the answer to a place's own question lights that place (live capture of the final client: signed-refusal)", () => {
  // Found in the live journey of 11 October 2026: the page asked the teaser of "A refusal leaves signed evidence" and the answer
  // explained exactly that (a refusal is a signed allowance message, the household's evidence) but lit only "dishonest-isp",
  // so a typed follow-up was needed. The answer and the follow-up's answer are kept as captured; each lights the reviewed set.
  const { turns } = fixture("live-final-answers.json");
  const signedRefusal = byId.get("signed-refusal");
  assert.equal(turns[0].text, signedRefusal.teaser, "the captured question is the place's own teaser");
  for (const turn of turns.filter((candidate) => candidate.role === "assistant")) {
    assert.deepEqual(lit(turn.text), turn.lights);
    assert.ok(turn.lights.includes("signed-refusal"), "the place the question was about is lit");
    assert.deepEqual(Object.keys(turn.evidence), turn.lights, "an evidence phrase for every place, in graph order");
    for (const [id, phrase] of Object.entries(turn.evidence)) {
      assert.ok(turn.text.includes(phrase), `${id}: "${phrase}" is not in the answer`);
      assert.ok(lit(phrase).includes(id), `${id} is not lit by its own evidence "${phrase}"`);
    }
  }
});

test("the live assistant's answer to the question a place offers lights that place: 244 answers from four sweeps of all 65 places", () => {
  // tests/live/atlas_teaser_sweep.mjs asks every place's teaser of the live assistant. The model words an answer differently
  // every time, and a place that is not lit by the answer to its own question costs the visitor a typed follow-up. These are
  // the finished answers of four sweeps (the first two tuned the terms, the last two were asked with the terms frozen), kept as captured.
  const { answers } = fixture("live-teaser-sweeps.json");
  assert.ok(answers.length >= 240);
  assert.equal(new Set(answers.map((entry) => entry.id)).size, ISLANDS.length, "every place was asked in a sweep");
  const missed = answers.filter((entry) => !lit(entry.answer).includes(entry.id)).map((entry) => `${entry.id} (sweep ${entry.sweep})`);
  assert.deepEqual(missed, [], "each answer lights the place it was asked about");
  for (const entry of answers) assert.equal(entry.question, byId.get(entry.id).teaser, `${entry.id}: the question is the place's teaser`);
});
