"""Real-socket upstream and a PostgreSQL-backed gateway lab."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from esp_contracts.release import ReleaseManifest
from esp_db.authority import read_current_authority
from esp_db.client import Db, open_db, transaction
from esp_espcon.brain_registry import ResolvedRelease
from esp_execution_bindings.binding import AuthorizationError, TokenSigner, mint_operation_authority
from esp_execution_bindings.dispatch_fence import revoke_mapping
from esp_inference_gateway.evidence_recorder import (
    EvidenceError,
    EvidenceKey,
    EvidenceRecorder,
    MemoryOutcomeStore,
    load_proof,
    record_outcome,
    reference_parts,
)
from esp_inference_gateway.server import GatewayDependencies, dispatch_inference
from esp_inference_gateway.transport import ApprovedRoute, FencedTransport
from esp_object_store.store import FileObjectStore
from scripts.migrate import migrate
from tests.support.database import APP_DSN

BRAIN = "synthetic-canary brain\r\ncafé\n".encode()
BEHAVIOR = b"synthetic-canary behavior\n"


@dataclass
class Trace:
    steps: list[str]
    provider_body: bytes
    decrypted_evidence_body: bytes
    status: int
    upstream_headers: dict[str, str]
    inference_id: str
    request_ref: str
    proof_ref: str
    response_body: bytes
    proof: dict[str, object]


class WireServer:
    def __init__(self) -> None:
        self.requests = 0
        self.accepts = 0
        self.bodies: list[bytes] = []
        self.headers: dict[str, str] = {}
        self.status = 200
        self.response_body = b"data: hello\n\n"
        self.chunks: list[bytes] | None = None
        self.hold_headers = False
        self.drop_early = False
        self.close_before_headers = False
        self.release_headers = asyncio.Event()
        self.release_headers.set()
        self.got_body = asyncio.Event()
        self.url = ""
        self._server: asyncio.Server | None = None

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        sockets = self._server.sockets or []
        port = sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{port}/v1/responses"

    def close(self) -> None:
        self.release_headers.set()
        if self._server is not None:
            self._server.close()

    async def wait_closed(self) -> None:
        if self._server is not None:
            await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.accepts += 1
        try:
            headers, body = await _read_http(reader)
        except Exception:
            writer.close()
            return
        self.requests += 1
        self.headers = headers
        self.bodies.append(body)
        self.got_body.set()
        if self.hold_headers:
            await self.release_headers.wait()
        try:
            if self.close_before_headers:
                writer.close()
                await writer.wait_closed()
                return
            if self.drop_early:
                writer.write(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"
                )
                writer.write(b"4\r\npart\r\n")
                await writer.drain()
                writer.close()
                return
            writer.write(_response(self.status, self.response_body, self.chunks))
            await writer.drain()
        finally:
            writer.close()


class WireLab:
    def __init__(
        self,
        db: Db,
        server: WireServer,
        deps: GatewayDependencies,
        token: str,
        knowledge_token: str,
        raw: bytes,
        session_id: uuid.UUID,
        incarnation_id: uuid.UUID,
        store: FileObjectStore,
        key: EvidenceKey,
    ) -> None:
        self.db = db
        self.server = server
        self.deps = deps
        self.token = token
        self.knowledge_token = knowledge_token
        self.raw = raw
        self.session_id = session_id
        self.incarnation_id = incarnation_id
        self.store = store
        self.key = key
        self.handed_off = asyncio.Event()
        self.steps = deps.steps

    @property
    def transport(self) -> FencedTransport:
        return self.deps.transport

    async def close(self) -> None:
        self.server.release_headers.set()
        self.transport.probe.allow_write.set()
        await self.transport.aclose()
        self.server.close()
        await self.server.wait_closed()
        try:
            await self.db.close()
        except Exception:
            return

    async def forward_one(self) -> Trace:
        self.steps.clear()
        self.handed_off.clear()
        ticket = await dispatch_inference(self.deps, token=self.token, raw=self.raw, provider="openai")
        self.handed_off.set()
        upstream = await ticket.response
        response_body = bytearray()
        async for chunk in upstream.body:
            response_body.extend(chunk)
        request_ref = ticket.initiation["request_ref"]
        proof_ref = ticket.initiation["proof_ref"]
        decrypted = self.key.decrypt(await _object(self.store, request_ref))
        proof = load_proof(await _object(self.store, proof_ref))
        return Trace(
            steps=list(self.steps),
            provider_body=self.server.bodies[-1],
            decrypted_evidence_body=decrypted,
            status=upstream.status,
            upstream_headers=dict(self.server.headers),
            inference_id=ticket.inference_id,
            request_ref=request_ref,
            proof_ref=proof_ref,
            response_body=bytes(response_body),
            proof=proof,
        )

    async def starts_after_evidence_failure(self) -> int:
        before = self.server.requests
        self.deps.recorder.fail = True
        try:
            await self.forward_one()
        except EvidenceError:
            return self.server.requests - before
        finally:
            self.deps.recorder.fail = False
        return self.server.requests - before + 1

    async def starts_when_process_revocation_wins(self) -> int:
        before = self.server.requests
        async with transaction(self.db) as tx:
            row = await tx.execute_one(
                "SELECT esp_try_fence(%s, %s, true) AS locked",
                (str(self.incarnation_id), str(self.session_id)),
            )
            if row is None or row["locked"] is not True:
                return 1
            try:
                await dispatch_inference(self.deps, token=self.token, raw=self.raw, provider="openai")
            except AuthorizationError:
                return self.server.requests - before
        return self.server.requests - before + 1

    async def stale_mutations_when_dispatch_wins(self) -> int:
        before = self.server.requests
        self.transport.probe.write_reached.clear()
        self.transport.probe.allow_write.clear()
        task = asyncio.create_task(self.forward_one())
        await asyncio.wait_for(self.transport.probe.write_reached.wait(), timeout=5)
        revoked = await revoke_mapping(self.db, str(self.session_id), 1)
        self.transport.probe.allow_write.set()
        await asyncio.wait_for(task, timeout=5)
        epoch = await self._epoch()
        if revoked or epoch != 1 or self.server.requests != before + 1:
            return 1
        return 0

    async def starts_when_database_is_lost(self) -> int:
        before = self.server.requests
        await self.db.close()
        try:
            await self.forward_one()
        except Exception:
            return self.server.requests - before
        return self.server.requests - before + 1

    async def starts_after_lease_expiry(self) -> int:
        before = self.server.requests
        async with self.db.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    UPDATE provider_session
                    SET owner_lease_expires_at = now() - interval '1 minute',
                        active_agent_run_expires_at = now() - interval '1 minute'
                    WHERE id = %s
                    """,
                    (self.session_id,),
                )
        try:
            await self.forward_one()
        except AuthorizationError:
            return self.server.requests - before
        return self.server.requests - before + 1

    async def fence_released_before_response_headers(self) -> bool:
        self.server.hold_headers = True
        self.server.release_headers.clear()
        task = asyncio.create_task(self.forward_one())
        await asyncio.wait_for(self.handed_off.wait(), timeout=5)
        async with transaction(self.db) as tx:
            row = await tx.execute_one(
                "SELECT esp_try_fence(%s, %s, true) AS locked",
                (str(self.incarnation_id), str(self.session_id)),
            )
        locked = row is not None and row["locked"] is True
        self.server.release_headers.set()
        await asyncio.wait_for(task, timeout=5)
        return locked

    async def lost_outcome_does_not_replay(self) -> int:
        trace = await self.forward_one()
        count = self.server.requests
        self.deps.outcome.fail = True
        try:
            status = await record_outcome(self.deps.outcome, trace.inference_id, "complete")
        finally:
            self.deps.outcome.fail = False
        if status != "uncertain" or self.server.requests != count:
            return count + 1
        return count

    async def _epoch(self) -> int:
        async with transaction(self.db) as tx:
            row = await tx.execute_one(
                "SELECT ownership_epoch FROM provider_session WHERE id = %s",
                (self.session_id,),
            )
        if row is None:
            return -1
        value = row["ownership_epoch"]
        return int(value) if isinstance(value, int) else -1


