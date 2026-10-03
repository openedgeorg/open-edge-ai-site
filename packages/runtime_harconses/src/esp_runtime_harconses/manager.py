"""Runtime Session Manager: submit once, report native acceptance truthfully, read owned history.

Scope (P §§7.1, 11–13; plan Task 16). Admission (`esp_request_admission`) has already reserved the
conversation's guard and healthy compatible capacity and holds no input. This module does the rest of
the live request, and nothing that outlives it:

Setup (`ensure_session`), bounded and only on the already reserved capacity:

1. Create the native session on the reserved Shared Harness Instance (ShaHarIns) and Process Incarnation
   (ProInc), resume a saved one there, or use the resident one. Nothing waits for other capacity.
2. Register a new native ID conditionally on the reservation's ownership epoch, through the fenced
   `register_native_session`. Fence contention is retried until the deadline; a moved epoch or a
   different native ID is a stale reservation and ends setup.
3. Mark the run `running` conditionally on the same run, epoch, request, native ID and placement.
4. Re-read current authority and mint the two operation scopes only if it still matches the admission
   exactly (run, epoch, native ID, guard, placement, pins and unexpired lease and run deadline).

Submission (`submit_message`) sends the visitor input once, to that native ID, and keeps it only in this
call. The outcome is the adapter's:

- `accepted` only on qualified native acceptance; the native work reference is then recorded
  conditionally on the same run and epoch;
- `not_submitted` only when the input conclusively never reached the harness (any setup failure, a
  transport refusal before sending, an explicit native refusal, an unknown native session). The
  reservation is then released through `release_unsubmitted`, so the visitor may resubmit manually;
- `unconfirmed` for everything else: a lost, late or malformed acknowledgement, a deadline after the
  input may have been sent, any unexpected error during the send. The guard, run, request and capacity
  stay held and any native reference is recorded; the metadata reconciler settles it later by native
  status, never by resubmitting.

Setup and acceptance confirmation share one budget (engineering limit, at most 10 seconds by default).
A deadline before the send is not-started; a deadline after it is unconfirmed.

Status (`inspect_submission`) and history (`read_authorized_history`) start no native work and never
read native files: they call only the adapter's `inspect` and `read_history`.

- A resident session is read in place, on the instance where it is resident.
- A saved, unloaded session is read only under a non-waiting, bounded residency reservation, held for
  the bounded read only:
  - the mapping row is held `FOR KEY SHARE NOWAIT`, so no admission can place or resume the session
    meanwhile and no second process can load it;
  - one free resident slot is locked with `SKIP LOCKED` on an instance that mounts its storage and is
    ready. Readiness is re-read under that instance's shared incarnation fence, and the fence is given
    back before the native read. The read therefore never holds off an exclusive fence user on that
    process: a peer's release or registration, or a revocation.

  Nothing is committed as a claim, so a crashed reader leaves nothing behind.
- A session whose resident instance is not ready, or that is neither resident nor unloaded, is not
  read elsewhere.

Task 17 hand-off: an in-place read of a resident session holds no lock while it reads. Unload and
eviction must not let the session be placed and resumed on another process while such a read may still
run on the old one. Otherwise a Grok-style read, which loads the session transiently, could load it
there while another process also has it loaded. In-place reads are bounded by `read_timeout_seconds`.

Status outcomes. "Correlated" means the native harness reports this request ID with its saved input.

- No native session was ever registered and the request is not current: `not_started`, resubmission
  allowed, because nothing can have been submitted.
- The request is current and either no native session exists yet or its run is still `starting`
  (setup may still be running on another live request): `not_started`, resubmission not allowed.
  Input is sent only after setup has marked the run `running`, so metadata alone proves it was not
  sent, and status makes no native call. A resident session is admitted directly as `running`, so its
  setup is not distinguishable this way and is answered as below.
- Correlated: the native status decides. `running` and `completed` and `failed` map to themselves;
  `interrupted` is `cancelled` when cancellation intent is recorded for the current run; idle, unknown
  and other interruptions are `accepted` (the harness saved the input). Resubmission is not allowed.
- A native session exists and the request is not correlated, current or older: `submission_unconfirmed`,
  resubmission not allowed. An older request ID stays unresolved unless native correlation proves its
  result.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import psycopg
from psycopg import errors as pg_errors
from pydantic import ValidationError

from esp_contracts.api import SubmissionView, SubmitMessage
from esp_contracts.ids import Provider
from esp_contracts.runtime import (
    Accepted,
    AdmissionAuthority,
    AuthorityRecord,
    NativeHistorySnapshot,
    NativeStatus,
    NotSubmitted,
    OperationAuthority,
    SessionHandle,
    SessionReservation,
    SubmissionResult,
    Unconfirmed,
)
from esp_db.client import Db, Transaction
from esp_espcon.conversation import ConversationNotFound
from esp_event_protocol.history import authorized_history, empty_history
from esp_execution_bindings.authorize import read_authority
from esp_execution_bindings.binding import AuthorizationError, TokenSigner, mint_operation_authority
from esp_execution_bindings.dispatch_fence import register_native_session
from esp_provider_router.router import NativeRuntimeAdapter, PoolUnavailable, ProviderRouter
from esp_provider_shared.adapter import UnknownNativeId
from esp_request_admission.admit import Admitted
from esp_runtime_placement.capacity import (
    INSTANCE_HEARTBEAT_LEASE_SECONDS,
    InstanceCapacity,
    compatible_instances,
    incarnation_is_ready,
)

# Engineering bounds (plan Shared Contracts §2): setup plus acceptance confirmation, and one native read.
ACCEPTANCE_BUDGET_SECONDS = 10.0
READ_TIMEOUT_SECONDS = 5.0
CONNECTION_TIMEOUT_SECONDS = 1.0
LOCK_TIMEOUT = "250ms"
STATEMENT_TIMEOUT = "2s"
# The server ends a held read reservation this long after its read deadline if the backend stalls.
_IDLE_MARGIN_SECONDS = 2.0
REQUEST_ID_MAX_LENGTH = 200
SUBJECT_MAX_LENGTH = 128

_DATABASE_ERRORS = (psycopg.Error, OSError, TimeoutError)


@dataclass(frozen=True)
class SessionLimits:
    """Bounds for one live request. Measured engineering limits, not PRD timings."""

    acceptance_budget_seconds: float = ACCEPTANCE_BUDGET_SECONDS
    read_timeout_seconds: float = READ_TIMEOUT_SECONDS
    release_attempts: int = 5
    retry_interval_seconds: float = 0.05

    def __post_init__(self) -> None:
        if self.acceptance_budget_seconds <= 0 or self.read_timeout_seconds <= 0:
            raise ValueError("session limits must be positive")
        if self.release_attempts < 1 or self.retry_interval_seconds < 0:
            raise ValueError("release attempts and retry interval must be usable")


class SetupFailed(Exception):
    """Setup ended before the input was sent. `code` is a stable machine code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class NativeReadUnavailable(Exception):
    """Native status or history exists but cannot be read now. Never answered with an empty history."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class ReservationReleaser(Protocol):
    """Releases a reservation whose input provably never reached the harness (Task 15)."""

    async def release_unsubmitted(self, authority: AdmissionAuthority) -> bool: ...


class OperationalTelemetry(Protocol):
    """Payload-free operational events: names, identifiers and codes only, never input or native content."""

    def emit(self, name: str, attributes: Mapping[str, str]) -> None: ...


class _NoTelemetry:
    def emit(self, name: str, attributes: Mapping[str, str]) -> None:
        return None


class _Skip(Exception):
    """Leave a read-reservation candidate's savepoint, releasing what it locked."""


