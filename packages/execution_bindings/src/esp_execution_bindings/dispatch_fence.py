"""Shared dispatch fences and exclusive revocation, incarnation before mapping."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from psycopg import errors as pg_errors

from esp_contracts.runtime import DispatchTicket, RunBinding
from esp_db.client import Db, Transaction, transaction
from esp_execution_bindings.authorize import assert_dispatchable, read_authority, read_eligibility
from esp_execution_bindings.binding import AuthorizationError

# Bounded wait for the exclusive incarnation fence in whole-process revocation. Shared holders are
# dispatches inside their bounded transport start and admissions inside their bounded transaction.
REVOCATION_LOCK_TIMEOUT = "2s"


async def with_dispatch_authority(
    binding: RunBinding,
    start: Callable[[], Awaitable[DispatchTicket]],
    *,
    db: Db,
) -> DispatchTicket:
    async with transaction(db) as tx:
        if not await _fence(tx, binding.runtime_incarnation_id, binding.provider_session_id, exclusive=False):
            raise AuthorizationError("fence_unavailable")
        record = await read_authority(tx, binding.provider_session_id)
        release_status, profile_status = await read_eligibility(tx, binding.provider_session_id)
        assert_dispatchable(record, binding, release_status, profile_status)
        # The ticket's response stays outside this transaction. Task 7 proves the real write boundary.
        return await start()


async def revoke_mapping(db: Db, mapping_id: str, expected_epoch: int) -> bool:
    try:
        async with transaction(db) as tx:
            incarnation_id = await _incarnation(tx, mapping_id)
            if incarnation_id is None or not await _fence(tx, incarnation_id, mapping_id, exclusive=True):
                raise AuthorizationError("fence_unavailable")
            updated = await tx.execute_one(
                """
                UPDATE provider_session
                SET ownership_epoch = ownership_epoch + 1, runtime_state = 'unavailable'
                WHERE id = %s::uuid AND ownership_epoch = %s AND is_current
                RETURNING id::text AS id
                """,
                (mapping_id, expected_epoch),
            )
            if updated is None:
                raise AuthorizationError("epoch_mismatch")
    except AuthorizationError:
        return False
    return True


async def revoke_incarnation(db: Db, instance_id: str, incarnation_id: str) -> list[str]:
    """Revoke a whole Process Incarnation (ProInc) and every current mapping on it (P §12.6 step 1).

    1. Mark the instance `failed` for this incarnation and commit, so placement stops choosing it at
       once, even while the fence below is unavailable. The mark is conditional on the incarnation, so
       it never touches a replacement process, and repeating it changes nothing.
    2. Take the exclusive incarnation fence, waiting at most `REVOCATION_LOCK_TIMEOUT`. While this
       request is queued PostgreSQL grants no later conflicting one, so new shared dispatch and
       admission fences on the incarnation fail at once instead of starving the revocation.
    3. Only then inventory the incarnation's current mappings. Admission writes a mapping onto an
       incarnation only while it holds the shared fence and after it has re-read that the instance is
       still ready on that incarnation. Every mapping admission can still commit there is therefore in
       this inventory, or admission refuses it.
    4. Fence and revoke each mapping: epoch + 1, state `unavailable`.

    Returns the revoked mapping IDs. An empty list means no current mapping was on the incarnation.
    Raises `AuthorizationError` when the revocation could not complete, because a fence stayed
    unavailable or a mapping changed underneath it. A database outage propagates its own error. Either
    way, at most the mark from step 1 persists, and the caller retries. A failure is never reported as
    an empty inventory.

    The ordering in step 3 holds only while every other writer keeps two invariants (Tasks 17 and 21):

    - `failed` is terminal for an `(instance, process_incarnation_id)` pair. Status and heartbeat writers
      are conditional on the incarnation and never move a `failed` incarnation back to `ready`; a
      restarted process registers a new `process_incarnation_id`. Otherwise a stale process could
      heartbeat its revoked incarnation back to `ready` after this inventory, and a later placement
      there would never be revoked.
    - Every writer that assigns a mapping to an incarnation (admission placement today; recovery
      reassignment later) holds the shared incarnation fence and re-reads readiness under it before it
      commits.
    """
    async with transaction(db) as tx:
        await tx.execute(
            """
            UPDATE harness_instance SET lifecycle_status = 'failed'
            WHERE id = %s::uuid
              AND process_incarnation_id = %s::uuid
              AND lifecycle_status IN ('starting', 'ready', 'draining', 'suspect')
            """,
            (instance_id, incarnation_id),
        )
    try:
        async with transaction(db) as tx:
            await tx.execute("SELECT set_config('lock_timeout', %s, true) AS lock_timeout", (REVOCATION_LOCK_TIMEOUT,))
            await tx.execute("SELECT esp_await_incarnation_fence(%s) AS locked", (incarnation_id,))
            rows = await tx.execute(
                """
                SELECT id::text AS id
                FROM provider_session
                WHERE harness_instance_id = %s::uuid
                  AND runtime_incarnation_id = %s::uuid
                  AND is_current
                ORDER BY id
                """,
                (instance_id, incarnation_id),
            )
            mapping_ids = [str(row["id"]) for row in rows]
            for mapping_id in mapping_ids:
                if not await _fence(tx, incarnation_id, mapping_id, exclusive=True):
                    raise AuthorizationError("fence_unavailable")
            revoked: list[str] = []
            for mapping_id in mapping_ids:
                updated = await tx.execute_one(
                    """
                    UPDATE provider_session
                    SET ownership_epoch = ownership_epoch + 1, runtime_state = 'unavailable'
                    WHERE id = %s::uuid AND runtime_incarnation_id = %s::uuid AND is_current
                    RETURNING id::text AS id
                    """,
                    (mapping_id, incarnation_id),
                )
                if updated is None:
                    raise AuthorizationError("epoch_mismatch")
                revoked.append(str(updated["id"]))
    except (pg_errors.LockNotAvailable, pg_errors.QueryCanceled) as exc:
        raise AuthorizationError("fence_unavailable") from exc
    return revoked


async def clear_terminal_guard(db: Db, mapping_id: str, expected_epoch: int) -> bool:
    try:
        async with transaction(db) as tx:
            incarnation_id = await _incarnation(tx, mapping_id)
            if incarnation_id is None or not await _fence(tx, incarnation_id, mapping_id, exclusive=True):
                raise AuthorizationError("fence_unavailable")
            updated = await tx.execute_one(
                """
                UPDATE conversation AS c
                SET active_provider_session_id = NULL, updated_at = transaction_timestamp()
                FROM provider_session AS ps
                WHERE ps.id = %s::uuid
                  AND ps.ownership_epoch = %s
                  AND ps.is_current
                  AND c.id = ps.conversation_id
                  AND c.active_provider_session_id = ps.id
                RETURNING c.id::text AS id
                """,
                (mapping_id, expected_epoch),
            )
            if updated is None:
                raise AuthorizationError("epoch_mismatch")
    except AuthorizationError:
        return False
    return True


async def register_native_session(db: Db, mapping_id: str, expected_epoch: int, native_session_id: str) -> bool:
    try:
        async with transaction(db) as tx:
            incarnation_id = await _incarnation(tx, mapping_id)
            if incarnation_id is None or not await _fence(tx, incarnation_id, mapping_id, exclusive=True):
                raise AuthorizationError("fence_unavailable")
            updated = await tx.execute_one(
                """
                UPDATE provider_session
                SET native_session_id = %s
                WHERE id = %s::uuid
                  AND ownership_epoch = %s
                  AND (native_session_id IS NULL OR native_session_id = %s)
                RETURNING id::text AS id
                """,
                (native_session_id, mapping_id, expected_epoch, native_session_id),
            )
            if updated is None:
                raise AuthorizationError("epoch_mismatch")
    except AuthorizationError:
        return False
    return True


async def withdraw_release(db: Db, release_id: str) -> bool:
    return await _mutate_eligibility(
        db,
        """
        SELECT ps.runtime_incarnation_id::text AS incarnation_id, ps.id::text AS mapping_id
        FROM provider_session AS ps
        WHERE ps.brain_release_id = %s AND ps.is_current AND ps.runtime_incarnation_id IS NOT NULL
        ORDER BY ps.runtime_incarnation_id::text, ps.id::text
        """,
        (release_id,),
        """
        UPDATE brain_release SET status = 'withdrawn'
        WHERE version = %s AND status <> 'withdrawn'
        RETURNING version
        """,
        (release_id,),
    )


async def disable_profile(db: Db, qualification_id: str) -> bool:
    return await _mutate_eligibility(
        db,
        """
        SELECT ps.runtime_incarnation_id::text AS incarnation_id, ps.id::text AS mapping_id
        FROM provider_session AS ps
        JOIN provider_deployment AS pd ON pd.id = ps.deployment_ref
        WHERE pd.shared_process_qualification_id = %s
          AND ps.is_current
          AND ps.runtime_incarnation_id IS NOT NULL
        ORDER BY ps.runtime_incarnation_id::text, ps.id::text
        """,
        (qualification_id,),
        """
        UPDATE runtime_qualification SET status = 'invalidated'
        WHERE id = %s AND status <> 'invalidated'
        RETURNING id
        """,
        (qualification_id,),
    )


async def _mutate_eligibility(
    db: Db,
    inventory_sql: str,
    inventory_params: tuple[object, ...],
    update_sql: str,
    update_params: tuple[object, ...],
) -> bool:
    try:
        async with transaction(db) as tx:
            rows = await tx.execute(inventory_sql, inventory_params)
            for row in rows:
                incarnation_id = row["incarnation_id"]
                mapping_id = row["mapping_id"]
                if not isinstance(incarnation_id, str) or not isinstance(mapping_id, str):
                    raise AuthorizationError("fence_unavailable")
                if not await _fence(tx, incarnation_id, mapping_id, exclusive=True):
                    raise AuthorizationError("fence_unavailable")
            updated = await tx.execute_one(update_sql, update_params)
            if updated is None:
                raise AuthorizationError("authority_unavailable")
    except AuthorizationError:
        return False
    return True


async def _fence(tx: Transaction, incarnation_id: str, mapping_id: str, *, exclusive: bool) -> bool:
    row = await tx.execute_one(
        "SELECT esp_try_fence(%s, %s, %s) AS locked",
        (incarnation_id, mapping_id, exclusive),
    )
    return row is not None and row["locked"] is True


async def _incarnation(tx: Transaction, mapping_id: str) -> str | None:
    row = await tx.execute_one(
        "SELECT runtime_incarnation_id::text AS incarnation_id FROM provider_session WHERE id = %s::uuid",
        (mapping_id,),
    )
    if row is None or not isinstance(row["incarnation_id"], str):
        return None
    return row["incarnation_id"]
