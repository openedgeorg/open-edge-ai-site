"""Live capacity and DA-01. No approved budget is recorded, so both stay pending."""

from __future__ import annotations

import pytest

from esp_contracts.ids import Provider
from scripts.da01 import run_capacity, run_da01


@pytest.mark.qualification
def test_capacity_and_da01_have_no_approved_budget() -> None:
    providers: tuple[Provider, ...] = ("openai", "xai")
    for provider in providers:
        capacity = run_capacity(provider)
        decision = run_da01(provider)
        assert capacity.status == "pending"
        assert decision.status == "pending"
        assert capacity.empty_evidence and decision.empty_evidence
        assert "missing_budget" in capacity.failed_criteria
        assert "missing_budget" in decision.failed_criteria
