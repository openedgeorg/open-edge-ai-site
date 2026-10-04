"""Submission and native-history labs: real PostgreSQL, real Valkey, the real shared native adapter.

The native side is an in-memory harness fake reached through the production `HarnessAdapter` and
`NativeRpcClient`, so acceptance, lost acknowledgements and transport refusals take the adapter's real
paths. Native storage (`NativeStore`) is separate from the processes that mount it (`NativeProcess`), so
a second backend, or a second instance mounting the same storage, sees the same saved sessions. Each
backend connects to each process over its own connection, as separate backends reach a supervisor.

The fake performs no inference. It saves the visitor input it accepts and an answer the lab completes
on its behalf, and it counts every native method it receives, so a status or history read that started
any native work (create, resume, submit, continue) is visible.

It supports operation-specific cancellation and per-session unload, each with switchable faults, and it
announces a work's terminal status as a `session/event` notification (`turn_completed`) on every open
connection. The event carries the identity of the operation that submitted the work, which the harness
learns from the operation scope it was handed at submission, as a real per-operation context would.

Every runtime, release and policy value is a synthetic test identity inherited from `ApiLab` and
`AdmissionLab`; nothing here records or upgrades a validated qualification.
"""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import json
import uuid
from collections import Counter
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, LiteralString, cast

import httpx
from fastapi import FastAPI
from psycopg import AsyncConnection

from esp_api.server import NativeRuntimeAdapter, build_api
from esp_contracts.api import SubmissionView, SubmitMessage
from esp_contracts.ids import Provider
from esp_contracts.runtime import (
    Accepted,
    AuthorizedProvenance,
    HistoryItem,
    NativeEvent,
    NativeHistorySnapshot,
    NativeStatus,
    NativeWorkStatus,
    OperationAuthority,
    RunBinding,
    SessionHandle,
    SessionReservation,
    SubmissionResult,
    WorkRef,
)
from esp_db.client import Transaction
from esp_execution_bindings.binding import TokenSigner, TokenVerifier
from esp_provider_shared.adapter import HarnessAdapter
from esp_provider_shared.rpc import NativeRpcClient
from esp_provider_shared.transport_context import TransportContext
from esp_request_admission.admit import Admitted
from esp_request_admission.rate_limits import RatePolicy
from esp_runtime_harconses.manager import SessionLimits, SessionManager
from esp_runtime_placement.capacity import release_run_slots
from tests.support.admission import (
    LAB_RATE_POLICY,
    AdmissionLab,
    Backend,
    Conv,
    close_admission_lab,
    open_admission_lab,
)
from tests.support.api_lab import APP_ROLE_DSN, Visitor

_METHOD_NOT_FOUND = -32601
_UNKNOWN_NATIVE = -32001
_INTERNAL = -32603
DRAFT = "private draft that only the live request and the native harness may hold"
NATIVE_ANSWER = "Native answer saved by the harness itself."
NativeMethod = Literal[
    "session/create",
    "session/resume",
    "session/submit",
    "session/continue",
    "session/inspect",
    "session/history",
    "session/cancel",
    "session/unload",
]
WORK_METHODS: tuple[NativeMethod, ...] = ("session/create", "session/resume", "session/submit", "session/continue")


class _Lost:
    """The native process saved the request, then the connection carrying its answer ended."""


_LOST = _Lost()


@dataclass
class NativeWork:
    work_ref: str
    request_id: str
    text: str
    status: NativeWorkStatus = "running"
    answer: str | None = None
    partial: str | None = None
    provenance: list[AuthorizedProvenance] = field(default_factory=lambda: [])
    # The submitting operation's identity, from the scope the harness was handed with the input.
    identity: dict[str, object] = field(default_factory=lambda: {})


@dataclass
class NativeSession:
    native_session_id: str
    conversation_id: str
    works: list[NativeWork] = field(default_factory=lambda: [])

    def work_for(self, request_id: str) -> NativeWork | None:
        for work in self.works:
            if work.request_id == request_id:
                return work
        return None


class NativeStore:
    """One native storage unit. Only the harness reads or writes it; ESP sees it only through RPC."""

    def __init__(self, unit_id: str) -> None:
        self.unit_id = unit_id
        self.sessions: dict[str, NativeSession] = {}

    def complete(self, native_session_id: str, request_id: str, answer: str) -> NativeWork:
        work = self.sessions[native_session_id].work_for(request_id)
        if work is None:
            raise AssertionError("the native harness never saved that request")
        work.status = "completed"
        work.answer = answer
        work.partial = None
        return work

    def texts(self, native_session_id: str) -> list[str]:
        session = self.sessions[native_session_id]
        texts: list[str] = []
        for work in session.works:
            texts.append(work.text)
            if work.answer is not None:
                texts.append(work.answer)
        return texts


