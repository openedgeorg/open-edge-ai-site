"""Qualification records. A functional subgate pass is not a validated deployment."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from esp_contracts.api import STRICT
from esp_contracts.ids import Provider

PrimitiveState = Literal["proven", "absent", "unproven"]
GateName = Literal[
    "inspect",
    "network",
    "storage",
    "g1",
    "g2",
    "capacity",
    "da01",
    "privacy",
    "release",
]

REQUIRED_PRIMITIVES: tuple[str, ...] = (
    "create",
    "resume",
    "unload",
    "acceptance",
    "status",
    "history",
    "cancel",
    "model_context_hook",
    "mcp_context_hook",
    "compaction",
    "auxiliary_title",
    "auxiliary_summary",
    "auxiliary_memory",
    "auxiliary_warmup",
    "auxiliary_model_list",
    "auxiliary_subagent",
    "storage",
    "tool_policy",
)

# §12.14 areas. A nonempty inventory is required before a gate can pass.
REQUIRED_DA01_CRITERIA: tuple[str, ...] = (
    "multiple_sessions",
    "parallel_runs",
    "immediate_admission",
    "request_scoped_identity",
    "privacy_isolation",
    "bounded_residency",
    "native_persistence",
    "native_history_binding",
    "group_crash_recovery",
    "capacity_and_cost",
    "release_compatibility",
)


class PrimitiveEvidence(BaseModel):
    model_config = STRICT
    name: str = Field(min_length=1)
    state: PrimitiveState
    evidence_ref: str | None = None


class RuntimeProfile(BaseModel):
    model_config = STRICT
    provider: Provider
    model: str = Field(min_length=1)
    model_snapshot: str | None = None
    context_limit_tokens: int | None = Field(default=None, ge=1)
    harness_build: str = Field(min_length=1)
    image_digest: str = Field(min_length=1)
    configuration_digest: str = Field(min_length=1)
    transport_digest: str = Field(min_length=1)
    storage_profile: str = Field(min_length=1)
    tool_policy_digest: str = Field(min_length=1)
    primitives: list[PrimitiveEvidence]


class CapabilityReport(BaseModel):
    model_config = STRICT
    provider: Provider
    profile: RuntimeProfile | None
    installed_version: str | None = None
    primitives: list[PrimitiveEvidence]
    notes: list[str] = Field(default_factory=list)


class QualificationResult(BaseModel):
    model_config = STRICT
    design_assumption: Literal["DA-01"] = "DA-01"
    provider: Provider
    gate: str
    harness_build: str | None = None
    runtime_image_digest: str | None = None
    transport_integration_digest: str | None = None
    storage_profile: str | None = None
    tool_policy_digest: str | None = None
    configuration_digest: str | None = None
    status: Literal["pending", "validated", "invalidated"]
    functional_subgate_pass: bool = False
    validated_resident_session_limit: int | None = None
    validated_active_turn_limit: int | None = None
    acceptance_budgets_ref: str | None = None
    evidence_bundle_ref: str | None = None
    failed_criteria: list[str] = Field(default_factory=list)
    review_owner: str | None = None
    reviewed_at: datetime | None = None
    reviewer: str | None = None
    scenario_ids: list[str] = Field(default_factory=list)
    positive_observation_count: int = 0
    overlapping_native_identities: int = 0
    environment_digest: str | None = None
    allowlist_digest: str | None = None
    model_digest: str | None = None
    gateway_digest: str | None = None
    adapter_digest: str | None = None
    g1a_complete: bool = False
    g1b_complete: bool = False
    g2_complete: bool = False
    actual_main_process_count: int = 0
    max_overlapping_native_sessions: int = 0
    brain_versions: list[str] = Field(default_factory=list)
    brain_hashes: list[str] = Field(default_factory=list)
    behavior_versions: list[str] = Field(default_factory=list)
    captured_inference_count: int = 0
    compaction_inference_count: int = 0
    wrong_attributions: int = 0
    bypass_count: int = 0
    essential_absence: bool = False
    skipped: bool = False
    empty_evidence: bool = False