@dataclass(frozen=True)
class _Meta:
    """One committed read of a conversation's current coordination metadata. No native content."""

    conversation_id: str
    provider: Provider
    row: Mapping[str, Any]

    @property
    def mapping_id(self) -> str | None:
        value = self.row["mapping_id"]
        return None if value is None else str(value)

    @property
    def native_session_id(self) -> str | None:
        value = self.row["native_session_id"]
        return None if value is None else str(value)

    def is_current(self, request_id: str) -> bool:
        return self.mapping_id is not None and self.row["current_request_id"] == request_id

    def in_setup(self, request_id: str) -> bool:
        """The current run is still `starting`: setup sends input only after marking it `running`."""
        return (
            self.is_current(request_id)
            and self.row["active_agent_run_id"] is not None
            and self.row["runtime_state"] == "starting"
        )


class SessionManager:
    """The Runtime Session Manager of one backend instance. Holds no input beyond a live call."""

    def __init__(
        self,
        db: Db,
        router: ProviderRouter,
        signer: TokenSigner,
        releaser: ReservationReleaser,
        *,
        limits: SessionLimits | None = None,
        telemetry: OperationalTelemetry | None = None,
    ) -> None:
        self._db = db
        self._router = router
        self._signer = signer
        self._releaser = releaser
        self._limits = limits or SessionLimits()
        self._telemetry: OperationalTelemetry = telemetry or _NoTelemetry()

    @property
    def limits(self) -> SessionLimits:
        return self._limits

    # Setup and submission

    async def ensure_session(self, admission: Admitted) -> tuple[SessionHandle, OperationAuthority]:
        """Bounded setup on the reserved capacity, then operation scopes for the registered native ID.

        Raises `SetupFailed` for every failure; the input has not been sent when it does.
        """
        deadline = asyncio.get_running_loop().time() + self._limits.acceptance_budget_seconds
        return await self._ensure_within(admission, deadline)

    async def submit_message(self, admission: Admitted, input: SubmitMessage) -> SubmissionResult:
        """Set up, then send `input` once to the reserved native session and report what is proved."""
        _require_same_request(admission, input)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._limits.acceptance_budget_seconds
        try:
            handle, authority = await self._ensure_within(admission, deadline)
        except SetupFailed as exc:
            return await self._not_submitted(admission, exc.code)
        if loop.time() >= deadline:
            return await self._not_submitted(admission, "setup_timeout")
        result = await self._submit_once(handle, input, authority, deadline)
        if isinstance(result, NotSubmitted):
            return await self._not_submitted(admission, result.code)
        work_ref = result.work.native_work_ref if isinstance(result, Accepted) else result.native_work_ref
        if work_ref is not None:
            await self._record_work(admission, handle, work_ref)
        return result

    async def _ensure_within(self, admission: Admitted, deadline: float) -> tuple[SessionHandle, OperationAuthority]:
        try:
            async with asyncio.timeout_at(deadline):
                return await self._ensure(admission)
        except TimeoutError as exc:
            raise SetupFailed("setup_timeout") from exc

    async def _ensure(self, admission: Admitted) -> tuple[SessionHandle, OperationAuthority]:
        reservation = admission.reservation
        _require_consistent_admission(admission)
        try:
            adapter = self._router.adapter_for(reservation.provider)
        except PoolUnavailable as exc:
            raise SetupFailed("pool_unavailable") from exc
        if admission.residency == "new":
            if reservation.native_session_id is not None:
                raise SetupFailed("residency_mismatch")
            handle = await _native_setup(adapter.create_session(reservation), "create_failed")
            _require_handle(handle, reservation)
            await self._register(admission, handle.native_session_id)
        else:
            if reservation.native_session_id is None:
                raise SetupFailed("native_id_missing")
            handle = _handle_from(reservation, reservation.native_session_id)
            if admission.residency == "resume":
                resumed = await _native_setup(adapter.resume_session(handle), "resume_failed")
                _require_handle(resumed, reservation)
                if resumed.native_session_id != handle.native_session_id:
                    raise SetupFailed("handle_mismatch")
        await self._mark_running(admission, handle)
        return handle, await self._mint(admission, handle)

    async def _register(self, admission: Admitted, native_session_id: str) -> None:
        """Conditional on the reservation epoch; fence contention retries until the setup deadline."""
        reservation = admission.reservation
        while True:
            try:
                registered = await register_native_session(
                    self._db, reservation.provider_session_id, reservation.ownership_epoch, native_session_id
                )
            except _DATABASE_ERRORS as exc:
                raise SetupFailed("database_unavailable") from exc
            if registered:
                return
            if await self._registration_is_stale(admission, native_session_id):
                raise SetupFailed("authority_changed")
            await asyncio.sleep(self._limits.retry_interval_seconds)

    async def _registration_is_stale(self, admission: Admitted, native_session_id: str) -> bool:
        try:
            async with _bounded(self._db) as tx:
                row = await tx.execute_one(
                    """
                    SELECT ownership_epoch, native_session_id, is_current, active_agent_run_id::text AS run
                    FROM provider_session WHERE id = %s::uuid
                    """,
                    (admission.reservation.provider_session_id,),
                )
        except _DATABASE_ERRORS as exc:
            raise SetupFailed("database_unavailable") from exc
        return (
            row is None
            or row["is_current"] is not True
            or row["ownership_epoch"] != admission.authority.ownership_epoch
            or row["run"] != admission.authority.active_agent_run_id
            or row["native_session_id"] not in (None, native_session_id)
        )

    async def _mark_running(self, admission: Admitted, handle: SessionHandle) -> None:
        reservation = admission.reservation
        try:
            async with _bounded(self._db) as tx:
                row = await tx.execute_one(
                    """
                    UPDATE provider_session SET runtime_state = 'running', last_used_at = transaction_timestamp()
                    WHERE id = %(id)s::uuid
                      AND conversation_id = %(conversation)s::uuid
                      AND is_current
                      AND ownership_epoch = %(epoch)s
                      AND active_agent_run_id = %(run)s::uuid
                      AND current_request_id = %(request)s
                      AND native_session_id = %(native)s
                      AND harness_instance_id = %(instance)s::uuid
                      AND runtime_incarnation_id = %(incarnation)s::uuid
                      AND cancel_requested_at IS NULL
                      AND runtime_state IN ('starting', 'running')
                    RETURNING id
                    """,
                    {
                        "id": reservation.provider_session_id,
                        "conversation": reservation.conversation_id,
                        "epoch": reservation.ownership_epoch,
                        "run": admission.authority.active_agent_run_id,
                        "request": admission.client_request_id,
                        "native": handle.native_session_id,
                        "instance": reservation.harness_instance_id,
                        "incarnation": reservation.runtime_incarnation_id,
                    },
                )
        except _DATABASE_ERRORS as exc:
            raise SetupFailed("database_unavailable") from exc
        if row is None:
            raise SetupFailed("authority_changed")

    async def _mint(self, admission: Admitted, handle: SessionHandle) -> OperationAuthority:
        try:
            async with _bounded(self._db) as tx:
                record = await read_authority(tx, admission.reservation.provider_session_id)
        except _DATABASE_ERRORS as exc:
            raise SetupFailed("database_unavailable") from exc
        _require_current(record, admission, handle)
        assert record is not None
        try:
            return mint_operation_authority(record, signer=self._signer)
        except AuthorizationError as exc:
            raise SetupFailed(str(exc)) from exc

    async def _submit_once(
        self, handle: SessionHandle, message: SubmitMessage, authority: OperationAuthority, deadline: float
    ) -> SubmissionResult:
        adapter = self._router.adapter_for(handle.provider)
        try:
            async with asyncio.timeout_at(deadline):
                result = await adapter.submit(handle, message, authority)
        except TimeoutError:
            return Unconfirmed(kind="unconfirmed", native_work_ref=None)
        except UnknownNativeId:
            # The harness answered that it has no such session: nothing could have been saved there.
            return NotSubmitted(kind="not_submitted", code="unknown_native_id")
        except Exception:
            # The frame may have been sent before the failure; acceptance stays uncertain.
            return Unconfirmed(kind="unconfirmed", native_work_ref=None)
        if isinstance(result, Accepted) and result.work.native_session_id != handle.native_session_id:
            return Unconfirmed(kind="unconfirmed", native_work_ref=None)
        return result

    async def _not_submitted(self, admission: Admitted, code: str) -> NotSubmitted:
        """Conclusive non-acceptance: release the reservation so the visitor may resubmit manually.

        A `False` from the release is contention, a moved epoch or an outage. After the bounded attempts the
        reservation stays held for the metadata reconciler; the input is still not submitted.
        """
        attempts = self._limits.release_attempts
        for attempt in range(attempts):
            if await self._releaser.release_unsubmitted(admission.authority):
                return NotSubmitted(kind="not_submitted", code=code)
            if attempt + 1 < attempts:
                await asyncio.sleep(self._limits.retry_interval_seconds)
        # The guard stays held for the metadata reconciler. Leave an operator trace of why.
        self._trace("submission.release_deferred", admission, code=code)
        return NotSubmitted(kind="not_submitted", code=code)

    async def _record_work(self, admission: Admitted, handle: SessionHandle, native_work_ref: str) -> bool:
        """Record the native reference on the same run. Best effort: native history keeps the truth.

        A failure leaves an operator trace (identifiers and a code), because the reconciler then has no
        recorded reference to settle the run by.
        """
        recorded = await self._update_work_ref(admission, handle, native_work_ref)
        if recorded != "recorded":
            self._trace("submission.work_ref_unrecorded", admission, native_work_ref=native_work_ref, code=recorded)
        return recorded == "recorded"

    def _trace(self, name: str, admission: Admitted, **codes: str) -> None:
        attributes = {
            "conversation_id": admission.reservation.conversation_id,
            "provider_session_id": admission.reservation.provider_session_id,
            "active_agent_run_id": admission.authority.active_agent_run_id,
            **codes,
        }
        try:
            self._telemetry.emit(name, attributes)
        except Exception:
            # Telemetry never changes what the submission proved.
            return

    async def _update_work_ref(
        self, admission: Admitted, handle: SessionHandle, native_work_ref: str
    ) -> Literal["recorded", "record_conflict", "database_unavailable"]:
        try:
            async with _bounded(self._db) as tx:
                row = await tx.execute_one(
                    """
                    UPDATE provider_session
                    SET current_native_work_ref = %(ref)s, last_used_at = transaction_timestamp()
                    WHERE id = %(id)s::uuid
                      AND is_current
                      AND ownership_epoch = %(epoch)s
                      AND active_agent_run_id = %(run)s::uuid
                      AND native_session_id = %(native)s
                      AND (current_native_work_ref IS NULL OR current_native_work_ref = %(ref)s)
                    RETURNING id
                    """,
                    {
                        "ref": native_work_ref,
                        "id": admission.reservation.provider_session_id,
                        "epoch": admission.authority.ownership_epoch,
                        "run": admission.authority.active_agent_run_id,
                        "native": handle.native_session_id,
                    },
                )
        except _DATABASE_ERRORS:
            return "database_unavailable"
        return "recorded" if row is not None else "record_conflict"

    # Status and history

    async def inspect_submission(self, subject_id: str, conversation_id: str, request_id: str) -> SubmissionView:
        """Reconciled status of one request: metadata plus native correlation. Starts no native work."""
        if not request_id or len(request_id) > REQUEST_ID_MAX_LENGTH:
            raise ValueError("client_request_id must be 1 to 200 characters")
        meta = await self._read_meta(subject_id, conversation_id)
        if meta.native_session_id is None or meta.in_setup(request_id):
            return _view_not_started(meta, request_id)
        native = await self._read_native(meta, lambda adapter, handle: adapter.inspect(handle, request_id))
        return _view_with_native_status(meta, request_id, native)

    async def read_authorized_history(self, subject_id: str, conversation_id: str) -> NativeHistorySnapshot:
        """The owner's native history from the conversation's own native session. Empty only before one exists."""
        meta = await self._read_meta(subject_id, conversation_id)
        native_session_id = meta.native_session_id
        if native_session_id is None:
            return empty_history()
        snapshot = await self._read_native(meta, lambda adapter, handle: adapter.read_history(handle))
        return authorized_history(snapshot, conversation_id=meta.conversation_id, native_session_id=native_session_id)

    async def _read_meta(self, subject_id: str, conversation_id: str) -> _Meta:
        normalized = _uuid_or_none(conversation_id)
        if normalized is None or not subject_id or len(subject_id) > SUBJECT_MAX_LENGTH:
            raise ConversationNotFound(conversation_id)
        try:
            async with _bounded(self._db) as tx:
                row = await tx.execute_one(_META, (INSTANCE_HEARTBEAT_LEASE_SECONDS, normalized))
        except _DATABASE_ERRORS as exc:
            raise NativeReadUnavailable("database_unavailable") from exc
        if row is None or row["owner_subject_id"] != subject_id:
            raise ConversationNotFound(conversation_id)
        provider = row["provider"]
        if provider not in ("openai", "xai"):
            raise NativeReadUnavailable("provider_unknown")
        return _Meta(conversation_id=normalized, provider=provider, row=row)

    async def _read_native[T](
        self, meta: _Meta, op: Callable[[NativeRuntimeAdapter, SessionHandle], Awaitable[T]]
    ) -> T:
        try:
            adapter = self._router.adapter_for(meta.provider)
        except PoolUnavailable as exc:
            raise NativeReadUnavailable("pool_unavailable") from exc
        row = meta.row
        if row["resident_instance_id"] is not None:
            if row["resident_ready"] is not True:
                # Resident on an instance that is not ready: never loaded by a second process meanwhile.
                raise NativeReadUnavailable("resident_instance_unavailable")
            handle = _handle_from_row(row, row["harness_instance_id"], row["runtime_incarnation_id"])
            # No lock is held during this read. Task 17's unload and eviction must keep the session from
            # being placed and resumed elsewhere while it may still run (see the module hand-off).
            return await self._bounded_read(lambda: op(adapter, handle))
        if row["runtime_state"] != "unloaded":
            raise NativeReadUnavailable("session_not_readable")
        return await self._read_reserved(meta, adapter, op)

    async def _read_reserved[T](
        self,
        meta: _Meta,
        adapter: NativeRuntimeAdapter,
        op: Callable[[NativeRuntimeAdapter, SessionHandle], Awaitable[T]],
    ) -> T:
        """A saved, unloaded session read under a non-waiting residency reservation held only for the read."""
        outcome: list[T] = []
        try:
            async with _held_read(self._db, self._limits.read_timeout_seconds) as tx:
                if not await _hold_unloaded_mapping(tx, meta):
                    raise NativeReadUnavailable("session_contended")
                candidate = await _reserve_read_residency(tx, meta)
                if candidate is None:
                    raise NativeReadUnavailable("residency_unavailable")
                handle = _handle_from_row(meta.row, candidate.harness_instance_id, candidate.runtime_incarnation_id)
                outcome.append(await self._bounded_read(lambda: op(adapter, handle)))
        except NativeReadUnavailable:
            raise
        except _DATABASE_ERRORS as exc:
            if outcome:
                # The read finished; only ending the reservation failed, and the server ends it anyway.
                return outcome[0]
            raise NativeReadUnavailable("database_unavailable") from exc
        return outcome[0]

    async def _bounded_read[T](self, call: Callable[[], Awaitable[T]]) -> T:
        try:
            async with asyncio.timeout(self._limits.read_timeout_seconds):
                return await call()
        except NativeReadUnavailable:
            raise
        except Exception as exc:
            raise NativeReadUnavailable("native_read_failed") from exc


