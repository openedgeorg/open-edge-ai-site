"""Compare a binding with the current primary row. Nothing is cached."""

from __future__ import annotations

from datetime import datetime

from esp_contracts.runtime import AuthorityRecord, RunBinding
from esp_db.client import Db, Transaction, transaction
from esp_db.records import AUTHORITY_COLUMNS
from esp_execution_bindings.binding import AuthorizationError

_ALLOWED_RELEASE = {"draft", "reviewed", "production"}
_ALLOWED_PROFILE = {"pending", "validated"}


async def authorize_binding(binding: RunBinding, *, db: Db) -> AuthorityRecord:
    async with transaction(db) as tx:
        record = await read_authority(tx, binding.provider_session_id)
        release_status, profile_status = await read_eligibility(tx, binding.provider_session_id)
    assert_dispatchable(record, binding, release_status, profile_status)
    if record is None:
        raise AuthorizationError("authority_unavailable")
    return record


async def read_authority(tx: Transaction, provider_session_id: str) -> AuthorityRecord | None:
    columns = ", ".join(AUTHORITY_COLUMNS)
    query = f"SELECT {columns} FROM current_authority WHERE provider_session_id = %s"  # noqa: S608
    row = await tx.execute_one(query, (provider_session_id,))
    if row is None:
        return None
    return AuthorityRecord.model_validate(row)


async def read_eligibility(tx: Transaction, provider_session_id: str) -> tuple[str | None, str | None]:
    row = await tx.execute_one(
        """
        SELECT br.status AS release_status, rq.status AS profile_status
        FROM provider_session AS ps
        LEFT JOIN brain_release AS br ON br.version = ps.brain_release_id
        LEFT JOIN provider_deployment AS pd ON pd.id = ps.deployment_ref
        LEFT JOIN runtime_qualification AS rq ON rq.id = pd.shared_process_qualification_id
        WHERE ps.id = %s::uuid
        """,
        (provider_session_id,),
    )
    if row is None:
        return None, None
    release_status = row["release_status"]
    profile_status = row["profile_status"]
    return (
        release_status if isinstance(release_status, str) else None,
        profile_status if isinstance(profile_status, str) else None,
    )


def assert_dispatchable(
    record: AuthorityRecord | None,
    binding: RunBinding,
    release_status: str | None,
    profile_status: str | None,
) -> None:
    if record is None or not record.is_current:
        raise AuthorizationError("authority_unavailable")
    if not _same(record, binding):
        raise AuthorizationError("authority_mismatch")
    if record.runtime_state != "running" or record.cancel_requested:
        raise AuthorizationError("authority_unavailable")
    if record.guard_provider_session_id != record.provider_session_id:
        raise AuthorizationError("guard_mismatch")
    if not _future(record.database_time, record.owner_lease_expires_at) or not _future(
        record.database_time, record.active_agent_run_expires_at
    ):
        raise AuthorizationError("lease_expired")
    if record.database_time >= binding.expires_at:
        raise AuthorizationError("lease_expired")
    if release_status not in _ALLOWED_RELEASE:
        raise AuthorizationError("release_unavailable")
    if profile_status not in _ALLOWED_PROFILE:
        raise AuthorizationError("profile_disabled")


def _same(record: AuthorityRecord, binding: RunBinding) -> bool:
    return (
        record.conversation_id == binding.conversation_id
        and record.provider_session_id == binding.provider_session_id
        and record.session_generation == binding.session_generation
        and record.native_session_id == binding.native_session_id
        and record.active_agent_run_id == binding.active_agent_run_id
        and record.harness_instance_id == binding.harness_instance_id
        and record.runtime_incarnation_id == binding.runtime_incarnation_id
        and record.ownership_epoch == binding.ownership_epoch
        and record.provider == binding.provider
        and record.model == binding.model
        and record.brain_release_id == binding.brain_release_id
        and record.brain_hash == binding.brain_hash
        and record.behavior_version == binding.behavior_version
        and record.behavior_hash == binding.behavior_hash
        and record.corpus_release_id == binding.corpus_release_id
        and record.deployment_ref == binding.deployment_ref
    )


def _future(database_time: datetime, deadline: datetime | None) -> bool:
    return deadline is not None and database_time < deadline
