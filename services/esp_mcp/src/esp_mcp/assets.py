"""Manifest-listed asset resolution. Bytes stay in the immutable object store."""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal, cast

import psycopg
from pydantic import ValidationError

from esp_contracts.knowledge import AssetRecord, KnowledgeResult, KnowledgeScope, SourceMetadata, err, ok
from esp_contracts.release import ReleaseError
from esp_mcp.resolve import allows, metadata_row, read_verified_bytes, required_str

if TYPE_CHECKING:
    from esp_mcp.retrieve import KnowledgeCorpus


async def resolve_asset(
    corpus: KnowledgeCorpus,
    asset_id: str,
    scope: KnowledgeScope,
    version: str | None = None,
) -> KnowledgeResult[AssetRecord]:
    try:
        return await _resolve_asset(corpus, asset_id, scope, version)
    except (ReleaseError, ValidationError, psycopg.OperationalError, TypeError):
        return err("unavailable")


async def _resolve_asset(
    corpus: KnowledgeCorpus,
    asset_id: str,
    scope: KnowledgeScope,
    version: str | None,
) -> KnowledgeResult[AssetRecord]:
    from esp_db.client import transaction

    async with transaction(corpus.db) as tx:
        if version is None:
            rows = await tx.execute(
                """
                SELECT asset_id, version, mime, content_hash, object_ref, alt, source_id, visibility, status
                FROM knowledge.asset_object
                WHERE corpus_release_id = %s AND asset_id = %s AND status = 'active'
                """,
                (scope.corpus_release_id, asset_id),
            )
            if not rows:
                return err("not_found")
            if len(rows) > 1:
                return err("conflict")
            row = rows[0]
        else:
            row = await tx.execute_one(
                """
                SELECT asset_id, version, mime, content_hash, object_ref, alt, source_id, visibility, status
                FROM knowledge.asset_object
                WHERE corpus_release_id = %s AND asset_id = %s AND version = %s
                """,
                (scope.corpus_release_id, asset_id, version),
            )
            if row is None:
                return err("not_found")
        if not allows(scope, required_str(row, "visibility")):
            return err("forbidden")
        if required_str(row, "status") == "withdrawn":
            return err("unavailable")
        source_rows = await tx.execute(
            """
            SELECT source_id, version, title, content_hash, authority, effective_date, supersedes,
                   status, source_owner, visibility, locator_start, locator_end
            FROM knowledge.source_object
            WHERE corpus_release_id = %s AND source_id = %s AND status = 'active'
            """,
            (scope.corpus_release_id, required_str(row, "source_id")),
        )
    await read_verified_bytes(corpus, required_str(row, "object_ref"), required_str(row, "content_hash"))
    status = required_str(row, "status")
    visibility = required_str(row, "visibility")
    if status not in {"active", "withdrawn"} or visibility not in {"public", "internal"}:
        return err("unavailable")
    record_status = cast(Literal["active", "withdrawn"], status)
    record_visibility = cast(Literal["public", "internal"], visibility)
    sources: list[SourceMetadata] = []
    if len(source_rows) == 1 and allows(scope, required_str(source_rows[0], "visibility")):
        sources.append(metadata_row(source_rows[0]))
    record = AssetRecord(
        asset_id=required_str(row, "asset_id"),
        version=required_str(row, "version"),
        mime=required_str(row, "mime"),
        content_hash=required_str(row, "content_hash"),
        object_ref=required_str(row, "object_ref"),
        alt=required_str(row, "alt"),
        source_id=required_str(row, "source_id"),
        visibility=record_visibility,
        status=record_status,
    )
    return ok(scope.corpus_release_id, record, sources)