_META = """
    SELECT c.owner_subject_id, c.provider, c.active_provider_session_id::text AS guard,
           ps.id::text AS mapping_id, ps.conversation_id::text AS conversation_id, ps.session_generation,
           ps.native_session_id, ps.model, ps.brain_release_id, ps.brain_hash, ps.behavior_version,
           ps.behavior_hash, ps.corpus_release_id, ps.deployment_ref, ps.runtime_state,
           ps.harness_instance_id::text AS harness_instance_id,
           ps.runtime_incarnation_id::text AS runtime_incarnation_id, ps.native_storage_unit_id, ps.state_location,
           ps.ownership_epoch, ps.active_agent_run_id::text AS active_agent_run_id, ps.current_request_id,
           ps.current_native_work_ref, (ps.cancel_requested_at IS NOT NULL) AS cancel_requested,
           resident.scope_id AS resident_instance_id,
           COALESCE(
               hi.lifecycle_status = 'ready'
               AND hi.process_incarnation_id = ps.runtime_incarnation_id
               AND hi.last_heartbeat_at > transaction_timestamp() - make_interval(secs => %s),
               false
           ) AS resident_ready
    FROM conversation AS c
    LEFT JOIN provider_session AS ps ON ps.conversation_id = c.id AND ps.is_current
    LEFT JOIN LATERAL (
        SELECT cs.scope_id FROM capacity_slot AS cs
        WHERE cs.scope = 'resident' AND cs.holder_provider_session_id = ps.id
        ORDER BY cs.scope_id, cs.slot_number
        LIMIT 1
    ) AS resident ON true
    LEFT JOIN harness_instance AS hi ON hi.id::text = resident.scope_id AND hi.id = ps.harness_instance_id
    WHERE c.id = %s::uuid
"""


