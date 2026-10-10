/**
 * Atlas graph integrity: the shape, the status rules, the honesty rules and the trace fixture of
 * site/js/atlas-graph.js. Whether each quotation really occurs in the section it names is checked
 * in test_atlas_graph.py. Whether a label is faithful to its quotation needs a human read.
 *
 * Nothing here pins island names, teasers, labels, terms or anchors. Every expectation is derived at
 * run time from the graph, from tests/fixtures/atlas-trace.json and from the summary embedded in the
 * local draft brain (counts of section 10 bullets, the summary hash, the contested item).
 *
 * Run with: node --test tests/e2e/atlas_graph.test.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTESTED_FULL_LABEL,
  CONTESTED_LABEL,
  EDGE_DRAGON_CAPTION,
  EDGES,
  FIRST_SUGGESTION,
  ISLANDS,
  OPEN_LABEL,
  REGIONS,
  START_ID,
  VIEWBOX,
  buildIndex,
  edgeKey,
} from "../../site/js/atlas-graph.js";

const REGION_IDS = ["coast", "lowlands", "interior", "highlands", "mountains", "valley", "badlands", "dragons"];
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_SPACING = 60;
/** Radius of an island body in viewBox units (atlas-map.js BODY_R): the circle must sit inside its band. */
const BODY_RADIUS = 11;
/** Where the region bands start and stop vertically (atlas-map.js BAND_TOP, BAND_BOTTOM). */
const BAND_TOP = 10;
const BAND_BOTTOM = 742;
/** What an edge that touches a contested or an open island must say (F4). */
const QUALIFIER = /\b(?:awaits incorporation|still open|open|not ratified|undefined|deferred|unsealed)\b/i;
const PRONOUN_START = /^(?:it|they|this|that|these|those|its|their)\b/i;
const ROADMAP_WORDS = /\b(?:will|roadmap|next steps?)\b/i;

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const repo = (...parts) => join(ROOT, ...parts);

const ids = ISLANDS.map((island) => island.id);
const idSet = new Set(ids);
const byId = new Map(ISLANDS.map((island) => [island.id, island]));
const index = buildIndex();
const dragons = ISLANDS.filter((island) => island.region === "dragons");
const openIslands = ISLANDS.filter((island) => island.status === "open");
const contestedIslands = ISLANDS.filter((island) => island.status === "contested");
/** True when an end of the path is a contested or an open island. */
const flaggedEnds = (edge) => [edge.a, edge.b].some((id) => ["open", "contested"].includes(byId.get(id).status));

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** @param {unknown} section */
function isValidSection(section) {
  return section === "preamble" || (Number.isInteger(section) && section >= 1 && section <= 10);
}

/** Curly quotes become straight and every run of whitespace becomes one space. */
function squash(text) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** The brain the local listener serves, found through knowledge/release/local_draft.py. */
function brainPath() {
  const python = readFileSync(repo("knowledge", "release", "local_draft.py"), "utf8");
  const match = python.match(/BRAIN_DIR\s*=\s*ROOT\s*\/\s*"knowledge"\s*\/\s*"brain"\s*\/\s*"([\w.-]+)"/);
  assert.ok(match, "knowledge/release/local_draft.py no longer names BRAIN_DIR the way this test reads it");
  return { release: match[1], file: repo("knowledge", "brain", match[1], "canonical_brain.md") };
}

/** The bytes between the BEGIN SOURCE and END SOURCE marker lines, as a Buffer. */
function embeddedSource(brain) {
  const text = brain.toString("latin1"); // one char per byte, so string offsets are byte offsets
  const begins = [...text.matchAll(/^----- BEGIN SOURCE [^\n]* -----\n/gm)];
  const ends = [...text.matchAll(/^----- END SOURCE [^\n]* -----\n/gm)];
  assert.equal(begins.length, 1, "BEGIN SOURCE markers");
  assert.equal(ends.length, 1, "END SOURCE markers");
  const start = begins[0].index + begins[0][0].length;
  assert.ok(start <= ends[0].index);
  return brain.subarray(start, ends[0].index);
}

/** The squashed text of every `- **` bullet of one section's raw text: a bullet runs to the next one or to the section's end. */
function bulletsOf(raw) {
  const starts = [...raw.matchAll(/^- \*\*/gm)].map((match) => match.index);
  return starts.map((start, position) =>
    squash(raw.slice(start, position + 1 < starts.length ? starts[position + 1] : raw.length)),
  );
}

