"""Transport authority for knowledge tools. The MCP process holds no signing key."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import psycopg

from esp_contracts.knowledge import KnowledgeScope
from esp_contracts.runtime import RunBinding
from esp_db.client import Db, transaction
from esp_execution_bindings.binding import AuthorizationError, TokenVerifier, verify_binding
from esp_mcp.retrieve import Embedder, KnowledgeCorpus

_ALLOWED_PROFILE = frozenset({"pending", "validated"})


class AuthorityOutage(Exception):
    """The current-authority read could not be completed."""

    def __init__(self, code: str = "authority_unavailable") -> None:
        super().__init__(code)
        self.code = code


@dataclass
class AuthorityReader:
    """Restricted reader: public verification key plus the knowledge_authority view."""

    db: Db
    verifier: TokenVerifier


@dataclass
class KnowledgeDependencies:
    """Authority reader, immutable corpus, embedding client, inspection identity, telemetry."""

    authority: AuthorityReader
    corpus: KnowledgeCorpus
    embedder: Embedder
    inspection_identity: str
    telemetry: list[dict[str, str]] = field(default_factory=list)


async def authorize_tool_call(transport_token: str, *, deps: KnowledgeDependencies) -> KnowledgeScope:
    """Resolve the public corpus pin from the current knowledge-audience token."""
    if not transport_token.strip():
        raise AuthorizationError("unauthenticated")
    if transport_token == deps.inspection_identity:
        raise AuthorizationError("inspection_credential")
    binding = verify_binding(transport_token, "knowledge", verifier=deps.authority.verifier)
    try:
        row = await _read_knowledge_authority(deps.authority.db, binding.provider_session_id)
    except psycopg.OperationalError as exc:
        raise AuthorityOutage("authority_unavailable") from exc
    if row is None:
        raise AuthorizationError("authority_unavailable")
    _require_current(binding, row)
    as_of = _database_time(row["database_time"])
    if as_of >= binding.expires_at:
        raise AuthorizationError("lease_expired")
    corpus_release_id = _text(row, "corpus_release_id")
    if corpus_release_id != binding.corpus_release_id:
        raise AuthorizationError("authority_mismatch")
    return KnowledgeScope(corpus_release_id=corpus_release_id, public_visibility="public", as_of=as_of)


async def _read_knowledge_authority(db: Db, provider_session_id: str) -> dict[str, Any] | None:
    async with transaction(db) as tx:
        return await tx.execute_one(
            """
            SELECT conversation_id, provider_session_id, provider, active_agent_run_id,
                   ownership_epoch, runtime_incarnation_id, corpus_release_id,
                   qualification_status, database_time, guard_provider_session_id,
                   cancel_requested
            FROM knowledge_authority
            WHERE provider_session_id = %s
            """,
            (provider_session_id,),
        )


def _require_current(binding: RunBinding, row: Mapping[str, Any]) -> None:
    if (
        _text(row, "conversation_id") != binding.conversation_id
        or _text(row, "provider_session_id") != binding.provider_session_id
        or _text(row, "provider") != binding.provider
        or _text(row, "active_agent_run_id") != binding.active_agent_run_id
        or _text(row, "runtime_incarnation_id") != binding.runtime_incarnation_id
    ):
        raise AuthorizationError("authority_mismatch")
    epoch = row["ownership_epoch"]
    if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch != binding.ownership_epoch:
        raise AuthorizationError("authority_mismatch")
    if _text(row, "guard_provider_session_id") != binding.provider_session_id:
        raise AuthorizationError("guard_mismatch")
    if row["cancel_requested"] is not False:
        raise AuthorizationError("authority_unavailable")
    if _text(row, "qualification_status") not in _ALLOWED_PROFILE:
        raise AuthorizationError("profile_disabled")


def _text(row: Mapping[str, Any], key: str) -> str:
    value = row[key]
    if not isinstance(value, str) or not value:
        raise AuthorizationError("authority_unavailable")
    return value


def _database_time(value: object) -> datetime:
    if not isinstance(value, datetime):
        raise AuthorityOutage("authority_unavailable")
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value