async def _hold_unloaded_mapping(tx: Transaction, meta: _Meta) -> bool:
    """Hold the mapping row for the read and re-check it is still saved, unloaded and unplaced.

    `FOR KEY SHARE` is the weakest row lock that still conflicts with admission's `FOR UPDATE NOWAIT`.
    Admission is the only writer that places or resumes a session, so none can do so during the read.
    A later writer that places or resumes a saved session (Task 21 recovery) must lock the row
    `FOR UPDATE` in the same way. The lock does not conflict with an update of non-key columns. A
    revocation that bumps the epoch of a saved session still naming the revoked incarnation is
    therefore never held off by a read.
    """
    try:
        row = await tx.execute_one(
            """
            SELECT ps.runtime_state, ps.ownership_epoch, ps.native_session_id,
                   EXISTS (
                       SELECT 1 FROM capacity_slot AS cs
                       WHERE cs.scope = 'resident' AND cs.holder_provider_session_id = ps.id
                   ) AS resident
            FROM provider_session AS ps
            WHERE ps.id = %s::uuid AND ps.is_current
            FOR KEY SHARE OF ps NOWAIT
            """,
            (meta.mapping_id,),
        )
    except (pg_errors.LockNotAvailable, pg_errors.QueryCanceled):
        return False
    return (
        row is not None
        and row["runtime_state"] == "unloaded"
        and row["resident"] is False
        and row["ownership_epoch"] == meta.row["ownership_epoch"]
        and row["native_session_id"] == meta.native_session_id
    )


