"""Release readiness needs matching evidence. The synthetic fixture does not write a qualification row."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import psycopg

from esp_contracts.evaluation import ProductionConfig
from esp_contracts.qualification import AcceptanceBudgets, QualificationResult
from knowledge.evals.schema import EvaluationReport
from scripts.release_gate import evaluate_release_gate
from tests.support.database import APP_DSN

ROOT = Path(__file__).resolve().parents[2]
_DIGEST = "sha256:" + ("ab" * 32)


def _budgets(workload: str = "workload-1") -> AcceptanceBudgets:
    return AcceptanceBudgets(
        owner="owner",
        reviewed_at=datetime(2026, 1, 1, tzinfo=UTC),
        workload=workload,
        saved_session_target=2,
        resident_session_target=2,
        active_turn_target=1,
        provider_rpm=1,
        provider_tpm=1,
        memory_baseline_bytes=1,
        memory_increment_bytes=1,
        memory_peak_bytes=1,
        memory_reclamation_bytes=1,
        p95_admission_ms=1,
        p95_warm_ms=1,
        p95_restore_ms=1,
        p95_ttft_ms=1,
        rejection_objective="manual",
        recovery_objective="bounded",
        run_spend_ceiling="0",
        test_spend_ceiling="0",
        cost_per_completed_answer="0",
        prices_as_of=datetime(2026, 1, 1, tzinfo=UTC),
        recovery_headroom=1,
        transport_digest="transport-1",
        provider="openai",
        approved=True,
    )


def _config() -> ProductionConfig:
    return ProductionConfig(
        region="region-1",
        encryption_owner="owner",
        key_owner="owner",
        runtime_identity="esp-runtime",
        web_identity="esp-web",
        knowledge_identity="esp-knowledge",
        native_retention="30d",
        evidence_retention="365d",
        metadata_retention="30d",
        telemetry_retention="14d",
        backup_retention="30d",
        cookie_lifetime="12h",
        qualified_profile_refs=["profile-1"],
        resident_limit=2,
        active_limit=1,
        deletion_required=False,
        deletion_supported=False,
        workload_digest="workload-1",
        transport_digest="transport-1",
        storage_profile="storage-1",
    )


def _qualifications(xai_status: str = "validated") -> list[QualificationResult]:
    rows: list[QualificationResult] = []
    for provider in ("openai", "xai"):
        status = "validated" if provider == "openai" else xai_status
        for gate in ("g1", "g2", "da01", "privacy"):
            rows.append(QualificationResult(provider=provider, gate=gate, status=status))  # type: ignore[arg-type]
    return rows


def _reports() -> list[EvaluationReport]:
    return [
        EvaluationReport(
            provider=provider,  # type: ignore[arg-type]
            deployment_ref="dep",
            release_id="rel",
            content_reviewed=True,
            grades=[],
            missing_evidence=[],
            positive_inference_count=1,
        )
        for provider in ("openai", "xai")
    ]


class ReleaseCases:
    def one_pending_provider(self):
        return evaluate_release_gate(
            _qualifications("pending"),
            _reports(),
            _budgets(),
            _config(),
            workload_digest="workload-1",
            transport_digest="transport-1",
            storage_profile="storage-1",
            policy_approved=True,
        )

    def changed_workload_without_remeasure(self):
        return evaluate_release_gate(
            _qualifications(),
            _reports(),
            _budgets(),
            _config(),
            workload_digest="workload-2",
            transport_digest="transport-1",
            storage_profile="storage-1",
            policy_approved=True,
        )

    def changed_transport_or_storage(self):
        return evaluate_release_gate(
            _qualifications(),
            _reports(),
            _budgets(),
            _config(),
            workload_digest="workload-1",
            transport_digest="transport-2",
            storage_profile="storage-2",
            policy_approved=True,
        )

    def missing_policy_approval(self):
        return evaluate_release_gate(
            _qualifications(),
            _reports(),
            _budgets(),
            _config(),
            workload_digest="workload-1",
            transport_digest="transport-1",
            storage_profile="storage-1",
            policy_approved=False,
        )

    def nonzero_unobserved_dispatch(self):
        return evaluate_release_gate(
            _qualifications(),
            _reports(),
            _budgets(),
            _config(),
            workload_digest="workload-1",
            transport_digest="transport-1",
            storage_profile="storage-1",
            unobserved_dispatches=1,
            policy_approved=True,
        )

    def synthetic_complete_fixture(self):
        return evaluate_release_gate(
            _qualifications(),
            _reports(),
            _budgets(),
            _config(),
            workload_digest="workload-1",
            transport_digest="transport-1",
            storage_profile="storage-1",
            policy_approved=True,
        )


def test_readiness_needs_matching_complete_evidence() -> None:
    cases = ReleaseCases()
    before = _validated_rows()
    assert not cases.one_pending_provider().ready
    assert not cases.changed_workload_without_remeasure().ready
    assert not cases.changed_transport_or_storage().ready
    assert not cases.missing_policy_approval().ready
    assert not cases.nonzero_unobserved_dispatch().ready
    assert cases.synthetic_complete_fixture().ready
    assert _validated_rows() == before
    for name in ("openai", "xai"):
        candidate = json.loads((ROOT / "docs" / "qualification" / name / "candidate.json").read_text(encoding="utf-8"))
        assert candidate["status"] == "pending"


def _validated_rows() -> int:
    with psycopg.connect(APP_DSN, autocommit=True) as connection:
        row = connection.execute("SELECT count(*) FROM runtime_qualification WHERE status = 'validated'").fetchone()
    assert row is not None
    return int(row[0])
