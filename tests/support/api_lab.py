"""API lab: the real FastAPI application over real PostgreSQL and a file-backed Brain Registry.

Every runtime, release and policy value here is a synthetic test identity. The lab records pending
runtime qualification rows only; it never inserts or upgrades a validated record. Isolated-candidate
admission comes from a recorded test-only candidate policy that is bound to the lab's isolated
deployment identity, exactly as a qualification deployment would load it.

The application connects as the restricted `esp_app` role, so every route runs with the production
privileges. Seeding uses the disposable database owner.

`provider_capacity` is one row per provider, shared by every test. The lab snapshots both rows before
it marks the providers healthy and restores the snapshot when it closes.

`FaultyObjectStore` wraps the lab's real store and fails reads on demand. It stands in for a release
store outage or a permanently absent object; it never changes a stored object.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from esp_api.auth import CSRF_HEADER, SubjectIdentity
from esp_api.config import ApiSettings, load_candidate_policy, load_runtime_profiles, load_settings
from esp_api.server import ApiDependencies, NativeRuntimeAdapter, build_api
from esp_contracts.api import ConversationView
from esp_contracts.ids import Provider
from esp_contracts.qualification import PrimitiveEvidence, RuntimeProfile
from esp_contracts.release import ReleaseManifest
from esp_contracts.runtime import SessionHandle, SessionReservation
from esp_db.client import Db, open_db, transaction
from esp_espcon.brain_registry import BrainRegistry
from esp_espcon.conversation import AdmissionPins, ConversationService, ProviderEligibility
from esp_execution_bindings.binding import TokenSigner
from esp_object_store.store import FileObjectStore, ObjectReceipt
from knowledge.release.publish import publish_candidate
from tests.support.database import APP_DSN
from tests.support.policy_lab import CLUSTER_UID, policy_document, synthetic_profile
from tests.support.release import FIXTURES, manifest_for

ORIGIN = "https://esp.test"
FOREIGN_ORIGIN = "https://attacker.test"
DEV_ORIGIN = "http://127.0.0.1:8080"
APP_ROLE_DSN = os.environ.get("ESP_APP_ROLE_DATABASE_URL", "postgresql://esp_app:esp_app@127.0.0.1:54329/esp")
ISOLATED_DEPLOYMENT_REF = "qual-deployment-test-api"
SESSION_MAX_AGE_SECONDS = 86400


def encode_key(key: bytes) -> str:
    return base64.urlsafe_b64encode(key).decode().rstrip("=")


def _digest(label: str) -> str:
    return "sha256:" + hashlib.sha256(label.encode()).hexdigest()


def synthetic_xai_profile(**overrides: object) -> RuntimeProfile:
    """A pending Grok Build candidate with synthetic identities. No policy in the lab allowlists it."""
    base: dict[str, object] = {
        "provider": "xai",
        "model": "test-only-xai-model",
        "harness_build": "test-only-grok-build",
        "image_digest": _digest("test-only grok runtime image"),
        "configuration_digest": _digest("test-only grok configuration"),
        "transport_digest": _digest("test-only grok transport integration"),
        "storage_profile": "test-only/unqualified-native-volume",
        "tool_policy_digest": _digest("test-only grok tool policy"),
        "primitives": [PrimitiveEvidence(name="storage", state="unproven")],
    }
    base.update(overrides)
    return RuntimeProfile.model_validate(base)


class CountingRuntime:
    """Native runtime double. Creation is lazy, so every call here is counted as a failure."""

    def __init__(self, provider: Provider) -> None:
        self.provider = provider
        self.create_calls = 0

    async def create_session(self, reservation: SessionReservation) -> SessionHandle:
        self.create_calls += 1
        raise RuntimeError("conversation creation must not allocate a native session")


class FaultyObjectStore:
    """The lab's real object store, whose reads raise `failure()` while a failure is set."""

    def __init__(self, inner: FileObjectStore) -> None:
        self.inner = inner
        self.failure: Callable[[], Exception] | None = None
        self.failed_reads = 0

    async def put_immutable(self, key: str, body: bytes, metadata: dict[str, str]) -> ObjectReceipt:
        return await self.inner.put_immutable(key, body, metadata)

    async def get(self, key: str, version_id: str | None = None) -> bytes:
        if self.failure is not None:
            self.failed_reads += 1
            raise self.failure()
        return await self.inner.get(key, version_id)


