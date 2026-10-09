/**
 * Unit tests for the small pure parts of the Atlas controller (site/js/atlas.js). The controller
 * itself needs a real DOM and is driven in Chrome by tests/e2e/atlas_browser.test.mjs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ANNOUNCE_NAMES,
  CLEAR_CONFIRM_LABEL,
  CLEAR_CONFIRM_MS,
  CLEAR_LABEL,
  NO_GLOSSARY_NOTICE,
  describeLit,
} from "../../site/js/atlas.js";

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
