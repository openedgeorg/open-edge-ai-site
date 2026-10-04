"""DA-01 decisions. Missing budgets and missing measurements stay pending. Nothing here publishes."""

from __future__ import annotations

from typing import Literal

from esp_contracts.ids import Provider
from esp_contracts.qualification import (
    REQUIRED_DA01_CRITERIA,
    AcceptanceBudgets,
    CapacityReport,
    QualificationDecision,
    QualificationResult,
    Reviewer,
    RuntimeProfile,
)

_DIGEST = "sha256:" + ("0" * 64)


def measure_capacity(profile: RuntimeProfile, budgets: AcceptanceBudgets | None) -> CapacityReport:
    """Return an unmeasured report. Live samples are not invented from the budget sheet."""
    approved = False
    budgets_digest: str | None = None
    if budgets is not None:
        approved = bool(budgets.approved and budgets.reviewed_at.tzinfo is not None and budgets.owner)
        budgets_digest = budgets.transport_digest
    return CapacityReport(
        provider=profile.provider,
        measured=False,
        within_budget=None,
        preapproved=approved,
        transport_digest=profile.transport_digest,
        budgets_transport_digest=budgets_digest,
        criteria=[],
        published=False,
    )


def decide_da01(
    g1: QualificationResult,
    g2: QualificationResult,
    capacity: CapacityReport | None,
    reviewer: Reviewer | None,
) -> QualificationDecision:
    """Functional recovery without capacity, a budget, or a matching transport stays pending."""
    provider = g1.provider
    if capacity is None or not capacity.measured:
        return _decision(provider, "pending", ["missing_capacity"])
    if not capacity.preapproved:
        return _decision(provider, "pending", ["missing_preapproved_budget"])
    if not _digest_matches(capacity):
        return _decision(provider, "pending", ["changed_transport_digest"])
    if capacity.within_budget is False:
        return _decision(provider, "invalidated", ["capacity_failure"])
    authorized = (
        reviewer is not None and reviewer.role == "qualification_admin" and reviewer.reviewed_at.tzinfo is not None
    )
    evidence_complete = (
        g1.status == "validated"
        and g1.g1a_complete
        and g1.g1b_complete
        and g1.provider == provider
        and g2.status == "validated"
        and g2.g2_complete
        and g2.provider == provider
        and capacity.within_budget is True
        and authorized
        and set(REQUIRED_DA01_CRITERIA) <= set(capacity.criteria)
    )
    if not evidence_complete:
        return _decision(provider, "pending", ["incomplete_evidence"])
    return _decision(provider, "validated", [])


def run_capacity(provider: Provider) -> QualificationResult:
    """No approved budget file is loaded. The capacity gate stays pending."""
    return _pending(provider, "capacity")


def run_da01(provider: Provider) -> QualificationResult:
    """No live G1/G2 bundle and no approved budget. DA-01 stays pending."""
    return _pending(provider, "da01")


def _digest_matches(capacity: CapacityReport) -> bool:
    if capacity.transport_digest is None or capacity.budgets_transport_digest is None:
        return False
    return capacity.transport_digest == capacity.budgets_transport_digest


def _decision(
    provider: Provider,
    status: Literal["pending", "validated", "invalidated"],
    failed: list[str],
) -> QualificationDecision:
    validated = status == "validated"
    return QualificationDecision(
        provider=provider,
        status=status,
        qualifies_openai=validated and provider == "openai",
        qualifies_xai=validated and provider == "xai",
        failed_criteria=failed,
        published=False,
    )


def _pending(provider: Provider, gate: str) -> QualificationResult:
    return QualificationResult(
        provider=provider,
        gate=gate,
        status="pending",
        empty_evidence=True,
        failed_criteria=["missing_budget"],
        transport_integration_digest=_DIGEST,
    )
