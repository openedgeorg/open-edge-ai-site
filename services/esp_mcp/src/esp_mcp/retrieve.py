"""Versioned hybrid retrieval. Access and precedence run before ranking."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol, cast

import psycopg

from esp_contracts.knowledge import (
    AssetRecord,
    FactKind,
    FactRecord,
    KnowledgeResult,
    KnowledgeScope,
    SearchFilters,
    SearchHit,
    SearchResults,
    SourceMetadata,
    SourceRecord,
    err,
    ok,
)
from esp_contracts.release import ReleaseError
from esp_db.client import Db, transaction
from esp_embeddings.embed import (
    PINNED_DIMENSION,
    PINNED_MODEL_ID,
    PINNED_TOKENIZER,
    EmbeddingBatch,
    EmbeddingUnavailable,
)
from esp_mcp.resolve import (
    VISIBILITY_SQL,
    metadata_from,
    optional_datetime,
    optional_str,
    required_int,
    required_str,
)
from esp_object_store.store import ObjectStore

RRF_K = 60
CANDIDATE_LIMIT = 20
HIT_LIMIT = 8
MAX_COSINE_DISTANCE = 0.5
EMBED_BATCH = 32
MAX_TOKENS = 256
TOKEN_OVERLAP = 32
_WHITESPACE = {0x20, 0x09, 0x0A, 0x0D}
SourceStatus = Literal["active", "withdrawn", "historical"]
ReleaseStatus = Literal["draft", "reviewed", "production", "withdrawn"]
Visibility = Literal["public", "internal"]
ValueStatus = Literal["active", "withdrawn", "historical"]
RecordStatus = Literal["active", "withdrawn"]


class Embedder(Protocol):
    revision: str
    dimension: int

    def embed(self, texts: list[str]) -> EmbeddingBatch: ...


@dataclass(frozen=True)
class CorpusPin:
    corpus_release_id: str
    status: ReleaseStatus
    embedding_revision: str
    embedding_dimension: int
    tokenizer_revision: str


@dataclass(frozen=True)
class SourceIngest:
    source_id: str
    version: str
    title: str
    body: bytes
    authority: str
    authority_rank: int
    effective_date: datetime | None
    supersedes: str | None
    status: SourceStatus
    source_owner: str
    visibility: Visibility
    locator_start: int
    locator_end: int


@dataclass(frozen=True)
class CurrentValueIngest:
    key: str
    value: str
    unit: str | None
    effective_date: datetime | None
    authority: str
    authority_rank: int
    status: ValueStatus
    source_id: str
    version: str


@dataclass(frozen=True)
class ClaimIngest:
    claim_id: str
    text: str
    status: RecordStatus
    citations: tuple[tuple[str, str, int, int], ...]


@dataclass(frozen=True)
class ConceptIngest:
    concept_id: str
    definition: str
    status: RecordStatus
    relationships: tuple[str, ...]


@dataclass(frozen=True)
class AssetIngest:
    asset_id: str
    version: str
    mime: str
    body: bytes
    alt: str
    source_id: str
    visibility: Visibility
    status: RecordStatus


@dataclass
class _Chunk:
    source_id: str
    version: str
    chunk_index: int
    locator_start: int
    locator_end: int
    text: str
    visibility: str
    status: str
    effective_date: datetime | None
    vector: list[float]


class KnowledgeCorpus:
    def __init__(self, db: Db, store: ObjectStore, embedder: Embedder) -> None:
        self.db = db
        self.store = store
        self.embedder = embedder
        self.trace: list[str] = []

    async def ingest_release(
        self,
        pin: CorpusPin,
        sources: list[SourceIngest],
        values: list[CurrentValueIngest],
        claims: list[ClaimIngest],
        concepts: list[ConceptIngest],
        assets: list[AssetIngest],
    ) -> None:
        _require_pin(pin, self.embedder)
        async with transaction(self.db) as tx:
            await tx.execute(
                """
                INSERT INTO knowledge.corpus_release (
                    id, status, embedding_revision, embedding_dimension, tokenizer_revision, created_at
                ) VALUES (%s, %s, %s, %s, %s, now())
                """,
                (
                    pin.corpus_release_id,
                    pin.status,
                    pin.embedding_revision,
                    pin.embedding_dimension,
                    pin.tokenizer_revision,
                ),
            )
        stored: list[tuple[SourceIngest, str]] = []
        for source in sources:
            _check_locator(source.body, source.locator_start, source.locator_end)
            digest = hashlib.sha256(source.body).hexdigest()
            key = _object_key(pin.corpus_release_id, "sources", source.source_id, source.version)
            receipt = await self.store.put_immutable(key, source.body, {"sha256": digest})
            self.trace.append("object")
            if receipt.sha256 != digest:
                raise ReleaseError("object_unavailable")
            async with transaction(self.db) as tx:
                await tx.execute(
                    """
                    INSERT INTO knowledge.source_object (
                        corpus_release_id, source_id, version, title, content_hash, authority,
                        authority_rank, effective_date, supersedes, status, source_owner, visibility,
                        object_ref, byte_length, locator_start, locator_end
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                    )
                    """,
                    (
                        pin.corpus_release_id,
                        source.source_id,
                        source.version,
                        source.title,
                        digest,
                        source.authority,
                        source.authority_rank,
                        source.effective_date,
                        source.supersedes,
                        source.status,
                        source.source_owner,
                        source.visibility,
                        receipt.reference,
                        len(source.body),
                        source.locator_start,
                        source.locator_end,
                    ),
                )
            self.trace.append("metadata")
            confirmed = await self.store.get(key, receipt.version_id)
            if confirmed != source.body:
                raise ReleaseError("object_unavailable")
            stored.append((source, receipt.version_id))
        for asset in assets:
            digest = hashlib.sha256(asset.body).hexdigest()
            key = _object_key(pin.corpus_release_id, "assets", asset.asset_id, asset.version)
            receipt = await self.store.put_immutable(key, asset.body, {"sha256": digest})
            self.trace.append("object")
            async with transaction(self.db) as tx:
                await tx.execute(
                    """
                    INSERT INTO knowledge.asset_object (
                        corpus_release_id, asset_id, version, mime, content_hash, object_ref, alt,
                        source_id, visibility, status
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        pin.corpus_release_id,
                        asset.asset_id,
                        asset.version,
                        asset.mime,
                        digest,
                        receipt.reference,
                        asset.alt,
                        asset.source_id,
                        asset.visibility,
                        asset.status,
                    ),
                )
            self.trace.append("metadata")
        for value in values:
            async with transaction(self.db) as tx:
                await tx.execute(
                    """
                    INSERT INTO knowledge.current_value (
                        corpus_release_id, value_key, source_id, version, value_text, unit,
                        effective_date, authority, authority_rank, status
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        pin.corpus_release_id,
                        value.key,
                        value.source_id,
                        value.version,
                        value.value,
                        value.unit,
                        value.effective_date,
                        value.authority,
                        value.authority_rank,
                        value.status,
                    ),
                )
            self.trace.append("metadata")
        for claim in claims:
            async with transaction(self.db) as tx:
                await tx.execute(
                    """
                    INSERT INTO knowledge.claim (corpus_release_id, claim_id, claim_text, status)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (pin.corpus_release_id, claim.claim_id, claim.text, claim.status),
                )
                for source_id, version, start, end in claim.citations:
                    await tx.execute(
                        """
                        INSERT INTO knowledge.claim_citation (
                            corpus_release_id, claim_id, source_id, version, locator_start, locator_end
                        ) VALUES (%s, %s, %s, %s, %s, %s)
                        """,
                        (pin.corpus_release_id, claim.claim_id, source_id, version, start, end),
                    )
            self.trace.append("metadata")
        for concept in concepts:
            async with transaction(self.db) as tx:
                await tx.execute(
                    """
                    INSERT INTO knowledge.concept (corpus_release_id, concept_id, definition, status)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (pin.corpus_release_id, concept.concept_id, concept.definition, concept.status),
                )
                for related in concept.relationships:
                    await tx.execute(
                        """
                        INSERT INTO knowledge.concept_relationship (
                            corpus_release_id, concept_id, related_id
                        ) VALUES (%s, %s, %s)
                        """,
                        (pin.corpus_release_id, concept.concept_id, related),
                    )
            self.trace.append("metadata")
        chunks = await self._chunks(pin, stored)
        self.trace.append("index")
        async with transaction(self.db) as tx:
            current = await tx.execute_one(
                """
                SELECT COALESCE(MAX(generation), 0) AS generation
                FROM knowledge.index_generation
                WHERE corpus_release_id = %s
                """,
                (pin.corpus_release_id,),
            )
            generation = 1 if current is None else required_int(current, "generation") + 1
            await tx.execute(
                """
                INSERT INTO knowledge.index_generation (
                    corpus_release_id, generation, embedding_revision, tokenizer_revision, dimension, built_at
                ) VALUES (%s, %s, %s, %s, %s, now())
                """,
                (
                    pin.corpus_release_id,
                    generation,
                    pin.embedding_revision,
                    pin.tokenizer_revision,
                    pin.embedding_dimension,
                ),
            )
            for chunk in chunks:
                await tx.execute(
                    """
                    INSERT INTO knowledge.source_chunk (
                        corpus_release_id, generation, source_id, version, chunk_index, locator_start,
                        locator_end, chunk_text, embedding, visibility, status, effective_date
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::vector, %s, %s, %s)
                    """,
                    (
                        pin.corpus_release_id,
                        generation,
                        chunk.source_id,
                        chunk.version,
                        chunk.chunk_index,
                        chunk.locator_start,
                        chunk.locator_end,
                        chunk.text,
                        _vector_literal(chunk.vector),
                        chunk.visibility,
                        chunk.status,
                        chunk.effective_date,
                    ),
                )

    async def search_sources(
        self,
        query: str,
        scope: KnowledgeScope,
        filters: SearchFilters | None = None,
    ) -> KnowledgeResult[SearchResults]:
        try:
            return await self._search(query, scope, filters)
        except (psycopg.OperationalError, ReleaseError):
            return err("unavailable")

    async def resolve_source(
        self,
        source_id: str,
        version: str | None,
        scope: KnowledgeScope,
    ) -> KnowledgeResult[SourceRecord]:
        from esp_mcp.resolve import resolve_source

        return await resolve_source(self, source_id, version, scope)

    async def resolve_fact(
        self,
        kind: FactKind,
        key: str,
        scope: KnowledgeScope,
    ) -> KnowledgeResult[FactRecord]:
        from esp_mcp.resolve import resolve_fact

        return await resolve_fact(self, kind, key, scope)

    async def resolve_asset(
        self,
        asset_id: str,
        scope: KnowledgeScope,
        version: str | None = None,
    ) -> KnowledgeResult[AssetRecord]:
        from esp_mcp.assets import resolve_asset

        return await resolve_asset(self, asset_id, scope, version)

    async def _chunks(self, pin: CorpusPin, stored: list[tuple[SourceIngest, str]]) -> list[_Chunk]:
        drafted: list[_Chunk] = []
        for source, version_id in stored:
            if source.status == "withdrawn":
                continue
            key = _object_key(pin.corpus_release_id, "sources", source.source_id, source.version)
            body = await self.store.get(key, version_id)
            pieces = chunk_bytes(body)
            for index, (start, end, text) in enumerate(pieces):
                drafted.append(
                    _Chunk(
                        source_id=source.source_id,
                        version=source.version,
                        chunk_index=index,
                        locator_start=start,
                        locator_end=end,
                        text=text,
                        visibility=source.visibility,
                        status=source.status,
                        effective_date=source.effective_date,
                        vector=[],
                    )
                )
        vectors: list[list[float]] = []
        for offset in range(0, len(drafted), EMBED_BATCH):
            batch = self.embedder.embed([item.text for item in drafted[offset : offset + EMBED_BATCH]])
            if batch.revision != pin.embedding_revision or batch.dimension != pin.embedding_dimension:
                raise EmbeddingUnavailable("embedding_pin_mismatch")
            if len(batch.vectors) != min(EMBED_BATCH, len(drafted) - offset):
                raise EmbeddingUnavailable("embeddings_unavailable")
            vectors.extend(batch.vectors)
        if len(vectors) != len(drafted):
            raise EmbeddingUnavailable("embeddings_unavailable")
        for chunk, vector in zip(drafted, vectors, strict=True):
            if len(vector) != PINNED_DIMENSION or any(not _finite(value) for value in vector):
                raise EmbeddingUnavailable("embeddings_unavailable")
            chunk.vector = vector
        return drafted

    async def _search(
        self,
        query: str,
        scope: KnowledgeScope,
        filters: SearchFilters | None,
    ) -> KnowledgeResult[SearchResults]:
        as_of = scope.as_of
        if filters is not None and filters.as_of is not None and filters.as_of < as_of:
            as_of = filters.as_of
        version = None if filters is None else filters.version
        source_ids = None if filters is None else filters.source_ids
        try:
            async with transaction(self.db) as tx:
                pin = await tx.execute_one(
                    """
                    SELECT embedding_revision, tokenizer_revision, embedding_dimension
                    FROM knowledge.corpus_release
                    WHERE id = %s
                    """,
                    (scope.corpus_release_id,),
                )
                if pin is None:
                    return err("not_found")
                generation = await tx.execute_one(
                    """
                    SELECT generation, embedding_revision, tokenizer_revision, dimension
                    FROM knowledge.index_generation
                    WHERE corpus_release_id = %s
                    ORDER BY generation DESC
                    LIMIT 1
                    """,
                    (scope.corpus_release_id,),
                )
                if generation is None or not _index_matches(pin, generation, self.embedder):
                    return err("unavailable")
                lexical = await tx.execute(
                    _lexical_sql(),
                    _filter_params(
                        query,
                        scope,
                        required_int(generation, "generation"),
                        version,
                        as_of,
                        source_ids,
                        True,
                    ),
                )
        except psycopg.OperationalError:
            return err("unavailable")
        vector_rows: Sequence[Mapping[str, object]] | None
        try:
            batch = self.embedder.embed([query])
        except EmbeddingUnavailable:
            vector_rows = None
        else:
            if (
                batch.revision != self.embedder.revision
                or batch.dimension != PINNED_DIMENSION
                or len(batch.vectors) != 1
                or len(batch.vectors[0]) != PINNED_DIMENSION
            ):
                return err("unavailable")
            async with transaction(self.db) as tx:
                found = await tx.execute(
                    _vector_sql(),
                    _filter_params(
                        _vector_literal(batch.vectors[0]),
                        scope,
                        required_int(generation, "generation"),
                        version,
                        as_of,
                        source_ids,
                        False,
                    ),
                )
            vector_rows = cast(Sequence[Mapping[str, object]], found)
        mode: Literal["hybrid", "lexical"] = "lexical" if vector_rows is None else "hybrid"
        hits, sources = _fuse(lexical, vector_rows or [])
        return ok(scope.corpus_release_id, SearchResults(hits=hits, mode=mode), sources)


def _require_pin(pin: CorpusPin, embedder: Embedder) -> None:
    if pin.embedding_dimension != PINNED_DIMENSION or embedder.dimension != PINNED_DIMENSION:
        raise EmbeddingUnavailable("embedding_pin_mismatch")
    if embedder.revision != pin.embedding_revision:
        raise EmbeddingUnavailable("embedding_pin_mismatch")
    if pin.status in {"reviewed", "production"} and (
        pin.embedding_revision != PINNED_MODEL_ID or pin.tokenizer_revision != PINNED_TOKENIZER
    ):
        raise EmbeddingUnavailable("embedding_pin_mismatch")


def _index_matches(pin: Mapping[str, object], generation: Mapping[str, object], embedder: Embedder) -> bool:
    return (
        required_str(pin, "embedding_revision") == required_str(generation, "embedding_revision") == embedder.revision
        and required_str(pin, "tokenizer_revision") == required_str(generation, "tokenizer_revision")
        and required_int(pin, "embedding_dimension") == required_int(generation, "dimension") == PINNED_DIMENSION
    )


def _object_key(corpus_id: str, kind: str, object_id: str, version: str) -> str:
    for part in (corpus_id, kind, object_id, version):
        if not part or "/" in part or part in {".", ".."}:
            raise ReleaseError("object_key_invalid")
    return f"knowledge/{corpus_id}/{kind}/{object_id}/{version}"


def _check_locator(body: bytes, start: int, end: int) -> None:
    if start < 0 or end < start or end > len(body):
        raise ReleaseError("object_unavailable")


def _vector_literal(values: list[float]) -> str:
    return "[" + ",".join(f"{value:.8f}" for value in values) + "]"


def _finite(value: float) -> bool:
    return value == value and value not in {float("inf"), float("-inf")}


def chunk_bytes(body: bytes) -> list[tuple[int, int, str]]:
    body.decode("utf-8")
    spans: list[tuple[int, int]] = []
    start: int | None = None
    for index, byte in enumerate(body):
        if byte in _WHITESPACE:
            if start is not None:
                spans.append((start, index))
                start = None
        elif start is None:
            start = index
    if start is not None:
        spans.append((start, len(body)))
    if not spans:
        if not body:
            return []
        return [(0, len(body), body.decode("utf-8"))]
    step = MAX_TOKENS - TOKEN_OVERLAP
    windows: list[tuple[int, int, str]] = []
    begin = 0
    while begin < len(spans):
        end_token = min(begin + MAX_TOKENS, len(spans))
        byte_start = spans[begin][0]
        byte_end = spans[end_token - 1][1]
        windows.append((byte_start, byte_end, body[byte_start:byte_end].decode("utf-8")))
        if end_token == len(spans):
            break
        begin += step
    return windows


def _lexical_sql() -> str:
    visibility = VISIBILITY_SQL.format(alias="c")
    return f"""
        SELECT c.source_id, c.version, c.locator_start, c.locator_end, c.chunk_text,
               s.title, s.content_hash, s.authority, s.effective_date, s.supersedes,
               s.status, s.source_owner, s.visibility,
               s.locator_start AS source_locator_start, s.locator_end AS source_locator_end
        FROM knowledge.source_chunk AS c
        JOIN knowledge.source_object AS s
          ON s.corpus_release_id = c.corpus_release_id
         AND s.source_id = c.source_id
         AND s.version = c.version
        WHERE c.corpus_release_id = %s
          AND c.generation = %s
          AND {visibility}
          AND (
                (%s::text IS NULL AND c.status = 'active')
                OR (%s::text IS NOT NULL AND c.version = %s AND c.status IN ('active', 'historical'))
              )
          AND (c.effective_date IS NULL OR c.effective_date <= %s)
          AND (%s::text[] IS NULL OR c.source_id = ANY(%s::text[]))
          AND c.tsv @@ plainto_tsquery('simple', %s)
        ORDER BY ts_rank(c.tsv, plainto_tsquery('simple', %s)) DESC, c.source_id, c.locator_start
        LIMIT {CANDIDATE_LIMIT}
    """


def _vector_sql() -> str:
    visibility = VISIBILITY_SQL.format(alias="c")
    return f"""
        SELECT c.source_id, c.version, c.locator_start, c.locator_end, c.chunk_text,
               s.title, s.content_hash, s.authority, s.effective_date, s.supersedes,
               s.status, s.source_owner, s.visibility,
               s.locator_start AS source_locator_start, s.locator_end AS source_locator_end
        FROM knowledge.source_chunk AS c
        JOIN knowledge.source_object AS s
          ON s.corpus_release_id = c.corpus_release_id
         AND s.source_id = c.source_id
         AND s.version = c.version
        WHERE c.corpus_release_id = %s
          AND c.generation = %s
          AND {visibility}
          AND c.embedding IS NOT NULL
          AND (
                (%s::text IS NULL AND c.status = 'active')
                OR (%s::text IS NOT NULL AND c.version = %s AND c.status IN ('active', 'historical'))
              )
          AND (c.effective_date IS NULL OR c.effective_date <= %s)
          AND (%s::text[] IS NULL OR c.source_id = ANY(%s::text[]))
          AND (c.embedding <=> %s::vector) <= {MAX_COSINE_DISTANCE}
        ORDER BY c.embedding <=> %s::vector, c.source_id, c.locator_start
        LIMIT {CANDIDATE_LIMIT}
    """


def _filter_params(
    query_or_vector: str,
    scope: KnowledgeScope,
    generation: int,
    version: str | None,
    as_of: datetime,
    source_ids: list[str] | None,
    lexical: bool,
) -> tuple[object, ...]:
    common: tuple[object, ...] = (
        scope.corpus_release_id,
        generation,
        scope.public_visibility,
        scope.public_visibility,
        version,
        version,
        version,
        as_of,
        source_ids,
        source_ids,
    )
    if lexical:
        return common + (query_or_vector, query_or_vector)
    return common + (query_or_vector, query_or_vector)


def _fuse(
    lexical: Sequence[Mapping[str, object]],
    vector: Sequence[Mapping[str, object]],
) -> tuple[list[SearchHit], list[SourceMetadata]]:
    scores: dict[tuple[str, str, int, int], float] = {}
    rows: dict[tuple[str, str, int, int], Mapping[str, object]] = {}
    for rank, row in enumerate(lexical, start=1):
        key = _hit_key(row)
        scores[key] = scores.get(key, 0.0) + (1.0 / (RRF_K + rank))
        rows[key] = row
    for rank, row in enumerate(vector, start=1):
        key = _hit_key(row)
        scores[key] = scores.get(key, 0.0) + (1.0 / (RRF_K + rank))
        rows[key] = row
    ordered = sorted(scores, key=lambda key: (-scores[key], key[0], key[1], key[2]))[:HIT_LIMIT]
    hits: list[SearchHit] = []
    sources: list[SourceMetadata] = []
    seen: set[tuple[str, str]] = set()
    for index, key in enumerate(ordered):
        row = rows[key]
        hits.append(
            SearchHit(
                source_id=key[0],
                version=key[1],
                locator=f"{key[2]}:{key[3]}",
                snippet=required_str(row, "chunk_text"),
                rank=index,
            )
        )
        identity = (key[0], key[1])
        if identity not in seen:
            seen.add(identity)
            sources.append(_source_metadata(row))
    return hits, sources


def _hit_key(row: Mapping[str, object]) -> tuple[str, str, int, int]:
    return (
        required_str(row, "source_id"),
        required_str(row, "version"),
        required_int(row, "locator_start"),
        required_int(row, "locator_end"),
    )


def _source_metadata(row: Mapping[str, object]) -> SourceMetadata:
    return metadata_from(
        source_id=required_str(row, "source_id"),
        version=required_str(row, "version"),
        title=required_str(row, "title"),
        content_hash=required_str(row, "content_hash"),
        authority=required_str(row, "authority"),
        effective_date=optional_datetime(row, "effective_date"),
        supersedes=optional_str(row, "supersedes"),
        status=required_str(row, "status"),
        source_owner=required_str(row, "source_owner"),
        visibility=required_str(row, "visibility"),
        locator_start=required_int(row, "source_locator_start"),
        locator_end=required_int(row, "source_locator_end"),
    )
