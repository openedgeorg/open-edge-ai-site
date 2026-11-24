"""Local Compose listener for the conversational app.

This is the process `infra/local/compose.yaml` service `conversational` runs. It does not change
the qualified process entries, which still refuse to listen, and it does not claim Gate 1.

One HTTPS origin serves the site and the Application Backend. Codex and Grok Build run in this
process with the machine logins already in `~/.codex` and `~/.grok` (symlinked, never copied).
Their model traffic is forced onto loopback relays, which attribute the call and forward it to
the local inference gateway. The gateway holds the login material; the harness environment does not.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import psycopg
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row

from esp_api.auth import SubjectIdentity
from esp_api.config import load_candidate_policy, load_runtime_profiles, load_settings
from esp_api.server import ApiDependencies, build_api
from esp_contracts.qualification import PrimitiveEvidence, RuntimeProfile
from esp_contracts.release import ReleaseManifest
from esp_db.client import Db, Transaction, open_db
from esp_espcon.brain_registry import BrainRegistry
from esp_execution_bindings.binding import TokenSigner
from esp_inference_gateway.evidence_recorder import EvidenceKey, EvidenceRecorder, MemoryOutcomeStore
from esp_inference_gateway.server import GatewayDependencies, build_gateway
from esp_inference_gateway.transport import ApprovedRoute, FencedTransport
from esp_object_store.store import FileObjectStore
from esp_provider_openai.codex_adapter import (
    CODEX_BUILD,
    CODEX_NATIVE_SHA256,
    STDIO_READER_LIMIT,
    JsonlFrameTransport,
    create_codex_adapter,
)
from esp_provider_shared.rpc import NativeRpcClient
from esp_provider_shared.transport_context import UnattributedCall
from esp_provider_xai.grok_build_adapter import (
    GROK_BUILD,
    GROK_NATIVE_SHA256,
    GROK_SESSION_CWD,
    AcpClientGuard,
    GrokStdioTransport,
    create_grok_adapter,
)
from esp_provider_xai.grok_build_adapter import STDIO_READER_LIMIT as GROK_STDIO_LIMIT
from esp_request_admission.rate_limits import RatePolicy, connect_rate_limiter
from esp_runtime_harconses.manager import SessionLimits
from esp_runtime_placement.capacity import provision_instance_slots, provision_provider_slots
from knowledge.release.local_draft import BRAIN_DIR, RELEASE_ID
from knowledge.release.publish import publish_candidate

ROOT = Path(__file__).resolve().parents[1]
STATE = Path(os.environ.get("ESP_LOCAL_STATE", "/var/lib/esp-local"))
PORT = int(os.environ.get("ESP_PUBLIC_PORT", "8766"))
ORIGIN = f"https://127.0.0.1:{PORT}"
GATEWAY_PORT = 8470
CODEX_RELAY_PORT = 8471
GROK_RELAY_PORT = 8472
OWNER_DSN = os.environ.get("ESP_DATABASE_URL", "postgresql://esp:esp@127.0.0.1:54329/esp")
APP_DSN = os.environ.get("ESP_APP_ROLE_DATABASE_URL", "postgresql://esp_app:esp_app@127.0.0.1:54329/esp")
VALKEY_URL = os.environ.get("ESP_VALKEY_URL", "redis://127.0.0.1:63799/0")
DEPLOYMENT_REF = "qual-local-compose"
CLUSTER_UID = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3"
OPENAI_MODEL = "gpt-6-astra"
XAI_MODEL = "grok-4.7"
LOOPBACK_API_KEY = "esp-local-gateway"
# Each conversation keeps one native session resident until it is evicted after 15 idle minutes.
# Four slots per provider were used up by a handful of test conversations, and every later new
# conversation was refused with capacity_unavailable (HTTP 503).
RESIDENT_SESSION_LIMIT = 16
ACTIVE_TURN_LIMIT = 8
IDLE_EVICTION_PERIOD_SECONDS = 30
CREDENTIAL_PROBES = {
    "openai": "https://api.openai.com/v1/models",
    "xai": "https://api.x.ai/v1/models",
}
CODEX_CONFIG = ROOT / "infra" / "runtime" / "codex" / "config.toml"
GROK_CONFIG = ROOT / "infra" / "runtime" / "grok" / "config.toml"
TOOL_POLICY = ROOT / "infra" / "runtime" / "tool-policy.json"
CODEX_BINARY = Path(
    os.environ.get(
        "ESP_CODEX_BINARY",
        str(
            Path.home()
            / ".local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"
        ),
    )
)
GROK_BINARY = Path(os.environ.get("ESP_GROK_BINARY", str(Path.home() / ".local/bin/grok")))
OPENAI_INSTANCE = "11111111-1111-4111-8111-111111111111"
XAI_INSTANCE = "22222222-2222-4222-8222-222222222222"
_SECRET = re.compile(r"sk-[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,}|Bearer\s+\S+", re.IGNORECASE)
# The gateway rejects these keys anywhere in a model body. Real CLIs send some of them.
_GATEWAY_DROPPED_KEYS = {"previous_response_id", "store", "background", "truncation", "url", "image_url", "file_url"}


def digest(body: bytes) -> str:
    return "sha256:" + hashlib.sha256(body).hexdigest()


def redact(text: str) -> str:
    return _SECRET.sub("redacted", text)[-400:]


def _without_forbidden_fields(body: bytes) -> bytes:
    """Drop keys the gateway refuses, then forward the rest unchanged in meaning."""
    try:
        document = json.loads(body)
    except json.JSONDecodeError:
        return body
    removed: list[str] = []

    def walk(value: object) -> None:
        if isinstance(value, dict):
            for key in list(value):
                if key in _GATEWAY_DROPPED_KEYS:
                    removed.append(key)
                    del value[key]
                else:
                    walk(value[key])
        elif isinstance(value, list):
            for item in value:
                walk(item)

    if not isinstance(document, dict):
        return body
    if document.get("instructions") is None and "instructions" in document:
        document["instructions"] = ""
    walk(document)
    if removed:
        model = document.get("model")
        model_text = model if isinstance(model, str) and len(model) <= 80 else type(model).__name__
        print(f"relay dropped {sorted(set(removed))} model={model_text}", file=sys.stderr)
    return json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _secret_file(path: Path, size: int) -> bytes:
    if path.is_file() and path.stat().st_size == size:
        return path.read_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = os.urandom(size)
    path.write_bytes(raw)
    path.chmod(0o600)
    return raw


def _session_keys() -> str:
    raw = _secret_file(STATE / "session.key", 32)
    return "local1:" + _b64(raw)


def _require_binary(path: Path, expected: str, label: str) -> None:
    if not path.is_file():
        raise SystemExit(f"{label} binary is missing")
    found = hashlib.sha256(path.read_bytes()).hexdigest()
    if found != expected:
        raise SystemExit(f"{label} binary digest does not match the pinned build")


def _stage_config(
    template: Path,
    dest: Path,
    base_url: str,
    *,
    model_from: str | None = None,
    model_to: str | None = None,
    pin_loopback_api_key: bool = False,
) -> None:
    text = template.read_text(encoding="utf-8")
    replaced, count = re.subn(r'(?m)^base_url\s*=\s*"[^"]*"', f'base_url = "{base_url}"', text)
    if count != 1:
        raise SystemExit(f"{template.name} does not name exactly one base_url")
    if model_from is not None and model_to is not None:
        needle = f'model = "{model_from}"'
        if replaced.count(needle) != 1:
            raise SystemExit(f"{template.name} does not name the placeholder model once")
        replaced = replaced.replace(needle, f'model = "{model_to}"', 1)
    if pin_loopback_api_key:
        # Not a provider secret. grok 1.0.46 will not open a session until an auth method is
        # selected. This only selects xai.api_key so session/new stays on the loopback relay.
        needle = f'base_url = "{base_url}"\n'
        if replaced.count(needle) != 1:
            raise SystemExit("staged grok profile does not name exactly one gateway base_url")
        if LOOPBACK_API_KEY not in replaced:
            replaced = replaced.replace(needle, f'{needle}api_key = "{LOOPBACK_API_KEY}"\n', 1)
        # The knowledge service is not part of this listener. Leaving the MCP server in the staged
        # profile makes grok quit the worker when nothing is listening on 8473.
        replaced = re.sub(r"(?ms)^\[mcp_servers\.esp_knowledge\].*?(?=^\[|\Z)", "", replaced)
    dest.write_text(replaced, encoding="utf-8")


def _link_auth(source: Path, dest_home: Path) -> None:
    auth = source / "auth.json"
    if not auth.is_file():
        raise SystemExit(f"missing login file for {source.name}")
    link = dest_home / "auth.json"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(auth)


def _login_bearer(path: Path, provider: str) -> str:
    """Read the existing machine login. The value is never printed."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if provider == "openai":
        tokens = data.get("tokens")
        token = tokens.get("access_token") if isinstance(tokens, dict) else None
        if isinstance(token, str) and token:
            return token
        raise SystemExit("openai login has no access token")
    if isinstance(data, dict):
        for value in data.values():
            if isinstance(value, dict):
                key = value.get("key")
                if isinstance(key, str) and key:
                    return key
    raise SystemExit("xai login has no key")