class NativeProcess:
    """One Shared Harness Instance (ShaHarIns) process at one Process Incarnation (ProInc).

    Fault switches are one-shot: each applies to the next matching request only.
    """

    def __init__(self, instance_id: str, incarnation_id: str, store: NativeStore) -> None:
        self.instance_id = instance_id
        self.incarnation_id = incarnation_id
        self.store = store
        self.loaded: set[str] = set()
        self.connections: list[NativeConnection] = []
        self.calls: Counter[str] = Counter()
        # `interrupt` stops the named running work at once; `ignore` acknowledges and keeps it running;
        # `fail` answers with an error. `unload` releases an idle session; `unsupported` has no such method.
        self.cancel_mode: Literal["interrupt", "ignore", "fail"] = "interrupt"
        self.unload_mode: Literal["unload", "unsupported", "fail"] = "unload"
        self.cancel_requests: list[tuple[str, str]] = []
        self.notifications_sent = 0
        self.submissions: Counter[tuple[str, str]] = Counter()
        self.submitted_tokens: list[tuple[str, str, str]] = []
        self.transient_reads = 0
        self.refuse_send: set[str] = set()
        self.fail: set[str] = set()
        self.hang: set[str] = set()
        self.lose_ack_after_save = False
        self.withhold_submit_ack = False
        self.native_refusal: str | None = None
        self.before: dict[str, Callable[[dict[str, Any]], Awaitable[None]]] = {}
        self.during_read: Callable[[], Awaitable[None]] | None = None

    def connect(self) -> NativeConnection:
        connection = NativeConnection(self)
        self.connections.append(connection)
        return connection

    def work_calls(self) -> int:
        return sum(self.calls[method] for method in WORK_METHODS)

    async def handle(self, message: dict[str, Any]) -> dict[str, Any] | _Lost | None:
        method = str(message["method"])
        params = cast(dict[str, Any], message.get("params") or {})
        request_id = message["id"]
        self.calls[method] += 1
        hook = self.before.pop(method, None)
        if hook is not None:
            await hook(params)
        if method in self.hang:
            self.hang.discard(method)
            return None
        if method in self.fail:
            self.fail.discard(method)
            return _error(request_id, _INTERNAL, "injected_failure")
        if method == "session/create":
            return self._create(request_id, params)
        native_id = params.get("native_session_id")
        if not isinstance(native_id, str) or native_id not in self.store.sessions:
            return _error(request_id, _UNKNOWN_NATIVE, "unknown_native_id")
        session = self.store.sessions[native_id]
        if method == "session/resume":
            self.loaded.add(native_id)
            return _result(request_id, {"native_session_id": native_id})
        if method == "session/submit":
            return self._submit(request_id, session, params)
        if method == "session/cancel":
            return self._cancel(request_id, session, params)
        if method == "session/unload":
            return self._unload(request_id, session)
        if method in ("session/inspect", "session/history"):
            if native_id not in self.loaded:
                # Read from saved storage without making the session resident in this process.
                self.transient_reads += 1
            if self.during_read is not None:
                await self.during_read()
            if method == "session/inspect":
                requested = params.get("request_id")
                return _result(request_id, _status(session, requested if isinstance(requested, str) else None))
            return _result(request_id, _history(session))
        return _error(request_id, _METHOD_NOT_FOUND, "unsupported")

    def _create(self, request_id: object, params: dict[str, Any]) -> dict[str, Any]:
        if params.get("harness_instance_id") != self.instance_id:
            return _error(request_id, _INTERNAL, "wrong_instance")
        if params.get("runtime_incarnation_id") != self.incarnation_id:
            return _error(request_id, _INTERNAL, "wrong_incarnation")
        native_id = f"native-{uuid.uuid4().hex[:12]}"
        self.store.sessions[native_id] = NativeSession(
            native_session_id=native_id, conversation_id=str(params["conversation_id"])
        )
        self.loaded.add(native_id)
        return _result(request_id, {"native_session_id": native_id})

    def _submit(
        self, request_id: object, session: NativeSession, params: dict[str, Any]
    ) -> dict[str, Any] | _Lost | None:
        native_id = session.native_session_id
        if native_id not in self.loaded:
            return _error(request_id, _UNKNOWN_NATIVE, "unknown_native_id")
        client_request_id = str(params["client_request_id"])
        self.submitted_tokens.append((native_id, str(params["inference_token"]), str(params["knowledge_token"])))
        if self.native_refusal is not None:
            code = self.native_refusal
            self.native_refusal = None
            return _result(request_id, {"disposition": "not_submitted", "native_session_id": native_id, "code": code})
        work = NativeWork(
            work_ref=f"work-{uuid.uuid4().hex[:12]}",
            request_id=client_request_id,
            text=params["message"],
            identity=_operation_identity(str(params["inference_token"])),
        )
        session.works.append(work)
        self.submissions[(native_id, client_request_id)] += 1
        if self.lose_ack_after_save:
            self.lose_ack_after_save = False
            return _LOST
        if self.withhold_submit_ack:
            self.withhold_submit_ack = False
            return None
        return _result(
            request_id,
            {"disposition": "accepted", "native_session_id": native_id, "native_work_ref": work.work_ref},
        )

    def _cancel(self, request_id: object, session: NativeSession, params: dict[str, Any]) -> dict[str, Any]:
        """Operation-specific: only the named work of this session is interrupted, never a peer's."""
        native_id = session.native_session_id
        work_ref = str(params.get("native_work_ref"))
        self.cancel_requests.append((native_id, work_ref))
        if self.cancel_mode == "fail":
            return _error(request_id, _INTERNAL, "cancel_failed")
        work = next((item for item in session.works if item.work_ref == work_ref), None)
        if work is not None and work.status == "running" and self.cancel_mode == "interrupt":
            work.status = "interrupted"
            self.announce(session, work)
        return _result(request_id, {"native_session_id": native_id, "outcome": "requested"})

    def _unload(self, request_id: object, session: NativeSession) -> dict[str, Any]:
        """Release one idle session from this process; its saved state stays in the store."""
        native_id = session.native_session_id
        if self.unload_mode == "unsupported":
            return _error(request_id, _METHOD_NOT_FOUND, "unsupported")
        if self.unload_mode == "fail":
            return _error(request_id, _INTERNAL, "unload_failed")
        if any(work.status == "running" for work in session.works):
            return _error(request_id, _INTERNAL, "session_busy")
        self.loaded.discard(native_id)
        return _result(request_id, {"native_session_id": native_id, "outcome": "unloaded"})

    def finish(
        self,
        native_session_id: str,
        request_id: str,
        *,
        status: NativeWorkStatus = "completed",
        answer: str = NATIVE_ANSWER,
        announce: bool = True,
    ) -> NativeWork:
        """The harness ends the work by itself and, unless told not to, announces its terminal status."""
        session = self.store.sessions[native_session_id]
        work = session.work_for(request_id)
        if work is None:
            raise AssertionError("the native harness never saved that request")
        work.status = status
        if status == "completed":
            work.answer = answer
            work.partial = None
        if announce:
            self.announce(session, work)
        return work

    def announce(self, session: NativeSession, work: NativeWork, **identity: object) -> None:
        """A `turn_completed` notification for the work on every open connection to this process.

        `identity` overrides fields of the submitting operation's identity (a stale or forged event).
        """
        merged = {**work.identity, **identity}
        if not merged:
            return
        self.notify(
            "session/event",
            {
                "native_session_id": session.native_session_id,
                "native_work_ref": work.work_ref,
                **merged,
                "payload_type": "turn_completed",
                "payload": {"status": work.status},
            },
        )

    def notify(self, method: str, params: dict[str, Any]) -> None:
        frame = json.dumps({"jsonrpc": "2.0", "method": method, "params": params}).encode()
        for connection in self.connections:
            if not connection.closed:
                connection.push(frame)
        self.notifications_sent += 1


