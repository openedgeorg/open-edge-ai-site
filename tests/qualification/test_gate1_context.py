"""Live G1a context scenarios. Pending until captured inference evidence exists."""

from __future__ import annotations

import pytest

from scripts.gate_coverage import run_gate1


@pytest.mark.qualification
def test_g1_context_has_no_captured_inference_without_a_bundle() -> None:
    report = run_gate1("xai", None)
    assert report.captured_inference_count == 0
    assert report.compaction_inference_count == 0
    assert report.status == "pending"
