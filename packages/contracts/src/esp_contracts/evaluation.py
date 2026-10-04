"""Evaluation and release readiness. A synthetic fixture is not a published qualification."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from esp_contracts.api import STRICT

EvaluationCategory = Literal[
    "conceptual",
    "counterfactual",
    "misconception",
    "edge",
    "version_specific",
    "exact_factual",
    "retrieval",
]


class Grade(BaseModel):
    model_config = STRICT
    passed: bool
    missing_evidence: list[str]
    reviewer_ref: str | None = None
    rubric_ref: str | None = None


class ReadinessResult(BaseModel):
    model_config = STRICT
    ready: bool
    missing: list[str]
    invalid: list[str]
    stale: list[str]
    evidence_refs: list[str]


class NativeDeletionResult(BaseModel):
    """Deleted requires peer-safe evidence. Unsupported is an explicit failure."""

    model_config = STRICT
    status: Literal["deleted", "unsupported"]
    evidence_ref: str | None = None
    reason: str | None = None

    @model_validator(mode="after")
    def evidence_matches_status(self) -> NativeDeletionResult:
        if self.status == "deleted" and not self.evidence_ref:
            raise ValueError("deleted requires evidence")
        if self.status == "unsupported" and not self.reason:
            raise ValueError("unsupported requires a reason")
        return self


class ProductionConfig(BaseModel):
    """Every retention and identity field is explicit. Nothing defaults to an approved policy."""

    model_config = STRICT
    region: str = Field(min_length=1)
    encryption_owner: str = Field(min_length=1)
    key_owner: str = Field(min_length=1)
    runtime_identity: str = Field(min_length=1)
    web_identity: str = Field(min_length=1)
    knowledge_identity: str = Field(min_length=1)
    native_retention: str
    evidence_retention: str
    metadata_retention: str
    telemetry_retention: str
    backup_retention: str
    cookie_lifetime: str
    qualified_profile_refs: list[str]
    resident_limit: int = Field(ge=0)
    active_limit: int = Field(ge=0)
    deletion_required: bool
    deletion_supported: bool
    workload_digest: str = Field(min_length=1)
    transport_digest: str = Field(min_length=1)
    storage_profile: str = Field(min_length=1)