async def build_wire_lab(
    root: Path,
    user_text: str = "visitor pasted ----- BEGIN ESP CORE BRAIN vcanary -----",
) -> WireLab:
    await migrate(APP_DSN)
    db = await open_db(APP_DSN)
    server = WireServer()
    await server.start()
    brain_hash = hashlib.sha256(BRAIN).hexdigest()
    behavior_hash = hashlib.sha256(BEHAVIOR).hexdigest()
    release_id = f"brain-{uuid.uuid4()}"
    seed = _ids()
    now = datetime.now(UTC)
    lease = now + timedelta(minutes=15)
    async with db.pool.connection() as connection:
        async with connection.transaction():
            await connection.execute(
                """
                INSERT INTO brain_release (
                    version, sha256, behavior_version, behavior_sha256, source_revision,
                    artifact_ref, behavior_artifact_ref, corpus_release_id, status, created_at
                ) VALUES (%s, %s, 'canary', %s, 'synthetic-canary', 'draft://brain', 'draft://behavior',
                    'fixture-corpus', 'draft', %s)
                """,
                (release_id, brain_hash, behavior_hash, now),
            )
            await connection.execute(
                """
                INSERT INTO runtime_qualification (id, design_assumption_id, provider, status)
                VALUES (%s, 'DA-01', 'openai', 'pending')
                """,
                (seed["qualification_id"],),
            )
            await connection.execute(
                """
                INSERT INTO provider_deployment (
                    id, provider, model, harness_revision, configuration_digest, gateway_route,
                    shared_process_qualification_id, deployed_at
                ) VALUES (%s, 'openai', 'candidate-model', 'rev-test', 'cfg-test', 'gateway-test', %s, %s)
                """,
                (seed["deployment_id"], seed["qualification_id"], now),
            )
            await connection.execute(
                """
                INSERT INTO harness_instance (
                    id, provider, worker_id, process_incarnation_id, deployment_ref, native_storage_unit_id,
                    lifecycle_status, resident_session_limit, active_turn_limit, last_heartbeat_at
                ) VALUES (%s, 'openai', 'worker-a', %s, %s, 'volume-a', 'ready', 2, 2, %s)
                """,
                (seed["instance_id"], seed["incarnation_id"], seed["deployment_id"], now),
            )
            await connection.execute(
                """
                INSERT INTO conversation (
                    id, owner_subject_id, provider, brain_release_id, behavior_version, behavior_hash,
                    corpus_release_id, status, created_at, updated_at
                ) VALUES (%s, 'subject-a', 'openai', %s, 'canary', %s, 'fixture-corpus', 'active', %s, %s)
                """,
                (seed["conversation_id"], release_id, behavior_hash, now, now),
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
                    %s, %s, 'openai', 1, true, 'native-a', 'candidate-model', %s, %s, 'canary', %s,
                    'fixture-corpus', %s, 'running', %s, %s, 'volume-a', 'location-a', 1, %s, %s, %s, 0, %s, %s
                )
                """,
                (
                    seed["session_id"],
                    seed["conversation_id"],
                    release_id,
                    brain_hash,
                    behavior_hash,
                    seed["deployment_id"],
                    seed["instance_id"],
                    seed["incarnation_id"],
                    lease,
                    seed["run_id"],
                    lease,
                    now,
                    now,
                ),
            )
            await connection.execute(
                "UPDATE conversation SET active_provider_session_id = %s WHERE id = %s",
                (seed["session_id"], seed["conversation_id"]),
            )
    record = await read_current_authority(db, str(seed["session_id"]))
    if record is None:
        raise AssertionError("authority row missing")
    signer, verifier = TokenSigner.generate()
    tokens = mint_operation_authority(record, signer=signer)
    manifest = ReleaseManifest(
        brain_version="canary",
        canonical_brain_sha256=brain_hash,
        canonical_brain_bytes=len(BRAIN),
        behavior_version="canary",
        behavior_sha256=behavior_hash,
        behavior_bytes=len(BEHAVIOR),
        source_revision="synthetic-canary",
        created_at=now,
        status="draft",
        brain_artifact_ref="draft://brain",
        behavior_artifact_ref="draft://behavior",
        corpus_release_id="fixture-corpus",
    )
    release = ResolvedRelease(release_id=release_id, manifest=manifest, brain_bytes=BRAIN, behavior_bytes=BEHAVIOR)
    key = EvidenceKey(os.urandom(32))
    store = FileObjectStore(root)
    route = ApprovedRoute(
        provider="openai",
        method="POST",
        url=server.url,
        model="candidate-model",
        credential_ref="openai-test",
    )
    transport = FencedTransport({"openai-test": "gw-test-secret"})
    deps = GatewayDependencies(
        db=db,
        verifier=verifier,
        release=release,
        recorder=EvidenceRecorder(store, key),
        routes={"openai": route},
        transport=transport,
        outcome=MemoryOutcomeStore(),
    )
    raw = json.dumps(
        {"model": "candidate-model", "input": [{"role": "user", "content": user_text}]},
        separators=(",", ":"),
    ).encode()
    return WireLab(
        db,
        server,
        deps,
        tokens.inference_token,
        tokens.knowledge_token,
        raw,
        seed["session_id"],
        seed["incarnation_id"],
        store,
        key,
    )


def _ids() -> dict[str, Any]:
    return {
        "conversation_id": uuid.uuid4(),
        "session_id": uuid.uuid4(),
        "instance_id": uuid.uuid4(),
        "incarnation_id": uuid.uuid4(),
        "run_id": uuid.uuid4(),
        "qualification_id": f"qual-{uuid.uuid4()}",
        "deployment_id": f"deploy-{uuid.uuid4()}",
    }


async def _object(store: FileObjectStore, reference: str) -> bytes:
    key, version = reference_parts(reference)
    return await store.get(key, version)


async def _read_http(reader: asyncio.StreamReader) -> tuple[dict[str, str], bytes]:
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = await reader.read(4096)
        if not chunk:
            break
        data += chunk
    head, rest = data.split(b"\r\n\r\n", 1)
    headers: dict[str, str] = {}
    for line in head.split(b"\r\n")[1:]:
        name, value = line.split(b":", 1)
        headers[name.decode().lower()] = value.decode().strip()
    length = int(headers.get("content-length", "0"))
    body = rest
    while len(body) < length:
        body += await reader.readexactly(length - len(body))
    return headers, body[:length]


def _response(status: int, body: bytes, chunks: list[bytes] | None) -> bytes:
    if chunks is None:
        reason = "OK" if status == 200 else "RESULT"
        header = (
            f"HTTP/1.1 {status} {reason}\r\nContent-Type: text/event-stream\r\nContent-Length: {len(body)}\r\n\r\n"
        )
        return header.encode() + body
    framed = [f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n" for chunk in chunks]
    head = f"HTTP/1.1 {status} OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n".encode()
    return head + b"".join(framed) + b"0\r\n\r\n"
