/**
 * Reading an answer, deterministically (no browser): what site/js/render.js puts into the history and what
 * site/css/chat.css promises about it.
 *
 *  - every row says who is speaking (li[data-role] + span.speaker BEFORE the p) and a row of an unknown role
 *    is not labelled with a guess;
 *  - the message is ONE text node in ONE <p>, byte for byte: paragraph breaks, blank lines, list lines,
 *    indentation, tabs and a trailing newline stay in the text, and nothing is parsed (no innerHTML, no <br>,
 *    no elements made from the text), so the page's `white-space: pre-wrap` is what shows them;
 *  - the style sheet really sets that, and lets long terms wrap;
 *  - the captured 309-word first answer of the audit (tests/fixtures/atlas_reading/first_answer.txt) goes
 *    through unchanged.
 * tests/e2e/atlas_browser_reading.test.mjs checks the same in Chrome (computed styles, heights, scrolling).
 *
 * Run: node --test tests/e2e/chat_reading.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** A document that records what was built and refuses every way of turning text into markup. */
function makeDocument() {
  const refuse = (name) => () => {
    throw new Error(`${name} must never be used on model text`);
  };
  const element = (name) => {
    const node = {
      nodeName: name,
      children: [],
      attrs: {},
      className: "",
      listeners: {},
      parent: null,
      textContent: "",
      appendChild(child) {
        this.children.push(child);
        child.parent = this;
        return child;
      },
      setAttribute(key, value) {
        this.attrs[key] = String(value);
      },
      getAttribute(key) {
        return Object.hasOwn(this.attrs, key) ? this.attrs[key] : null;
      },
      addEventListener(type, handler) {
        this.listeners[type] = handler;
      },
      remove() {
        if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
      },
    };
    for (const name of ["innerHTML", "outerHTML"]) {
      Object.defineProperty(node, name, { get: refuse(name), set: refuse(name) });
    }
    node.insertAdjacentHTML = refuse("insertAdjacentHTML");
    node.append = refuse("append");
    node.prepend = refuse("prepend");
    return node;
  };
  return {
    activeElement: null,
    createElement: element,
    createTextNode: refuse("createTextNode"),
    write: refuse("document.write"),
    element,
  };
}

const fake = makeDocument();
globalThis.document = fake;
const { SPEAKER_LABELS, renderHistoryItem, speakerRole } = await import("../../site/js/render.js");

const newList = () => fake.element("ol");
const bodyOf = (row) => row.children.find((child) => child.nodeName === "p");
const FIRST_ANSWER = read("../fixtures/atlas_reading/first_answer.txt");

describe("speaker roles", () => {
  test("a question, an answer and a problem report are labelled in words, before the text", () => {
    const list = newList();
    const rows = [
      renderHistoryItem({ role: "user", text: "Who pays the apps?" }, list),
      renderHistoryItem({ role: "assistant", text: "Your ISP." }, list),
      renderHistoryItem({ role: "error", text: "It could not be delivered." }, list),
    ];
    assert.deepEqual(
      rows.map((row) => row.getAttribute("data-role")),
      ["user", "assistant", "error"],
    );
    assert.deepEqual(
      rows.map((row) => row.children[0].textContent),
      ["You", "Answer", "Problem"],
    );
    for (const row of rows) {
      assert.equal(row.nodeName, "li");
      assert.equal(row.children[0].nodeName, "span");
      assert.equal(row.children[0].className, "speaker");
      assert.equal(row.children[1].nodeName, "p", "the label comes first, the message second");
      assert.equal(row.children.length, 2);
    }
    assert.deepEqual(list.children, rows, "the rows are appended in order");
  });

  test("the words are exactly You, Answer and Problem", () => {
    assert.deepEqual({ ...SPEAKER_LABELS }, { user: "You", assistant: "Answer", error: "Problem" });
    assert.ok(Object.isFrozen(SPEAKER_LABELS));
  });

  test("a row of a role nobody knows is added without a label, and with no guessed role", () => {
    for (const role of [undefined, null, "", "system", "tool", "USER", "constructor", "__proto__", "toString", 7, {}]) {
      const row = renderHistoryItem({ role, text: "text" }, newList());
      assert.equal(row.getAttribute("data-role"), null, `role ${String(role)}`);
      assert.equal(row.children.length, 1, `role ${String(role)} has no label`);
      assert.equal(row.children[0].nodeName, "p");
      assert.equal(row.children[0].textContent, "text");
    }
  });

  test("speakerRole accepts the three roles and nothing else", () => {
    assert.equal(speakerRole("user"), "user");
    assert.equal(speakerRole("assistant"), "assistant");
    assert.equal(speakerRole("error"), "error");
    for (const role of ["", "Assistant", "hasOwnProperty", "valueOf", null, undefined, 1]) assert.equal(speakerRole(role), "");
  });

  test("a missing item does not throw", () => {
    const row = renderHistoryItem(undefined, newList());
    assert.equal(bodyOf(row).textContent, "");
  });
});

