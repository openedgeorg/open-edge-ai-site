"""Owned ESP Conversation (EspCon) creation with an immutable provider and release pins.

Creation records the visitor's provider choice and pins the selected Brain release, its separately
pinned behavior and its corpus. It allocates nothing native. The deployment and model are pinned at
first admission, inside the reservation transaction (`select_admission_pins`); native setup then
consumes those pins unchanged.

Eligibility composes three authorities and trusts none of them alone:

- the Brain Registry selection: registry withdrawal is selection metadata, so the release is always
  resolved through `BrainRegistry.resolve_release`, which refuses a withdrawn selection;
- the Application Database `brain_release` row, which the fenced withdrawal path
  (`esp_execution_bindings.dispatch_fence.withdraw_release`) changes;
- the deployment's actual qualification reference, `provider_deployment.shared_process_qualification_id`
  to `runtime_qualification`, compared with the exact running profile. A deployment has no status of
  its own.

Public eligibility then needs a released Brain and a matching validated record
(`esp_contracts.eligibility.publicly_eligible`). Only an isolated qualification deployment holds a
candidate policy; that recorded test-only policy may admit allowlisted pending candidates
(`esp_contracts.eligibility.eligible`), never an invalidated one, and changes no record.

Ineligible and unavailable are different answers. `ConversationIneligible` means an authority answered
no: the release is withdrawn, unselected, absent or does not match its hashes, or the deployment does not
qualify. `ReleaseStoreUnavailable` means the release store could not be read, so eligibility is unknown;
callers answer `503 service_unavailable` (retryable) and never report the provider ineligible.

Serialization. The eligibility reads are plain reads under READ COMMITTED. `esp_app` holds only SELECT
on `brain_release` and `runtime_qualification`, so it cannot lock those rows, and `withdraw_release` and
`disable_profile` fence only current mappings that already have an incarnation. A creation, or a first
admission, that races a withdrawal or invalidation can therefore commit against eligibility that was
withdrawn concurrently. That is not a safety gap: dispatch-time authorization is the backstop.
`with_dispatch_authority` takes the shared dispatch fences and rereads the release and profile status
(`authorize.assert_dispatchable`) before any provider request, and a mapping without an incarnation
cannot dispatch until native setup gives it one. Creation and admission only decline early.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from esp_contracts.api import STRICT, ConversationView, ProviderOption
from esp_contracts.eligibility import (
    CandidateAdmissionPolicy,
    RuntimeQualificationRecord,
    eligible,
    publicly_eligible,
)
from esp_contracts.ids import HarnessName, Provider, Sha256, UuidStr, new_id
from esp_contracts.qualification import RuntimeProfile
from esp_contracts.release import ReleaseError
from esp_db.client import Db, Transaction, transaction
from esp_espcon.brain_registry import BrainRegistry, ResolvedRelease

HARNESS_FOR_PROVIDER: Mapping[Provider, HarnessName] = {"openai": "codex", "xai": "grok-build"}
PROVIDER_ORDER: tuple[Provider, ...] = ("openai", "xai")
LIST_LIMIT = 100
SUBJECT_MAX_LENGTH = 128

EligibilityReason = Literal[
    "provider_not_configured",
    "release_withdrawn",
    "release_unavailable",
    "release_unrecorded",
    "release_mismatch",
    "deployment_missing",
    "deployment_mismatch",
    "qualification_missing",
    "qualification_invalidated",
    "profile_mismatch",
    "not_allowlisted",
    "not_publicly_eligible",
    "pin_mismatch",
    "conversation_closed",
]

_VIEW_COLUMNS = """
    c.id::text AS id, c.provider, c.brain_release_id, c.behavior_version, c.corpus_release_id, c.status,
    ps.model, ps.runtime_state, ps.active_agent_run_id::text AS active_agent_run_id
"""
_QUALIFICATION_COLUMNS = """
    id, design_assumption_id, provider, harness_revision, image_digest, configuration_digest,
    transport_digest, storage_profile, tool_policy_digest, status, resident_session_limit,
    active_turn_limit, acceptance_budgets_ref, evidence_bundle_ref, failed_criteria, reviewed_by, reviewed_at
