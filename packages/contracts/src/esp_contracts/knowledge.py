"""Read-only knowledge shapes. Retrieval behavior is implemented by the Knowledge Service."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, TypeVar

from pydantic import BaseModel, Field

from esp_contracts.api import STRICT
from esp_contracts.ids import Sha256

T = TypeVar("T")
KnowledgeCode = Literal["not_found", "conflict", "unavailable", "forbidden"]
FactKind = Literal["claim", "concept", "current_value"]


class KnowledgeScope(BaseModel):
    model_config = STRICT
    corpus_release_id: str = Field(min_length=1)
    public_visibility: Literal["public", "internal"]
    as_of: datetime


class SourceMetadata(BaseModel):
    model_config = STRICT
    source_id: str
    version: str
    title: str
    content_hash: Sha256
    authority: str
    effective_date: datetime | None
    supersedes: str | None = None
    status: Literal["active", "withdrawn", "historical"]
    source_owner: str
    visibility: Literal["public", "internal"]
    locator_start: int = Field(ge=0)
    locator_end: int = Field(ge=0)


class SearchFilters(BaseModel):
    model_config = STRICT
    source_ids: list[str] | None = None
    version: str | None = None
    as_of: datetime | None = None


class SearchHit(BaseModel):
    model_config = STRICT
    source_id: str
    version: str
    locator: str
    snippet: str
    rank: int = Field(ge=0)


class SearchResults(BaseModel):
    model_config = STRICT
    hits: list[SearchHit]
    mode: Literal["hybrid", "lexical"]


class SourceRecord(BaseModel):
    model_config = STRICT
    metadata: SourceMetadata
    text: str
    original_bytes_ref: str


class ClaimRecord(BaseModel):
    model_config = STRICT
    claim_id: str
    text: str
    citations: list[SourceMetadata]


class ConceptRecord(BaseModel):
    model_config = STRICT
    concept_id: str
    definition: str
    relationships: list[str]


class CurrentValueRecord(BaseModel):
    model_config = STRICT
    key: str
    value: str
    unit: str | None
    effective_date: datetime | None
    source: SourceMetadata


class FactRecord(BaseModel):
    model_config = STRICT
    kind: FactKind
    claim: ClaimRecord | None = None
    concept: ConceptRecord | None = None
    current_value: CurrentValueRecord | None = None


class AssetRecord(BaseModel):
    model_config = STRICT
    asset_id: str
    version: str
    mime: str
    content_hash: Sha256
    object_ref: str
    alt: str
    source_id: str
    visibility: Literal["public", "internal"]
    status: Literal["active", "withdrawn"]


class KnowledgeOk[T](BaseModel):
    model_config = STRICT
    ok: Literal[True] = True
    corpus_release_id: str
    data: T
    sources: list[SourceMetadata]


class KnowledgeErr(BaseModel):
    model_config = STRICT
    ok: Literal[False] = False
    code: KnowledgeCode


KnowledgeResult = KnowledgeOk[T] | KnowledgeErr


def ok[T](corpus_release_id: str, data: T, sources: list[SourceMetadata]) -> KnowledgeOk[T]:
    return KnowledgeOk(corpus_release_id=corpus_release_id, data=data, sources=sources)


def err(code: KnowledgeCode) -> KnowledgeErr:
    return KnowledgeErr(code=code)


class CitationVerification(BaseModel):
    model_config = STRICT
    state: Literal["verified", "unverified", "unavailable"]
    source_id: str | None = None
    version: str | None = None
    locator: str | None = None
