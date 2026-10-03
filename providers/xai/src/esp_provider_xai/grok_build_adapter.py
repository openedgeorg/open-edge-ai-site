"""Grok Build candidate adapter: one long-lived `grok agent stdio` ACP process, many sessions.

Every native operation is one the exact captured build declares at `initialize` (ACP protocol
version 1, `loadSession`, `sessionCapabilities.resume` and `.close`) or a baseline ACP v1 method whose
name and request type are present in that binary (`providers/xai/integration/protocol-capabilities.json`).
Persistence, resume, unload and history are not inferred from headless-mode documentation, and
no headless or CLI resume path is used: a standalone headless resume is not ACP recovery.

Acceptance. ACP answers `session/prompt` only when the prompt turn ends, so neither that answer nor
its absence proves durable acceptance. A submission is `accepted` only when the build's persisted
session, replayed through `session/load`, holds a user message carrying this request's `messageId`
(derived from the session and client request id). Only a JSON-RPC refusal the build itself sent can
make it `not_submitted`, and only while the persisted session lacks the input; any other failure after
the frame was handed to the transport keeps it `unconfirmed`.

Attribution. ACP updates name the session, not a turn, so the work reference is the prompt this
adapter sent on that session, and only while it is in flight. Model requests are attributed from the
`x-grok-session-id` header the build's model-request client names; MCP requests from the
`x-mcp-session-id: {{session_id}}` header the build documents. Neither is runtime-proven yet.

Use:

    rpc = NativeRpcClient(AcpClientGuard(GrokStdioTransport(stdout, stdin)))
    adapter = create_grok_adapter(rpc, profile)   # inside a running event loop
    await adapter.initialize()                    # required once, before any other call

`AcpClientGuard` is the client half of the tool policy: the supervisor offers no file-system or
terminal capability and approves no tool permission, whatever the agent asks for. The supervisor-local
relays call `adapter.attribute_model_request(headers, body)` and `adapter.attribute_mcp_request(headers)`;
manual compaction is `await adapter.compact(handle, authority)`. These are Grok-specific, so the factory
returns the typed `GrokBuildHarnessAdapter`.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Literal, NoReturn, Protocol, cast

from pydantic import BaseModel, ConfigDict, Field

from esp_contracts.api import SubmitMessage
from esp_contracts.qualification import RuntimeProfile
from esp_contracts.runtime import (
    Accepted,
    HistoryItem,
    NativeHistorySnapshot,
    NativeStatus,
    NativeWorkStatus,
    NotSubmitted,
    OperationAuthority,
    SessionHandle,
    SessionReservation,
    SubmissionResult,
    Unconfirmed,
    WorkRef,
)
from esp_provider_shared.adapter import HarnessAdapter, UnsupportedPrimitive
from esp_provider_shared.rpc import (
    FRAME_LIMIT_BYTES,
    FrameTooLarge,
    FrameTransport,
    NativeRpcClient,
    NotificationParams,
    ResponseLost,
    RpcProtocolError,
)
from esp_provider_shared.transport_context import OperationContext, TransportContext, UnattributedCall
from esp_provider_xai.events import (
    GrokEventRejected,
    model_option,
    normalize_grok_update,
    stop_status,
    terminal_events,
)

# `grok --version` of the captured build, run with an isolated HOME and GROK_HOME (no channel suffix).
GROK_VERSION = "grok 1.0.46 (2765805b9442)"
# sha256 of the native binary the frozen capture was taken from.
GROK_NATIVE_SHA256 = "41626a53292324140b92556b9d42ff5542e3dcd04aff85eafb8689dd4adb44fc"


def grok_build_id(version: str, native_sha256: str) -> str:
    """Canonical exact-build identity: the version string plus the native binary digest.

    The frozen capture, the candidate manifest, `qualify inspect` and the factory all use this form.
    """
    return f"{version} sha256:{native_sha256}"


GROK_BUILD = grok_build_id(GROK_VERSION, GROK_NATIVE_SHA256)
ACP_PROTOCOL_VERSION = 1
# ESP primitive -> ACP method. Each one is declared by the captured build (see module docstring).
GROK_METHODS: Mapping[str, str] = MappingProxyType(
    {
        "handshake": "initialize",
        "create": "session/new",
        "history": "session/load",
        "resume": "session/resume",
        "submit": "session/prompt",
        "unload": "session/close",
    }
)
# `session/cancel` is an ACP notification scoped to the session's prompt turn.
GROK_CLIENT_NOTIFICATIONS: tuple[str, ...] = ("session/cancel",)
# Catalog key of the gateway relay model in infra/runtime/grok/config.toml (`[model.esp-grok]`).
GROK_MODEL_CATALOG_KEY = "esp-grok"
# Working directory every session is created, loaded and resumed in. The build groups persisted
# sessions by working directory and refuses to load a session from a different one.
GROK_SESSION_CWD = "/srv/esp/grok-work"
# The build lists `compact` in its initialize `availableCommands`; ACP commands are sent as prompts.
GROK_COMPACT_COMMAND = "/compact"
# Header names present in the build's model-request client module; the relay's attribution input.
GROK_SESSION_HEADER = "x-grok-session-id"
# MCP request header configured with the build-documented `{{session_id}}` template.
GROK_MCP_SESSION_HEADER = "x-mcp-session-id"
MAX_MODEL_REQUEST_BYTES = 1_048_576
# One byte for the newline plus one so an exactly-at-limit line is still readable.
STDIO_READER_LIMIT = FRAME_LIMIT_BYTES + 2

_METHOD_NOT_FOUND = -32601
# JSON-RPC codes that mean the peer refused the request before running it: parse error, invalid
# request, method not found, invalid params. Internal and server-defined errors are not refusals.
_REFUSAL_CODES = frozenset({-32700, -32600, _METHOD_NOT_FOUND, -32602})
_READ_ERRORS = (RpcProtocolError, ResponseLost, OSError, FrameTooLarge)
_REQUIRED_SESSION_CAPABILITIES = ("resume", "close")
# Initialize metadata that describes the host or this process instance. Never returned or stored.
HOST_IDENTIFYING_META = frozenset({"hostname", "currentWorkingDirectory", "agentId", "agentInstanceId"})
_MESSAGE_NAMESPACE = uuid.UUID("6f3c1a52-8d0e-4b8f-9a37-2c1d5e4b7a90")


class GrokBindingMismatch(Exception):
    """The build reported a model other than the pinned one, or none at all."""


class GrokCapabilityMissing(Exception):
    """The build did not declare an ACP capability this adapter's mapping requires."""