async def _reserve_read_residency(tx: Transaction, meta: _Meta) -> InstanceCapacity | None:
    storage = meta.row["native_storage_unit_id"]
    if not isinstance(storage, str) or not storage:
        return None
    candidates = await compatible_instances(
        tx,
        provider=meta.provider,
        deployment_ref=str(meta.row["deployment_ref"]),
        instance_id=None,
        native_storage_unit_id=storage,
    )
    for candidate in candidates:
        if candidate.resident.free <= 0:
            continue
        if await _lock_read_slot(tx, candidate, str(meta.mapping_id)):
            return candidate
    return None


async def _lock_read_slot(tx: Transaction, candidate: InstanceCapacity, mapping_id: str) -> bool:
    """Lock, never claim, one free resident row of a candidate that is ready now, in a savepoint.

    The row lock stays with the held read. The incarnation fence does not: see `_ready_under_brief_fence`.
    """
    try:
        async with tx.connection.transaction():
            slot = await tx.execute_one(
                """
                SELECT slot_number FROM capacity_slot
                WHERE scope = 'resident' AND scope_id = %s AND holder_provider_session_id IS NULL
                  AND slot_number < %s
                ORDER BY slot_number
                LIMIT 1
                FOR UPDATE SKIP LOCKED
                """,
                (candidate.harness_instance_id, candidate.resident.claimable_below),
            )
            if slot is None:
                raise _Skip
            if not await _ready_under_brief_fence(tx, candidate, mapping_id):
                raise _Skip
    except (_Skip, pg_errors.LockNotAvailable, pg_errors.QueryCanceled):
        return False
    return True