def _operation_identity(inference_token: str) -> dict[str, object]:
    """The operation identity carried in the scope the harness received (`v1.<payload>.<signature>`).

    The fake reads it without verifying, as the harness only relays it; nothing else is decoded.
    """
    parts = inference_token.split(".")
    if len(parts) != 3:
        return {}
    try:
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    except (ValueError, json.JSONDecodeError):
        return {}
    binding = cast(dict[str, Any], payload).get("binding") if isinstance(payload, dict) else None
    if not isinstance(binding, dict):
        return {}
    fields = cast(dict[str, object], binding)
    names = (
        "provider_session_id",
        "session_generation",
        "active_agent_run_id",
        "ownership_epoch",
        "runtime_incarnation_id",
    )
    return {name: fields[name] for name in names if name in fields}


class NativeConnection:
    """One backend's frame transport to one native process."""

    def __init__(self, process: NativeProcess) -> None:
        self._process = process
        self._inbox: asyncio.Queue[bytes] = asyncio.Queue()
        self.closed = False

    async def send_frame(self, payload: bytes) -> None:
        message = cast(dict[str, Any], json.loads(payload))
        method = message.get("method")
        if isinstance(method, str) and method in self._process.refuse_send:
            self._process.refuse_send.discard(method)
            raise ConnectionRefusedError("the transport refused the frame before sending it")
        if "id" not in message:
            return
        reply = await self._process.handle(message)
        if isinstance(reply, _Lost):
            self.closed = True
            self._inbox.put_nowait(b"")
            return
        if reply is not None:
            self._inbox.put_nowait(json.dumps(reply).encode())

    async def recv_frame(self) -> bytes:
        return await self._inbox.get()

    def push(self, frame: bytes) -> None:
        """A frame the native process sends without a request: a notification."""
        self._inbox.put_nowait(frame)


def _result(request_id: object, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: object, code: int, data_code: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": data_code, "data": {"code": data_code}},
    }


def _status(session: NativeSession, request_id: str | None) -> dict[str, Any]:
    if request_id is not None:
        work = session.work_for(request_id)
        if work is None:
            latest = session.works[-1].status if session.works else "idle"
            status = NativeStatus(status=latest, request_id=request_id, saved_input_available=False)
        else:
            status = NativeStatus(
                status=work.status, native_work_ref=work.work_ref, request_id=request_id, saved_input_available=True
            )
    elif session.works:
        latest_work = session.works[-1]
        status = NativeStatus(
            status=latest_work.status, native_work_ref=latest_work.work_ref, saved_input_available=True
        )
    else:
        status = NativeStatus(status="idle", saved_input_available=False)
    return {"native_session_id": session.native_session_id, **status.model_dump(mode="json")}


def _history(session: NativeSession) -> dict[str, Any]:
    items: list[HistoryItem] = []
    provenance: list[AuthorizedProvenance] = []
    for work in session.works:
        items.append(
            HistoryItem(
                native_item_id=f"{work.work_ref}:user", native_work_ref=work.work_ref, role="user", text=work.text
            )
        )
        answer = work.answer if work.answer is not None else work.partial
        if answer is not None:
            items.append(
                HistoryItem(
                    native_item_id=f"{work.work_ref}:assistant",
                    native_work_ref=work.work_ref,
                    role="assistant",
                    text=answer,
                )
            )
        provenance.extend(work.provenance)
    snapshot = NativeHistorySnapshot(
        items=items,
        native_cursor=None,
        status=NativeStatus.model_validate(
            {k: v for k, v in _status(session, None).items() if k != "native_session_id"}
        ),
        provenance=provenance,
    )
    return {"native_session_id": session.native_session_id, **snapshot.model_dump(mode="json")}


class NativeCluster:
    """Every native process of one provider pool, by Shared Harness Instance (ShaHarIns) ID."""

    def __init__(self) -> None:
        self.processes: dict[str, NativeProcess] = {}
        self.stores: dict[str, NativeStore] = {}

    def add(self, instance_id: str, incarnation_id: str, unit_id: str) -> NativeProcess:
        store = self.stores.setdefault(unit_id, NativeStore(unit_id))
        process = NativeProcess(instance_id, incarnation_id, store)
        self.processes[instance_id] = process
        return process

    def session_store(self, native_session_id: str) -> NativeStore:
        for store in self.stores.values():
            if native_session_id in store.sessions:
                return store
        raise AssertionError(f"no store holds {native_session_id}")

    def work_calls(self) -> int:
        return sum(process.work_calls() for process in self.processes.values())

    def total_calls(self) -> int:
        return sum(sum(process.calls.values()) for process in self.processes.values())

    def submissions(self, request_id: str) -> int:
        return sum(
            count
            for process in self.processes.values()
            for (_native, request), count in process.submissions.items()
            if request == request_id
        )


