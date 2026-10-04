"""Release a conversation run after a provider completion that will never finish the reply.

A finished reply clears the run in `SessionLifecycle.finish_run`. An upstream non-success
completion, including HTTP 403, does not produce that reply, so the same clear runs here.
"""

from __future__ import annotations

from psycopg import errors as pg_errors

from esp_contracts.runtime import RunBinding
from esp_db.client import Db, Transaction, transaction

_LOCK_ERRORS = (pg_errors.LockNotAvailable, pg_errors.QueryCanceled)

# Same column clear as SessionLifecycle.finish_run. The work predicate differs: a finished reply
# names its work, while a provider failure often carries the inference token minted before that
# reference was stored.
_CLEAR_RUN = """
UPDATE provider_session SET
    active_agent_run_id = NULL,
    current_request_id = NULL,
    current_native_work_ref = NULL,
    owner_lease_expires_at = NULL,
    active_agent_run_expires_at = NULL,
    cancel_requested_at = NULL,
    runtime_state = 'warm_idle',
    last_used_at = transaction_timestamp()
WHERE id = %s::uuid
  AND is_current
  AND ownership_epoch = %s
  AND active_agent_run_id = %s::uuid
  AND native_session_id = %s
"""


def provider_completion_failed(status: int) -> bool:
    """True when an upstream completion is not an HTTP success."""
    return status < 200 or status >= 300


async def clear_finished_run(
    db: Db,
    binding: RunBinding,
    *,
    native_work_ref: str | None,
    provider_failure: bool = False,
) -> bool:
    """Clear one run. False when the epoch, run or work no longer matches, or the row is locked.

    `provider_failure` is the path a non-success provider completion takes. A missing work reference
    still clears this running run. A different recorded reference does not.
    """
    try:
        async with transaction(db) as tx:
            locked = await tx.execute_one(
                "SELECT esp_try_fence(%s, %s, true) AS locked",
                (binding.runtime_incarnation_id, binding.provider_session_id),
            )
            if locked is None or locked["locked"] is not True:
                return False
            held = await tx.execute_one(
                "SELECT id FROM provider_session WHERE id = %s::uuid FOR UPDATE NOWAIT",
                (binding.provider_session_id,),
            )
            if held is None:
                return False
            if provider_failure:
                statement = (
                    _CLEAR_RUN
                    + """
                      AND runtime_state = 'running'
                      AND (%s::text IS NULL OR current_native_work_ref IS NULL OR current_native_work_ref = %s)
                    RETURNING conversation_id::text AS conversation_id
                    """
                )
                params: tuple[object, ...] = (
                    binding.provider_session_id,
                    binding.ownership_epoch,
                    binding.active_agent_run_id,
                    binding.native_session_id,
                    native_work_ref,
                    native_work_ref,
                )
            else:
                statement = (
                    _CLEAR_RUN
                    + """
                      AND current_native_work_ref = %s
                    RETURNING conversation_id::text AS conversation_id
                """
                )
                params = (
                    binding.provider_session_id,
                    binding.ownership_epoch,
                    binding.active_agent_run_id,
                    binding.native_session_id,
                    native_work_ref,
                )
            cleared = await tx.execute_one(statement, params)
            if cleared is None:
                return False
            await _release_run_slots(tx, binding.provider_session_id, binding.ownership_epoch)
            await tx.execute(
                """
                UPDATE conversation SET active_provider_session_id = NULL
                WHERE id = %s::uuid AND active_provider_session_id = %s::uuid
                """,
                (cleared["conversation_id"], binding.provider_session_id),
            )
            return True
    except _LOCK_ERRORS:
        return False


async def _release_run_slots(tx: Transaction, provider_session_id: str, reservation_epoch: int) -> None:
    """Release the active and provider slots one run reserved. Resident capacity stays."""
    await tx.execute(
        """
        UPDATE capacity_slot
        SET holder_provider_session_id = NULL, reservation_epoch = NULL
        WHERE holder_provider_session_id = %s::uuid
          AND reservation_epoch = %s
          AND scope IN ('active', 'provider')
        """,
        (provider_session_id, reservation_epoch),
    )