def _manifest(release_id: str, brain: bytes, behavior: bytes) -> ReleaseManifest:
    return ReleaseManifest(
        brain_version=release_id,
        canonical_brain_sha256=hashlib.sha256(brain).hexdigest(),
        canonical_brain_bytes=len(brain),
        behavior_version=f"{release_id}-behavior",
        behavior_sha256=hashlib.sha256(behavior).hexdigest(),
        behavior_bytes=len(behavior),
        source_revision="repo-local-draft-v1",
        created_at=datetime(2026, 10, 4, tzinfo=UTC),
        status="draft",
        brain_artifact_ref="pending-brain",
        behavior_artifact_ref="pending-behavior",
        corpus_release_id="local-compose-corpus",
    )


def _profile(provider: str, model: str, harness: str, config: Path, image: str) -> RuntimeProfile:
    return RuntimeProfile(
        provider=provider,  # type: ignore[arg-type]
        model=model,
        harness_build=harness,
        image_digest=image,
        configuration_digest=digest(config.read_bytes()),
        transport_digest=digest(b"local-compose-stdio-transport/1"),
        storage_profile="local-compose/native-home",
        tool_policy_digest=digest(TOOL_POLICY.read_bytes()),
        primitives=[PrimitiveEvidence(name="storage", state="unproven")],
    )