class PoolClient:
    """One backend's client for one provider pool.

    It addresses the Shared Harness Instance (ShaHarIns) named by each reservation or handle, over that
    backend's own connection to it, as a supervisor control channel would, and refuses a handle whose
    Process Incarnation (ProInc) is not the instance's current one.
    """

    def __init__(self, cluster: NativeCluster) -> None:
        self._cluster = cluster
        self._adapters: dict[tuple[str, str], tuple[HarnessAdapter, NativeConnection]] = {}
        self.calls: Counter[str] = Counter()
        self.connections = 0
        self.refreshed: list[tuple[str, str, str]] = []

    def _adapter(self, instance_id: str, incarnation_id: str) -> HarnessAdapter:
        """The backend's adapter for that process; a connection that ended is replaced by a new one."""
        process = self._cluster.processes.get(instance_id)
        if process is None or process.incarnation_id != incarnation_id:
            raise RuntimeError("no current process for that instance and incarnation")
        key = (instance_id, incarnation_id)
        cached = self._adapters.get(key)
        if cached is None or cached[1].closed:
            connection = process.connect()
            cached = (HarnessAdapter(NativeRpcClient(connection), TransportContext()), connection)
            self._adapters[key] = cached
            self.connections += 1
        return cached[0]

    async def create_session(self, reservation: SessionReservation) -> SessionHandle:
        self.calls["create_session"] += 1
        adapter = self._adapter(reservation.harness_instance_id, reservation.runtime_incarnation_id)
        return await adapter.create_session(reservation)

    async def resume_session(self, handle: SessionHandle) -> SessionHandle:
        self.calls["resume_session"] += 1
        return await self._adapter(handle.harness_instance_id, handle.runtime_incarnation_id).resume_session(handle)

    async def submit(
        self, handle: SessionHandle, message: SubmitMessage, authority: OperationAuthority
    ) -> SubmissionResult:
        self.calls["submit"] += 1
        adapter = self._adapter(handle.harness_instance_id, handle.runtime_incarnation_id)
        return await adapter.submit(handle, message, authority)

    async def inspect(self, handle: SessionHandle, request_id: str | None = None) -> NativeStatus:
        self.calls["inspect"] += 1
        return await self._adapter(handle.harness_instance_id, handle.runtime_incarnation_id).inspect(
            handle, request_id
        )

    async def read_history(self, handle: SessionHandle) -> NativeHistorySnapshot:
        self.calls["read_history"] += 1
        adapter = self._adapter(handle.harness_instance_id, handle.runtime_incarnation_id)
        return await adapter.read_history(handle)

    async def cancel(self, handle: SessionHandle, work: WorkRef) -> Literal["requested", "stopped", "unknown"]:
        self.calls["cancel"] += 1
        return await self._adapter(handle.harness_instance_id, handle.runtime_incarnation_id).cancel(handle, work)

    async def unload(self, handle: SessionHandle) -> Literal["unloaded", "unsupported"]:
        self.calls["unload"] += 1
        return await self._adapter(handle.harness_instance_id, handle.runtime_incarnation_id).unload(handle)

    async def refresh_tokens(self, handle: SessionHandle, authority: OperationAuthority) -> None:
        self.calls["refresh_tokens"] += 1
        self.refreshed.append((handle.native_session_id, authority.inference_token, authority.knowledge_token))
        adapter = self._adapter(handle.harness_instance_id, handle.runtime_incarnation_id)
        adapter.transport.refresh_tokens(handle.native_session_id, authority.inference_token, authority.knowledge_token)

    def take_control_events(self) -> list[NativeEvent]:
        """Notifications already read by this backend's open connections. Not a request."""
        events: list[NativeEvent] = []
        for adapter, _connection in self._adapters.values():
            drain = getattr(adapter, "drain_events", None)
            if not callable(drain):
                continue
            drained = drain()
            if isinstance(drained, list):
                events.extend(item for item in drained if isinstance(item, NativeEvent))
        return events

    def pending_control_events(self) -> int:
        """Events sitting on open connections that no consumer has taken."""
        pending = 0
        for adapter, _connection in self._adapters.values():
            queues = getattr(adapter, "_events", None)
            if not isinstance(queues, dict):
                continue
            for queue in queues.values():
                pending += queue.qsize()
        return pending


@dataclass
class BackendRuntime:
    """One Application Backend instance: admission backend, native pool client, manager and HTTP app."""

    backend: Backend
    pool: PoolClient
    manager: SessionManager
    app: FastAPI