class GrokSessionBusy(Exception):
    """A prompt of ours is still in flight on this session; nothing was sent."""


class _Unreadable:
    """Persisted history could not be read, so acceptance cannot be decided."""


_UNREADABLE = _Unreadable()


class GrokModelScope(BaseModel):
    """Inference scope for one model request, resolved from the build's own session header."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    audience: Literal["inference"]
    token: str = Field(min_length=1)
    native_session_id: str = Field(min_length=1)
    native_work_ref: str = Field(min_length=1)


class GrokToolScope(BaseModel):
    """Knowledge scope for one MCP request, resolved from the documented session header."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    audience: Literal["knowledge"]
    token: str = Field(min_length=1)
    native_session_id: str = Field(min_length=1)
    native_work_ref: str = Field(min_length=1)


def grok_message_id(native_session_id: str, client_request_id: str) -> str:
    """Deterministic ACP `messageId` for one client request on one session.

    The same request always maps to the same id, so status reconciliation can find the input in the
    build's persisted session without any application-side record of what was sent.
    """
    return str(uuid.uuid5(_MESSAGE_NAMESPACE, f"{native_session_id}\x00{client_request_id}"))


def acp_initialize_params(client_name: str, client_version: str) -> dict[str, object]:
    """ACP `initialize` params. The client offers no file-system and no terminal capability."""
    return {
        "protocolVersion": ACP_PROTOCOL_VERSION,
        "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False},
        "clientInfo": {"name": client_name, "version": client_version},
    }


class LineWriter(Protocol):
    def is_closing(self) -> bool: ...

    def write(self, data: bytes) -> None: ...

    async def drain(self) -> None: ...


class GrokStdioTransport:
    """`grok agent stdio` framing: one JSON-RPC message per newline-terminated line."""

    def __init__(self, reader: asyncio.StreamReader, writer: LineWriter, *, limit: int = FRAME_LIMIT_BYTES) -> None:
        self._reader = reader
        self._writer = writer
        self._limit = limit

    async def send_frame(self, payload: bytes) -> None:
        if b"\n" in payload:
            raise ValueError("payload contains a newline")
        if len(payload) > self._limit:
            raise FrameTooLarge(len(payload))
        if self._writer.is_closing():
            # Nothing was handed to the pipe, so this is a conclusive not-sent.
            raise ConnectionError("agent stdin is closed")
        self._writer.write(payload + b"\n")
        try:
            await self._writer.drain()
        except OSError as exc:
            # The line may already be in the pipe. The build may have read it.
            raise ResponseLost("write outcome unknown") from exc

    async def recv_frame(self) -> bytes:
        try:
            line = await self._reader.readuntil(b"\n")
        except asyncio.IncompleteReadError:
            return b""
        except asyncio.LimitOverrunError as exc:
            raise FrameTooLarge(exc.consumed) from exc
        body = line[:-1]
        if len(body) > self._limit:
            raise FrameTooLarge(len(body))
        return body


