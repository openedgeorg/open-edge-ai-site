"""Live G2 host loss. This file is not part of the ordinary suite. No bundle is recorded in this tree."""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from esp_contracts.ids import Provider
from scripts.gate_coverage import run_gate2


@dataclass
class HostLossReport:
    active_peers_before_fault: int = 0
    idle_peers_before_fault: int = 0
    all_affected_mappings_inventoried: bool = False
    native_ids_before: list[str] = field(default_factory=list)
    native_ids_after: list[str] = field(default_factory=list)
    positive_fence_receipt: bool = False
    maximum_volume_writers: int = 0
    completed_regenerations: int = 0
    cancelled_restarts: int = 0
    stale_mutations: int = 0
    cross_visitor_leaks: int = 0


class LiveApplication:
    def __init__(self, provider: Provider = "openai") -> None:
        self.provider = provider

    async def kill_process_then_replace_host(self) -> HostLossReport:
        """No live process is killed. An empty gate stays pending and supplies no peer evidence."""
        pending = run_gate2(self.provider, None)
        assert pending.status == "pending"
        return HostLossReport()


@pytest.fixture
def live_application() -> LiveApplication:
    return LiveApplication("openai")


@pytest.mark.qualification
async def test_host_loss_reconciles_every_native_mapping(live_application: LiveApplication) -> None:
    report = await live_application.kill_process_then_replace_host()
    assert report.active_peers_before_fault >= 2 and report.idle_peers_before_fault >= 1
    assert report.all_affected_mappings_inventoried
    assert report.native_ids_after == report.native_ids_before
    assert report.positive_fence_receipt and report.maximum_volume_writers <= 1
    assert report.completed_regenerations == report.cancelled_restarts == 0
    assert report.stale_mutations == report.cross_visitor_leaks == 0