"""


class ConfiguredRuntime(BaseModel):
    """The exact runtime profile one provider pool runs, and the deployment record it runs under."""

    model_config = STRICT
    provider: Provider
    deployment_ref: str = Field(min_length=1)
    profile: RuntimeProfile

    @model_validator(mode="after")
    def _profile_is_this_provider(self) -> ConfiguredRuntime:
        if self.profile.provider != self.provider:
            raise ValueError("runtime profile provider differs from the configured provider")
        return self


class ProviderEligibility(BaseModel):
    """An internal decision. The reason is for operators and tests, never for the browser."""

    model_config = STRICT
    provider: Provider
    eligible: bool
    reason: EligibilityReason | None
    deployment_ref: str | None
    model: str | None

    @model_validator(mode="after")
    def _consistent(self) -> ProviderEligibility:
        selected = self.deployment_ref is not None and self.model is not None
        if self.eligible != (self.reason is None) or self.eligible != selected:
            raise ValueError("an eligible decision names a deployment and model and no refusal reason")
        return self


class AdmissionPins(BaseModel):
    """Every pin first admission writes on the initial mapping. Native setup consumes them unchanged."""

    model_config = STRICT
    conversation_id: UuidStr
    provider: Provider
    deployment_ref: str = Field(min_length=1)
    model: str = Field(min_length=1)
    brain_release_id: str = Field(min_length=1)
    brain_hash: Sha256
    behavior_version: str = Field(min_length=1)
    behavior_hash: Sha256
    corpus_release_id: str = Field(min_length=1)


class ConversationNotFound(Exception):
    """Absent or owned by another subject. Callers must not distinguish the two."""


class ConversationIneligible(Exception):
    """An authority answered no. Permanent for this release and deployment; not retryable."""

    def __init__(self, provider: Provider, reason: EligibilityReason) -> None:
        super().__init__(reason)
        self.provider: Provider = provider
        self.reason: EligibilityReason = reason


class ReleaseStoreUnavailable(Exception):
    """The Brain Registry or its object store could not be read, so eligibility is unknown.

    A bound service that cannot be established: callers answer `503 service_unavailable` with
    `retryable:true`, on creation, on `/providers` and on admission. `code` is a stable machine code
    (`ReleaseError` code or `release_store_io_error`), never exception text.
    """

    def __init__(self, provider: Provider, code: str) -> None:
        super().__init__(code)
        self.provider: Provider = provider
        self.code = code


# The release authority's own answers about one release: withdrawn, unselected, absent, or not the
# immutable bytes its manifest names. Every other failure (`object_store_unavailable`, an I/O error
# or a code this module does not classify) means the answer could not be read.
_RELEASE_REFUSALS: frozenset[str] = frozenset(
    {
        "release_withdrawn",
        "release_unavailable",
        "release_id_invalid",
        "object_unavailable",
        "object_version_mismatch",
        "object_key_invalid",
        "artifact_reference_invalid",
        "pinned_brain_unavailable",
        "pinned_behavior_unavailable",
        "artifact_hash_mismatch",
    }
)


class ConversationService:
    """Ownership and pinning over the Application Database and the Brain Registry. No native I/O."""

    def __init__(
        self,
        db: Db,
        registry: BrainRegistry,
        *,
        release_id: str,
        runtimes: Mapping[Provider, ConfiguredRuntime],
        candidate_policy: CandidateAdmissionPolicy | None,
    ) -> None:
        for provider, runtime in runtimes.items():
            if runtime.provider != provider:
                raise ValueError("runtime registered under another provider")
        self._db = db
        self._registry = registry
        self._release_id = release_id
        self._runtimes = dict(runtimes)
        self._policy = candidate_policy

    async def create_conversation(self, subject_id: str, provider: Provider) -> ConversationView:
        """Pin the provider and the selected release for `subject_id`. Allocates no native session."""
        _require_subject(subject_id)
        release = await self._resolve(provider, self._release_id)
        manifest = release.manifest
        async with transaction(self._db) as tx:
            decision = await self._decide(tx, provider, release)
            if decision.reason is not None:
                raise ConversationIneligible(provider, decision.reason)
            row = await tx.execute_one(
                """
                INSERT INTO conversation (
                    id, owner_subject_id, provider, brain_release_id, behavior_version, behavior_hash,
                    corpus_release_id, status, created_at, updated_at
                ) VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, 'active', transaction_timestamp(), transaction_timestamp())
                RETURNING id::text AS id, provider, brain_release_id, behavior_version, corpus_release_id, status,
                          NULL::text AS model, NULL::text AS runtime_state, NULL::text AS active_agent_run_id
                """,
                (
                    new_id(),
                    subject_id,
                    provider,
                    release.release_id,
                    manifest.behavior_version,
                    manifest.behavior_sha256,
                    manifest.corpus_release_id,
                ),
            )
        if row is None:
            raise RuntimeError("conversation insert returned no row")
        return _view(row)

    async def list_eligible_providers(self) -> list[ProviderOption]:
        """One option per configured provider: eligibility for new conversations plus current health."""
        options: list[ProviderOption] = []
        for provider in PROVIDER_ORDER:
            runtime = self._runtimes.get(provider)
            if runtime is None:
                continue
            decision = await self.eligibility(provider)
            available = decision.eligible and await self._available(provider, decision.deployment_ref)
            options.append(
                ProviderOption(
                    provider=provider,
                    harness=HARNESS_FOR_PROVIDER[provider],
                    display_model=runtime.profile.model,
                    eligible=decision.eligible,
                    available=available,
                )
            )
        return options

    async def get_conversation(self, subject_id: str, conversation_id: str) -> ConversationView:
        _require_subject(subject_id)
        normalized = _uuid_or_none(conversation_id)
        if normalized is None:
            raise ConversationNotFound(conversation_id)
        async with transaction(self._db) as tx:
            row = await tx.execute_one(
                f"""
                SELECT {_VIEW_COLUMNS}
                FROM conversation AS c
                LEFT JOIN provider_session AS ps ON ps.conversation_id = c.id AND ps.is_current
                WHERE c.id = %s::uuid AND c.owner_subject_id = %s
                """,  # noqa: S608
                (normalized, subject_id),
            )
        if row is None:
            raise ConversationNotFound(conversation_id)
        return _view(row)

    async def list_conversations(self, subject_id: str) -> list[ConversationView]:
        """The caller's most recent conversations, newest first, bounded to `LIST_LIMIT`."""
        _require_subject(subject_id)
        async with transaction(self._db) as tx:
            rows = await tx.execute(
                f"""
                SELECT {_VIEW_COLUMNS}
                FROM conversation AS c
                LEFT JOIN provider_session AS ps ON ps.conversation_id = c.id AND ps.is_current
                WHERE c.owner_subject_id = %s
                ORDER BY c.created_at DESC, c.id
                LIMIT %s
                """,  # noqa: S608
                (subject_id, LIST_LIMIT),
            )
        return [_view(row) for row in rows]

    async def eligibility(self, provider: Provider) -> ProviderEligibility:
        """Whether a new conversation on `provider` may pin the currently selected release.

        Raises `ReleaseStoreUnavailable` when the release store cannot be read: unknown is not refused.
        """
        try:
            release = await self._resolve(provider, self._release_id)
        except ConversationIneligible as exc:
            return _refused(provider, exc.reason)
        async with transaction(self._db) as tx:
            return await self._decide(tx, provider, release)

    async def resolve_pinned_release(self, conversation_id: str) -> ResolvedRelease:
        """Resolve a conversation's own pinned release, before any reservation transaction opens.

        Object-store reads happen here, outside the transaction. A withdrawn or substituted release
        is refused (`ConversationIneligible`); nothing falls back to the currently selected release.
        A release store that cannot be read raises `ReleaseStoreUnavailable`, which admission reports
        as `service_unavailable`, never as ineligibility.
        """
        normalized = _uuid_or_none(conversation_id)
        if normalized is None:
            raise ConversationNotFound(conversation_id)
        async with transaction(self._db) as tx:
            row = await _pinned_row(tx, normalized)
        if row is None:
            raise ConversationNotFound(conversation_id)
        provider = _provider(row["provider"])
        release = await self._resolve(provider, str(row["brain_release_id"]))
        if not _same_pins(row, release):
            raise ConversationIneligible(provider, "pin_mismatch")
        return release

    async def select_admission_pins(
        self, tx: Transaction, conversation_id: str, release: ResolvedRelease
    ) -> AdmissionPins:
        """Select the matching eligible deployment and model inside the caller's reservation transaction.

        No remote I/O: `release` comes from `resolve_pinned_release`. Database eligibility is read
        again here so a withdrawal or invalidation committed since creation refuses admission.

        These reads are not serialized against a concurrent withdrawal or invalidation (see the module
        docstring); dispatch-time authorization under the dispatch fence is the backstop. If admission
        must itself commit only against current eligibility, the caller has to serialize with the
        eligibility mutations, for example a release- and qualification-scoped `esp_try_fence` taken
        exclusive by `withdraw_release`/`disable_profile` and shared here. That fence does not exist yet.
        """
        normalized = _uuid_or_none(conversation_id)
        if normalized is None:
            raise ConversationNotFound(conversation_id)
        row = await _pinned_row(tx, normalized)
        if row is None:
            raise ConversationNotFound(conversation_id)
        provider = _provider(row["provider"])
        if row["status"] != "active":
            raise ConversationIneligible(provider, "conversation_closed")
        if not _same_pins(row, release):
            raise ConversationIneligible(provider, "pin_mismatch")
        decision = await self._decide(tx, provider, release)
        if decision.reason is not None:
            raise ConversationIneligible(provider, decision.reason)
        if decision.deployment_ref is None or decision.model is None:
            raise RuntimeError("an eligible decision names its deployment and model")
        manifest = release.manifest
        return AdmissionPins(
            conversation_id=normalized,
            provider=provider,
            deployment_ref=decision.deployment_ref,
            model=decision.model,
            brain_release_id=release.release_id,
            brain_hash=manifest.canonical_brain_sha256,
            behavior_version=manifest.behavior_version,
            behavior_hash=manifest.behavior_sha256,
            corpus_release_id=manifest.corpus_release_id,
        )

    async def _resolve(self, provider: Provider, release_id: str) -> ResolvedRelease:
        """Resolve through the registry, classifying a refusal apart from an unreadable store."""
        try:
            return await self._registry.resolve_release(release_id)
        except ReleaseError as exc:
            code = exc.args[0] if exc.args and isinstance(exc.args[0], str) else "release_error_uncoded"
            if code not in _RELEASE_REFUSALS:
                raise ReleaseStoreUnavailable(provider, code) from exc
            raise ConversationIneligible(
                provider, "release_withdrawn" if code == "release_withdrawn" else "release_unavailable"
            ) from exc
        except OSError as exc:
            raise ReleaseStoreUnavailable(provider, "release_store_io_error") from exc

    async def _decide(self, tx: Transaction, provider: Provider, release: ResolvedRelease) -> ProviderEligibility:
        runtime = self._runtimes.get(provider)
        if runtime is None:
            return _refused(provider, "provider_not_configured")
        manifest = release.manifest
        recorded = await tx.execute_one(
            """
            SELECT status, sha256, behavior_version, behavior_sha256, corpus_release_id
            FROM brain_release WHERE version = %s
            """,
            (release.release_id,),
        )
        if recorded is None:
            return _refused(provider, "release_unrecorded")
        if recorded["status"] == "withdrawn" or manifest.status == "withdrawn":
            return _refused(provider, "release_withdrawn")
        if (
            recorded["sha256"] != manifest.canonical_brain_sha256
            or recorded["behavior_version"] != manifest.behavior_version
            or recorded["behavior_sha256"] != manifest.behavior_sha256
            or recorded["corpus_release_id"] != manifest.corpus_release_id
        ):
            return _refused(provider, "release_mismatch")
        profile = runtime.profile
        deployment = await tx.execute_one(
            """
            SELECT provider, model, harness_revision, configuration_digest, shared_process_qualification_id
            FROM provider_deployment WHERE id = %s
            """,
            (runtime.deployment_ref,),
        )
        if deployment is None:
            return _refused(provider, "deployment_missing")
        if (
            deployment["provider"] != provider
            or deployment["model"] != profile.model
            or deployment["harness_revision"] != profile.harness_build
            or deployment["configuration_digest"] != profile.configuration_digest
        ):
            return _refused(provider, "deployment_mismatch")
        record = await _qualification(tx, deployment["shared_process_qualification_id"])
        if record is None:
            return _refused(provider, "qualification_missing")
        if record.status == "invalidated":
            return _refused(provider, "qualification_invalidated")
        if self._policy is None:
            if recorded["status"] != "production" or not publicly_eligible(profile, manifest, record):
                return _refused(provider, "not_publicly_eligible")
        else:
            if not _record_matches_profile(record, profile):
                return _refused(provider, "profile_mismatch")
            if not eligible(profile, manifest, self._policy):
                return _refused(provider, "not_allowlisted")
        return ProviderEligibility(
            provider=provider,
            eligible=True,
            reason=None,
            deployment_ref=runtime.deployment_ref,
            model=profile.model,
        )

    async def _available(self, provider: Provider, deployment_ref: str | None) -> bool:
        """Healthy provider capacity and a ready instance on the eligible deployment. Not a reservation."""
        if deployment_ref is None:
            return False
        async with transaction(self._db) as tx:
            row = await tx.execute_one(
                """
                SELECT
                    EXISTS (
                        SELECT 1 FROM provider_capacity
                        WHERE provider = %s AND healthy AND active_limit > 0
                    ) AS provider_healthy,
                    EXISTS (
                        SELECT 1 FROM harness_instance
                        WHERE provider = %s AND deployment_ref = %s AND lifecycle_status = 'ready'
                    ) AS instance_ready
                """,
                (provider, provider, deployment_ref),
            )
        return row is not None and row["provider_healthy"] is True and row["instance_ready"] is True