def _write_policy(path: Path, profiles: Mapping[str, RuntimeProfile], manifest: ReleaseManifest) -> None:
    document = {
        "policy_format": "esp-candidate-policy/1",
        "policy_id": DEPLOYMENT_REF,
        "deployment": {
            "environment": "isolated-qualification",
            "namespace": "esp-qualification",
            "deployment_ref": DEPLOYMENT_REF,
            "cluster_uid": CLUSTER_UID,
            "public_ingress": False,
        },
        "data_namespace": "esp-qualification-data-local-compose",
        "credential_namespace": "qualification/local-compose",
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
            for profile in profiles.values()
        ],
        "content": [
            {
                "brain_version": manifest.brain_version,
                "canonical_brain_sha256": manifest.canonical_brain_sha256,
                "behavior_version": manifest.behavior_version,
                "behavior_sha256": manifest.behavior_sha256,
                "corpus_release_id": manifest.corpus_release_id,
            }
        ],
        "recorded_by": "local-compose",
        "recorded_at": "2026-10-04T00:00:00Z",
    }
    path.write_text(json.dumps(document), encoding="utf-8")


def _write_profiles(path: Path, profiles: Mapping[str, RuntimeProfile], deployments: Mapping[str, str]) -> None:
    document = {
        "profiles_format": "esp-runtime-profiles/1",
        "runtimes": [
            {
                "provider": provider,
                "deployment_ref": deployments[provider],
                "profile": profile.model_dump(mode="json"),
            }
            for provider, profile in profiles.items()
        ],
    }
    path.write_text(json.dumps(document), encoding="utf-8")


def _certificate() -> tuple[Path, Path]:
    cert = STATE / "tls.crt"
    key = STATE / "tls.key"
    if cert.is_file() and key.is_file():
        return cert, key
    STATE.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-keyout",
            str(key),
            "-out",
            str(cert),
            "-days",
            "365",
            "-nodes",
            "-subj",
            "/CN=127.0.0.1",
            "-addext",
            "subjectAltName=IP:127.0.0.1,DNS:localhost",
        ],
        check=True,
        capture_output=True,
    )
    key.chmod(0o600)
    return cert, key


