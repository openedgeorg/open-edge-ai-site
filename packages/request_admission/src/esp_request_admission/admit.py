"""Immediate admission: execute on immediately available capacity, otherwise reject (P §§12.4, 17.4; D3).

`try_admit` deliberately takes no message. The live request handler keeps the input; admission only
decides, in one bounded SQL transaction, whether this request may become the conversation's Active
Agent Run (ActAgeRun). Nothing here waits for capacity, retries, queues or stores input.

Protocol (Shared Contracts §3), in order:

1. A bounded authoritative status read: an unowned conversation is `404`; the current request ID
   returns status only (`DuplicateActive`); a committed guard or unresolved run is `409
   conversation_busy`; a recovering, suspect, unavailable or draining session is `503
   service_unavailable`.
2. The visitor rate check in Valkey (`rate_limits`), independent of capacity and authority.
3. Release resolution outside the transaction (object-store reads happen here, never under locks).
4. One transaction with bounded connection acquisition, lock wait and statement time:
   `FOR UPDATE NOWAIT` on the conversation guard, then on the current mapping; recheck the duplicate,
   guard and run state; recheck eligibility and pins (`select_admission_pins`); claim resident, active
   and provider slots with `SKIP LOCKED` (`choose_compatible_slots`); create or update the
   nullable-native-ID mapping with a fresh run, request, epoch, lease and deadline; set the guard.
   Any failure rolls the whole transaction back, so no partial claim survives.
5. After a rollback for contention, a bounded committed re-read decides: duplicate (status), confirmed
   conflicting guard (busy) or committed exhaustion (capacity). Otherwise `service_unavailable`.
   A lock failure or an empty `SKIP LOCKED` result is never by itself busy or exhaustion.

`release_unsubmitted` clears one reservation only when the caller has proven non-submission and the
current mapping still carries that exact run, epoch and guard with no native work recorded. On any
failure it returns `False` and changes nothing: ownership and accounting stay conservative until a
conditional clear succeeds. It releases active and provider capacity; resident capacity stays with
the mapping (native state may be loaded) until the supervisor confirms an unload.

A matching `current_request_id` is a duplicate whether or not the run is still active, so a retry of a
finished request cannot submit again. `release_unsubmitted` clears it, because the input provably
never reached the harness and the visitor may resubmit it manually.

The mapping keeps the request ID while unresolved; a lost commit acknowledgement is resolved by the
re-read (a committed reservation answers as a duplicate). If even the re-read fails, the answer is
`service_unavailable` and any committed reservation stays guarded until reconciled.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated, Any, Literal

import psycopg
from psycopg import errors as pg_errors
from pydantic import BaseModel, Field, model_validator

from esp_contracts.api import STRICT, RuntimeStateName
from esp_contracts.ids import UuidStr, new_id
from esp_contracts.runtime import AdmissionAuthority, SessionReservation
from esp_db.client import Db, Transaction
from esp_espcon.brain_registry import ResolvedRelease
from esp_espcon.conversation import (
    AdmissionPins,
    ConversationIneligible,
    ConversationNotFound,
    ConversationService,
    ReleaseStoreUnavailable,
)
from esp_request_admission.rate_limits import CounterStoreUnavailable, RateLimiter, RatePolicy
from esp_runtime_placement.capacity import SlotScope, held_resident_slot, release_run_slots
from esp_runtime_placement.placement import (
    PlacementRequest,
    SlotsExhausted,
    SlotsInconclusive,
    choose_compatible_slots,
    committed_exhaustion,
)

# P §12.2 initial operating values (qualification inputs): database-clock lease and run deadline.
LEASE_SECONDS = 30
RUN_DEADLINE_SECONDS = 300
# Engineering bounds for one admission decision. Admission never waits on a lock it can skip.
CONNECTION_TIMEOUT_SECONDS = 1.0
LOCK_TIMEOUT = "250ms"
STATEMENT_TIMEOUT = "2s"
REQUEST_ID_MAX_LENGTH = 200
SUBJECT_MAX_LENGTH = 128

RejectionCode = Literal[
    "invalid_request",
    "not_found",
    "conversation_busy",
    "capacity_unavailable",
    "service_unavailable",
    "rate_limited",
]
Residency = Literal["new", "resume", "resident"]
HttpStatus = Literal[400, 404, 409, 429, 503]

_STATUS_FOR_CODE: Mapping[RejectionCode, HttpStatus] = {
    "invalid_request": 400,
    "not_found": 404,
    "conversation_busy": 409,
    "rate_limited": 429,
    "capacity_unavailable": 503,
    "service_unavailable": 503,
}
_UNRESOLVED_STATES = frozenset({"running", "cancelling"})
_UNAVAILABLE_STATES = frozenset({"suspect", "recovering", "unavailable", "draining"})
_RELEASABLE_STATES = frozenset({"starting", "running", "cancelling"})
_DATABASE_ERRORS = (psycopg.Error, OSError, TimeoutError)


class Admitted(BaseModel):
    """A held reservation and its setup-scoped authority. It authorizes neither inference nor MCP.

    `residency` tells setup what the native state needs: `new` (create), `resume` (reopen saved state)
    or `resident` (already loaded on the reserved instance).
    """

    model_config = STRICT
    kind: Literal["admitted"] = "admitted"
    reservation: SessionReservation
    authority: AdmissionAuthority
    residency: Residency
    client_request_id: str = Field(min_length=1, max_length=REQUEST_ID_MAX_LENGTH)


class DuplicateActive(BaseModel):
    """The request is already the current request. Status only: no reservation, binding or token."""

    model_config = STRICT
    kind: Literal["duplicate_active"] = "duplicate_active"
    conversation_id: UuidStr
    provider_session_id: UuidStr
    client_request_id: str = Field(min_length=1)
    active_agent_run_id: UuidStr | None
    native_work_ref: str | None
    runtime_state: RuntimeStateName


class Rejected(BaseModel):
    """A clean rejection before native submission. Nothing was submitted or kept for later.

    `reason` is an operator and test diagnostic, never shown to the browser.
    """

    model_config = STRICT
    kind: Literal["rejected"] = "rejected"
    http_status: HttpStatus
    code: RejectionCode
    retryable: bool
    retry_after: int | None = Field(default=None, ge=1)
    reason: str = Field(min_length=1)

    @model_validator(mode="after")
    def _status_matches_code(self) -> Rejected:
        if _STATUS_FOR_CODE[self.code] != self.http_status:
            raise ValueError("http status does not match the rejection code")
        if (self.retry_after is not None) != (self.code == "rate_limited"):
            raise ValueError("only a rate-limit rejection carries retry-after guidance")
        return self


AdmissionResult = Annotated[Admitted | DuplicateActive | Rejected, Field(discriminator="kind")]


@dataclass(frozen=True)
class _Inconclusive:
    """Authority or capacity could not be established. Settled by a committed re-read after rollback."""

    reason: str
    placement: PlacementRequest | None = None


class _Abort(Exception):
    """Leave the admission transaction, rolling it back, with an outcome that is not an admission."""

    def __init__(self, outcome: DuplicateActive | Rejected | _Inconclusive) -> None:
        super().__init__(type(outcome).__name__)
        self.outcome = outcome


class _Refused(Exception):
    """A conditional release whose conditions no longer hold. Rolls back; nothing changes."""


@dataclass(frozen=True)
class _Status:
    owner_subject_id: str
    conversation_status: str
    guard: str | None
    mapping_id: str | None
    current_request_id: str | None
    active_agent_run_id: str | None
    native_work_ref: str | None
    runtime_state: RuntimeStateName | None
    cancel_requested: bool


_STATUS = """
    SELECT c.owner_subject_id, c.status AS conversation_status, c.active_provider_session_id::text AS guard,
           ps.id::text AS mapping_id, ps.current_request_id, ps.active_agent_run_id::text AS active_agent_run_id,
           ps.current_native_work_ref, ps.runtime_state, (ps.cancel_requested_at IS NOT NULL) AS cancel_requested
    FROM conversation AS c
    LEFT JOIN provider_session AS ps ON ps.conversation_id = c.id AND ps.is_current
    WHERE c.id = %s::uuid
