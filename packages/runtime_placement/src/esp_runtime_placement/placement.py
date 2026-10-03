"""Healthy compatible placement inside the caller's admission transaction. Internal to admission.

`choose_compatible_slots` claims, without waiting, everything one admitted run needs in the stable order
resident -> active -> provider: a resident slot for new or unloaded native state, an active slot on the
same Shared Harness Instance (ShaHarIns), and a provider slot. It answers one of three outcomes:

- `acquired`: every needed slot is held by the mapping at the reservation epoch, and the caller's
  transaction holds the shared fence on the chosen instance's Process Incarnation (ProInc);
- `exhausted`: committed holders fill a needed budget on every compatible instance, or the provider budget;
- `inconclusive`: capacity could not be established. Committed capacity existed but the rows were locked
  by other transactions or never provisioned, the provider is unhealthy, no ready compatible instance
  (or not the instance holding the mapping's resident slot) exists, or the chosen incarnation is being
  revoked. Callers report `service_unavailable`, never busy and never exhaustion.

Ordering against whole-process revocation: after the claims, placement takes the non-waiting shared fence
`esp_try_fence(incarnation, mapping, false)` and then re-reads that the instance is still ready on that
incarnation. The fence stays held until the caller's transaction ends. Revocation marks the instance
first and only then takes the exclusive incarnation fence and inventories the incarnation's mappings.
An admitted run is therefore either committed before that inventory, which revokes it, or refused here:
the fence is unavailable while a revocation holds or awaits it, and once a revocation has committed, the
re-read sees its mark.

A non-acquired outcome rolls back its own claims and fence (savepoint), so no partial reservation
survives in the caller's transaction. Placement does no remote I/O, takes no provider-wide lock and
never retries.

Fair use across instances: candidates are tried in order of most free committed active capacity, then
most free resident capacity, then instance ID. A contended instance is skipped for the next, so free
capacity elsewhere is used rather than refused, and sequential admissions spread over instances.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator

from esp_contracts.api import STRICT
from esp_contracts.ids import Int64, Provider, UuidStr
from esp_db.client import Transaction
from esp_runtime_placement.capacity import (
    ClaimedSlot,
    InstanceCapacity,
    ProviderBudget,
    SlotScope,
    claim_slot,
    compatible_instances,
    incarnation_is_ready,
    provider_budget,
)

InconclusiveReason = Literal[
    "slots_locked",
    "slots_unprovisioned",
    "provider_unavailable",
    "no_ready_instance",
    "resident_instance_unavailable",
    "incarnation_fenced",
    "incarnation_unavailable",
]


class PlacementRequest(BaseModel):
    """What one run must hold: the mapping, its pinned deployment, residency and storage requirement.

    A mapping that already holds a resident slot names that instance and its current Process
    Incarnation (ProInc); it needs only active and provider capacity there. Otherwise a resident slot is
    claimed too, on an instance mounting `native_storage_unit_id` when saved native state exists.
    """

    model_config = STRICT
    provider_session_id: UuidStr
    reservation_epoch: Int64 = Field(ge=1)
    provider: Provider
    deployment_ref: str = Field(min_length=1)
    resident_instance_id: UuidStr | None = None
    runtime_incarnation_id: UuidStr | None = None
    native_storage_unit_id: str | None = None

    @model_validator(mode="after")
    def _residency_is_consistent(self) -> PlacementRequest:
        if (self.resident_instance_id is None) != (self.runtime_incarnation_id is None):
            raise ValueError("a resident instance is named together with its current incarnation")
        return self

    @property
    def needs_resident(self) -> bool:
        return self.resident_instance_id is None

    @property
    def scopes(self) -> tuple[SlotScope, ...]:
        if self.needs_resident:
            return ("resident", "active", "provider")
        return ("active", "provider")


class SlotsAcquired(BaseModel):
    model_config = STRICT
    outcome: Literal["acquired"]
    harness_instance_id: UuidStr
    runtime_incarnation_id: UuidStr
    native_storage_unit_id: str = Field(min_length=1)
    slots: list[ClaimedSlot]


class SlotsExhausted(BaseModel):
    """Committed holders fill this budget. Locked rows never contribute to an exhausted answer."""

    model_config = STRICT
    outcome: Literal["exhausted"]
    scope: SlotScope


class SlotsInconclusive(BaseModel):
    model_config = STRICT
    outcome: Literal["inconclusive"]
    reason: InconclusiveReason


SlotClaimResult = Annotated[SlotsAcquired | SlotsExhausted | SlotsInconclusive, Field(discriminator="outcome")]

_PLACEMENT = "esp_placement"
_INSTANCE = "esp_placement_instance"


async def choose_compatible_slots(tx: Transaction, request: PlacementRequest) -> SlotClaimResult:
    budget = await provider_budget(tx, request.provider)
    if budget is None or not budget.healthy:
        return SlotsInconclusive(outcome="inconclusive", reason="provider_unavailable")
    if budget.budget.free <= 0:
        return SlotsExhausted(outcome="exhausted", scope="provider")
    instances = await _candidates(tx, request)
    if isinstance(instances, SlotsInconclusive):
        return instances
    await tx.execute(f"SAVEPOINT {_PLACEMENT}")
    placed = await _claim_instance(tx, request, instances)
    if placed is None:
        await _undo(tx, _PLACEMENT)
        return _instance_failure(instances, request.needs_resident)
    instance, slots = placed
    provider_slot = await claim_slot(
        tx,
        scope="provider",
        scope_id=request.provider,
        claimable_below=budget.budget.claimable_below,
        holder_provider_session_id=request.provider_session_id,
        reservation_epoch=request.reservation_epoch,
    )
    if provider_slot is None:
        await _undo(tx, _PLACEMENT)
        return _provider_failure(await provider_budget(tx, request.provider))
    unsettled = await _hold_incarnation(tx, request, instance)
    if unsettled is not None:
        await _undo(tx, _PLACEMENT)
        return unsettled
    await tx.execute(f"RELEASE SAVEPOINT {_PLACEMENT}")
    return SlotsAcquired(
        outcome="acquired",
        harness_instance_id=instance.harness_instance_id,
        runtime_incarnation_id=instance.runtime_incarnation_id,
        native_storage_unit_id=instance.native_storage_unit_id,
        slots=[*slots, provider_slot],
    )


async def committed_exhaustion(tx: Transaction, request: PlacementRequest) -> SlotScope | None:
    """A bounded committed re-read after rollback: the budget committed holders now fill, if any.

    It claims nothing and retries nothing. `None` means exhaustion is not established.
    """
    budget = await provider_budget(tx, request.provider)
    if budget is None or not budget.healthy:
        return None
    if budget.budget.free <= 0:
        return "provider"
    instances = await _candidates(tx, request)
    if isinstance(instances, SlotsInconclusive):
        return None
    failure = _instance_failure(instances, request.needs_resident)
    return failure.scope if isinstance(failure, SlotsExhausted) else None


async def _candidates(tx: Transaction, request: PlacementRequest) -> list[InstanceCapacity] | SlotsInconclusive:
    instances = await compatible_instances(
        tx,
        provider=request.provider,
        deployment_ref=request.deployment_ref,
        instance_id=request.resident_instance_id,
        native_storage_unit_id=request.native_storage_unit_id,
    )
    if request.resident_instance_id is not None:
        if len(instances) != 1 or instances[0].runtime_incarnation_id != request.runtime_incarnation_id:
            return SlotsInconclusive(outcome="inconclusive", reason="resident_instance_unavailable")
    elif not instances:
        return SlotsInconclusive(outcome="inconclusive", reason="no_ready_instance")
    return instances


async def _claim_instance(
    tx: Transaction, request: PlacementRequest, instances: list[InstanceCapacity]
) -> tuple[InstanceCapacity, list[ClaimedSlot]] | None:
    """Try each committed-hostable instance in order; a failed instance's claims roll back at once."""
    for instance in instances:
        if not instance.can_host(request.needs_resident):
            continue
        await tx.execute(f"SAVEPOINT {_INSTANCE}")
        slots: list[ClaimedSlot] = []
        for scope in request.scopes:
            if scope == "provider":
                continue
            budget = instance.resident if scope == "resident" else instance.active
            slot = await claim_slot(
                tx,
                scope=scope,
                scope_id=instance.harness_instance_id,
                claimable_below=budget.claimable_below,
                holder_provider_session_id=request.provider_session_id,
                reservation_epoch=request.reservation_epoch,
            )
            if slot is None:
                break
            slots.append(slot)
        else:
            await tx.execute(f"RELEASE SAVEPOINT {_INSTANCE}")
            return instance, slots
        await _undo(tx, _INSTANCE)
    return None


