"""Live G1a/G1b on the Compose stack.

Full overlap, Brain and isolation are still required. No bundle is recorded in this tree.
"""

from __future__ import annotations

import pytest

from tests.support.live_application import LiveApplication


@pytest.fixture
def live_application() -> LiveApplication:
    return LiveApplication("openai")


@pytest.mark.qualification
async def test_real_gate1_has_positive_mixed_release_overlap(live_application: LiveApplication) -> None:
    result = await live_application.gate1()
    assert result.actual_main_process_count == 1
    assert result.max_overlapping_native_sessions >= 2
    assert len(result.brain_versions) >= 2 and len(result.brain_hashes) >= 2
    assert len(result.behavior_versions) >= 2
    assert result.captured_inference_count > 0
    assert result.compaction_inference_count > 0
    assert result.wrong_attributions == result.bypass_count == 0
    assert result.g1a_complete and result.g1b_complete
