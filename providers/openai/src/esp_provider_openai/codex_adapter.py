"""Codex App Server candidate adapter for the exact captured build.

Operation names, request fields and notification shapes are frozen from the protocol capture
of `codex-cli 0.159.3` (`providers/openai/integration/protocol-schema.json`). No lifecycle
method is guessed: a primitive the build does not declare is reported unsupported instead.

Acceptance is claimed only after the build's persisted thread history shows the user message
carrying this request's `clientUserMessageId`. Model requests are attributed from the
`client_metadata["x-codex-turn-metadata"]` thread and turn ids the build declares it sends on
every Responses request, never from a process-wide header.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
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
from esp_provider_openai.events import CodexEventRejected, normalize_codex_notification, notification_turn_id
from esp_provider_shared.adapter import HarnessAdapter, UnsupportedPrimitive
from esp_provider_shared.rpc import (
    FRAME_LIMIT_BYTES,
    FrameTooLarge,
    NativeRpcClient,
    NotificationParams,
    ResponseLost,
    RpcProtocolError,
)
from esp_provider_shared.transport_context import OperationContext, TransportContext, UnattributedCall

CODEX_BUILD = "codex-cli 0.159.3"
# Key of the gateway relay entry in infra/runtime/codex/config.toml `[model_providers]`.
CODEX_MODEL_PROVIDER = "esp_gateway"
# ESP primitive -> captured app-server method. Every value is in the capture's client request list.
CODEX_METHODS: Mapping[str, str] = MappingProxyType(
    {
        "handshake": "initialize",
        "create": "thread/start",
        "resume": "thread/resume",
        "submit": "turn/start",
        "status": "thread/read",
        "history": "thread/turns/list",
        "items": "thread/items/list",
        "cancel": "turn/interrupt",
        "unload": "thread/unsubscribe",
        "loaded": "thread/loaded/list",
        "compact": "thread/compact/start",
        "delete": "thread/delete",
    }
)
CODEX_CLIENT_NOTIFICATIONS: tuple[str, ...] = ("initialized",)
# Suppressed at initialize: hidden reasoning, host/account metadata and unrelated UI updates.
CODEX_OPT_OUT_NOTIFICATIONS: tuple[str, ...] = (
    "item/reasoning/textDelta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "remoteControl/status/changed",
    "account/updated",
    "account/rateLimits/updated",
    "app/list/updated",
    "skills/changed",
    "fs/changed",
    "mcpServer/startupStatus/updated",
)
TURN_METADATA_KEY = "x-codex-turn-metadata"
MAX_MODEL_REQUEST_BYTES = 1_048_576
# One byte for the newline plus one so an exactly-at-limit line is still readable.
STDIO_READER_LIMIT = FRAME_LIMIT_BYTES + 2

_METHOD_NOT_FOUND = -32601
_UNLOAD_STATUSES = frozenset({"unsubscribed", "notSubscribed", "notLoaded"})
_READ_ERRORS = (RpcProtocolError, ResponseLost, OSError, FrameTooLarge)


class CodexBindingMismatch(Exception):
    """The build reported a model, provider, policy or persistence mode other than the pinned one."""


class UnloadUnconfirmed(Exception):
    """The build accepted the unsubscribe but still lists the thread as loaded."""


class _Unreadable:
    """Persisted history could not be read, so acceptance cannot be decided."""


_UNREADABLE = _Unreadable()


class CodexModelScope(BaseModel):
    """Inference scope for one model request, resolved from the build's own turn metadata."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    audience: Literal["inference"]
    token: str = Field(min_length=1)
    native_session_id: str = Field(min_length=1)
    native_work_ref: str = Field(min_length=1)


class LineWriter(Protocol):
    def is_closing(self) -> bool: ...

    def write(self, data: bytes) -> None: ...

    async def drain(self) -> None: ...


class JsonlFrameTransport:
    """App-server stdio framing: one JSON-RPC message per newline-terminated line."""

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
            raise ConnectionError("app-server stdin is closed")
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


