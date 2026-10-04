"""Gate coverage decisions. A missing live bundle stays pending. Nothing here writes a qualification row."""

from __future__ import annotations

from dataclasses import dataclass, field

from esp_contracts.ids import Provider
from esp_contracts.qualification import QualificationResult, RuntimeProfile


def _str_list() -> list[str]:
    return []

# Kept aligned with scripts.qualify.REQUIRED_G1_SCENARIOS. The unit test fails if they diverge.
G1_SCENARIOS: tuple[str, ...] = (
    "g1a_shared_main_process",
    "g1a_distinct_private_canaries",
    "g1a_mixed_brain_releases",
    "g1a_mixed_behavior_releases",
    "g1a_interleaved_requests",
    "g1a_interleaved_mcp",
    "g1a_repeated_turns",
    "g1a_multiple_tools",
    "g1a_native_retries",
    "g1a_automatic_compaction",
    "g1a_manual_compaction",
    "g1a_resume",
    "g1a_long_input",
    "g1a_absent_injection",
    "g1a_corrupt_block_rejected",
    "g1a_duplicate_block_rejected",
    "g1a_inert_pasted_markers",
    "g1a_stale_scopes",
    "g1a_disabled_auxiliary",
    "g1a_evidence_equality",
    "g1a_egress_denial",
    "g1b_owned_create",
    "g1b_conversation_saturation",
    "g1b_resident_saturation",
    "g1b_active_saturation",
    "g1b_provider_saturation",
    "g1b_rejected_input_not_executed_later",
    "g1b_presubmit_release",
    "g1b_ambiguous_acceptance_no_replay",
    "g1b_two_successive_messages",
    "g1b_peer_safe_cancel",
    "g1b_peer_safe_unload",
)

G2_SCENARIOS: tuple[str, ...] = (
    "g2_shared_process_kill",
    "g2_host_loss_storage_survives",
    "g2_control_partition",
    "g2_before_submit",
    "g2_lost_ack",
    "g2_complete_before_sql_clear",
    "g2_tools_and_compaction",
    "g2_browser_reconnect",
    "g2_authority_outage",
    "g2_idle_unload_reload",
    "g2_compatible_drain",
    "g2_rejected_input_not_later",
    "g2_reclaimed_memory",
    "g2_every_mapping_inventoried",
)


@dataclass
class Gate1Observation:
    """In-memory coverage input. It is not a deployment evidence bundle."""

    actual_main_process_count: int = 0
    max_overlapping_native_sessions: int = 0
    brain_versions: list[str] = field(default_factory=_str_list)
    brain_hashes: list[str] = field(default_factory=_str_list)
    behavior_versions: list[str] = field(default_factory=_str_list)
    captured_inference_count: int = 0
    compaction_inference_count: int = 0
    wrong_attributions: int = 0
    bypass_count: int = 0
    scenario_ids: list[str] = field(default_factory=_str_list)
    stub: bool = False
    same_brain_pair: bool = False


def evaluate_gate1(provider: Provider, observation: Gate1Observation) -> QualificationResult:
    """Pending unless every G1a and G1b scenario was observed on one real shared process."""
    missing = [item for item in G1_SCENARIOS if item not in set(observation.scenario_ids)]
    distinct_brains = len(set(observation.brain_hashes))
    safety_failure = observation.wrong_attributions > 0 or observation.bypass_count > 0
    complete = (
        not observation.stub
        and not observation.same_brain_pair
        and not safety_failure
        and observation.actual_main_process_count == 1
        and observation.max_overlapping_native_sessions >= 2
        and len(set(observation.brain_versions)) >= 2
        and distinct_brains >= 2
        and len(set(observation.behavior_versions)) >= 2
        and observation.captured_inference_count > 0
        and observation.compaction_inference_count > 0
        and not missing
    )
    if safety_failure:
        status = "invalidated"
    elif complete:
        status = "validated"
    else:
        status = "pending"
    return QualificationResult(
        provider=provider,
        gate="g1",
        status=status,
        g1a_complete=complete,
        g1b_complete=complete,
        actual_main_process_count=observation.actual_main_process_count,
        max_overlapping_native_sessions=observation.max_overlapping_native_sessions,
        brain_versions=list(observation.brain_versions),
        brain_hashes=list(observation.brain_hashes),
        behavior_versions=list(observation.behavior_versions),
        captured_inference_count=observation.captured_inference_count,
        compaction_inference_count=observation.compaction_inference_count,
        wrong_attributions=observation.wrong_attributions,
        bypass_count=observation.bypass_count,
        scenario_ids=list(observation.scenario_ids),
        positive_observation_count=observation.captured_inference_count,
        empty_evidence=not complete and not safety_failure,
        failed_criteria=(["safety_failure"] if safety_failure else missing),
        essential_absence=safety_failure,
    )