async def _ready_under_brief_fence(tx: Transaction, candidate: InstanceCapacity, mapping_id: str) -> bool:
    """Re-read readiness under the shared incarnation fence, then give the fence back before the read.

    The fence is taken and the readiness re-read in a savepoint that is always rolled back. Rolling a
    savepoint back releases the advisory locks taken inside it at once. Releasing it would hand them to
    the held read transaction instead, so every exclusive fence user on this process would be refused
    for the whole native read: a refused peer's `release_unsubmitted`, `register_native_session`,
    `revoke_mapping`, and whole-process revocation, which waits at most `REVOCATION_LOCK_TIMEOUT`.

    The fence orders only this readiness check against a whole-process revocation, as for every other
    shared holder. It does not need to cover the read. The read assigns nothing to the incarnation and
    carries no operation scope. Placement and resumption of the session are excluded for the whole read
    by the mapping row lock (`_hold_unloaded_mapping`). Residency capacity is excluded by the locked
    resident row. A revocation that completes during the read can only make the native read fail.
    """
    ready = False
    async with tx.connection.transaction() as fence:
        fenced = await tx.execute_one(
            "SELECT esp_try_fence(%s, %s, false) AS locked", (candidate.runtime_incarnation_id, mapping_id)
        )
        if fenced is not None and fenced["locked"] is True:
            ready = await incarnation_is_ready(tx, candidate.harness_instance_id, candidate.runtime_incarnation_id)
        raise psycopg.Rollback(fence)
    return ready