describe("the message text", () => {
  const SAMPLES = {
    "paragraphs and a blank line": "First paragraph.\n\nSecond paragraph.\n\n\nThird, after two blank lines.",
    "a bulleted list": "The path:\n\n- one\n- two with a long long long text\n  - nested\n\nDone.",
    "a numbered list": "1. first\n2. second\n3. third",
    "indentation and tabs": "    indented four\n\tindented by a tab\ntrailing spaces   ",
    "windows line breaks": "line one\r\nline two\r\n\r\nline four",
    "a trailing and a leading newline": "\nbetween\n",
    "html that must stay text": "<script>alert(1)</script>\n<b>bold</b> <img src=x onerror=alert(2)>\n&amp; &lt;",
    "markdown that must stay text": "**bold** `code` [link](javascript:alert(1))\n# not a heading\n> not a quote",
    "a very long term": `${"x".repeat(400)}\nhttps://example.invalid/${"path/".repeat(60)}`,
    "code-like text": "const total = price * quantity;\nif (a < b && c > d) { return \"x\"; }",
    "unicode": "caf\u00e9 \u2014 \u201cquoted\u201d \u2022 \ud83d\ude00",
  };

  for (const [name, text] of Object.entries(SAMPLES)) {
    test(`${name}: one text node in one <p>, unchanged`, () => {
      const list = newList();
      const row = renderHistoryItem({ role: "assistant", text }, list);
      const paragraphs = row.children.filter((child) => child.nodeName === "p");
      assert.equal(paragraphs.length, 1, "exactly one <p> holds the message");
      assert.equal(paragraphs[0].textContent, text, "the text is kept character for character");
      assert.equal(paragraphs[0].children.length, 0, "no element is made from the text");
      assert.deepEqual(
        row.children.map((child) => child.nodeName),
        ["span", "p"],
        "nothing but the label and the paragraph is made",
      );
    });
  }

  test("a non-string text is turned into text, never into markup", () => {
    assert.equal(bodyOf(renderHistoryItem({ role: "user", text: 42 }, newList())).textContent, "42");
    assert.equal(bodyOf(renderHistoryItem({ role: "user", text: null }, newList())).textContent, "");
    assert.equal(bodyOf(renderHistoryItem({ role: "user" }, newList())).textContent, "");
    assert.equal(bodyOf(renderHistoryItem({ role: "user", text: { toString: () => "<i>x</i>" } }, newList())).textContent, "<i>x</i>");
  });

  test("citations are buttons after the paragraph and the paragraph stays the first text holder", () => {
    const row = renderHistoryItem(
      { role: "assistant", text: "See the note.", citations: [{ title: "Note A", source_id: "src-1" }, { source_id: "src-2" }] },
      newList(),
    );
    assert.deepEqual(
      row.children.map((child) => child.nodeName),
      ["span", "p", "button", "button"],
    );
    assert.deepEqual(
      row.children.slice(2).map((child) => child.textContent),
      ["Note A", "src-2"],
    );
    assert.equal(row.children[2].type, "button");
  });

  test("the code that builds a row never reaches for markup", () => {
    const source = read("../../site/js/render.js");
    for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "DOMParser", "createContextualFragment", "document.write", "eval(", "new Function"]) {
      assert.ok(!source.includes(forbidden), `render.js does not use ${forbidden}`);
    }
  });
});