@dataclass
class SubmissionLab:
    admission: AdmissionLab
    cluster: NativeCluster
    signer: TokenSigner
    verifier: TokenVerifier
    limits: SessionLimits
    native_answer: str = NATIVE_ANSWER
    instances: list[str] = field(default_factory=lambda: [])
    runtimes: list[BackendRuntime] = field(default_factory=lambda: [])
    _unknown: tuple[Conv, Admitted] | None = None

    # World building

    async def setup(
        self, *, instances: list[tuple[int, int]] | None = None, provider_limit: int = 8
    ) -> None:
        self.instances = await self.admission.fresh_pool(instances or [(8, 8)], provider_limit=provider_limit)
        for instance_id in self.instances:
            await self.attach_process(instance_id)
        for index in range(len(self.admission.backends)):
            self.runtimes.append(self._runtime(self.admission.backends[index]))

    async def attach_process(self, instance_id: str) -> NativeProcess:
        rows = await self._fetch(
            """
            SELECT process_incarnation_id::text AS inc, native_storage_unit_id AS unit
            FROM harness_instance WHERE id = %s
            """,
            (instance_id,),
        )
        return self.cluster.add(instance_id, str(rows[0]["inc"]), str(rows[0]["unit"]))

    async def add_instance(
        self, *, resident: int = 2, active: int = 2, storage_unit: str | None = None
    ) -> NativeProcess:
        instance_id = await self.admission.add_instance(resident=resident, active=active, storage_unit=storage_unit)
        self.instances.append(instance_id)
        return await self.attach_process(instance_id)

    @property
    def process(self) -> NativeProcess:
        return self.cluster.processes[self.instances[0]]

    def _runtime(
        self, backend: Backend, *, limits: SessionLimits | None = None, rate_policy: RatePolicy = LAB_RATE_POLICY
    ) -> BackendRuntime:
        pool = PoolClient(self.cluster)
        empty = PoolClient(NativeCluster())
        adapters: dict[Provider, NativeRuntimeAdapter] = {"openai": pool, "xai": empty}
        deps = dataclasses.replace(
            self.admission.api.dependencies(db=backend.db),
            adapters=adapters,
            signer=self.signer,
            counters=backend.limiter,
            rate_policy=rate_policy,
            session_limits=limits or self.limits,
        )
        app = build_api(deps)
        manager = app.state.sessions
        if not isinstance(manager, SessionManager):
            raise AssertionError("the application has no session manager")
        return BackendRuntime(backend=backend, pool=pool, manager=manager, app=app)

    def runtime(self, index: int = 0) -> BackendRuntime:
        return self.runtimes[index]

    async def restarted_backend(
        self, *, limits: SessionLimits | None = None, rate_policy: RatePolicy = LAB_RATE_POLICY
    ) -> BackendRuntime:
        """A fresh backend process: its own database pool, counter client and native connections."""
        runtime = self._runtime(await self.admission.backend(), limits=limits, rate_policy=rate_policy)
        self.runtimes.append(runtime)
        return runtime

    def manager(self, index: int = 0) -> SessionManager:
        return self.runtimes[index].manager

    async def conversation(self) -> Conv:
        return await self.admission.conversation()

    async def admit(self, conv: Conv, request_id: str, *, backend: int = 0) -> Admitted:
        result = await self.admission.admit(conv, request_id, backend=backend)
        if not isinstance(result, Admitted):
            raise AssertionError(f"expected an admission, got {result!r}")
        return result

    @staticmethod
    def message(conv: Conv, request_id: str, text: str = DRAFT) -> SubmitMessage:
        return SubmitMessage(conversation_id=conv.conversation_id, client_request_id=request_id, message=text)

    async def submit(self, conv: Conv, request_id: str, text: str = DRAFT, *, backend: int = 0) -> SubmissionResult:
        admitted = await self.admit(conv, request_id, backend=backend)
        return await self.manager(backend).submit_message(admitted, self.message(conv, request_id, text))

    async def visitor(self, index: int = 0) -> Visitor:
        visitor = await self.admission.api.visitor(self.runtimes[index].app)
        self.admission.track_counter(visitor.subject_id, LAB_RATE_POLICY)
        return visitor

    def same_browser(self, visitor: Visitor, index: int) -> Visitor:
        return self.admission.api.same_browser(visitor, self.runtimes[index].app)

    async def created(self, visitor: Visitor) -> str:
        response = await visitor.create("openai")
        if response.status_code != 201:
            raise AssertionError(response.text)
        return str(response.json()["id"])

    # Metadata observations and stand-ins for later tasks' state changes

    async def mapping(self, conv: Conv | str) -> dict[str, Any] | None:
        return await self.admission.mapping(_conv(conv))

    async def guard(self, conv: Conv | str) -> str | None:
        return await self.admission.guard(_conv(conv))

    async def run_slots(self, mapping_id: str) -> list[str]:
        rows = await self._fetch(
            "SELECT scope FROM capacity_slot WHERE holder_provider_session_id = %s ORDER BY scope", (mapping_id,)
        )
        return [str(row["scope"]) for row in rows]

    async def terminal_clear(self, conv: Conv | str) -> None:
        """Task 17 stand-in: native work is terminal, so clear the run, guard and run capacity; stay warm."""
        mapping = await self.mapping(conv)
        assert mapping is not None
        async with self.admission.admin.pool.connection() as connection:
            async with connection.transaction():
                await release_run_slots(Transaction(connection), str(mapping["id"]), int(mapping["ownership_epoch"]))
                await connection.execute(
                    """
                    UPDATE provider_session SET active_agent_run_id = NULL, current_native_work_ref = NULL,
                        owner_lease_expires_at = NULL, active_agent_run_expires_at = NULL, runtime_state = 'warm_idle'
                    WHERE id = %s
                    """,
                    (mapping["id"],),
                )
                await connection.execute(
                    "UPDATE conversation SET active_provider_session_id = NULL WHERE id = %s",
                    (_conv(conv).conversation_id,),
                )

    async def unload(self, conv: Conv | str) -> None:
        """Task 17 stand-in: confirmed native unload releases the resident slot; the mapping stays."""
        mapping = await self.mapping(conv)
        assert mapping is not None
        await self.execute(
            """
            UPDATE capacity_slot SET holder_provider_session_id = NULL, reservation_epoch = NULL
            WHERE scope = 'resident' AND holder_provider_session_id = %s
            """,
            (mapping["id"],),
        )
        await self.execute("UPDATE provider_session SET runtime_state = 'unloaded' WHERE id = %s", (mapping["id"],))
        native_id = mapping["native_session_id"]
        for process in self.cluster.processes.values():
            process.loaded.discard(str(native_id))

    async def slot_rows(self) -> list[tuple[str, str, int, str | None, int | None]]:
        rows = await self._fetch(
            """
            SELECT scope, scope_id, slot_number, holder_provider_session_id::text AS holder, reservation_epoch
            FROM capacity_slot WHERE scope_id = ANY(%s) ORDER BY scope, scope_id, slot_number
            """,
            (self.instances,),
        )
        return [
            (str(r["scope"]), str(r["scope_id"]), int(r["slot_number"]), r["holder"], r["reservation_epoch"])
            for r in rows
        ]

    def conv(self, subject_id: str, conversation_id: str) -> Conv:
        return Conv(subject_id=subject_id, conversation_id=conversation_id)

    async def free_resident_rows(self, instance_id: str) -> int:
        """Committed free resident rows of the instance, whether or not another transaction locks them."""
        rows = await self._fetch(
            """
            SELECT count(*) AS n FROM capacity_slot
            WHERE scope = 'resident' AND scope_id = %s AND holder_provider_session_id IS NULL
            """,
            (instance_id,),
        )
        return int(rows[0]["n"])

    async def lockable_free_resident_rows(self, instance_id: str) -> int:
        """Free resident rows another backend could lock right now, without waiting; locks nothing after."""
        connection = await AsyncConnection.connect(APP_ROLE_DSN, autocommit=False)
        try:
            cursor = await connection.execute(
                """
                SELECT slot_number FROM capacity_slot
                WHERE scope = 'resident' AND scope_id = %s AND holder_provider_session_id IS NULL
                FOR UPDATE SKIP LOCKED
                """,
                (instance_id,),
            )
            return len(await cursor.fetchall())
        finally:
            await connection.rollback()
            await connection.close()

    async def fill_resident(self, instance_id: str) -> None:
        """Committed resident holders on every free resident slot of the instance (other conversations)."""
        await self.execute(
            """
            UPDATE capacity_slot SET holder_provider_session_id = gen_random_uuid(), reservation_epoch = 1
            WHERE scope = 'resident' AND scope_id = %s AND holder_provider_session_id IS NULL
            """,
            (instance_id,),
        )

    async def _fetch(self, query: str, params: tuple[object, ...]) -> list[dict[str, Any]]:
        async with self.admission.admin.pool.connection() as connection:
            cursor = await connection.execute(cast(LiteralString, query), params)
            return [dict(row) for row in await cursor.fetchall()]

    async def execute(self, query: str, params: tuple[object, ...]) -> None:
        async with self.admission.admin.pool.connection() as connection:
            await connection.execute(cast(LiteralString, query), params)

    # Lifecycle and cancellation scenarios (Task 17). No visitor text is kept here.

    def lifecycle(self, index: int = 0) -> Any:
        from esp_runtime_harconses.lifecycle import SessionLifecycle

        value = self.runtimes[index].app.state.lifecycle
        if not isinstance(value, SessionLifecycle):
            raise AssertionError("the session lifecycle is not registered on the application")
        return value

    def supervision(self, index: int = 0) -> Any:
        from esp_runtime_harconses.supervision import RunSupervision

        value = self.runtimes[index].app.state.supervision
        if not isinstance(value, RunSupervision):
            raise AssertionError("the control consumer is not registered apart from request handlers")
        return value

    async def consume(self, index: int = 0) -> None:
        await self.supervision(index).consume_control_events()

    async def coordination(self, conv: Conv | str) -> dict[str, Any]:
        rows = await self._fetch(
            """
            SELECT ps.id::text AS id, ps.runtime_state, ps.ownership_epoch,
                   ps.active_agent_run_id::text AS active_agent_run_id, ps.current_request_id,
                   ps.current_native_work_ref, ps.native_session_id,
                   ps.harness_instance_id::text AS harness_instance_id,
                   ps.runtime_incarnation_id::text AS runtime_incarnation_id,
                   ps.owner_lease_expires_at, ps.active_agent_run_expires_at, ps.last_used_at,
                   ps.cancel_requested_at, ps.recovery_count, ps.recovery_started_at,
                   ps.recovery_deadline_at, ps.last_failure_code,
                   c.active_provider_session_id::text AS guard
            FROM provider_session AS ps
            JOIN conversation AS c ON c.id = ps.conversation_id
            WHERE ps.conversation_id = %s AND ps.is_current
            """,
            (_conv(conv).conversation_id,),
        )
        if not rows:
            raise AssertionError("the conversation has no current mapping")
        return rows[0]

    async def instance_row(self, instance_id: str) -> dict[str, Any]:
        rows = await self._fetch(
            """
            SELECT lifecycle_status, process_incarnation_id::text AS process_incarnation_id, drain_started_at
            FROM harness_instance WHERE id = %s
            """,
            (instance_id,),
        )
        if not rows:
            raise AssertionError("no such harness instance")
        return rows[0]

    async def resident(self, conv: Conv | str) -> bool:
        row = await self.coordination(conv)
        if row["runtime_state"] == "unloaded":
            return False
        return "resident" in await self.run_slots(str(row["id"]))

    async def database_now(self) -> datetime:
        rows = await self._fetch("SELECT transaction_timestamp() AS now", ())
        return cast(datetime, rows[0]["now"])

    async def age_last_used(self, conv: Conv | str, seconds: int) -> datetime:
        """Move last use to exactly `seconds` before the database clock and return that clock."""
        rows = await self._fetch(
            """
            UPDATE provider_session
            SET last_used_at = transaction_timestamp() - make_interval(secs => %s)
            WHERE conversation_id = %s AND is_current
            RETURNING transaction_timestamp() AS now
            """,
            (seconds, _conv(conv).conversation_id),
        )
        if not rows:
            raise AssertionError("the conversation has no current mapping to age")
        return cast(datetime, rows[0]["now"])

    async def run_binding(self, conv: Conv | str) -> RunBinding:
        from esp_execution_bindings.authorize import read_authority

        mapping_id = str((await self.coordination(conv))["id"])
        async with self.admission.admin.pool.connection() as connection:
            async with connection.transaction():
                record = await read_authority(Transaction(connection), mapping_id)
        if (
            record is None
            or record.native_session_id is None
            or record.active_agent_run_id is None
            or record.harness_instance_id is None
            or record.runtime_incarnation_id is None
            or record.model is None
            or record.owner_lease_expires_at is None
        ):
            raise AssertionError("the run has no current authority to bind")
        return RunBinding(
            conversation_id=record.conversation_id,
            provider_session_id=record.provider_session_id,
            session_generation=record.session_generation,
            native_session_id=record.native_session_id,
            active_agent_run_id=record.active_agent_run_id,
            harness_instance_id=record.harness_instance_id,
            runtime_incarnation_id=record.runtime_incarnation_id,
            ownership_epoch=record.ownership_epoch,
            provider=record.provider,
            model=record.model,
            brain_release_id=record.brain_release_id,
            brain_hash=record.brain_hash,
            behavior_version=record.behavior_version,
            behavior_hash=record.behavior_hash,
            corpus_release_id=record.corpus_release_id,
            deployment_ref=record.deployment_ref,
            issued_at=record.database_time,
            expires_at=record.owner_lease_expires_at,
            audience="inference",
            native_work_ref=record.current_native_work_ref,
        )

    async def metadata_blob(self) -> str:
        """Coordination columns only. Visitor text must never appear in them."""
        rows = await self._fetch(
            """
            SELECT c.owner_subject_id, c.status, ps.runtime_state, ps.current_request_id,
                   ps.current_native_work_ref, ps.last_failure_code, ps.native_session_id,
                   hi.lifecycle_status, hi.worker_id
            FROM conversation AS c
            LEFT JOIN provider_session AS ps ON ps.conversation_id = c.id
            LEFT JOIN harness_instance AS hi ON hi.id = ps.harness_instance_id
            """,
            (),
        )
        return json.dumps(rows, default=str)

    async def _accepted(self, conv: Conv, request_id: str, text: str = DRAFT) -> Accepted:
        result = await self.submit(conv, request_id, text)
        if not isinstance(result, Accepted):
            raise AssertionError(f"the native harness did not accept the message: {result!r}")
        return result

    async def _finish_and_consume(self, conv: Conv, request_id: str, native_session_id: str) -> None:
        self.cluster.session_store(native_session_id)
        process = self._process_for(native_session_id)
        process.finish(native_session_id, request_id)
        await asyncio.sleep(0)
        await self.consume()

    def _process_for(self, native_session_id: str) -> NativeProcess:
        for process in self.cluster.processes.values():
            if native_session_id in process.loaded or native_session_id in process.store.sessions:
                return process
        raise AssertionError(f"no process holds {native_session_id}")

    async def two_sequential_messages_native_count(self) -> int:
        conv = await self.conversation()
        first = await self._accepted(conv, "life-seq-1")
        await self._finish_and_consume(conv, "life-seq-1", first.work.native_session_id)
        if await self.guard(conv) is not None:
            return 0
        second = await self.submit(conv, "life-seq-2")
        if not isinstance(second, Accepted) or second.work.native_session_id != first.work.native_session_id:
            return 0
        slots = await self.run_slots(str((await self.coordination(conv))["id"]))
        if "resident" not in slots or "active" not in slots:
            return 0
        return self.cluster.submissions("life-seq-1") + self.cluster.submissions("life-seq-2")

    async def resident_at_idle_seconds(self, seconds: int) -> bool:
        conv = await self.conversation()
        accepted = await self._accepted(conv, f"life-idle-{seconds}")
        await self._finish_and_consume(conv, f"life-idle-{seconds}", accepted.work.native_session_id)
        if not await self.resident(conv):
            return False
        now = await self.age_last_used(conv, seconds)
        await self.lifecycle().evict_idle(now)
        return await self.resident(conv)

    async def peer_runs_after_unload(self) -> bool:
        anchor = self.instances[0]
        peer = await self.conversation()
        subject = await self.conversation()
        peer_run = await self._accepted(peer, "life-peer-run")
        subject_run = await self._accepted(subject, "life-peer-idle")
        await self._finish_and_consume(subject, "life-peer-idle", subject_run.work.native_session_id)
        incarnation = str((await self.instance_row(anchor))["process_incarnation_id"])
        now = await self.age_last_used(subject, 900)
        await self.lifecycle().evict_idle(now)
        if await self.resident(subject) or (await self.coordination(subject))["runtime_state"] != "unloaded":
            return False
        peer_row = await self.coordination(peer)
        if peer_row["guard"] is None or peer_row["runtime_state"] != "running":
            return False
        if str((await self.instance_row(anchor))["process_incarnation_id"]) != incarnation:
            return False
        if str((await self.instance_row(anchor))["lifecycle_status"]) != "ready":
            return False
        resumed = await self.submit(subject, "life-peer-resume")
        if not isinstance(resumed, Accepted) or resumed.work.native_session_id != subject_run.work.native_session_id:
            return False
        peer_after = await self.coordination(peer)
        native = self.cluster.session_store(peer_run.work.native_session_id)
        work = native.sessions[peer_run.work.native_session_id].work_for("life-peer-run")
        return (
            peer_after["guard"] == peer_row["guard"]
            and peer_after["active_agent_run_id"] == peer_row["active_agent_run_id"]
            and work is not None
            and work.status == "running"
        )

    async def guard_until_cancel_confirmed(self) -> bool:
        peer = await self.conversation()
        subject = await self.conversation()
        peer_run = await self._accepted(peer, "life-cancel-peer")
        subject_run = await self._accepted(subject, "life-cancel-subject")
        process = self._process_for(subject_run.work.native_session_id)
        incarnation = str((await self.instance_row(self.instances[0]))["process_incarnation_id"])
        run_id = str((await self.coordination(subject))["active_agent_run_id"])
        process.cancel_mode = "ignore"
        view = await self.lifecycle().cancel_run(subject.subject_id, subject.conversation_id, run_id)
        held = await self.coordination(subject)
        peer_held = await self.coordination(peer)
        instance = await self.instance_row(self.instances[0])
        if (
            held["guard"] is None
            or held["runtime_state"] != "cancelling"
            or held["cancel_requested_at"] is None
            or held["recovery_started_at"] is None
            or int(held["recovery_count"]) < 1
            or view.resubmission_allowed
            or peer_held["runtime_state"] != "running"
            or str(instance["lifecycle_status"]) != "ready"
            or str(instance["process_incarnation_id"]) != incarnation
        ):
            return False
        process.cancel_mode = "interrupt"
        confirmed = await self.lifecycle().cancel_run(subject.subject_id, subject.conversation_id, run_id)
        released = await self.coordination(subject)
        peer_after = await self.coordination(peer)
        slots = await self.run_slots(str(released["id"]))
        work = self.cluster.session_store(peer_run.work.native_session_id).sessions[
            peer_run.work.native_session_id
        ].work_for("life-cancel-peer")
        still = await self.instance_row(self.instances[0])
        return (
            confirmed.outcome == "cancelled"
            and not confirmed.resubmission_allowed
            and released["guard"] is None
            and released["active_agent_run_id"] is None
            and released["runtime_state"] == "warm_idle"
            and "resident" in slots
            and "active" not in slots
            and peer_after["guard"] is not None
            and peer_after["runtime_state"] == "running"
            and work is not None
            and work.status == "running"
            and str(still["lifecycle_status"]) == "ready"
        )

    async def old_epoch_event_clears_replacement(self) -> bool:
        conv = await self.conversation()
        first = await self._accepted(conv, "life-epoch-old")
        process = self._process_for(first.work.native_session_id)
        session = process.store.sessions[first.work.native_session_id]
        old = process.finish(first.work.native_session_id, "life-epoch-old", announce=False)
        if not old.identity:
            raise AssertionError("the native harness did not keep the submitting operation identity")
        await self._finish_and_consume(conv, "life-epoch-old", first.work.native_session_id)
        await self._accepted(conv, "life-epoch-new")
        before = await self.coordination(conv)
        inspects = self.runtime().pool.calls["inspect"]
        process.announce(session, old)
        process.announce(
            session,
            old,
            runtime_incarnation_id=str(uuid.uuid4()),
            ownership_epoch=int(before["ownership_epoch"]) - 1,
        )
        await asyncio.sleep(0)
        await self.consume()
        after = await self.coordination(conv)
        cleared = (
            after["guard"] is None
            or after["active_agent_run_id"] != before["active_agent_run_id"]
            or int(after["ownership_epoch"]) != int(before["ownership_epoch"])
            or after["runtime_state"] != "running"
            or after["current_native_work_ref"] != before["current_native_work_ref"]
        )
        unconsumed = self.runtime().pool.pending_control_events() > 0
        ignored = self.runtime().pool.calls["inspect"] <= inspects
        return cleared or unconsumed or ignored

    # The plan's named scenarios

    async def fail_before_send(self) -> SubmissionResult:
        conv = await self.conversation()
        admitted = await self.admit(conv, "req-fail-before-send")
        self.process.refuse_send.add("session/submit")
        return await self.manager().submit_message(admitted, self.message(conv, "req-fail-before-send"))

    async def lose_ack_after_native_save(self) -> SubmissionResult:
        conv = await self.conversation()
        admitted = await self.admit(conv, "req-lost-ack")
        self.process.lose_ack_after_save = True
        result = await self.manager().submit_message(admitted, self.message(conv, "req-lost-ack"))
        self._unknown = (conv, admitted)
        return result

    async def unknown_state(self) -> tuple[Conv, Admitted]:
        if self._unknown is None:
            await self.lose_ack_after_native_save()
        assert self._unknown is not None
        return self._unknown

    async def guard_held_after_unknown(self) -> bool:
        conv, admitted = await self.unknown_state()
        mapping = await self.mapping(conv)
        return (
            mapping is not None
            and await self.guard(conv) == admitted.reservation.provider_session_id
            and mapping["active_agent_run_id"] == admitted.authority.active_agent_run_id
            and mapping["current_request_id"] == admitted.client_request_id
            and sorted(await self.run_slots(str(mapping["id"]))) == ["active", "provider", "resident"]
        )

    async def duplicate_active_submit_count(self) -> int:
        """Two backends race the same request, then the browser repeats it once more."""
        visitor = await self.visitor(0)
        other = self.same_browser(visitor, 1)
        conversation_id = await self.created(visitor)
        body = {"conversation_id": conversation_id, "client_request_id": "req-duplicate", "message": DRAFT}
        responses = await asyncio.gather(
            post_message(visitor, conversation_id, body), post_message(other, conversation_id, body)
        )
        accepted = [r for r in responses if r.headers.get("x-esp-acceptance") == "accepted"]
        if len(accepted) > 1:
            raise AssertionError("one request was accepted twice")
        repeat = await post_message(visitor, conversation_id, body)
        if repeat.status_code != 200 or repeat.headers.get("x-esp-acceptance") != "duplicate":
            raise AssertionError(f"a repeated current request was not answered with its status: {repeat.text}")
        return self.cluster.submissions("req-duplicate")

    async def completed_after_backend_restart(self) -> str:
        """The native harness finishes the unconfirmed work before metadata is cleared; a new backend reads it."""
        conv, admitted = await self.unknown_state()
        mapping = await self.mapping(conv)
        assert mapping is not None
        native_id = str(mapping["native_session_id"])
        self.cluster.session_store(native_id).complete(native_id, admitted.client_request_id, self.native_answer)
        restarted = await self.restarted_backend()
        view = await restarted.manager.inspect_submission(
            conv.subject_id, conv.conversation_id, admitted.client_request_id
        )
        if view.outcome != "completed" or view.resubmission_allowed:
            raise AssertionError(f"the restarted backend did not reconcile the completed work: {view!r}")
        history = await restarted.manager.read_authorized_history(conv.subject_id, conv.conversation_id)
        answers = [item.text for item in history.items if item.role == "assistant"]
        return answers[-1] if answers else ""

    async def uncorrelated_old_request(self) -> SubmissionView:
        conv, _admitted = await self.unknown_state()
        return await self.manager().inspect_submission(conv.subject_id, conv.conversation_id, "req-never-correlated")