class AcpClientGuard:
    """Client half of the tool policy, between the agent's stdout and the RPC client.

    The supervisor advertises no file-system or terminal capability, so a conformant build never asks
    for them. Any agent-to-client request is answered here and never reaches ESP code: permission
    requests get the build's own reject option (or an error when none is offered) and everything else
    gets method-not-found. Nothing is read, written or executed on the agent's behalf.
    """

    def __init__(self, inner: FrameTransport) -> None:
        self._inner = inner
        self.refused: list[str] = []

    async def send_frame(self, payload: bytes) -> None:
        await self._inner.send_frame(payload)

    async def recv_frame(self) -> bytes:
        while True:
            payload = await self._inner.recv_frame()
            request = _agent_request(payload)
            if request is None:
                return payload
            await self._refuse(request)

    async def _refuse(self, request: Mapping[str, Any]) -> None:
        method = cast(str, request["method"])
        self.refused.append(method)
        reply: dict[str, Any] = {"jsonrpc": "2.0", "id": request["id"]}
        reject = _reject_option(request.get("params")) if method == "session/request_permission" else None
        if reject is not None:
            reply["result"] = {"outcome": {"outcome": "selected", "optionId": reject}}
        else:
            reply["error"] = {"code": _METHOD_NOT_FOUND, "message": "client capability not offered"}
        await self._inner.send_frame(json.dumps(reply).encode())


@dataclass(eq=False)
class _Operation:
    """One prompt this adapter sent: a submission or the `compact` command."""

    context: OperationContext
    message_id: str
    kind: Literal["prompt", "compaction"]
    task: asyncio.Task[object]
    tool_calls: dict[str, str] = field(default_factory=lambda: {})


@dataclass(frozen=True)
class _Terminal:
    status: NativeWorkStatus | None
    stop_reason: str | None
    echoed_message_id: str | None


