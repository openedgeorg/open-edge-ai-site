"""HTTP-independent session supervision: terminal clear, leases, cancel, idle eviction and drain.

Admission has already reserved capacity. This module never starts model work and never reads visitor
text. A browser connection, a status read and a missing token stream do not govern a run.

Terminal clear is conditional on the run, epoch, native id and work reference. It releases the
conversation guard and the active and provider slots, and it leaves the resident slot until a confirmed
unload. Cancellation keeps that guard until the owning harness confirms the named work stopped. An
ignored or failed cancel, or an unsupported unload, records group recovery and does not stop the
process or any peer. Idle eviction and drain skip a native session whose in-place read is in flight.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import Any, Literal, cast

import psycopg
from pydantic import ValidationError

from esp_contracts.api import RuntimeStateName, SubmissionView
from esp_contracts.ids import Provider
from esp_contracts.runtime import (
    NativeEvent,
    NativeStatus,
    OperationAuthority,
    RunBinding,
    SessionHandle,
    WorkRef,
)
from esp_db.client import Db, Transaction, transaction
from esp_espcon.conversation import ConversationNotFound
from esp_execution_bindings.authorize import read_authority
from esp_execution_bindings.binding import AuthorizationError, TokenSigner, mint_operation_authority
from esp_observability.traces import RecoveryTrace
from esp_provider_router.router import NativeRuntimeAdapter, ProviderRouter
from esp_provider_shared.storage_fence import FenceEvidenceMissing, FenceReceipt, StorageFence
from esp_provider_shared.supervisor import publish_recovery
from esp_recovery.group_recovery import GroupRecovery, RecoveryGroupResult
from esp_request_admission.admit import LEASE_SECONDS
from esp_runtime_placement.capacity import release_run_slots

_Outcome = Literal[
    "accepted",
    "running",
    "completed",
    "not_started",
    "submission_unconfirmed",
    "cancelled",
    "failed",
]
_Drain = Literal["draining", "stopped"]

IDLE_SECONDS = 900
RENEW_INTERVAL_SECONDS = 5
RECOVERY_DEADLINE_SECONDS = 120
_RENEW_REMAINING_SECONDS = LEASE_SECONDS - RENEW_INTERVAL_SECONDS
_LOCK_ERRORS = (psycopg.errors.LockNotAvailable, psycopg.errors.QueryCanceled)
_MAPPING = """
    SELECT c.owner_subject_id,
           ps.id::text AS id,
           ps.conversation_id::text AS conversation_id,
           ps.session_generation,
           ps.native_session_id,
           ps.active_agent_run_id::text AS active_agent_run_id,
           ps.harness_instance_id::text AS harness_instance_id,
           ps.runtime_incarnation_id::text AS runtime_incarnation_id,
           ps.native_storage_unit_id,
           ps.state_location,
           ps.ownership_epoch,
           ps.provider,
           ps.model,
           ps.brain_release_id,
           ps.brain_hash,
           ps.behavior_version,
           ps.behavior_hash,
           ps.corpus_release_id,
           ps.deployment_ref,
           ps.runtime_state,
           ps.current_request_id,
           ps.current_native_work_ref,
           ps.owner_lease_expires_at,
           ps.active_agent_run_expires_at,
           ps.cancel_requested_at,
           ps.last_used_at,
           transaction_timestamp() AS database_time
    FROM provider_session AS ps
    JOIN conversation AS c ON c.id = ps.conversation_id
