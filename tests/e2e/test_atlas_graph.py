"""Atlas graph grounding. Every trace anchor must occur verbatim in the section of the brain it names.

Node dumps the graph from site/js/atlas-graph.js as JSON. Python reads the local draft brain,
cuts the embedded source notes out of it, splits them into the preamble and sections 1..10,
and checks each island trace and each edge trace against the text of the section it cites.
The graph integrity rules live in atlas_graph.test.mjs.
"""

from __future__ import annotations

import hashlib
import json
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
SOURCE_PATH = Path("/home/ibmko/lab/oe/materials/Whitepaper/v0.2/notes-allowance-architecture-summary.md")
PREAMBLE = "preamble"
SECTION_NUMBERS = tuple(range(1, 11))

NODE_DUMP = """
import { pathToFileURL } from "node:url";
const { EDGES, ISLANDS } = await import(pathToFileURL(process.argv[1]).href);
process.stdout.write(JSON.stringify({
  islands: ISLANDS.map(({ id, trace }) => ({ id, trace })),
  edges: EDGES.map(({ a, b, trace }) => ({ a, b, trace })),
}));
"""

BEGIN_SOURCE = re.compile(rb"^----- BEGIN SOURCE [^\n]* -----\n", re.MULTILINE)
END_SOURCE = re.compile(rb"^----- END SOURCE [^\n]* -----\n", re.MULTILINE)
HEADING = re.compile(r"^## (\d+)\. ", re.MULTILINE)
BULLET_START = re.compile(r"^- \*\*", re.MULTILINE)

CURLY_QUOTES = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"'})

type SectionKey = int | str


@dataclass(frozen=True)
class Trace:
    section: SectionKey
    anchor: str


@dataclass(frozen=True)
class Island:
    id: str
    trace: tuple[Trace, ...]


@dataclass(frozen=True)
class Edge:
    a: str
    b: str
    trace: Trace

    @property
    def name(self) -> str:
        return f"{self.a}|{self.b}"


@dataclass(frozen=True)
class Graph:
    islands: tuple[Island, ...]
    edges: tuple[Edge, ...]


def _mapping(value: object, where: str) -> Mapping[str, object]:
    assert isinstance(value, dict), f"{where} is not an object"
    return cast(dict[str, object], value)


def _items(value: object, where: str) -> list[object]:
    assert isinstance(value, list), f"{where} is not an array"
    return cast(list[object], value)


def _text(value: object, where: str) -> str:
    assert isinstance(value, str), f"{where} is not a string"
    return value


def _section(value: object, where: str) -> SectionKey:
    if isinstance(value, str):
        assert value == PREAMBLE, f"{where} is {value!r}"
        return value
    assert isinstance(value, int) and not isinstance(value, bool), f"{where} is not a section"
    return value


def _trace(value: object, where: str) -> Trace:
    fields = _mapping(value, where)
    return Trace(
        section=_section(fields.get("section"), f"{where}.section"),
        anchor=_text(fields.get("anchor"), f"{where}.anchor"),
    )


