"""Captured Codex App Server peer for contract tests. No network and no real model.

Every request the adapter sends and every reply this peer builds is checked against the
frozen protocol capture of the exact installed build (`protocol-schema.json`). Model
requests are emitted with the turn-metadata shape that build declares, then passed
through the adapter's attribution hook the way the supervisor-local relay does.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, cast

from esp_contracts.api import SubmitMessage
from esp_contracts.qualification import PrimitiveEvidence, RuntimeProfile
from esp_contracts.runtime import OperationAuthority, SessionHandle, SessionReservation, SubmissionResult
from esp_provider_openai.codex_adapter import (
    CODEX_BUILD,
    CodexHarnessAdapter,
    create_codex_adapter,
)
from esp_provider_shared.rpc import NativeRpcClient
from esp_provider_shared.transport_context import UnattributedCall
from tests.support.contracts import EPOCH

ROOT = Path(__file__).resolve().parents[2]
CAPTURE_PATH = ROOT / "providers" / "openai" / "integration" / "protocol-schema.json"
CONFIG_PATH = ROOT / "infra" / "runtime" / "codex" / "config.toml"
CANDIDATE_PATH = ROOT / "docs" / "qualification" / "openai" / "candidate.json"
RPC_TIMEOUT = 2.0
LAB_MODEL = "codex-lab-model"
LAB_PROVIDER_ID = "esp_gateway"
CANARY_A = "private-canary-A"
CANARY_B = "private-canary-B"
HARNESS_INSTANCE_ID = "44444444-4444-4444-8444-444444444444"
CONV_A = "11111111-1111-4111-8111-111111111111"
CONV_B = "11111111-1111-4111-8111-111111111112"
CONV_C = "11111111-1111-4111-8111-111111111113"
PROV_A = "22222222-2222-4222-8222-222222222221"
PROV_B = "22222222-2222-4222-8222-222222222222"
PROV_C = "22222222-2222-4222-8222-222222222223"
INC = "55555555-5555-4555-8555-555555555551"
_METHOD_NOT_FOUND = -32601
_INVALID_REQUEST = -32600

RelayKind = Literal["turn", "compaction"]


def load_capture() -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(CAPTURE_PATH.read_text(encoding="utf-8")))


def lab_profile(**overrides: object) -> RuntimeProfile:
    """Synthetic test profile. It names the frozen build but is not a qualified deployment."""
    base: dict[str, object] = {
        "provider": "openai",
        "model": LAB_MODEL,
        "harness_build": CODEX_BUILD,
        "image_digest": "synthetic:codex-lab-image",
        "configuration_digest": "synthetic:codex-lab-config",
        "transport_digest": "synthetic:codex-lab-transport",
        "storage_profile": "synthetic:memory",
        "tool_policy_digest": "synthetic:codex-lab-tools",
        "primitives": [PrimitiveEvidence(name="create", state="unproven")],
    }
    base.update(overrides)
    return RuntimeProfile.model_validate(base)


def shape_violations(label: str, value: object, shape: Mapping[str, Any]) -> list[str]:
    """Top-level key check against a captured {properties, required} shape."""
    if not isinstance(value, dict):
        return [f"{label}: expected object, got {type(value).__name__}"]
    keys = set(cast(dict[str, Any], value))
    allowed = set(cast(list[str], shape["properties"]))
    required = set(cast(list[str], shape["required"]))
    problems: list[str] = []
    for key in sorted(keys - allowed):
        problems.append(f"{label}: field {key!r} is not in the captured shape")
    for key in sorted(required - keys):
        problems.append(f"{label}: required field {key!r} is missing")
    return problems


@dataclass
class RelayRecord:
    kind: RelayKind
    emitting_thread: str
    turn_id: str
    forwarded: bool
    token: str | None = None
    attributed_thread: str | None = None
    refused_reason: str | None = None


@dataclass
class _Turn:
    id: str
    status: str = "inProgress"
    items: list[dict[str, Any]] = field(default_factory=lambda: [])
    persisted: list[dict[str, Any]] = field(default_factory=lambda: [])


@dataclass
class _Thread:
    id: str
    model: str
    provider: str
    turns: list[_Turn] = field(default_factory=lambda: [])
    loaded: bool = True


class CapturedCodexPeer:
    """FrameTransport plus fake app-server. `recv_frame` returns raw JSON bodies.

    Options are plain attributes so a test states the build behaviour it simulates.
    """

    def __init__(self, capture: Mapping[str, Any]) -> None:
        self.capture = capture
        self.client_requests = frozenset(cast(list[str], capture["client_requests"]))
        self.client_notifications = frozenset(cast(list[str], capture["client_notifications"]))
        self.mapped = frozenset(cast(dict[str, str], capture["esp_operation_mapping"]).values())
        self.violations: list[str] = []
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.notifications_sent: list[str] = []
        self.threads: dict[str, _Thread] = {}
        self.relay: Callable[[bytes, RelayKind, str, str], None] | None = None
        self.persist_user_messages = True
        self.hold_turn_acks = 0
        self.keep_running: set[str] = set()
        self.keep_loaded_after_unsubscribe = False
        self.reject_next_turn_start = False
        self.record_input_before_rejection = False
        self.lose_next_turn_ack = False
        self.fail_next_send = False
        self.steer_next_turn = False
        self.model_override: str | None = None
        self.auto_compact_before_sampling: set[str] = set()
        self.emit_reasoning = True
        self._held: list[dict[str, Any]] = []
        self._inbox: asyncio.Queue[bytes] = asyncio.Queue()
        self._enqueued = 0
        self._dequeued = 0
        self._waiters = 0
        self._dropped = False
        self._ordinal = 0

    # FrameTransport -------------------------------------------------------------------
    async def send_frame(self, payload: bytes) -> None:
        if self.fail_next_send:
            self.fail_next_send = False
            raise BrokenPipeError("stdin closed before write")
        message = json.loads(payload)
        if not isinstance(message, dict):
            raise AssertionError("frame was not a JSON object")
        self._dispatch(cast(dict[str, Any], message))

    async def recv_frame(self) -> bytes:
        if self._dropped and self._inbox.empty():
            raise ConnectionError("response lost")
        self._waiters += 1
        try:
            payload = await self._inbox.get()
        finally:
            self._waiters -= 1
        self._dequeued += 1
        if payload == b"":
            raise ConnectionError("response lost")
        return payload

    async def wait_idle(self) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + RPC_TIMEOUT
        while loop.time() < deadline:
            if self._waiters > 0 and self._inbox.empty() and self._dequeued >= self._enqueued:
                await asyncio.sleep(0)
                return
            await asyncio.sleep(0.01)
        raise AssertionError(f"adapter did not drain frames (enqueued={self._enqueued} dequeued={self._dequeued})")

    # Test controls ----------------------------------------------------------------------
    def requests_for(self, method: str) -> list[dict[str, Any]]:
        return [params for name, params in self.requests if name == method]

    def emit_model_request(self, thread_id: str, turn_id: str, kind: RelayKind, *, metadata: bool = True) -> None:
        thread = self.threads[thread_id]
        body: dict[str, Any] = {
            "model": thread.model,
            "instructions": "codex base instructions",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "lab"}]}],
            "stream": True,
        }
        if metadata:
            turn_metadata = {
                "session_id": thread_id,
                "thread_id": thread_id,
                "turn_id": turn_id,
                "window_id": f"{thread_id}:window",
            }
            body["client_metadata"] = {"x-codex-turn-metadata": json.dumps(turn_metadata)}
        if self.relay is None:
            raise AssertionError("no relay attached to the captured peer")
        self.relay(json.dumps(body).encode(), kind, thread_id, turn_id)

    def notify(self, method: str, params: dict[str, Any]) -> None:
        shapes = cast(dict[str, Any], self.capture["notification_shapes"])
        if method in shapes:
            self.violations.extend(shape_violations(f"notification {method}", params, shapes[method]))
        self.notifications_sent.append(method)
        self._enqueue({"method": method, "params": params, "emittedAtMs": 0})

    # Dispatch ---------------------------------------------------------------------------
    def _dispatch(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        if not isinstance(method, str):
            raise AssertionError(f"frame without method: {message!r}")
        params_value = message.get("params", {})
        params = cast(dict[str, Any], params_value) if isinstance(params_value, dict) else {}
        if "id" not in message:
            if method not in self.client_notifications:
                self.violations.append(f"client notification {method!r} is not in the capture")
            self.requests.append((method, params))
            return
        self.requests.append((method, params))
        if method not in self.client_requests:
            self.violations.append(f"method {method!r} is not a captured client request")
            self._error(message, _METHOD_NOT_FOUND, "Method not found")
            return
        if method not in self.mapped:
            self.violations.append(f"method {method!r} is outside the frozen operation mapping")
        shapes = cast(dict[str, Any], self.capture["shapes"])
        if method in shapes:
            self.violations.extend(shape_violations(f"{method} params", params, shapes[method]["params"]))
        handler = getattr(self, "_on_" + method.replace("/", "_"), None)
        if handler is None:
            self._error(message, _METHOD_NOT_FOUND, "Method not found")
            return
        cast(Callable[[dict[str, Any], dict[str, Any]], None], handler)(message, params)

    def _on_initialize(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        self._reply(
            message,
            "initialize",
            {
                "userAgent": "esp-supervisor/0.159.3 (lab)",
                "codexHome": "/isolated/codex-home",
                "platformFamily": "unix",
                "platformOs": "linux",
            },
        )

    def _on_thread_start(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        self._ordinal += 1
        thread_id = f"019a0000-0000-7000-8000-{self._ordinal:012d}"
        model = self.model_override or str(params.get("model"))
        thread = _Thread(id=thread_id, model=model, provider=str(params.get("modelProvider")))
        self.threads[thread_id] = thread
        self._reply(message, "thread/start", self._thread_envelope(thread))

    def _on_thread_resume(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        thread = self._thread(message, params)
        if thread is None:
            return
        thread.loaded = True
        self._reply(message, "thread/resume", self._thread_envelope(thread))

    def _on_turn_start(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        thread = self._thread(message, params)
        if thread is None:
            return
        for entry in cast(list[object], params.get("input", [])):
            variants = cast(dict[str, Any], self.capture["definitions"]["UserInput"])["variants"]
            self.violations.extend(shape_violations("turn/start input", entry, variants["text"]))
        if self.lose_next_turn_ack:
            self.lose_next_turn_ack = False
            self._record_user_message(thread, params, self._new_turn(thread))
            self._dropped = True
            self._inbox.put_nowait(b"")
            self._enqueued += 1
            return
        if self.reject_next_turn_start:
            self.reject_next_turn_start = False
            if self.record_input_before_rejection:
                self._record_user_message(thread, params, self._new_turn(thread))
            self._error(message, _INVALID_REQUEST, "turn rejected")
            return
        if self.hold_turn_acks > 0:
            self._held.append(message)
            if len(self._held) >= self.hold_turn_acks:
                self.hold_turn_acks = 0
                held = list(reversed(self._held))
                self._held.clear()
                for item in held:
                    self._start_turn(item)
            return
        self._start_turn(message)

    def _on_turn_interrupt(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        thread = self._thread(message, params)
        if thread is None:
            return
        turn = self._turn(thread, str(params.get("turnId")))
        if turn is None:
            self._error(message, _INVALID_REQUEST, "unknown turn")
            return
        turn.status = "interrupted"
        self.keep_running.discard(thread.id)
        self._reply(message, "turn/interrupt", {})
        self.notify("turn/completed", {"threadId": thread.id, "turn": self._turn_object(turn, full=False)})

    def _on_thread_read(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        thread = self._thread(message, params)
        if thread is None:
            return
        self._reply(message, "thread/read", {"thread": self._thread_object(thread)})

    def _on_thread_turns_list(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        thread = self._thread(message, params)
        if thread is None:
            return
        turns = list(thread.turns)
        if params.get("sortDirection", "desc") != "asc":
            turns.reverse()
        full = params.get("itemsView") == "full"
        page, next_cursor = _page(turns, params)
        self._reply(
            message,
            "thread/turns/list",
            {
                "data": [self._turn_object(turn, full=full) for turn in page],
                "nextCursor": next_cursor,
                "backwardsCursor": None,
            },
        )

    def _on_thread_items_list(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        thread = self._thread(message, params)
        if thread is None:
            return
        wanted = params.get("turnId")
        entries: list[dict[str, Any]] = []
        for turn in thread.turns:
            if wanted is not None and turn.id != wanted:
                continue
            for item in turn.persisted:
                entries.append({"item": item, "turnId": turn.id, "startedAtMs": 0, "completedAtMs": 0})
        page, next_cursor = _page(entries, params)
        self._reply(message, "thread/items/list", {"data": page, "nextCursor": next_cursor, "backwardsCursor": None})

    def _on_thread_compact_start(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        thread = self._thread(message, params)
        if thread is None:
            return
        self._reply(message, "thread/compact/start", {})
        turn = self._new_turn(thread)
        self.notify("turn/started", {"threadId": thread.id, "turn": self._turn_object(turn, full=False)})
        self.emit_model_request(thread.id, turn.id, "compaction")
        self._complete_compaction(thread, turn)

    def _on_thread_unsubscribe(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        thread = self._thread(message, params)
        if thread is None:
            return
        self._reply(message, "thread/unsubscribe", {"status": "unsubscribed"})
        if not self.keep_loaded_after_unsubscribe:
            thread.loaded = False
            self.notify("thread/closed", {"threadId": thread.id})

    def _on_thread_loaded_list(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        loaded = [thread.id for thread in self.threads.values() if thread.loaded]
        self._reply(message, "thread/loaded/list", {"data": loaded, "nextCursor": None})

    def _on_thread_delete(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        thread = self._thread(message, params)
        if thread is None:
            return
        del self.threads[thread.id]
        self._reply(message, "thread/delete", {})

    # Turn simulation ---------------------------------------------------------------------
    def _start_turn(self, message: dict[str, Any]) -> None:
        params = cast(dict[str, Any], message["params"])
        thread = self.threads[str(params["threadId"])]
        active = next((turn for turn in thread.turns if turn.status == "inProgress"), None)
        if self.steer_next_turn and active is not None:
            self.steer_next_turn = False
            self._record_user_message(thread, params, active)
            self._reply(message, "turn/start", {"turn": self._turn_object(active, full=False)})
            return
        turn = self._new_turn(thread)
        # The build may begin sampling before the client has read the turn/start response.
        if thread.id in self.auto_compact_before_sampling:
            self.auto_compact_before_sampling.discard(thread.id)
            self.emit_model_request(thread.id, turn.id, "compaction")
            compaction = {"type": "contextCompaction", "id": f"{turn.id}-compaction"}
            turn.items.append(compaction)
            turn.persisted.append(compaction)
        self.emit_model_request(thread.id, turn.id, "turn")
        self._record_user_message(thread, params, turn)
        self._reply(message, "turn/start", {"turn": self._turn_object(turn, full=False)})
        self.notify("turn/started", {"threadId": thread.id, "turn": self._turn_object(turn, full=False)})
        text = _input_text(params)
        if self.emit_reasoning:
            empty: list[object] = []
            reasoning: dict[str, Any] = {"type": "reasoning", "id": f"{turn.id}-reasoning", "summary": empty}
            turn.items.append(reasoning)
            turn.persisted.append(reasoning)
            self.notify(
                "item/completed",
                {"threadId": thread.id, "turnId": turn.id, "completedAtMs": 0, "item": reasoning},
            )
        reply_item = {"type": "agentMessage", "id": f"{turn.id}-reply", "text": f"reply to {text}"}
        self.notify(
            "item/agentMessage/delta",
            {"threadId": thread.id, "turnId": turn.id, "itemId": reply_item["id"], "delta": reply_item["text"]},
        )
        turn.items.append(reply_item)
        turn.persisted.append(reply_item)
        if thread.id in self.keep_running:
            return
        turn.status = "completed"
        self.notify("turn/completed", {"threadId": thread.id, "turn": self._turn_object(turn, full=False)})

    def _complete_compaction(self, thread: _Thread, turn: _Turn) -> None:
        item = {"type": "contextCompaction", "id": f"{turn.id}-compaction"}
        turn.items.append(item)
        turn.persisted.append(item)
        self.notify("item/completed", {"threadId": thread.id, "turnId": turn.id, "completedAtMs": 0, "item": item})
        turn.status = "completed"
        self.notify("turn/completed", {"threadId": thread.id, "turn": self._turn_object(turn, full=False)})

    def _new_turn(self, thread: _Thread) -> _Turn:
        turn = _Turn(id=f"{thread.id}-turn-{len(thread.turns) + 1}")
        thread.turns.append(turn)
        return turn

    def _record_user_message(self, thread: _Thread, params: Mapping[str, Any], turn: _Turn) -> None:
        item: dict[str, Any] = {
            "type": "userMessage",
            "id": f"{turn.id}-user-{len(turn.items) + 1}",
            "content": [{"type": "text", "text": _input_text(params), "text_elements": []}],
        }
        client_id = params.get("clientUserMessageId")
        if isinstance(client_id, str):
            item["clientId"] = client_id
        turn.items.append(item)
        if self.persist_user_messages:
            turn.persisted.append(item)

    # Objects ----------------------------------------------------------------------------
    def _thread_envelope(self, thread: _Thread) -> dict[str, Any]:
        return {
            "thread": self._thread_object(thread),
            "model": thread.model,
            "modelProvider": thread.provider,
            "approvalPolicy": "never",
            "approvalsReviewer": "user",
            "cwd": "/srv/esp/codex-work",
            "sandbox": {"type": "readOnly", "networkAccess": False},
        }

    def _thread_object(self, thread: _Thread) -> dict[str, Any]:
        active = any(turn.status == "inProgress" for turn in thread.turns)
        if not thread.loaded:
            status: dict[str, Any] = {"type": "notLoaded"}
        elif active:
            status = {"type": "active", "activeFlags": []}
        else:
            status = {"type": "idle"}
        value: dict[str, Any] = {
            "id": thread.id,
            "sessionId": thread.id,
            "cliVersion": "0.159.3",
            "createdAt": 0,
            "updatedAt": 0,
            "cwd": "/srv/esp/codex-work",
            "ephemeral": False,
            "model": thread.model,
            "modelProvider": thread.provider,
            "preview": "",
            "projectId": None,
            "source": "appServer",
            "status": status,
            "turns": [],
        }
        self.violations.extend(shape_violations("Thread", value, self.capture["definitions"]["Thread"]))
        return value

    def _turn_object(self, turn: _Turn, *, full: bool) -> dict[str, Any]:
        items = list(turn.persisted) if full else []
        variants = cast(dict[str, Any], self.capture["definitions"]["ThreadItem"])["variants"]
        for item in items:
            shape = variants.get(item["type"])
            if shape is None:
                self.violations.append(f"ThreadItem type {item['type']!r} is not captured")
            else:
                self.violations.extend(shape_violations(f"ThreadItem {item['type']}", item, shape))
        value = {"id": turn.id, "items": items, "status": turn.status, "itemsView": "full" if full else "notLoaded"}
        self.violations.extend(shape_violations("Turn", value, self.capture["definitions"]["Turn"]))
        return value

    def _thread(self, message: dict[str, Any], params: Mapping[str, Any]) -> _Thread | None:
        thread = self.threads.get(str(params.get("threadId")))
        if thread is None:
            self._error(message, _INVALID_REQUEST, "thread not found")
        return thread

    def _turn(self, thread: _Thread, turn_id: str) -> _Turn | None:
        return next((turn for turn in thread.turns if turn.id == turn_id), None)

    def _reply(self, message: dict[str, Any], method: str, result: dict[str, Any]) -> None:
        shapes = cast(dict[str, Any], self.capture["shapes"])
        if method in shapes:
            self.violations.extend(shape_violations(f"{method} result", result, shapes[method]["result"]))
        self._enqueue({"id": message["id"], "result": result})

    def _error(self, message: dict[str, Any], code: int, text: str) -> None:
        self._enqueue({"id": message["id"], "error": {"code": code, "message": text}})

    def _enqueue(self, body: dict[str, Any]) -> None:
        self._inbox.put_nowait(json.dumps(body).encode())
        self._enqueued += 1


def _input_text(params: Mapping[str, Any]) -> str:
    parts: list[str] = []
    for entry in cast(list[object], params.get("input", [])):
        if isinstance(entry, dict):
            text = cast(dict[str, Any], entry).get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts)


def _page(values: list[Any], params: Mapping[str, Any]) -> tuple[list[Any], str | None]:
    start = int(params["cursor"]) if isinstance(params.get("cursor"), str) else 0
    limit_value = params.get("limit")
    limit = limit_value if isinstance(limit_value, int) and limit_value > 0 else len(values) or 1
    page = values[start : start + limit]
    end = start + limit
    return page, (str(end) if end < len(values) else None)


class CodexLab:
    """One captured app-server peer hosting threads A and B (and optionally C) in one process."""

    def __init__(self) -> None:
        self.capture = load_capture()
        self.peer = CapturedCodexPeer(self.capture)
        self.rpc = NativeRpcClient(self.peer)
        adapter = create_codex_adapter(self.rpc, lab_profile())
        if not isinstance(adapter, CodexHarnessAdapter):
            raise AssertionError("create_codex_adapter must return the Codex adapter")
        self.adapter: CodexHarnessAdapter = adapter
        self.adapter.acceptance_confirm_attempts = 2
        self.adapter.acceptance_confirm_interval = 0.0
        self.adapter.unload_confirm_timeout = 0.05
        self.peer.relay = self.relay
        self.relay_records: list[RelayRecord] = []
        self.authority_a = OperationAuthority(inference_token="inf-A", knowledge_token="know-A")
        self.authority_b = OperationAuthority(inference_token="inf-B", knowledge_token="know-B")
        self._tokens: dict[str, str] = {}
        self.handle_a: SessionHandle
        self.handle_b: SessionHandle
        self.result_b: SubmissionResult | None = None
        self.message_a = SubmitMessage(conversation_id=CONV_A, client_request_id="req-canary-a", message=CANARY_A)
        self.message_b = SubmitMessage(conversation_id=CONV_B, client_request_id="req-canary-b", message=CANARY_B)

    @classmethod
    async def start(cls) -> CodexLab:
        lab = cls()
        await asyncio.wait_for(lab.adapter.initialize(), timeout=RPC_TIMEOUT)
        lab.handle_a = await asyncio.wait_for(lab.adapter.create_session(reservation(CONV_A, PROV_A)), RPC_TIMEOUT)
        lab.handle_b = await asyncio.wait_for(lab.adapter.create_session(reservation(CONV_B, PROV_B)), RPC_TIMEOUT)
        return lab

    async def aclose(self) -> None:
        return None

    # Relay: what the supervisor-local attribution relay does for each model request. ------
    def relay(self, body: bytes, kind: RelayKind, emitting_thread: str, turn_id: str) -> None:
        try:
            scope = self.adapter.attribute_model_request(body)
        except UnattributedCall as exc:
            reason = str(exc.args[0]) if exc.args else "unattributed"
            self.relay_records.append(
                RelayRecord(kind, emitting_thread, turn_id, forwarded=False, refused_reason=reason)
            )
            return
        self.relay_records.append(
            RelayRecord(
                kind,
                emitting_thread,
                turn_id,
                forwarded=True,
                token=scope.token,
                attributed_thread=scope.native_session_id,
            )
        )

    def expected_token(self, thread_id: str) -> str | None:
        return self._tokens.get(thread_id)

    def forwarded(self, kind: RelayKind) -> list[RelayRecord]:
        return [record for record in self.relay_records if record.kind == kind and record.forwarded]

    # Plan scenario helpers ------------------------------------------------------------------
    async def submit(
        self, handle: SessionHandle, message: SubmitMessage, authority: OperationAuthority
    ) -> SubmissionResult:
        self._tokens[handle.native_session_id] = authority.inference_token
        result = await asyncio.wait_for(self.adapter.submit(handle, message, authority), RPC_TIMEOUT)
        await self.peer.wait_idle()
        return result

    async def submit_a(self) -> SubmissionResult:
        """Interleave A and B on one process; replies come back in reverse order and B keeps running."""
        self.peer.hold_turn_acks = 2
        self.peer.keep_running.add(self.handle_b.native_session_id)
        self._tokens[self.handle_a.native_session_id] = self.authority_a.inference_token
        self._tokens[self.handle_b.native_session_id] = self.authority_b.inference_token
        result_a, result_b = await asyncio.wait_for(
            asyncio.gather(
                self.adapter.submit(self.handle_a, self.message_a, self.authority_a),
                self.adapter.submit(self.handle_b, self.message_b, self.authority_b),
            ),
            timeout=RPC_TIMEOUT,
        )
        self.result_b = result_b
        await self.peer.wait_idle()
        return result_a

    @property
    def submitted_native_id(self) -> str | None:
        for params in self.peer.requests_for("turn/start"):
            if params.get("clientUserMessageId") == self.message_a.client_request_id:
                thread_id = params.get("threadId")
                return thread_id if isinstance(thread_id, str) else None
        return None

    async def history_text(self, handle: SessionHandle) -> list[str]:
        snapshot = await asyncio.wait_for(self.adapter.read_history(handle), RPC_TIMEOUT)
        return [item.text for item in snapshot.items]

    async def peer_canary_in_history_a(self) -> bool:
        texts = await self.history_text(self.handle_a)
        if not any(CANARY_A in text for text in texts):
            raise AssertionError(f"thread A history does not contain its own canary: {texts!r}")
        return any(CANARY_B in text for text in texts)

    async def compaction_requests_without_scope(self) -> int:
        """Run manual and automatic compaction on A; count compaction requests lacking A's scope."""
        await asyncio.wait_for(self.adapter.compact(self.handle_a, self.authority_a), RPC_TIMEOUT)
        await self.peer.wait_idle()
        self.peer.auto_compact_before_sampling.add(self.handle_a.native_session_id)
        follow_up = SubmitMessage(conversation_id=CONV_A, client_request_id="req-a-2", message="second question")
        await self.submit(self.handle_a, follow_up, self.authority_a)
        missing = 0
        for record in self.relay_records:
            if record.kind != "compaction":
                continue
            expected = self.expected_token(record.emitting_thread)
            correct = (
                record.forwarded
                and record.token is not None
                and record.token == expected
                and record.attributed_thread == record.emitting_thread
            )
            if not correct:
                missing += 1
        return missing

    @property
    def compaction_requests_forwarded(self) -> int:
        return len(self.forwarded("compaction"))

    async def create_unbound_c(self) -> SessionHandle:
        return await asyncio.wait_for(self.adapter.create_session(reservation(CONV_C, PROV_C)), RPC_TIMEOUT)


def reservation(conversation_id: str, provider_session_id: str, *, model: str = LAB_MODEL) -> SessionReservation:
    return SessionReservation(
        conversation_id=conversation_id,
        provider_session_id=provider_session_id,
        session_generation=1,
        native_session_id=None,
        harness_instance_id=HARNESS_INSTANCE_ID,
        runtime_incarnation_id=INC,
        native_storage_unit_id="codex-unit-1",
        state_location="volume://codex-unit-1",
        ownership_epoch=EPOCH,
        provider="openai",
        model=model,
        brain_release_id="fixture-brain-a",
        brain_hash="a" * 64,
        behavior_version="fixture-behavior-a",
        behavior_hash="b" * 64,
        corpus_release_id="fixture-corpus-a",
        deployment_ref="deployment-fixture",
    )