class GrokBuildHarnessAdapter(HarnessAdapter):
    """One Grok Build ACP process. Sessions are addressed only by their explicit `sessionId`."""

    rejected_events: int

    def __init__(self, rpc: NativeRpcClient, transport: TransportContext, profile: RuntimeProfile) -> None:
        self.profile = profile
        self.acceptance_confirm_attempts = 8
        self.acceptance_confirm_interval = 0.25
        self.model_reroutes = 0
        self.disallowed_items = 0
        self.unbound_updates = 0
        self._operations: dict[str, _Operation] = {}
        self._terminals: dict[str, dict[str, _Terminal]] = {}
        self._replays: dict[str, list[dict[str, Any]]] = {}
        self._read_locks: dict[str, asyncio.Lock] = {}
        self._closed: set[str] = set()
        self._known: set[str] = set()
        super().__init__(rpc, transport)

    async def initialize(self, *, client_name: str = "esp-supervisor", client_version: str = "1") -> dict[str, object]:
        """ACP handshake. Returns a sanitized summary; host-identifying metadata is dropped."""
        result = await self._rpc.request(GROK_METHODS["handshake"], acp_initialize_params(client_name, client_version))
        body = _require_object(result, "invalid initialize result")
        if body.get("protocolVersion") != ACP_PROTOCOL_VERSION:
            raise GrokCapabilityMissing("protocolVersion")
        capabilities = _object(body.get("agentCapabilities")) or {}
        if capabilities.get("loadSession") is not True:
            raise GrokCapabilityMissing("loadSession")
        session_capabilities = _object(capabilities.get("sessionCapabilities")) or {}
        for name in _REQUIRED_SESSION_CAPABILITIES:
            if name not in session_capabilities:
                raise GrokCapabilityMissing(name)
        meta = _object(body.get("_meta")) or {}
        agent_version = meta.get("agentVersion")
        auth_ids = [_object(entry) or {} for entry in _objects(body.get("authMethods"))]
        return {
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "agentVersion": agent_version if isinstance(agent_version, str) else None,
            "loadSession": True,
            "sessionCapabilities": sorted(session_capabilities),
            "authMethodIds": sorted(str(entry.get("id")) for entry in auth_ids if isinstance(entry.get("id"), str)),
        }

    async def create_session(self, reservation: SessionReservation) -> SessionHandle:
        if reservation.provider != "xai" or reservation.model != self.profile.model:
            raise GrokBindingMismatch("model_pin_mismatch")
        result = await self._rpc.request(GROK_METHODS["create"], {"cwd": GROK_SESSION_CWD, "mcpServers": []})
        body = _require_object(result, "invalid session result")
        session_id = body.get("sessionId")
        if not isinstance(session_id, str) or session_id == "":
            raise RpcProtocolError("missing sessionId")
        _check_model(body)
        self._known.add(session_id)
        self._remember_run(session_id)
        data = reservation.model_dump()
        data["native_session_id"] = session_id
        return SessionHandle.model_validate(data)

    async def resume_session(self, handle: SessionHandle) -> SessionHandle:
        self._require_pins(handle)
        session_id = handle.native_session_id
        result = await self._rpc.request(
            GROK_METHODS["resume"], {"sessionId": session_id, "cwd": GROK_SESSION_CWD, "mcpServers": []}
        )
        _check_model(_require_object(result, "invalid resume result"))
        self._closed.discard(session_id)
        self._known.add(session_id)
        self._remember_run(session_id)
        return handle

    async def submit(
        self,
        handle: SessionHandle,
        message: SubmitMessage,
        authority: OperationAuthority,
    ) -> SubmissionResult:
        self._require_pins(handle)
        if message.conversation_id != handle.conversation_id:
            raise GrokBindingMismatch("conversation_mismatch")
        session_id = handle.native_session_id
        if self._in_flight(session_id) is not None:
            # ACP runs one prompt turn per session; a second prompt would be queued or steered by the
            # build. Nothing is sent, so this is conclusive.
            return NotSubmitted(kind="not_submitted", code="prompt_in_flight")
        message_id = grok_message_id(session_id, message.client_request_id)
        operation = self._start(handle, authority, message_id, "prompt", message.message)
        attempts = max(1, self.acceptance_confirm_attempts)
        for _ in range(attempts):
            # Give the answer (or the build's queued updates) time to arrive before reading history.
            await asyncio.wait({operation.task}, timeout=self.acceptance_confirm_interval)
            if operation.task.done():
                return await self._after_answer(operation)
            located = await self._locate_input(session_id, message_id)
            if located == message_id:
                return Accepted(kind="accepted", work=WorkRef(native_session_id=session_id, native_work_ref=message_id))
        return Unconfirmed(kind="unconfirmed", native_work_ref=None)

    async def _after_answer(self, operation: _Operation) -> SubmissionResult:
        """The prompt request finished. Decide acceptance from persisted history, never from the answer."""
        session_id = operation.context.native_session_id
        message_id = operation.message_id
        exc = None if operation.task.cancelled() else operation.task.exception()
        if isinstance(exc, ConnectionError):
            # The transport refused before writing anything: conclusively not sent.
            return NotSubmitted(kind="not_submitted", code="not_sent")
        if isinstance(exc, RpcProtocolError) and _peer_refusal(exc):
            located = await self._locate_input(session_id, message_id)
            if located is None:
                return NotSubmitted(kind="not_submitted", code="native_rejected")
            if isinstance(located, _Unreadable):
                return Unconfirmed(kind="unconfirmed", native_work_ref=None)
            return Unconfirmed(kind="unconfirmed", native_work_ref=message_id)
        if exc is not None or operation.task.cancelled():
            # Lost answer, a garbled stream or a closed connection after the frame was handed over.
            return Unconfirmed(kind="unconfirmed", native_work_ref=None)
        echoed = _object(operation.task.result()) or {}
        named = message_id if echoed.get("userMessageId") == message_id else None
        located = await self._locate_input(session_id, message_id)
        if located == message_id:
            return Accepted(kind="accepted", work=WorkRef(native_session_id=session_id, native_work_ref=message_id))
        # A terminal answer without the input in persisted history is not durable acceptance.
        return Unconfirmed(kind="unconfirmed", native_work_ref=named)

    async def continue_work(
        self,
        handle: SessionHandle,
        work: WorkRef,
        authority: OperationAuthority,
    ) -> SubmissionResult:
        # ACP declares no saved-state continuation of an interrupted prompt turn. Nothing is sent.
        return NotSubmitted(kind="not_submitted", code="continue_unsupported")

    async def compact(self, handle: SessionHandle, authority: OperationAuthority) -> NativeWorkStatus:
        """Manual compaction through the build's declared `compact` command, bound to this scope.

        Returns once the build ends the command's prompt turn.
        """
        self._require_pins(handle)
        session_id = handle.native_session_id
        if self._in_flight(session_id) is not None:
            raise GrokSessionBusy(session_id)
        operation = self._start(handle, authority, str(uuid.uuid4()), "compaction", GROK_COMPACT_COMMAND)
        await asyncio.wait({operation.task})
        exc = None if operation.task.cancelled() else operation.task.exception()
        if isinstance(exc, ConnectionError):
            raise exc
        if exc is not None or operation.task.cancelled():
            return "unknown"
        return cast(NativeWorkStatus, stop_status((_object(operation.task.result()) or {}).get("stopReason")))

    async def inspect(self, handle: SessionHandle, request_id: str | None = None) -> NativeStatus:
        session_id = handle.native_session_id
        replay = await self._replay(session_id)
        return self._status(session_id, replay, request_id)

    async def read_history(self, handle: SessionHandle) -> NativeHistorySnapshot:
        session_id = handle.native_session_id
        replay = await self._replay(session_id)
        running = self._in_flight(session_id)
        provisional_turn = None if running is None else running.message_id
        items = _history_items(session_id, replay, provisional_turn)
        status = self._status(session_id, replay, None)
        return NativeHistorySnapshot(items=items, native_cursor=None, status=status, provenance=[])

    def _status(self, session_id: str, replay: list[dict[str, Any]], request_id: str | None) -> NativeStatus:
        """Status from this connection's own prompt answers plus the build's persisted session.

        ACP declares no per-turn status read: an input the build saved whose prompt answer this
        adapter never observed has an unknown outcome.
        """
        saved = {
            update.get("messageId") for update in replay if update.get("sessionUpdate") == "user_message_chunk"
        }
        running = self._in_flight(session_id)
        terminals = self._terminals.get(session_id, {})
        if request_id is None:
            if running is not None:
                return NativeStatus(
                    status="running",
                    native_work_ref=running.message_id,
                    saved_input_available=running.message_id in saved,
                )
            for last_id, last in reversed(terminals.items()):
                if last.status is not None:
                    return NativeStatus(
                        status=last.status, native_work_ref=last_id, saved_input_available=last_id in saved
                    )
                break
            return NativeStatus(status="idle", saved_input_available=False)
        message_id = grok_message_id(session_id, request_id)
        terminal = terminals.get(message_id)
        if running is not None and running.message_id == message_id:
            status: NativeWorkStatus = "running"
        elif message_id not in saved:
            idle: NativeWorkStatus = "running" if running is not None else "idle"
            return NativeStatus(status=idle, request_id=request_id, saved_input_available=False)
        elif terminal is not None and terminal.status is not None:
            status = terminal.status
        else:
            status = "unknown"
        return NativeStatus(
            status=status,
            native_work_ref=message_id,
            request_id=request_id,
            saved_input_available=message_id in saved,
        )

    async def cancel(self, handle: SessionHandle, work: WorkRef) -> Literal["requested", "stopped", "unknown"]:
        if work.native_session_id != handle.native_session_id:
            raise ValueError("work_session_mismatch")
        running = self._in_flight(handle.native_session_id)
        if running is None or running.message_id != work.native_work_ref:
            # ACP cancellation is session-wide, so a stale reference must never reach the build: it
            # would interrupt whatever replacement work now runs on that session.
            return "unknown"
        try:
            await self._rpc.notify(GROK_CLIENT_NOTIFICATIONS[0], {"sessionId": handle.native_session_id})
        except (RpcProtocolError, ResponseLost, OSError):
            return "unknown"
        return "requested"

    async def unload(self, handle: SessionHandle) -> Literal["unloaded", "unsupported"]:
        session_id = handle.native_session_id
        if self._in_flight(session_id) is not None:
            raise GrokSessionBusy(session_id)
        try:
            result = await self._rpc.request(GROK_METHODS["unload"], {"sessionId": session_id})
        except RpcProtocolError as exc:
            if exc.args and exc.args[0] == _METHOD_NOT_FOUND:
                return "unsupported"
            raise
        _require_object(result, "invalid close result")
        self._forget_session(session_id)
        return "unloaded"

    async def export_history(self, handle: SessionHandle) -> None:
        # ACP declares no export method. The build's `grok export` CLI is outside this process.
        raise UnsupportedPrimitive("export")

    async def delete_history(self, handle: SessionHandle) -> None:
        # ACP declares no delete method. The build's `grok sessions delete` CLI is outside this process.
        raise UnsupportedPrimitive("delete")

    def attribute_model_request(self, headers: Mapping[str, str], body: bytes) -> GrokModelScope:
        """Per-request model hook used by the supervisor-local relay. Refusals are never forwarded.

        The scope is that of the prompt this adapter has in flight on the request's own session.
        Auxiliary model slots are configured to a model the profile does not pin, so they are refused.
        """
        if len(body) > MAX_MODEL_REQUEST_BYTES:
            self._refuse("oversize")
        try:
            document = _load_object(body)
        except ValueError:
            self._refuse("invalid_body")
        if document.get("model") != self.profile.model:
            self._refuse("model_not_pinned")
        session_id = _header(headers, GROK_SESSION_HEADER)
        if session_id is None:
            self._refuse("missing_session_header")
        context = self._scope_context(session_id)
        scope = self.transport.start_model_call_for(context)
        return GrokModelScope(
            audience="inference",
            token=scope["token"],
            native_session_id=session_id,
            native_work_ref=cast(str, context.native_work_ref),
        )

    def attribute_mcp_request(self, headers: Mapping[str, str]) -> GrokToolScope:
        """Per-request MCP hook used by the supervisor-local MCP relay. Refusals are never forwarded."""
        session_id = _header(headers, GROK_MCP_SESSION_HEADER)
        if session_id is None:
            self._refuse("missing_session_header")
        context = self._scope_context(session_id)
        self.transport.start_tool_call(session_id)
        return GrokToolScope(
            audience="knowledge",
            token=context.knowledge_token,
            native_session_id=session_id,
            native_work_ref=cast(str, context.native_work_ref),
        )

    def tracked_sessions(self) -> frozenset[str]:
        """Sessions this adapter still holds attribution or status state for. Confirmed unload releases it."""
        sessions = set(self._operations) | set(self._terminals) | set(self._replays) | set(self._read_locks)
        sessions |= self._known | set(self._run_ids) | self._bound
        return frozenset(sessions)

    # Internals ------------------------------------------------------------------------------

    def _refuse(self, reason: str) -> NoReturn:
        self.transport.unattributed_starts += 1
        raise UnattributedCall(reason)

    def _require_pins(self, handle: SessionHandle) -> None:
        if handle.provider != "xai" or handle.model != self.profile.model:
            raise GrokBindingMismatch("model_pin_mismatch")

    def _in_flight(self, session_id: str) -> _Operation | None:
        operation = self._operations.get(session_id)
        if operation is None or operation.task.done():
            return None
        return operation

    def _scope_context(self, session_id: str) -> OperationContext:
        if session_id in self._closed:
            self._refuse("closed_session")
        if session_id not in self._known:
            self._refuse("unknown_session")
        operation = self._in_flight(session_id)
        if operation is None:
            self._refuse("unbound_session")
        current = self.transport.current(session_id)
        # The transport copy carries any token refresh pushed for this operation.
        if current is not None and current.native_work_ref == operation.message_id:
            return current
        return operation.context

    def _start(
        self,
        handle: SessionHandle,
        authority: OperationAuthority,
        message_id: str,
        kind: Literal["prompt", "compaction"],
        text: str,
    ) -> _Operation:
        """Bind the session to this prompt before the frame is sent, then send it."""
        session_id = handle.native_session_id
        context = OperationContext(
            native_session_id=session_id,
            native_work_ref=message_id,
            provider_session_id=handle.provider_session_id,
            session_generation=handle.session_generation,
            active_agent_run_id=self._remember_run(session_id),
            ownership_epoch=handle.ownership_epoch,
            runtime_incarnation_id=handle.runtime_incarnation_id,
            inference_token=authority.inference_token,
            knowledge_token=authority.knowledge_token,
        )
        self.transport.bind(context)
        self._bound.add(session_id)
        self._known.add(session_id)
        params = {"sessionId": session_id, "messageId": message_id, "prompt": [{"type": "text", "text": text}]}
        task: asyncio.Task[object] = asyncio.get_running_loop().create_task(
            self._rpc.request(GROK_METHODS["submit"], params), name=f"grok-prompt-{session_id}"
        )
        operation = _Operation(context=context, message_id=message_id, kind=kind, task=task)
        self._operations[session_id] = operation
        task.add_done_callback(lambda _task: self._settle(operation))
        return operation

    def _settle(self, operation: _Operation) -> None:
        """The prompt request finished: the turn is over. Record it, publish its end, release the scope."""
        session_id = operation.context.native_session_id
        task = operation.task
        exc = None if task.cancelled() else task.exception()
        if self._operations.get(session_id) is operation:
            del self._operations[session_id]
            self.transport.unbind(session_id)
        if isinstance(exc, ConnectionError):
            return
        terminals = self._terminals.setdefault(session_id, {})
        if isinstance(exc, RpcProtocolError) and _peer_refusal(exc):
            terminals[operation.message_id] = _Terminal(status=None, stop_reason=None, echoed_message_id=None)
            return
        if exc is not None or task.cancelled():
            terminals[operation.message_id] = _Terminal(status="unknown", stop_reason=None, echoed_message_id=None)
            return
        result = _object(task.result())
        if result is None:
            terminals[operation.message_id] = _Terminal(status="unknown", stop_reason=None, echoed_message_id=None)
            return
        echoed = result.get("userMessageId")
        stop_reason = result.get("stopReason")
        terminals[operation.message_id] = _Terminal(
            status=cast(NativeWorkStatus, stop_status(stop_reason)),
            stop_reason=stop_reason if isinstance(stop_reason, str) else None,
            echoed_message_id=echoed if isinstance(echoed, str) else None,
        )
        queue = self._queue_for(session_id)
        for event in terminal_events(operation.context, result, compaction=operation.kind == "compaction"):
            queue.put_nowait(event)

    async def _replay(self, session_id: str) -> list[dict[str, Any]]:
        """Persisted session updates, replayed by the build in answer to `session/load`.

        Updates for this session that arrive while the load is outstanding are history, not live work.
        Reads of one session are serialized so two replays never interleave.
        """
        lock = self._read_locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            # Let the RPC reader and the notification consumer run, so updates already received are
            # handled as live work before the replay window opens.
            for _ in range(2):
                await asyncio.sleep(0)
            collected: list[dict[str, Any]] = []
            self._replays[session_id] = collected
            try:
                result = await self._rpc.request(
                    GROK_METHODS["history"], {"sessionId": session_id, "cwd": GROK_SESSION_CWD, "mcpServers": []}
                )
            finally:
                self._replays.pop(session_id, None)
            _check_model(_require_object(result, "invalid load result"))
            return collected

    async def _locate_input(self, session_id: str, message_id: str) -> str | None | _Unreadable:
        try:
            replay = await self._replay(session_id)
        except (*_READ_ERRORS, GrokBindingMismatch):
            return _UNREADABLE
        for update in replay:
            if update.get("sessionUpdate") == "user_message_chunk" and update.get("messageId") == message_id:
                return message_id
        return None

    def _forget_session(self, session_id: str) -> None:
        """Residency is bounded: a closed session keeps no attribution, status or binding state.

        Its event queue is kept, so an `events(handle)` stream opened earlier still receives the work
        of the same session after `resume_session`.
        """
        self._operations.pop(session_id, None)
        self._terminals.pop(session_id, None)
        self._replays.pop(session_id, None)
        self._read_locks.pop(session_id, None)
        self._known.discard(session_id)
        self._run_ids.pop(session_id, None)
        self._bound.discard(session_id)
        self._closed.add(session_id)
        self.transport.unbind(session_id)

    def _on_notification(self, params: NotificationParams) -> None:
        if params.method != "session/update":
            # `_x.ai/*` extension notifications are not work events; nothing is inferred from them.
            return
        session_id = params.get("sessionId")
        update = _object(params.get("update"))
        if not isinstance(session_id, str) or session_id == "" or update is None:
            self.rejected_events += 1
            return
        replay = self._replays.get(session_id)
        if replay is not None:
            replay.append(update)
            return
        operation = self._in_flight(session_id)
        if operation is None:
            # Background or auto-wake work no prompt of ours started: never published, always counted.
            self.rejected_events += 1
            self.unbound_updates += 1
            return
        try:
            event = normalize_grok_update(
                params, operation.context, operation.tool_calls, pinned_model_option=GROK_MODEL_CATALOG_KEY
            )
        except GrokEventRejected:
            self.rejected_events += 1
            return
        if event is None:
            return
        if event.payload_type == "model_rerouted":
            self.model_reroutes += 1
        elif event.payload_type == "disallowed_item":
            self.disallowed_items += 1
        self._queue_for(session_id).put_nowait(event)


