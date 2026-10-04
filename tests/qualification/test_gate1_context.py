"""Live G1a context scenarios. The Compose attempt stays pending until captured inference exists."""

from __future__ import annotations

import pytest

from scripts.gate_coverage import run_gate1


@pytest.mark.qualification
def test_g1_context_has_no_captured_inference_without_a_bundle() -> None:
    report = run_gate1("xai", None)
    assert report.status != "validated"
    assert not report.g1a_complete and not report.g1b_complete
    assert any(item.startswith("g1_attempt_") for item in report.failed_criteria)
    assert report.captured_inference_count == 0 or "brain_absent" in report.failed_criteria
    assert report.compaction_inference_count == 0 or report.status == "invalidated"