"""
_MAPPING_COLUMNS = """
    id::text AS id, conversation_id::text AS conversation_id, provider, session_generation, native_session_id,
    model, brain_release_id, brain_hash, behavior_version, behavior_hash, corpus_release_id, deployment_ref,
    runtime_state, harness_instance_id::text AS harness_instance_id,
    runtime_incarnation_id::text AS runtime_incarnation_id, native_storage_unit_id, state_location,
    ownership_epoch, active_agent_run_id::text AS active_agent_run_id, current_request_id,
    current_native_work_ref, (cancel_requested_at IS NOT NULL) AS cancel_requested
"""


class AdmissionController:
    """The Admission Controller for one backend instance. Every decision is bounded and non-waiting."""

    def __init__(
        self,
        db: Db,
        conversations: ConversationService,
        *,
        rates: RateLimiter,
        rate_policy: RatePolicy,
    ) -> None:
        self._db = db
        self._conversations = conversations
        self._rates = rates
        self._rate_policy = rate_policy

    async def try_admit(self, subject_id: str, conversation_id: str, client_request_id: str) -> AdmissionResult:
        conversation = _uuid_or_none(conversation_id)
        if not subject_id or len(subject_id) > SUBJECT_MAX_LENGTH or conversation is None:
            return _not_found()
        if not client_request_id or len(client_request_id) > REQUEST_ID_MAX_LENGTH:
            return _rejected("invalid_request", "client_request_id_invalid", retryable=False)
        try:
            async with _bounded(self._db) as tx:
                status = await _read_status(tx, conversation)
        except _DATABASE_ERRORS:
            return _unavailable("database_unavailable")
        decided = _decide(status, subject_id, conversation, client_request_id)
        if decided is not None:
            return decided
        try:
            rate = await self._rates.check_rate(subject_id, self._rate_policy)
        except CounterStoreUnavailable:
            return _unavailable("rate_counter_unavailable")
        if not rate.allowed:
            return Rejected(
                http_status=429,
                code="rate_limited",
                retryable=True,
                retry_after=rate.retry_after_seconds,
                reason="rate_limited",
            )
        try:
            release = await self._conversations.resolve_pinned_release(conversation)
        except ConversationNotFound:
            return _not_found()
        except ConversationIneligible as exc:
            return _unavailable(exc.reason, retryable=False)
        except ReleaseStoreUnavailable:
            return _unavailable("release_store_unavailable")
        except _DATABASE_ERRORS:
            return _unavailable("database_unavailable")
        return await self._reserve(subject_id, conversation, client_request_id, release)

    async def release_unsubmitted(self, authority: AdmissionAuthority) -> bool:
        """Release a reservation whose input provably never reached the harness. `False` changes nothing."""
        try:
            async with _bounded(self._db) as tx:
                if not await _release_unsubmitted(tx, authority):
                    raise _Refused
        except (_Refused, *_DATABASE_ERRORS):
            return False
        return True

    async def _reserve(
        self, subject_id: str, conversation: str, request_id: str, release: ResolvedRelease
    ) -> AdmissionResult:
        try:
            async with _bounded(self._db) as tx:
                admitted = await self._claim(tx, subject_id, conversation, request_id, release)
            return admitted
        except _Abort as abort:
            outcome = abort.outcome
        except _DATABASE_ERRORS as exc:
            outcome = _Inconclusive(_database_reason(exc))
        if isinstance(outcome, _Inconclusive):
            return await self._settle(subject_id, conversation, request_id, outcome)
        return outcome

    async def _claim(
        self, tx: Transaction, subject_id: str, conversation: str, request_id: str, release: ResolvedRelease
    ) -> Admitted:
        """Everything that must hold together, or `_Abort` and roll back."""
        guard_row = await _nowait(
            tx,
            """
            SELECT owner_subject_id, status AS conversation_status, active_provider_session_id::text AS guard
            FROM conversation WHERE id = %s::uuid
            FOR UPDATE NOWAIT
            """,
            (conversation,),
            "guard_contended",
        )
        if guard_row is None:
            raise _Abort(_not_found())
        mapping = await tx.execute_one(
            f"SELECT {_MAPPING_COLUMNS} FROM provider_session WHERE conversation_id = %s::uuid AND is_current",  # noqa: S608
            (conversation,),
        )
        _abort_if_decided(guard_row, mapping, subject_id, conversation, request_id)
        if mapping is not None:
            mapping = await _nowait(
                tx,
                f"SELECT {_MAPPING_COLUMNS} FROM provider_session WHERE id = %s::uuid AND is_current FOR UPDATE NOWAIT",  # noqa: S608
                (mapping["id"],),
                "mapping_contended",
            )
            if mapping is None:
                raise _Abort(_Inconclusive("mapping_changed"))
            _abort_if_decided(guard_row, mapping, subject_id, conversation, request_id)
        try:
            pins = await self._conversations.select_admission_pins(tx, conversation, release)
        except ConversationNotFound as exc:
            raise _Abort(_not_found()) from exc
        except ConversationIneligible as exc:
            raise _Abort(_unavailable(exc.reason, retryable=False)) from exc
        if mapping is not None and not _pins_match(mapping, pins):
            raise _Abort(_unavailable("pin_mismatch", retryable=False))
        placement = await _placement_request(tx, mapping, pins)
        claim = await choose_compatible_slots(tx, placement)
        if isinstance(claim, SlotsExhausted):
            raise _Abort(_capacity(claim.scope))
        if isinstance(claim, SlotsInconclusive):
            raise _Abort(_Inconclusive(claim.reason, placement))
        residency = _residency(mapping, placement)
        native_session_id = None if mapping is None else mapping["native_session_id"]
        location = (
            str(mapping["state_location"])
            if mapping is not None and native_session_id is not None and mapping["state_location"]
            else f"volume://{claim.native_storage_unit_id}"
        )
        values: dict[str, object] = {
            "id": placement.provider_session_id,
            "conversation": conversation,
            "provider": pins.provider,
            "model": pins.model,
            "brain_release_id": pins.brain_release_id,
            "brain_hash": pins.brain_hash,
            "behavior_version": pins.behavior_version,
            "behavior_hash": pins.behavior_hash,
            "corpus_release_id": pins.corpus_release_id,
            "deployment_ref": pins.deployment_ref,
            "state": "running" if residency == "resident" else "starting",
            "instance": claim.harness_instance_id,
            "incarnation": claim.runtime_incarnation_id,
            "storage": claim.native_storage_unit_id,
            "location": location,
            "epoch": placement.reservation_epoch,
            "previous_epoch": placement.reservation_epoch - 1,
            "run": new_id(),
            "request": request_id,
            "lease": LEASE_SECONDS,
            "deadline": RUN_DEADLINE_SECONDS,
        }
        row = await tx.execute_one(_INSERT_MAPPING if mapping is None else _UPDATE_MAPPING, values)
        if row is None:
            raise _Abort(_Inconclusive("mapping_changed"))
        guarded = await tx.execute_one(
            """
            UPDATE conversation SET active_provider_session_id = %s::uuid, updated_at = transaction_timestamp()
            WHERE id = %s::uuid AND active_provider_session_id IS NULL
            RETURNING id
            """,
            (placement.provider_session_id, conversation),
        )
        if guarded is None:
            raise _Abort(_Inconclusive("guard_changed"))
        return _admitted(row, residency, request_id)

    async def _settle(
        self, subject_id: str, conversation: str, request_id: str, inconclusive: _Inconclusive
    ) -> AdmissionResult:
        """After rollback: one bounded committed read. It claims nothing and retries nothing."""
        exhausted: SlotScope | None = None
        try:
            async with _bounded(self._db) as tx:
                status = await _read_status(tx, conversation)
                if inconclusive.placement is not None:
                    exhausted = await committed_exhaustion(tx, inconclusive.placement)
        except _DATABASE_ERRORS:
            return _unavailable(inconclusive.reason)
        decided = _decide(status, subject_id, conversation, request_id)
        if decided is not None:
            return decided
        if exhausted is not None:
            return _capacity(exhausted)
        return _unavailable(inconclusive.reason)


_INSERT_MAPPING = f"""
    INSERT INTO provider_session (
        id, conversation_id, provider, session_generation, is_current, native_session_id, model,
        brain_release_id, brain_hash, behavior_version, behavior_hash, corpus_release_id, deployment_ref,
        runtime_state, harness_instance_id, runtime_incarnation_id, native_storage_unit_id, state_location,
        ownership_epoch, owner_lease_expires_at, active_agent_run_id, current_request_id,
        active_agent_run_expires_at, recovery_count, created_at, last_used_at
    )
    SELECT
        %(id)s::uuid, %(conversation)s::uuid, %(provider)s, COALESCE(max(existing.session_generation), 0) + 1,
        true, NULL, %(model)s, %(brain_release_id)s, %(brain_hash)s, %(behavior_version)s, %(behavior_hash)s,
        %(corpus_release_id)s, %(deployment_ref)s, %(state)s, %(instance)s::uuid, %(incarnation)s::uuid,
        %(storage)s, %(location)s, %(epoch)s, transaction_timestamp() + make_interval(secs => %(lease)s),
        %(run)s::uuid, %(request)s, transaction_timestamp() + make_interval(secs => %(deadline)s),
        0, transaction_timestamp(), transaction_timestamp()
    FROM provider_session AS existing
    WHERE existing.conversation_id = %(conversation)s::uuid
    RETURNING {_MAPPING_COLUMNS}
