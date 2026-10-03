"""Isolated candidate policy lab. Every runtime/content value here is a synthetic test identity.

The lab records a pending runtime qualification in PostgreSQL, evaluates the recorded test-only
candidate policy on the same profile and release, and reads the qualification record back. It never
inserts or upgrades a validated record.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from esp_contracts.eligibility import RuntimeQualificationRecord, eligible, publicly_eligible
from esp_contracts.qualification import PrimitiveEvidence, RuntimeProfile
from esp_contracts.release import ReleaseManifest
from esp_db.client import Db
from esp_provider_openai.codex_adapter import CODEX_BUILD
from scripts.qualify import TOOL_POLICY_PATH, load_candidate_policy
from tests.support.release import FIXTURES, manifest_for

ROOT = Path(__file__).resolve().parents[2]
CODEX_CONFIG = ROOT / "infra" / "runtime" / "codex" / "config.toml"
CLUSTER_UID = "3f0c2f55-6b4e-4a8e-9a57-0d1f2e3c4b5a"


def _digest(body: bytes) -> str:
    return "sha256:" + hashlib.sha256(body).hexdigest()


def synthetic_profile(**overrides: object) -> RuntimeProfile:
    """A pending Codex candidate profile with synthetic image/transport identities."""
    base: dict[str, object] = {
        "provider": "openai",
        "model": "gpt-6-astra",
        "harness_build": CODEX_BUILD,
        "image_digest": _digest(b"test-only codex runtime image"),
        "configuration_digest": _digest(CODEX_CONFIG.read_bytes()),
        "transport_digest": _digest(b"test-only codex transport integration"),
        "storage_profile": "test-only/unqualified-native-volume",
        "tool_policy_digest": _digest(TOOL_POLICY_PATH.read_bytes()),
        "primitives": [PrimitiveEvidence(name="storage", state="unproven")],
    }
    base.update(overrides)
    return RuntimeProfile.model_validate(base)


def synthetic_release(**overrides: object) -> ReleaseManifest:
    brain = (FIXTURES / "release_a" / "canonical_brain.md").read_bytes()
    behavior = (FIXTURES / "release_a" / "behavior.md").read_bytes()
    manifest = manifest_for("qual-draft-a", brain, behavior)
    return manifest.model_copy(update=overrides)


def policy_document(profile: RuntimeProfile, release: ReleaseManifest, **overrides: object) -> dict[str, Any]:
    document: dict[str, Any] = {
        "policy_format": "esp-candidate-policy/1",
        "policy_id": "qual-policy-test-a",
        "deployment": {
            "environment": "isolated-qualification",
            "namespace": "esp-qualification",
            "deployment_ref": "qual-deployment-test-a",
            "cluster_uid": CLUSTER_UID,
            "public_ingress": False,
        },
        "data_namespace": "esp-qualification-data-test-a",
        "credential_namespace": "qualification/test-a",
        "runtimes": [
            {
                "provider": profile.provider,
                "model": profile.model,
                "harness_build": profile.harness_build,
                "image_digest": profile.image_digest,
                "configuration_digest": profile.configuration_digest,
                "transport_digest": profile.transport_digest,
                "storage_profile": profile.storage_profile,
                "tool_policy_digest": profile.tool_policy_digest,
            }
        ],
        "content": [
            {
                "brain_version": release.brain_version,
                "canonical_brain_sha256": release.canonical_brain_sha256,
                "behavior_version": release.behavior_version,
                "behavior_sha256": release.behavior_sha256,
                "corpus_release_id": release.corpus_release_id,
            }
        ],
        "recorded_by": "test-only-recorder",
        "recorded_at": "2026-10-03T00:00:00Z",
    }
    document.update(overrides)
    return document


class PolicyLab:
    """One pending candidate deployment in PostgreSQL plus its recorded isolated-candidate policy."""

    def __init__(self, db: Db, profile: RuntimeProfile, release: ReleaseManifest) -> None:
        self.db = db
        self.profile = profile
        self.release = release
        suffix = uuid.uuid4().hex[:12]
        self.qualification_id = f"test-qual-{suffix}"
        self.deployment_ref = f"qual-test-{suffix}"
        self.provider_session_id = str(uuid.uuid4())
        self.policy_bytes = json.dumps(policy_document(profile, release)).encode()

    async def record_pending_candidate(self) -> None:
        now = datetime.now(UTC)
        conversation_id = uuid.uuid4()
        async with self.db.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    INSERT INTO runtime_qualification (
                        id, design_assumption_id, provider, harness_revision, image_digest,
                        configuration_digest, transport_digest, storage_profile, tool_policy_digest, status
                    ) VALUES (%s, 'DA-01', %s, %s, %s, %s, %s, %s, %s, 'pending')
                    """,
                    (
                        self.qualification_id,
                        self.profile.provider,
                        self.profile.harness_build,
                        self.profile.image_digest,
                        self.profile.configuration_digest,
                        self.profile.transport_digest,
                        self.profile.storage_profile,
                        self.profile.tool_policy_digest,
                    ),
                )
                await connection.execute(
                    """
                    INSERT INTO provider_deployment (
                        id, provider, model, harness_revision, configuration_digest, gateway_route,
                        shared_process_qualification_id, deployed_at
                    ) VALUES (%s, %s, %s, %s, %s, 'openai-responses', %s, %s)
                    """,
                    (
                        self.deployment_ref,
                        self.profile.provider,
                        self.profile.model,
                        self.profile.harness_build,
                        self.profile.configuration_digest,
                        self.qualification_id,
                        now,
                    ),
                )
                await connection.execute(
                    """
                    INSERT INTO conversation (
                        id, owner_subject_id, provider, brain_release_id, behavior_version, behavior_hash,
                        corpus_release_id, status, created_at, updated_at
                    ) VALUES (%s, 'test-subject', %s, %s, %s, %s, %s, 'active', %s, %s)
                    """,
                    (
                        conversation_id,
                        self.profile.provider,
                        self.release.brain_version,
                        self.release.behavior_version,
                        self.release.behavior_sha256,
                        self.release.corpus_release_id,
                        now,
                        now,
                    ),
                )
                await connection.execute(
                    """
                    INSERT INTO provider_session (
                        id, conversation_id, provider, session_generation, is_current, brain_release_id,
                        brain_hash, behavior_version, behavior_hash, corpus_release_id, deployment_ref,
                        runtime_state, ownership_epoch, recovery_count, created_at, last_used_at
                    ) VALUES (%s, %s, %s, 1, true, %s, %s, %s, %s, %s, %s, 'warm_idle', 1, 0, %s, %s)
                    """,
                    (
                        self.provider_session_id,
                        conversation_id,
                        self.profile.provider,
                        self.release.brain_version,
                        self.release.canonical_brain_sha256,
                        self.release.behavior_version,
                        self.release.behavior_sha256,
                        self.release.corpus_release_id,
                        self.deployment_ref,
                        now,
                        now,
                    ),
                )

    def isolated_candidate_allowed(self) -> bool:
        policy = load_candidate_policy(self.policy_bytes)
        return eligible(self.profile, self.release, policy)

    async def same_candidate_publicly_allowed(self) -> bool:
        return publicly_eligible(self.profile, self.release, await self.qualification_record())

    async def qualification_record(self) -> RuntimeQualificationRecord | None:
        async with self.db.pool.connection() as connection:
            cursor = await connection.execute(
                """
                SELECT rq.id, rq.design_assumption_id, rq.provider, rq.harness_revision, rq.image_digest,
                       rq.configuration_digest, rq.transport_digest, rq.storage_profile, rq.tool_policy_digest,
                       rq.status, rq.resident_session_limit, rq.active_turn_limit, rq.acceptance_budgets_ref,
                       rq.evidence_bundle_ref, rq.failed_criteria, rq.reviewed_by, rq.reviewed_at
                FROM provider_deployment AS pd
                JOIN runtime_qualification AS rq ON rq.id = pd.shared_process_qualification_id
                WHERE pd.id = %s
                """,
                (self.deployment_ref,),
            )
            row = await cursor.fetchone()
        if row is None:
            return None
        return RuntimeQualificationRecord.model_validate(dict(row))

    async def qualification_status(self) -> str:
        record = await self.qualification_record()
        assert record is not None
        return record.status

    async def authority_qualification_status(self) -> str:
        async with self.db.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT qualification_status FROM current_authority WHERE provider_session_id = %s",
                (self.provider_session_id,),
            )
            row = await cursor.fetchone()
        assert row is not None
        return str(row["qualification_status"])
