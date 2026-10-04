"""A replacement without a positive fence is blocked. Recovery does not replay or drop the guard."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from esp_provider_shared.storage_fence import ContractStorageFence
from esp_recovery.group_recovery import GroupRecovery
from scripts.migrate import migrate
from tests.support.database import APP_DSN
from tests.support.submission import SubmissionLab, close_submission_lab, open_submission_lab


class RecoveryLab:
    def __init__(self, inner: SubmissionLab) -> None:
        self.inner = inner
        self.fence = ContractStorageFence()
        self.original_native_ids: list[str] = []
        self._instance_id = ""
        self._incarnation = ""
        self._unit = ""
        self._submits_at_start = 0

    async def prepare(self) -> None:
        first = await self.inner.conversation()
        second = await self.inner.conversation()
        await self.inner.submit(first, "recover-a")
        await self.inner.submit(second, "recover-b")
        mapping = await self.inner.mapping(first)
        assert mapping is not None
        self._instance_id = str(mapping["harness_instance_id"])
        self._incarnation = str(mapping["runtime_incarnation_id"])
        units = await self.inner._fetch(
            "SELECT native_storage_unit_id AS unit FROM harness_instance WHERE id = %s",
            (self._instance_id,),
        )
        self._unit = str(units[0]["unit"])
        rows = await self.inner._fetch(
            """
            SELECT native_session_id FROM provider_session
            WHERE harness_instance_id = %s AND is_current ORDER BY id
            """,
            (self._instance_id,),
        )
        self.original_native_ids = [str(row["native_session_id"]) for row in rows]
        self._submits_at_start = self.inner.cluster.work_calls()

    def _group(self) -> GroupRecovery:
        return GroupRecovery(self.inner.runtime().backend.db, self.fence)

    async def replace_without_positive_fence(self) -> str:
        result = await self._group().recover_instance(self._instance_id, self._incarnation)
        return result.status

    async def resumed_native_ids(self) -> list[str]:
        self.fence.observe_revocation(self._unit, self._incarnation, "evidence-recover-1")
        result = await self._group().recover_instance(self._instance_id, self._incarnation)
        return result.native_session_ids

    async def completed_regenerations(self) -> int:
        return self.inner.cluster.work_calls() - self._submits_at_start

    async def cancelled_continuations(self) -> int:
        await self.inner.execute(
            """
            UPDATE provider_session SET cancel_requested_at = transaction_timestamp()
            WHERE harness_instance_id = %s AND is_current
            """,
            (self._instance_id,),
        )
        result = await self._group().recover_instance(self._instance_id, self._incarnation)
        return sum(1 for decision in result.decisions if decision.action == "continue_saved")

    async def restarts_across_coordinator_restarts(self) -> int:
        await self._group().recover_instance(self._instance_id, self._incarnation)
        result = await self._group().recover_instance(self._instance_id, self._incarnation)
        return result.max_recovery_count

    async def guard_after_recovery_window_expiry(self) -> bool:
        await self.inner.execute(
            """
            UPDATE provider_session
            SET recovery_deadline_at = transaction_timestamp() - make_interval(secs => 1)
            WHERE harness_instance_id = %s AND is_current
            """,
            (self._instance_id,),
        )
        await self._group().recover_instance(self._instance_id, self._incarnation)
        rows = await self.inner._fetch(
            """
            SELECT c.active_provider_session_id AS guard
            FROM conversation AS c
            JOIN provider_session AS ps ON ps.conversation_id = c.id
            WHERE ps.harness_instance_id = %s AND ps.is_current
            """,
            (self._instance_id,),
        )
        return all(row["guard"] is not None for row in rows)


@pytest.fixture
async def recovery_lab(tmp_path: Path) -> AsyncIterator[RecoveryLab]:
    await migrate(APP_DSN)
    inner = await open_submission_lab(tmp_path, instances=[(8, 8)], provider_limit=8)
    lab = RecoveryLab(inner)
    try:
        await lab.prepare()
        yield lab
    finally:
        await close_submission_lab(inner)


async def test_recovery_never_replays_or_resets_budget(recovery_lab: RecoveryLab) -> None:
    assert await recovery_lab.replace_without_positive_fence() == "blocked"
    assert await recovery_lab.resumed_native_ids() == recovery_lab.original_native_ids
    assert await recovery_lab.completed_regenerations() == 0
    assert await recovery_lab.cancelled_continuations() == 0
    assert await recovery_lab.restarts_across_coordinator_restarts() <= 2
    assert await recovery_lab.guard_after_recovery_window_expiry()
