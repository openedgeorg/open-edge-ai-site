"""Live G1b admission scenarios. Pending until a recorded shared-process run exists."""

from __future__ import annotations

import pytest

from scripts.gate_coverage import G1_SCENARIOS, run_gate1


@pytest.mark.qualification
def test_g1b_scenarios_are_required_before_completion() -> None:
    report = run_gate1("openai", None)
    required = [item for item in G1_SCENARIOS if item.startswith("g1b_")]
    assert report.status == "pending"
    assert set(required).isdisjoint(report.scenario_ids)
