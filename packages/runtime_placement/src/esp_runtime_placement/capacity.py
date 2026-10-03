"""Preallocated capacity slots: resident and active per Shared Harness Instance (ShaHarIns), plus provider.

A `capacity_slot` row is one unit of a budget. Its scope is `resident` or `active` with the instance ID
as `scope_id`, or `provider` with the provider name. A held row names the Harness Conversation Session
(HarConSes) mapping that holds it and the ownership epoch it was reserved under. Rows store no message,
turn or future work.

Limits stay authoritative on `harness_instance` and `provider_capacity`; rows are the lockable tokens.
A held row counts against its budget even above a lowered limit, so a lowered limit never lets new
claims exceed it, and claims use only rows below `limit - held_above_limit`.

Reads here are plain committed reads (READ COMMITTED, no locks). They establish exhaustion only from
committed holders; a row another transaction has locked is never treated as occupied. Claims are
non-waiting (`FOR UPDATE SKIP LOCKED`), so an empty claim alone proves nothing.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from esp_contracts.api import STRICT
from esp_contracts.ids import Int64, Provider, UuidStr
from esp_db.client import Transaction

SlotScope = Literal["resident", "active", "provider"]
SLOT_SCOPES: tuple[SlotScope, ...] = ("resident", "active", "provider")

# P §12.2 database-clock lease. An instance whose heartbeat is older is not healthy for placement.
INSTANCE_HEARTBEAT_LEASE_SECONDS = 30


class ClaimedSlot(BaseModel):
    model_config = STRICT
    scope: SlotScope
    scope_id: str = Field(min_length=1)
    slot_number: int = Field(ge=0)


class BudgetState(BaseModel):
    """One budget's committed state. `free` may be negative after a lowered limit."""

    model_config = STRICT
    limit: int = Field(ge=0)
    held: int = Field(ge=0)
    held_above_limit: int = Field(ge=0)
    free_rows: int = Field(ge=0)

    @property
    def free(self) -> int:
        return self.limit - self.held

    @property
    def claimable_below(self) -> int:
        """Claims use rows numbered below this, so held rows never exceed the limit."""
        return max(0, self.limit - self.held_above_limit)


class InstanceCapacity(BaseModel):
    """A ready, heartbeat-fresh compatible instance and its committed resident and active budgets."""

    model_config = STRICT
    harness_instance_id: UuidStr
    runtime_incarnation_id: UuidStr
    native_storage_unit_id: str = Field(min_length=1)
    resident: BudgetState
    active: BudgetState

    def can_host(self, needs_resident: bool) -> bool:
        return self.active.free > 0 and (not needs_resident or self.resident.free > 0)


class ProviderBudget(BaseModel):
    model_config = STRICT
    provider: Provider
    healthy: bool
    budget: BudgetState


_BUDGET = """
    SELECT
        count(*) FILTER (WHERE cs.holder_provider_session_id IS NOT NULL) AS held,
        count(*) FILTER (
            WHERE cs.holder_provider_session_id IS NOT NULL AND cs.slot_number >= {limit}
        ) AS held_above_limit,
        count(*) FILTER (WHERE cs.holder_provider_session_id IS NULL AND cs.slot_number < {limit}) AS free_rows
    FROM capacity_slot AS cs
    WHERE cs.scope = '{scope}' AND cs.scope_id = {scope_id}
"""

_RESIDENT_BUDGET = _BUDGET.format(limit="hi.resident_session_limit", scope="resident", scope_id="hi.id::text")
_ACTIVE_BUDGET = _BUDGET.format(limit="hi.active_turn_limit", scope="active", scope_id="hi.id::text")
_PROVIDER_BUDGET = _BUDGET.format(limit="pc.active_limit", scope="provider", scope_id="pc.provider")

