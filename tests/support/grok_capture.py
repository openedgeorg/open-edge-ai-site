"""Captured Grok Build ACP peer for contract tests. No network, no real model, no grok process.

Methods the adapter may call and the reply shapes this peer builds are checked against the frozen
capture of the exact installed build (`protocol-capabilities.json`): the ACP protocol version and
session capabilities that build declared at `initialize`, and the ACP v1 shapes recorded there.
Model and MCP requests are emitted with the per-request headers the build's own binary names
(`x-grok-session-id`; the documented `x-mcp-session-id: {{session_id}}` template) and passed
through the adapter's attribution hooks the way the supervisor-local relays would.
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
from esp_provider_shared.rpc import NativeRpcClient
from esp_provider_shared.transport_context import UnattributedCall
from esp_provider_xai.grok_build_adapter import (
    GROK_BUILD,
    GROK_COMPACT_COMMAND,
    GROK_MCP_SESSION_HEADER,
    GROK_MODEL_CATALOG_KEY,
    GROK_SESSION_HEADER,
    AcpClientGuard,
    GrokBuildHarnessAdapter,
    create_grok_adapter,
)
from tests.support.contracts import EPOCH

ROOT = Path(__file__).resolve().parents[2]
CAPTURE_PATH = ROOT / "providers" / "xai" / "integration" / "protocol-capabilities.json"
CONFIG_PATH = ROOT / "infra" / "runtime" / "grok" / "config.toml"
CANDIDATE_PATH = ROOT / "docs" / "qualification" / "xai" / "candidate.json"
RPC_TIMEOUT = 2.0
LAB_MODEL = "grok-lab-model"
AUXILIARY_MODEL = "esp-auxiliary-disabled"
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
_INVALID_PARAMS = -32602
_METHOD_NOT_FOUND = -32601
# Host-identifying initialize fields the real build sends. The adapter must never return them.
LAB_HOST_META: dict[str, object] = {
    "hostname": "lab-host-name",
    "currentWorkingDirectory": "/isolated/lab-home",
    "agentId": "00000000-0000-5000-8000-00000000a9e7",
    "agentInstanceId": "00000000-0000-4000-8000-000000001257",
}

RelayKind = Literal["turn", "compaction", "auxiliary"]


def load_capture() -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(CAPTURE_PATH.read_text(encoding="utf-8")))


def write_grok_observation(path: Path, **overrides: object) -> Path:
    """A recorded discovery observation of the frozen build, so CLI tests never execute the installed binary."""
    capture = load_capture()
    static = cast(dict[str, Any], capture["static"])
    native = cast(dict[str, Any], static["native_binary"])
    values: dict[str, object] = {
        "binary_found": True,
        "version": static["version"],
        "binary_sha256": native["sha256"],
        "native_label": native["label"],
        "static_capture": static,
        "network_isolated": True,
        "acp_initialize": None,
        "errors": [],
    }
    values.update(overrides)
    path.write_text(json.dumps(values), encoding="utf-8")
    return path


def lab_profile(**overrides: object) -> RuntimeProfile:
    """Synthetic test profile. It names the frozen build but is not a qualified deployment."""
    base: dict[str, object] = {
        "provider": "xai",
        "model": LAB_MODEL,
        "harness_build": GROK_BUILD,
        "image_digest": "synthetic:grok-lab-image",
        "configuration_digest": "synthetic:grok-lab-config",
        "transport_digest": "synthetic:grok-lab-transport",
        "storage_profile": "synthetic:memory",
        "tool_policy_digest": "synthetic:grok-lab-tools",
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
    emitting_session: str
    forwarded: bool
    token: str | None = None
    attributed_session: str | None = None
    attributed_work: str | None = None
    refused_reason: str | None = None


@dataclass
class _Session:
    id: str
    model_option: str
    loaded: bool = True
    # The build's persisted update stream for this session (its `updates.jsonl`).
    persisted: list[dict[str, Any]] = field(default_factory=lambda: [])
    held: dict[str, Any] | None = None
    turns: int = 0


class CapturedGrokPeer:
    """FrameTransport plus fake `grok agent stdio`. Options are plain attributes so a test states the
    build behaviour it simulates."""

    def __init__(self, capture: Mapping[str, Any]) -> None:
        self.capture = capture
        acp = cast(dict[str, Any], capture["acp_v1"])
        self.client_requests = frozenset(cast(list[str], acp["client_requests"]))
        self.client_notifications = frozenset(cast(list[str], acp["client_notifications"]))
        self.mapped = frozenset(cast(dict[str, str], capture["esp_operation_mapping"]).values())
        self.shapes = cast(dict[str, Any], acp["shapes"])
        self.violations: list[str] = []
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.sessions: dict[str, _Session] = {}
        self.relay: Callable[[Mapping[str, str], bytes, RelayKind, str], None] | None = None
        self.mcp_relay: Callable[[Mapping[str, str], str], None] | None = None
        self.request_model = LAB_MODEL
        self.model_option_override: str | None = None
        self.omit_model_option = False
        self.persist_user_messages = True
        self.omit_persisted_message_id = False
        self.keep_running: set[str] = set()
        self.reject_next_prompt = False
        self.reject_code = _INVALID_PARAMS
        self.record_input_before_rejection = False
        self.lose_next_prompt_response = False
        self.fail_next_send = False
        # A raw stdout line (malformed or non-object) delivered before the next prompt response.
        self.raw_line_before_next_prompt_response: bytes | None = None
        self.auto_compact_before_sampling: set[str] = set()
        self.updates_during_next_prompt: list[dict[str, Any]] = []
        self.agent_requests_during_next_prompt: list[tuple[str, dict[str, Any]]] = []
        self.mcp_calls_during_next_prompt: list[str] = []
        self.declared_session_capabilities: dict[str, object] | None = None
        self.declared_load_session = True
        self.agent_request_responses: list[dict[str, Any]] = []
        # Live updates of a running turn that the build emits while a `session/load` of that session is
        # outstanding (between the replay and the load answer), as (update, persisted). Updates that never
        # met a load are delivered as ordinary live updates by `flush_live_updates`.
        self.live_updates_during_load: dict[str, list[tuple[dict[str, Any], bool]]] = {}
        # Hold `session/load` answers (replay plus result) until `release_loads`.
        self.hold_loads = False
        # Hold `session/close` and `session/resume` answers until `release_closes` and `release_resumes`. The
        # build applies a held request (unloads or loads the session) when it answers it.
        self.hold_closes = False
        self.hold_resumes = False
        # What the `compact` command streams and whether the build persists the command like a user message.
        self.compaction_output: str | None = None
        self.persist_compaction_command = False
        self._held: dict[str, list[dict[str, Any]]] = {}
        self._inbox: asyncio.Queue[bytes] = asyncio.Queue()
        self._enqueued = 0
        self._dequeued = 0
        self._waiters = 0
        self._dropped = False
        self._ordinal = 0
        self._agent_request_ordinal = 0

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

    async def wait_for_requests(self, method: str, count: int) -> None:
        """Wait until the adapter has sent at least `count` requests of `method`."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + RPC_TIMEOUT
        while len(self.requests_for(method)) < count:
            if loop.time() > deadline:
                raise AssertionError(f"adapter sent {len(self.requests_for(method))} {method} requests, not {count}")
            await asyncio.sleep(0.005)

    def emit_model_request(
        self,
        session_id: str,
        kind: RelayKind,
        *,
        model: str | None = None,
        session_header: bool = True,
        body: bytes | None = None,
    ) -> None:
        headers: dict[str, str] = {"content-type": "application/json"}
        if session_header:
            headers[GROK_SESSION_HEADER] = session_id
            headers["x-grok-turn-idx"] = str(self.sessions[session_id].turns if session_id in self.sessions else 0)
        if body is None:
            document = {
                "model": self.request_model if model is None else model,
                "messages": [
                    {"role": "system", "content": "grok build base prompt"},
                    {"role": "user", "content": "lab"},
                ],
                "stream": True,
            }
            body = json.dumps(document).encode()
        if self.relay is None:
            raise AssertionError("no relay attached to the captured peer")
        self.relay(headers, body, kind, session_id)

    def emit_mcp_call(self, session_id: str, tool: str, *, session_header: bool = True) -> None:
        headers = {GROK_MCP_SESSION_HEADER: session_id} if session_header else {}
        if self.mcp_relay is None:
            raise AssertionError("no MCP relay attached to the captured peer")
        self.mcp_relay(headers, tool)

    def start_background_turn(self, session_id: str) -> None:
        """Native work no client prompt started (an auto-wake style turn), announced like any update."""
        session = self.sessions[session_id]
        session.turns += 1
        self.emit_model_request(session_id, "auxiliary")
        self.update(session_id, _agent_chunk(f"{session_id}-background-{session.turns}", "background output"))

    def update(self, session_id: str, update: dict[str, Any], *, persist: bool = True) -> None:
        if persist and session_id in self.sessions:
            self.sessions[session_id].persisted.append(update)
        self.notify("session/update", {"sessionId": session_id, "update": update})

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self._enqueue({"jsonrpc": "2.0", "method": method, "params": params})

    def flush_live_updates(self, session_id: str) -> None:
        """Deliver the configured live updates that no outstanding `session/load` overlapped."""
        for update, persist in self.live_updates_during_load.pop(session_id, []):
            self.update(session_id, update, persist=persist)

    def release_loads(self) -> None:
        """Answer every held `session/load`: replay first, then the result, as the build does."""
        for message in self._held.pop("session/load", []):
            self._answer_load(message, cast(dict[str, Any], message.get("params", {})))

    def release_closes(self) -> None:
        """Answer every held `session/close`; the session is unloaded as the build answers."""
        for message in self._held.pop("session/close", []):
            self._answer_close(message, cast(dict[str, Any], message.get("params", {})))

    def release_resumes(self) -> None:
        """Answer every held `session/resume`; the session is loaded as the build answers."""
        for message in self._held.pop("session/resume", []):
            self._answer_resume(message, cast(dict[str, Any], message.get("params", {})))

    def release(self, session_id: str, stop_reason: str = "end_turn") -> None:
        """Finish a held prompt turn the way the build ends any prompt turn."""
        session = self.sessions[session_id]
        held = session.held
        if held is None:
            raise AssertionError(f"session {session_id} has no running prompt")
        session.held = None
        self.keep_running.discard(session_id)
        self._prompt_result(held, stop_reason)

    # Dispatch ---------------------------------------------------------------------------
    def _dispatch(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        if method is None and "id" in message and ("result" in message or "error" in message):
            # The client's answer to a request this agent sent.
            self.agent_request_responses.append(message)
            return
        if not isinstance(method, str):
            raise AssertionError(f"frame without method: {message!r}")
        params_value = message.get("params", {})
        params = cast(dict[str, Any], params_value) if isinstance(params_value, dict) else {}
        self.requests.append((method, params))
        if "id" not in message:
            if method not in self.client_notifications:
                self.violations.append(f"client notification {method!r} is not declared by the captured build")
            self._check_shape(f"{method} params", params, method, "params")
            if method == "session/cancel":
                self._on_cancel(params)
            return
        if method not in self.client_requests:
            self.violations.append(f"method {method!r} is not declared by the captured build")
            self._error(message, _METHOD_NOT_FOUND, "Method not found")
            return
        if method not in self.mapped:
            self.violations.append(f"method {method!r} is outside the frozen operation mapping")
        self._check_shape(f"{method} params", params, method, "params")
        handler = getattr(self, "_on_" + method.replace("/", "_"), None)
        if handler is None:
            self._error(message, _METHOD_NOT_FOUND, "Method not found")
            return
        cast(Callable[[dict[str, Any], dict[str, Any]], None], handler)(message, params)

    def _on_initialize(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        initialize = cast(dict[str, Any], self.capture["acp_initialize"])
        capabilities = json.loads(json.dumps(initialize["agentCapabilities"]))
        if self.declared_session_capabilities is not None:
            capabilities["sessionCapabilities"] = self.declared_session_capabilities
        capabilities["loadSession"] = self.declared_load_session
        meta: dict[str, object] = dict(cast(dict[str, object], initialize["meta"]))
        meta.update(LAB_HOST_META)
        result = {
            "protocolVersion": initialize["protocolVersion"],
            "agentCapabilities": capabilities,
            "authMethods": [{"id": method, "name": method} for method in initialize["authMethodIds"]],
            "_meta": meta,
        }
        self._reply(message, "initialize", result)
        for method in cast(list[str], initialize["notifications"]):
            self.notify(method, {"mcpServers": []})

    def _on_session_new(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        self._ordinal += 1
        session_id = f"019a0000-0000-7000-8000-{self._ordinal:012d}"
        session = _Session(id=session_id, model_option=self.model_option_override or GROK_MODEL_CATALOG_KEY)
        self.sessions[session_id] = session
        self._reply(message, "session/new", {"sessionId": session_id, **self._session_options(session)})

    def _on_session_load(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        if self._hold("session/load", message, self.hold_loads):
            return
        self._answer_load(message, params)

    def _answer_load(self, message: dict[str, Any], params: Mapping[str, Any]) -> None:
        session = self._session(message, params)
        if session is None:
            return
        session.loaded = True
        # ACP replays the whole persisted conversation before answering session/load.
        for update in list(session.persisted):
            self.notify("session/update", {"sessionId": session.id, "update": update})
        # A running turn keeps streaming while the load is outstanding; on the wire these updates look
        # exactly like the replay.
        for update, persist in self.live_updates_during_load.pop(session.id, []):
            self.update(session.id, update, persist=persist)
        self._reply(message, "session/load", self._session_options(session))

    def _on_session_resume(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        if self._hold("session/resume", message, self.hold_resumes):
            return
        self._answer_resume(message, params)

    def _answer_resume(self, message: dict[str, Any], params: Mapping[str, Any]) -> None:
        session = self._session(message, params)
        if session is None:
            return
        session.loaded = True
        session.model_option = self.model_option_override or session.model_option
        self._reply(message, "session/resume", self._session_options(session))

    def _on_session_close(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        if self._hold("session/close", message, self.hold_closes):
            return
        self._answer_close(message, params)

    def _answer_close(self, message: dict[str, Any], params: Mapping[str, Any]) -> None:
        session = self._session(message, params)
        if session is None:
            return
        session.loaded = False
        self._reply(message, "session/close", {})

    def _on_session_prompt(self, message: dict[str, Any], params: dict[str, Any]) -> None:
        session = self._session(message, params)
        if session is None:
            return
        if not session.loaded:
            self.violations.append(f"session/prompt on session {session.id} that is not loaded in this process")
            self._error(message, _INVALID_PARAMS, "session not loaded")
            return
        for block in cast(list[object], params.get("prompt", [])):
            self.violations.extend(shape_violations("session/prompt text block", block, self.shapes["TextContent"]))
        text = _prompt_text(params)
        message_id = params.get("messageId")
        user_update: dict[str, Any] = {
            "sessionUpdate": "user_message_chunk",
            "content": {"type": "text", "text": text},
        }
        if isinstance(message_id, str) and not self.omit_persisted_message_id:
            user_update["messageId"] = message_id
        if self.reject_next_prompt:
            self.reject_next_prompt = False
            if self.record_input_before_rejection:
                session.persisted.append(user_update)
            self._error(message, self.reject_code, "prompt rejected")
            return
        if self.lose_next_prompt_response:
            self.lose_next_prompt_response = False
            session.persisted.append(user_update)
            self._dropped = True
            self._inbox.put_nowait(b"")
            self._enqueued += 1
            return
        session.turns += 1
        if text.strip() == GROK_COMPACT_COMMAND:
            # The declared `compact` command: compaction sampling through the same model endpoint.
            if self.persist_compaction_command:
                session.persisted.append(user_update)
            self.emit_model_request(session.id, "compaction")
            self.emit_model_request(session.id, "compaction")
            if self.compaction_output is not None:
                self.update(session.id, _agent_chunk(f"{session.id}-compact-{session.turns}", self.compaction_output))
            self._prompt_result(message, "end_turn")
            return
        if self.persist_user_messages:
            session.persisted.append(user_update)
        if session.id in self.auto_compact_before_sampling:
            self.auto_compact_before_sampling.discard(session.id)
            self.emit_model_request(session.id, "compaction")
        self.emit_model_request(session.id, "turn")
        for tool in self.mcp_calls_during_next_prompt:
            self.emit_mcp_call(session.id, tool)
        self.mcp_calls_during_next_prompt = []
        for agent_method, agent_params in self.agent_requests_during_next_prompt:
            self._agent_request_ordinal += 1
            self._enqueue(
                {
                    "jsonrpc": "2.0",
                    "id": f"agent-{self._agent_request_ordinal}",
                    "method": agent_method,
                    "params": {"sessionId": session.id, **agent_params},
                }
            )
        self.agent_requests_during_next_prompt = []
        self.update(session.id, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "hidden"}})
        for extra in self.updates_during_next_prompt:
            self.update(session.id, extra)
        self.updates_during_next_prompt = []
        self.update(session.id, _agent_chunk(f"{session.id}-agent-{session.turns}", f"reply to {text}"))
        if self.raw_line_before_next_prompt_response is not None:
            raw, self.raw_line_before_next_prompt_response = self.raw_line_before_next_prompt_response, None
            self._inbox.put_nowait(raw)
            self._enqueued += 1
        if session.id in self.keep_running:
            session.held = message
            return
        self._prompt_result(message, "end_turn")

    def _on_cancel(self, params: Mapping[str, Any]) -> None:
        session = self.sessions.get(str(params.get("sessionId")))
        if session is None or session.held is None:
            return
        held, session.held = session.held, None
        self.keep_running.discard(session.id)
        self._prompt_result(held, "cancelled")

    def _hold(self, method: str, message: dict[str, Any], hold: bool) -> bool:
        """Defer the answer to this request until the matching `release_*` call."""
        if hold:
            self._held.setdefault(method, []).append(message)
        return hold

    # Objects ----------------------------------------------------------------------------
    def _prompt_result(self, message: dict[str, Any], stop_reason: str) -> None:
        params = cast(dict[str, Any], message["params"])
        result: dict[str, Any] = {
            "stopReason": stop_reason,
            "usage": {"inputTokens": 12, "outputTokens": 5, "totalTokens": 17, "cachedReadTokens": 2},
        }
        message_id = params.get("messageId")
        if isinstance(message_id, str):
            result["userMessageId"] = message_id
        self._reply(message, "session/prompt", result)

    def _session_options(self, session: _Session) -> dict[str, Any]:
        if self.omit_model_option:
            return {"configOptions": []}
        option = {
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": session.model_option,
            "options": [{"value": session.model_option, "name": session.model_option}],
        }
        return {"configOptions": [option]}

    def _session(self, message: dict[str, Any], params: Mapping[str, Any]) -> _Session | None:
        session = self.sessions.get(str(params.get("sessionId")))
        if session is None:
            self._error(message, _INVALID_PARAMS, "session not found")
        return session

    def _check_shape(self, label: str, value: object, method: str, part: str) -> None:
        shape = self.shapes.get(method)
        if isinstance(shape, dict) and part in shape:
            self.violations.extend(shape_violations(label, value, cast(dict[str, Any], shape)[part]))

    def _reply(self, message: dict[str, Any], method: str, result: dict[str, Any]) -> None:
        self._check_shape(f"{method} result", result, method, "result")
        self._enqueue({"jsonrpc": "2.0", "id": message["id"], "result": result})

    def _error(self, message: dict[str, Any], code: int, text: str) -> None:
        self._enqueue({"jsonrpc": "2.0", "id": message["id"], "error": {"code": code, "message": text}})

    def _enqueue(self, body: dict[str, Any]) -> None:
        self._inbox.put_nowait(json.dumps(body).encode())
        self._enqueued += 1


def _agent_chunk(message_id: str, text: str) -> dict[str, Any]:
    return {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}, "messageId": message_id}


def _prompt_text(params: Mapping[str, Any]) -> str:
    parts: list[str] = []
    for block in cast(list[object], params.get("prompt", [])):
        if isinstance(block, dict):
            text = cast(dict[str, Any], block).get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts)


class GrokLab:
    """One captured `grok agent stdio` peer hosting sessions A and B in one process."""

    def __init__(self) -> None:
        self.capture = load_capture()
        self.peer = CapturedGrokPeer(self.capture)
        self.guard = AcpClientGuard(self.peer)
        self.rpc = NativeRpcClient(self.guard)
        self.adapter: GrokBuildHarnessAdapter = create_grok_adapter(self.rpc, lab_profile())
        self.adapter.acceptance_wait = 0.04
        self.peer.relay = self.relay
        self.peer.mcp_relay = self.mcp_relay
        self.relay_records: list[RelayRecord] = []
        self.mcp_records: list[RelayRecord] = []
        self.authority_a = OperationAuthority(inference_token="inf-A", knowledge_token="know-A")
        self.authority_b = OperationAuthority(inference_token="inf-B", knowledge_token="know-B")
        self._tokens: dict[str, str] = {}
        self.handle_a: SessionHandle
        self.handle_b: SessionHandle
        self.result_b: SubmissionResult | None = None
        self.auxiliary_attempts = 0
        self.message_a = SubmitMessage(conversation_id=CONV_A, client_request_id="req-canary-a", message=CANARY_A)
        self.message_b = SubmitMessage(conversation_id=CONV_B, client_request_id="req-canary-b", message=CANARY_B)

    @classmethod
    async def start(cls) -> GrokLab:
        lab = cls()
        await asyncio.wait_for(lab.adapter.initialize(), timeout=RPC_TIMEOUT)
        lab.handle_a = await asyncio.wait_for(lab.adapter.create_session(reservation(CONV_A, PROV_A)), RPC_TIMEOUT)
        lab.handle_b = await asyncio.wait_for(lab.adapter.create_session(reservation(CONV_B, PROV_B)), RPC_TIMEOUT)
        await lab.peer.wait_idle()
        return lab

    async def aclose(self) -> None:
        return None

    # Relays: what the supervisor-local model and MCP relays do for each request. --------
    def relay(self, headers: Mapping[str, str], body: bytes, kind: RelayKind, emitting_session: str) -> None:
        try:
            scope = self.adapter.attribute_model_request(headers, body)
        except UnattributedCall as exc:
            reason = str(exc.args[0]) if exc.args else "unattributed"
            self.relay_records.append(RelayRecord(kind, emitting_session, forwarded=False, refused_reason=reason))
            return
        self.relay_records.append(
            RelayRecord(
                kind,
                emitting_session,
                forwarded=True,
                token=scope.token,
                attributed_session=scope.native_session_id,
                attributed_work=scope.native_work_ref,
            )
        )

    def mcp_relay(self, headers: Mapping[str, str], tool: str) -> None:
        emitting = headers.get(GROK_MCP_SESSION_HEADER, "")
        try:
            scope = self.adapter.attribute_mcp_request(headers)
        except UnattributedCall as exc:
            reason = str(exc.args[0]) if exc.args else "unattributed"
            self.mcp_records.append(RelayRecord("turn", emitting, forwarded=False, refused_reason=reason))
            return
        self.mcp_records.append(
            RelayRecord(
                "turn",
                emitting,
                forwarded=True,
                token=scope.token,
                attributed_session=scope.native_session_id,
                attributed_work=scope.native_work_ref,
            )
        )

    def expected_token(self, session_id: str) -> str | None:
        return self._tokens.get(session_id)

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
        """Interleave A and B on one process; B keeps running while A completes."""
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
    def prompt_session_id(self) -> str | None:
        for params in self.peer.requests_for("session/prompt"):
            if _prompt_text(params) == self.message_a.message:
                session_id = params.get("sessionId")
                return session_id if isinstance(session_id, str) else None
        return None

    @property
    def peer_canary(self) -> str:
        return CANARY_B

    async def history_text(self, handle: SessionHandle) -> list[str]:
        snapshot = await asyncio.wait_for(self.adapter.read_history(handle), RPC_TIMEOUT)
        await self.peer.wait_idle()
        return [item.text for item in snapshot.items]

    async def read_a_text(self) -> str:
        texts = await self.history_text(self.handle_a)
        if not any(CANARY_A in text for text in texts):
            raise AssertionError(f"session A history does not contain its own canary: {texts!r}")
        return "\n".join(texts)

    async def terminal_ack_without_durability(self) -> SubmissionResult:
        """A prompt turn that ends normally while the build's persisted history never shows its input."""
        handle_c = await self.create_c()
        self.peer.persist_user_messages = False
        try:
            message = SubmitMessage(conversation_id=CONV_C, client_request_id="req-c-1", message="question c")
            authority = OperationAuthority(inference_token="inf-C", knowledge_token="know-C")
            return await self.submit(handle_c, message, authority)
        finally:
            self.peer.persist_user_messages = True

    async def unbound_auxiliary_requests(self) -> int:
        """Auxiliary and background model work the build could start: none may be forwarded with a scope."""
        session_a = self.handle_a.native_session_id
        session_b = self.handle_b.native_session_id
        before = len(self.relay_records)
        # Title or summary generation on the auxiliary model slot, while B's run is in flight.
        self.peer.emit_model_request(session_b, "auxiliary", model=AUXILIARY_MODEL)
        # An auto-wake style turn on idle session A.
        self.peer.start_background_turn(session_a)
        # A request that carries no native session identity at all.
        self.peer.emit_model_request(session_a, "auxiliary", session_header=False)
        await self.peer.wait_idle()
        attempts = self.relay_records[before:]
        self.auxiliary_attempts = len(attempts)
        return sum(1 for record in attempts if record.forwarded)

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
            correct = (
                record.forwarded
                and record.token is not None
                and record.token == self.expected_token(record.emitting_session)
                and record.attributed_session == record.emitting_session
            )
            if not correct:
                missing += 1
        return missing

    @property
    def compaction_requests_forwarded(self) -> int:
        return len(self.forwarded("compaction"))

    async def create_c(self) -> SessionHandle:
        handle = await asyncio.wait_for(self.adapter.create_session(reservation(CONV_C, PROV_C)), RPC_TIMEOUT)
        await self.peer.wait_idle()
        return handle


def reservation(conversation_id: str, provider_session_id: str, *, model: str = LAB_MODEL) -> SessionReservation:
    return SessionReservation(
        conversation_id=conversation_id,
        provider_session_id=provider_session_id,
        session_generation=1,
        native_session_id=None,
        harness_instance_id=HARNESS_INSTANCE_ID,
        runtime_incarnation_id=INC,
        native_storage_unit_id="grok-unit-1",
        state_location="volume://grok-unit-1",
        ownership_epoch=EPOCH,
        provider="xai",
        model=model,
        brain_release_id="fixture-brain-a",
        brain_hash="a" * 64,
        behavior_version="fixture-behavior-a",
        behavior_hash="b" * 64,
        corpus_release_id="fixture-corpus-a",
        deployment_ref="deployment-fixture",
    )