def _conv(conv: Conv | str) -> Conv:
    if isinstance(conv, Conv):
        return conv
    return Conv(subject_id="", conversation_id=conv)


async def post_message(
    visitor: Visitor, conversation_id: str, body: Mapping[str, object] | None = None, *, raw: bytes | None = None
) -> httpx.Response:
    content = raw if raw is not None else json.dumps(body).encode()
    return await visitor.client.post(
        f"/conversations/{conversation_id}/messages", content=content, headers=visitor.write_headers()
    )


async def open_submission_lab(
    tmp_path: Path,
    *,
    limits: SessionLimits | None = None,
    instances: list[tuple[int, int]] | None = None,
    provider_limit: int = 8,
) -> SubmissionLab:
    admission = await open_admission_lab(tmp_path, backend_count=2)
    signer, verifier = TokenSigner.generate()
    lab = SubmissionLab(
        admission=admission,
        cluster=NativeCluster(),
        signer=signer,
        verifier=verifier,
        limits=limits or SessionLimits(acceptance_budget_seconds=2.0, read_timeout_seconds=2.0),
    )
    try:
        await lab.setup(instances=instances, provider_limit=provider_limit)
    except BaseException:
        await close_admission_lab(admission)
        raise
    return lab


async def close_submission_lab(lab: SubmissionLab) -> None:
    await close_admission_lab(lab.admission)
