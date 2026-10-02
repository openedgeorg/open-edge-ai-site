"""In-process knowledge server. Tokens are checked against the live primary row."""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, cast

import httpx
import psycopg

from esp_contracts.runtime import AuthorityRecord
from esp_db.authority import read_current_authority
from esp_db.client import Db, open_db
from esp_execution_bindings.binding import TokenSigner, TokenVerifier, mint_operation_authority, mint_setup_authority
from esp_execution_bindings.dispatch_fence import revoke_incarnation
from esp_mcp.authz import AuthorityReader, KnowledgeDependencies
from esp_mcp.retrieve import KnowledgeCorpus
from esp_mcp.server import build_knowledge_server
from tests.support.corpus_lab import MCP_DSN, CorpusLab, build_corpus_lab
from tests.support.database import APP_DSN

HASH = "a" * 64
TOKEN_HEADER = "esp-knowledge-token"
SESSION_HEADER = "mcp-session-id"
PROTOCOL = "2025-11-25"
ProviderName = Literal["openai", "xai"]


@dataclass
class _Run:
    provider: ProviderName
    conversation_id: uuid.UUID
    session_id: uuid.UUID
    instance_id: uuid.UUID
    incarnation_id: uuid.UUID
    run_id: uuid.UUID
    release_id: str
    qualification_id: str
    deployment_id: str
    knowledge_token: str
    inference_token: str
    setup_token: str


class _Down:
    def connection(self) -> None:
        raise psycopg.OperationalError("down")


