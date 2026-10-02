"""Synthetic draft corpus. These rows are not a production release."""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from typing import Literal, cast

import psycopg

from esp_contracts.knowledge import (
    KnowledgeErr,
    KnowledgeOk,
    KnowledgeScope,
    SearchResults,
    SourceRecord,
)
from esp_contracts.release import ReleaseError
from esp_db.client import Db, open_db
from esp_embeddings.embed import EmbeddingBatch, EmbeddingUnavailable
from esp_mcp.retrieve import (
    AssetIngest,
    ClaimIngest,
    ConceptIngest,
    CorpusPin,
    CurrentValueIngest,
    KnowledgeCorpus,
    RecordStatus,
    ReleaseStatus,
    SourceIngest,
)
from esp_object_store.store import FileObjectStore, ObjectReceipt, parse_object_reference
from scripts.migrate import migrate
from tests.support.database import APP_DSN

FIXTURE_ROOT = Path("tests/fixtures/corpus")
MCP_DSN = "postgresql://esp_mcp:esp_mcp@127.0.0.1:54329/esp"
PUBLIC_AS_OF = datetime.fromisoformat("2026-01-01T00:00:00+00:00")
EARLY_AS_OF = datetime.fromisoformat("2024-06-01T00:00:00+00:00")
LATE_AS_OF = datetime.fromisoformat("2026-12-01T00:00:00+00:00")
SourceStatus = Literal["active", "withdrawn", "historical"]
Visibility = Literal["public", "internal"]


class ToggleStore:
    def __init__(self, inner: FileObjectStore) -> None:
        self.inner = inner
        self.fail = False

    async def put_immutable(self, key: str, body: bytes, metadata: dict[str, str]) -> ObjectReceipt:
        return await self.inner.put_immutable(key, body, metadata)

    async def get(self, key: str, version_id: str | None = None) -> bytes:
        if self.fail:
            raise ReleaseError("object_unavailable")
        return await self.inner.get(key, version_id)


