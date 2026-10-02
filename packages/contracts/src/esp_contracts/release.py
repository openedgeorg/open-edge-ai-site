"""Immutable release identity. Artifact bytes live in the object store, not this model."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from esp_contracts.api import STRICT
from esp_contracts.ids import Sha256

ReleaseStatus = Literal["draft", "reviewed", "production", "withdrawn"]


class ReleaseManifest(BaseModel):
    model_config = STRICT
    brain_version: str = Field(min_length=1)
    canonical_brain_sha256: Sha256
    canonical_brain_bytes: int = Field(ge=0)
    behavior_version: str = Field(min_length=1)
    behavior_sha256: Sha256
    behavior_bytes: int = Field(ge=0)
    source_revision: str = Field(min_length=1)
    created_at: datetime
    status: ReleaseStatus
    brain_artifact_ref: str = Field(min_length=1)
    behavior_artifact_ref: str = Field(min_length=1)
    corpus_release_id: str = Field(min_length=1)
    evaluation_ref: str | None = None
    qualification_refs: list[str] = Field(default_factory=list)


class ReleaseError(Exception):
    """Fail-closed release resolution. The message is a stable machine code."""