_INSTANCES = f"""
    SELECT
        hi.id::text AS harness_instance_id,
        hi.process_incarnation_id::text AS runtime_incarnation_id,
        hi.native_storage_unit_id,
        hi.resident_session_limit AS resident_limit,
        hi.active_turn_limit AS active_limit,
        r.held AS resident_held, r.held_above_limit AS resident_held_above_limit, r.free_rows AS resident_free_rows,
        a.held AS active_held, a.held_above_limit AS active_held_above_limit, a.free_rows AS active_free_rows
    FROM harness_instance AS hi
    CROSS JOIN LATERAL ({_RESIDENT_BUDGET}) AS r
    CROSS JOIN LATERAL ({_ACTIVE_BUDGET}) AS a
    WHERE hi.provider = %(provider)s
      AND hi.deployment_ref = %(deployment_ref)s
      AND hi.lifecycle_status = 'ready'
      AND hi.last_heartbeat_at > transaction_timestamp() - make_interval(secs => %(lease)s)
      AND (%(instance_id)s::uuid IS NULL OR hi.id = %(instance_id)s::uuid)
      AND (%(storage)s::text IS NULL OR hi.native_storage_unit_id = %(storage)s::text)
    ORDER BY (hi.active_turn_limit - a.held) DESC, (hi.resident_session_limit - r.held) DESC, hi.id
"""

_PROVIDER = f"""
    SELECT pc.provider, pc.healthy, pc.active_limit AS limit, b.held, b.held_above_limit, b.free_rows
    FROM provider_capacity AS pc
    CROSS JOIN LATERAL ({_PROVIDER_BUDGET}) AS b
    WHERE pc.provider = %s
"""


async def compatible_instances(
    tx: Transaction,
    *,
    provider: Provider,
    deployment_ref: str,
    instance_id: str | None,
    native_storage_unit_id: str | None,
) -> list[InstanceCapacity]:
    """Ready, heartbeat-fresh instances of the pinned deployment, most free active capacity first.

    `instance_id` restricts the answer to the instance already holding the mapping's resident slot;
    `native_storage_unit_id` to instances that mount the mapping's saved native storage.
    """
    rows = await tx.execute(
        _INSTANCES,
        {
            "provider": provider,
            "deployment_ref": deployment_ref,
            "lease": INSTANCE_HEARTBEAT_LEASE_SECONDS,
            "instance_id": instance_id,
            "storage": native_storage_unit_id,
        },
    )
    return [_instance(row) for row in rows]


async def provider_budget(tx: Transaction, provider: Provider) -> ProviderBudget | None:
    row = await tx.execute_one(_PROVIDER, (provider,))
    if row is None:
        return None
    return ProviderBudget(
        provider=provider,
        healthy=row["healthy"] is True,
        budget=_budget(row, ""),
    )


async def claim_slot(
    tx: Transaction,
    *,
    scope: SlotScope,
    scope_id: str,
    claimable_below: int,
    holder_provider_session_id: str,
    reservation_epoch: int,
) -> ClaimedSlot | None:
    """Claim one unheld, unlocked row without waiting. `None` is inconclusive on its own.

    The locking candidate is a materialized CTE, evaluated exactly once. A `LIMIT 1 ... SKIP LOCKED`
    subquery under `IN` may be re-run per outer row by a semi join, and each re-run skips the row the
    same command just updated, so it would claim every free row.
    """
    rows = await tx.execute(
        """
        WITH candidate AS MATERIALIZED (
            SELECT c.scope, c.scope_id, c.slot_number
            FROM capacity_slot AS c
            WHERE c.scope = %(scope)s
              AND c.scope_id = %(scope_id)s
              AND c.holder_provider_session_id IS NULL
              AND c.slot_number < %(below)s
            ORDER BY c.slot_number
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        UPDATE capacity_slot AS cs
        SET holder_provider_session_id = %(holder)s::uuid, reservation_epoch = %(epoch)s
        FROM candidate
        WHERE cs.scope = candidate.scope
          AND cs.scope_id = candidate.scope_id
          AND cs.slot_number = candidate.slot_number
          AND cs.holder_provider_session_id IS NULL
        RETURNING cs.slot_number
        """,
        {
            "holder": holder_provider_session_id,
            "epoch": reservation_epoch,
            "scope": scope,
            "scope_id": scope_id,
            "below": claimable_below,
        },
    )
    if len(rows) > 1:
        raise RuntimeError("a slot claim updated more than one row")
    if not rows:
        return None
    return ClaimedSlot(scope=scope, scope_id=scope_id, slot_number=int(rows[0]["slot_number"]))


