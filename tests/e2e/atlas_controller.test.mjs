/**
 * Unit tests for the small pure parts of the Atlas controller (site/js/atlas.js). The controller
 * itself needs a real DOM and is driven in Chrome by tests/e2e/atlas_browser.test.mjs.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ANNOUNCE_NAMES,
  ATLAS_IN_VIEW_PX,
  CHAT_IN_VIEW_PX,
  CLEAR_CONFIRM_LABEL,
  CLEAR_CONFIRM_MS,
  CLEAR_LABEL,
  NO_GLOSSARY_NOTICE,
  SCROLLED_AWAY_SCREENS,
  TWO_COLUMNS_QUERY,
  conversationInView,
  describeLit,
  mapStillWanted,
} from "../../site/js/atlas.js";
import { SEEN_KEY } from "../../site/js/atlas-chat.js";
import { buildIndex } from "../../site/js/atlas-graph.js";
import { ATLAS_KEY, persistAtlas, reduceAtlas, restoreAtlas } from "../../site/js/atlas-state.js";

describe("describeLit: the polite sentence after a reply", () => {
  it("says so when nothing lit", () => {
    assert.equal(describeLit([], 5, 60), "No new places lit.");
  });

  it("lists what lit and counts what is visited", () => {
    assert.equal(describeLit(["The pot"], 2, 60), "Lit: The pot. 2 of 60 visited.");
    assert.equal(describeLit(["The common fund", "The pot", "Overdraft"], 4, 60), "Lit: The common fund, The pot, Overdraft. 4 of 60 visited.");
  });

  it("names at most five places and counts the rest", () => {
    assert.equal(ANNOUNCE_NAMES, 5);
    const five = ["A", "B", "C", "D", "E"];
    assert.equal(describeLit(five, 6, 60), "Lit: A, B, C, D, E. 6 of 60 visited.");
    assert.equal(describeLit([...five, "F"], 7, 60), "Lit: A, B, C, D, E (+1 more). 7 of 60 visited.");
    assert.equal(describeLit([...five, "F", "G", "H"], 9, 60), "Lit: A, B, C, D, E (+3 more). 9 of 60 visited.");
    assert.equal(describeLit(["A", "B", "C"], 4, 60, 2), "Lit: A, B (+1 more). 4 of 60 visited.", "the cap can be changed");
  });

  it("uses the total it is given", () => {
    assert.equal(describeLit(["A"], 2, 61), "Lit: A. 2 of 61 visited.");
  });
});

describe("Clear map wording", () => {
  it("has a plain label, a confirm label and a short confirm window", () => {
    assert.equal(CLEAR_LABEL, "Clear map");
    assert.equal(CLEAR_CONFIRM_LABEL, "Confirm: clear map");
    assert.ok(CLEAR_CONFIRM_MS >= 3000 && CLEAR_CONFIRM_MS <= 6000, `${CLEAR_CONFIRM_MS} ms`);
  });
});

describe("the notice for a browser that cannot read answers", () => {
  it("is honest and says what still works", () => {
    assert.equal(NO_GLOSSARY_NOTICE, "This browser cannot read answers for the map; the list still works.");
  });
});

describe("conversationInView: is the visitor reading the answer?", () => {
  const VIEW = 800;

  it("is false when the card is below the fold, as on a phone right after a chip tap", () => {
    assert.equal(conversationInView({ top: 1774, bottom: 2331 }, VIEW), false);
    assert.equal(conversationInView({ top: VIEW - 20, bottom: VIEW + 500 }, VIEW), false, "only the card's top edge peeks in");
  });

  it("is true when enough of the card is on screen, from below or from above", () => {
    assert.equal(CHAT_IN_VIEW_PX, 120);
    assert.equal(conversationInView({ top: 300, bottom: 900 }, VIEW), true);
    assert.equal(conversationInView({ top: -400, bottom: 200 }, VIEW), true, "scrolled past its top");
    assert.equal(conversationInView({ top: VIEW - 120, bottom: VIEW + 400 }, VIEW), true, "exactly the threshold");
    assert.equal(conversationInView({ top: VIEW - 119, bottom: VIEW + 400 }, VIEW), false);
  });

  it("is false when the card is above the window or missing", () => {
    assert.equal(conversationInView({ top: -900, bottom: -10 }, VIEW), false);
    assert.equal(conversationInView(null, VIEW), false);
  });

  it("the two-column layout starts where the style sheet says it does", () => {
    assert.equal(TWO_COLUMNS_QUERY, "(min-width: 1180px)");
    const css = readFileSync(new URL("../../site/css/atlas.css", import.meta.url), "utf8");
    assert.ok(css.includes(`@media ${TWO_COLUMNS_QUERY} {`), "atlas.css switches to two columns at the same width");
  });
});

describe("mapStillWanted: has the visitor gone away from the map while waiting? (F36)", () => {
  const VIEW = 844;
  const IN_VIEW = { top: 200, bottom: 1600 };
  const FAR_BELOW = { top: 2100, bottom: 3500 };
  const FAR_ABOVE = { top: -3000, bottom: -1000 };

  it("is true while the Atlas card is on screen, wherever the page was when the question went out", () => {
    assert.equal(ATLAS_IN_VIEW_PX, 120);
    assert.equal(mapStillWanted(IN_VIEW, VIEW, 2000, 0), true);
    assert.equal(mapStillWanted({ top: VIEW - 120, bottom: VIEW + 900 }, VIEW, 5000, 0), true, "exactly the threshold");
    assert.equal(mapStillWanted({ top: VIEW - 119, bottom: VIEW + 900 }, VIEW, 5000, 0), false, "a sliver of the card is not looking at it");
    assert.equal(mapStillWanted({ top: -1400, bottom: 130 }, VIEW, 5000, 0), true, "scrolled past most of it, enough still shows");
  });

  it("is true while the page has moved less than half a screen since the question was sent", () => {
    assert.equal(SCROLLED_AWAY_SCREENS, 0.5);
    assert.equal(mapStillWanted(FAR_BELOW, VIEW, 2000, 2000), true, "has not moved");
    assert.equal(mapStillWanted(FAR_BELOW, VIEW, 2000 - 400, 2000), true, "400px up of 844");
    assert.equal(mapStillWanted(FAR_BELOW, VIEW, 2000 + 400, 2000), true, "400px down of 844");
    assert.equal(mapStillWanted(FAR_ABOVE, VIEW, 100, 450), true, "and the card may even lie above");
  });

  it("is false for a visitor who scrolled half a screen or more away and has left the card", () => {
    assert.equal(mapStillWanted(FAR_BELOW, VIEW, 0, 2187), false, "the review's case: to the top of the page while waiting");
    assert.equal(mapStillWanted(FAR_BELOW, VIEW, 2000 - 422, 2000), false, "exactly half a screen");
    assert.equal(mapStillWanted(FAR_BELOW, VIEW, 2000 + 422, 2000), false);
    assert.equal(mapStillWanted(FAR_ABOVE, VIEW, 5200, 100), false, "down to the footer");
  });

  it("falls back to the card alone when the position at sending is unknown, and says no when nothing is known", () => {
    assert.equal(mapStillWanted(IN_VIEW, VIEW, 100, null), true);
    assert.equal(mapStillWanted(IN_VIEW, VIEW, 100, undefined), true);
    assert.equal(mapStillWanted(FAR_BELOW, VIEW, 100, null), false, "a stranger to this page's history is not pulled");
    assert.equal(mapStillWanted(FAR_BELOW, VIEW, 100, undefined), false);
    assert.equal(mapStillWanted(FAR_BELOW, VIEW, undefined, 100), false);
    assert.equal(mapStillWanted(null, VIEW, 100, 100), true, "no card to measure, but the page has not moved");
    assert.equal(mapStillWanted(null, VIEW, 100, null), false);
    assert.equal(mapStillWanted(FAR_BELOW, 0, 100, 100), false, "a window with no height tells nothing");
  });

  it("the controller records the position when the form is submitted and asks this function before it scrolls the page", () => {
    const source = readFileSync(new URL("../../site/js/atlas.js", import.meta.url), "utf8");
    assert.match(source, /querySelector\("#composer"\)\?\.addEventListener\("submit"/);
    assert.match(source, /sentScrollY = Number\.isFinite\(win\.scrollY\)/);
    assert.match(source, /const vertical = !matches\(TWO_COLUMNS_QUERY\) && !reading && around;/);
    assert.match(source, /mapStillWanted\(atlasCard \? atlasCard\.getBoundingClientRect\(\) : null, viewHeight, win\.scrollY, sentScrollY\)/);
  });
});

describe("the replies already read survive a reload (F11)", () => {
  const source = readFileSync(new URL("../../site/js/atlas.js", import.meta.url), "utf8");

  it("the controller hands its sessionStorage to the chat bridge", () => {
    // The controller itself needs a real DOM (tests/e2e/atlas_browser_reload.test.mjs drives it in Chrome and
    // would fail without this); this is the cheap guard that runs without a browser.
    const call = source.match(/createChatBridge\(\{([^}]*)\}\)/s);
    assert.ok(call, "atlas.js creates the bridge with an options object");
    assert.match(call[1], /^\s*storage,?\s*$/m, "the same storage the map progress uses is passed on");
    assert.match(source, /createAtlas\(\{[^)]*\bstorage = null\b/s, "and that storage is the controller's own option");
  });

  it("Clear map leaves the stored memory alone: it rewrites its own key only", () => {
    const index = buildIndex();
    const data = new Map([[SEEN_KEY, '["1:e40c292c"]']]);
    const calls = [];
    const storage = {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem(key, value) {
        calls.push(["setItem", key]);
        data.set(key, String(value));
      },
      removeItem(key) {
        calls.push(["removeItem", key]);
        data.delete(key);
      },
      clear() {
        calls.push(["clear"]);
        data.clear();
      },
    };
    assert.notEqual(SEEN_KEY, ATLAS_KEY);
    let state = restoreAtlas(storage, index);
    state = reduceAtlas(state, { type: "reply", ids: [] }, index);
    persistAtlas(storage, state);
    state = reduceAtlas(state, { type: "reset" }, index);
    persistAtlas(storage, state);
    assert.equal(data.get(SEEN_KEY), '["1:e40c292c"]');
    assert.deepEqual(calls.filter((call) => call[0] !== "setItem" || call[1] !== ATLAS_KEY), []);
    // The controller's reset() is exactly that: the reducer and persistAtlas, nothing else touches storage.
    assert.ok(!/removeItem|storage\.clear/.test(source), "atlas.js never removes or clears a storage key");
    assert.ok(!source.includes(SEEN_KEY), "and never mentions the memory's key");
  });
});
