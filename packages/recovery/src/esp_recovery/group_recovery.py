"""Inventory every mapping on a failed incarnation. A missing fence blocks the replacement."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from esp_contracts.api import STRICT
from esp_db.client import Db, transaction
from esp_provider_shared.storage_fence import FenceEvidenceMissing, StorageFence
from esp_recovery.reconcile import NativeObservedState, ReconciliationAction, reconcile_after_interrupt


def _empty_decisions() -> list[ReconciliationAction]:
    return []


class RecoveryGroupResult(BaseModel):
    model_config = STRICT
    status: Literal["blocked", "inventoried"]
    instance_id: str
    fence_evidence_ref: str | None = None
    mapping_ids: list[str] = Field(default_factory=list)
    native_session_ids: list[str] = Field(default_factory=list)
    decisions: list[ReconciliationAction] = Field(default_factory=_empty_decisions)
    max_recovery_count: int = 0


class GroupRecovery:
    """One coordinator. It never submits and never clears a conversation guard."""

    def __init__(self, db: Db, fence: StorageFence) -> None:
        self._db = db
        self._fence = fence

    async def recover_instance(self, instance_id: str, failed_incarnation_id: str) -> RecoveryGroupResult:
        unit_id = await self._storage_unit(instance_id)
        if unit_id is None:
            return RecoveryGroupResult(status="blocked", instance_id=instance_id)
        try:
            receipt = await self._fence.fence_previous_writer(unit_id, failed_incarnation_id)
        except FenceEvidenceMissing:
            return RecoveryGroupResult(status="blocked", instance_id=instance_id)
        rows = await self._mappings(instance_id)
        decisions: list[ReconciliationAction] = []
        native_ids: list[str] = []
        mapping_ids: list[str] = []
        for row in rows:
            native_id = row.get("native_session_id")
            if isinstance(native_id, str):
                native_ids.append(native_id)
            mapping_id = str(row["id"])
            mapping_ids.append(mapping_id)
            decisions.append(reconcile_after_interrupt(_from_row(row)))
            await self._note_recovery(mapping_id)
        fresh = await self._mappings(instance_id)
        counts = [_as_count(item.get("recovery_count")) for item in fresh]
        counts = [count for count in counts if count is not None]
        return RecoveryGroupResult(
            status="inventoried",
            instance_id=instance_id,
            fence_evidence_ref=receipt.fence_evidence_ref,
            mapping_ids=mapping_ids,
            native_session_ids=native_ids,
            decisions=decisions,
            max_recovery_count=max(counts) if counts else 0,
        )

    async def _storage_unit(self, instance_id: str) -> str | None:
        async with transaction(self._db) as tx:
            row = await tx.execute_one(
                "SELECT native_storage_unit_id FROM harness_instance WHERE id = %s::uuid",
                (instance_id,),
            )
        if row is None:
            return None
        unit = row["native_storage_unit_id"]
        return unit if isinstance(unit, str) and unit else None

    async def _mappings(self, instance_id: str) -> list[dict[str, object]]:
        async with transaction(self._db) as tx:
            rows = await tx.execute(
                """
                SELECT id::text AS id, native_session_id, runtime_state, cancel_requested_at,
                       recovery_count, current_native_work_ref
                FROM provider_session
                WHERE harness_instance_id = %s::uuid AND is_current
                ORDER BY id
                """,
                (instance_id,),
            )
        return rows

    async def _note_recovery(self, mapping_id: str) -> None:
        """Cap recorded restarts at two. Never decrease the counter or release the guard."""
        async with transaction(self._db) as tx:
            await tx.execute(
                """
                UPDATE provider_session
                SET recovery_count = LEAST(recovery_count + 1, 2),
                    recovery_started_at = COALESCE(recovery_started_at, transaction_timestamp()),
                    recovery_deadline_at = COALESCE(
                        recovery_deadline_at, transaction_timestamp() + make_interval(secs => 120)
                    )
                WHERE id = %s::uuid AND is_current
                """,
                (mapping_id,),
            )


def _as_count(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _from_row(row: dict[str, object]) -> NativeObservedState:
    cancelled = row.get("cancel_requested_at") is not None
    work = row.get("current_native_work_ref")
    ref = work if isinstance(work, str) else None
    state = row.get("runtime_state")
    if cancelled:
        return NativeObservedState(
            native_status="interrupted",
            acceptance="accepted",
            saved_input_available=True,
            qualified_continuation=True,
            persisted_cancellation=True,
            native_work_ref=ref,
        )
    if state == "warm_idle":
        return NativeObservedState(
            native_status="idle",
            acceptance="accepted",
            saved_input_available=True,
            qualified_continuation=False,
            persisted_cancellation=False,
            native_work_ref=ref,
        )
    return NativeObservedState(
        native_status="unknown",
        acceptance="ambiguous",
        saved_input_available=True,
        qualified_continuation=False,
        persisted_cancellation=False,
        native_work_ref=ref,
    )