class CodexHarnessAdapter(HarnessAdapter):
    """One Codex app-server process. Threads are addressed only by their explicit thread id."""

    def __init__(self, rpc: NativeRpcClient, transport: TransportContext, profile: RuntimeProfile) -> None:
        self.profile = profile
        self.page_limit = 50
        self.max_pages = 200
        self.acceptance_confirm_attempts = 5
        self.acceptance_confirm_interval = 0.05
        self.unload_confirm_timeout = 2.0
        self.model_reroutes = 0
        self.disallowed_items = 0
        self._contexts: dict[str, OperationContext] = {}
        # Context of the operation that owns each accepted turn, so late output keeps its own epoch.
        self._turn_contexts: dict[tuple[str, str], OperationContext] = {}
        self._known_turns: dict[str, set[str]] = {}
        self._closed_turns: dict[str, set[str]] = {}
        self._closed_threads: dict[str, asyncio.Event] = {}
        super().__init__(rpc, transport)

    async def initialize(self, *, client_name: str = "esp-supervisor", client_version: str = "1") -> dict[str, str]:
        result = await self._rpc.request(
            CODEX_METHODS["handshake"],
            {
                "clientInfo": {"name": client_name, "version": client_version},
                "capabilities": {
                    "experimentalApi": False,
                    "optOutNotificationMethods": list(CODEX_OPT_OUT_NOTIFICATIONS),
                },
            },
        )
        body = _require_object(result, "invalid initialize result")
        sanitized: dict[str, str] = {}
        for key in ("userAgent", "platformFamily", "platformOs"):
            value = body.get(key)
            if not isinstance(value, str) or value == "":
                raise RpcProtocolError("invalid initialize result")
            sanitized[key] = value
        # Keep the product token only; the rest of the user agent describes the host.
        sanitized["userAgent"] = sanitized["userAgent"].split(" ", 1)[0]
        await self._rpc.notify(CODEX_CLIENT_NOTIFICATIONS[0])
        return sanitized

    async def create_session(self, reservation: SessionReservation) -> SessionHandle:
        if reservation.provider != "openai" or reservation.model != self.profile.model:
            raise CodexBindingMismatch("model_pin_mismatch")
        result = await self._rpc.request(
            CODEX_METHODS["create"],
            {
                "model": reservation.model,
                "modelProvider": CODEX_MODEL_PROVIDER,
                "approvalPolicy": "never",
                "sandbox": "read-only",
                "ephemeral": False,
            },
        )
        thread_id = _checked_thread(result, model=reservation.model, expected=None)
        self._remember_run(thread_id)
        data = reservation.model_dump()
        data["native_session_id"] = thread_id
        return SessionHandle.model_validate(data)

    async def resume_session(self, handle: SessionHandle) -> SessionHandle:
        self._require_pins(handle)
        result = await self._rpc.request(
            CODEX_METHODS["resume"],
            {
                "threadId": handle.native_session_id,
                "excludeTurns": True,
                "model": handle.model,
                "modelProvider": CODEX_MODEL_PROVIDER,
                "approvalPolicy": "never",
                "sandbox": "read-only",
            },
        )
        _checked_thread(result, model=handle.model, expected=handle.native_session_id)
        self._closed_threads.pop(handle.native_session_id, None)
        self._remember_run(handle.native_session_id)
        return handle

    async def submit(
        self,
        handle: SessionHandle,
        message: SubmitMessage,
        authority: OperationAuthority,
    ) -> SubmissionResult:
        self._require_pins(handle)
        if message.conversation_id != handle.conversation_id:
            raise CodexBindingMismatch("conversation_mismatch")
        thread_id = handle.native_session_id
        self._bind_operation(handle, authority, None)
        known_before = frozenset(self._known_turns.get(thread_id, ()))
        text_elements: list[object] = []
        params: dict[str, object] = {
            "threadId": thread_id,
            "input": [{"type": "text", "text": message.message, "text_elements": text_elements}],
            "clientUserMessageId": message.client_request_id,
        }
        try:
            result = await self._rpc.request(CODEX_METHODS["submit"], params)
        except ResponseLost:
            return Unconfirmed(kind="unconfirmed", native_work_ref=None)
        except OSError:
            return NotSubmitted(kind="not_submitted", code="not_sent")
        except RpcProtocolError:
            # An explicit rejection is conclusive only if persisted history lacks this input.
            located = await self._locate_input(thread_id, message.client_request_id, None)
            if located is None:
                return NotSubmitted(kind="not_submitted", code="native_rejected")
            return Unconfirmed(kind="unconfirmed", native_work_ref=located if isinstance(located, str) else None)
        turn_id = _turn_id_of(result)
        if turn_id is None:
            return Unconfirmed(kind="unconfirmed", native_work_ref=None)
        if turn_id in known_before:
            # The build steered this input into work that already existed. It is not new accepted work.
            return Unconfirmed(kind="unconfirmed", native_work_ref=turn_id)
        self._known_turns.setdefault(thread_id, set()).add(turn_id)
        attempts = max(1, self.acceptance_confirm_attempts)
        for attempt in range(attempts):
            located = await self._locate_input(thread_id, message.client_request_id, turn_id)
            if located == turn_id:
                self._bind_operation(handle, authority, turn_id)
                return Accepted(kind="accepted", work=WorkRef(native_session_id=thread_id, native_work_ref=turn_id))
            if attempt + 1 < attempts:
                await asyncio.sleep(self.acceptance_confirm_interval)
        return Unconfirmed(kind="unconfirmed", native_work_ref=turn_id)

    async def continue_work(
        self,
        handle: SessionHandle,
        work: WorkRef,
        authority: OperationAuthority,
    ) -> SubmissionResult:
        # The captured build declares no saved-state continuation method. Nothing is sent.
        return NotSubmitted(kind="not_submitted", code="continue_unsupported")

    async def compact(self, handle: SessionHandle, authority: OperationAuthority) -> Literal["requested"]:
        """Manual compaction. The thread is bound first so its model requests carry this scope."""
        self._require_pins(handle)
        self._bind_operation(handle, authority, None)
        result = await self._rpc.request(CODEX_METHODS["compact"], {"threadId": handle.native_session_id})
        _require_object(result, "invalid compaction result")
        return "requested"

    async def inspect(self, handle: SessionHandle, request_id: str | None = None) -> NativeStatus:
        thread_id = handle.native_session_id
        thread_state = await self._thread_state(thread_id)
        if request_id is not None:
            located = await self._locate_input(thread_id, request_id, None)
            if isinstance(located, _Unreadable):
                raise RpcProtocolError("history_unreadable")
            if located is None:
                return NativeStatus(
                    status=_thread_only(thread_state),
                    native_work_ref=None,
                    request_id=request_id,
                    saved_input_available=False,
                )
            turn = await self._find_turn(thread_id, located)
            return NativeStatus(
                status=_work_status(None if turn is None else turn.get("status"), thread_state),
                native_work_ref=located,
                request_id=request_id,
                saved_input_available=True,
            )
        latest = await self._latest_turn(thread_id)
        if latest is None:
            return NativeStatus(status=_thread_only(thread_state), saved_input_available=False)
        latest_id = latest.get("id")
        return NativeStatus(
            status=_work_status(latest.get("status"), thread_state),
            native_work_ref=latest_id if isinstance(latest_id, str) else None,
            saved_input_available=True,
        )

    async def read_history(self, handle: SessionHandle) -> NativeHistorySnapshot:
        thread_id = handle.native_session_id
        items: list[HistoryItem] = []
        cursor: str | None = None
        for _ in range(self.max_pages):
            params: dict[str, Any] = {
                "threadId": thread_id,
                "itemsView": "full",
                "sortDirection": "asc",
                "limit": self.page_limit,
            }
            if cursor is not None:
                params["cursor"] = cursor
            body = _require_object(await self._rpc.request(CODEX_METHODS["history"], params), "invalid history")
            for turn in _objects(body.get("data")):
                items.extend(_history_items(turn))
            next_cursor = body.get("nextCursor")
            if not isinstance(next_cursor, str):
                break
            cursor = next_cursor
        else:
            raise RpcProtocolError("history_unbounded")
        status = await self.inspect(handle)
        return NativeHistorySnapshot(items=items, native_cursor=None, status=status, provenance=[])

    async def cancel(self, handle: SessionHandle, work: WorkRef) -> Literal["requested", "stopped", "unknown"]:
        if work.native_session_id != handle.native_session_id:
            raise ValueError("work_session_mismatch")
        try:
            result = await self._rpc.request(
                CODEX_METHODS["cancel"],
                {"threadId": handle.native_session_id, "turnId": work.native_work_ref},
            )
        except (RpcProtocolError, ResponseLost, OSError):
            return "unknown"
        if not isinstance(result, dict):
            return "unknown"
        return "requested"

    async def unload(self, handle: SessionHandle) -> Literal["unloaded", "unsupported"]:
        thread_id = handle.native_session_id
        closed = self._closed_event(thread_id)
        try:
            result = await self._rpc.request(CODEX_METHODS["unload"], {"threadId": thread_id})
        except RpcProtocolError as exc:
            if exc.args and exc.args[0] == _METHOD_NOT_FOUND:
                return "unsupported"
            raise
        status = _require_object(result, "invalid unload result").get("status")
        if status not in _UNLOAD_STATUSES:
            raise RpcProtocolError("invalid unload status")
        if status == "unsubscribed":
            try:
                await asyncio.wait_for(closed.wait(), timeout=self.unload_confirm_timeout)
            except TimeoutError:
                pass
        if await self._is_loaded(thread_id):
            raise UnloadUnconfirmed(thread_id)
        self._forget_turns(thread_id)
        return "unloaded"

    async def export_history(self, handle: SessionHandle) -> None:
        # The captured build declares no export method; do not invent one.
        raise UnsupportedPrimitive("export")

    async def delete_history(self, handle: SessionHandle) -> None:
        try:
            await self._rpc.request(CODEX_METHODS["delete"], {"threadId": handle.native_session_id})
        except RpcProtocolError as exc:
            if exc.args and exc.args[0] == _METHOD_NOT_FOUND:
                raise UnsupportedPrimitive("delete") from exc
            raise

    def attribute_model_request(self, body: bytes) -> CodexModelScope:
        """Per-request model hook used by the supervisor-local relay. Refusals are never forwarded."""
        if len(body) > MAX_MODEL_REQUEST_BYTES:
            self._refuse("oversize")
        try:
            document = _load_object(body)
        except ValueError:
            self._refuse("invalid_body")
        identity = _turn_metadata(document)
        if identity is None:
            self._refuse("missing_turn_metadata")
        thread_id, turn_id = identity
        if turn_id in self._closed_turns.get(thread_id, set()):
            self._refuse("stale_turn")
        scope = self.transport.start_model_call(thread_id)
        return CodexModelScope(
            audience="inference",
            token=scope["token"],
            native_session_id=thread_id,
            native_work_ref=turn_id,
        )

    # Internals ------------------------------------------------------------------------------

    def _refuse(self, reason: str) -> NoReturn:
        self.transport.unattributed_starts += 1
        raise UnattributedCall(reason)

    def _require_pins(self, handle: SessionHandle) -> None:
        if handle.provider != "openai" or handle.model != self.profile.model:
            raise CodexBindingMismatch("model_pin_mismatch")

    def _bind_operation(self, handle: SessionHandle, authority: OperationAuthority, work_ref: str | None) -> None:
        context = OperationContext(
            native_session_id=handle.native_session_id,
            native_work_ref=work_ref,
            provider_session_id=handle.provider_session_id,
            session_generation=handle.session_generation,
            active_agent_run_id=self._remember_run(handle.native_session_id),
            ownership_epoch=handle.ownership_epoch,
            runtime_incarnation_id=handle.runtime_incarnation_id,
            inference_token=authority.inference_token,
            knowledge_token=authority.knowledge_token,
        )
        self.transport.bind(context)
        self._contexts[handle.native_session_id] = context
        if work_ref is not None:
            self._turn_contexts[(handle.native_session_id, work_ref)] = context
        self._bound.add(handle.native_session_id)

    def _forget_turns(self, thread_id: str) -> None:
        """Per-turn state is bounded by residency: an unloaded thread keeps none."""
        self._known_turns.pop(thread_id, None)
        self._closed_turns.pop(thread_id, None)
        for key in [key for key in self._turn_contexts if key[0] == thread_id]:
            del self._turn_contexts[key]

    def _closed_event(self, thread_id: str) -> asyncio.Event:
        event = self._closed_threads.get(thread_id)
        if event is None:
            event = asyncio.Event()
            self._closed_threads[thread_id] = event
        return event

    async def _thread_state(self, thread_id: str) -> str:
        result = await self._rpc.request(CODEX_METHODS["status"], {"threadId": thread_id, "includeTurns": False})
        thread = _object(_require_object(result, "invalid thread").get("thread"))
        if thread is None or thread.get("id") != thread_id:
            raise RpcProtocolError("native_session_mismatch")
        status = _object(thread.get("status"))
        state = None if status is None else status.get("type")
        return state if isinstance(state, str) else "unknown"

    async def _locate_input(
        self, thread_id: str, client_request_id: str, turn_id: str | None
    ) -> str | None | _Unreadable:
        cursor: str | None = None
        for _ in range(self.max_pages):
            params: dict[str, Any] = {"threadId": thread_id, "limit": self.page_limit, "sortDirection": "asc"}
            if turn_id is not None:
                params["turnId"] = turn_id
            if cursor is not None:
                params["cursor"] = cursor
            try:
                result = await self._rpc.request(CODEX_METHODS["items"], params)
            except _READ_ERRORS:
                return _UNREADABLE
            body = _object(result)
            if body is None:
                return _UNREADABLE
            for entry in _objects(body.get("data")):
                item = _object(entry.get("item"))
                entry_turn = entry.get("turnId")
                if (
                    item is not None
                    and item.get("type") == "userMessage"
                    and item.get("clientId") == client_request_id
                    and isinstance(entry_turn, str)
                    and entry_turn != ""
                ):
                    return entry_turn
            next_cursor = body.get("nextCursor")
            if not isinstance(next_cursor, str):
                return None
            cursor = next_cursor
        return _UNREADABLE

    async def _latest_turn(self, thread_id: str) -> dict[str, Any] | None:
        params = {"threadId": thread_id, "limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"}
        body = _require_object(await self._rpc.request(CODEX_METHODS["history"], params), "invalid turns")
        turns = _objects(body.get("data"))
        return turns[0] if turns else None

    async def _find_turn(self, thread_id: str, turn_id: str) -> dict[str, Any] | None:
        cursor: str | None = None
        for _ in range(self.max_pages):
            params: dict[str, Any] = {
                "threadId": thread_id,
                "limit": self.page_limit,
                "sortDirection": "desc",
                "itemsView": "notLoaded",
            }
            if cursor is not None:
                params["cursor"] = cursor
            body = _require_object(await self._rpc.request(CODEX_METHODS["history"], params), "invalid turns")
            for turn in _objects(body.get("data")):
                if turn.get("id") == turn_id:
                    return turn
            next_cursor = body.get("nextCursor")
            if not isinstance(next_cursor, str):
                return None
            cursor = next_cursor
        return None

    async def _is_loaded(self, thread_id: str) -> bool:
        cursor: str | None = None
        for _ in range(self.max_pages):
            params: dict[str, Any] = {"limit": self.page_limit}
            if cursor is not None:
                params["cursor"] = cursor
            body = _require_object(await self._rpc.request(CODEX_METHODS["loaded"], params), "invalid loaded list")
            data = body.get("data")
            if isinstance(data, list) and thread_id in cast(list[object], data):
                return True
            next_cursor = body.get("nextCursor")
            if not isinstance(next_cursor, str):
                return False
            cursor = next_cursor
        # An unbounded listing cannot confirm absence.
        return True

    def _on_notification(self, params: NotificationParams) -> None:
        method = params.method
        thread_value = params.get("threadId")
        thread_id = thread_value if isinstance(thread_value, str) and thread_value != "" else None
        if method == "thread/closed":
            if thread_id is not None:
                self._closed_event(thread_id).set()
            return
        if thread_id is not None and method in {"turn/started", "turn/completed"}:
            turn = _object(params.get("turn"))
            turn_id = None if turn is None else turn.get("id")
            if isinstance(turn_id, str) and turn_id != "":
                self._known_turns.setdefault(thread_id, set()).add(turn_id)
                if method == "turn/completed":
                    self._closed_turns.setdefault(thread_id, set()).add(turn_id)
        context = None if thread_id is None else self._contexts.get(thread_id)
        turn_id = notification_turn_id(method, params)
        if thread_id is not None and turn_id is not None:
            context = self._turn_contexts.get((thread_id, turn_id), context)
        try:
            event = normalize_codex_notification(method, params, context)
        except CodexEventRejected:
            self.rejected_events += 1
            return
        if event is None:
            return
        if event.payload_type == "model_rerouted":
            self.model_reroutes += 1
        elif event.payload_type == "disallowed_item":
            self.disallowed_items += 1
        self._queue_for(event.native_session_id).put_nowait(event)


