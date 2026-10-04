"""Invented values and unsourced facts do not pass. The fixture is not approved domain content."""

from __future__ import annotations

import json
from pathlib import Path

from esp_contracts.runtime import HistoryItem
from knowledge.evals.grade import grade_answer
from knowledge.evals.schema import EvaluationCase

ROOT = Path(__file__).resolve().parents[2]


def _item(text: str) -> HistoryItem:
    return HistoryItem(
        native_item_id="item-1",
        native_work_ref=None,
        role="assistant",
        text=text,
        citations=[],
        assets=[],
        structured_data=[],
    )


def _case(**overrides: object) -> EvaluationCase:
    data: dict[str, object] = {
        "case_id": "case-1",
        "category": "exact_factual",
        "question": "What is the recorded value?",
        "required_concepts": [],
        "required_sources": ["src-1"],
        "retrieval_expected": False,
        "prohibited_claims": ["42"],
        "rubric_ref": "rubric-owner",
        "unavailable_value": False,
        "requires_source": True,
        "approved_domain_content": False,
    }
    data.update(overrides)
    return EvaluationCase.model_validate(data)


def test_fixture_cases_are_not_approved_domain_content() -> None:
    document = json.loads((ROOT / "tests" / "fixtures" / "evals" / "cases.json").read_text(encoding="utf-8"))
    assert document["cases"]
    assert all(case["approved_domain_content"] is False for case in document["cases"])


def test_invented_or_unsourced_answers_fail() -> None:
    invented = grade_answer(_item("The value is 42"), _case(unavailable_value=True))
    assert invented.passed is False
    assert "invented_unavailable_value" in invented.missing_evidence
    unsourced = grade_answer(_item("A sourced claim"), _case())
    assert unsourced.passed is False
    assert "factual_without_source" in unsourced.missing_evidence