def run_gate1(provider: Provider, profile: RuntimeProfile | None = None) -> QualificationResult:
    """No recorded live bundle is loaded from disk. The candidate stays pending."""
    del profile
    return evaluate_gate1(provider, Gate1Observation())


@dataclass
class Gate2Observation:
    """In-memory G2 coverage. It is not a host-loss evidence bundle."""

    active_peers_before_fault: int = 0
    idle_peers_before_fault: int = 0
    all_affected_mappings_inventoried: bool = False
    native_ids_unchanged: bool = False
    positive_fence_receipt: bool = False
    maximum_volume_writers: int = 0
    completed_regenerations: int = 0
    cancelled_restarts: int = 0
    stale_mutations: int = 0
    cross_visitor_leaks: int = 0
    reclaimed_memory_bytes: int | None = None
    skipped_host_fault: bool = False
    single_session_resume: bool = False
    scenario_ids: list[str] = field(default_factory=_str_list)
    stub: bool = False


def evaluate_gate2(provider: Provider, observation: Gate2Observation) -> QualificationResult:
    """Pending unless every G2 fault was measured on a real shared process with surviving storage."""
    missing = [item for item in G2_SCENARIOS if item not in set(observation.scenario_ids)]
    safety_failure = (
        observation.stale_mutations > 0
        or observation.cross_visitor_leaks > 0
        or observation.completed_regenerations > 0
        or observation.cancelled_restarts > 0
    )
    measured_reclaim = observation.reclaimed_memory_bytes is not None and observation.reclaimed_memory_bytes >= 0
    complete = (
        not observation.stub
        and not observation.skipped_host_fault
        and not observation.single_session_resume
        and not safety_failure
        and measured_reclaim
        and observation.active_peers_before_fault >= 2
        and observation.idle_peers_before_fault >= 1
        and observation.all_affected_mappings_inventoried
        and observation.native_ids_unchanged
        and observation.positive_fence_receipt
        and observation.maximum_volume_writers == 1
        and not missing
    )
    if safety_failure:
        status = "invalidated"
    elif complete:
        status = "validated"
    else:
        status = "pending"
    failed = ["safety_failure"] if safety_failure else list(missing)
    if not safety_failure and not complete:
        if observation.single_session_resume:
            failed.append("single_session_resume")
        if observation.skipped_host_fault:
            failed.append("skipped_host_fault")
        if not measured_reclaim:
            failed.append("missing_reclaimed_memory")
    return QualificationResult(
        provider=provider,
        gate="g2",
        status=status,
        g2_complete=complete,
        functional_subgate_pass=complete,
        actual_main_process_count=1 if complete else 0,
        max_overlapping_native_sessions=observation.active_peers_before_fault,
        positive_observation_count=0,
        scenario_ids=list(observation.scenario_ids),
        empty_evidence=not complete and not safety_failure,
        failed_criteria=failed,
        essential_absence=safety_failure,
        skipped=observation.skipped_host_fault,
    )


def run_gate2(provider: Provider, profile: RuntimeProfile | None = None) -> QualificationResult:
    """No recorded host-loss bundle is loaded from disk. The candidate stays pending."""
    del profile
    return evaluate_gate2(provider, Gate2Observation())
