"""Synthetic qualification cases. They are not live Gate 1 evidence."""

from __future__ import annotations

from dataclasses import dataclass

from esp_contracts.qualification import REQUIRED_DA01_CRITERIA, QualificationResult

EXPECTED_G1_SCENARIOS = frozenset(
    {
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
    }
)


def _result(provider: str = "openai", **overrides: object) -> QualificationResult:
    base: dict[str, object] = {
        "provider": provider,
        "gate": "inspect",
        "status": "pending",
        "scenario_ids": [],
        "positive_observation_count": 0,
    }
    base.update(overrides)
    return QualificationResult.model_validate(base)


@dataclass
class QualificationCases:
    expected_g1_scenarios: frozenset[str] = EXPECTED_G1_SCENARIOS
    expected_da01_criteria: tuple[str, ...] = REQUIRED_DA01_CRITERIA

    @property
    def missing_binary_skipped_empty_or_unproven(self) -> list[QualificationResult]:
        return [
            _result(harness_build=None, empty_evidence=True),
            _result(skipped=True, positive_observation_count=0),
            _result(empty_evidence=True, scenario_ids=["g1a_shared_main_process"]),
            _result(positive_observation_count=0, scenario_ids=sorted(EXPECTED_G1_SCENARIOS)),
        ]

    @property
    def essential_absent(self) -> QualificationResult:
        return _result(
            essential_absence=True,
            failed_criteria=["compaction"],
            status="invalidated",
            positive_observation_count=1,
        )

    @property
    def g2_only(self) -> QualificationResult:
        return _result(
            gate="g2",
            g2_complete=True,
            functional_subgate_pass=True,
            positive_observation_count=4,
            status="pending",
        )

    @property
    def synthetic_complete(self) -> QualificationResult:
        return _result(
            gate="da01",
            status="validated",
            g1a_complete=True,
            g1b_complete=True,
            g2_complete=True,
            functional_subgate_pass=True,
            positive_observation_count=8,
            scenario_ids=sorted(EXPECTED_G1_SCENARIOS),
            failed_criteria=[],
            review_owner="synthetic-reviewer",
            reviewer="synthetic-reviewer",
            evidence_bundle_ref="synthetic://not-production",
            acceptance_budgets_ref="synthetic://budgets",
            harness_build="synthetic",
            runtime_image_digest="synthetic",
            transport_integration_digest="synthetic",
            storage_profile="synthetic",
            tool_policy_digest="synthetic",
            configuration_digest="synthetic",
            environment_digest="synthetic",
            allowlist_digest="synthetic",
        )


def da01_criteria() -> tuple[str, ...]:
    return REQUIRED_DA01_CRITERIA
