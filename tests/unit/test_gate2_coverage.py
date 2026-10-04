"""G2 coverage fails closed. A single session, a skipped host fault, or no reclaim measurement is not a pass."""

from __future__ import annotations

from scripts.gate_coverage import G2_SCENARIOS, Gate2Observation, evaluate_gate2, run_gate2
from scripts.qualify import REQUIRED_G2_SCENARIOS


def _complete() -> Gate2Observation:
    return Gate2Observation(
        active_peers_before_fault=2,
        idle_peers_before_fault=1,
        all_affected_mappings_inventoried=True,
        native_ids_unchanged=True,
        positive_fence_receipt=True,
        maximum_volume_writers=1,
        reclaimed_memory_bytes=4096,
        scenario_ids=list(G2_SCENARIOS),
    )


def test_scenario_list_matches_the_qualify_contract() -> None:
    assert set(G2_SCENARIOS) == set(REQUIRED_G2_SCENARIOS)


def test_single_session_skipped_fault_or_missing_reclaim_stays_pending() -> None:
    single = _complete()
    single.single_session_resume = True
    single.active_peers_before_fault = 1
    decided = evaluate_gate2("openai", single)
    assert decided.status == "pending"
    assert not decided.g2_complete
    assert "single_session_resume" in decided.failed_criteria

    skipped = _complete()
    skipped.skipped_host_fault = True
    decided = evaluate_gate2("xai", skipped)
    assert decided.status == "pending"
    assert decided.skipped
    assert "skipped_host_fault" in decided.failed_criteria

    unmeasured = _complete()
    unmeasured.reclaimed_memory_bytes = None
    decided = evaluate_gate2("openai", unmeasured)
    assert decided.status == "pending"
    assert "missing_reclaimed_memory" in decided.failed_criteria


def test_isolation_failure_invalidates_and_live_command_has_no_bundle() -> None:
    leaked = _complete()
    leaked.cross_visitor_leaks = 1
    assert evaluate_gate2("openai", leaked).status == "invalidated"

    replayed = _complete()
    replayed.completed_regenerations = 1
    assert evaluate_gate2("xai", replayed).status == "invalidated"

    live = run_gate2("openai", None)
    assert live.status == "pending"
    assert live.empty_evidence
    assert not live.g2_complete
    assert not live.functional_subgate_pass
    assert live.positive_observation_count == 0


def test_complete_observation_is_a_functional_pass_only() -> None:
    decided = evaluate_gate2("openai", _complete())
    assert decided.status == "validated"
    assert decided.g2_complete
    assert decided.functional_subgate_pass