async def held_resident_slot(tx: Transaction, provider_session_id: str) -> ClaimedSlot | None:
    """The resident slot a mapping already holds, which keeps its native state counted as resident."""
    row = await tx.execute_one(
        """
        SELECT scope_id, slot_number FROM capacity_slot
        WHERE scope = 'resident' AND holder_provider_session_id = %s::uuid
        ORDER BY scope_id, slot_number
        LIMIT 1
        """,
        (provider_session_id,),
    )
    if row is None:
        return None
    return ClaimedSlot(scope="resident", scope_id=str(row["scope_id"]), slot_number=int(row["slot_number"]))


async def release_run_slots(tx: Transaction, provider_session_id: str, reservation_epoch: Int64) -> int:
    """Release the active and provider slots one run reserved. Resident capacity is not a run's to free."""
    rows = await tx.execute(
        """
        UPDATE capacity_slot
        SET holder_provider_session_id = NULL, reservation_epoch = NULL
        WHERE holder_provider_session_id = %s::uuid
          AND reservation_epoch = %s
          AND scope IN ('active', 'provider')
        RETURNING scope
        """,
        (provider_session_id, reservation_epoch),
    )
    return len(rows)


async def provision_instance_slots(tx: Transaction, instance_id: str) -> None:
    """Make the instance's resident and active rows match its limits. Held rows are never removed."""
    await tx.execute(
        """
        INSERT INTO capacity_slot (scope, scope_id, slot_number)
        SELECT budget.scope, hi.id::text, numbered.slot_number
        FROM harness_instance AS hi
        CROSS JOIN LATERAL (
            VALUES ('resident', hi.resident_session_limit), ('active', hi.active_turn_limit)
        ) AS budget (scope, slot_limit)
        CROSS JOIN LATERAL generate_series(0, budget.slot_limit - 1) AS numbered (slot_number)
        WHERE hi.id = %s::uuid
        ON CONFLICT (scope, scope_id, slot_number) DO NOTHING
        """,
        (instance_id,),
    )
    await tx.execute(
        """
        DELETE FROM capacity_slot AS cs
        USING harness_instance AS hi
        WHERE hi.id = %s::uuid
          AND cs.scope_id = hi.id::text
          AND cs.holder_provider_session_id IS NULL
          AND (
              (cs.scope = 'resident' AND cs.slot_number >= hi.resident_session_limit)
              OR (cs.scope = 'active' AND cs.slot_number >= hi.active_turn_limit)
          )
        """,
        (instance_id,),
    )


async def provision_provider_slots(tx: Transaction, provider: Provider) -> None:
    """Make the provider budget's rows match `provider_capacity.active_limit`. Held rows stay."""
    await tx.execute(
        """
        INSERT INTO capacity_slot (scope, scope_id, slot_number)
        SELECT 'provider', pc.provider, numbered.slot_number
        FROM provider_capacity AS pc
        CROSS JOIN LATERAL generate_series(0, pc.active_limit - 1) AS numbered (slot_number)
        WHERE pc.provider = %s
        ON CONFLICT (scope, scope_id, slot_number) DO NOTHING
        """,
        (provider,),
    )
    await tx.execute(
        """
        DELETE FROM capacity_slot AS cs
        USING provider_capacity AS pc
        WHERE pc.provider = %s
          AND cs.scope = 'provider'
          AND cs.scope_id = pc.provider
          AND cs.holder_provider_session_id IS NULL
          AND cs.slot_number >= pc.active_limit
        """,
        (provider,),
    )


def _budget(row: dict[str, Any], prefix: str) -> BudgetState:
    return BudgetState(
        limit=int(row[f"{prefix}limit"]),
        held=int(row[f"{prefix}held"]),
        held_above_limit=int(row[f"{prefix}held_above_limit"]),
        free_rows=int(row[f"{prefix}free_rows"]),
    )


def _instance(row: dict[str, Any]) -> InstanceCapacity:
    return InstanceCapacity(
        harness_instance_id=str(row["harness_instance_id"]),
        runtime_incarnation_id=str(row["runtime_incarnation_id"]),
        native_storage_unit_id=str(row["native_storage_unit_id"]),
        resident=_budget(row, "resident_"),
        active=_budget(row, "active_"),
    )
