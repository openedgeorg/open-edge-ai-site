"""Section 23 does not start on a functional gate, a fixture, one provider, or unreviewed content."""

from __future__ import annotations

import pytest

from esp_contracts.qualification import QualificationResult
from knowledge.evals.run import allowed_to_evaluate, section23_readiness
from knowledge.evals.schema import EvaluationReport


def _da01(provider: str, status: str = "validated") -> QualificationResult:
    return QualificationResult(provider=provider, gate="da01", status=status)  # type: ignore[arg-type]


def _g2(provider: str) -> QualificationResult:
    return QualificationResult(provider=provider, gate="g2", status="validated", g2_complete=True)  # type: ignore[arg-type]


def _report(provider: str, *, reviewed: bool) -> EvaluationReport:
    return EvaluationReport(
        provider=provider,  # type: ignore[arg-type]
        deployment_ref="dep",
        release_id="rel",
        content_reviewed=reviewed,
        grades=[],
        missing_evidence=[],
        positive_inference_count=1,
    )


class _View:
    def __init__(self, *, allowed_to_evaluate: bool, section23_ready: bool) -> None:
        self.allowed_to_evaluate = allowed_to_evaluate
        self.section23_ready = section23_ready


class EvalCases:
    def functional_g2_only(self) -> _View:
        return _View(allowed_to_evaluate=allowed_to_evaluate([_g2("openai")]), section23_ready=False)

    def fixture_smoke_only(self) -> _View:
        ready = section23_readiness([], [], content_reviewed=False).ready
        return _View(allowed_to_evaluate=False, section23_ready=ready)

    def one_provider_pending(self) -> _View:
        ready = section23_readiness(
            [_report("openai", reviewed=True)],
            [_da01("openai"), _da01("xai", "pending")],
            content_reviewed=True,
        ).ready
        return _View(allowed_to_evaluate=True, section23_ready=ready)

    def unreviewed_domain_content(self) -> _View:
        ready = section23_readiness(
            [_report("openai", reviewed=False), _report("xai", reviewed=False)],
            [_da01("openai"), _da01("xai")],
            content_reviewed=False,
        ).ready
        return _View(allowed_to_evaluate=True, section23_ready=ready)


@pytest.fixture
def eval_cases() -> EvalCases:
    return EvalCases()


def test_post_gate_evaluation_requires_actual_da01(eval_cases: EvalCases) -> None:
    assert not eval_cases.functional_g2_only().allowed_to_evaluate
    assert not eval_cases.fixture_smoke_only().section23_ready
    assert not eval_cases.one_provider_pending().section23_ready
    assert not eval_cases.unreviewed_domain_content().section23_ready
