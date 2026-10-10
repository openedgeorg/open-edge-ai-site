/**
 * Unit tests for the small pure parts of the Atlas controller (site/js/atlas.js). The controller
 * itself needs a real DOM and is driven in Chrome by tests/e2e/atlas_browser.test.mjs.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ANNOUNCE_NAMES,
  CHAT_IN_VIEW_PX,
  CLEAR_CONFIRM_LABEL,
  CLEAR_CONFIRM_MS,
  CLEAR_LABEL,
  NO_GLOSSARY_NOTICE,
  TWO_COLUMNS_QUERY,
  conversationInView,
  describeLit,
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
