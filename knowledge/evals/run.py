"""Post-gate evaluation order. A pending runtime is not evaluated and no answer is invented."""

from __future__ import annotations

from esp_contracts.evaluation import ReadinessResult
from esp_contracts.ids import Provider
from esp_contracts.qualification import QualificationResult
from knowledge.evals.schema import EvaluationCase, EvaluationReport


def allowed_to_evaluate(qualifications: list[QualificationResult]) -> bool:
    """Formal evaluation needs a validated DA-01 record, not a functional G2 pass."""
    return any(item.gate == "da01" and item.status == "validated" for item in qualifications)


def section23_readiness(
    reports: list[EvaluationReport],
    qualifications: list[QualificationResult],
    *,
    content_reviewed: bool,
) -> ReadinessResult:
    missing: list[str] = []
    if not content_reviewed or any(not report.content_reviewed for report in reports):
        missing.append("unreviewed_domain_content")
    validated = {item.provider for item in qualifications if item.gate == "da01" and item.status == "validated"}
    if validated != {"openai", "xai"}:
        missing.append("both_provider_da01")
    if not reports or any(report.positive_inference_count <= 0 for report in reports):
        missing.append("evaluation_reports")
    return ReadinessResult(ready=not missing, missing=missing, invalid=[], stale=[], evidence_refs=[])


def run_evaluation(
    provider: Provider,
    deployment_ref: str,
    release_id: str,
    cases: list[EvaluationCase],
) -> EvaluationReport:
    """Refuse to invent answers. Live inference is not called from this process."""
    del cases
    return EvaluationReport(
        provider=provider,
        deployment_ref=deployment_ref,
        release_id=release_id,
        content_reviewed=False,
        grades=[],
        missing_evidence=["missing_da01", "missing_approved_content"],
        positive_inference_count=0,
    )
