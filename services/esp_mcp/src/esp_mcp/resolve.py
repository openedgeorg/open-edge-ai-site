"""Exact source and fact resolution. Text comes from the immutable object, not the index."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal, cast

import psycopg
from pydantic import ValidationError

from esp_contracts.knowledge import (
    ClaimRecord,
    ConceptRecord,
    CurrentValueRecord,
    FactRecord,
    KnowledgeResult,
    KnowledgeScope,
    SourceMetadata,
    SourceRecord,
    err,
    ok,
)
from esp_contracts.release import ReleaseError
from esp_object_store.store import parse_object_reference

if TYPE_CHECKING:
    from esp_mcp.retrieve import KnowledgeCorpus

VISIBILITY_SQL = """
    (
        (%s = 'public' AND {alias}.visibility = 'public')
        OR (%s = 'internal' AND {alias}.visibility IN ('public', 'internal'))
    )
"""


def allows(scope: KnowledgeScope, visibility: str) -> bool:
    if visibility == "public":
        return True
    return scope.public_visibility == "internal" and visibility == "internal"


def required_str(row: Mapping[str, Any], key: str) -> str:
    value = row[key]
    if not isinstance(value, str):
        raise TypeError(key)
    return value


def required_int(row: Mapping[str, Any], key: str) -> int:
    value = row[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(key)
    return value


def optional_str(row: Mapping[str, Any], key: str) -> str | None:
    value = row[key]
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(key)
    return value


def optional_datetime(row: Mapping[str, Any], key: str) -> datetime | None:
    value = row[key]
    if value is None:
        return None
    if not isinstance(value, datetime):
        raise TypeError(key)
    return value


def metadata_from(
    *,
    source_id: str,
    version: str,
    title: str,
    content_hash: str,
    authority: str,
    effective_date: datetime | None,
    supersedes: str | None,
    status: str,
    source_owner: str,
    visibility: str,
    locator_start: int,
    locator_end: int,
) -> SourceMetadata:
    if status not in {"active", "withdrawn", "historical"}:
        raise TypeError("status")
    if visibility not in {"public", "internal"}:
        raise TypeError("visibility")
    record_status = cast(Literal["active", "withdrawn", "historical"], status)
    record_visibility = cast(Literal["public", "internal"], visibility)
    return SourceMetadata(
        source_id=source_id,
        version=version,
        title=title,
        content_hash=content_hash,
        authority=authority,
        effective_date=effective_date,
        supersedes=supersedes,
        status=record_status,
        source_owner=source_owner,
        visibility=record_visibility,
        locator_start=locator_start,
        locator_end=locator_end,
    )


def metadata_row(row: Mapping[str, Any]) -> SourceMetadata:
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
        locator_start=required_int(row, "locator_start"),
        locator_end=required_int(row, "locator_end"),
    )


async def read_verified_bytes(corpus: KnowledgeCorpus, object_ref: str, content_hash: str) -> bytes:
    key, version_id = parse_object_reference(object_ref)
    body = await corpus.store.get(key, version_id)
    if hashlib.sha256(body).hexdigest() != content_hash:
        raise ReleaseError("object_unavailable")
    return body


async def resolve_source(
    corpus: KnowledgeCorpus,
    source_id: str,
    version: str | None,
    scope: KnowledgeScope,
) -> KnowledgeResult[SourceRecord]:
    try:
        return await _resolve_source(corpus, source_id, version, scope)
    except (ReleaseError, UnicodeError, ValidationError, psycopg.OperationalError):
        return err("unavailable")


async def _resolve_source(
    corpus: KnowledgeCorpus,
    source_id: str,
    version: str | None,
    scope: KnowledgeScope,
) -> KnowledgeResult[SourceRecord]:
    from esp_db.client import transaction

    async with transaction(corpus.db) as tx:
        if version is None:
            rows = await tx.execute(
                """
                SELECT source_id, version, title, content_hash, authority, effective_date, supersedes,
                       status, source_owner, visibility, object_ref, locator_start, locator_end
                FROM knowledge.source_object
                WHERE corpus_release_id = %s AND source_id = %s AND status = 'active'
                """,
                (scope.corpus_release_id, source_id),
            )
            if not rows:
                return err("not_found")
            if len(rows) > 1:
                return err("conflict")
            row = rows[0]
        else:
            row = await tx.execute_one(
                """
                SELECT source_id, version, title, content_hash, authority, effective_date, supersedes,
                       status, source_owner, visibility, object_ref, locator_start, locator_end
                FROM knowledge.source_object
                WHERE corpus_release_id = %s AND source_id = %s AND version = %s
                """,
                (scope.corpus_release_id, source_id, version),
            )
            if row is None:
                return err("not_found")
    if not allows(scope, required_str(row, "visibility")):
        return err("forbidden")
    if required_str(row, "status") == "withdrawn":
        return err("unavailable")
    body = await read_verified_bytes(corpus, required_str(row, "object_ref"), required_str(row, "content_hash"))
    metadata = metadata_row(row)
    if metadata.locator_end > len(body):
        return err("unavailable")
    record = SourceRecord(
        metadata=metadata,
        text=body.decode("utf-8"),
        original_bytes_ref=required_str(row, "object_ref"),
    )
    return ok(scope.corpus_release_id, record, [metadata])


async def resolve_fact(
    corpus: KnowledgeCorpus,
    kind: str,
    key: str,
    scope: KnowledgeScope,
) -> KnowledgeResult[FactRecord]:
    try:
        if kind == "claim":
            return await _claim(corpus, key, scope)
        if kind == "concept":
            return await _concept(corpus, key, scope)
        if kind == "current_value":
            return await _current_value(corpus, key, scope)
        return err("not_found")
    except (ReleaseError, ValidationError, psycopg.OperationalError, TypeError):
        return err("unavailable")


async def _claim(corpus: KnowledgeCorpus, claim_id: str, scope: KnowledgeScope) -> KnowledgeResult[FactRecord]:
    from esp_db.client import transaction

    async with transaction(corpus.db) as tx:
        row = await tx.execute_one(
            """
            SELECT claim_text, status
            FROM knowledge.claim
            WHERE corpus_release_id = %s AND claim_id = %s
            """,
            (scope.corpus_release_id, claim_id),
        )
        if row is None:
            return err("not_found")
        if required_str(row, "status") == "withdrawn":
            return err("unavailable")
        citations = await tx.execute(
            """
            SELECT s.source_id, s.version, s.title, s.content_hash, s.authority, s.effective_date,
                   s.supersedes, s.status, s.source_owner, s.visibility,
                   c.locator_start, c.locator_end
            FROM knowledge.claim_citation AS c
            JOIN knowledge.source_object AS s
              ON s.corpus_release_id = c.corpus_release_id
             AND s.source_id = c.source_id
             AND s.version = c.version
            WHERE c.corpus_release_id = %s AND c.claim_id = %s
            ORDER BY c.source_id, c.version, c.locator_start
            """,
            (scope.corpus_release_id, claim_id),
        )
        expected = await tx.execute_one(
            """
            SELECT count(*) AS n
            FROM knowledge.claim_citation
            WHERE corpus_release_id = %s AND claim_id = %s
            """,
            (scope.corpus_release_id, claim_id),
        )
    if expected is None or required_int(expected, "n") != len(citations):
        return err("unavailable")
    sources: list[SourceMetadata] = []
    for citation in citations:
        metadata = metadata_row(citation)
        if not allows(scope, metadata.visibility) or metadata.status == "withdrawn":
            return err("unavailable")
        sources.append(metadata)
    record = FactRecord(
        kind="claim",
        claim=ClaimRecord(claim_id=claim_id, text=required_str(row, "claim_text"), citations=sources),
    )
    return ok(scope.corpus_release_id, record, sources)


async def _concept(corpus: KnowledgeCorpus, concept_id: str, scope: KnowledgeScope) -> KnowledgeResult[FactRecord]:
    from esp_db.client import transaction

    async with transaction(corpus.db) as tx:
        row = await tx.execute_one(
            """
            SELECT definition, status
            FROM knowledge.concept
            WHERE corpus_release_id = %s AND concept_id = %s
            """,
            (scope.corpus_release_id, concept_id),
        )
        if row is None:
            return err("not_found")
        if required_str(row, "status") == "withdrawn":
            return err("unavailable")
        relations = await tx.execute(
            """
            SELECT related_id
            FROM knowledge.concept_relationship
            WHERE corpus_release_id = %s AND concept_id = %s
            ORDER BY related_id
            """,
            (scope.corpus_release_id, concept_id),
        )
    related = [required_str(item, "related_id") for item in relations]
    record = FactRecord(
        kind="concept",
        concept=ConceptRecord(concept_id=concept_id, definition=required_str(row, "definition"), relationships=related),
    )
    return ok(scope.corpus_release_id, record, [])


async def _current_value(corpus: KnowledgeCorpus, key: str, scope: KnowledgeScope) -> KnowledgeResult[FactRecord]:
    from esp_db.client import transaction

    visibility = VISIBILITY_SQL.format(alias="s")
    async with transaction(corpus.db) as tx:
        rows = await tx.execute(
            f"""
            SELECT v.value_text, v.unit, v.effective_date AS value_effective, v.authority_rank,
                   s.source_id, s.version, s.title, s.content_hash, s.authority, s.effective_date,
                   s.supersedes, s.status, s.source_owner, s.visibility, s.locator_start, s.locator_end
            FROM knowledge.current_value AS v
            JOIN knowledge.source_object AS s
              ON s.corpus_release_id = v.corpus_release_id
             AND s.source_id = v.source_id
             AND s.version = v.version
            WHERE v.corpus_release_id = %s
              AND v.value_key = %s
              AND v.status = 'active'
              AND s.status <> 'withdrawn'
              AND (v.effective_date IS NULL OR v.effective_date <= %s)
              AND {visibility}
            """,
            (
                scope.corpus_release_id,
                key,
                scope.as_of,
                scope.public_visibility,
                scope.public_visibility,
            ),
        )
    if not rows:
        return err("not_found")
    best = max(_precedence(row) for row in rows)
    tied = [row for row in rows if _precedence(row) == best]
    if len({required_str(row, "value_text") for row in tied}) > 1:
        return err("conflict")
    winner = tied[0]
    metadata = metadata_row(winner)
    record = FactRecord(
        kind="current_value",
        current_value=CurrentValueRecord(
            key=key,
            value=required_str(winner, "value_text"),
            unit=optional_str(winner, "unit"),
            effective_date=optional_datetime(winner, "value_effective"),
            source=metadata,
        ),
    )
    return ok(scope.corpus_release_id, record, [metadata])


def _precedence(row: Mapping[str, Any]) -> tuple[datetime, int]:
    effective = optional_datetime(row, "value_effective")
    when = effective if effective is not None else datetime.min.replace(tzinfo=UTC)
    return (when, required_int(row, "authority_rank"))