class DeterministicEmbedder:
    """Local stand-in used only by the draft fixture. It is not MiniLM."""

    def __init__(self, revision: str, dimension: int) -> None:
        self.revision = revision
        self.dimension = dimension
        self.fail = False

    def embed(self, texts: list[str]) -> EmbeddingBatch:
        if self.fail:
            raise EmbeddingUnavailable("embeddings_unavailable")
        vectors: list[list[float]] = []
        for text in texts:
            digest = hashlib.sha256(text.encode("utf-8")).digest()
            raw = (digest * ((self.dimension // len(digest)) + 1))[: self.dimension]
            vectors.append([(byte - 128) / 128 for byte in raw])
        return EmbeddingBatch(revision=self.revision, dimension=self.dimension, vectors=vectors)


class CorpusLab:
    def __init__(
        self,
        app: Db,
        mcp: Db,
        store: ToggleStore,
        corpus: KnowledgeCorpus,
        embedder: DeterministicEmbedder,
        corpus_id: str,
        promoted_id: str,
        original_quote: bytes,
    ) -> None:
        self.app = app
        self.mcp = mcp
        self.store = store
        self.corpus = corpus
        self.embedder = embedder
        self.corpus_id = corpus_id
        self.promoted_id = promoted_id
        self.original_quote = original_quote

    async def close(self) -> None:
        await self.app.close()
        await self.mcp.close()

    def _scope(self, corpus_id: str, as_of: datetime, visibility: Visibility = "public") -> KnowledgeScope:
        return KnowledgeScope(corpus_release_id=corpus_id, public_visibility=visibility, as_of=as_of)

    async def explicit_old_source(self) -> KnowledgeOk[SourceRecord]:
        result = await self.corpus.resolve_source("src-versioned", "1", self._public())
        assert isinstance(result, KnowledgeOk)
        return result

    async def equal_precedence_current_value(self) -> KnowledgeErr:
        result = await self.corpus.resolve_fact("current_value", "fixture.parameter", self._public())
        assert isinstance(result, KnowledgeErr)
        return result

    async def search_private_canary(self) -> KnowledgeOk[SearchResults]:
        result = await self.corpus.search_sources("privatecanarytoken", self._public())
        assert isinstance(result, KnowledgeOk)
        return result

    async def withdrawn_recorded_version(self) -> KnowledgeErr:
        result = await self.corpus.resolve_source("src-withdrawn", "1", self._public())
        assert isinstance(result, KnowledgeErr)
        return result

    async def quoted_locator_bytes(self) -> bytes:
        result = await self.corpus.resolve_source("src-quote", "1", self._public())
        assert isinstance(result, KnowledgeOk)
        key, version_id = parse_object_reference(result.data.original_bytes_ref)
        raw = await self.store.get(key, version_id)
        start = result.data.metadata.locator_start
        end = result.data.metadata.locator_end
        return raw[start:end]

    async def private_chunk_is_indexed(self) -> bool:
        async with self.app.pool.connection() as connection:
            cursor = await connection.execute(
                """
                SELECT 1
                FROM knowledge.source_chunk
                WHERE corpus_release_id = %s AND source_id = 'src-private'
                LIMIT 1
                """,
                (self.corpus_id,),
            )
            row = await cursor.fetchone()
        return row is not None

    async def internal_canary_hits(self) -> int:
        result = await self.corpus.search_sources("privatecanarytoken", self._internal())
        assert isinstance(result, KnowledgeOk)
        return sum(1 for hit in result.data.hits if "privatecanarytoken" in hit.snippet)

    async def marker_snippet(self) -> str:
        result = await self.corpus.search_sources("markerbrainfixture", self._public())
        assert isinstance(result, KnowledgeOk)
        assert result.data.hits
        return result.data.hits[0].snippet

    async def store_outage_code(self) -> str:
        self.store.fail = True
        try:
            result = await self.corpus.resolve_source("src-quote", "1", self._public())
        finally:
            self.store.fail = False
        assert isinstance(result, KnowledgeErr)
        return result.code

    async def pinned_text_after_promotion(self) -> str:
        pinned = await self.corpus.resolve_source("src-versioned", "2", self._public())
        promoted = await self.corpus.resolve_source(
            "src-versioned",
            "2",
            self._scope(self.promoted_id, PUBLIC_AS_OF),
        )
        assert isinstance(pinned, KnowledgeOk)
        assert isinstance(promoted, KnowledgeOk)
        assert pinned.corpus_release_id == self.corpus_id
        assert "promoted-substitution" in promoted.data.text
        return pinned.data.text

    async def current_value_as_of(self) -> str:
        result = await self.corpus.resolve_fact(
            "current_value",
            "fixture.asof",
            self._scope(self.corpus_id, EARLY_AS_OF),
        )
        assert isinstance(result, KnowledgeOk)
        assert result.data.current_value is not None
        return result.data.current_value.value

    async def later_current_value(self) -> str:
        result = await self.corpus.resolve_fact(
            "current_value",
            "fixture.asof",
            self._scope(self.corpus_id, LATE_AS_OF),
        )
        assert isinstance(result, KnowledgeOk)
        assert result.data.current_value is not None
        return result.data.current_value.value

    async def lexical_mode_when_embeddings_unavailable(self) -> str:
        self.embedder.fail = True
        try:
            result = await self.corpus.search_sources("markerbrainfixture", self._public())
        finally:
            self.embedder.fail = False
        assert isinstance(result, KnowledgeOk)
        assert result.data.hits
        assert all("privatecanarytoken" not in hit.snippet for hit in result.data.hits)
        return result.data.mode

    async def revision_mismatch_code(self) -> str:
        async with self.app.pool.connection() as connection:
            await connection.execute(
                """
                INSERT INTO knowledge.index_generation (
                    corpus_release_id, generation, embedding_revision, tokenizer_revision,
                    dimension, built_at
                )
                SELECT %s, COALESCE(MAX(generation), 0) + 1, 'revision-mismatch',
                       'fixture-whitespace-v1', 384, now()
                FROM knowledge.index_generation
                WHERE corpus_release_id = %s
                """,
                (self.corpus_id, self.corpus_id),
            )
        result = await self.corpus.search_sources("markerbrainfixture", self._public())
        assert isinstance(result, KnowledgeErr)
        return result.code

    async def missing_fact_code(self) -> str:
        result = await self.corpus.resolve_fact("claim", "fixture-absent", self._public())
        assert isinstance(result, KnowledgeErr)
        return result.code

    async def private_resolve_code(self) -> str:
        result = await self.corpus.resolve_source("src-private", "1", self._public())
        assert isinstance(result, KnowledgeErr)
        return result.code

    async def recorded_claim_text(self) -> str:
        result = await self.corpus.resolve_fact("claim", "fixture-claim", self._public())
        assert isinstance(result, KnowledgeOk)
        assert result.data.claim is not None
        return result.data.claim.text

    async def asset_bytes_match_hash(self) -> bool:
        result = await self.corpus.resolve_asset("asset-fixture", self._public(), "1")
        assert isinstance(result, KnowledgeOk)
        key, version_id = parse_object_reference(result.data.object_ref)
        raw = await self.store.get(key, version_id)
        return hashlib.sha256(raw).hexdigest() == result.data.content_hash

    async def mcp_can_read(self) -> bool:
        async with self.mcp.pool.connection() as connection:
            cursor = await connection.execute(
                """
                SELECT count(*) AS n
                FROM knowledge.source_object
                WHERE corpus_release_id = %s
                """,
                (self.corpus_id,),
            )
            row = await cursor.fetchone()
        if row is None:
            return False
        count = row["n"]
        return isinstance(count, int) and not isinstance(count, bool) and count > 0

    async def mcp_write_sqlstate(self) -> str:
        try:
            async with self.mcp.pool.connection() as connection:
                async with connection.transaction():
                    await connection.execute(
                        """
                        INSERT INTO knowledge.corpus_release (
                            id, status, embedding_revision, embedding_dimension,
                            tokenizer_revision, created_at
                        ) VALUES (%s, 'draft', 'fixture-local-384', 384, 'fixture-whitespace-v1', now())
                        """,
                        (f"fixture-draft-mcp-write-{uuid.uuid4().hex}",),
                    )
        except psycopg.Error as exc:
            if exc.sqlstate is None:
                raise
            return exc.sqlstate
        raise AssertionError("esp_mcp was allowed to insert knowledge")

    def originals_preceded_index(self) -> bool:
        trace = self.corpus.trace
        if "index" not in trace:
            return False
        first_index = trace.index("index")
        earlier = trace[:first_index]
        return "object" in earlier and "metadata" in earlier and set(earlier) <= {"object", "metadata"}

    async def hybrid_mode(self) -> str:
        result = await self.corpus.search_sources("markerbrainfixture", self._public())
        assert isinstance(result, KnowledgeOk)
        return result.data.mode

    def _public(self) -> KnowledgeScope:
        return self._scope(self.corpus_id, PUBLIC_AS_OF, "public")

    def _internal(self) -> KnowledgeScope:
        return self._scope(self.corpus_id, PUBLIC_AS_OF, "internal")


def _load(name: str) -> dict[str, object]:
    payload = cast(object, json.loads((FIXTURE_ROOT / name).read_text(encoding="utf-8")))
    return _as_mapping(payload, name)


def _as_mapping(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise TypeError(label)
    mapped: dict[str, object] = {}
    for key, inner in cast(dict[object, object], value).items():
        if not isinstance(key, str):
            raise TypeError(label)
        mapped[key] = inner
    return mapped


def _as_list(value: object, label: str) -> list[dict[str, object]]:
    if not isinstance(value, list):
        raise TypeError(label)
    return [_as_mapping(item, label) for item in cast(list[object], value)]


def _int(item: Mapping[str, object], key: str) -> int:
    value = item[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(key)
    return value


def _when(value: object) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError("effective_date")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _text(item: Mapping[str, object], key: str) -> str:
    value = item[key]
    if not isinstance(value, str):
        raise TypeError(key)
    return value


def _status(item: Mapping[str, object]) -> SourceStatus:
    value = _text(item, "status")
    if value not in {"active", "withdrawn", "historical"}:
        raise TypeError("status")
    return cast(SourceStatus, value)


def _visibility(item: Mapping[str, object]) -> Visibility:
    value = _text(item, "visibility")
    if value not in {"public", "internal"}:
        raise TypeError("visibility")
    return cast(Visibility, value)


def _record_status(item: Mapping[str, object]) -> RecordStatus:
    value = _text(item, "status")
    if value not in {"active", "withdrawn"}:
        raise TypeError("status")
    return cast(RecordStatus, value)


def _release_status(value: str) -> ReleaseStatus:
    if value not in {"draft", "reviewed", "production", "withdrawn"}:
        raise TypeError("status")
    return cast(ReleaseStatus, value)


def _sources(
    document: Mapping[str, object],
    quote: bytes,
    replacements: dict[tuple[str, str], str],
) -> list[SourceIngest]:
    ingested: list[SourceIngest] = []
    for source in _as_list(document["sources"], "sources"):
        source_id = _text(source, "source_id")
        for version_item in _as_list(source["versions"], "versions"):
            version = _text(version_item, "version")
            if version_item.get("compose") == "quote":
                prefix = b"prefix-bytes\n"
                body = prefix + quote + b"\nsuffix-bytes"
                start = len(prefix)
                end = start + len(quote)
            else:
                text = replacements.get((source_id, version), _text(version_item, "text"))
                body = text.encode("utf-8")
                start, end = 0, len(body)
            ingested.append(
                SourceIngest(
                    source_id=source_id,
                    version=version,
                    title=_text(version_item, "title"),
                    body=body,
                    authority=_text(version_item, "authority"),
                    authority_rank=_int(version_item, "authority_rank"),
                    effective_date=_when(version_item.get("effective_date")),
                    supersedes=None,
                    status=_status(version_item),
                    source_owner=_text(version_item, "source_owner"),
                    visibility=_visibility(version_item),
                    locator_start=start,
                    locator_end=end,
                )
            )
    return ingested


def _values(document: Mapping[str, object]) -> list[CurrentValueIngest]:
    values: list[CurrentValueIngest] = []
    for item in _as_list(document["current_values"], "current_values"):
        status = _status(item)
        values.append(
            CurrentValueIngest(
                key=_text(item, "key"),
                value=_text(item, "value"),
                unit=_text(item, "unit"),
                effective_date=_when(item.get("effective_date")),
                authority=_text(item, "authority"),
                authority_rank=_int(item, "authority_rank"),
                status=status,
                source_id=_text(item, "source_id"),
                version=_text(item, "version"),
            )
        )
    return values


def _claims(document: Mapping[str, object], sources: list[SourceIngest]) -> list[ClaimIngest]:
    located = {(item.source_id, item.version): (item.locator_start, item.locator_end) for item in sources}
    claims: list[ClaimIngest] = []
    for item in _as_list(document["claims"], "claims"):
        citations: list[tuple[str, str, int, int]] = []
        for citation in _as_list(item["citations"], "citations"):
            source_id = _text(citation, "source_id")
            version = _text(citation, "version")
            start, end = located[(source_id, version)]
            citations.append((source_id, version, start, end))
        claims.append(
            ClaimIngest(
                claim_id=_text(item, "claim_id"),
                text=_text(item, "text"),
                status=_record_status(item),
                citations=tuple(citations),
            )
        )
    return claims


def _concepts(document: Mapping[str, object]) -> list[ConceptIngest]:
    concepts: list[ConceptIngest] = []
    for item in _as_list(document["concepts"], "concepts"):
        relationships = item["relationships"]
        if not isinstance(relationships, list):
            raise TypeError("relationships")
        related: list[str] = []
        for value in cast(list[object], relationships):
            if not isinstance(value, str):
                raise TypeError("relationships")
            related.append(value)
        concepts.append(
            ConceptIngest(
                concept_id=_text(item, "concept_id"),
                definition=_text(item, "definition"),
                status=_record_status(item),
                relationships=tuple(related),
            )
        )
    return concepts


def _assets(document: Mapping[str, object]) -> list[AssetIngest]:
    assets: list[AssetIngest] = []
    for item in _as_list(document["assets"], "assets"):
        assets.append(
            AssetIngest(
                asset_id=_text(item, "asset_id"),
                version=_text(item, "version"),
                mime=_text(item, "mime"),
                body=_text(item, "body_utf8").encode("utf-8"),
                alt=_text(item, "alt"),
                source_id=_text(item, "source_id"),
                visibility=_visibility(item),
                status=_record_status(item),
            )
        )
    return assets


def _replacements(document: Mapping[str, object]) -> dict[tuple[str, str], str]:
    replacements: dict[tuple[str, str], str] = {}
    for item in _as_list(document["promoted_replacements"], "promoted_replacements"):
        replacements[(_text(item, "source_id"), _text(item, "version"))] = _text(item, "text")
    return replacements


async def build_corpus_lab(root: Path) -> CorpusLab:
    manifest = _load("manifest.json")
    document = _load("sources.json")
    quote = _text(document, "quote").encode("utf-8")
    suffix = uuid.uuid4().hex[:8]
    corpus_id = f"{_text(manifest, 'corpus_release_id')}-{suffix}"
    promoted_id = f"{_text(manifest, 'promoted_corpus_release_id')}-{suffix}"
    revision = _text(manifest, "embedding_revision")
    dimension = manifest["embedding_dimension"]
    if not isinstance(dimension, int):
        raise TypeError("embedding_dimension")
    tokenizer = _text(manifest, "tokenizer_revision")
    status = _release_status(_text(manifest, "status"))
    await migrate(APP_DSN)
    app = await open_db(APP_DSN)
    mcp = await open_db(MCP_DSN)
    store = ToggleStore(FileObjectStore(root / "objects"))
    embedder = DeterministicEmbedder(revision, dimension)
    corpus = KnowledgeCorpus(app, store, embedder)
    sources = _sources(document, quote, {})
    pin = CorpusPin(
        corpus_release_id=corpus_id,
        status=status,
        embedding_revision=revision,
        embedding_dimension=dimension,
        tokenizer_revision=tokenizer,
    )
    await corpus.ingest_release(
        pin,
        sources,
        _values(document),
        _claims(document, sources),
        _concepts(document),
        _assets(document),
    )
    promoted_sources = _sources(document, quote, _replacements(document))
    await corpus.ingest_release(
        CorpusPin(
            corpus_release_id=promoted_id,
            status=status,
            embedding_revision=revision,
            embedding_dimension=dimension,
            tokenizer_revision=tokenizer,
        ),
        promoted_sources,
        [],
        [],
        [],
        [],
    )
    return CorpusLab(app, mcp, store, corpus, embedder, corpus_id, promoted_id, quote)
