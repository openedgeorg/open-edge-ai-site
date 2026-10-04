"""Residency credit requires a measured reclaim. A missing measurement stays pending."""

from __future__ import annotations

import pytest

from scripts.gate_coverage import Gate2Observation, evaluate_gate2


@pytest.mark.qualification
def test_missing_reclaimed_memory_is_not_a_pass() -> None:
    decided = evaluate_gate2("openai", Gate2Observation())
    assert decided.status == "pending"
    assert "missing_reclaimed_memory" in decided.failed_criteria
    assert decided.g2_complete is False