def parse_graph(raw: str) -> Graph:
    root = _mapping(json.loads(raw), "graph")
    islands: list[Island] = []
    for position, entry in enumerate(_items(root.get("islands"), "islands")):
        fields = _mapping(entry, f"islands[{position}]")
        island_id = _text(fields.get("id"), f"islands[{position}].id")
        traces = tuple(
            _trace(item, f"{island_id}.trace[{n}]") for n, item in enumerate(_items(fields.get("trace"), island_id))
        )
        islands.append(Island(id=island_id, trace=traces))
    edges: list[Edge] = []
    for position, entry in enumerate(_items(root.get("edges"), "edges")):
        fields = _mapping(entry, f"edges[{position}]")
        edges.append(
            Edge(
                a=_text(fields.get("a"), f"edges[{position}].a"),
                b=_text(fields.get("b"), f"edges[{position}].b"),
                trace=_trace(fields.get("trace"), f"edges[{position}].trace"),
            )
        )
    return Graph(islands=tuple(islands), edges=tuple(edges))


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
    """The normalised text of the preamble and of each numbered section."""

    preamble: str
    sections: Mapping[int, str]
    section_ten_bullets: tuple[str, ...]

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
    return Notes(
        preamble=normalise(preamble),
        sections={number: normalise(text) for number, text in sections.items()},
        section_ten_bullets=bullets,
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
def notes() -> Notes:
    return build_notes(load_brain())


def _ungrounded(label: str, trace: Trace, notes: Notes) -> str | None:
    anchor = normalise(trace.anchor)
    if not anchor:
        return f"{label}: empty anchor"
    if trace.section != PREAMBLE and trace.section not in notes.sections:
        return f"{label}: no such section {trace.section!r}"
    if anchor not in notes.text_for(trace.section):
        return f"{label}: not in section {trace.section!r}: {trace.anchor!r}"
    return None


def test_graph_dump_is_not_empty(graph: Graph) -> None:
    assert len(graph.islands) >= 55
    assert len(graph.edges) >= 80


def test_brain_is_the_draft_with_the_source_notes_inside(notes: Notes) -> None:
    assert sorted(notes.sections) == list(SECTION_NUMBERS)
    assert "awaits incorporation into the authoritative design and message catalogue" in notes.preamble
    assert len(notes.section_ten_bullets) == 9


def test_embedded_source_is_the_notes_file() -> None:
    """The brain embeds the notes byte for byte. The owner keeps editing the live file, so drift skips."""
    if not SOURCE_PATH.exists():
        pytest.skip(f"{SOURCE_PATH} is not available")
    embedded = embedded_source(load_brain())
    current = SOURCE_PATH.read_bytes()
    embedded_digest = hashlib.sha256(embedded).hexdigest()
    current_digest = hashlib.sha256(current).hexdigest()
    if current_digest != embedded_digest:
        pytest.skip(
            f"the live notes file changed after the brain was built: the brain embeds {len(embedded)} bytes "
            f"(sha256 {embedded_digest[:12]}) but the notes file has {len(current)} bytes "
            f"(sha256 {current_digest[:12]}); the graph is grounded in the brain, not in the live file"
        )
    assert embedded == current, (
        f"the brain embeds {len(embedded)} bytes (sha256 {embedded_digest[:12]}) "
        f"but the notes file has {len(current)} bytes (sha256 {current_digest[:12]})"
    )


def test_every_island_has_a_trace(graph: Graph) -> None:
    assert [island.id for island in graph.islands if not island.trace] == []


def test_every_island_trace_anchor_is_verbatim_in_its_section(graph: Graph, notes: Notes) -> None:
    problems = [
        problem
        for island in graph.islands
        for n, trace in enumerate(island.trace)
        if (problem := _ungrounded(f"island {island.id} trace[{n}]", trace, notes)) is not None
    ]
    assert problems == []


def test_every_edge_trace_anchor_is_verbatim_in_its_section(graph: Graph, notes: Notes) -> None:
    problems = [
        problem for edge in graph.edges if (problem := _ungrounded(f"edge {edge.name}", edge.trace, notes)) is not None
    ]
    assert problems == []


def test_island_traces_cover_sections_one_to_ten(graph: Graph) -> None:
    cited = {trace.section for island in graph.islands for trace in island.trace}
    assert set(SECTION_NUMBERS) <= cited, f"sections never cited by an island: {sorted(set(SECTION_NUMBERS) - cited)}"


def test_all_traces_together_cover_sections_one_to_ten(graph: Graph) -> None:
    cited = {trace.section for island in graph.islands for trace in island.trace}
    cited |= {edge.trace.section for edge in graph.edges}
    assert set(SECTION_NUMBERS) <= cited, f"sections never cited: {sorted(set(SECTION_NUMBERS) - cited)}"


def test_each_section_ten_bullet_is_covered_by_a_dragon_trace(graph: Graph, notes: Notes) -> None:
    anchors = [normalise(trace.anchor) for island in graph.islands for trace in island.trace if trace.section == 10]
    uncovered = [bullet[:80] for bullet in notes.section_ten_bullets if not any(anchor in bullet for anchor in anchors)]
    assert uncovered == []
    orphans = [anchor for anchor in anchors if not any(anchor in bullet for bullet in notes.section_ten_bullets)]
    assert orphans == []
