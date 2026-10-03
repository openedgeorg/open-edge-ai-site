"""Isolated candidate admission versus public eligibility. Pure decisions; no I/O.

Qualification and evaluation run in an isolated deployment with an explicit, recorded, test-only
candidate policy. That policy may admit an allowlisted pending runtime profile and a non-production
release on the deployment's real application path. It never changes a qualification record and has
no public-eligibility field. Public eligibility is a separate decision that takes no policy at all:
it needs a released Brain and a matching validated runtime qualification record.

What these predicates do not decide, and every caller (Task 14's `ApiDependencies`) must compose:

- Registry withdrawal. Withdrawal is controlled registry selection metadata; immutable manifests are
  not rewritten, so a withdrawn release usually still reads `status != "withdrawn"` here. Resolve the
  release through `esp_espcon.brain_registry.BrainRegistry` and refuse a withdrawn selection
  (`BrainRegistry.publicly_eligible` and `resolve_release` already do) before calling either predicate.
- Deployment binding. `eligible` compares profile and content identities only; it does not know which
  deployment is running. The code that loads a candidate policy must refuse it unless
  `policy.deployment.cluster_uid` and `policy.deployment.deployment_ref` equal the running isolated
  deployment's own identity, so a policy loaded anywhere else admits nothing. `scripts/qualify.py`
  checks the cluster UID before it deploys or probes.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Literal

from pydantic import AwareDatetime, BaseModel, Field

from esp_contracts.api import STRICT
from esp_contracts.ids import Provider, Sha256, UuidStr
from esp_contracts.qualification import RuntimeProfile
from esp_contracts.release import ReleaseManifest

QUALIFICATION_ENVIRONMENT = "isolated-qualification"
QUALIFICATION_NAMESPACE = "esp-qualification"
CANDIDATE_POLICY_FORMAT = "esp-candidate-policy/1"
_DIGEST = r"^sha256:[0-9a-f]{64}$"
_SLUG = r"^qual-[a-z0-9]+(?:-[a-z0-9]+)*$"


class CandidateDeployment(BaseModel):
    """The one isolated deployment the policy applies to. It has no public ingress."""

    model_config = STRICT
    environment: Literal["isolated-qualification"]
    namespace: Literal["esp-qualification"]
    deployment_ref: str = Field(pattern=_SLUG, max_length=63)
    cluster_uid: UuidStr
    public_ingress: Literal[False]


class CandidateRuntime(BaseModel):
    """An exact runtime profile identity. Every digest must match; nothing is a prefix match."""

    model_config = STRICT
    provider: Provider
    model: str = Field(min_length=1)
    harness_build: str = Field(min_length=1)
    image_digest: str = Field(pattern=_DIGEST)
    configuration_digest: str = Field(pattern=_DIGEST)
    transport_digest: str = Field(min_length=1)
    storage_profile: str = Field(min_length=1)
    tool_policy_digest: str = Field(pattern=_DIGEST)


class CandidateContent(BaseModel):
    """An exact Brain, behavior and corpus identity."""

    model_config = STRICT
    brain_version: str = Field(min_length=1)
    canonical_brain_sha256: Sha256
    behavior_version: str = Field(min_length=1)
    behavior_sha256: Sha256
    corpus_release_id: str = Field(min_length=1)


class CandidateAdmissionPolicy(BaseModel):
    """Recorded test-only allowlist for one isolated qualification deployment.

    The data namespace holds that deployment's own data stores and the credential namespace its own
    credentials; both are qualification-only by construction of their names.
    """

    model_config = STRICT
    policy_format: Literal["esp-candidate-policy/1"]
    policy_id: str = Field(pattern=_SLUG, max_length=63)
    deployment: CandidateDeployment
    data_namespace: str = Field(pattern=r"^esp-qualification-data(?:-[a-z0-9]+)*$", max_length=63)
    credential_namespace: str = Field(pattern=r"^qualification/[a-z0-9]+(?:[/-][a-z0-9]+)*$")
    runtimes: list[CandidateRuntime] = Field(min_length=1)
    content: list[CandidateContent] = Field(min_length=1)
    recorded_by: str = Field(min_length=1)
    recorded_at: AwareDatetime


class RuntimeQualificationRecord(BaseModel):
    """One `runtime_qualification` row (P §17.5) as read from the primary database."""

    model_config = STRICT
    id: str = Field(min_length=1)
    design_assumption_id: Literal["DA-01"]
    provider: Provider
    harness_revision: str | None
    image_digest: str | None
    configuration_digest: str | None
    transport_digest: str | None
    storage_profile: str | None
    tool_policy_digest: str | None
    status: Literal["pending", "validated", "invalidated"]
    resident_session_limit: int | None
    active_turn_limit: int | None
    acceptance_budgets_ref: str | None
    evidence_bundle_ref: str | None
    failed_criteria: list[str]
    reviewed_by: str | None
    reviewed_at: datetime | None


def eligible(profile: RuntimeProfile, release: ReleaseManifest, policy: CandidateAdmissionPolicy) -> bool:
    """Whether the isolated deployment may admit this exact profile and release.

    Pending runtimes and draft or reviewed content are admissible when allowlisted. A manifest marked
    withdrawn is refused; registry withdrawal and the policy's deployment binding are the caller's to
    check (see the module docstring). The answer says nothing about public eligibility or qualification
    status.
    """
    if release.status == "withdrawn":
        return False
    runtime_allowed = any(_same_runtime(profile, runtime) for runtime in policy.runtimes)
    content_allowed = any(_same_content(release, content) for content in policy.content)
    return runtime_allowed and content_allowed


def publicly_eligible(
    profile: RuntimeProfile, release: ReleaseManifest, record: RuntimeQualificationRecord | None
) -> bool:
    """Public creation: a released Brain and a matching, reviewed, validated runtime qualification.

    There is deliberately no candidate-policy parameter, so no isolated allowlist can widen this.
    Registry withdrawal is the caller's to check first (see the module docstring).
    """
    if release.status != "production" or release.evaluation_ref is None or not release.qualification_refs:
        return False
    if record is None or record.status != "validated" or record.id not in release.qualification_refs:
        return False
    if record.failed_criteria or record.reviewed_by is None or record.reviewed_at is None:
        return False
    if record.evidence_bundle_ref is None or record.acceptance_budgets_ref is None:
        return False
    if record.resident_session_limit is None or record.active_turn_limit is None:
        return False
    return (
        record.provider == profile.provider
        and record.harness_revision == profile.harness_build
        and record.image_digest == profile.image_digest
        and record.configuration_digest == profile.configuration_digest
        and record.transport_digest == profile.transport_digest
        and record.storage_profile == profile.storage_profile
        and record.tool_policy_digest == profile.tool_policy_digest
    )


def policy_digest(policy: CandidateAdmissionPolicy) -> str:
    """Digest of the canonical policy JSON; the qualification result's allowlist identity."""
    canonical = json.dumps(policy.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode()).hexdigest()


def _same_runtime(profile: RuntimeProfile, runtime: CandidateRuntime) -> bool:
    return (
        profile.provider == runtime.provider
        and profile.model == runtime.model
        and profile.harness_build == runtime.harness_build
        and profile.image_digest == runtime.image_digest
        and profile.configuration_digest == runtime.configuration_digest
        and profile.transport_digest == runtime.transport_digest
        and profile.storage_profile == runtime.storage_profile
        and profile.tool_policy_digest == runtime.tool_policy_digest
    )


def _same_content(release: ReleaseManifest, content: CandidateContent) -> bool:
    return (
        release.brain_version == content.brain_version
        and release.canonical_brain_sha256 == content.canonical_brain_sha256
        and release.behavior_version == content.behavior_version
        and release.behavior_sha256 == content.behavior_sha256
        and release.corpus_release_id == content.corpus_release_id
    )
