"""Deterministic evidence checks. There is no external judge and no model call."""

from __future__ import annotations

from esp_contracts.evaluation import Grade
from esp_contracts.runtime import HistoryItem
from knowledge.evals.schema import EvaluationCase


def grade_answer(item: HistoryItem, case: EvaluationCase) -> Grade:
    missing: list[str] = []
    if not case.approved_domain_content:
        missing.append("unreviewed_domain_content")
    if case.unavailable_value:
        for claim in case.prohibited_claims:
            if claim and claim in item.text:
                missing.append("invented_unavailable_value")
                break
    if case.requires_source and not item.citations:
        missing.append("factual_without_source")
    if case.retrieval_expected and not item.citations:
        missing.append("retrieval_not_observed")
    return Grade(passed=not missing, missing_evidence=missing, reviewer_ref=None, rubric_ref=case.rubric_ref)
