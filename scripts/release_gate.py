"""Match release evidence. This module does not publish or deploy."""

from __future__ import annotations

from esp_contracts.evaluation import ProductionConfig, ReadinessResult
from esp_contracts.qualification import AcceptanceBudgets, QualificationResult
from knowledge.evals.schema import EvaluationReport

_REQUIRED_GATES = ("g1", "g2", "da01", "privacy")


def evaluate_release_gate(
    qualifications: list[QualificationResult],
    evaluations: list[EvaluationReport],
    budgets: AcceptanceBudgets | None,
    config: ProductionConfig | None,
    *,
    workload_digest: str | None = None,
    transport_digest: str | None = None,
    storage_profile: str | None = None,
    unobserved_dispatches: int = 0,
    policy_approved: bool = False,
) -> ReadinessResult:
    missing: list[str] = []
    invalid: list[str] = []
    stale: list[str] = []
    by_provider: dict[str, set[str]] = {"openai": set(), "xai": set()}
    for item in qualifications:
        if item.status == "validated":
            by_provider.setdefault(item.provider, set()).add(item.gate)
    for provider, gates in by_provider.items():
        absent = [gate for gate in _REQUIRED_GATES if gate not in gates]
        if absent:
            missing.append(f"{provider}:{','.join(absent)}")
    reviewed = {item.provider for item in evaluations if item.content_reviewed and item.positive_inference_count > 0}
    if reviewed != {"openai", "xai"}:
        missing.append("both_provider_evaluations")
    if budgets is None or not budgets.approved:
        missing.append("approved_budgets")
    elif workload_digest is not None and workload_digest != budgets.workload:
        stale.append("changed_workload")
    if transport_digest is not None and (budgets is None or transport_digest != budgets.transport_digest):
        stale.append("changed_transport")
    if storage_profile is not None and (config is None or storage_profile != config.storage_profile):
        stale.append("changed_storage")
    if config is None or not policy_approved:
        missing.append("policy_approval")
    elif config.deletion_required and not config.deletion_supported:
        missing.append("deletion_unsupported")
    if unobserved_dispatches != 0:
        invalid.append("unobserved_dispatch")
    ready = not missing and not invalid and not stale
    return ReadinessResult(ready=ready, missing=missing, invalid=invalid, stale=stale, evidence_refs=[])


def run_release(milestone: str | None) -> int:
    """No complete G0–G4 bundle is recorded. The release gate stays blocked."""
    label = milestone or "unspecified"
    print("blocked")
    print(f"milestone={label} ready=false observations=0")
    return 2