/**
 * The passages of the summary that make up the mechanism its preamble says awaits incorporation (F45).
 * The preamble names it in one sentence ("The <epoch price-catalogue> mechanism in section <N> awaits
 * incorporation ..."): the section is N, and the mechanism is the bullets of that section that talk
 * about the thing the sentence names (its last word, here the catalogue). Read from the brain, never
 * from a list in this file. `passages` is the sentence plus those bullets.
 */
function mechanismOf(preambleRaw, sections) {
  const preamble = squash(preambleRaw);
  const found = preamble.match(/\bThe ([\w -]+?) mechanism in section (\d+) awaits incorporation\b[^.]*\./);
  assert.ok(found, "the preamble no longer has the sentence 'The ... mechanism in section N awaits incorporation ...'");
  const section = Number(found[2]);
  const noun = found[1].split(/[\s-]+/).pop();
  const bullets = bulletsOf(sections.get(section));
  const word = new RegExp(`\\b${noun}\\b`, "i");
  const indexes = bullets.flatMap((bullet, position) => (word.test(bullet) ? [position] : []));
  return { section, noun, sentence: found[0], bullets, indexes, passages: [found[0], ...indexes.map((i) => bullets[i])] };
}

/** The squashed preamble and sections 1..10 of the summary, the squashed bullets of section 10 and the awaiting mechanism. */
function loadNotes() {
  const { release, file } = brainPath();
  const source = embeddedSource(readFileSync(file));
  const text = source.toString("utf8");
  const headings = [...text.matchAll(/^## (\d+)\. /gm)];
  assert.deepEqual(
    headings.map((heading) => Number(heading[1])),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  const sections = new Map();
  headings.forEach((heading, position) => {
    const stop = position + 1 < headings.length ? headings[position + 1].index : text.length;
    sections.set(Number(heading[1]), text.slice(heading.index, stop));
  });
  const preambleRaw = text.slice(0, headings[0].index);
  return {
    release,
    sha256: createHash("sha256").update(source).digest("hex"),
    bytes: source.length,
    preamble: squash(preambleRaw),
    sections: new Map([...sections].map(([number, body]) => [number, squash(body)])),
    bullets: bulletsOf(sections.get(10)),
    mechanism: mechanismOf(preambleRaw, sections),
    awaitsIncorporation: (text.match(/awaits incorporation/g) ?? []).length,
  };
}

const notes = loadNotes();
const fixture = JSON.parse(readFileSync(repo("tests", "fixtures", "atlas-trace.json"), "utf8"));

/**
 * Which paths rest on the mechanism that the preamble says awaits incorporation, and which of them fail to say so (F31, F45).
 * A path rests on it when its quotation lies inside the preamble sentence or inside one of the section's bullets that talk
 * about it, whatever words the quotation uses. A path that ends at a dragon is exempt from carrying "awaits incorporation"
 * itself, because the dragon's own qualifier is required of it by the open-island rule.
 * @param {typeof EDGES} edges
 * @param {(edge: {a: string, b: string}) => string} anchorOf the squashed quotation behind a path
 */
function mechanismFindings(edges, anchorOf) {
  const { mechanism } = notes;
  const inside = (anchor, passage) => anchor !== "" && passage.includes(anchor);
  const section = notes.sections.get(mechanism.section);
  const open = new Set(openIslands.map((island) => island.id));
  const resting = edges.filter((edge) => mechanism.passages.some((passage) => inside(anchorOf(edge), passage)));
  const touchesDragon = (edge) => open.has(edge.a) || open.has(edge.b);
  return {
    resting,
    // A quotation in the section that lies in no single bullet would slip between two of them.
    straddling: edges.filter(
      (edge) => inside(anchorOf(edge), section) && !mechanism.bullets.some((bullet) => inside(anchorOf(edge), bullet)),
    ),
    unqualified: resting.filter((edge) => !touchesDragon(edge) && !edge.label.includes(CONTESTED_LABEL)),
    dragonEndsWithoutQualifier: resting.filter((edge) => touchesDragon(edge) && !QUALIFIER.test(edge.label)),
  };
}

/** The squashed quotation behind a path, from the trace fixture. */
const fixtureAnchorOf = (edge) => squash(fixture.edges[edgeKey(edge.a, edge.b)] ?? "");

/** Every string a visitor could see or that feeds the matcher, with a label for failure messages. */
function textFields() {
  const fields = [];
  for (const island of ISLANDS) {
    for (const key of ["name", "teaser", "label", "note"]) {
      if (island[key] !== undefined) fields.push([`island ${island.id}.${key}`, island[key]]);
    }
    for (const term of island.terms ?? []) fields.push([`island ${island.id}.terms`, term]);
  }
  for (const edge of EDGES) fields.push([`edge ${edge.a}|${edge.b}.label`, edge.label]);
  return fields;
}

/** Strings a visitor can read on the page (names, teasers, labels, notes, path labels). */
function visibleFields() {
  return textFields().filter(([where]) => !where.endsWith(".terms"));
}

/** Hops from `startId` to every reachable island. */
function hopsFrom(startId) {
  const hops = new Map([[startId, 0]]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of index.neighbours.get(current) ?? []) {
      if (!hops.has(next)) {
        hops.set(next, hops.get(current) + 1);
        queue.push(next);
      }
    }
  }
  return hops;
}

/** The inner x range of a region's band, by the midpoint rule of atlas-map.js. */
function bandOf(regionId) {
  const position = REGIONS.findIndex((region) => region.id === regionId);
  const region = REGIONS[position];
  const prev = REGIONS[position - 1];
  const next = REGIONS[position + 1];
  const left = prev ? (prev.x + region.x) / 2 : Math.max(8, region.x - (next ? (next.x - region.x) / 2 : 70));
  const right = next
    ? (region.x + next.x) / 2
    : Math.min(VIEWBOX.width - 8, region.x + (prev ? (region.x - prev.x) / 2 : 70));
  return { left: left + 1.5, right: right - 1.5 };
}

/** @param {unknown} value @param {(key: string, path: string) => void} visit @param {string} path */
function walkKeys(value, visit, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, position) => walkKeys(item, visit, `${path}[${position}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      visit(key, `${path}.${key}`);
      walkKeys(child, visit, `${path}.${key}`);
    }
  }
}

/** Every file under a directory, as absolute paths. */
function filesUnder(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort();
}

describe("graph size and identity", () => {
  it("has 55..65 islands", () => {
    assert.ok(ISLANDS.length >= 55 && ISLANDS.length <= 65, `islands: ${ISLANDS.length}`);
  });

  it("has 80..100 edges", () => {
    assert.ok(EDGES.length >= 80 && EDGES.length <= 100, `edges: ${EDGES.length}`);
  });

  it("gives every island a unique, key-safe id", () => {
    assert.equal(idSet.size, ISLANDS.length, "duplicate island ids");
    for (const id of ids) {
      assert.match(id, ID_PATTERN, `island id ${id}`);
    }
  });

  it("has exactly one start island, equal to START_ID, in the coast", () => {
    const starts = ISLANDS.filter((island) => island.start === true);
    assert.equal(starts.length, 1, `start islands: ${starts.map((island) => island.id).join(", ")}`);
    assert.equal(starts[0].id, START_ID);
    assert.equal(starts[0].region, "coast");
    assert.ok(byId.has(START_ID));
    for (const island of ISLANDS) {
      assert.ok(island.start === undefined || island.start === true, `${island.id}.start`);
    }
  });
});

describe("edges", () => {
  it("references only existing islands and has no self loops", () => {
    for (const edge of EDGES) {
      assert.ok(idSet.has(edge.a), `edge end ${edge.a} is not an island`);
      assert.ok(idSet.has(edge.b), `edge end ${edge.b} is not an island`);
      assert.notEqual(edge.a, edge.b, `self loop on ${edge.a}`);
    }
  });

  it("has no duplicate undirected pairs", () => {
    const seen = new Map();
    for (const edge of EDGES) {
      const key = edgeKey(edge.a, edge.b);
      assert.ok(!seen.has(key), `duplicate edge ${key}`);
      seen.set(key, edge);
    }
    assert.equal(index.byKey.size, EDGES.length);
  });

  it("keeps edgeKey symmetric and the index adjacency symmetric", () => {
    for (const edge of EDGES) {
      assert.equal(edgeKey(edge.a, edge.b), edgeKey(edge.b, edge.a));
      assert.ok(index.neighbours.get(edge.a).has(edge.b));
      assert.ok(index.neighbours.get(edge.b).has(edge.a));
    }
  });

  it("is connected from START_ID", () => {
    const seen = hopsFrom(START_ID);
    const missing = ids.filter((id) => !seen.has(id));
    assert.deepEqual(missing, [], `unreachable from ${START_ID}`);
    assert.equal(seen.size, ISLANDS.length);
  });

  it("gives the start island at least three neighbours", () => {
    assert.ok(index.neighbours.get(START_ID).size >= 3, `neighbours: ${index.neighbours.get(START_ID).size}`);
  });

  it("gives every edge a 3..60 character label and a traced section", () => {
    for (const edge of EDGES) {
      const where = `edge ${edge.a}|${edge.b}`;
      assert.ok(isNonEmptyString(edge.label), `${where} label`);
      assert.ok(edge.label.length >= 3 && edge.label.length <= 60, `${where} label length ${edge.label.length}`);
      assert.ok(edge.trace && typeof edge.trace === "object", `${where} trace`);
      assert.ok(isValidSection(edge.trace.section), `${where} trace section ${edge.trace.section}`);
    }
  });

  it("starts no path label with a pronoun, because a label is read from both ends", () => {
    const bad = EDGES.filter((edge) => PRONOUN_START.test(edge.label.trim()));
    assert.deepEqual(
      bad.map((edge) => `${edge.a}|${edge.b}: ${edge.label}`),
      [],
    );
  });

  it("makes every path that touches a contested or an open island say so (F4)", () => {
    const flagged = new Set([...openIslands, ...contestedIslands].map((island) => island.id));
    const touching = EDGES.filter((edge) => flagged.has(edge.a) || flagged.has(edge.b));
    assert.ok(touching.length >= 1, "no path touches a contested or an open island");
    const bad = touching.filter((edge) => !QUALIFIER.test(edge.label));
    assert.deepEqual(
      bad.map((edge) => `${edge.a}|${edge.b}: ${edge.label}`),
      [],
      "a path to a contested or open island must carry its qualifier",
    );
  });

  it("lets only a path that touches an open island cite section 10 (F31)", () => {
    const open = new Set(openIslands.map((island) => island.id));
    const citing = EDGES.filter((edge) => edge.trace.section === 10);
    assert.ok(citing.length >= 1, "no path cites section 10");
    const bad = citing.filter((edge) => !open.has(edge.a) && !open.has(edge.b));
    assert.deepEqual(
      bad.map((edge) => `${edge.a}|${edge.b}: ${edge.label}`),
      [],
      "a path that cites section 10 must touch an open island",
    );
  });

  it("makes every path that rests on the awaiting price-catalogue mechanism say so, by the bullet its quotation sits in (F31, F45)", () => {
    const { mechanism } = notes;
    // The preamble sentence names the mechanism and the bullets that talk about it are read from the brain. Pinned: they
    // are the first three bullets of section 4 (the signed catalogue, the prices fixed for the epoch, the charges
    // traceable to the accepted catalogue). If the notes change that, this fails and the rule must be re-read.
    assert.equal(mechanism.section, 4, "the preamble no longer says that section 4 holds the mechanism");
    assert.deepEqual(mechanism.indexes, [0, 1, 2], "the mechanism is no longer the first three bullets of section 4");
    const found = mechanismFindings(EDGES, fixtureAnchorOf);
    const names = (list) => list.map((edge) => `${edge.a}|${edge.b}: ${edge.label}`);
    assert.deepEqual(names(found.straddling), [], "a quotation in section 4 must lie inside one bullet");
    assert.ok(found.resting.length >= 3, `only ${found.resting.length} paths rest on the price-catalogue mechanism`);
    assert.deepEqual(names(found.unqualified), [], "a path that rests on the price-catalogue mechanism must say it awaits incorporation");
    assert.deepEqual(names(found.dragonEndsWithoutQualifier), [], "the dragon end of such a path needs its own qualifier");
  });

  it("catches a path that loses its qualifier, or is re-anchored on a mechanism bullet without one (F45 regression cases)", () => {
    const { mechanism } = notes;
    const names = (list) => list.map((edge) => `${edge.a}|${edge.b}`);
    const clean = mechanismFindings(EDGES, fixtureAnchorOf);
    const settledResting = clean.resting.filter((edge) => edge.label.includes(CONTESTED_LABEL) && !flaggedEnds(edge));
    assert.ok(settledResting.length >= 1, "no settled path rests on the mechanism");
    // M1: one such path loses its qualifier.
    const victim = settledResting[0];
    const stripped = EDGES.map((edge) => (edge === victim ? { ...edge, label: edge.label.split(CONTESTED_LABEL).join("") } : edge));
    assert.deepEqual(names(mechanismFindings(stripped, fixtureAnchorOf).unqualified), names([victim]));
    // M3: a settled path with no qualifier is re-anchored on the lead-in of the second bullet (no word "catalogue" in it).
    const lead = mechanism.bullets[1].match(/^- \*\*(.+?):\*\*/);
    assert.ok(lead, "the second bullet has no bold lead-in");
    assert.ok(!/catalogue/i.test(lead[1]), "the lead-in used for the regression case must not name the catalogue");
    const settled = EDGES.find(
      (edge) => !flaggedEnds(edge) && !clean.resting.includes(edge) && !edge.label.includes(CONTESTED_LABEL),
    );
    assert.ok(settled, "no settled path outside the mechanism");
    const reanchored = (edge) => (edge === settled ? squash(lead[1]) : fixtureAnchorOf(edge));
    assert.deepEqual(names(mechanismFindings(EDGES, reanchored).unqualified), names([settled]));
  });
});

describe("islands", () => {
  it("gives every island a known region", () => {
    const bad = ISLANDS.filter((island) => !REGION_IDS.includes(island.region));
    assert.deepEqual(
      bad.map((island) => `${island.id}: ${island.region}`),
      [],
    );
  });

  it("gives every island a non-empty name of at most 36 characters", () => {
    const bad = ISLANDS.filter((island) => !isNonEmptyString(island.name) || island.name.length > 36);
    assert.deepEqual(
      bad.map((island) => `${island.id}: ${island.name} (${island.name?.length} characters)`),
      [],
    );
  });

  it("gives every island a question teaser of at most 90 characters", () => {
    const bad = ISLANDS.filter(
      (island) => !isNonEmptyString(island.teaser) || !island.teaser.endsWith("?") || island.teaser.length > 90,
    );
    assert.deepEqual(
      bad.map((island) => `${island.id}: ${island.teaser} (${island.teaser?.length} characters)`),
      [],
    );
  });

  it("traces every island to at least one section 1..10 or the preamble", () => {
    for (const island of ISLANDS) {
      assert.ok(Array.isArray(island.trace) && island.trace.length >= 1, `${island.id} trace`);
      for (const entry of island.trace) {
        assert.ok(isValidSection(entry.section), `${island.id} trace section ${entry.section}`);
      }
    }
  });

  it("gives every island a non-empty list of match terms", () => {
    for (const island of ISLANDS) {
      assert.ok(Array.isArray(island.terms) && island.terms.length >= 1, `${island.id} terms`);
      for (const term of island.terms) {
        assert.ok(isNonEmptyString(term), `${island.id} has an empty term`);
        assert.equal(term, term.trim(), `${island.id} term ${JSON.stringify(term)} has outer whitespace`);
      }
      assert.equal(new Set(island.terms).size, island.terms.length, `${island.id} repeats a term`);
    }
  });

  it("gives a note, where an island has one, as plain non-empty text", () => {
    for (const island of ISLANDS) {
      if (island.note !== undefined) assert.ok(isNonEmptyString(island.note), `${island.id}.note`);
    }
  });

  it("places every island inside the viewBox and inside the band of its region", () => {
    assert.ok(VIEWBOX.width > 0 && VIEWBOX.height > 0);
    for (const island of ISLANDS) {
      assert.ok(Number.isFinite(island.x) && Number.isFinite(island.y), `${island.id} position`);
      assert.ok(island.x > 0 && island.x < VIEWBOX.width, `${island.id} x ${island.x}`);
      assert.ok(island.y > 0 && island.y < VIEWBOX.height, `${island.id} y ${island.y}`);
      const band = bandOf(island.region);
      assert.ok(
        island.x - BODY_RADIUS >= band.left && island.x + BODY_RADIUS <= band.right,
        `${island.id} x ${island.x} leaves the ${island.region} band ${band.left}..${band.right}`,
      );
      assert.ok(
        island.y - BODY_RADIUS >= BAND_TOP && island.y + BODY_RADIUS <= BAND_BOTTOM,
        `${island.id} y ${island.y} leaves the bands ${BAND_TOP}..${BAND_BOTTOM}`,
      );
    }
  });

  it("keeps every pair of islands at least 60 apart", () => {
    for (let i = 0; i < ISLANDS.length; i += 1) {
      for (let j = i + 1; j < ISLANDS.length; j += 1) {
        const a = ISLANDS[i];
        const b = ISLANDS[j];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        assert.ok(distance >= MIN_SPACING, `${a.id} and ${b.id} are ${distance.toFixed(1)} apart`);
      }
    }
  });
});

describe("regions", () => {
  it("has the eight regions L0..L7 in order", () => {
    assert.deepEqual(
      REGIONS.map((region) => region.id),
      REGION_IDS,
    );
    assert.deepEqual(
      REGIONS.map((region) => region.level),
      ["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7"],
    );
    for (const region of REGIONS) {
      assert.ok(isNonEmptyString(region.name), `${region.id} name`);
      assert.ok(isNonEmptyString(region.subtitle), `${region.id} subtitle`);
    }
  });

  it("lays the regions out left to right inside the viewBox", () => {
    for (let i = 0; i < REGIONS.length; i += 1) {
      assert.ok(REGIONS[i].x > 0 && REGIONS[i].x < VIEWBOX.width, `${REGIONS[i].id} x`);
      if (i > 0) assert.ok(REGIONS[i].x > REGIONS[i - 1].x, `${REGIONS[i].id} is left of ${REGIONS[i - 1].id}`);
    }
  });

  it("populates all eight regions", () => {
    for (const region of REGIONS) {
      const members = ISLANDS.filter((island) => island.region === region.id);
      assert.ok(members.length >= 1, `region ${region.id} is empty`);
    }
  });

  it("keeps the coast within three hops of the start, each coastal island next to the coast or the lowlands (F21)", () => {
    const hops = hopsFrom(START_ID);
    const coast = ISLANDS.filter((island) => island.region === "coast");
    assert.ok(coast.length >= 2);
    for (const island of coast) {
      assert.ok(hops.get(island.id) <= 3, `${island.id} is ${hops.get(island.id)} hops from ${START_ID}`);
      const near = [...index.neighbours.get(island.id)].filter((id) =>
        ["coast", "lowlands"].includes(byId.get(id).region),
      );
      assert.ok(near.length >= 1, `${island.id} hangs off the interior or deeper only`);
    }
  });
});

describe("status rules", () => {
  it("uses only the known statuses", () => {
    for (const island of ISLANDS) {
      assert.ok([undefined, "contested", "open"].includes(island.status), `${island.id} status ${island.status}`);
    }
  });

  it("pins the exported labels", () => {
    assert.equal(OPEN_LABEL, "open, not ratified");
    assert.equal(CONTESTED_LABEL, "awaits incorporation");
    assert.equal(CONTESTED_FULL_LABEL, `${CONTESTED_LABEL} into the authoritative design and message catalogue`);
  });

  it("marks every dragon open with the exact label", () => {
    assert.ok(dragons.length >= 1);
    for (const island of dragons) {
      assert.equal(island.status, "open", `${island.id} status`);
      assert.equal(island.label, "open, not ratified", `${island.id} label`);
    }
  });

  it("gives every open island the exact label and keeps open islands in the dragons region only", () => {
    assert.ok(openIslands.length >= 1);
    for (const island of openIslands) {
      assert.equal(island.region, "dragons", `${island.id} is open outside the dragons`);
      assert.equal(island.label, OPEN_LABEL, `${island.id} label`);
    }
    for (const island of ISLANDS.filter((candidate) => candidate.region !== "dragons")) {
      assert.notEqual(island.label, OPEN_LABEL, `${island.id} borrows the dragon label`);
    }
    assert.equal(openIslands.length, dragons.length);
  });

  it("lets only the two exported labels appear, each with its own status", () => {
    for (const island of ISLANDS) {
      if (island.label === undefined) {
        assert.equal(island.status, undefined, `${island.id} has a status but no label`);
      } else {
        const expected = { [OPEN_LABEL]: "open", [CONTESTED_LABEL]: "contested" }[island.label];
        assert.ok(expected, `${island.id} label ${JSON.stringify(island.label)}`);
        assert.equal(island.status, expected, `${island.id} label ${island.label}`);
      }
    }
  });

  it("flags as contested what the summary preamble flags, and nothing else", () => {
    assert.ok(notes.awaitsIncorporation >= 1, "the summary no longer flags a contested item");
    assert.ok(notes.preamble.includes(CONTESTED_FULL_LABEL), "the preamble does not say the full contested label");
    assert.equal(contestedIslands.length, notes.awaitsIncorporation, "contested islands vs flagged items");
    const flagged = notes.preamble.match(/mechanism in section (\d+) awaits incorporation/);
    assert.ok(flagged, "the preamble no longer names the section of the contested mechanism");
    for (const island of contestedIslands) {
      assert.equal(island.label, CONTESTED_LABEL, `${island.id} label`);
      assert.ok(
        island.trace.some((entry) => entry.section === Number(flagged[1])),
        `${island.id} does not trace to section ${flagged[1]}, where the preamble puts the contested mechanism`,
      );
    }
  });

  it("covers every bullet of section 10 with its own dragon traced to section 10", () => {
    assert.ok(notes.bullets.length >= 1, "no bullets found in section 10 of the brain");
    const covering = dragons.filter((island) => island.trace.some((entry) => entry.section === 10));
    assert.ok(
      covering.length >= notes.bullets.length,
      `${covering.length} dragons trace section 10 but the summary has ${notes.bullets.length} bullets there`,
    );
    for (const bullet of notes.bullets) {
      const match = covering.find((island) =>
        island.trace.some(
          (entry, position) =>
            entry.section === 10 && bullet.includes(squash(fixture.islands[island.id]?.[position] ?? "\u0000")),
        ),
      );
      assert.ok(match, `no dragon has a section 10 anchor inside the bullet: ${bullet.slice(0, 80)}`);
    }
  });

  it("adds the other open items of the summary as dragons beyond section 10", () => {
    const outsideTen = dragons.filter((island) => !island.trace.some((entry) => entry.section === 10));
    const mentionsOpen = [...notes.sections]
      .filter(([number]) => number < 10)
      .filter(([, body]) => /\b(?:undefined|unsealed|deferred)\b/i.test(body));
    assert.ok(mentionsOpen.length >= 1, "the summary no longer calls anything undefined, unsealed or deferred");
    assert.ok(outsideTen.length >= 1, "every dragon cites section 10: the open items of sections 2 to 8 have none");
  });

  it("ties every section 10 trace on an island to a dragon", () => {
    for (const island of ISLANDS) {
      if (island.trace.some((entry) => entry.section === 10)) {
        assert.equal(island.region, "dragons", `${island.id} cites section 10 outside the dragons`);
      }
    }
  });

  it("keeps the open items out of the first-load neighbourhood", () => {
    const next = index.neighbours.get(START_ID);
    for (const island of openIslands) {
      assert.ok(!next.has(island.id), `${island.id} is a first-load neighbour of ${START_ID}`);
    }
  });
});

describe("honest wording", () => {
  it("has no angle brackets in any island or edge text", () => {
    for (const [where, value] of textFields()) {
      assert.ok(!/[<>]/.test(value), `${where} contains an angle bracket: ${value}`);
    }
  });

  it("never uses the word roadmap", () => {
    for (const [where, value] of textFields()) {
      assert.ok(!/roadmap/i.test(value), `${where} uses roadmap: ${value}`);
    }
  });

  it("never reads as a roadmap on an open island or on a path to one", () => {
    const flagged = new Set(openIslands.map((island) => island.id));
    for (const island of openIslands) {
      for (const key of ["name", "teaser", "label", "note"]) {
        if (island[key] === undefined) continue;
        assert.ok(!ROADMAP_WORDS.test(island[key]), `island ${island.id}.${key} promises something: ${island[key]}`);
      }
    }
    for (const edge of EDGES.filter((candidate) => flagged.has(candidate.a) || flagged.has(candidate.b))) {
      assert.ok(!ROADMAP_WORDS.test(edge.label), `edge ${edge.a}|${edge.b} promises something: ${edge.label}`);
    }
  });

  it("never says an island was learned", () => {
    for (const [where, value] of visibleFields()) {
      assert.ok(!/\blearned\b/i.test(value), `${where} says learned: ${value}`);
    }
  });

  it("keeps visible text free of control characters and line breaks", () => {
    for (const [where, value] of visibleFields()) {
      assert.ok(!/[\u0000-\u001f]/.test(value), `${where} has a control character`);
    }
  });
});

describe("first-load facts", () => {
  it("opens on Your internet bill", () => {
    assert.equal(byId.get(START_ID).name, "Your internet bill");
  });

  it("offers the first suggestion", () => {
    assert.equal(FIRST_SUGGESTION, "Who actually pays the apps I use?");
  });

  it("captions the edge dragon", () => {
    assert.equal(EDGE_DRAGON_CAPTION, "Unfinished. You will get here.");
  });
});

describe("no quotation of the summary is served (F13)", () => {
  it("has no anchor key anywhere in the graph objects", () => {
    const found = [];
    for (const [name, value] of [["ISLANDS", ISLANDS], ["EDGES", EDGES], ["REGIONS", REGIONS], ["VIEWBOX", VIEWBOX]]) {
      walkKeys(value, (key, path) => {
        if (/anchor/i.test(key)) found.push(`${name}${path.slice(1)}`);
      });
    }
    assert.deepEqual(found, []);
  });

  it("keeps only a section number in every trace entry", () => {
    for (const island of ISLANDS) {
      for (const entry of island.trace) assert.deepEqual(Object.keys(entry), ["section"], `${island.id} trace`);
    }
    for (const edge of EDGES) assert.deepEqual(Object.keys(edge.trace), ["section"], `${edge.a}|${edge.b} trace`);
  });

  it("does not name an anchor field in the code of atlas-graph.js", () => {
    const source = readFileSync(repo("site", "js", "atlas-graph.js"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/anchor/i.test(code), "atlas-graph.js code mentions an anchor");
  });

  it("copies no fixture anchor into any file under site/", () => {
    const anchors = [
      ...Object.values(fixture.islands).flat(),
      ...Object.values(fixture.edges),
    ].map((anchor) => squash(anchor).toLowerCase());
    assert.ok(anchors.length >= ISLANDS.length + EDGES.length);
    const files = filesUnder(repo("site"));
    assert.ok(files.length >= 10, `site/ files: ${files.length}`);
    const leaks = new Set();
    for (const file of files) {
      // Compared without regard to case, quote style and line breaks: a label that only lower-cases a quotation still copies it.
      const text = squash(readFileSync(file, "utf8")).toLowerCase();
      for (const anchor of anchors) {
        if (text.includes(anchor)) leaks.add(`${file.slice(ROOT.length)}: ${anchor}`);
      }
    }
    assert.deepEqual([...leaks], []);
  });
});

describe("the trace fixture", () => {
  const anchorsOfIslands = Object.entries(fixture.islands).flatMap(([id, list]) =>
    list.map((anchor, position) => [`island ${id} trace[${position}]`, anchor]),
  );
  const anchorsOfEdges = Object.entries(fixture.edges).map(([key, anchor]) => [`edge ${key}`, anchor]);

  it("has exactly the keys summary_sha256, islands and edges", () => {
    assert.deepEqual(Object.keys(fixture).sort(), ["edges", "islands", "summary_sha256"]);
  });

  it("is the summary embedded in the brain: its hash is the sha256 of the embedded source", () => {
    assert.match(fixture.summary_sha256, /^[0-9a-f]{64}$/);
    assert.equal(fixture.summary_sha256, notes.sha256);
  });

  it("has an entry for every island and no other", () => {
    assert.deepEqual(Object.keys(fixture.islands).sort(), [...ids].sort());
  });

  it("has one anchor string per trace entry of every island", () => {
    for (const island of ISLANDS) {
      const list = fixture.islands[island.id];
      assert.ok(Array.isArray(list), `${island.id} has no anchor list`);
      assert.equal(list.length, island.trace.length, `${island.id}: ${list.length} anchors for ${island.trace.length} traces`);
      list.forEach((anchor, position) => assert.ok(isNonEmptyString(anchor), `${island.id} anchor ${position}`));
    }
  });

  it("has an entry for every edge, keyed by the sorted edgeKey, and no other", () => {
    const keys = Object.keys(fixture.edges);
    assert.deepEqual(keys.slice().sort(), EDGES.map((edge) => edgeKey(edge.a, edge.b)).sort());
    for (const key of keys) {
      const ends = key.split("|");
      assert.equal(ends.length, 2, `edge key ${key}`);
      assert.equal(key, edgeKey(ends[0], ends[1]), `edge key ${key} is not sorted the way edgeKey sorts it`);
      assert.ok(isNonEmptyString(fixture.edges[key]), `edge ${key} anchor`);
    }
  });

  it("gives every anchor at least 20 characters and 4 words", () => {
    assert.ok(anchorsOfIslands.length >= ISLANDS.length);
    const bad = [...anchorsOfIslands, ...anchorsOfEdges].filter(([, anchor]) => {
      const text = squash(anchor);
      return text.length < 20 || text.split(" ").length < 4;
    });
    assert.deepEqual(
      bad.map(([where, anchor]) => `${where}: ${anchor}`),
      [],
    );
  });

  it("records the revision of the summary in the graph header", () => {
    const source = readFileSync(repo("site", "js", "atlas-graph.js"), "utf8");
    const header = source.slice(0, source.indexOf("export const VIEWBOX"));
    assert.ok(header.includes(`knowledge/brain/${notes.release}`), `header does not name ${notes.release}`);
    assert.ok(header.includes(`${notes.bytes.toLocaleString("en-US")} bytes`), `header does not give ${notes.bytes} bytes`);
    assert.match(header, new RegExp(`sha256[\\s*]+${notes.sha256}`));
    assert.equal(notes.sha256, fixture.summary_sha256);
  });
});