def create_grok_adapter(rpc: NativeRpcClient, profile: RuntimeProfile) -> GrokBuildHarnessAdapter:
    """Adapter for the frozen build only (`GROK_BUILD`: version plus native binary digest).

    Call inside a running event loop, then `await adapter.initialize()` before any other call.
    """
    if profile.provider != "xai":
        raise ValueError("profile_provider_mismatch")
    if profile.harness_build != GROK_BUILD:
        raise ValueError("unqualified_harness_build")
    return GrokBuildHarnessAdapter(rpc, TransportContext(), profile)


def _check_model(body: Mapping[str, Any]) -> None:
    current = model_option(body.get("configOptions"))
    if current is None:
        raise GrokBindingMismatch("model_unverified")
    if current != GROK_MODEL_CATALOG_KEY:
        raise GrokBindingMismatch("model_drift")


def _history_items(session_id: str, replay: list[dict[str, Any]], provisional_turn: str | None) -> list[HistoryItem]:
    """Public user and assistant text, grouped per message. Reasoning, plans and tools are filtered."""
    items: list[HistoryItem] = []
    turn: str | None = None
    current: tuple[str, str] | None = None
    texts: list[str] = []

    def flush() -> None:
        if current is None:
            return
        role, item_id = current
        items.append(
            HistoryItem(
                native_item_id=item_id,
                native_work_ref=turn,
                role=cast(Literal["user", "assistant"], role),
                text="".join(texts),
                provisional=role == "assistant" and turn is not None and turn == provisional_turn,
            )
        )

    for index, update in enumerate(replay):
        kind = update.get("sessionUpdate")
        if kind not in {"user_message_chunk", "agent_message_chunk"}:
            continue
        content = _object(update.get("content")) or {}
        if content.get("type") != "text":
            continue
        role = "user" if kind == "user_message_chunk" else "assistant"
        raw_id = update.get("messageId")
        item_id = raw_id if isinstance(raw_id, str) and raw_id != "" else f"{session_id}:{index}"
        if current is None or current[0] != role or (isinstance(raw_id, str) and current[1] != raw_id):
            flush()
            texts = []
            if role == "user":
                turn = raw_id if isinstance(raw_id, str) and raw_id != "" else None
            current = (role, item_id)
        text = content.get("text")
        texts.append(text if isinstance(text, str) else "")
    flush()
    return items


