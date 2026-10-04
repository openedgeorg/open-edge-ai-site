"""Publication needs a review and both providers. Promotion does not move an old pin."""

from __future__ import annotations

import pytest

from esp_contracts.runtime import HistoryItem
from knowledge.evals.grade import grade_answer
from knowledge.evals.schema import EvaluationCase, EvaluationReport
from knowledge.release.prepare import promote_release, publish_release


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
        "unavailable_value": True,
        "requires_source": True,
        "approved_domain_content": False,
    }
    data.update(overrides)
    return EvaluationCase.model_validate(data)


def _report(provider: str) -> EvaluationReport:
    return EvaluationReport(
        provider=provider,  # type: ignore[arg-type]
        deployment_ref="dep",
        release_id="rel",
        content_reviewed=True,
        grades=[],
        missing_evidence=[],
        positive_inference_count=1,
    )


class PublicationLab:
    def __init__(self) -> None:
        self.original_pin = "brain-v1"
        self._pins = {"conv": self.original_pin}

    async def publish_without_review(self) -> bool:
        return publish_release("candidate", "", [_report("openai"), _report("xai")], [])

    async def publish_with_one_provider_report(self) -> bool:
        return publish_release("candidate", "review-1", [_report("openai")], ["qual-openai"])

    def grade_invented_unavailable_value(self):
        return grade_answer(_item("The value is 42"), _case())

    def grade_factual_without_source(self):
        return grade_answer(_item("A recorded fact"), _case(unavailable_value=False, prohibited_claims=[]))

    async def old_pin_after_promotion(self) -> str:
        pins = promote_release("rel-2", self._pins)
        return pins["conv"]


@pytest.fixture
def publication_lab() -> PublicationLab:
    return PublicationLab()


async def test_publication_requires_review_and_both_provider_matrix(publication_lab: PublicationLab) -> None:
    assert not await publication_lab.publish_without_review()
    assert not await publication_lab.publish_with_one_provider_report()
    assert not publication_lab.grade_invented_unavailable_value().passed
    assert not publication_lab.grade_factual_without_source().passed
    assert await publication_lab.old_pin_after_promotion() == publication_lab.original_pin