describe("the captured first answer (309 words)", () => {
  const paragraphs = FIRST_ANSWER.split("\n\n");

  test("the fixture is the audit's answer: 309 words in several paragraphs with a list in the middle", () => {
    assert.equal(FIRST_ANSWER.split(/\s+/).filter(Boolean).length, 309);
    assert.ok(paragraphs.length >= 6, `${paragraphs.length} paragraphs`);
    assert.ok(FIRST_ANSWER.startsWith("You pay your ISP. The protocol pays the apps, using money your ISP committed."));
    assert.equal(FIRST_ANSWER.split("\n").filter((line) => line.startsWith("- ")).length, 4, "four list lines");
  });

  test("it is rendered as one answer row whose text is the answer, line breaks included", () => {
    const row = renderHistoryItem({ role: "assistant", text: FIRST_ANSWER }, newList());
    assert.equal(bodyOf(row).textContent, FIRST_ANSWER);
    assert.equal(bodyOf(row).textContent.split("\n\n").length, paragraphs.length, "the paragraph breaks are still there");
    assert.equal(bodyOf(row).textContent.split("\n").filter((line) => line.startsWith("- ")).length, 4);
    assert.equal(row.getAttribute("data-role"), "assistant");
    assert.equal(row.children[0].textContent, "Answer");
  });
});

describe("chat.css", () => {
  const css = read("../../site/css/chat.css").replace(/\/\*[\s\S]*?\*\//g, "");
  /** The body of the first rule whose selector list names `selector` (comments are stripped). */
  const rule = (selector) => {
    const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) =>
      match[1].split(",").some((part) => part.replace(/\s+/g, " ").trim() === selector),
    );
    assert.ok(found, `chat.css has a rule for ${selector}`);
    return found[2];
  };

  test("the message paragraph keeps line breaks and wraps long terms", () => {
    const body = rule(".atlas-section .atlas-chat #history > li > p");
    assert.match(body, /white-space:\s*pre-wrap/);
    assert.match(body, /overflow-wrap:\s*anywhere/);
  });

  test("the history is a numberless scroll region that never scrolls sideways", () => {
    const body = rule(".atlas-chat #history");
    assert.match(body, /list-style:\s*none/);
    assert.match(body, /overflow-x:\s*hidden/);
    assert.match(body, /overflow-y:\s*auto/);
    assert.match(body, /scroll-behavior:\s*auto/, "html's smooth scrolling is not inherited by the history");
  });

  test("a swipe that reaches the end of the history carries on to the page on a phone", () => {
    assert.match(rule(".atlas-chat #history"), /overscroll-behavior:\s*auto/);
  });

  test("in the two-column layout the history takes the height the card leaves instead of a fixed cap", () => {
    const twoColumns = css.slice(css.lastIndexOf("@media (min-width: 1180px)", css.indexOf("max-height: none")));
    assert.match(twoColumns, /^@media \(min-width: 1180px\)/);
    assert.match(twoColumns, /\.atlas-chat #history \{[^}]*max-height:\s*none/);
  });

  test("each role looks different, and not by colour alone (the label is text)", () => {
    for (const role of ["user", "assistant", "error"]) {
      assert.match(css, new RegExp(`\\.atlas-chat #history > li\\[data-role="${role}"\\] \\{`), `${role} row`);
      assert.match(css, new RegExp(`\\.atlas-chat #history > li\\[data-role="${role}"\\] \\.speaker \\{`), `${role} label`);
    }
    assert.match(rule(".atlas-chat #history .speaker"), /display:\s*block/);
  });

  test("it styles the status area, the actions and the history line the conversation client adds, hiding the empty ones", () => {
    for (const selector of [".atlas-chat .chat-status", ".atlas-chat #history-state", ".atlas-chat .chat-actions"]) rule(selector);
    assert.match(css, /\.chat-status:empty/);
    assert.match(css, /\.atlas-chat \.chat-actions \{[^}]*flex-wrap:\s*wrap/);
  });

  test("the buttons that move around the history have a 44px touch target", () => {
    assert.match(rule(".atlas-chat .history-nav button"), /min-height:\s*44px/);
    assert.match(rule(".atlas-chat .chat-actions button"), /min-height:\s*44px/);
  });

  test("it carries no style that the page's CSP would object to and loads nothing from elsewhere", () => {
    assert.doesNotMatch(css, /@import|url\(|expression\(|javascript:/i);
  });

  test("index.html links it after atlas-panel.css, so its rules win ties with the older card rules", () => {
    const html = read("../../site/index.html");
    const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((match) => match[1]);
    assert.ok(links.includes("css/chat.css"));
    assert.ok(links.indexOf("css/chat.css") > links.indexOf("css/atlas-panel.css"));
    assert.ok(links.indexOf("css/chat.css") > links.indexOf("css/atlas.css"));
  });
});