@asynccontextmanager
async def _bounded(db: Db) -> AsyncGenerator[Transaction]:
    """One transaction with bounded connection acquisition, lock wait and statement time."""
    async with db.pool.connection(timeout=CONNECTION_TIMEOUT_SECONDS) as connection:
        async with connection.transaction():
            tx = Transaction(connection)
            await tx.execute(
                "SELECT set_config('lock_timeout', %s, true) AS lock_timeout, "
                "set_config('statement_timeout', %s, true) AS statement_timeout",
                (LOCK_TIMEOUT, STATEMENT_TIMEOUT),
            )
            yield tx


@asynccontextmanager
async def _held_read(db: Db, read_seconds: float) -> AsyncGenerator[Transaction]:
    """A transaction held across one bounded native read; the server ends it if the backend stalls."""
    idle = f"{int((read_seconds + _IDLE_MARGIN_SECONDS) * 1000)}ms"
    async with db.pool.connection(timeout=CONNECTION_TIMEOUT_SECONDS) as connection:
        async with connection.transaction():
            tx = Transaction(connection)
            await tx.execute(
                "SELECT set_config('lock_timeout', %s, true) AS lock_timeout, "
                "set_config('statement_timeout', %s, true) AS statement_timeout, "
                "set_config('idle_in_transaction_session_timeout', %s, true) AS idle_timeout",
                (LOCK_TIMEOUT, STATEMENT_TIMEOUT, idle),
            )
            yield tx


async def _native_setup[T](call: Awaitable[T], code: str) -> T:
    try:
        return await call
    except Exception as exc:
        raise SetupFailed(code) from exc


def _require_same_request(admission: Admitted, message: SubmitMessage) -> None:
    if (
        message.conversation_id != admission.reservation.conversation_id
        or message.client_request_id != admission.client_request_id
    ):
        raise ValueError("the input does not belong to this admission")


_PINS = (
    "conversation_id",
    "provider_session_id",
    "session_generation",
    "ownership_epoch",
    "provider",
    "brain_release_id",
    "brain_hash",
    "behavior_version",
    "behavior_hash",
    "corpus_release_id",
    "deployment_ref",
)


def _require_consistent_admission(admission: Admitted) -> None:
    reservation = admission.reservation
    authority = admission.authority
    if any(getattr(reservation, name) != getattr(authority, name) for name in _PINS):
        raise SetupFailed("admission_inconsistent")
    if authority.native_session_id != reservation.native_session_id or authority.model != reservation.model:
        raise SetupFailed("admission_inconsistent")


def _require_handle(handle: SessionHandle, reservation: SessionReservation) -> None:
    """A native handle keeps every reservation pin and placement; only the native ID is new."""
    expected = reservation.model_dump(exclude={"native_session_id"})
    if handle.model_dump(exclude={"native_session_id"}) != expected or not handle.native_session_id:
        raise SetupFailed("handle_mismatch")
    if reservation.native_session_id is not None and handle.native_session_id != reservation.native_session_id:
        raise SetupFailed("handle_mismatch")


def _handle_from(reservation: SessionReservation, native_session_id: str) -> SessionHandle:
    data = reservation.model_dump()
    data["native_session_id"] = native_session_id
    return SessionHandle.model_validate(data)


