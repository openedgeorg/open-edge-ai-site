"""Owner cases and reports. approved_domain_content is never implied."""

from __future__ import annotations

from pydantic import BaseModel, Field

from esp_contracts.api import STRICT
from esp_contracts.evaluation import EvaluationCategory, Grade
from esp_contracts.ids import Provider


class EvaluationCase(BaseModel):
    model_config = STRICT
    case_id: str = Field(min_length=1)
    category: EvaluationCategory
    question: str = Field(min_length=1)
    required_concepts: list[str]
    required_sources: list[str]
    retrieval_expected: bool
    prohibited_claims: list[str]
    rubric_ref: str = Field(min_length=1)
    unavailable_value: bool
    requires_source: bool
    approved_domain_content: bool


class EvaluationReport(BaseModel):
    model_config = STRICT
    provider: Provider
    deployment_ref: str = Field(min_length=1)
    release_id: str = Field(min_length=1)
    content_reviewed: bool
    grades: list[Grade]
    missing_evidence: list[str]
    positive_inference_count: int = Field(ge=0)
