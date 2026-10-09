/**
 * Atlas graph integrity: the shape, the status rules and the honesty rules of
 * site/js/atlas-graph.js. Grounding against the brain text lives in test_atlas_graph.py.
 * Run with: node --test tests/e2e/atlas_graph.test.mjs
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
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

/** The lead phrase of each of the nine bullets of section 10 of the summary. */
const SECTION_10_BULLETS = [
  "Epoch tariff agreements still need a format and evidence specification",
  "The ISP credit policy still needs numerical calibration",
  "Dishonest-ISP analysis remains incomplete",
  "ISP-and-app collusion still has an undefeated silent-padding form",
  "Several production anti-collusion mechanisms remain candidates",
  "Borrow-and-default replaces consumption-weighted allocation farming",
  "Production needs a durable second instance",
  "Production needs a deliberate finality and clawback horizon",
  "ISP fronting of household shortfalls remains optional future work",
];

const ids = ISLANDS.map((island) => island.id);
const idSet = new Set(ids);
const byId = new Map(ISLANDS.map((island) => [island.id, island]));
const index = buildIndex();

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** @param {unknown} section */
function isValidSection(section) {
  return section === "preamble" || (Number.isInteger(section) && section >= 1 && section <= 10);
}

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

/** @param {string} startId */
function reachableFrom(startId) {
  const seen = new Set([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of index.neighbours.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
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
    const seen = reachableFrom(START_ID);
    const missing = ids.filter((id) => !seen.has(id));
    assert.deepEqual(missing, [], `unreachable from ${START_ID}`);
  });

  it("gives the start island at least three neighbours", () => {
    assert.ok(index.neighbours.get(START_ID).size >= 3, `neighbours: ${index.neighbours.get(START_ID).size}`);
  });

  it("gives every edge a 3..60 character label and a traced anchor", () => {
    for (const edge of EDGES) {
      const where = `edge ${edge.a}|${edge.b}`;
      assert.ok(isNonEmptyString(edge.label), `${where} label`);
      assert.ok(edge.label.length >= 3 && edge.label.length <= 60, `${where} label length ${edge.label.length}`);
      assert.ok(edge.trace && typeof edge.trace === "object", `${where} trace`);
      assert.ok(isValidSection(edge.trace.section), `${where} trace section ${edge.trace.section}`);
      assert.ok(isNonEmptyString(edge.trace.anchor), `${where} trace anchor`);
    }
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

  it("traces every island to at least one section 1..10 or the preamble with an anchor", () => {
    for (const island of ISLANDS) {
      assert.ok(Array.isArray(island.trace) && island.trace.length >= 1, `${island.id} trace`);
      for (const entry of island.trace) {
        assert.ok(isValidSection(entry.section), `${island.id} trace section ${entry.section}`);
        assert.ok(isNonEmptyString(entry.anchor), `${island.id} trace anchor`);
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

  it("places every island inside the viewBox", () => {
    assert.ok(VIEWBOX.width > 0 && VIEWBOX.height > 0);
    for (const island of ISLANDS) {
      assert.ok(Number.isFinite(island.x) && Number.isFinite(island.y), `${island.id} position`);
      assert.ok(island.x > 0 && island.x < VIEWBOX.width, `${island.id} x ${island.x}`);
      assert.ok(island.y > 0 && island.y < VIEWBOX.height, `${island.id} y ${island.y}`);
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
  });

  it("marks every dragon open with the exact label", () => {
    const dragons = ISLANDS.filter((island) => island.region === "dragons");
    assert.ok(dragons.length >= 1);
    for (const island of dragons) {
      assert.equal(island.status, "open", `${island.id} status`);
      assert.equal(island.label, "open, not ratified", `${island.id} label`);
    }
  });

  it("marks nothing outside the dragons region open", () => {
    const strays = ISLANDS.filter((island) => island.status === "open" && island.region !== "dragons");
    assert.deepEqual(
      strays.map((island) => island.id),
      [],
    );
    for (const island of ISLANDS.filter((candidate) => candidate.region !== "dragons")) {
      assert.notEqual(island.label, "open, not ratified", `${island.id} borrows the dragon label`);
    }
  });

  it("marks exactly the epoch price catalogue contested", () => {
    const contested = ISLANDS.filter((island) => island.status === "contested");
    assert.equal(contested.length, 1, `contested: ${contested.map((island) => island.id).join(", ")}`);
    assert.equal(contested[0].id, "price-catalogue");
    assert.match(contested[0].name, /price catalogue/i);
    assert.equal(contested[0].label, "awaits incorporation");
  });

  it("has the post-pilot emergency settlement dragon", () => {
    const island = byId.get("post-pilot-emergency");
    assert.ok(island, "post-pilot-emergency island is missing");
    assert.equal(island.region, "dragons");
    assert.equal(island.status, "open");
    assert.match(island.name, /post-pilot emergency settlement/i);
    assert.ok(island.trace.some((entry) => entry.section === 6 && /post-pilot/.test(entry.anchor)));
  });

  it("covers each of the nine bullets of section 10 with a dragon traced to section 10", () => {
    const dragons = ISLANDS.filter((island) => island.region === "dragons");
    for (const bullet of SECTION_10_BULLETS) {
      const match = dragons.find((island) =>
        island.trace.some((entry) => entry.section === 10 && entry.anchor.startsWith(bullet)),
      );
      assert.ok(match, `no dragon traced to section 10 for: ${bullet}`);
    }
    const covering = dragons.filter((island) => island.trace.some((entry) => entry.section === 10));
    assert.ok(covering.length >= SECTION_10_BULLETS.length, `dragons tracing section 10: ${covering.length}`);
  });

  it("ties every section 10 trace on an island to a dragon", () => {
    for (const island of ISLANDS) {
      if (island.trace.some((entry) => entry.section === 10)) {
        assert.equal(island.region, "dragons", `${island.id} cites section 10 outside the dragons`);
      }
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