def _require_current(record: AuthorityRecord | None, admission: Admitted, handle: SessionHandle) -> None:
    """Scopes are minted only for the exact admitted run, still current, with time left on both clocks."""
    reservation = admission.reservation
    authority = admission.authority
    if record is None or not record.is_current or record.runtime_state != "running" or record.cancel_requested:
        raise SetupFailed("authority_changed")
    same = (
        record.active_agent_run_id == authority.active_agent_run_id
        and record.ownership_epoch == authority.ownership_epoch
        and record.native_session_id == handle.native_session_id
        and record.guard_provider_session_id == record.provider_session_id == reservation.provider_session_id
        and record.current_request_id == admission.client_request_id
        and record.harness_instance_id == reservation.harness_instance_id
        and record.runtime_incarnation_id == reservation.runtime_incarnation_id
        and record.conversation_id == reservation.conversation_id
        and record.session_generation == reservation.session_generation
        and record.provider == reservation.provider
        and record.model == reservation.model
        and record.brain_release_id == reservation.brain_release_id
        and record.brain_hash == reservation.brain_hash
        and record.behavior_version == reservation.behavior_version
        and record.behavior_hash == reservation.behavior_hash
        and record.corpus_release_id == reservation.corpus_release_id
        and record.deployment_ref == reservation.deployment_ref
    )
    if not same:
        raise SetupFailed("authority_changed")
    lease = record.owner_lease_expires_at
    deadline = record.active_agent_run_expires_at
    if lease is None or deadline is None or record.database_time >= lease or record.database_time >= deadline:
        raise SetupFailed("lease_expired")


def _handle_from_row(row: Mapping[str, Any], instance_id: object, incarnation_id: object) -> SessionHandle:
    try:
        return SessionHandle.model_validate(
            {
                "conversation_id": row["conversation_id"],
                "provider_session_id": row["mapping_id"],
                "session_generation": row["session_generation"],
                "native_session_id": row["native_session_id"],
                "harness_instance_id": instance_id,
                "runtime_incarnation_id": incarnation_id,
                "native_storage_unit_id": row["native_storage_unit_id"],
                "state_location": row["state_location"],
                "ownership_epoch": row["ownership_epoch"],
                "provider": row["provider"],
                "model": row["model"],
                "brain_release_id": row["brain_release_id"],
                "brain_hash": row["brain_hash"],
                "behavior_version": row["behavior_version"],
                "behavior_hash": row["behavior_hash"],
                "corpus_release_id": row["corpus_release_id"],
                "deployment_ref": row["deployment_ref"],
            }
        )
    except ValidationError as exc:
        raise NativeReadUnavailable("session_not_readable") from exc


def _view_not_started(meta: _Meta, request_id: str) -> SubmissionView:
    """Nothing can have been submitted: no native session was ever registered, or the run is in setup."""
    row = meta.row
    current = meta.is_current(request_id) and row["active_agent_run_id"] is not None
    return SubmissionView(
        outcome="not_started",
        active_agent_run_id=row["active_agent_run_id"] if current else None,
        native_work_ref=None,
        # A current request may still be in setup on another live request; only then is resubmitting unsafe.
        resubmission_allowed=not current,
        runtime_state=row["runtime_state"],
    )


def _view_with_native_status(meta: _Meta, request_id: str, native: NativeStatus) -> SubmissionView:
    row = meta.row
    current = meta.is_current(request_id)
    run = row["active_agent_run_id"] if current else None
    correlated = native.saved_input_available and native.native_work_ref is not None and native.request_id == request_id
    if not correlated:
        return SubmissionView(
            outcome="submission_unconfirmed",
            active_agent_run_id=run,
            native_work_ref=row["current_native_work_ref"] if current else None,
            resubmission_allowed=False,
            runtime_state=row["runtime_state"],
        )
    if native.status == "running":
        outcome = "running"
    elif native.status == "completed":
        outcome = "completed"
    elif native.status == "failed":
        outcome = "failed"
    elif native.status == "interrupted" and current and row["cancel_requested"] is True:
        outcome = "cancelled"
    else:
        # Saved and accepted by the harness; idle, interrupted without cancellation, or unknown outcome.
        outcome = "accepted"
    return SubmissionView(
        outcome=outcome,
        active_agent_run_id=run,
        native_work_ref=native.native_work_ref,
        resubmission_allowed=False,
        runtime_state=row["runtime_state"],
    )


def _uuid_or_none(value: str) -> str | None:
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        return None


__all__ = [
    "ACCEPTANCE_BUDGET_SECONDS",
    "READ_TIMEOUT_SECONDS",
    "REQUEST_ID_MAX_LENGTH",
    "NativeReadUnavailable",
    "OperationalTelemetry",
    "ReservationReleaser",
    "SessionLimits",
    "SessionManager",
    "SetupFailed",
]