def _agent_request(payload: bytes) -> dict[str, Any] | None:
    """An agent-to-client JSON-RPC request (method plus id, no result or error), else None."""
    try:
        message = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        return None
    body = _object(message)
    if body is None or not isinstance(body.get("method"), str):
        return None
    if body.get("id") is None or "result" in body or "error" in body:
        return None
    return body


def _reject_option(params: object) -> str | None:
    for option in _objects((_object(params) or {}).get("options")):
        kind = option.get("kind")
        option_id = option.get("optionId")
        if isinstance(kind, str) and kind.startswith("reject") and isinstance(option_id, str):
            return option_id
    return None


def _peer_refusal(exc: RpcProtocolError) -> bool:
    """A refusal the build sent for this request id. `NativeRpcClient` gives a peer error response an
    integer code; errors it raises locally (garbled stream, invalid result) carry a string code."""
    code = exc.args[0] if exc.args else None
    return isinstance(code, int) and not isinstance(code, bool) and code in _REFUSAL_CODES


def _header(headers: Mapping[str, str], name: str) -> str | None:
    for key, value in headers.items():
        if key.lower() == name and value != "":
            return value
    return None


def _load_object(raw: bytes) -> dict[str, Any]:
    """Strict JSON object: duplicate keys, NaN/Infinity and a BOM are rejected."""
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ValueError("bom")

    def pairs(entries: list[tuple[str, Any]]) -> dict[str, Any]:
        document: dict[str, Any] = {}
        for key, value in entries:
            if key in document:
                raise ValueError("duplicate key")
            document[key] = value
        return document

    def constant(_name: str) -> None:
        raise ValueError("non-finite number")

    value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    if not isinstance(value, dict):
        raise ValueError("not an object")
    return cast(dict[str, Any], value)


def _require_object(value: object, message: str) -> dict[str, Any]:
    body = _object(value)
    if body is None:
        raise RpcProtocolError(message)
    return body


def _object(value: object) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return cast(dict[str, Any], value)
    return None


def _objects(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [cast(dict[str, Any], entry) for entry in cast(list[object], value) if isinstance(entry, dict)]