"""


class _BlockedFence:
    """No configured fence. Replacement stays blocked instead of inventing a receipt."""

    async def fence_previous_writer(self, unit_id: str, incarnation_id: str) -> FenceReceipt:
        del unit_id, incarnation_id
        raise FenceEvidenceMissing("no fence configured")


class SessionLifecycle:
    """Conditional runtime transitions for one backend. Holds no visitor input."""

    def __init__(
        self,
        db: Db,
        adapters: Mapping[Provider, NativeRuntimeAdapter],
        signer: TokenSigner,
        resident_reads: set[str],
        fence: StorageFence | None = None,
    ) -> None:
        self._db = db
        self._router = ProviderRouter.for_providers(adapters)
        self._pools = list(adapters.values())
        self._signer = signer
        self._resident_reads = resident_reads
        self._recovery = GroupRecovery(db, fence if fence is not None else _BlockedFence())

    async def recover_instance(self, instance_id: str, failed_incarnation_id: str) -> RecoveryGroupResult:
        """Replace a writer only after a positive fence. No fence configured means blocked."""
        return await self._recovery.recover_instance(instance_id, failed_incarnation_id)

    async def finish_run(self, binding: RunBinding, work: WorkRef) -> bool:
        """Clear one terminal run. False when the epoch, run or work no longer matches, or the row is locked."""
        if binding.native_session_id != work.native_session_id:
            return False
        try:
            async with transaction(self._db) as tx:
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
                cleared = await tx.execute_one(
                    """
                    UPDATE provider_session SET
                        active_agent_run_id = NULL,
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
                      AND current_native_work_ref = %s
                    RETURNING conversation_id::text AS conversation_id
                    """,
                    (
                        binding.provider_session_id,
                        binding.ownership_epoch,
                        binding.active_agent_run_id,
                        binding.native_session_id,
                        work.native_work_ref,
                    ),
                )
                if cleared is None:
                    return False
                await release_run_slots(tx, binding.provider_session_id, binding.ownership_epoch)
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

    async def renew_ownership(self, binding: RunBinding) -> OperationAuthority:
        """Extend the 30s lease only. The original run deadline, epoch and last use stay put.

        Raises AuthorizationError when the lease is already past. Nothing is written in that case.
        """
        identity = (binding.provider_session_id, binding.ownership_epoch, binding.active_agent_run_id)
        async with transaction(self._db) as tx:
            current = await tx.execute_one(
                """
                SELECT owner_lease_expires_at
                FROM provider_session
                WHERE id = %s::uuid
                  AND is_current
                  AND ownership_epoch = %s
                  AND active_agent_run_id = %s::uuid
                  AND runtime_state = 'running'
                  AND cancel_requested_at IS NULL
                  AND owner_lease_expires_at > transaction_timestamp()
                  AND active_agent_run_expires_at > transaction_timestamp()
                FOR UPDATE
                """,
                identity,
            )
            if current is None or not isinstance(current["owner_lease_expires_at"], datetime):
                raise AuthorizationError("lease_expired")
            previous = current["owner_lease_expires_at"]
            renewed = await tx.execute_one(
                """
                UPDATE provider_session
                SET owner_lease_expires_at = transaction_timestamp() + make_interval(secs => %s)
                WHERE id = %s::uuid
                  AND is_current
                  AND ownership_epoch = %s
                  AND active_agent_run_id = %s::uuid
                RETURNING id::text AS id
                """,
                (LEASE_SECONDS, *identity),
            )
            if renewed is None:
                raise AuthorizationError("lease_expired")
            record = await read_authority(tx, binding.provider_session_id)
            handle = await _handle_in(tx, binding.provider_session_id)
        if record is None or handle is None:
            await self._restore_lease(binding, previous)
            raise AuthorizationError("authority_unavailable")
        authority = mint_operation_authority(record, signer=self._signer)
        try:
            await self._refresh(handle, authority)
        except Exception:
            await self._restore_lease(binding, previous)
            raise
        return authority

    async def cancel_run(self, subject_id: str, conversation_id: str, run_id: str) -> SubmissionView:
        """Stop one run of this conversation. The guard stays until that stop is confirmed."""
        row = await self._owned(subject_id, conversation_id)
        active = row["active_agent_run_id"]
        if active != run_id:
            return _view(row)
        await self._mark_cancelling(row)
        outcome = await self._native_cancel(row)
        status = await self._inspect(row)
        stopped = outcome == "stopped" or (status is not None and status.status == "interrupted")
        if stopped or (status is not None and status.status in ("completed", "failed")):
            work_ref = row["current_native_work_ref"]
            if status is not None and isinstance(status.native_work_ref, str) and status.native_work_ref:
                work_ref = status.native_work_ref
            if isinstance(work_ref, str) and work_ref:
                fresh = await self._mapping_by_id(str(row["id"]))
                if fresh is not None:
                    await self._finish_row(fresh, work_ref)
            released = await self._mapping_by_id(str(row["id"]))
            if released is None:
                raise ConversationNotFound(conversation_id)
            if released["active_agent_run_id"] is None:
                return _view(released, outcome="cancelled")
        code = "cancel_failed" if outcome == "unknown" or status is None else "cancel_unconfirmed"
        if status is not None and status.status == "running" and outcome == "requested":
            code = "cancel_unconfirmed"
        elif outcome == "unknown" or status is None:
            code = "cancel_failed"
        await self._record_cancel_recovery(str(row["id"]), _as_int(row["ownership_epoch"]), str(active), code)
        held = await self._mapping_by_id(str(row["id"]))
        if held is None:
            raise ConversationNotFound(conversation_id)
        return _view(held)

    async def evict_idle(self, now: datetime) -> list[str]:
        """Unload warm-idle sessions whose last use is at least 900s before `now`. Busy sessions stay."""
        rows = await self._idle_rows(now)
        released: list[str] = []
        for row in rows:
            native_id = row["native_session_id"]
            if isinstance(native_id, str) and native_id in self._resident_reads:
                continue
            if not self._hosted(row):
                continue
            if await self._unload_resident(row):
                released.append(str(row["id"]))
        return released

    async def drain_instance(self, instance_id: str) -> _Drain:
        """Stop admitting to one instance, unload its idle sessions, and stop only when none remain."""
        status = await self._instance_status(instance_id)
        if status is None:
            raise ValueError("unknown harness instance")
        if status == "stopped":
            return "stopped"
        if status not in ("ready", "draining"):
            return "draining"
        if status == "ready":
            await self._mark_draining(instance_id)
        busy = False
        for row in await self._instance_rows(instance_id):
            state = row["runtime_state"]
            if state == "unloaded":
                continue
            native_id = row["native_session_id"]
            in_read = isinstance(native_id, str) and native_id in self._resident_reads
            if state == "warm_idle" and isinstance(native_id, str) and not in_read:
                if not await self._unload_resident(row):
                    busy = True
                continue
            busy = True
        if busy:
            return "draining"
        await self._mark_stopped(instance_id)
        return "stopped"

    async def consume_control_events(self) -> None:
        """Drain native notifications and reconcile unresolved runs. Not an HTTP request."""
        events = await self._take_events()
        await self._apply_events(events)
        await self._reconcile_unresolved()
        await self._renew_due()
        late = await self._take_events()
        if late:
            await self._apply_events(late)

    async def _apply_events(self, events: list[NativeEvent]) -> None:
        for event in events:
            row = await self._mapping_by_id(str(event.provider_session_id))
            if row is None or _in_read(self._resident_reads, row):
                continue
            if _event_matches(event, row) and _event_terminal(event, row):
                await self._finish_row(row, event.native_work_ref)
                continue
            await self._inspect(row)

    async def _reconcile_unresolved(self) -> None:
        for row in await self._unresolved_rows():
            if _in_read(self._resident_reads, row) or not self._hosted(row):
                continue
            status = await self._inspect(row)
            if status is None or not _status_terminal(status.status, row):
                continue
            work_ref = status.native_work_ref if status.native_work_ref else row["current_native_work_ref"]
            if isinstance(work_ref, str) and work_ref:
                fresh = await self._mapping_by_id(str(row["id"]))
                if fresh is not None and fresh["active_agent_run_id"] is not None:
                    await self._finish_row(fresh, work_ref)

    async def _renew_due(self) -> None:
        for row in await self._due_rows():
            if not self._hosted(row):
                continue
            binding = _as_binding(row)
            if binding is None:
                continue
            try:
                await self.renew_ownership(binding)
            except (AuthorizationError, OSError, RuntimeError, TimeoutError):
                continue

    async def _finish_row(self, row: Mapping[str, object], work_ref: str) -> bool:
        binding = _as_binding(row)
        native_id = row["native_session_id"]
        if binding is None or not isinstance(native_id, str):
            return False
        return await self.finish_run(binding, WorkRef(native_session_id=native_id, native_work_ref=work_ref))

    async def _owned(self, subject_id: str, conversation_id: str) -> Mapping[str, object]:
        try:
            parsed = str(uuid.UUID(conversation_id))
        except (ValueError, TypeError, AttributeError) as exc:
            raise ConversationNotFound(conversation_id) from exc
        async with transaction(self._db) as tx:
            row = await tx.execute_one(
                _MAPPING + " WHERE c.id = %s::uuid AND ps.is_current",
                (parsed,),
            )
        if row is None or row["owner_subject_id"] != subject_id or row["id"] is None:
            raise ConversationNotFound(conversation_id)
        return row

    async def _mapping_by_id(self, provider_session_id: str) -> Mapping[str, object] | None:
        async with transaction(self._db) as tx:
            return await tx.execute_one(
                _MAPPING + " WHERE ps.id = %s::uuid AND ps.is_current",
                (provider_session_id,),
            )

    async def _restore_lease(self, binding: RunBinding, previous: datetime) -> None:
        """Put the lease back when the harness never received the refreshed tokens."""
        async with transaction(self._db) as tx:
            await tx.execute(
                """
                UPDATE provider_session
                SET owner_lease_expires_at = %s
                WHERE id = %s::uuid
                  AND is_current
                  AND ownership_epoch = %s
                  AND active_agent_run_id = %s::uuid
                  AND runtime_state = 'running'
                """,
                (previous, binding.provider_session_id, binding.ownership_epoch, binding.active_agent_run_id),
            )

    async def _idle_rows(self, now: datetime) -> list[dict[str, Any]]:
        async with transaction(self._db) as tx:
            return await tx.execute(
                _MAPPING
                + """
                WHERE ps.is_current
                  AND ps.runtime_state = 'warm_idle'
                  AND ps.native_session_id IS NOT NULL
                  AND ps.last_used_at <= %s::timestamptz - make_interval(secs => %s)
                """,
                (now, IDLE_SECONDS),
            )

    async def _unresolved_rows(self) -> list[dict[str, Any]]:
        async with transaction(self._db) as tx:
            return await tx.execute(
                _MAPPING
                + """
                WHERE ps.is_current
                  AND ps.runtime_state IN ('running', 'cancelling')
                  AND ps.active_agent_run_id IS NOT NULL
                  AND ps.native_session_id IS NOT NULL
                """,
                (),
            )

    async def _due_rows(self) -> list[dict[str, Any]]:
        async with transaction(self._db) as tx:
            return await tx.execute(
                _MAPPING
                + """
                WHERE ps.is_current
                  AND ps.runtime_state = 'running'
                  AND ps.cancel_requested_at IS NULL
                  AND ps.active_agent_run_id IS NOT NULL
                  AND ps.owner_lease_expires_at > transaction_timestamp()
                  AND ps.owner_lease_expires_at <= transaction_timestamp() + make_interval(secs => %s)
                  AND ps.active_agent_run_expires_at > transaction_timestamp()
                """,
                (_RENEW_REMAINING_SECONDS,),
            )

    async def _instance_rows(self, instance_id: str) -> list[dict[str, Any]]:
        async with transaction(self._db) as tx:
            return await tx.execute(
                _MAPPING + " WHERE ps.is_current AND ps.harness_instance_id = %s::uuid",
                (instance_id,),
            )

    async def _instance_status(self, instance_id: str) -> str | None:
        try:
            parsed = str(uuid.UUID(instance_id))
        except (ValueError, TypeError, AttributeError) as exc:
            raise ValueError("unknown harness instance") from exc
        async with transaction(self._db) as tx:
            row = await tx.execute_one(
                "SELECT lifecycle_status FROM harness_instance WHERE id = %s::uuid",
                (parsed,),
            )
        if row is None:
            return None
        status = row["lifecycle_status"]
        return status if isinstance(status, str) else None

    async def _mark_draining(self, instance_id: str) -> None:
        async with transaction(self._db) as tx:
            await tx.execute(
                """
                UPDATE harness_instance
                SET lifecycle_status = 'draining',
                    drain_started_at = COALESCE(drain_started_at, transaction_timestamp())
                WHERE id = %s::uuid AND lifecycle_status = 'ready'
                """,
                (instance_id,),
            )

    async def _mark_stopped(self, instance_id: str) -> None:
        async with transaction(self._db) as tx:
            await tx.execute(
                """
                UPDATE harness_instance SET lifecycle_status = 'stopped'
                WHERE id = %s::uuid AND lifecycle_status = 'draining'
                """,
                (instance_id,),
            )

    async def _mark_cancelling(self, row: Mapping[str, object]) -> None:
        async with transaction(self._db) as tx:
            await tx.execute(
                """
                UPDATE provider_session
                SET runtime_state = 'cancelling',
                    cancel_requested_at = COALESCE(cancel_requested_at, transaction_timestamp())
                WHERE id = %s::uuid
                  AND is_current
                  AND ownership_epoch = %s
                  AND active_agent_run_id = %s::uuid
                """,
                (row["id"], row["ownership_epoch"], row["active_agent_run_id"]),
            )

    async def _record_cancel_recovery(self, mapping_id: str, epoch: int, run_id: str, code: str) -> None:
        async with transaction(self._db) as tx:
            await tx.execute(
                """
                UPDATE provider_session
                SET runtime_state = 'cancelling',
                    cancel_requested_at = COALESCE(cancel_requested_at, transaction_timestamp()),
                    recovery_count = CASE
                        WHEN recovery_started_at IS NULL THEN recovery_count + 1 ELSE recovery_count END,
                    recovery_started_at = COALESCE(recovery_started_at, transaction_timestamp()),
                    recovery_deadline_at = COALESCE(
                        recovery_deadline_at, transaction_timestamp() + make_interval(secs => %s)
                    ),
                    last_failure_code = %s
                WHERE id = %s::uuid
                  AND is_current
                  AND ownership_epoch = %s
                  AND active_agent_run_id = %s::uuid
                """,
                (RECOVERY_DEADLINE_SECONDS, code, mapping_id, epoch, run_id),
            )
        publish_recovery(
            RecoveryTrace(
                active_agent_run_id=run_id,
                ownership_epoch=epoch,
                recovery_mode="cancel_unconfirmed",
                recovery_reason=code,
                session_state="cancelling",
            )
        )

    async def _unload_resident(self, row: Mapping[str, object]) -> bool:
        outcome = await self._native_unload(row)
        if outcome == "unloaded":
            return await self._commit_unloaded(row)
        code = "unload_unsupported" if outcome == "unsupported" else "unload_failed"
        await self._commit_unload_failure(row, code)
        return False

    async def _commit_unloaded(self, row: Mapping[str, object]) -> bool:
        async with transaction(self._db) as tx:
            cleared = await tx.execute_one(
                """
                UPDATE provider_session SET runtime_state = 'unloaded'
                WHERE id = %s::uuid
                  AND is_current
                  AND ownership_epoch = %s
                  AND runtime_state = 'warm_idle'
                RETURNING id
                """,
                (row["id"], row["ownership_epoch"]),
            )
            if cleared is None:
                return False
            await tx.execute(
                """
                UPDATE capacity_slot
                SET holder_provider_session_id = NULL, reservation_epoch = NULL
                WHERE scope = 'resident' AND holder_provider_session_id = %s::uuid
                """,
                (row["id"],),
            )
            return True

    async def _commit_unload_failure(self, row: Mapping[str, object], code: str) -> None:
        async with transaction(self._db) as tx:
            await tx.execute(
                """
                UPDATE provider_session
                SET runtime_state = 'recovering',
                    recovery_count = CASE
                        WHEN recovery_started_at IS NULL THEN recovery_count + 1 ELSE recovery_count END,
                    recovery_started_at = COALESCE(recovery_started_at, transaction_timestamp()),
                    recovery_deadline_at = COALESCE(
                        recovery_deadline_at, transaction_timestamp() + make_interval(secs => %s)
                    ),
                    last_failure_code = %s
                WHERE id = %s::uuid AND is_current AND ownership_epoch = %s AND runtime_state = 'warm_idle'
                """,
                (RECOVERY_DEADLINE_SECONDS, code, row["id"], row["ownership_epoch"]),
            )
        native_id = row.get("native_session_id")
        publish_recovery(
            RecoveryTrace(
                native_session_id=native_id if isinstance(native_id, str) else None,
                ownership_epoch=_as_int(row.get("ownership_epoch")),
                recovery_mode="unload_unconfirmed",
                recovery_reason=code,
                session_state="recovering",
            )
        )

    async def _native_cancel(self, row: Mapping[str, object]) -> Literal["requested", "stopped", "unknown"]:
        handle = _as_handle(row)
        work_ref = row["current_native_work_ref"]
        native_id = row["native_session_id"]
        if handle is None or not isinstance(work_ref, str) or not isinstance(native_id, str):
            return "unknown"
        adapter = self._router.adapter_for(handle.provider)
        method = getattr(adapter, "cancel", None)
        if not callable(method):
            return "unknown"
        canceller = cast(Callable[[SessionHandle, WorkRef], Awaitable[object]], method)
        try:
            outcome = await canceller(handle, WorkRef(native_session_id=native_id, native_work_ref=work_ref))
        except Exception:
            return "unknown"
        if outcome == "requested":
            return "requested"
        if outcome == "stopped":
            return "stopped"
        return "unknown"

    async def _native_unload(self, row: Mapping[str, object]) -> Literal["unloaded", "unsupported", "failed"]:
        handle = _as_handle(row)
        if handle is None:
            return "failed"
        adapter = self._router.adapter_for(handle.provider)
        method = getattr(adapter, "unload", None)
        if not callable(method):
            return "unsupported"
        unloader = cast(Callable[[SessionHandle], Awaitable[object]], method)
        try:
            outcome = await unloader(handle)
        except Exception:
            return "failed"
        if outcome == "unloaded":
            return "unloaded"
        if outcome == "unsupported":
            return "unsupported"
        return "failed"

    async def _inspect(self, row: Mapping[str, object]) -> NativeStatus | None:
        if _in_read(self._resident_reads, row):
            return None
        handle = _as_handle(row)
        if handle is None:
            return None
        adapter = self._router.adapter_for(handle.provider)
        request_id = row["current_request_id"]
        requested = request_id if isinstance(request_id, str) else None
        try:
            return await adapter.inspect(handle, requested)
        except Exception:
            return None

    def _hosted(self, row: Mapping[str, Any]) -> bool:
        """Whether this backend's pool actually hosts the row's process.

        An in-process pool exposes `_cluster`. A network pool does not, and then every current row is in scope.
        Skipping a process this pool cannot reach keeps a shared test database from being supervised by the wrong lab.
        """
        handle = _as_handle(row)
        if handle is None:
            return False
        adapter = self._router.adapter_for(handle.provider)
        cluster = getattr(adapter, "_cluster", None)
        if cluster is None:
            return True
        processes = getattr(cluster, "processes", None)
        if not isinstance(processes, dict):
            return True
        process = cast(Mapping[object, object], processes).get(handle.harness_instance_id)
        if process is None:
            return False
        return getattr(process, "incarnation_id", None) == handle.runtime_incarnation_id

    async def _refresh(self, handle: SessionHandle, authority: OperationAuthority) -> None:
        adapter = self._router.adapter_for(handle.provider)
        method = getattr(adapter, "refresh_tokens", None)
        if not callable(method):
            raise AuthorizationError("authority_unavailable")
        refresher = cast(Callable[[SessionHandle, OperationAuthority], Awaitable[None]], method)
        await refresher(handle, authority)

    async def _take_events(self) -> list[NativeEvent]:
        taken: list[NativeEvent] = []
        idle_passes = 0
        while idle_passes < 4:
            await asyncio.sleep(0)
            batch = _drain_pools(self._pools)
            if batch:
                taken.extend(batch)
                idle_passes = 0
            else:
                idle_passes += 1
        return taken


def _drain_pools(pools: list[NativeRuntimeAdapter]) -> list[NativeEvent]:
    events: list[NativeEvent] = []
    for pool in pools:
        adapters = getattr(pool, "_adapters", None)
        if not isinstance(adapters, dict):
            continue
        adapter_map = cast(Mapping[object, object], adapters)
        for item in adapter_map.values():
            inner = cast(object, item[0] if isinstance(item, tuple) else item)
            queues = getattr(inner, "_events", None)
            if not isinstance(queues, dict):
                continue
            for queue in cast(Mapping[object, object], queues).values():
                if not isinstance(queue, asyncio.Queue):
                    continue
                event_queue = cast(asyncio.Queue[object], queue)
                while True:
                    try:
                        event = event_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    if isinstance(event, NativeEvent):
                        events.append(event)
    return events


def _in_read(resident_reads: set[str], row: Mapping[str, object]) -> bool:
    native_id = row.get("native_session_id")
    return isinstance(native_id, str) and native_id in resident_reads


def _event_matches(event: NativeEvent, row: Mapping[str, object]) -> bool:
    return (
        str(event.provider_session_id) == row.get("id")
        and event.native_session_id == row.get("native_session_id")
        and str(event.active_agent_run_id) == row.get("active_agent_run_id")
        and int(event.ownership_epoch) == _as_int(row.get("ownership_epoch"))
        and str(event.runtime_incarnation_id) == row.get("runtime_incarnation_id")
        and event.native_work_ref == row.get("current_native_work_ref")
        and int(event.session_generation) == _as_int(row.get("session_generation"))
    )


def _event_terminal(event: NativeEvent, row: Mapping[str, object]) -> bool:
    return _status_terminal(event.payload.get("status"), row)


def _status_terminal(status: object, row: Mapping[str, object]) -> bool:
    if status == "completed" or status == "failed":
        return True
    return status == "interrupted" and row.get("cancel_requested_at") is not None


def _view(row: Mapping[str, object], *, outcome: _Outcome | None = None) -> SubmissionView:
    runtime_state = _runtime_state(row.get("runtime_state"))
    run = row.get("active_agent_run_id")
    work = row.get("current_native_work_ref")
    chosen: _Outcome
    if outcome is not None:
        chosen = outcome
    elif runtime_state == "running" or runtime_state == "cancelling":
        chosen = "running"
    else:
        chosen = "accepted"
    return SubmissionView(
        outcome=chosen,
        active_agent_run_id=run if isinstance(run, str) else None,
        native_work_ref=work if isinstance(work, str) else None,
        resubmission_allowed=False,
        runtime_state=runtime_state,
    )


_RUNTIME_STATES = frozenset(
    {"starting", "warm_idle", "running", "cancelling", "draining", "unloaded", "suspect", "recovering", "unavailable"}
)


def _as_int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return -1
    return value


def _runtime_state(value: object) -> RuntimeStateName | None:
    if isinstance(value, str) and value in _RUNTIME_STATES:
        return cast(RuntimeStateName, value)
    return None


def _provider(value: object) -> Provider | None:
    if value == "openai":
        return "openai"
    if value == "xai":
        return "xai"
    return None


def _as_binding(row: Mapping[str, object]) -> RunBinding | None:
    provider = _provider(row.get("provider"))
    issued = row.get("database_time")
    expires = row.get("owner_lease_expires_at")
    if not isinstance(issued, datetime):
        return None
    if not isinstance(expires, datetime):
        expires = issued
    work = row.get("current_native_work_ref")
    native_id = row.get("native_session_id")
    run_id = row.get("active_agent_run_id")
    if provider is None or not isinstance(native_id, str) or not isinstance(run_id, str):
        return None
    try:
        return RunBinding.model_validate(
            {
                "conversation_id": row.get("conversation_id"),
                "provider_session_id": row.get("id"),
                "session_generation": row.get("session_generation"),
                "native_session_id": native_id,
                "active_agent_run_id": run_id,
                "harness_instance_id": row.get("harness_instance_id"),
                "runtime_incarnation_id": row.get("runtime_incarnation_id"),
                "ownership_epoch": row.get("ownership_epoch"),
                "provider": provider,
                "model": row.get("model"),
                "brain_release_id": row.get("brain_release_id"),
                "brain_hash": row.get("brain_hash"),
                "behavior_version": row.get("behavior_version"),
                "behavior_hash": row.get("behavior_hash"),
                "corpus_release_id": row.get("corpus_release_id"),
                "deployment_ref": row.get("deployment_ref"),
                "issued_at": issued,
                "expires_at": expires,
                "audience": "inference",
                "native_work_ref": work if isinstance(work, str) else None,
            }
        )
    except ValidationError:
        return None


def _as_handle(row: Mapping[str, object]) -> SessionHandle | None:
    provider = _provider(row.get("provider"))
    if provider is None:
        return None
    try:
        return SessionHandle.model_validate(
            {
                "conversation_id": row.get("conversation_id"),
                "provider_session_id": row.get("id"),
                "session_generation": row.get("session_generation"),
                "native_session_id": row.get("native_session_id"),
                "harness_instance_id": row.get("harness_instance_id"),
                "runtime_incarnation_id": row.get("runtime_incarnation_id"),
                "native_storage_unit_id": row.get("native_storage_unit_id"),
                "state_location": row.get("state_location"),
                "ownership_epoch": row.get("ownership_epoch"),
                "provider": provider,
                "model": row.get("model"),
                "brain_release_id": row.get("brain_release_id"),
                "brain_hash": row.get("brain_hash"),
                "behavior_version": row.get("behavior_version"),
                "behavior_hash": row.get("behavior_hash"),
                "corpus_release_id": row.get("corpus_release_id"),
                "deployment_ref": row.get("deployment_ref"),
            }
        )
    except ValidationError:
        return None


async def _handle_in(tx: Transaction, provider_session_id: str) -> SessionHandle | None:
    row = await tx.execute_one(_MAPPING + " WHERE ps.id = %s::uuid AND ps.is_current", (provider_session_id,))
    if row is None:
        return None
    return _as_handle(row)