def create_codex_adapter(rpc: NativeRpcClient, profile: RuntimeProfile) -> HarnessAdapter:
    """Adapter for the frozen build only. Call inside a running event loop."""
    if profile.provider != "openai":
        raise ValueError("profile_provider_mismatch")
    if profile.harness_build != CODEX_BUILD:
        raise ValueError("unqualified_harness_build")
    return CodexHarnessAdapter(rpc, TransportContext(), profile)


def _checked_thread(result: object, *, model: str, expected: str | None) -> str:
    body = _require_object(result, "invalid thread result")
    thread = _object(body.get("thread"))
    thread_id = None if thread is None else thread.get("id")
    if thread is None or not isinstance(thread_id, str) or thread_id == "":
        raise RpcProtocolError("missing thread id")
    if expected is not None and thread_id != expected:
        raise RpcProtocolError("native_session_mismatch")
    if body.get("model") != model:
        raise CodexBindingMismatch("model_drift")
    if body.get("modelProvider") != CODEX_MODEL_PROVIDER or thread.get("modelProvider") != CODEX_MODEL_PROVIDER:
        raise CodexBindingMismatch("provider_drift")
    if body.get("approvalPolicy") != "never":
        raise CodexBindingMismatch("approval_policy_drift")
    sandbox = _object(body.get("sandbox"))
    if sandbox is None or sandbox.get("type") != "readOnly":
        raise CodexBindingMismatch("sandbox_drift")
    if thread.get("ephemeral") is not False:
        raise CodexBindingMismatch("ephemeral_thread")
    return thread_id