async def _hold_incarnation(
    tx: Transaction, request: PlacementRequest, instance: InstanceCapacity
) -> SlotsInconclusive | None:
    """Take the shared incarnation fence without waiting, then re-read the instance under it."""
    fenced = await tx.execute_one(
        "SELECT esp_try_fence(%s, %s, false) AS locked",
        (instance.runtime_incarnation_id, request.provider_session_id),
    )
    if fenced is None or fenced["locked"] is not True:
        return SlotsInconclusive(outcome="inconclusive", reason="incarnation_fenced")
    if not await incarnation_is_ready(tx, instance.harness_instance_id, instance.runtime_incarnation_id):
        return SlotsInconclusive(outcome="inconclusive", reason="incarnation_unavailable")
    return None


def _provider_failure(current: ProviderBudget | None) -> SlotsExhausted | SlotsInconclusive:
    """Why no provider row could be claimed, from the committed re-read after rollback."""
    if current is None or not current.healthy:
        return SlotsInconclusive(outcome="inconclusive", reason="provider_unavailable")
    if current.budget.free <= 0:
        return SlotsExhausted(outcome="exhausted", scope="provider")
    if current.budget.free_rows == 0:
        return SlotsInconclusive(outcome="inconclusive", reason="slots_unprovisioned")
    return SlotsInconclusive(outcome="inconclusive", reason="slots_locked")


def _instance_failure(instances: list[InstanceCapacity], needs_resident: bool) -> SlotsExhausted | SlotsInconclusive:
    """Exhausted only when committed holders leave no compatible instance able to host the run."""
    if all(not instance.can_host(needs_resident) for instance in instances):
        lacking_active = any(instance.active.free <= 0 for instance in instances)
        return SlotsExhausted(outcome="exhausted", scope="active" if lacking_active else "resident")
    rows_existed = any(
        instance.can_host(needs_resident)
        and instance.active.free_rows > 0
        and (not needs_resident or instance.resident.free_rows > 0)
        for instance in instances
    )
    return SlotsInconclusive(outcome="inconclusive", reason="slots_locked" if rows_existed else "slots_unprovisioned")


async def _undo(tx: Transaction, savepoint: str) -> None:
    await tx.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
    await tx.execute(f"RELEASE SAVEPOINT {savepoint}")
