"""Immediate admission over real PostgreSQL and Valkey, raced across independent backend connections.

Every decision is bounded by the predeclared latency budget below, including while another backend
holds row locks indefinitely: admission never waits for a lock, a slot or capacity to free up.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import Counter
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest

from esp_execution_bindings import dispatch_fence
from esp_execution_bindings.binding import AuthorizationError
from esp_execution_bindings.dispatch_fence import revoke_incarnation
from esp_request_admission.admit import AdmissionResult, Admitted, DuplicateActive, Rejected
from esp_request_admission.rate_limits import RatePolicy, open_counter_client
from esp_runtime_placement.capacity import SlotScope
from scripts.migrate import migrate
from tests.support.admission import (
    UNREACHABLE_DSN,
    UNREACHABLE_VALKEY_URL,
    VALKEY_URL,
    AdmissionLab,
    close_admission_lab,
    open_admission_lab,
    rejected,
)
from tests.support.database import APP_DSN

# Predeclared before measurement: the slowest admission decision this module accepts.
LATENCY_BUDGET_SECONDS = 2.0


@pytest.fixture
async def admission_lab(tmp_path: Path) -> AsyncIterator[AdmissionLab]:
    await migrate(APP_DSN)
    lab = await open_admission_lab(tmp_path)
    try:
        yield lab
    finally:
        await close_admission_lab(lab)


def admitted(result: object) -> Admitted:
    if not isinstance(result, Admitted):
        raise AssertionError(f"expected an admission, got {result!r}")
    return result


def within_budget(lab: AdmissionLab) -> None:
    assert lab.latencies, "no admission was measured"
    assert max(lab.latencies) <= LATENCY_BUDGET_SECONDS, max(lab.latencies)


async def test_contention_is_not_semantic_exhaustion(admission_lab: AdmissionLab) -> None:
    assert (await admission_lab.contended_guard_without_owner()).code == "service_unavailable"
    assert (await admission_lab.confirmed_conflicting_guard()).code == "conversation_busy"
    assert (await admission_lab.all_compatible_slots_committed_full()).code == "capacity_unavailable"
    assert (await admission_lab.locked_slots_with_free_capacity()).code == "service_unavailable"
    assert await admission_lab.native_submissions_after_reject_then_free() == 0
    within_budget(admission_lab)


async def test_rejections_carry_the_documented_status_and_retry_disposition(admission_lab: AdmissionLab) -> None:
    contended = await admission_lab.contended_guard_without_owner()
    busy = await admission_lab.confirmed_conflicting_guard()
    full = await admission_lab.all_compatible_slots_committed_full()
    locked = await admission_lab.locked_slots_with_free_capacity()
    assert (contended.http_status, contended.retryable, contended.retry_after) == (503, True, None)
    assert (busy.http_status, busy.retryable) == (409, False)
    assert (full.http_status, full.retryable) == (503, True)
    assert (locked.http_status, locked.retryable, locked.retry_after) == (503, True, None)
    assert contended.reason == "guard_contended"
    assert full.reason == "active_exhausted"
    assert locked.reason == "slots_locked"


async def test_admission_claims_guard_mapping_and_every_slot_in_one_transaction(admission_lab: AdmissionLab) -> None:
    # Large budgets: each claim must take exactly one row however many rows are free.
    (instance,) = await admission_lab.fresh_pool([(8, 8)], provider_limit=8)
    conv = await admission_lab.conversation()
    result = admitted(await admission_lab.admit(conv, "req-one"))

    reservation, authority = result.reservation, result.authority
    mapping = await admission_lab.mapping(conv)
    assert mapping is not None
    assert result.residency == "new"
    assert result.client_request_id == "req-one"
    assert reservation.native_session_id is None and authority.native_session_id is None
    assert authority.scope == "setup"
    assert reservation.harness_instance_id == instance
    assert reservation.provider_session_id == authority.provider_session_id == mapping["id"]
    assert reservation.ownership_epoch == authority.ownership_epoch == mapping["ownership_epoch"] == 1
    assert reservation.model == admission_lab.api.profiles["openai"].model
    assert reservation.deployment_ref == admission_lab.api.deployment_refs["openai"]
    assert reservation.brain_hash == admission_lab.api.release.canonical_brain_sha256
    assert mapping["active_agent_run_id"] == authority.active_agent_run_id
    assert mapping["current_request_id"] == "req-one"
    assert mapping["runtime_state"] == "starting"
    assert mapping["owner_lease_expires_at"] is not None and mapping["active_agent_run_expires_at"] is not None
    assert await admission_lab.guard(conv) == mapping["id"]
    held = await admission_lab.held_slots()
    assert sorted((slot.scope, slot.scope_id) for slot in held) == [
        ("active", instance),
        ("provider", "openai"),
        ("resident", instance),
    ]
    assert {slot.holder for slot in held} == {mapping["id"]}
    assert {slot.epoch for slot in held} == {1}


async def test_duplicate_current_request_returns_status_without_a_new_reservation(
    admission_lab: AdmissionLab,
) -> None:
    await admission_lab.fresh_pool([(2, 2)], provider_limit=4)
    conv = await admission_lab.conversation()
    first = admitted(await admission_lab.admit(conv, "req-dup"))
    before = await admission_lab.held_slots()

    for backend in range(3):
        duplicate = await admission_lab.admit(conv, "req-dup", backend=backend)
        assert isinstance(duplicate, DuplicateActive)
        assert duplicate.active_agent_run_id == first.authority.active_agent_run_id
        assert duplicate.provider_session_id == first.reservation.provider_session_id
        assert duplicate.client_request_id == "req-dup"
        assert duplicate.native_work_ref is None
        assert duplicate.runtime_state == "starting"
        assert set(type(duplicate).model_fields) == {
            "kind",
            "conversation_id",
            "provider_session_id",
            "client_request_id",
            "active_agent_run_id",
            "native_work_ref",
            "runtime_state",
        }

    mapping = await admission_lab.mapping(conv)
    assert mapping is not None and mapping["ownership_epoch"] == 1
    assert await admission_lab.held_slots() == before
    busy = rejected(await admission_lab.admit(conv, "req-different"))
    assert busy.code == "conversation_busy"


async def test_racing_first_mapping_creation_admits_exactly_one(admission_lab: AdmissionLab) -> None:
    await admission_lab.fresh_pool([(4, 4)], provider_limit=8)
    conv = await admission_lab.conversation()
    results = await admission_lab.race([(conv, f"req-race-{index}") for index in range(8)])

    winners = [result for result in results if isinstance(result, Admitted)]
    assert len(winners) == 1
    losers = [rejected(result) for result in results if not isinstance(result, Admitted)]
    assert {loser.code for loser in losers} <= {"conversation_busy", "service_unavailable"}
    assert await admission_lab.mapping_count(conv) == 1
    assert await admission_lab.guard(conv) == winners[0].reservation.provider_session_id
    held = await admission_lab.held_slots()
    assert Counter(slot.scope for slot in held) == Counter({"resident": 1, "active": 1, "provider": 1})
    assert {slot.holder for slot in held} == {winners[0].reservation.provider_session_id}
    within_budget(admission_lab)


async def test_racing_duplicate_current_request_admits_exactly_once(admission_lab: AdmissionLab) -> None:
    await admission_lab.fresh_pool([(4, 4)], provider_limit=8)
    conv = await admission_lab.conversation()
    results = await admission_lab.race([(conv, "req-same") for _ in range(8)])

    winners = [result for result in results if isinstance(result, Admitted)]
    assert len(winners) == 1
    for result in results:
        if isinstance(result, Rejected):
            assert result.code == "service_unavailable"
        elif isinstance(result, DuplicateActive):
            assert result.active_agent_run_id == winners[0].authority.active_agent_run_id
    retry = await admission_lab.admit(conv, "req-same")
    assert isinstance(retry, DuplicateActive)
    assert len(await admission_lab.held_slots()) == 3
    within_budget(admission_lab)


async def test_resident_active_and_provider_caps_are_independent(admission_lab: AdmissionLab) -> None:
    for pool, limit, exhausted_scope in (
        ([(1, 3)], 8, "resident"),
        ([(3, 1)], 8, "active"),
        ([(3, 3), (3, 3)], 1, "provider"),
    ):
        await admission_lab.fresh_pool(pool, provider_limit=limit)
        holder = admitted(await admission_lab.admit(await admission_lab.conversation()))
        before = await admission_lab.held_slots()
        refused_conv = await admission_lab.conversation()
        refused = rejected(await admission_lab.admit(refused_conv))
        assert (refused.code, refused.reason) == ("capacity_unavailable", f"{exhausted_scope}_exhausted")
        assert await admission_lab.held_slots() == before
        assert await admission_lab.mapping_count(refused_conv) == 0
        assert await admission_lab.guard(refused_conv) is None
        assert {slot.holder for slot in before} == {holder.reservation.provider_session_id}


@pytest.mark.parametrize("scope", ["active", "provider"])
async def test_missing_slot_rows_are_not_exhaustion(admission_lab: AdmissionLab, scope: SlotScope) -> None:
    (instance,) = await admission_lab.fresh_pool([(2, 2)], provider_limit=4)
    await admission_lab.drop_unheld_slots("openai" if scope == "provider" else instance, scope)
    conv = await admission_lab.conversation()
    refused = rejected(await admission_lab.admit(conv))
    assert (refused.code, refused.reason) == ("service_unavailable", "slots_unprovisioned")
    assert await admission_lab.held_slots() == []
    assert await admission_lab.mapping_count(conv) == 0


async def test_lowered_limit_counts_slots_held_above_it(admission_lab: AdmissionLab) -> None:
    (instance,) = await admission_lab.fresh_pool([(8, 3)], provider_limit=8)
    first, second, third = [admitted(await admission_lab.admit(await admission_lab.conversation())) for _ in range(3)]
    for released in (first, second):
        assert await admission_lab.backends[0].controller.release_unsubmitted(released.authority)
    active = [slot for slot in await admission_lab.held_slots() if slot.scope == "active"]
    assert [(slot.slot_number, slot.holder) for slot in active] == [(2, third.reservation.provider_session_id)]

    await admission_lab.set_instance(instance, active_turn_limit=2)
    results = await admission_lab.race([(await admission_lab.conversation(), f"req-low-{n}") for n in range(2)])
    assert sum(isinstance(result, Admitted) for result in results) == 1
    for result in results:
        if not isinstance(result, Admitted):
            assert rejected(result).code in {"capacity_unavailable", "service_unavailable"}
    active = [slot for slot in await admission_lab.held_slots() if slot.scope == "active"]
    assert sorted(slot.slot_number for slot in active) == [0, 2]
    refused = rejected(await admission_lab.admit(await admission_lab.conversation()))
    assert (refused.code, refused.reason) == ("capacity_unavailable", "active_exhausted")


async def test_resident_session_readmits_without_a_new_resident_slot(admission_lab: AdmissionLab) -> None:
    (instance,) = await admission_lab.fresh_pool([(1, 1)], provider_limit=4)
    conv = await admission_lab.conversation()
    first = admitted(await admission_lab.admit(conv, "req-a"))
    await admission_lab.complete_setup(first, "native-session-a")
    assert await admission_lab.backends[0].controller.release_unsubmitted(first.authority)
    mapping = await admission_lab.mapping(conv)
    assert mapping is not None and mapping["runtime_state"] == "warm_idle"
    assert [slot.scope for slot in await admission_lab.held_slots()] == ["resident"]

    other = rejected(await admission_lab.admit(await admission_lab.conversation()))
    assert (other.code, other.reason) == ("capacity_unavailable", "resident_exhausted")

    again = admitted(await admission_lab.admit(conv, "req-b", backend=1))
    assert again.residency == "resident"
    assert again.reservation.native_session_id == "native-session-a"
    assert again.reservation.harness_instance_id == instance
    assert again.reservation.ownership_epoch == first.reservation.ownership_epoch + 2
    mapping = await admission_lab.mapping(conv)
    assert mapping is not None and mapping["runtime_state"] == "running"
    held = await admission_lab.held_slots()
    assert Counter(slot.scope for slot in held) == Counter({"resident": 1, "active": 1, "provider": 1})


async def test_partial_claims_roll_back_when_a_later_slot_is_contended(admission_lab: AdmissionLab) -> None:
    await admission_lab.fresh_pool([(2, 2)], provider_limit=2)
    conv = await admission_lab.conversation()
    holder = await admission_lab.hold_free_slots("provider", "openai")
    try:
        assert holder.locked_rows == 2
        result = rejected(await admission_lab.admit(conv))
        held_during = await admission_lab.held_slots()
    finally:
        await holder.release()
    assert (result.code, result.reason) == ("service_unavailable", "slots_locked")
    assert held_during == []
    assert await admission_lab.mapping_count(conv) == 0
    assert await admission_lab.guard(conv) is None
    assert isinstance(await admission_lab.admit(conv), Admitted)


async def test_failure_after_slot_claims_rolls_back_every_claim(admission_lab: AdmissionLab) -> None:
    await admission_lab.fresh_pool([(2, 2)], provider_limit=2)
    fresh = await admission_lab.conversation()
    async with admission_lab.mapping_write_fault(fresh):
        result = rejected(await admission_lab.admit(fresh))
    assert result.code == "service_unavailable"
    assert await admission_lab.held_slots() == []
    assert await admission_lab.mapping_count(fresh) == 0
    assert await admission_lab.guard(fresh) is None

    released = await admission_lab.conversation()
    first = admitted(await admission_lab.admit(released))
    await admission_lab.complete_setup(first, "native-session-fault")
    assert await admission_lab.backends[0].controller.release_unsubmitted(first.authority)
    before = await admission_lab.held_slots()
    async with admission_lab.mapping_write_fault(released):
        result = rejected(await admission_lab.admit(released))
    assert result.code == "service_unavailable"
    assert await admission_lab.held_slots() == before
    assert await admission_lab.guard(released) is None
    mapping = await admission_lab.mapping(released)
    assert mapping is not None and mapping["active_agent_run_id"] is None


def assert_never_current_on_revoked(mapping: dict[str, Any] | None, result: AdmissionResult, revoked: str) -> None:
    """Admission and whole-process revocation may interleave in any order, but never leave live authority.

    Either the admission was refused and wrote nothing, or the revocation inventoried and revoked the run
    it admitted. A mapping that is current on the revoked incarnation with the admitted epoch is the
    stale-dispatch / second-writer hazard (D4).
    """
    if isinstance(result, Rejected):
        assert result.code == "service_unavailable"
        assert mapping is None
        return
    admitted_run = admitted(result)
    assert mapping is not None
    if mapping["runtime_incarnation_id"] == revoked:
        assert mapping["ownership_epoch"] > admitted_run.authority.ownership_epoch
        assert mapping["runtime_state"] == "unavailable"


async def test_revocation_waits_for_and_revokes_an_admission_past_its_incarnation_fence(
    admission_lab: AdmissionLab,
) -> None:
    (instance,) = await admission_lab.fresh_pool([(2, 2)], provider_limit=4)
    incarnation = await admission_lab.incarnation(instance)
    conv = await admission_lab.conversation()
    async with admission_lab.slow_mapping_write(conv, seconds=0.8):
        admission = asyncio.create_task(admission_lab.admit(conv, "req-straddled"))
        await admission_lab.wait_until_sleeping("INSERT INTO provider_session")
        revoked = await revoke_incarnation(admission_lab.backends[1].db, instance, incarnation)
        result = await admission
    mapping = await admission_lab.mapping(conv)

    assert_never_current_on_revoked(mapping, result, incarnation)
    winner = admitted(result)
    assert revoked == [winner.reservation.provider_session_id]
    assert mapping is not None and mapping["runtime_incarnation_id"] == incarnation
    assert mapping["ownership_epoch"] == winner.authority.ownership_epoch + 1
    assert await admission_lab.instance_status(instance) == "failed"


async def test_admission_that_read_a_ready_instance_is_refused_after_its_revocation(
    admission_lab: AdmissionLab,
) -> None:
    (instance,) = await admission_lab.fresh_pool([(2, 2)], provider_limit=4)
    incarnation = await admission_lab.incarnation(instance)
    conv = await admission_lab.conversation()
    async with admission_lab.slow_active_claim(instance, seconds=0.8):
        admission = asyncio.create_task(admission_lab.admit(conv, "req-before-fence"))
        await admission_lab.wait_until_sleeping("capacity_slot")
        revoked = await revoke_incarnation(admission_lab.backends[1].db, instance, incarnation)
        result = await admission
    mapping = await admission_lab.mapping(conv)

    assert_never_current_on_revoked(mapping, result, incarnation)
    assert revoked == []
    refused = rejected(result)
    assert (refused.code, refused.reason) == ("service_unavailable", "incarnation_unavailable")
    assert await admission_lab.held_slots() == []
    assert await admission_lab.guard(conv) is None
    assert await admission_lab.instance_status(instance) == "failed"


async def test_revocation_in_progress_refuses_admission_without_waiting(admission_lab: AdmissionLab) -> None:
    (instance,) = await admission_lab.fresh_pool([(2, 2)], provider_limit=4)
    incarnation = await admission_lab.incarnation(instance)
    conv = await admission_lab.conversation()
    revoking = await admission_lab.hold_incarnation_fence(incarnation, exclusive=True)
    try:
        refused = rejected(await admission_lab.admit(conv))
        held_during = await admission_lab.held_slots()
    finally:
        await revoking.release()
    assert (refused.code, refused.reason) == ("service_unavailable", "incarnation_fenced")
    assert held_during == []
    assert await admission_lab.mapping_count(conv) == 0
    # A peer's shared dispatch fence never contends with admission's shared fence.
    dispatching = await admission_lab.hold_incarnation_fence(incarnation, exclusive=False)
    try:
        assert admitted(await admission_lab.admit(conv)).reservation.runtime_incarnation_id == incarnation
    finally:
        await dispatching.release()
    within_budget(admission_lab)


async def test_whole_process_revocation_marks_first_and_never_reports_an_incomplete_inventory(
    admission_lab: AdmissionLab, monkeypatch: pytest.MonkeyPatch
) -> None:
    (instance,) = await admission_lab.fresh_pool([(2, 2)], provider_limit=4)
    incarnation = await admission_lab.incarnation(instance)
    owner = await admission_lab.conversation()
    resident = admitted(await admission_lab.admit(owner))
    revoker = admission_lab.backends[1].db

    # An in-flight dispatch holds the shared fence. Revocation marks the instance at once, then queues
    # for the exclusive fence; while it waits, no new dispatch or admission fence is granted.
    dispatching = await admission_lab.hold_incarnation_fence(incarnation, exclusive=False)
    revocation = asyncio.create_task(revoke_incarnation(revoker, instance, incarnation))
    try:
        await admission_lab.wait_until_awaiting_advisory_lock()
        assert await admission_lab.instance_status(instance) == "failed"
        assert not await admission_lab.try_incarnation_fence(incarnation, exclusive=False)
        assert not revocation.done()
    finally:
        await dispatching.release()
    assert await revocation == [resident.reservation.provider_session_id]

    # A holder that outlasts the bounded wait makes revocation raise. It never returns an empty
    # inventory that a caller could mistake for "no mapping on this incarnation".
    monkeypatch.setattr(dispatch_fence, "REVOCATION_LOCK_TIMEOUT", "200ms")
    dispatching = await admission_lab.hold_incarnation_fence(incarnation, exclusive=False)
    try:
        with pytest.raises(AuthorizationError, match="fence_unavailable"):
            await revoke_incarnation(revoker, instance, incarnation)
    finally:
        await dispatching.release()
    mapping = await admission_lab.mapping(owner)
    assert mapping is not None and mapping["ownership_epoch"] == resident.authority.ownership_epoch + 1


async def test_free_instance_is_used_when_another_instance_is_contended(admission_lab: AdmissionLab) -> None:
    # The contended instance has the most free active slots, so placement tries it first and must move on.
    contended, free = await admission_lab.fresh_pool([(2, 3), (2, 2)], provider_limit=4)
    holder = await admission_lab.hold_free_slots("active", contended)
    try:
        assert holder.locked_rows == 3
        result = admitted(await admission_lab.admit(await admission_lab.conversation()))
        held_on_contended = [slot for slot in await admission_lab.held_slots() if slot.scope_id == contended]
    finally:
        await holder.release()
    assert result.reservation.harness_instance_id == free
    assert held_on_contended == []


async def test_row_locks_alone_never_become_busy_or_capacity_claims(admission_lab: AdmissionLab) -> None:
    await admission_lab.fresh_pool([(2, 2)], provider_limit=4)
    warm = await admission_lab.conversation()
    first = admitted(await admission_lab.admit(warm))
    assert await admission_lab.backends[0].controller.release_unsubmitted(first.authority)
    holder = await admission_lab.hold_mapping(warm)
    try:
        locked = rejected(await admission_lab.admit(warm))
    finally:
        await holder.release()
    assert (locked.code, locked.reason) == ("service_unavailable", "mapping_contended")
    assert await admission_lab.guard(warm) is None

    owned = await admission_lab.conversation()
    admitted(await admission_lab.admit(owned, "req-owner"))
    holder = await admission_lab.hold_conversation(owned)
    try:
        busy = rejected(await admission_lab.admit(owned, "req-other"))
        duplicate = await admission_lab.admit(owned, "req-owner")
    finally:
        await holder.release()
    assert busy.code == "conversation_busy"
    assert isinstance(duplicate, DuplicateActive)
    within_budget(admission_lab)


async def test_sequential_admissions_spread_over_instances(admission_lab: AdmissionLab) -> None:
    instances = await admission_lab.fresh_pool([(2, 2), (2, 2), (2, 2)], provider_limit=6)
    placed = [
        admitted(await admission_lab.admit(await admission_lab.conversation())).reservation.harness_instance_id
        for _ in range(6)
    ]
    assert set(placed[:3]) == set(instances)
    assert Counter(placed) == Counter({instance: 2 for instance in instances})
    full = rejected(await admission_lab.admit(await admission_lab.conversation()))
    assert full.code == "capacity_unavailable"


async def test_concurrent_admissions_never_oversubscribe_or_strand_a_slot(admission_lab: AdmissionLab) -> None:
    instances = await admission_lab.fresh_pool([(2, 2), (2, 2), (2, 2)], provider_limit=6)
    convs = [await admission_lab.conversation() for _ in range(9)]
    results = await admission_lab.race([(conv, f"req-{index}") for index, conv in enumerate(convs)])

    wins = [result for result in results if isinstance(result, Admitted)]
    codes = Counter(rejected(result).code for result in results if not isinstance(result, Admitted))
    assert set(codes) <= {"capacity_unavailable", "service_unavailable"}
    held = await admission_lab.held_slots()
    per_scope = Counter((slot.scope, slot.scope_id) for slot in held)
    for instance in instances:
        assert per_scope[("active", instance)] <= 2
        assert per_scope[("resident", instance)] <= 2
    assert per_scope[("provider", "openai")] == len(wins) <= 6
    by_holder: dict[str | None, set[tuple[str, str]]] = {}
    for slot in held:
        by_holder.setdefault(slot.holder, set()).add((slot.scope, slot.scope_id))
    for win in wins:
        instance = win.reservation.harness_instance_id
        assert by_holder[win.reservation.provider_session_id] == {
            ("resident", instance),
            ("active", instance),
            ("provider", "openai"),
        }
    if codes["capacity_unavailable"]:
        assert len(wins) == 6

    retried = [conv for conv, result in zip(convs, results, strict=True) if not isinstance(result, Admitted)]
    outcomes = [await admission_lab.admit(conv) for conv in retried]
    assert sum(isinstance(outcome, Admitted) for outcome in outcomes) == 6 - len(wins)
    assert len([slot for slot in await admission_lab.held_slots() if slot.scope == "active"]) == 6
    within_budget(admission_lab)


async def test_outages_reject_new_input_without_any_reservation(admission_lab: AdmissionLab) -> None:
    await admission_lab.fresh_pool([(2, 2)], provider_limit=4)
    conv = await admission_lab.conversation()
    outage_backends = {
        "database_unavailable": await admission_lab.backend(dsn=UNREACHABLE_DSN),
        "rate_counter_unavailable": await admission_lab.backend(valkey_url=UNREACHABLE_VALKEY_URL),
        "release_store_unavailable": await admission_lab.backend(faulty_store=True),
    }
    for reason, backend in outage_backends.items():
        started = time.perf_counter()
        result = rejected(await admission_lab.admit(conv, backend=backend))
        assert time.perf_counter() - started <= LATENCY_BUDGET_SECONDS
        assert (result.code, result.http_status, result.reason) == ("service_unavailable", 503, reason)
    assert await admission_lab.mapping_count(conv) == 0

    await admission_lab.set_provider(limit=4, healthy=False)
    assert rejected(await admission_lab.admit(conv)).reason == "provider_unavailable"
    await admission_lab.set_provider(limit=4, healthy=True)

    await admission_lab.fresh_pool([], provider_limit=4)
    await admission_lab.add_instance(heartbeat_age_seconds=120)
    stale = rejected(await admission_lab.admit(conv))
    assert (stale.code, stale.reason) == ("service_unavailable", "no_ready_instance")

    assert await admission_lab.mapping_count(conv) == 0
    assert await admission_lab.guard(conv) is None
    assert await admission_lab.held_slots() == []


async def test_unavailable_or_restarted_sessions_are_service_unavailable(admission_lab: AdmissionLab) -> None:
    (instance,) = await admission_lab.fresh_pool([(2, 2)], provider_limit=4)
    recovering = await admission_lab.conversation()
    admitted(await admission_lab.admit(recovering))
    for state in ("recovering", "suspect", "unavailable", "draining"):
        await admission_lab.idle_in_state(recovering, state)
        refused = rejected(await admission_lab.admit(recovering))
        assert (refused.code, refused.reason) == ("service_unavailable", f"session_{state}")

    restarted = await admission_lab.conversation()
    first = admitted(await admission_lab.admit(restarted))
    await admission_lab.complete_setup(first, "native-session-restart")
    assert await admission_lab.backends[0].controller.release_unsubmitted(first.authority)
    await admission_lab.set_instance(instance, process_incarnation_id="00000000-0000-4000-8000-000000000001")
    refused = rejected(await admission_lab.admit(restarted))
    assert (refused.code, refused.reason) == ("service_unavailable", "resident_instance_unavailable")


async def test_rate_limited_admission_reserves_nothing(admission_lab: AdmissionLab) -> None:
    await admission_lab.fresh_pool([(4, 4)], provider_limit=4)
    strict = RatePolicy(
        policy_id="test-admission-strict", window_seconds=3600, capacity=1, refill=1, expiry_seconds=3600
    )
    backend = await admission_lab.backend(policy=strict)
    first = await admission_lab.conversation()
    second = await admission_lab.conversation(first.subject_id)
    admission_lab.track_counter(first.subject_id, strict)
    admitted(await admission_lab.admit(first, backend=backend))
    limited = rejected(await admission_lab.admit(second, backend=backend))
    assert (limited.http_status, limited.code, limited.retryable) == (429, "rate_limited", True)
    assert limited.retry_after is not None and 1 <= limited.retry_after <= 3600
    assert await admission_lab.mapping_count(second) == 0
    assert await admission_lab.guard(second) is None


async def test_owner_mismatch_and_malformed_identifiers(admission_lab: AdmissionLab) -> None:
    await admission_lab.fresh_pool([(2, 2)], provider_limit=4)
    conv = await admission_lab.conversation()
    controller = admission_lab.backends[0].controller
    other = rejected(await admission_lab.admit(conv, subject_id="test-admission-someone-else"))
    malformed = rejected(await controller.try_admit(conv.subject_id, "not-a-uuid", "r"))
    blank = rejected(await controller.try_admit(conv.subject_id, conv.conversation_id, ""))
    long = rejected(await controller.try_admit(conv.subject_id, conv.conversation_id, "r" * 201))
    assert (other.http_status, other.code) == (404, "not_found")
    assert (malformed.http_status, malformed.code) == (404, "not_found")
    assert (blank.http_status, blank.code) == (400, "invalid_request")
    assert (long.http_status, long.code) == (400, "invalid_request")
    assert await admission_lab.mapping_count(conv) == 0


async def test_release_requires_proven_current_authority_and_stays_conservative(admission_lab: AdmissionLab) -> None:
    (instance,) = await admission_lab.fresh_pool([(2, 2)], provider_limit=4)
    conv = await admission_lab.conversation()
    first = admitted(await admission_lab.admit(conv, "req-held"))
    reserved = await admission_lab.held_slots()

    down = await admission_lab.backend(dsn=UNREACHABLE_DSN)
    started = time.perf_counter()
    assert not await down.controller.release_unsubmitted(first.authority)
    assert time.perf_counter() - started <= LATENCY_BUDGET_SECONDS
    holder = await admission_lab.hold_conversation(conv)
    try:
        assert not await admission_lab.backends[1].controller.release_unsubmitted(first.authority)
    finally:
        await holder.release()
    stale = first.authority.model_copy(update={"ownership_epoch": first.authority.ownership_epoch + 7})
    assert not await admission_lab.backends[0].controller.release_unsubmitted(stale)
    assert await admission_lab.held_slots() == reserved
    assert await admission_lab.guard(conv) == first.reservation.provider_session_id
    assert rejected(await admission_lab.admit(conv, "req-next")).code == "conversation_busy"

    assert await admission_lab.backends[2].controller.release_unsubmitted(first.authority)
    assert not await admission_lab.backends[2].controller.release_unsubmitted(first.authority)
    assert await admission_lab.guard(conv) is None
    mapping = await admission_lab.mapping(conv)
    assert mapping is not None
    assert (mapping["active_agent_run_id"], mapping["current_request_id"]) == (None, None)
    assert mapping["runtime_state"] == "unloaded"
    assert mapping["ownership_epoch"] == first.authority.ownership_epoch + 1
    assert [(slot.scope, slot.scope_id) for slot in await admission_lab.held_slots()] == [("resident", instance)]

    second = admitted(await admission_lab.admit(conv, "req-held"))
    assert second.residency == "new"
    assert second.reservation.harness_instance_id == instance
    assert second.reservation.ownership_epoch == first.authority.ownership_epoch + 2
    await admission_lab.record_native_work(second, "native-work-accepted")
    assert not await admission_lab.backends[0].controller.release_unsubmitted(second.authority)
    assert await admission_lab.guard(conv) == second.reservation.provider_session_id


async def test_admission_keeps_no_input_or_backlog(admission_lab: AdmissionLab) -> None:
    await admission_lab.fresh_pool([(1, 1)], provider_limit=1)
    holder = admitted(await admission_lab.admit(await admission_lab.conversation()))
    refused = [await admission_lab.conversation() for _ in range(4)]
    rows_before = await admission_lab.conversation_rows(refused)
    draft = f"test-admission-draft-canary-{uuid.uuid4().hex}"
    results = await asyncio.gather(
        *(admission_lab.submit(conv, f"req-refused-{index}", draft) for index, conv in enumerate(refused))
    )
    assert {rejected(result).code for result in results} == {"capacity_unavailable"}

    # Free the capacity the refusals saw as full. Nothing refused may run, or be kept, afterwards.
    assert await admission_lab.backends[0].controller.release_unsubmitted(holder.authority)
    await asyncio.sleep(0.3)
    assert await admission_lab.conversation_rows(refused) == rows_before
    for conv in refused:
        assert await admission_lab.mapping_count(conv) == 0
    assert await admission_lab.stored_text_occurrences(draft) == []
    within_budget(admission_lab)


async def test_stored_text_search_finds_text_in_a_table_or_valkey(admission_lab: AdmissionLab) -> None:
    """The no-backlog search above can fail: it finds text written to a table row or a Valkey key."""
    (instance,) = await admission_lab.fresh_pool([(1, 1)], provider_limit=1)
    canary = f"test-admission-search-canary-{uuid.uuid4().hex}"
    await admission_lab.set_instance(instance, worker_id=f"worker-{canary}")
    client = open_counter_client(VALKEY_URL, timeout_seconds=1.0)
    key = f"esp:test:{uuid.uuid4().hex}"
    try:
        await client.hset(key, mapping={"value": canary})
        assert await admission_lab.stored_text_occurrences(canary) == ["table:harness_instance", f"valkey:{key}"]
    finally:
        await client.delete(key)
        await client.aclose()