async def _pinned_row(tx: Transaction, conversation_id: str) -> dict[str, Any] | None:
    return await tx.execute_one(
        """
        SELECT provider, brain_release_id, behavior_version, behavior_hash, corpus_release_id, status
        FROM conversation WHERE id = %s::uuid
        """,
        (conversation_id,),
    )


async def _qualification(tx: Transaction, qualification_id: object) -> RuntimeQualificationRecord | None:
    if not isinstance(qualification_id, str):
        return None
    row = await tx.execute_one(
        f"SELECT {_QUALIFICATION_COLUMNS} FROM runtime_qualification WHERE id = %s",  # noqa: S608
        (qualification_id,),
    )
    if row is None:
        return None
    return RuntimeQualificationRecord.model_validate(row)


def _record_matches_profile(record: RuntimeQualificationRecord, profile: RuntimeProfile) -> bool:
    """A recorded digest that differs from the running profile refuses; an unrecorded one does not."""
    if record.provider != profile.provider:
        return False
    pairs = (
        (record.harness_revision, profile.harness_build),
        (record.image_digest, profile.image_digest),
        (record.configuration_digest, profile.configuration_digest),
        (record.transport_digest, profile.transport_digest),
        (record.storage_profile, profile.storage_profile),
        (record.tool_policy_digest, profile.tool_policy_digest),
    )
    return all(recorded is None or recorded == running for recorded, running in pairs)


