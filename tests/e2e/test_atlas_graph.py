"""Atlas graph grounding: every quotation that backs the graph must occur in the summary.

site/js/atlas-graph.js keeps only the SECTION of the summary behind each island and each path. The
verbatim quotations (anchors) live in the unserved fixture tests/fixtures/atlas-trace.json, keyed by
island id (one anchor per trace entry) and by edgeKey (one anchor per path). Node dumps the graph as
JSON. Python reads the local draft brain, cuts the embedded source notes out of it, splits them into
the preamble and sections 1..10, and checks the fixture and the graph against that text:

* each anchor occurs verbatim (whitespace collapsed, curly quotes straight) in the section it names,
  has at least 20 characters and 4 words, and the fixture hash is the hash of the embedded source;
* sections 1..10 are all cited, and every bullet of section 10 (counted from the brain, never from a
  list in this file) is covered by a dragon that cites it;
* every open island rests on a passage that the summary itself calls open, and every path to a
  contested or open island says so in its label;
* the brain still equals the live notes file. This fails on drift. Skip it only when the file is
  absent or ESP_ALLOW_NOTES_DRIFT=1 (the same opt-out as tests/unit/test_local_draft_brain.py).

What this cannot decide: whether a label or a teaser is a faithful, no stronger paraphrase of its
quotation. That needs a human read. The graph integrity rules live in atlas_graph.test.mjs.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import pytest

from knowledge.release.local_draft import load_brain

ROOT = Path(__file__).resolve().parents[2]
GRAPH_MODULE = ROOT / "site" / "js" / "atlas-graph.js"
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "atlas-trace.json"
DRIFT_OPT_OUT = "ESP_ALLOW_NOTES_DRIFT"
PREAMBLE = "preamble"
SECTION_NUMBERS = tuple(range(1, 11))
MIN_ANCHOR_CHARS = 20
MIN_ANCHOR_WORDS = 4
OPEN_LABEL = "open, not ratified"
CONTESTED_LABEL = "awaits incorporation"

NODE_DUMP = """
import { pathToFileURL } from "node:url";
const { EDGES, ISLANDS, edgeKey } = await import(pathToFileURL(process.argv[1]).href);
process.stdout.write(JSON.stringify({
  islands: ISLANDS.map(({ id, name, region, teaser, label, status, terms, trace }) => (
    { id, name, region, teaser, label, status, terms, trace }
  )),
  edges: EDGES.map(({ a, b, label, trace }) => ({ a, b, key: edgeKey(a, b), label, trace })),
}));
"""

SOURCE_MARKER = re.compile(rb"^----- BEGIN SOURCE ([^\n]*) -----\n", re.MULTILINE)
BEGIN_SOURCE = re.compile(rb"^----- BEGIN SOURCE [^\n]* -----\n", re.MULTILINE)
END_SOURCE = re.compile(rb"^----- END SOURCE [^\n]* -----\n", re.MULTILINE)
HEADING = re.compile(r"^## (\d+)\. ", re.MULTILINE)
BULLET_START = re.compile(r"^- \*\*", re.MULTILINE)
BLANK_LINE = re.compile(r"\n[ \t]*\n")
# What an edge that touches a contested or an open island must say.
QUALIFIER = re.compile(r"\b(?:awaits incorporation|still open|open|not ratified|undefined|deferred|unsealed)\b", re.I)
# Words with which the summary itself marks a passage as not settled.
OPEN_MARKER = re.compile(r"\b(?:unsealed|deferred|undefined|unspecified|unresolved|todo|not ratified)\b", re.I)
PRONOUN_START = re.compile(r"^(?:it|they|this|that|these|those|its|their)\b", re.I)

CURLY_QUOTES = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"'})

type SectionKey = int | str


@dataclass(frozen=True)
class Island:
    id: str
    name: str
    region: str
    teaser: str
    label: str | None
    status: str | None
    terms: tuple[str, ...]
    sections: tuple[SectionKey, ...]


@dataclass(frozen=True)
class Edge:
    a: str
    b: str
    key: str
    label: str
    section: SectionKey

    @property
    def name(self) -> str:
        return f"{self.a}|{self.b}"


@dataclass(frozen=True)
class Graph:
    islands: tuple[Island, ...]
    edges: tuple[Edge, ...]


@dataclass(frozen=True)
class Fixture:
    """tests/fixtures/atlas-trace.json: the quotations behind the graph, one per trace entry and per path."""

    summary_sha256: str
    islands: Mapping[str, tuple[str, ...]]
    edges: Mapping[str, str]
    top_level_keys: tuple[str, ...]


def _mapping(value: object, where: str) -> Mapping[str, object]:
    assert isinstance(value, dict), f"{where} is not an object"
    return cast(dict[str, object], value)


def _items(value: object, where: str) -> list[object]:
    assert isinstance(value, list), f"{where} is not an array"
    return cast(list[object], value)


def _text(value: object, where: str) -> str:
    assert isinstance(value, str), f"{where} is not a string"
    return value


def _optional_text(value: object, where: str) -> str | None:
    return None if value is None else _text(value, where)


def _section(value: object, where: str) -> SectionKey:
    if isinstance(value, str):
        assert value == PREAMBLE, f"{where} is {value!r}"
        return value
    assert isinstance(value, int) and not isinstance(value, bool), f"{where} is not a section"
    return value


def _only_section(value: object, where: str) -> SectionKey:
    """A trace entry of the served graph carries a section number and nothing else (no quotation)."""
    fields = _mapping(value, where)
    assert list(fields) == ["section"], f"{where} has keys {list(fields)}; only 'section' may be served"
    return _section(fields["section"], f"{where}.section")


def parse_graph(raw: str) -> Graph:
    root = _mapping(json.loads(raw), "graph")
    islands: list[Island] = []
    for position, entry in enumerate(_items(root.get("islands"), "islands")):
        where = f"islands[{position}]"
        fields = _mapping(entry, where)
        island_id = _text(fields.get("id"), f"{where}.id")
        islands.append(
            Island(
                id=island_id,
                name=_text(fields.get("name"), f"{island_id}.name"),
                region=_text(fields.get("region"), f"{island_id}.region"),
                teaser=_text(fields.get("teaser"), f"{island_id}.teaser"),
                label=_optional_text(fields.get("label"), f"{island_id}.label"),
                status=_optional_text(fields.get("status"), f"{island_id}.status"),
                terms=tuple(
                    _text(term, f"{island_id}.terms[{n}]")
                    for n, term in enumerate(_items(fields.get("terms"), island_id))
                ),
                sections=tuple(
                    _only_section(item, f"{island_id}.trace[{n}]")
                    for n, item in enumerate(_items(fields.get("trace"), island_id))
                ),
            )
        )
    edges: list[Edge] = []
    for position, entry in enumerate(_items(root.get("edges"), "edges")):
        where = f"edges[{position}]"
        fields = _mapping(entry, where)
        edges.append(
            Edge(
                a=_text(fields.get("a"), f"{where}.a"),
                b=_text(fields.get("b"), f"{where}.b"),
                key=_text(fields.get("key"), f"{where}.key"),
                label=_text(fields.get("label"), f"{where}.label"),
                section=_only_section(fields.get("trace"), f"{where}.trace"),
            )
        )
    return Graph(islands=tuple(islands), edges=tuple(edges))


def parse_fixture(raw: str) -> Fixture:
    root = _mapping(json.loads(raw), "fixture")
    islands = {
        island_id: tuple(_text(anchor, f"{island_id}[{n}]") for n, anchor in enumerate(_items(anchors, island_id)))
        for island_id, anchors in _mapping(root.get("islands"), "fixture.islands").items()
    }
    edges = {key: _text(anchor, f"edge {key}") for key, anchor in _mapping(root.get("edges"), "fixture.edges").items()}
    return Fixture(
        summary_sha256=_text(root.get("summary_sha256"), "fixture.summary_sha256"),
        islands=islands,
        edges=edges,
        top_level_keys=tuple(root),
    )


def normalise(text: str) -> str:
    """Curly quotes become straight and every run of whitespace becomes one space."""
    return " ".join(text.translate(CURLY_QUOTES).split())


def embedded_source(brain: bytes) -> bytes:
    """The bytes between the BEGIN SOURCE and END SOURCE marker lines."""
    begins = list(BEGIN_SOURCE.finditer(brain))
    ends = list(END_SOURCE.finditer(brain))
    assert len(begins) == 1, f"BEGIN SOURCE markers: {len(begins)}"
    assert len(ends) == 1, f"END SOURCE markers: {len(ends)}"
    assert begins[0].end() <= ends[0].start()
    return brain[begins[0].end() : ends[0].start()]


def source_path(brain: bytes) -> Path:
    """The notes file the brain says it embeds, read from the BEGIN SOURCE marker line."""
    markers = list(SOURCE_MARKER.finditer(brain))
    assert len(markers) == 1, f"BEGIN SOURCE markers: {len(markers)}"
    return Path(markers[0].group(1).decode("utf-8"))


def split_sections(source: str) -> tuple[str, dict[int, str]]:
    """The raw preamble and the raw text of sections 1..10, each from its heading to the next."""
    headings = list(HEADING.finditer(source))
    numbers = [int(match.group(1)) for match in headings]
    assert numbers == list(SECTION_NUMBERS), f"section headings: {numbers}"
    preamble = source[: headings[0].start()]
    sections: dict[int, str] = {}
    for position, match in enumerate(headings):
        stop = headings[position + 1].start() if position + 1 < len(headings) else len(source)
        sections[int(match.group(1))] = source[match.start() : stop]
    return preamble, sections


@dataclass(frozen=True)
class Notes:
    """The normalised text of the preamble and of each numbered section, and its paragraphs."""

    preamble: str
    sections: Mapping[int, str]
    paragraphs: Mapping[SectionKey, tuple[str, ...]]
    section_ten_bullets: tuple[str, ...]
    awaits_incorporation: int

    def text_for(self, section: SectionKey) -> str:
        if section == PREAMBLE:
            return self.preamble
        assert isinstance(section, int)
        return self.sections[section]


def build_notes(brain: bytes) -> Notes:
    source = embedded_source(brain).decode("utf-8")
    preamble, sections = split_sections(source)
    tail = sections[10]
    starts = [match.start() for match in BULLET_START.finditer(tail)]
    bullets = tuple(
        normalise(tail[start : starts[position + 1] if position + 1 < len(starts) else len(tail)])
        for position, start in enumerate(starts)
    )
    raw: dict[SectionKey, str] = {PREAMBLE: preamble, **sections}
    return Notes(
        preamble=normalise(preamble),
        sections={number: normalise(text) for number, text in sections.items()},
        paragraphs={
            key: tuple(normalise(part) for part in BLANK_LINE.split(text) if part.strip()) for key, text in raw.items()
        },
        section_ten_bullets=bullets,
        awaits_incorporation=len(re.findall(r"awaits incorporation", source)),
    )


@pytest.fixture(scope="module")
def graph() -> Graph:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    completed = subprocess.run(
        [node, "--input-type=module", "-e", NODE_DUMP, str(GRAPH_MODULE)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert completed.returncode == 0, completed.stderr
    return parse_graph(completed.stdout)


@pytest.fixture(scope="module")
def fixture() -> Fixture:
    return parse_fixture(FIXTURE_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def notes() -> Notes:
    return build_notes(load_brain())


def _words(text: str) -> int:
    return len(normalise(text).split(" "))


def _island_anchors(island: Island, fixture: Fixture) -> list[tuple[SectionKey, str]]:
    """The (section, anchor) of each trace entry of an island, joined to the fixture by island id."""
    anchors = fixture.islands.get(island.id, ())
    assert len(anchors) == len(island.sections), (
        f"island {island.id}: {len(anchors)} anchors, {len(island.sections)} traces"
    )
    return list(zip(island.sections, anchors, strict=True))


def _anchor_pairs(graph: Graph, fixture: Fixture) -> list[tuple[str, SectionKey, str]]:
    """Every (label, section, anchor) of the graph that has an anchor in the fixture, island traces then paths."""
    pairs: list[tuple[str, SectionKey, str]] = []
    for island in graph.islands:
        pairs.extend(
            (f"island {island.id} trace[{n}]", section, anchor)
            for n, (section, anchor) in enumerate(_island_anchors(island, fixture))
        )
    for edge in graph.edges:
        assert edge.key in fixture.edges, f"edge {edge.key} has no anchor in the fixture"
        pairs.append((f"edge {edge.name}", edge.section, fixture.edges[edge.key]))
    return pairs


def _ungrounded(label: str, section: SectionKey, anchor: str, notes: Notes) -> str | None:
    quote = normalise(anchor)
    if not quote:
        return f"{label}: empty anchor"
    if section != PREAMBLE and section not in notes.sections:
        return f"{label}: no such section {section!r}"
    if quote not in notes.text_for(section):
        return f"{label}: not in section {section!r}: {anchor!r}"
    return None


def test_graph_dump_is_not_empty(graph: Graph) -> None:
    assert 55 <= len(graph.islands) <= 65
    assert 80 <= len(graph.edges) <= 100
    assert len({island.id for island in graph.islands}) == len(graph.islands)
    assert len({edge.key for edge in graph.edges}) == len(graph.edges)


def test_brain_is_the_draft_with_the_source_notes_inside(notes: Notes) -> None:
    assert sorted(notes.sections) == list(SECTION_NUMBERS)
    assert "awaits incorporation into the authoritative design and message catalogue" in notes.preamble
    assert notes.awaits_incorporation >= 1
    assert len(notes.section_ten_bullets) >= 1
    # A second way to count the bullets of section 10: the blocks of that section that open a bullet.
    blocks = [block for block in notes.paragraphs[10] if block.startswith("- **")]
    assert len(blocks) == len(notes.section_ten_bullets)


def test_embedded_source_is_the_notes_file() -> None:
    """The brain embeds the notes byte for byte. A changed notes file fails: re-ground the graph and the fixture.

    Skips only when the notes file is absent or ESP_ALLOW_NOTES_DRIFT=1 (as tests/unit/test_local_draft_brain.py).
    """
    brain = load_brain()
    path = source_path(brain)
    if not path.is_file():
        pytest.skip(f"{path} is not available")
    if os.environ.get(DRIFT_OPT_OUT) == "1":
        pytest.skip(f"{DRIFT_OPT_OUT}=1: the live notes file is not compared with the embedded source")
    embedded = embedded_source(brain)
    live = path.read_bytes()
    embedded_digest = hashlib.sha256(embedded).hexdigest()
    live_digest = hashlib.sha256(live).hexdigest()
    assert live_digest == embedded_digest, (
        f"the notes file changed after the brain was built: the brain embeds {len(embedded)} bytes "
        f"(sha256 {embedded_digest[:12]}) but the notes file has {len(live)} bytes (sha256 {live_digest[:12]}); "
        "republish the brain, then re-ground the Atlas graph and tests/fixtures/atlas-trace.json"
    )
    assert live == embedded


def test_fixture_hash_is_the_hash_of_the_embedded_source(fixture: Fixture) -> None:
    embedded = embedded_source(load_brain())
    assert fixture.summary_sha256 == hashlib.sha256(embedded).hexdigest()
    assert sorted(fixture.top_level_keys) == ["edges", "islands", "summary_sha256"]


def test_fixture_keys_match_the_graph(graph: Graph, fixture: Fixture) -> None:
    assert sorted(fixture.islands) == sorted(island.id for island in graph.islands)
    assert sorted(fixture.edges) == sorted(edge.key for edge in graph.edges)
    for edge in graph.edges:
        assert edge.key == "|".join(sorted((edge.a, edge.b))), f"edge key {edge.key} is not the sorted pair"
    for key in fixture.edges:
        assert key == "|".join(sorted(key.split("|"))) and key.count("|") == 1, f"edge key {key} is not sorted"
    for island in graph.islands:
        assert len(fixture.islands[island.id]) == len(island.sections), f"island {island.id}: anchors vs trace entries"


def test_every_anchor_has_at_least_20_characters_and_4_words(graph: Graph, fixture: Fixture) -> None:
    pairs = _anchor_pairs(graph, fixture)
    short = [f"{label}: {anchor!r}" for label, _, anchor in pairs if len(normalise(anchor)) < MIN_ANCHOR_CHARS]
    few = [f"{label}: {anchor!r}" for label, _, anchor in pairs if _words(anchor) < MIN_ANCHOR_WORDS]
    assert short == []
    assert few == []


def test_every_island_has_a_trace(graph: Graph) -> None:
    assert [island.id for island in graph.islands if not island.sections] == []


def test_every_island_trace_anchor_is_verbatim_in_its_section(graph: Graph, fixture: Fixture, notes: Notes) -> None:
    problems = [
        problem
        for label, section, anchor in _anchor_pairs(graph, fixture)
        if label.startswith("island ") and (problem := _ungrounded(label, section, anchor, notes)) is not None
    ]
    assert problems == []


def test_every_edge_anchor_is_verbatim_in_its_section(graph: Graph, fixture: Fixture, notes: Notes) -> None:
    problems = [
        problem
        for label, section, anchor in _anchor_pairs(graph, fixture)
        if label.startswith("edge ") and (problem := _ungrounded(label, section, anchor, notes)) is not None
    ]
    assert problems == []


def test_island_traces_cover_sections_one_to_ten(graph: Graph) -> None:
    cited = {section for island in graph.islands for section in island.sections}
    assert set(SECTION_NUMBERS) <= cited, f"sections never cited by an island: {sorted(set(SECTION_NUMBERS) - cited)}"


def test_all_traces_together_cover_sections_one_to_ten(graph: Graph) -> None:
    cited = {section for island in graph.islands for section in island.sections}
    cited |= {edge.section for edge in graph.edges}
    assert set(SECTION_NUMBERS) <= cited, f"sections never cited: {sorted(set(SECTION_NUMBERS) - cited)}"


def _section_ten_dragon_anchors(graph: Graph, fixture: Fixture) -> dict[str, list[str]]:
    """For each dragon island, the normalised anchors of its section 10 trace entries."""
    found: dict[str, list[str]] = {}
    for island in graph.islands:
        anchors = [
            normalise(anchor)
            for section, anchor in _island_anchors(island, fixture)
            if section == 10 and island.region == "dragons"
        ]
        if anchors:
            found[island.id] = anchors
    return found


def test_each_section_ten_bullet_is_covered_by_a_dragon_trace(graph: Graph, fixture: Fixture, notes: Notes) -> None:
    by_dragon = _section_ten_dragon_anchors(graph, fixture)
    uncovered = [
        bullet[:80]
        for bullet in notes.section_ten_bullets
        if not any(anchor in bullet for anchors in by_dragon.values() for anchor in anchors)
    ]
    assert uncovered == []
    assert len(by_dragon) >= len(notes.section_ten_bullets), (
        f"{len(by_dragon)} dragons cite section 10 for {len(notes.section_ten_bullets)} bullets"
    )
    orphans = [
        anchor
        for anchors in by_dragon.values()
        for anchor in anchors
        if not any(anchor in bullet for bullet in notes.section_ten_bullets)
    ]
    assert orphans == []


def test_every_section_ten_trace_belongs_to_a_dragon(graph: Graph) -> None:
    assert [island.id for island in graph.islands if 10 in island.sections and island.region != "dragons"] == []


def test_every_open_island_rests_on_a_passage_the_summary_calls_open(
    graph: Graph, fixture: Fixture, notes: Notes
) -> None:
    """A dragon is grounded in section 10, or in a paragraph that says unsealed, deferred, undefined and the like."""
    ungrounded: list[str] = []
    for island in graph.islands:
        if island.status != "open":
            continue
        anchors = [(section, normalise(anchor)) for section, anchor in _island_anchors(island, fixture)]
        grounded = any(
            section == 10 or any(anchor in block and OPEN_MARKER.search(block) for block in notes.paragraphs[section])
            for section, anchor in anchors
        )
        if not grounded:
            ungrounded.append(island.id)
    assert ungrounded == []


def test_open_and_contested_islands_carry_their_exact_label(graph: Graph, notes: Notes) -> None:
    for island in graph.islands:
        if island.status == "open":
            assert island.label == OPEN_LABEL, island.id
            assert island.region == "dragons", f"{island.id} is open outside the dragons"
        elif island.status == "contested":
            assert island.label == CONTESTED_LABEL, island.id
        else:
            assert island.status is None and island.label is None, f"{island.id}: {island.status!r} {island.label!r}"
            assert island.region != "dragons", f"{island.id} is in the dragons but not open"
    contested = [island.id for island in graph.islands if island.status == "contested"]
    assert len(contested) == notes.awaits_incorporation, f"contested islands {contested} vs the summary's flags"


def test_every_path_to_a_contested_or_open_island_says_so(graph: Graph) -> None:
    flagged = {island.id for island in graph.islands if island.status in {"open", "contested"}}
    unqualified = [
        f"{edge.name}: {edge.label}"
        for edge in graph.edges
        if (edge.a in flagged or edge.b in flagged) and not QUALIFIER.search(edge.label)
    ]
    assert unqualified == []


def test_path_labels_are_short_and_do_not_open_with_a_pronoun(graph: Graph) -> None:
    assert [f"{edge.name}: {edge.label}" for edge in graph.edges if not 3 <= len(edge.label) <= 60] == []
    assert [f"{edge.name}: {edge.label}" for edge in graph.edges if PRONOUN_START.match(edge.label)] == []


def test_names_teasers_and_terms_are_well_formed_and_never_say_learned(graph: Graph) -> None:
    problems: list[str] = []
    for island in graph.islands:
        if not island.name or len(island.name) > 36:
            problems.append(f"{island.id}: name {island.name!r}")
        if not island.teaser.endswith("?") or len(island.teaser) > 90:
            problems.append(f"{island.id}: teaser {island.teaser!r}")
        if not island.terms or any(not term.strip() for term in island.terms):
            problems.append(f"{island.id}: terms {island.terms!r}")
        if island.status == "open" and re.search(r"\b(?:will|roadmap|next steps?)\b", island.teaser, re.I):
            problems.append(f"{island.id}: the open teaser reads as a promise: {island.teaser!r}")
        visible = [island.name, island.teaser, island.label or ""]
        if any(re.search(r"\blearned\b", text, re.I) for text in visible):
            problems.append(f"{island.id}: says learned")
    assert problems == []
    assert [edge.name for edge in graph.edges if re.search(r"\blearned\b", edge.label, re.I)] == []