"""

_UPDATE_MAPPING = f"""
    UPDATE provider_session SET
        ownership_epoch = %(epoch)s,
        active_agent_run_id = %(run)s::uuid,
        current_request_id = %(request)s,
        current_native_work_ref = NULL,
        owner_lease_expires_at = transaction_timestamp() + make_interval(secs => %(lease)s),
        active_agent_run_expires_at = transaction_timestamp() + make_interval(secs => %(deadline)s),
        runtime_state = %(state)s,
        harness_instance_id = %(instance)s::uuid,
        runtime_incarnation_id = %(incarnation)s::uuid,
        native_storage_unit_id = %(storage)s,
        state_location = %(location)s,
        model = COALESCE(model, %(model)s),
        last_used_at = transaction_timestamp()
    WHERE id = %(id)s::uuid
      AND conversation_id = %(conversation)s::uuid
      AND is_current
      AND ownership_epoch = %(previous_epoch)s
      AND active_agent_run_id IS NULL
      AND cancel_requested_at IS NULL
    RETURNING {_MAPPING_COLUMNS}
"""


async def _release_unsubmitted(tx: Transaction, authority: AdmissionAuthority) -> bool:
    guard = await tx.execute_one(
        "SELECT active_provider_session_id::text AS guard FROM conversation WHERE id = %s::uuid FOR UPDATE NOWAIT",
        (authority.conversation_id,),
    )
    if guard is None or guard["guard"] != authority.provider_session_id:
        return False
    mapping = await tx.execute_one(
        f"""
        SELECT {_MAPPING_COLUMNS}, is_current FROM provider_session
        WHERE id = %s::uuid AND conversation_id = %s::uuid
        FOR UPDATE NOWAIT
        """,  # noqa: S608
        (authority.provider_session_id, authority.conversation_id),
    )
    if (
        mapping is None
        or mapping["is_current"] is not True
        or mapping["active_agent_run_id"] != authority.active_agent_run_id
        or mapping["ownership_epoch"] != authority.ownership_epoch
        or mapping["current_native_work_ref"] is not None
        or mapping["runtime_state"] not in _RELEASABLE_STATES
    ):
        return False
    incarnation = mapping["runtime_incarnation_id"]
    if mapping["runtime_state"] != "starting" and isinstance(incarnation, str):
        # Operation scopes can exist only once a run is running; revoking them takes the exclusive fence.
        fenced = await tx.execute_one(
            "SELECT esp_try_fence(%s, %s, true) AS locked", (incarnation, authority.provider_session_id)
        )
        if fenced is None or fenced["locked"] is not True:
            return False
    await release_run_slots(tx, authority.provider_session_id, authority.ownership_epoch)
    cleared = await tx.execute_one(
        """
        UPDATE provider_session SET
            active_agent_run_id = NULL,
            current_request_id = NULL,
            current_native_work_ref = NULL,
            owner_lease_expires_at = NULL,
            active_agent_run_expires_at = NULL,
            cancel_requested_at = NULL,
            ownership_epoch = ownership_epoch + 1,
            runtime_state = CASE
                WHEN runtime_state = 'running' AND native_session_id IS NOT NULL THEN 'warm_idle'
                ELSE 'unloaded'
            END,
            last_used_at = transaction_timestamp()
        WHERE id = %s::uuid AND ownership_epoch = %s AND active_agent_run_id = %s::uuid AND is_current
        RETURNING id
        """,
        (authority.provider_session_id, authority.ownership_epoch, authority.active_agent_run_id),
    )
    unguarded = await tx.execute_one(
        """
        UPDATE conversation SET active_provider_session_id = NULL, updated_at = transaction_timestamp()
        WHERE id = %s::uuid AND active_provider_session_id = %s::uuid
        RETURNING id
        """,
        (authority.conversation_id, authority.provider_session_id),
    )
    return cleared is not None and unguarded is not None


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


async def _nowait(tx: Transaction, query: str, params: tuple[object, ...], reason: str) -> dict[str, Any] | None:
    try:
        return await tx.execute_one(query, params)
    except (pg_errors.LockNotAvailable, pg_errors.QueryCanceled) as exc:
        raise _Abort(_Inconclusive(reason)) from exc


async def _read_status(tx: Transaction, conversation: str) -> _Status | None:
    row = await tx.execute_one(_STATUS, (conversation,))
    if row is None:
        return None
    return _Status(
        owner_subject_id=str(row["owner_subject_id"]),
        conversation_status=str(row["conversation_status"]),
        guard=row["guard"],
        mapping_id=row["mapping_id"],
        current_request_id=row["current_request_id"],
        active_agent_run_id=row["active_agent_run_id"],
        native_work_ref=row["current_native_work_ref"],
        runtime_state=row["runtime_state"],
        cancel_requested=row["cancel_requested"] is True,
    )


def _abort_if_decided(
    guard_row: Mapping[str, Any],
    mapping: Mapping[str, Any] | None,
    subject_id: str,
    conversation: str,
    request_id: str,
) -> None:
    status = _Status(
        owner_subject_id=str(guard_row["owner_subject_id"]),
        conversation_status=str(guard_row["conversation_status"]),
        guard=guard_row["guard"],
        mapping_id=None if mapping is None else mapping["id"],
        current_request_id=None if mapping is None else mapping["current_request_id"],
        active_agent_run_id=None if mapping is None else mapping["active_agent_run_id"],
        native_work_ref=None if mapping is None else mapping["current_native_work_ref"],
        runtime_state=None if mapping is None else mapping["runtime_state"],
        cancel_requested=mapping is not None and mapping["cancel_requested"] is True,
    )
    decided = _decide(status, subject_id, conversation, request_id)
    if decided is not None:
        raise _Abort(decided)


def _decide(
    status: _Status | None, subject_id: str, conversation: str, request_id: str
) -> DuplicateActive | Rejected | None:
    """Committed state that settles the request before any capacity is considered. `None` continues."""
    if status is None or status.owner_subject_id != subject_id:
        return _not_found()
    if status.mapping_id is not None and status.runtime_state is not None and status.current_request_id == request_id:
        return DuplicateActive(
            conversation_id=conversation,
            provider_session_id=status.mapping_id,
            client_request_id=request_id,
            active_agent_run_id=status.active_agent_run_id,
            native_work_ref=status.native_work_ref,
            runtime_state=status.runtime_state,
        )
    if status.guard is not None:
        return _busy("guard_held")
    if status.active_agent_run_id is not None or status.cancel_requested or status.runtime_state in _UNRESOLVED_STATES:
        return _busy("run_unresolved")
    if status.conversation_status != "active":
        return _unavailable("conversation_closed", retryable=False)
    if status.runtime_state in _UNAVAILABLE_STATES:
        return _unavailable(f"session_{status.runtime_state}")
    return None


async def _placement_request(
    tx: Transaction, mapping: Mapping[str, Any] | None, pins: AdmissionPins
) -> PlacementRequest:
    if mapping is None:
        return PlacementRequest(
            provider_session_id=new_id(),
            reservation_epoch=1,
            provider=pins.provider,
            deployment_ref=pins.deployment_ref,
        )
    mapping_id = str(mapping["id"])
    saved_storage = mapping["native_storage_unit_id"] if mapping["native_session_id"] is not None else None
    resident = await held_resident_slot(tx, mapping_id)
    incarnation = mapping["runtime_incarnation_id"]
    if resident is not None and (mapping["harness_instance_id"] != resident.scope_id or incarnation is None):
        raise _Abort(_Inconclusive("resident_instance_unavailable"))
    return PlacementRequest(
        provider_session_id=mapping_id,
        reservation_epoch=int(mapping["ownership_epoch"]) + 1,
        provider=pins.provider,
        deployment_ref=pins.deployment_ref,
        resident_instance_id=None if resident is None else resident.scope_id,
        runtime_incarnation_id=None if resident is None else incarnation,
        native_storage_unit_id=saved_storage,
    )


def _residency(mapping: Mapping[str, Any] | None, placement: PlacementRequest) -> Residency:
    if mapping is None or mapping["native_session_id"] is None:
        return "new"
    if not placement.needs_resident and mapping["runtime_state"] == "warm_idle":
        return "resident"
    return "resume"


def _pins_match(mapping: Mapping[str, Any], pins: AdmissionPins) -> bool:
    return (
        mapping["provider"] == pins.provider
        and mapping["deployment_ref"] == pins.deployment_ref
        and mapping["model"] in (None, pins.model)
        and mapping["brain_release_id"] == pins.brain_release_id
        and mapping["brain_hash"] == pins.brain_hash
        and mapping["behavior_version"] == pins.behavior_version
        and mapping["behavior_hash"] == pins.behavior_hash
        and mapping["corpus_release_id"] == pins.corpus_release_id
    )


def _admitted(row: Mapping[str, Any], residency: Residency, request_id: str) -> Admitted:
    shared: dict[str, Any] = {
        "conversation_id": row["conversation_id"],
        "provider_session_id": row["id"],
        "session_generation": row["session_generation"],
        "native_session_id": row["native_session_id"],
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
    reservation = SessionReservation.model_validate(
        {
            **shared,
            "harness_instance_id": row["harness_instance_id"],
            "runtime_incarnation_id": row["runtime_incarnation_id"],
            "native_storage_unit_id": row["native_storage_unit_id"],
            "state_location": row["state_location"],
        }
    )
    authority = AdmissionAuthority.model_validate(
        {**shared, "active_agent_run_id": row["active_agent_run_id"], "scope": "setup"}
    )
    return Admitted(reservation=reservation, authority=authority, residency=residency, client_request_id=request_id)


def _rejected(code: RejectionCode, reason: str, *, retryable: bool) -> Rejected:
    return Rejected(http_status=_STATUS_FOR_CODE[code], code=code, retryable=retryable, reason=reason)


def _not_found() -> Rejected:
    return _rejected("not_found", "conversation_not_found", retryable=False)


def _busy(reason: str) -> Rejected:
    return _rejected("conversation_busy", reason, retryable=False)


def _capacity(scope: SlotScope) -> Rejected:
    return _rejected("capacity_unavailable", f"{scope}_exhausted", retryable=True)


def _unavailable(reason: str, *, retryable: bool = True) -> Rejected:
    return _rejected("service_unavailable", reason, retryable=retryable)


def _database_reason(exc: BaseException) -> str:
    if isinstance(exc, pg_errors.LockNotAvailable):
        return "lock_contended"
    if isinstance(exc, pg_errors.QueryCanceled):
        return "statement_timeout"
    if isinstance(exc, psycopg.OperationalError | OSError | TimeoutError):
        return "database_unavailable"
    sqlstate = getattr(exc, "sqlstate", None)
    return f"database_error_{sqlstate}" if isinstance(sqlstate, str) else "database_error"


def _uuid_or_none(value: str) -> str | None:
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        return None


__all__ = [
    "CONNECTION_TIMEOUT_SECONDS",
    "LEASE_SECONDS",
    "RUN_DEADLINE_SECONDS",
    "AdmissionController",
    "AdmissionResult",
    "Admitted",
    "DuplicateActive",
    "HttpStatus",
    "Rejected",
    "RejectionCode",
    "Residency",
]