def _turn_id_of(result: object) -> str | None:
    body = _object(result)
    turn = None if body is None else _object(body.get("turn"))
    turn_id = None if turn is None else turn.get("id")
    if isinstance(turn_id, str) and turn_id != "":
        return turn_id
    return None


def _thread_only(thread_state: str) -> NativeWorkStatus:
    if thread_state == "active":
        return "running"
    if thread_state in {"idle", "notLoaded"}:
        return "idle"
    return "unknown"


def _work_status(turn_status: object, thread_state: str) -> NativeWorkStatus:
    if turn_status == "completed":
        return "completed"
    if turn_status == "interrupted":
        return "interrupted"
    if turn_status == "failed":
        return "failed"
    if turn_status == "inProgress":
        # A persisted in-progress turn on a thread that is not active has an unknown outcome.
        return "running" if thread_state == "active" else "unknown"
    return _thread_only(thread_state)


def _history_items(turn: Mapping[str, Any]) -> list[HistoryItem]:
    turn_id = turn.get("id")
    work_ref = turn_id if isinstance(turn_id, str) and turn_id != "" else None
    provisional = turn.get("status") == "inProgress"
    items: list[HistoryItem] = []
    for item in _objects(turn.get("items")):
        item_id = item.get("id")
        if not isinstance(item_id, str) or item_id == "":
            continue
        kind = item.get("type")
        if kind == "userMessage":
            texts = [
                part.get("text")
                for part in _objects(item.get("content"))
                if part.get("type") == "text" and isinstance(part.get("text"), str)
            ]
            text = "\n".join(cast(list[str], texts))
            items.append(HistoryItem(native_item_id=item_id, native_work_ref=work_ref, role="user", text=text))
        elif kind == "agentMessage":
            text_value = item.get("text")
            items.append(
                HistoryItem(
                    native_item_id=item_id,
                    native_work_ref=work_ref,
                    role="assistant",
                    text=text_value if isinstance(text_value, str) else "",
                    provisional=provisional,
                )
            )
        # Reasoning, plans, tool calls and compaction markers are not public history items.
    return items


def _turn_metadata(document: Mapping[str, Any]) -> tuple[str, str] | None:
    client_metadata = _object(document.get("client_metadata"))
    raw = None if client_metadata is None else client_metadata.get(TURN_METADATA_KEY)
    if not isinstance(raw, str):
        return None
    try:
        metadata = _load_object(raw.encode("utf-8"))
    except ValueError:
        return None
    thread_id = metadata.get("thread_id")
    turn_id = metadata.get("turn_id")
    if not isinstance(thread_id, str) or thread_id == "" or not isinstance(turn_id, str) or turn_id == "":
        return None
    return thread_id, turn_id


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
