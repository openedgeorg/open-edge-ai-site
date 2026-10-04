"""G1 coverage fails closed. A stub, a dropped scenario, or the same Brain twice is not a pass."""

from __future__ import annotations

from scripts.gate_coverage import G1_SCENARIOS, Gate1Observation, evaluate_gate1, run_gate1
from scripts.qualify import REQUIRED_G1_SCENARIOS


def _almost() -> Gate1Observation:
    return Gate1Observation(
        actual_main_process_count=1,
        max_overlapping_native_sessions=2,
        brain_versions=["brain-a", "brain-b"],
        brain_hashes=["a" * 64, "b" * 64],
        behavior_versions=["beh-a", "beh-b"],
        captured_inference_count=2,
        compaction_inference_count=1,
        scenario_ids=list(G1_SCENARIOS),
    )


def test_scenario_list_matches_the_qualify_contract() -> None:
    assert set(G1_SCENARIOS) == set(REQUIRED_G1_SCENARIOS)


def test_removed_scenario_or_same_brain_stays_pending() -> None:
    dropped = _almost()
    dropped.scenario_ids = dropped.scenario_ids[:-1]
    assert evaluate_gate1("openai", dropped).status == "pending"
    assert not evaluate_gate1("openai", dropped).g1a_complete

    same = _almost()
    same.same_brain_pair = True
    same.brain_hashes = ["a" * 64, "a" * 64]
    assert evaluate_gate1("xai", same).status == "pending"
    assert not evaluate_gate1("xai", same).g1b_complete

    stub = _almost()
    stub.stub = True
    assert evaluate_gate1("openai", stub).status == "pending"


def test_bypass_invalidates_and_live_command_has_no_bundle() -> None:
    leaked = _almost()
    leaked.bypass_count = 1
    assert evaluate_gate1("openai", leaked).status == "invalidated"
    live = run_gate1("openai", None)
    assert live.status == "pending"
    assert live.empty_evidence
    assert live.positive_observation_count == 0
    assert not live.g1a_complete
    assert not live.g1b_complete