def _same_pins(row: Mapping[str, Any], release: ResolvedRelease) -> bool:
    manifest = release.manifest
    return (
        row["brain_release_id"] == release.release_id
        and row["behavior_version"] == manifest.behavior_version
        and row["behavior_hash"] == manifest.behavior_sha256
        and row["corpus_release_id"] == manifest.corpus_release_id
    )


def _refused(provider: Provider, reason: EligibilityReason) -> ProviderEligibility:
    return ProviderEligibility(provider=provider, eligible=False, reason=reason, deployment_ref=None, model=None)


def _view(row: Mapping[str, Any]) -> ConversationView:
    provider = _provider(row["provider"])
    return ConversationView(
        id=row["id"],
        provider=provider,
        harness=HARNESS_FOR_PROVIDER[provider],
        model=row["model"],
        brain_release_id=row["brain_release_id"],
        behavior_version=row["behavior_version"],
        corpus_release_id=row["corpus_release_id"],
        status=row["status"],
        runtime_state=row["runtime_state"],
        active_agent_run_id=row["active_agent_run_id"],
    )


def _provider(value: object) -> Provider:
    if value == "openai":
        return "openai"
    if value == "xai":
        return "xai"
    raise ValueError("unknown provider in conversation metadata")


def _uuid_or_none(value: str) -> str | None:
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        return None


def _require_subject(subject_id: str) -> None:
    if not subject_id or len(subject_id) > SUBJECT_MAX_LENGTH:
        raise ValueError("subject identifier required")