class RecordingTelemetry:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, str]]] = []

    def emit(self, name: str, attributes: Mapping[str, str]) -> None:
        self.events.append((name, dict(attributes)))


class MutableClock:
    def __init__(self) -> None:
        self.now = float(int(datetime.now(UTC).timestamp()))

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@dataclass
class Visitor:
    client: httpx.AsyncClient
    csrf: str
    origin: str = ORIGIN

    def cookie(self, name: str = "__Host-esp_session") -> str:
        value = self.client.cookies.get(name)
        if value is None:
            raise AssertionError(f"no {name} cookie")
        return value

    @property
    def subject_id(self) -> str:
        return self.cookie().split(".")[2]

    def write_headers(self, *, origin: str | None = None, csrf: str | None = None) -> dict[str, str]:
        headers = {"content-type": "application/json"}
        selected_origin = self.origin if origin is None else origin
        if selected_origin:
            headers["origin"] = selected_origin
        selected_csrf = self.csrf if csrf is None else csrf
        if selected_csrf:
            headers[CSRF_HEADER] = selected_csrf
        return headers

    async def create(
        self,
        provider: str = "openai",
        *,
        origin: str | None = None,
        csrf: str | None = None,
        body: object | None = None,
        raw: bytes | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> httpx.Response:
        content = raw if raw is not None else json.dumps({"provider": provider} if body is None else body).encode()
        headers = self.write_headers(origin=origin, csrf=csrf)
        if extra_headers:
            headers.update(extra_headers)
        return await self.client.post("/conversations", content=content, headers=headers)

    async def get(self, conversation_id: str) -> httpx.Response:
        return await self.client.get(f"/conversations/{conversation_id}")

    async def list(self) -> httpx.Response:
        return await self.client.get("/conversations")

    async def refresh(self) -> httpx.Response:
        response = await self.client.post("/visitor-session", headers={"origin": self.origin})
        if response.status_code == 200:
            self.csrf = str(response.json()["csrf_token"])
        return response


class ApiLab:
    def __init__(self, tmp_path: Path, admin: Db, app_db: Db) -> None:
        self.tmp_path = tmp_path
        self.admin = admin
        self.app_db = app_db
        suffix = uuid.uuid4().hex[:12]
        self.release_id = f"test-api-draft-{suffix}"
        self.store = FileObjectStore(tmp_path / "objects")
        self.registry = BrainRegistry(self.store, tmp_path / "registry")
        self.profiles: dict[Provider, RuntimeProfile] = {
            "openai": synthetic_profile(),
            "xai": synthetic_xai_profile(),
        }
        self.deployment_refs: dict[Provider, str] = {
            "openai": f"test-api-openai-{suffix}",
            "xai": f"test-api-xai-{suffix}",
        }
        self.qualification_ids: dict[Provider, str] = {
            "openai": f"test-api-qual-openai-{suffix}",
            "xai": f"test-api-qual-xai-{suffix}",
        }
        self.k1 = secrets.token_bytes(32)
        self.k2 = secrets.token_bytes(32)
        self.adapters: dict[Provider, CountingRuntime] = {
            "openai": CountingRuntime("openai"),
            "xai": CountingRuntime("xai"),
        }
        self.telemetry = RecordingTelemetry()
        self.clock = MutableClock()
        self.manifest: ReleaseManifest | None = None
        self.second_release_id = f"test-api-draft-b-{suffix}"
        self.second_manifest: ReleaseManifest | None = None
        self.policy_path = tmp_path / "candidate-policy.json"
        self.profiles_path = tmp_path / "runtime-profiles.json"
        self.foreign_db: Db | None = None
        self._clients: list[httpx.AsyncClient] = []
        self._capacity_snapshot: list[dict[str, Any]] = []
        self._default_app: FastAPI | None = None
        self.last_visitor: Visitor | None = None

    # Setup and teardown

    async def setup(self) -> None:
        brain = (FIXTURES / "release_a" / "canonical_brain.md").read_bytes()
        behavior = (FIXTURES / "release_a" / "behavior.md").read_bytes()
        draft = manifest_for(self.release_id, brain, behavior)
        self.manifest = await publish_candidate(
            FIXTURES / "release_a", draft, registry=self.registry, release_id=self.release_id
        )
        self.write_profiles(self.profiles_path, self.profiles)
        self._write_policy([self.manifest])
        await self._seed()

    def _write_policy(self, manifests: Sequence[ReleaseManifest]) -> None:
        """The recorded test-only policy, bound to the lab's isolated deployment, allowlisting `manifests`."""
        policy = policy_document(
            self.profiles["openai"],
            manifests[0],
            deployment={
                "environment": "isolated-qualification",
                "namespace": "esp-qualification",
                "deployment_ref": ISOLATED_DEPLOYMENT_REF,
                "cluster_uid": CLUSTER_UID,
                "public_ingress": False,
            },
        )
        policy["content"] = [
            {
                "brain_version": manifest.brain_version,
                "canonical_brain_sha256": manifest.canonical_brain_sha256,
                "behavior_version": manifest.behavior_version,
                "behavior_sha256": manifest.behavior_sha256,
                "corpus_release_id": manifest.corpus_release_id,
            }
            for manifest in manifests
        ]
        self.policy_path.write_text(json.dumps(policy), encoding="utf-8")

    async def publish_second_release(self) -> ReleaseManifest:
        """Publish fixture release B as another draft, record it, and allowlist A and B in the policy.

        Selecting B is a configuration change (`ESP_BRAIN_RELEASE_ID`) for applications built afterwards.
        """
        brain = (FIXTURES / "release_b" / "canonical_brain.md").read_bytes()
        behavior = (FIXTURES / "release_b" / "behavior.md").read_bytes()
        draft = manifest_for(self.second_release_id, brain, behavior)
        self.second_manifest = await publish_candidate(
            FIXTURES / "release_b", draft, registry=self.registry, release_id=self.second_release_id
        )
        async with self.admin.pool.connection() as connection:
            await _record_release(connection, self.second_release_id, self.second_manifest)
        self._write_policy([self.release, self.second_manifest])
        return self.second_manifest

    async def _seed(self) -> None:
        now = datetime.now(UTC)
        async with self.admin.pool.connection() as connection:
            async with connection.transaction():
                await _record_release(connection, self.release_id, self.release)
                for provider, profile in self.profiles.items():
                    await connection.execute(
                        """
                        INSERT INTO runtime_qualification (
                            id, design_assumption_id, provider, harness_revision, image_digest,
                            configuration_digest, transport_digest, storage_profile, tool_policy_digest, status
                        ) VALUES (%s, 'DA-01', %s, %s, %s, %s, %s, %s, %s, 'pending')
                        """,
                        (
                            self.qualification_ids[provider],
                            provider,
                            profile.harness_build,
                            profile.image_digest,
                            profile.configuration_digest,
                            profile.transport_digest,
                            profile.storage_profile,
                            profile.tool_policy_digest,
                        ),
                    )
                    await connection.execute(
                        """
                        INSERT INTO provider_deployment (
                            id, provider, model, harness_revision, configuration_digest, gateway_route,
                            shared_process_qualification_id, deployed_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            self.deployment_refs[provider],
                            provider,
                            profile.model,
                            profile.harness_build,
                            profile.configuration_digest,
                            f"{provider}-responses",
                            self.qualification_ids[provider],
                            now,
                        ),
                    )
                    await connection.execute(
                        """
                        INSERT INTO harness_instance (
                            id, provider, worker_id, process_incarnation_id, deployment_ref,
                            native_storage_unit_id, lifecycle_status, resident_session_limit,
                            active_turn_limit, last_heartbeat_at
                        ) VALUES (%s, %s, 'test-api-worker', %s, %s, 'test-api-volume', 'ready', 2, 2, %s)
                        """,
                        (uuid.uuid4(), provider, uuid.uuid4(), self.deployment_refs[provider], now),
                    )
                cursor = await connection.execute(
                    "SELECT provider, policy, healthy, active_limit FROM provider_capacity "
                    "WHERE provider IN ('openai', 'xai')"
                )
                self._capacity_snapshot = [dict(row) for row in await cursor.fetchall()]
        await self.set_provider_health("openai", True)
        await self.set_provider_health("xai", True)

    async def close(self) -> None:
        for client in self._clients:
            await client.aclose()
        self._clients.clear()
        async with self.admin.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute("DELETE FROM provider_capacity WHERE provider IN ('openai', 'xai')")
                for row in self._capacity_snapshot:
                    await connection.execute(
                        "INSERT INTO provider_capacity (provider, policy, healthy, active_limit) "
                        "VALUES (%s, %s, %s, %s)",
                        (row["provider"], row["policy"], row["healthy"], row["active_limit"]),
                    )
        if self.foreign_db is not None:
            await self.foreign_db.close()

    # Configuration and application builds

    @property
    def release(self) -> ReleaseManifest:
        if self.manifest is None:
            raise RuntimeError("lab is not set up")
        return self.manifest

    def write_profiles(self, path: Path, profiles: Mapping[Provider, RuntimeProfile]) -> Path:
        document = {
            "profiles_format": "esp-runtime-profiles/1",
            "runtimes": [
                {
                    "provider": provider,
                    "deployment_ref": self.deployment_refs[provider],
                    "profile": profile.model_dump(mode="json"),
                }
                for provider, profile in profiles.items()
            ],
        }
        path.write_text(json.dumps(document), encoding="utf-8")
        return path

    def changed_profiles(self, provider: Provider, **changes: object) -> Path:
        profiles = dict(self.profiles)
        profiles[provider] = profiles[provider].model_copy(update=changes)
        return self.write_profiles(self.tmp_path / f"profiles-{uuid.uuid4().hex[:8]}.json", profiles)

    def environ(
        self, environment: str = "qualification", overrides: Mapping[str, str | None] | None = None
    ) -> dict[str, str]:
        env = {
            "ESP_ENVIRONMENT": environment,
            "ESP_PUBLIC_ORIGIN": DEV_ORIGIN if environment == "development" else ORIGIN,
            "ESP_DATABASE_URL": APP_ROLE_DSN,
            "ESP_SESSION_KEYS": f"k1:{encode_key(self.k1)}",
            "ESP_SESSION_MAX_AGE_SECONDS": str(SESSION_MAX_AGE_SECONDS),
            "ESP_BRAIN_RELEASE_ID": self.release_id,
            "ESP_RUNTIME_PROFILES_PATH": str(self.profiles_path),
        }
        if environment == "qualification":
            env["ESP_CANDIDATE_POLICY_PATH"] = str(self.policy_path)
            env["ESP_QUALIFICATION_CLUSTER_UID"] = CLUSTER_UID
            env["ESP_QUALIFICATION_DEPLOYMENT_REF"] = ISOLATED_DEPLOYMENT_REF
        for name, value in (overrides or {}).items():
            if value is None:
                env.pop(name, None)
            else:
                env[name] = value
        return env

    def settings(
        self, environment: str = "qualification", overrides: Mapping[str, str | None] | None = None
    ) -> ApiSettings:
        return load_settings(self.environ(environment, overrides))

    def dependencies(
        self,
        environment: str = "qualification",
        overrides: Mapping[str, str | None] | None = None,
        *,
        db: Db | None = None,
        registry: BrainRegistry | None = None,
    ) -> ApiDependencies:
        settings = self.settings(environment, overrides)
        signer, _ = TokenSigner.generate()
        adapters: dict[Provider, NativeRuntimeAdapter] = dict(self.adapters)
        return ApiDependencies(
            db=self.app_db if db is None else db,
            settings=settings,
            identity=SubjectIdentity.from_settings(settings, clock=self.clock),
            releases=self.registry if registry is None else registry,
            runtimes=load_runtime_profiles(settings),
            adapters=adapters,
            candidate_policy=load_candidate_policy(settings),
            signer=signer,
            counters=None,
            telemetry=self.telemetry,
        )

    def build(
        self,
        environment: str = "qualification",
        overrides: Mapping[str, str | None] | None = None,
        *,
        db: Db | None = None,
        registry: BrainRegistry | None = None,
    ) -> FastAPI:
        return build_api(self.dependencies(environment, overrides, db=db, registry=registry))

    @property
    def app(self) -> FastAPI:
        if self._default_app is None:
            self._default_app = self.build()
        return self._default_app

    def service(
        self,
        environment: str = "qualification",
        overrides: Mapping[str, str | None] | None = None,
        *,
        registry: BrainRegistry | None = None,
    ) -> ConversationService:
        deps = self.dependencies(environment, overrides, registry=registry)
        return ConversationService(
            deps.db,
            deps.releases,
            release_id=deps.settings.brain_release_id,
            runtimes=deps.runtimes,
            candidate_policy=deps.candidate_policy,
        )

    def faulty_registry(self) -> tuple[BrainRegistry, FaultyObjectStore]:
        """The lab's registry selections over a store that fails on demand, with a cold release cache."""
        store = FaultyObjectStore(self.store)
        return BrainRegistry(store, self.registry.registry_dir), store

    def client(
        self,
        app: FastAPI | None = None,
        *,
        origin: str = ORIGIN,
        cookies: httpx.Cookies | None = None,
        raise_app_exceptions: bool = True,
    ) -> httpx.AsyncClient:
        """`raise_app_exceptions=False` shows the response a server sends after an unexpected exception."""
        transport = httpx.ASGITransport(app=app or self.app, raise_app_exceptions=raise_app_exceptions)
        client = httpx.AsyncClient(transport=transport, base_url=origin, cookies=cookies)
        self._clients.append(client)
        return client

    async def visitor(self, app: FastAPI | None = None, *, origin: str = ORIGIN) -> Visitor:
        client = self.client(app, origin=origin)
        response = await client.post("/visitor-session", headers={"origin": origin})
        assert response.status_code == 200, response.text
        visitor = Visitor(client=client, csrf=str(response.json()["csrf_token"]), origin=origin)
        self.last_visitor = visitor
        return visitor

    def same_browser(self, visitor: Visitor, app: FastAPI) -> Visitor:
        """The same browser cookie jar and CSRF token presented to another application build."""
        return Visitor(client=self.client(app, cookies=visitor.client.cookies), csrf=visitor.csrf)

    async def unreachable_db(self) -> Db:
        pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]] = AsyncConnectionPool(
            conninfo="postgresql://esp_app:esp_app@127.0.0.1:1/esp",
            min_size=1,
            max_size=1,
            timeout=0.5,
            open=False,
        )
        await pool.open(wait=False)
        self.foreign_db = Db(pool)
        return self.foreign_db

    # The plan's named scenarios

    @property
    def native_create_calls(self) -> int:
        return sum(adapter.create_calls for adapter in self.adapters.values())

    async def other_owner_get(self) -> httpx.Response:
        owner = await self.visitor()
        created = await owner.create("openai")
        assert created.status_code == 201, created.text
        other = await self.visitor()
        return await other.get(str(created.json()["id"]))

    async def public_create_pending(self) -> httpx.Response:
        visitor = await self.visitor(self.build("production"))
        return await visitor.create("openai")

    async def cross_origin_post(self) -> httpx.Response:
        visitor = await self.visitor()
        return await visitor.create("openai", origin=FOREIGN_ORIGIN)

    async def create_with_eligible_test_dependencies(self) -> ConversationView:
        visitor = await self.visitor()
        response = await visitor.create("openai")
        assert response.status_code == 201, response.text
        return ConversationView.model_validate(response.json())

    # Database observations and metadata changes

    async def conversation_row(self, conversation_id: str) -> dict[str, Any] | None:
        async with self.admin.pool.connection() as connection:
            cursor = await connection.execute(
                """
                SELECT owner_subject_id, provider, brain_release_id, behavior_version, behavior_hash,
                       corpus_release_id, status, active_provider_session_id
                FROM conversation WHERE id = %s
                """,
                (conversation_id,),
            )
            row = await cursor.fetchone()
        return None if row is None else dict(row)

    async def owned_conversation_count(self, subject_id: str) -> int:
        async with self.admin.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT count(*) AS n FROM conversation WHERE owner_subject_id = %s", (subject_id,)
            )
            row = await cursor.fetchone()
        assert row is not None
        return int(row["n"])

    async def mapping_count(self, conversation_id: str) -> int:
        async with self.admin.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT count(*) AS n FROM provider_session WHERE conversation_id = %s", (conversation_id,)
            )
            row = await cursor.fetchone()
        assert row is not None
        return int(row["n"])

    async def qualification_statuses(self) -> set[str]:
        async with self.admin.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT status FROM runtime_qualification WHERE id = ANY(%s)",
                (list(self.qualification_ids.values()),),
            )
            rows = await cursor.fetchall()
        return {str(row["status"]) for row in rows}

    async def set_provider_health(self, provider: Provider, healthy: bool) -> None:
        async with self.admin.pool.connection() as connection:
            await connection.execute(
                """
                INSERT INTO provider_capacity (provider, policy, healthy, active_limit)
                VALUES (%s, 'test-api-lab', %s, 2)
                ON CONFLICT (provider) DO UPDATE SET healthy = EXCLUDED.healthy
                """,
                (provider, healthy),
            )

    async def eligibility(
        self, provider: Provider, environment: str = "qualification", overrides: Mapping[str, str | None] | None = None
    ) -> ProviderEligibility:
        return await self.service(environment, overrides).eligibility(provider)

    async def admission_pins(
        self, conversation_id: str, overrides: Mapping[str, str | None] | None = None
    ) -> AdmissionPins:
        """Resolve the pinned release outside the transaction, then select inside it, as admission must."""
        service = self.service(overrides=overrides)
        release = await service.resolve_pinned_release(conversation_id)
        async with transaction(self.app_db) as tx:
            return await service.select_admission_pins(tx, conversation_id, release)

    async def record_initial_mapping(self, conversation_id: str) -> AdmissionPins:
        """Stand in for first admission: write the selected pins on a nullable-native-ID mapping."""
        pins = await self.admission_pins(conversation_id)
        now = datetime.now(UTC)
        async with self.admin.pool.connection() as connection:
            await connection.execute(
                """
                INSERT INTO provider_session (
                    id, conversation_id, provider, session_generation, is_current, native_session_id, model,
                    brain_release_id, brain_hash, behavior_version, behavior_hash, corpus_release_id,
                    deployment_ref, runtime_state, ownership_epoch, recovery_count, created_at, last_used_at
                ) VALUES (%s, %s, %s, 1, true, NULL, %s, %s, %s, %s, %s, %s, %s, 'warm_idle', 1, 0, %s, %s)
                """,
                (
                    uuid.uuid4(),
                    conversation_id,
                    pins.provider,
                    pins.model,
                    pins.brain_release_id,
                    pins.brain_hash,
                    pins.behavior_version,
                    pins.behavior_hash,
                    pins.corpus_release_id,
                    pins.deployment_ref,
                    now,
                    now,
                ),
            )
        return pins


async def _record_release(connection: AsyncConnection[Any], release_id: str, manifest: ReleaseManifest) -> None:
    """Record a published draft release in the Application Database, as the publisher role would."""
    await connection.execute(
        """
        INSERT INTO brain_release (
            version, sha256, behavior_version, behavior_sha256, source_revision,
            artifact_ref, behavior_artifact_ref, corpus_release_id, status, created_at
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'draft', %s)
        """,
        (
            release_id,
            manifest.canonical_brain_sha256,
            manifest.behavior_version,
            manifest.behavior_sha256,
            manifest.source_revision,
            manifest.brain_artifact_ref,
            manifest.behavior_artifact_ref,
            manifest.corpus_release_id,
            datetime.now(UTC),
        ),
    )


async def open_api_lab(tmp_path: Path) -> ApiLab:
    admin = await open_db(APP_DSN)
    app_db = await open_db(APP_ROLE_DSN)
    lab = ApiLab(tmp_path, admin, app_db)
    await lab.setup()
    return lab


async def close_api_lab(lab: ApiLab) -> None:
    try:
        await lab.close()
    finally:
        await lab.app_db.close()
        await lab.admin.close()
