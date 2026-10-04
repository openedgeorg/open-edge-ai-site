"""Exact published versions and citation checks against authorized native provenance."""

from __future__ import annotations

from dataclasses import dataclass, field

from pydantic import BaseModel, Field

from esp_contracts.api import STRICT, Citation
from esp_contracts.knowledge import (
    AssetRecord,
    CitationVerification,
    KnowledgeErr,
    KnowledgeOk,
    SourceRecord,
    err,
)

_UNSAFE = ("javascript:", "data:", "vbscript:", "http:", "https:", "//")
_ASSET_MIME = frozenset({"image/png", "image/jpeg", "image/webp", "text/plain"})


class ProvenanceExcerpt(BaseModel):
    """One quote observed in owner-authorized native history. Not a model claim."""

    model_config = STRICT
    conversation_id: str = Field(min_length=1)
    source_id: str = Field(min_length=1)
    version: str = Field(min_length=1)
    locator: str = Field(min_length=1)
    quote: str


class AuthorizedNativeProvenance(BaseModel):
    """Provenance for one conversation. Excerpts from any other conversation do not verify."""

    model_config = STRICT
    conversation_id: str = Field(min_length=1)
    excerpts: list[ProvenanceExcerpt]


def _sources() -> dict[tuple[str, str], SourceRecord]:
    return {}


def _assets() -> dict[tuple[str, str], AssetRecord]:
    return {}


@dataclass
class PublishedCatalog:
    """Manifest-listed public objects. A protected credential is off unless a test turns it on."""

    sources: dict[tuple[str, str], SourceRecord] = field(default_factory=_sources)
    assets: dict[tuple[str, str], AssetRecord] = field(default_factory=_assets)
    allow_protected: bool = False


def get_published_source(
    source_id: str,
    version: str,
    *,
    catalog: PublishedCatalog | None = None,
) -> KnowledgeOk[SourceRecord] | KnowledgeErr:
    store = catalog if catalog is not None else PublishedCatalog()
    record = store.sources.get((source_id, version))
    if record is None:
        return err("not_found")
    if record.metadata.visibility != "public" and not store.allow_protected:
        return err("forbidden")
    if not _safe_ref(record.original_bytes_ref):
        return err("forbidden")
    return KnowledgeOk(corpus_release_id=record.metadata.source_id, data=record, sources=[record.metadata])


def get_published_asset(
    asset_id: str,
    version: str,
    *,
    catalog: PublishedCatalog | None = None,
) -> KnowledgeOk[AssetRecord] | KnowledgeErr:
    store = catalog if catalog is not None else PublishedCatalog()
    record = store.assets.get((asset_id, version))
    if record is None:
        return err("not_found")
    if record.visibility != "public" and not store.allow_protected:
        return err("forbidden")
    if record.mime not in _ASSET_MIME or not _safe_ref(record.object_ref):
        return err("forbidden")
    return KnowledgeOk(corpus_release_id=record.source_id, data=record, sources=[])


def verify_citation(
    citation: Citation,
    provenance: AuthorizedNativeProvenance,
    source: SourceRecord | None,
) -> CitationVerification:
    """Match locator bytes to the same conversation. A withdrawn version is unavailable."""
    if source is not None and source.metadata.status == "withdrawn":
        return CitationVerification(
            state="unavailable",
            source_id=citation.source_id,
            version=citation.version,
            locator=citation.locator,
        )
    if source is None or _unsafe(citation.locator) or source.metadata.status != "active":
        return CitationVerification(state="unverified", source_id=citation.source_id, version=citation.version)
    if source.metadata.source_id != citation.source_id or source.metadata.version != citation.version:
        return CitationVerification(state="unverified", source_id=citation.source_id, version=citation.version)
    excerpt = _matching_excerpt(citation, provenance)
    slice_text = _slice(source)
    quote = citation.quote if citation.quote is not None else slice_text
    if excerpt is None or quote != excerpt.quote or quote != slice_text or excerpt.quote != slice_text:
        return CitationVerification(
            state="unverified",
            source_id=citation.source_id,
            version=citation.version,
            locator=citation.locator,
        )
    return CitationVerification(
        state="verified",
        source_id=citation.source_id,
        version=citation.version,
        locator=citation.locator,
    )


def _matching_excerpt(citation: Citation, provenance: AuthorizedNativeProvenance) -> ProvenanceExcerpt | None:
    for excerpt in provenance.excerpts:
        if excerpt.conversation_id != provenance.conversation_id:
            continue
        if excerpt.source_id != citation.source_id or excerpt.version != citation.version:
            continue
        if excerpt.locator != citation.locator:
            continue
        return excerpt
    return None


def _slice(source: SourceRecord) -> str:
    start = source.metadata.locator_start
    end = source.metadata.locator_end
    return source.text[start:end]


def _unsafe(locator: str) -> bool:
    lowered = locator.strip().lower()
    return lowered.startswith(_UNSAFE) or "<" in locator or ">" in locator


def _safe_ref(ref: str) -> bool:
    if not ref or ref.startswith(_UNSAFE) or ref.startswith("/") or ".." in ref:
        return False
    return all(character.isalnum() or character in "._/-" for character in ref)
