"""In-memory harness peer for the supervised native adapter. No network and no Kubernetes."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Literal

from esp_contracts.api import SubmitMessage
from esp_contracts.runtime import (
    Accepted,
    HistoryItem,
    NativeEvent,
    NativeHistorySnapshot,
    NativeStatus,
    OperationAuthority,
    SessionHandle,
    SessionReservation,
    SubmissionResult,
    WorkRef,
)
from esp_provider_shared.adapter import HarnessAdapter
from esp_provider_shared.rpc import NativeRpcClient
from esp_provider_shared.storage_fence import ContractStorageFence
from esp_provider_shared.supervisor import Supervisor, TrustAnchor
from esp_provider_shared.transport_context import TransportContext
from tests.support.contracts import EPOCH

RPC_TIMEOUT = 2.0
BACKEND_FINGERPRINT = "ab" * 32
OPERATOR_FINGERPRINT = "cd" * 32
HARNESS_INSTANCE_ID = "44444444-4444-4444-8444-444444444444"
CONV_A = "11111111-1111-4111-8111-111111111111"
CONV_B = "11111111-1111-4111-8111-111111111112"
PROV_A = "22222222-2222-4222-8222-222222222221"
PROV_B = "22222222-2222-4222-8222-222222222222"
INC_A = "55555555-5555-4555-8555-555555555551"
INC_B = "55555555-5555-4555-8555-555555555552"
RUN_A = "33333333-3333-4333-8333-333333333331"
RUN_B = "33333333-3333-4333-8333-333333333332"
BRAIN_HASH = "a" * 64
BEHAVIOR_HASH = "b" * 64
_METHOD_NOT_FOUND = -32601
_UNKNOWN_NATIVE = -32001


@dataclass
class CanaryView:
    text: str


_NativeStatusName = Literal["idle", "running", "completed", "interrupted", "failed", "unknown"]


@dataclass
class _NativeSession:
    status: _NativeStatusName = "idle"
    work_ref: str | None = None
    history_text: str | None = None


def _parse_payload(payload: bytes) -> dict[str, Any]:
    raw = payload
    if raw.startswith(b"Content-Length:"):
        header, separator, body = raw.partition(b"\r\n\r\n")
        if separator != b"\r\n\r\n":
            raise AssertionError("framed payload missing header terminator")
        length = int(header.split(b":", 1)[1].strip())
        raw = body[:length]
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"frame was not JSON: {payload[:120]!r}") from exc
    if not isinstance(loaded, dict):
        raise AssertionError("frame was not a JSON object")
    return loaded


class FakePeer:
    """Frame transport and native peer. `recv_frame` returns raw JSON, not a length header.

    Submit replies are held until both `session/submit` frames exist, then the second request id
    is answered first. `session/export` and `session/delete` are JSON-RPC -32601 with data.code
    unsupported. Any other unknown native id uses data.code unknown_native_id.
    """

    def __init__(self) -> None:
        self._inbox: asyncio.Queue[bytes] = asyncio.Queue()
        self._enqueued = 0
        self._dequeued = 0
        self._waiters = 0
        self._dropped = False
        self.hold_submits = False
        self.lose_next_submit = False
        self._buffered: list[dict[str, Any]] = []
        self.sessions: dict[str, _NativeSession] = {}
        self.submit_count = 0
        self.export_count = 0
        self.delete_count = 0
        self._ordinal = 0

    async def send_frame(self, payload: bytes) -> None:
        self._dispatch(_parse_payload(payload))

    async def recv_frame(self) -> bytes:
        if self._dropped and self._inbox.empty():
            raise ConnectionError("response lost")
        self._waiters += 1
        try:
            payload = await self._inbox.get()
        finally:
            self._waiters -= 1
        self._dequeued += 1
        if self._dropped or payload == b"":
            raise ConnectionError("response lost")
        return payload

    def notify(self, method: str, params: dict[str, Any]) -> None:
        """Queue one JSON-RPC notification. The method stays outside `params`."""
        self._enqueue({"jsonrpc": "2.0", "method": method, "params": params})

    def emit_attributed(self, native_ids: list[str]) -> None:
        for native_id in native_ids:
            self.notify("session/model_call", {"native_session_id": native_id})
            self.notify("session/tool_call", {"native_session_id": native_id})

    async def wait_idle(self) -> None:
        """Return once the adapter's reader has consumed every queued frame and is blocked again."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + RPC_TIMEOUT
        while loop.time() < deadline:
            if self._waiters > 0 and self._inbox.empty() and self._dequeued >= self._enqueued:
                return
            await asyncio.sleep(0.01)
        raise AssertionError(
            "adapter reader did not consume native frames "
            f"(enqueued={self._enqueued} dequeued={self._dequeued} waiters={self._waiters})"
        )

    def _dispatch(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        if not isinstance(method, str):
            raise AssertionError(f"request missing method: {message!r}")
        params = message.get("params")
        if not isinstance(params, dict):
            raise AssertionError(f"{method} params must be an object")
        if method == "session/create":
            self._create(message)
            return
        if method == "session/export":
            self.export_count += 1
            self._error(message, _METHOD_NOT_FOUND, "unsupported")
            return
        if method == "session/delete":
            self.delete_count += 1
            self._error(message, _METHOD_NOT_FOUND, "unsupported")
            return
        if method == "session/submit":
            self._submit(message)
            return
        session = self._session(message)
        if session is None:
            return
        if method == "session/inspect":
            self._reply(message["id"], _status_payload(session, params.get("request_id")))
            return
        if method == "session/history":
            self._reply(message["id"], _history_payload(session))
            return
        if method == "session/cancel":
            session.status = "interrupted"
            self._reply(message["id"], {"outcome": "requested"})
            return
        if method == "session/unload":
            self._reply(message["id"], {"outcome": "unloaded"})
            return
        self._error(message, _METHOD_NOT_FOUND, "fake_unexpected")

    def _create(self, message: dict[str, Any]) -> None:
        params = message["params"]
        if "conversation_id" not in params:
            raise AssertionError("session/create params must be the reservation JSON")
        self._ordinal += 1
        native_id = f"native-{chr(ord('a') + self._ordinal - 1)}"
        self.sessions[native_id] = _NativeSession()
        self._reply(message["id"], {"native_session_id": native_id})

    def _submit(self, message: dict[str, Any]) -> None:
        params = message["params"]
        self.submit_count += 1
        for key in ("native_session_id", "message", "client_request_id", "inference_token", "knowledge_token"):
            value = params.get(key)
            if not isinstance(value, str) or value == "":
                raise AssertionError(f"submit params missing {key}")
        if "signing_key" in params or "private_key" in params:
            raise AssertionError("submit must not carry a signing key")
        if self.lose_next_submit:
            self.lose_next_submit = False
            self._dropped = True
            self._inbox.put_nowait(b"")
            self._enqueued += 1
            return
        if self.hold_submits:
            self._buffered.append(message)
            if len(self._buffered) >= 2:
                self.hold_submits = False
                first, second = self._buffered[0], self._buffered[1]
                self._buffered.clear()
                self._accept(second)
                self._accept(first)
            return
        self._accept(message)

    def _accept(self, message: dict[str, Any]) -> None:
        params = message["params"]
        native_id = params["native_session_id"]
        session = self.sessions.get(native_id)
        if session is None:
            self._error(message, _UNKNOWN_NATIVE, "unknown_native_id")
            return
        work = f"work-{native_id}"
        text = params["message"]
        session.history_text = text
        session.work_ref = work
        session.status = "running"
        self._reply(
            message["id"],
            {
                "disposition": "accepted",
                "native_session_id": native_id,
                "native_work_ref": work,
                "text": text,
            },
        )

    def _session(self, message: dict[str, Any]) -> _NativeSession | None:
        native_id = message["params"].get("native_session_id")
        if not isinstance(native_id, str) or native_id not in self.sessions:
            self._error(message, _UNKNOWN_NATIVE, "unknown_native_id")
            return None
        return self.sessions[native_id]

    def _reply(self, request_id: object, result: dict[str, Any]) -> None:
        self._enqueue({"jsonrpc": "2.0", "id": request_id, "result": result})

    def _error(self, message: dict[str, Any], code: int, data_code: str) -> None:
        error_message = "Method not found" if code == _METHOD_NOT_FOUND else data_code
        self._enqueue(
            {
                "jsonrpc": "2.0",
                "id": message["id"],
                "error": {"code": code, "message": error_message, "data": {"code": data_code}},
            }
        )

    def _enqueue(self, body: dict[str, Any]) -> None:
        self._inbox.put_nowait(json.dumps(body).encode())
        self._enqueued += 1


def _status_payload(session: _NativeSession, request_id: object) -> dict[str, Any]:
    status = NativeStatus(
        status=session.status,
        native_work_ref=session.work_ref,
        request_id=request_id if isinstance(request_id, str) else None,
        saved_input_available=session.history_text is not None,
    )
    return status.model_dump(mode="json")


def _history_payload(session: _NativeSession) -> dict[str, Any]:
    items: list[HistoryItem] = []
    if session.history_text is not None:
        items.append(
            HistoryItem(
                native_item_id="item-1",
                native_work_ref=session.work_ref,
                role="user",
                text=session.history_text,
            )
        )
    snapshot = NativeHistorySnapshot(
        items=items,
        native_cursor=None,
        status=NativeStatus.model_validate(_status_payload(session, None)),
        provenance=[],
    )
    return snapshot.model_dump(mode="json")


class RuntimeLab:
    """One shared harness process with two native sessions.

    Model and tool notifications are queued only after `submit` returns, so a bind performed
    during submit is visible. The adapter has to keep reading notifications after RPCs return;
    nothing in this lab polls `events` to make attribution happen.
    """

    def __init__(self) -> None:
        self.transport = TransportContext()
        self.model_starts: list[dict[str, Any]] = []
        self.tool_starts: list[dict[str, Any]] = []
        self._record_starts()
        self.fence = ContractStorageFence()
        self.fake = FakePeer()
        self.rpc = NativeRpcClient(self.fake)
        self.adapter = HarnessAdapter(self.rpc, self.transport)
        self.supervisor = Supervisor(self.adapter, self.fence, instance_id=HARNESS_INSTANCE_ID)
        self.instance_id = HARNESS_INSTANCE_ID
        self.handle_a: SessionHandle | None = None
        self.handle_b: SessionHandle | None = None
        self.work_a: WorkRef | None = None
        self.run_a = RUN_A
        self.run_b = RUN_B
        self.anchors = [
            TrustAnchor(peer_id="backend-1", role="backend", cert_fingerprint=BACKEND_FINGERPRINT),
            TrustAnchor(peer_id="operator-1", role="operator", cert_fingerprint=OPERATOR_FINGERPRINT),
        ]

    async def aclose(self) -> None:
        return None

    def sample_handle(self) -> SessionHandle:
        return _handle_from(self._reservation(CONV_A, PROV_A, INC_A, "unit-a"), "native-a")

    async def interleave_with_reversed_rpc_responses(self) -> tuple[CanaryView, CanaryView]:
        self.fake.hold_submits = True
        reservation_a = self._reservation(CONV_A, PROV_A, INC_A, "unit-a")
        reservation_b = self._reservation(CONV_B, PROV_B, INC_B, "unit-b")
        self.handle_a = await asyncio.wait_for(self.adapter.create_session(reservation_a), timeout=RPC_TIMEOUT)
        self.handle_b = await asyncio.wait_for(self.adapter.create_session(reservation_b), timeout=RPC_TIMEOUT)
        authority_a = OperationAuthority(inference_token="inf-A", knowledge_token="know-A")
        authority_b = OperationAuthority(inference_token="inf-B", knowledge_token="know-B")
        message_a = SubmitMessage(
            conversation_id=reservation_a.conversation_id,
            client_request_id="req-canary-a",
            message="private-canary-A",
        )
        message_b = SubmitMessage(
            conversation_id=reservation_b.conversation_id,
            client_request_id="req-canary-b",
            message="private-canary-B",
        )
        result_a, result_b = await asyncio.wait_for(
            asyncio.gather(
                self.adapter.submit(self.handle_a, message_a, authority_a),
                self.adapter.submit(self.handle_b, message_b, authority_b),
            ),
            timeout=RPC_TIMEOUT,
        )
        self.work_a = _accepted_work(result_a, self.handle_a.native_session_id)
        _accepted_work(result_b, self.handle_b.native_session_id)
        self.fake.emit_attributed([self.handle_a.native_session_id, self.handle_b.native_session_id])
        await self._wait_attributed(2, 2)
        text_a = await self.history_text(self.handle_a)
        text_b = await self.history_text(self.handle_b)
        return CanaryView(text_a), CanaryView(text_b)

    async def peer_after_cancel_a(self) -> str:
        assert self.handle_a is not None and self.handle_b is not None and self.work_a is not None
        outcome = await asyncio.wait_for(self.adapter.cancel(self.handle_a, self.work_a), timeout=RPC_TIMEOUT)
        if outcome != "requested":
            raise AssertionError(f"cancel outcome {outcome!r} was not the native requested result")
        status = await asyncio.wait_for(self.adapter.inspect(self.handle_b), timeout=RPC_TIMEOUT)
        return status.status

    async def unattributed_model_or_tool_starts(self) -> int:
        self.transport.bind_from_stdio_wrapper(
            {"ESP_NATIVE_SESSION_ID": "forged", "ESP_INFERENCE_TOKEN": "forged-token"}
        )
        self.fake.notify("session/model_call", {})
        self.fake.notify("session/tool_call", {})
        self.fake.notify("session/model_call", {"native_session_id": "native-never-bound"})
        await self.fake.wait_idle()
        return self.transport.unattributed_starts

    async def lose_submit_ack(self) -> SubmissionResult:
        assert self.handle_a is not None
        self.fake.lose_next_submit = True
        message = SubmitMessage(
            conversation_id=self.handle_a.conversation_id,
            client_request_id="req-lost-ack",
            message="private-canary-lost",
        )
        authority = OperationAuthority(inference_token="inf-A", knowledge_token="know-A")
        return await asyncio.wait_for(
            self.adapter.submit(self.handle_a, message, authority),
            timeout=RPC_TIMEOUT,
        )

    async def history_text(self, handle: SessionHandle) -> str:
        snapshot = await asyncio.wait_for(self.adapter.read_history(handle), timeout=RPC_TIMEOUT)
        return "\n".join(item.text for item in snapshot.items)

    def event_params(self, handle: SessionHandle, *, text: str, work: str, run_id: str) -> dict[str, Any]:
        event = NativeEvent(
            native_session_id=handle.native_session_id,
            native_work_ref=work,
            provider_session_id=handle.provider_session_id,
            session_generation=handle.session_generation,
            active_agent_run_id=run_id,
            ownership_epoch=handle.ownership_epoch,
            runtime_incarnation_id=handle.runtime_incarnation_id,
            payload_type="text",
            payload={"text": text},
        )
        return event.model_dump(mode="json")

    async def _wait_attributed(self, models: int, tools: int) -> None:
        await self.fake.wait_idle()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + RPC_TIMEOUT
        while loop.time() < deadline:
            if len(self.model_starts) >= models and len(self.tool_starts) >= tools:
                return
            await asyncio.sleep(0.01)
        raise AssertionError(
            f"expected {models} model and {tools} tool starts, saw {self.model_starts!r} and {self.tool_starts!r}"
        )

    def _record_starts(self) -> None:
        original_model = self.transport.start_model_call
        original_tool = self.transport.start_tool_call

        def start_model_call(native_session_id: str) -> dict[str, Any]:
            result = original_model(native_session_id)
            self.model_starts.append(result)
            return result

        def start_tool_call(native_session_id: str) -> dict[str, Any]:
            result = original_tool(native_session_id)
            self.tool_starts.append(result)
            return result

        self.transport.start_model_call = start_model_call  # type: ignore[method-assign]
        self.transport.start_tool_call = start_tool_call  # type: ignore[method-assign]

    def _reservation(
        self,
        conversation_id: str,
        provider_session_id: str,
        incarnation_id: str,
        unit_id: str,
    ) -> SessionReservation:
        return SessionReservation(
            conversation_id=conversation_id,
            provider_session_id=provider_session_id,
            session_generation=1,
            native_session_id=None,
            harness_instance_id=HARNESS_INSTANCE_ID,
            runtime_incarnation_id=incarnation_id,
            native_storage_unit_id=unit_id,
            state_location=f"memory://{unit_id}",
            ownership_epoch=EPOCH,
            provider="openai",
            model="configured-model",
            brain_release_id="fixture-brain-a",
            brain_hash=BRAIN_HASH,
            behavior_version="fixture-behavior-a",
            behavior_hash=BEHAVIOR_HASH,
            corpus_release_id="fixture-corpus-a",
            deployment_ref="deployment-fixture",
        )


def _handle_from(reservation: SessionReservation, native_session_id: str) -> SessionHandle:
    data = reservation.model_dump()
    data["native_session_id"] = native_session_id
    return SessionHandle.model_validate(data)


def _accepted_work(result: SubmissionResult, native_session_id: str) -> WorkRef:
    if not isinstance(result, Accepted):
        raise AssertionError(f"submit was {getattr(result, 'kind', result)!r}, not accepted")
    if result.work.native_session_id != native_session_id:
        raise AssertionError("accepted work was applied to the wrong native session")
    if not result.work.native_work_ref:
        raise AssertionError("accepted work is missing native_work_ref")
    return result.work