class McpLab:
    def __init__(
        self,
        corpus_lab: CorpusLab,
        authority_db: Db,
        deps: KnowledgeDependencies,
        app_db: Db,
        runs: dict[ProviderName, _Run],
        verifier: TokenVerifier,
    ) -> None:
        self.corpus_lab = corpus_lab
        self.authority_db = authority_db
        self.deps = deps
        self.app_db = app_db
        self.runs = runs
        self.verifier = verifier
        self.gateway_calls = 0
        self.instructions: str | None = None
        self._client: httpx.AsyncClient | None = None
        self._sessions: dict[ProviderName, str] = {}
        self._ids = 0
        self._app: Any = None
        self._lifespan: asyncio.Task[None] | None = None
        self._shutdown = asyncio.Event()
        self._stopped = asyncio.Event()
        self._started = False

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError("lab client is closed")
        return self._client

    async def open(self) -> None:
        self._app = build_knowledge_server(self.deps)
        ready = asyncio.Event()
        failed: list[BaseException] = []

        async def receive() -> dict[str, Any]:
            if not self._started:
                self._started = True
                return {"type": "lifespan.startup"}
            await self._shutdown.wait()
            return {"type": "lifespan.shutdown"}

        async def send(message: dict[str, Any]) -> None:
            kind = message["type"]
            if kind == "lifespan.startup.complete":
                ready.set()
            elif kind == "lifespan.startup.failed":
                failed.append(RuntimeError(str(message.get("message", "lifespan failed"))))
                ready.set()
            elif kind == "lifespan.shutdown.complete":
                self._stopped.set()

        self._lifespan = asyncio.create_task(self._app({"type": "lifespan"}, receive, send))
        await asyncio.wait_for(ready.wait(), timeout=5)
        if failed:
            raise failed[0]
        transport = httpx.ASGITransport(app=self._app)
        self._client = httpx.AsyncClient(transport=transport, base_url="http://esp-knowledge")
        await self._client.__aenter__()

    async def close(self) -> None:
        if self._client is not None:
            await self._client.__aexit__(None, None, None)
            self._client = None
        if self._lifespan is not None:
            self._shutdown.set()
            await asyncio.wait_for(self._stopped.wait(), timeout=5)
            await self._lifespan
            self._lifespan = None
        await self.authority_db.close()
        await self.corpus_lab.close()

    async def tool_names(self, provider: ProviderName = "openai") -> list[str]:
        payload = await self._result("tools/list", None, provider)
        tools = payload["tools"]
        assert isinstance(tools, list)
        return [str(tool["name"]) for tool in tools if isinstance(tool, dict)]

    async def tool_contracts(self, provider: ProviderName = "openai") -> list[dict[str, Any]]:
        payload = await self._result("tools/list", None, provider)
        tools = payload["tools"]
        assert isinstance(tools, list)
        contracts: list[dict[str, Any]] = []
        for tool in tools:
            assert isinstance(tool, dict)
            contracts.append(
                {
                    "name": tool["name"],
                    "inputSchema": tool["inputSchema"],
                    "annotations": tool.get("annotations"),
                }
            )
        return sorted(contracts, key=lambda item: str(item["name"]))

    async def stale_call_status(self) -> int:
        await self._ensure_session("openai")
        run = self.runs["openai"]
        async with self.app_db.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    "UPDATE conversation SET active_provider_session_id = NULL WHERE id = %s",
                    (run.conversation_id,),
                )
                await connection.execute(
                    "UPDATE provider_session SET is_current = false WHERE id = %s",
                    (run.session_id,),
                )
        return await self._status("tools/call", _call("esp.search", {"query": "markerbrainfixture"}), "openai")

    async def model_supplied_binding_status(self) -> int:
        arguments = {"query": "markerbrainfixture", "binding": {"conversation_id": "model-supplied"}}
        return await self._status("tools/call", _call("esp.search", arguments), "openai")

    async def wrong_audience_status(self) -> int:
        await self._ensure_session("openai")
        return await self._status(
            "tools/call",
            _call("esp.search", {"query": "markerbrainfixture"}),
            "openai",
            token=self.runs["openai"].inference_token,
        )

    async def setup_token_status(self) -> int:
        await self._ensure_session("openai")
        return await self._status(
            "tools/call",
            _call("esp.get_claim", {"claim_id": "fixture-claim"}),
            "openai",
            token=self.runs["openai"].setup_token,
        )

    async def revoked_incarnation_status(self) -> int:
        await self._ensure_session("openai")
        run = self.runs["openai"]
        revoked = await revoke_incarnation(self.app_db, str(run.instance_id), str(run.incarnation_id))
        assert str(run.session_id) in revoked
        return await self._status("tools/call", _call("esp.get_source", {"source_id": "src-versioned"}), "openai")

    async def authority_outage_status(self) -> int:
        await self._ensure_session("openai")
        saved = self.deps.authority.db.pool
        self.deps.authority.db.pool = _Down()  # type: ignore[assignment]
        try:
            return await self._status("tools/call", _call("esp.get_current_value", {"key": "fixture.asof"}), "openai")
        finally:
            self.deps.authority.db.pool = saved

    async def missing_token_status(self) -> int:
        return await self._status(
            "tools/call",
            _call("esp.search", {"query": "markerbrainfixture"}),
            "openai",
            token="",
            session="forged-session-id",
        )

    async def forged_session_with_token_status(self) -> int:
        await self._ensure_session("openai")
        return await self._status(
            "tools/call",
            _call("esp.search", {"query": "privatecanarytoken"}),
            "openai",
            session="forged-session-id",
        )

    async def method_status(self, method: str, params: dict[str, Any] | None = None) -> int:
        await self._ensure_session("openai")
        return await self._status(method, params, "openai")

    async def write_tool_status(self) -> int:
        await self._ensure_session("openai")
        return await self._status("tools/call", _call("esp.write", {"path": "README.md"}), "openai")

    async def call_json(
        self, name: str, arguments: dict[str, Any], provider: ProviderName = "openai"
    ) -> dict[str, Any]:
        payload = await self._result("tools/call", _call(name, arguments), provider)
        return _structured(payload)

    async def current_value_outage(self) -> dict[str, Any]:
        await self._ensure_session("openai")
        saved = self.deps.corpus.db.pool
        self.deps.corpus.db.pool = _Down()  # type: ignore[assignment]
        try:
            return await self.call_json("esp.get_current_value", {"key": "fixture.asof"})
        finally:
            self.deps.corpus.db.pool = saved

    async def write_sqlstate(self) -> str:
        try:
            async with self.deps.corpus.db.pool.connection() as connection:
                async with connection.transaction():
                    await connection.execute(
                        """
                        INSERT INTO knowledge.corpus_release (
                            id, status, embedding_revision, embedding_dimension,
                            tokenizer_revision, created_at
                        ) VALUES (%s, 'draft', 'fixture-local-384', 384, 'fixture-whitespace-v1', now())
                        """,
                        (f"fixture-draft-mcp-server-{uuid.uuid4().hex}",),
                    )
        except psycopg.Error as exc:
            return exc.sqlstate or ""
        return ""

    async def gateway_view_sqlstate(self) -> str:
        try:
            async with self.deps.authority.db.pool.connection() as connection:
                await connection.execute("SELECT conversation_id FROM current_authority LIMIT 1")
        except psycopg.Error as exc:
            return exc.sqlstate or ""
        return ""

    async def knowledge_view_visible(self) -> bool:
        async with self.deps.authority.db.pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT corpus_release_id FROM knowledge_authority WHERE provider_session_id = %s",
                (str(self.runs["openai"].session_id),),
            )
            row = await cursor.fetchone()
        return row is not None and row["corpus_release_id"] == self.corpus_lab.corpus_id

    async def _ensure_session(self, provider: ProviderName) -> str:
        existing = self._sessions.get(provider)
        if existing is not None:
            return existing
        self._ids += 1
        response = await self._post(
            {
                "jsonrpc": "2.0",
                "id": self._ids,
                "method": "initialize",
                "params": {
                    "protocolVersion": PROTOCOL,
                    "capabilities": {},
                    "clientInfo": {"name": f"esp-{provider}", "version": "0"},
                },
            },
            provider,
            session=None,
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert isinstance(body, dict)
        result = body["result"]
        assert isinstance(result, dict)
        instructions = result.get("instructions")
        self.instructions = instructions if isinstance(instructions, str) else None
        capabilities = result["capabilities"]
        assert isinstance(capabilities, dict)
        assert "tools" in capabilities
        assert "prompts" not in capabilities
        assert "resources" not in capabilities
        assert "sampling" not in capabilities
        session = response.headers[SESSION_HEADER]
        self._sessions[provider] = session
        self._ids += 1
        noted = await self._post(
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            provider,
            session=session,
        )
        assert noted.status_code == 202, noted.text
        return session

    async def _result(self, method: str, params: dict[str, Any] | None, provider: ProviderName) -> dict[str, Any]:
        response = await self._exchange(method, params, provider)
        assert response.status_code == 200, response.text
        body = response.json()
        assert isinstance(body, dict)
        assert "error" not in body, body
        result = body["result"]
        assert isinstance(result, dict)
        return result

    async def _status(
        self,
        method: str,
        params: dict[str, Any] | None,
        provider: ProviderName,
        *,
        token: str | None = None,
        session: str | None = None,
    ) -> int:
        response = await self._exchange(method, params, provider, token=token, session=session)
        return response.status_code

    async def _exchange(
        self,
        method: str,
        params: dict[str, Any] | None,
        provider: ProviderName,
        *,
        token: str | None = None,
        session: str | None = None,
    ) -> httpx.Response:
        if session is None and token is None:
            session = await self._ensure_session(provider)
        message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if method != "notifications/initialized":
            self._ids += 1
            message["id"] = self._ids
        if params is not None:
            message["params"] = params
        return await self._post(message, provider, session=session, token=token)

    async def _post(
        self,
        message: dict[str, Any],
        provider: ProviderName,
        *,
        session: str | None,
        token: str | None = None,
    ) -> httpx.Response:
        selected = self.runs[provider].knowledge_token if token is None else token
        headers = {
            "accept": "application/json, text/event-stream",
            "content-type": "application/json",
        }
        if selected:
            headers[TOKEN_HEADER] = selected
        if session:
            headers[SESSION_HEADER] = session
            headers["mcp-protocol-version"] = PROTOCOL
        return await self.client.post("/mcp", headers=headers, json=message)


def _call(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {"name": name, "arguments": arguments}


def _structured(payload: dict[str, Any]) -> dict[str, Any]:
    structured = payload.get("structuredContent")
    if isinstance(structured, dict):
        return cast(dict[str, Any], structured)
    content = payload["content"]
    assert isinstance(content, list) and content
    first = content[0]
    assert isinstance(first, dict)
    parsed = json.loads(str(first["text"]))
    assert isinstance(parsed, dict)
    return cast(dict[str, Any], parsed)


async def build_mcp_lab(root: Path) -> McpLab:
    corpus_lab = await build_corpus_lab(root)
    authority_db = await open_db(MCP_DSN)
    signer, verifier = TokenSigner.generate()
    try:
        openai_run = await _seed(corpus_lab.app, signer, corpus_lab.corpus_id, "openai")
        xai_run = await _seed(corpus_lab.app, signer, corpus_lab.corpus_id, "xai")
    except Exception:
        await authority_db.close()
        await corpus_lab.close()
        raise
    deps = KnowledgeDependencies(
        authority=AuthorityReader(db=authority_db, verifier=verifier),
        corpus=KnowledgeCorpus(corpus_lab.mcp, corpus_lab.store, corpus_lab.embedder),
        embedder=corpus_lab.embedder,
        inspection_identity="inspection-fixture",
        telemetry=[],
    )
    lab = McpLab(
        corpus_lab,
        authority_db,
        deps,
        corpus_lab.app,
        {"openai": openai_run, "xai": xai_run},
        verifier,
    )
    try:
        await lab.open()
    except Exception:
        await lab.close()
        raise
    return lab


async def _seed(app: Db, signer: TokenSigner, corpus_id: str, provider: ProviderName) -> _Run:
    run = _Run(
        provider=provider,
        conversation_id=uuid.uuid4(),
        session_id=uuid.uuid4(),
        instance_id=uuid.uuid4(),
        incarnation_id=uuid.uuid4(),
        run_id=uuid.uuid4(),
        release_id=f"brain-{uuid.uuid4()}",
        qualification_id=f"qual-{uuid.uuid4()}",
        deployment_id=f"deploy-{uuid.uuid4()}",
        knowledge_token="",
        inference_token="",
        setup_token="",
    )
    lease = datetime.now(UTC) + timedelta(minutes=15)
    now = datetime.now(UTC)
    async with app.pool.connection() as connection:
        async with connection.transaction():
            await connection.execute(
                """
                INSERT INTO brain_release (
                    version, sha256, behavior_version, behavior_sha256, source_revision,
                    artifact_ref, behavior_artifact_ref, corpus_release_id, status, created_at
                ) VALUES (%s, %s, 'behavior-a', %s, 'synthetic-canary', 'draft://brain', 'draft://behavior',
                    %s, 'draft', %s)
                """,
                (run.release_id, HASH, HASH, corpus_id, now),
            )
            await connection.execute(
                """
                INSERT INTO runtime_qualification (id, design_assumption_id, provider, status)
                VALUES (%s, 'DA-01', %s, 'pending')
                """,
                (run.qualification_id, provider),
            )
            await connection.execute(
                """
                INSERT INTO provider_deployment (
                    id, provider, model, harness_revision, configuration_digest, gateway_route,
                    shared_process_qualification_id, deployed_at
                ) VALUES (%s, %s, 'candidate-model', 'rev-test', 'cfg-test', 'gateway-test', %s, %s)
                """,
                (run.deployment_id, provider, run.qualification_id, now),
            )
            await connection.execute(
                """
                INSERT INTO harness_instance (
                    id, provider, worker_id, process_incarnation_id, deployment_ref, native_storage_unit_id,
                    lifecycle_status, resident_session_limit, active_turn_limit, last_heartbeat_at
                ) VALUES (%s, %s, 'worker-a', %s, %s, 'volume-a', 'ready', 2, 2, %s)
                """,
                (run.instance_id, provider, run.incarnation_id, run.deployment_id, now),
            )
            await connection.execute(
                """
                INSERT INTO conversation (
                    id, owner_subject_id, provider, brain_release_id, behavior_version, behavior_hash,
                    corpus_release_id, status, created_at, updated_at
                ) VALUES (%s, 'subject-a', %s, %s, 'behavior-a', %s, %s, 'active', %s, %s)
                """,
                (run.conversation_id, provider, run.release_id, HASH, corpus_id, now, now),
            )
            await connection.execute(
                """
                INSERT INTO provider_session (
                    id, conversation_id, provider, session_generation, is_current, native_session_id, model,
                    brain_release_id, brain_hash, behavior_version, behavior_hash, corpus_release_id,
                    deployment_ref, runtime_state, harness_instance_id, runtime_incarnation_id,
                    native_storage_unit_id, state_location, ownership_epoch, owner_lease_expires_at,
                    active_agent_run_id, active_agent_run_expires_at, recovery_count, created_at, last_used_at
                ) VALUES (
                    %s, %s, %s, 1, true, 'native-a', 'candidate-model', %s, %s, 'behavior-a', %s,
                    %s, %s, 'running', %s, %s, 'volume-a', 'location-a', 1, %s, %s, %s, 0, %s, %s
                )
                """,
                (
                    run.session_id,
                    run.conversation_id,
                    provider,
                    run.release_id,
                    HASH,
                    HASH,
                    corpus_id,
                    run.deployment_id,
                    run.instance_id,
                    run.incarnation_id,
                    lease,
                    run.run_id,
                    lease,
                    now,
                    now,
                ),
            )
            await connection.execute(
                "UPDATE conversation SET active_provider_session_id = %s WHERE id = %s",
                (run.session_id, run.conversation_id),
            )
    record = await read_current_authority(app, str(run.session_id))
    if record is None:
        raise AssertionError("current authority missing")
    _require_record(record, corpus_id)
    minted = mint_operation_authority(record, signer=signer)
    run.knowledge_token = minted.knowledge_token
    run.inference_token = minted.inference_token
    run.setup_token = mint_setup_authority(record, signer=signer)
    return run


def _require_record(record: AuthorityRecord, corpus_id: str) -> None:
    if record.corpus_release_id != corpus_id or record.native_session_id is None:
        raise AssertionError("seed record is not executable")


def assert_app_dsn_is_not_the_mcp_role() -> None:
    assert APP_DSN != MCP_DSN