async def _seed(manifest: ReleaseManifest, profiles: Mapping[str, RuntimeProfile], deployments: Mapping[str, str]) -> None:
    now = datetime.now(UTC)
    async with await psycopg.AsyncConnection.connect(OWNER_DSN, row_factory=dict_row) as connection:
        async with connection.transaction():
            await connection.execute(
                """
                INSERT INTO brain_release (
                    version, sha256, behavior_version, behavior_sha256, source_revision,
                    artifact_ref, behavior_artifact_ref, corpus_release_id, status, created_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'draft', %s)
                ON CONFLICT (version) DO UPDATE SET
                    sha256 = EXCLUDED.sha256,
                    behavior_version = EXCLUDED.behavior_version,
                    behavior_sha256 = EXCLUDED.behavior_sha256,
                    artifact_ref = EXCLUDED.artifact_ref,
                    behavior_artifact_ref = EXCLUDED.behavior_artifact_ref,
                    corpus_release_id = EXCLUDED.corpus_release_id,
                    status = 'draft'
                """,
                (
                    RELEASE_ID,
                    manifest.canonical_brain_sha256,
                    manifest.behavior_version,
                    manifest.behavior_sha256,
                    manifest.source_revision,
                    manifest.brain_artifact_ref,
                    manifest.behavior_artifact_ref,
                    manifest.corpus_release_id,
                    now,
                ),
            )
            instances = {"openai": OPENAI_INSTANCE, "xai": XAI_INSTANCE}
            for provider, profile in profiles.items():
                qualification_id = f"local-compose-qual-{provider}"
                await connection.execute(
                    """
                    INSERT INTO runtime_qualification (
                        id, design_assumption_id, provider, harness_revision, image_digest,
                        configuration_digest, transport_digest, storage_profile, tool_policy_digest, status
                    ) VALUES (%s, 'DA-01', %s, %s, %s, %s, %s, %s, %s, 'pending')
                    ON CONFLICT (id) DO UPDATE SET
                        harness_revision = EXCLUDED.harness_revision,
                        image_digest = EXCLUDED.image_digest,
                        configuration_digest = EXCLUDED.configuration_digest,
                        transport_digest = EXCLUDED.transport_digest,
                        storage_profile = EXCLUDED.storage_profile,
                        tool_policy_digest = EXCLUDED.tool_policy_digest,
                        status = 'pending'
                    """,
                    (
                        qualification_id,
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
                    ON CONFLICT (id) DO UPDATE SET
                        model = EXCLUDED.model,
                        harness_revision = EXCLUDED.harness_revision,
                        configuration_digest = EXCLUDED.configuration_digest,
                        gateway_route = EXCLUDED.gateway_route,
                        shared_process_qualification_id = EXCLUDED.shared_process_qualification_id
                    """,
                    (
                        deployments[provider],
                        provider,
                        profile.model,
                        profile.harness_build,
                        profile.configuration_digest,
                        f"{provider}-responses",
                        qualification_id,
                        now,
                    ),
                )
                await connection.execute(
                    """
                    INSERT INTO harness_instance (
                        id, provider, worker_id, process_incarnation_id, deployment_ref,
                        native_storage_unit_id, lifecycle_status, resident_session_limit,
                        active_turn_limit, last_heartbeat_at
                    ) VALUES (%s::uuid, %s, 'local-compose', %s::uuid, %s, %s, 'ready', %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                        deployment_ref = EXCLUDED.deployment_ref,
                        lifecycle_status = 'ready',
                        resident_session_limit = EXCLUDED.resident_session_limit,
                        active_turn_limit = EXCLUDED.active_turn_limit,
                        last_heartbeat_at = EXCLUDED.last_heartbeat_at
                    """,
                    (
                        instances[provider],
                        provider,
                        "33333333-3333-4333-8333-3333333333" + ("01" if provider == "openai" else "02"),
                        deployments[provider],
                        f"local-compose/{provider}",
                        RESIDENT_SESSION_LIMIT,
                        ACTIVE_TURN_LIMIT,
                        now,
                    ),
                )
                await connection.execute(
                    """
                    INSERT INTO provider_capacity (provider, policy, healthy, active_limit)
                    VALUES (%s, 'local-compose', true, 8)
                    ON CONFLICT (provider) DO UPDATE SET
                        policy = EXCLUDED.policy,
                        healthy = true,
                        active_limit = EXCLUDED.active_limit
                    """,
                    (provider,),
                )
                tx = Transaction(connection)
                await provision_instance_slots(tx, instances[provider])
                await provision_provider_slots(tx, provider)  # type: ignore[arg-type]
            released_sessions = await connection.execute(
                """
                UPDATE provider_session
                SET runtime_state = 'warm_idle',
                    active_agent_run_id = NULL,
                    current_request_id = NULL,
                    current_native_work_ref = NULL,
                    active_agent_run_expires_at = NULL,
                    owner_lease_expires_at = NULL,
                    last_used_at = transaction_timestamp()
                WHERE harness_instance_id = ANY(%s::uuid[])
                  AND runtime_state = 'running'
                """,
                ([OPENAI_INSTANCE, XAI_INSTANCE],),
            )
            released_slots = await connection.execute(
                """
                UPDATE capacity_slot
                SET holder_provider_session_id = NULL,
                    reservation_epoch = NULL
                WHERE holder_provider_session_id IN (
                    SELECT id FROM provider_session
                    WHERE harness_instance_id = ANY(%s::uuid[])
                )
                   OR (scope IN ('resident', 'active') AND scope_id = ANY(%s))
                """,
                ([OPENAI_INSTANCE, XAI_INSTANCE], [OPENAI_INSTANCE, XAI_INSTANCE]),
            )
            print(
                f"released local holds sessions={released_sessions.rowcount} slots={released_slots.rowcount}",
                file=sys.stderr,
            )


async def _supervise(app: FastAPI, stop: asyncio.Event) -> None:
    """Settle finished turns so resident capacity is not stuck on an unconfirmed run."""
    while not stop.is_set():
        try:
            await app.state.supervision.consume_control_events()
        except Exception as exc:
            print("supervision failed: " + type(exc).__name__, file=sys.stderr)
        try:
            await asyncio.wait_for(stop.wait(), timeout=2)
        except TimeoutError:
            continue


async def _evict_idle(app: FastAPI, stop: asyncio.Event) -> None:
    """Unload sessions that have been idle for long. Unloading takes seconds, so it runs apart from the supervisor:
    a conversation stays busy until the supervisor settles its run, and a visitor's next question waits for that."""
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=IDLE_EVICTION_PERIOD_SECONDS)
        except TimeoutError:
            pass
        if stop.is_set():
            return
        try:
            evicted = await app.state.lifecycle.evict_idle(datetime.now(UTC))
            if evicted:
                print(f"evicted idle sessions={len(evicted)}", file=sys.stderr)
        except Exception as exc:
            print("idle eviction failed: " + type(exc).__name__, file=sys.stderr)


async def _mark_unusable_providers(credentials: Mapping[str, str]) -> None:
    """Mark a provider unavailable when its machine login is refused by the model API.

    The Codex login on this machine is a ChatGPT login (auth_mode "chatgpt", no API key): the OpenAI
    API answers 403 "missing scopes", so every OpenAI turn would be accepted and then fail. Saying so
    up front lets the site show the provider as unavailable instead of taking questions that can
    never be answered. A network error proves nothing about the login, so the provider stays then.
    """
    refused: dict[str, int] = {}
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        for provider, url in CREDENTIAL_PROBES.items():
            secret = credentials.get(provider, "")
            if not secret:
                refused[provider] = 0
                continue
            try:
                response = await client.get(url, headers={"authorization": f"Bearer {secret}"})
            except httpx.HTTPError as exc:
                print(f"{provider} credential probe skipped: {type(exc).__name__}", file=sys.stderr)
                continue
            if response.status_code in {401, 403}:
                refused[provider] = response.status_code
    if not refused:
        return
    async with await psycopg.AsyncConnection.connect(OWNER_DSN) as connection:
        for provider, status in refused.items():
            await connection.execute("UPDATE provider_capacity SET healthy = false WHERE provider = %s", (provider,))
            print(f"{provider} marked unavailable: its login is refused by the model API (HTTP {status})", file=sys.stderr)


async def _heartbeat(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            async with await psycopg.AsyncConnection.connect(OWNER_DSN) as connection:
                await connection.execute(
                    """
                    UPDATE harness_instance
                    SET last_heartbeat_at = transaction_timestamp(), lifecycle_status = 'ready'
                    WHERE id = ANY(%s::uuid[])
                    """,
                    ([OPENAI_INSTANCE, XAI_INSTANCE],),
                )
        except Exception as exc:
            print("heartbeat failed: " + type(exc).__name__, file=sys.stderr)
        try:
            await asyncio.wait_for(stop.wait(), timeout=10)
        except TimeoutError:
            continue


async def _spawn(argv: list[str], env: dict[str, str], cwd: Path, stderr_path: Path) -> asyncio.subprocess.Process:
    stderr = stderr_path.open("ab")
    limit = STDIO_READER_LIMIT if "codex" in argv[0] else GROK_STDIO_LIMIT
    return await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=stderr,
        env=env,
        cwd=str(cwd),
        start_new_session=True,
        limit=limit,
    )


def _relay(adapter: Any, gateway_url: str, *, grok: bool) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    client = httpx.AsyncClient(timeout=httpx.Timeout(connect=5.0, read=None, write=30.0, pool=5.0))

    @app.get("/{path:path}")
    async def models(path: str) -> Response:
        # Codex refreshes GET /models before a turn. The gateway only proxies the responses body.
        if path.rstrip("/").endswith("models"):
            model = XAI_MODEL if grok else OPENAI_MODEL
            return JSONResponse({"object": "list", "data": [{"id": model, "object": "model", "owned_by": "esp-local"}]})
        return Response(status_code=404)

    @app.post("/{path:path}")
    async def forward(request: Request, path: str) -> Response:
        del path
        body = await request.body()
        body = _without_forbidden_fields(body)
        try:
            if grok:
                scope = adapter.attribute_model_request(dict(request.headers), body)
            else:
                scope = adapter.attribute_model_request(body)
        except UnattributedCall as exc:
            code = exc.args[0] if exc.args and isinstance(exc.args[0], str) else "unattributed"
            if not re.fullmatch(r"[a-z0-9_]{1,64}", code):
                code = "unattributed"
            return Response(code, status_code=403, media_type="text/plain")
        upstream = await client.send(
            client.build_request(
                "POST",
                gateway_url,
                content=body,
                headers={"content-type": "application/json", "esp-inference-token": scope.token},
            ),
            stream=True,
        )
        if upstream.status_code >= 400:
            err = await upstream.aread()
            safe = err[:160].decode("utf-8", "replace")
            if re.search(r"sk-|xai-|bearer|token", safe, re.IGNORECASE):
                safe = "redacted"
            print(f"upstream {upstream.status_code} {safe}", file=sys.stderr)
            return Response(err, status_code=upstream.status_code, media_type=upstream.headers.get("content-type"))
        return StreamingResponse(
            upstream.aiter_raw(),
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type"),
        )

    return app


async def _serve(server: uvicorn.Server) -> None:
    await server._serve()


async def _main() -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    Path(GROK_SESSION_CWD).mkdir(parents=True, exist_ok=True)
    _require_binary(CODEX_BINARY, CODEX_NATIVE_SHA256, "codex")
    _require_binary(GROK_BINARY, GROK_NATIVE_SHA256, "grok")
    homes = STATE / "homes"
    codex_home = homes / "codex"
    grok_home = homes / "grok"
    codex_home.mkdir(parents=True, exist_ok=True)
    grok_home.mkdir(parents=True, exist_ok=True)
    (codex_home / "work").mkdir(exist_ok=True)
    _stage_config(CODEX_CONFIG, codex_home / "config.toml", f"http://127.0.0.1:{CODEX_RELAY_PORT}/openai/v1")
    _stage_config(
        GROK_CONFIG,
        grok_home / "config.toml",
        f"http://127.0.0.1:{GROK_RELAY_PORT}/xai/v1",
        model_from="esp-configured-xai-model",
        model_to=XAI_MODEL,
        pin_loopback_api_key=True,
    )
    _link_auth(Path.home() / ".codex", codex_home)
    _link_auth(Path.home() / ".grok", grok_home)
    profiles = {
        "openai": _profile("openai", OPENAI_MODEL, CODEX_BUILD, codex_home / "config.toml", digest(CODEX_BINARY.read_bytes())),
        "xai": _profile("xai", XAI_MODEL, GROK_BUILD, grok_home / "config.toml", digest(GROK_BINARY.read_bytes())),
    }
    # image_digest is sha256 of the pinned native binary. Hashing it twice would not match the file.
    profiles["openai"] = profiles["openai"].model_copy(update={"image_digest": "sha256:" + CODEX_NATIVE_SHA256})
    profiles["xai"] = profiles["xai"].model_copy(update={"image_digest": "sha256:" + GROK_NATIVE_SHA256})
    deployments = {"openai": "local-compose-openai", "xai": "local-compose-xai"}
    brain = (BRAIN_DIR / "canonical_brain.md").read_bytes()
    behavior = (BRAIN_DIR / "behavior.md").read_bytes()
    draft = _manifest(RELEASE_ID, brain, behavior)
    store = FileObjectStore(STATE / "objects")
    registry = BrainRegistry(store, STATE / "registry")
    published = await publish_candidate(BRAIN_DIR, draft, registry=registry, release_id=RELEASE_ID)
    _write_policy(STATE / "candidate-policy.json", profiles, published)
    _write_profiles(STATE / "runtime-profiles.json", profiles, deployments)
    await _seed(published, profiles, deployments)
    env = {
        "ESP_ENVIRONMENT": "qualification",
        "ESP_PUBLIC_ORIGIN": ORIGIN,
        "ESP_DATABASE_URL": APP_DSN,
        "ESP_SESSION_KEYS": _session_keys(),
        "ESP_SESSION_MAX_AGE_SECONDS": "86400",
        "ESP_BRAIN_RELEASE_ID": RELEASE_ID,
        "ESP_RUNTIME_PROFILES_PATH": str(STATE / "runtime-profiles.json"),
        "ESP_CANDIDATE_POLICY_PATH": str(STATE / "candidate-policy.json"),
        "ESP_QUALIFICATION_CLUSTER_UID": CLUSTER_UID,
        "ESP_QUALIFICATION_DEPLOYMENT_REF": DEPLOYMENT_REF,
    }
    settings = load_settings(env)
    db = await open_db(APP_DSN)
    signer, verifier = TokenSigner.generate()
    codex_env = {"PATH": "/usr/bin:/bin", "HOME": str(codex_home), "CODEX_HOME": str(codex_home)}
    grok_env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(grok_home),
        "GROK_HOME": str(grok_home),
        "GROK_DISABLE_AUTOUPDATER": "1",
    }
    codex = await _spawn(
        [str(CODEX_BINARY), "app-server", "--strict-config", "--listen", "stdio://"],
        codex_env,
        codex_home / "work",
        STATE / "codex.stderr",
    )
    grok = await _spawn(
        [str(GROK_BINARY), "agent", "--no-leader", "stdio"],
        grok_env,
        grok_home,
        STATE / "grok.stderr",
    )
    if codex.stdin is None or codex.stdout is None or grok.stdin is None or grok.stdout is None:
        raise SystemExit("harness pipes were not created")
    codex_rpc = NativeRpcClient(JsonlFrameTransport(codex.stdout, codex.stdin))
    grok_rpc = NativeRpcClient(AcpClientGuard(GrokStdioTransport(grok.stdout, grok.stdin)))
    codex_adapter = create_codex_adapter(codex_rpc, profiles["openai"])
    grok_adapter = create_grok_adapter(grok_rpc, profiles["xai"])
    # Real CLIs spend the lab's 10s budget on process setup. This listener waits longer.
    grok_adapter.acceptance_wait = 45.0
    try:
        await codex_adapter.initialize()
        await grok_adapter.initialize()
    except Exception as exc:
        for name in ("codex.stderr", "grok.stderr"):
            path = STATE / name
            if path.is_file():
                print(name + ": " + redact(path.read_text(encoding="utf-8", errors="replace")), file=sys.stderr)
        raise SystemExit("harness initialize failed: " + type(exc).__name__) from exc
    print("codex and grok initialized")
    counters = connect_rate_limiter(VALKEY_URL, scope_key=_secret_file(STATE / "rate.key", 32), timeout_seconds=1.0)
    app = build_api(
        ApiDependencies(
            db=db,
            settings=settings,
            identity=SubjectIdentity.from_settings(settings),
            releases=registry,
            runtimes=load_runtime_profiles(settings),
            adapters={"openai": codex_adapter, "xai": grok_adapter},
            candidate_policy=load_candidate_policy(settings),
            signer=signer,
            counters=counters,
            telemetry=_PrintTelemetry(),
            rate_policy=RatePolicy(policy_id="local-compose", window_seconds=60, capacity=30, refill=30, expiry_seconds=60),
            session_limits=SessionLimits(acceptance_budget_seconds=90.0),
        )
    )
    app.mount("/", StaticFiles(directory=str(ROOT / "site"), html=True), name="site")
    release = await registry.resolve_release(RELEASE_ID)
    credentials = {
        "openai": _login_bearer(Path.home() / ".codex" / "auth.json", "openai"),
        "xai": _login_bearer(Path.home() / ".grok" / "auth.json", "xai"),
    }
    await _mark_unusable_providers(credentials)
    gateway = build_gateway(
        GatewayDependencies(
            db=db,
            verifier=verifier,
            release=release,
            recorder=EvidenceRecorder(store, EvidenceKey(_secret_file(STATE / "evidence.key", 32))),
            routes={
                "openai": ApprovedRoute(
                    provider="openai",
                    method="POST",
                    url="https://api.openai.com/v1/responses",
                    model=OPENAI_MODEL,
                    credential_ref="openai",
                ),
                "xai": ApprovedRoute(
                    provider="xai",
                    method="POST",
                    url="https://api.x.ai/v1/chat/completions",
                    model=XAI_MODEL,
                    credential_ref="xai",
                ),
            },
            transport=FencedTransport(credentials),
            outcome=MemoryOutcomeStore(),
        )
    )
    cert, key = _certificate()
    public = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=PORT, ssl_certfile=str(cert), ssl_keyfile=str(key), log_level="info")
    )
    gateway_server = uvicorn.Server(uvicorn.Config(gateway, host="127.0.0.1", port=GATEWAY_PORT, log_level="info"))
    codex_relay = uvicorn.Server(
        uvicorn.Config(
            _relay(codex_adapter, f"http://127.0.0.1:{GATEWAY_PORT}/openai/v1/responses", grok=False),
            host="127.0.0.1",
            port=CODEX_RELAY_PORT,
            log_level="info",
        )
    )
    grok_relay = uvicorn.Server(
        uvicorn.Config(
            _relay(grok_adapter, f"http://127.0.0.1:{GATEWAY_PORT}/xai/v1/responses", grok=True),
            host="127.0.0.1",
            port=GROK_RELAY_PORT,
            log_level="info",
        )
    )
    stop = asyncio.Event()
    heartbeat = asyncio.create_task(_heartbeat(stop))
    supervision = asyncio.create_task(_supervise(app, stop))
    eviction = asyncio.create_task(_evict_idle(app, stop))
    internals = [asyncio.create_task(_serve(item)) for item in (gateway_server, codex_relay, grok_relay)]
    print(f"listening {ORIGIN}")
    try:
        await public.serve()
    finally:
        stop.set()
        for item in (gateway_server, codex_relay, grok_relay):
            item.should_exit = True
        heartbeat.cancel()
        supervision.cancel()
        eviction.cancel()
        for process in (codex, grok):
            if process.returncode is None and process.pid is not None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except OSError:
                    process.kill()
        await asyncio.gather(*internals, return_exceptions=True)
        await db.close()
        await counters.aclose()


class _PrintTelemetry:
    def emit(self, name: str, attributes: Mapping[str, str]) -> None:
        safe = {key: value for key, value in attributes.items() if "token" not in key and "secret" not in key}
        print(f"event {name} {safe}")


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        sys.exit(0)
