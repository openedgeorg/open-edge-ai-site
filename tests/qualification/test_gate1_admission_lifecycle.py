"""Live G1b admission scenarios. Compose does not require a cluster, and a partial attempt is not a pass."""

from __future__ import annotations

import pytest

from scripts.gate_coverage import G1_SCENARIOS, run_gate1


@pytest.mark.qualification
def test_g1b_scenarios_are_required_before_completion() -> None:
    report = run_gate1("openai", None)
    required = [item for item in G1_SCENARIOS if item.startswith("g1b_")]
    assert report.status != "validated"
    assert not report.g1b_complete
    assert set(required).isdisjoint(report.scenario_ids)
    assert any(item.startswith("g1_attempt_") for item in report.failed_criteria)
