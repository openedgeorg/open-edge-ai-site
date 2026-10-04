"""Acceptance faults stay pending until a live run shows the rejected input never executes later."""

from __future__ import annotations

import pytest

from scripts.gate_coverage import G2_SCENARIOS, run_gate2


@pytest.mark.qualification
def test_rejected_input_fault_is_not_credited_without_a_bundle() -> None:
    report = run_gate2("openai", None)
    assert report.status == "pending"
    assert "g2_rejected_input_not_later" in G2_SCENARIOS
    assert "g2_rejected_input_not_later" not in report.scenario_ids
    assert report.empty_evidence
