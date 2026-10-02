"""ID-routed harness adapter. Notifications are consumed without entering events()."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Mapping
from typing import Any, Literal

from pydantic import ValidationError

from esp_contracts.api import SubmitMessage
from esp_contracts.runtime import (
    Accepted,
    NativeEvent,
    NativeHistorySnapshot,
    NativeStatus,
    NotSubmitted,
    OperationAuthority,
    SessionHandle,
    SessionReservation,
    SubmissionResult,
    Unconfirmed,
    WorkRef,
)
from esp_provider_shared.rpc import NativeRpcClient, NotificationParams, ResponseLost, RpcProtocolError
from esp_provider_shared.transport_context import OperationContext, TransportContext

_METHOD_NOT_FOUND = -32601
_UNKNOWN_NATIVE_CODE = -32001
_CancelOutcome = Literal["requested", "stopped", "unknown"]
_UnloadOutcome = Literal["unloaded", "unsupported"]


class UnknownNativeId(Exception):
    """The harness has no session for this native id."""


class UnsupportedPrimitive(Exception):
    """Export or delete is not implemented by this harness. `.primitive` names which one."""

    def __init__(self, primitive: str) -> None:
        super().__init__(primitive)
        self.primitive = primitive


def _error_data_code(exc: RpcProtocolError) -> str | None:
    data = exc.data
    if not isinstance(data, dict):
        return None
    code = data.get("code")
    if isinstance(code, str):
        return code
    return None


def _jsonrpc_code_is(exc: RpcProtocolError, code: int) -> bool:
    return bool(exc.args) and exc.args[0] == code


def _remote_kind(exc: RpcProtocolError) -> Literal["unknown_native_id", "unsupported"] | None:
    data_code = _error_data_code(exc)
    if data_code == "unknown_native_id":
        return "unknown_native_id"
    if data_code == "unsupported" or _jsonrpc_code_is(exc, _METHOD_NOT_FOUND):
        return "unsupported"
    if _jsonrpc_code_is(exc, _UNKNOWN_NATIVE_CODE):
        return "unknown_native_id"
    return None


def _raise_if_unknown(exc: RpcProtocolError) -> None:
    if _remote_kind(exc) == "unknown_native_id":
        raise UnknownNativeId("unknown_native_id") from exc


def _matching_payload(handle: SessionHandle, result: object, *, required: bool) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise RpcProtocolError("invalid result")
    payload = dict(result)
    if required or "native_session_id" in payload:
        got = payload.pop("native_session_id", None)
        if got != handle.native_session_id:
            raise RpcProtocolError("native_session_mismatch")
    return payload


def _submission_from(handle: SessionHandle, result: object) -> SubmissionResult:
    payload = _matching_payload(handle, result, required=True)
    disposition = payload.get("disposition")
    if disposition == "accepted":
        work_ref = payload.get("native_work_ref")
        if not isinstance(work_ref, str) or work_ref == "":
            raise RpcProtocolError("missing native_work_ref")
        return Accepted(
            kind="accepted",
            work=WorkRef(native_session_id=handle.native_session_id, native_work_ref=work_ref),
        )
    if disposition == "not_submitted":
        code = payload.get("code")
        if not isinstance(code, str) or code == "":
            code = "not_submitted"
        return NotSubmitted(kind="not_submitted", code=code)
    if disposition == "unconfirmed":
        work_ref = payload.get("native_work_ref")
        native_work_ref = work_ref if isinstance(work_ref, str) and work_ref != "" else None
        return Unconfirmed(kind="unconfirmed", native_work_ref=native_work_ref)
    raise RpcProtocolError("invalid disposition")


def _handle_from_reservation(reservation: SessionReservation, native_session_id: str) -> SessionHandle:
    """Copy Python fields so `ownership_epoch` stays an int, not a JSON string."""
    data = reservation.model_dump()
    data["native_session_id"] = native_session_id
    return SessionHandle.model_validate(data)


class HarnessAdapter:
    """One native harness process. Session state is keyed by `native_session_id` on this instance."""

    def __init__(self, rpc: NativeRpcClient, transport: TransportContext) -> None:
        self._rpc = rpc
        self.transport = transport
        self.rejected_events = 0
        self._run_ids: dict[str, str] = {}
        self._bound: set[str] = set()
        self._events: dict[str, asyncio.Queue[NativeEvent]] = {}
        self._consumer = asyncio.create_task(self._consume(), name="harness-notifications")

    async def create_session(self, reservation: SessionReservation) -> SessionHandle:
        result = await self._rpc.request("session/create", reservation.model_dump(mode="json"))
        if not isinstance(result, dict):
            raise RpcProtocolError("invalid result")
        native_session_id = result.get("native_session_id")
        if not isinstance(native_session_id, str) or native_session_id == "":
            raise RpcProtocolError("missing native_session_id")
        self._remember_run(native_session_id)
        return _handle_from_reservation(reservation, native_session_id)

    async def resume_session(self, handle: SessionHandle) -> SessionHandle:
        try:
            result = await self._rpc.request("session/resume", {"native_session_id": handle.native_session_id})
        except RpcProtocolError as exc:
            _raise_if_unknown(exc)
            raise
        _matching_payload(handle, result, required=True)
        self._remember_run(handle.native_session_id)
        return handle

    async def submit(
        self,
        handle: SessionHandle,
        message: SubmitMessage,
        authority: OperationAuthority,
    ) -> SubmissionResult:
        self._bind(handle, authority, None)
        return await self._submit_rpc(
            "session/submit",
            handle,
            {
                "native_session_id": handle.native_session_id,
                "message": message.message,
                "client_request_id": message.client_request_id,
                "inference_token": authority.inference_token,
                "knowledge_token": authority.knowledge_token,
            },
        )

    async def continue_work(
        self,
        handle: SessionHandle,
        work: WorkRef,
        authority: OperationAuthority,
    ) -> SubmissionResult:
        self._bind(handle, authority, work.native_work_ref)
        return await self._submit_rpc(
            "session/continue",
            handle,
            {
                "native_session_id": handle.native_session_id,
                "native_work_ref": work.native_work_ref,
                "inference_token": authority.inference_token,
                "knowledge_token": authority.knowledge_token,
            },
        )

    async def inspect(self, handle: SessionHandle, request_id: str | None = None) -> NativeStatus:
        params: dict[str, Any] = {"native_session_id": handle.native_session_id}
        if request_id is not None:
            params["request_id"] = request_id
        result = await self._session_request("session/inspect", params)
        return NativeStatus.model_validate(_matching_payload(handle, result, required=False))

    async def read_history(self, handle: SessionHandle) -> NativeHistorySnapshot:
        result = await self._session_request("session/history", {"native_session_id": handle.native_session_id})
        return NativeHistorySnapshot.model_validate(_matching_payload(handle, result, required=False))

    async def cancel(self, handle: SessionHandle, work: WorkRef) -> _CancelOutcome:
        try:
            result = await self._rpc.request(
                "session/cancel",
                {"native_session_id": handle.native_session_id, "native_work_ref": work.native_work_ref},
            )
        except RpcProtocolError as exc:
            _raise_if_unknown(exc)
            return "unknown"
        if not isinstance(result, dict):
            return "unknown"
        if "native_session_id" in result and result["native_session_id"] != handle.native_session_id:
            raise RpcProtocolError("native_session_mismatch")
        outcome = result.get("outcome")
        if outcome == "requested" or outcome == "stopped" or outcome == "unknown":
            return outcome
        return "unknown"

    async def unload(self, handle: SessionHandle) -> _UnloadOutcome:
        try:
            result = await self._rpc.request("session/unload", {"native_session_id": handle.native_session_id})
        except RpcProtocolError as exc:
            _raise_if_unknown(exc)
            if _remote_kind(exc) == "unsupported":
                return "unsupported"
            raise
        payload = _matching_payload(handle, result, required=False)
        outcome = payload.get("outcome")
        if outcome == "unloaded":
            return "unloaded"
        if outcome == "unsupported":
            return "unsupported"
        raise RpcProtocolError("invalid unload outcome")

    async def export_history(self, handle: SessionHandle) -> None:
        await self._missing_primitive("session/export", handle, "export")

    async def delete_history(self, handle: SessionHandle) -> None:
        await self._missing_primitive("session/delete", handle, "delete")

    async def events(self, handle: SessionHandle) -> AsyncIterator[NativeEvent]:
        queue = self._queue_for(handle.native_session_id)
        while True:
            yield await queue.get()

    async def _submit_rpc(self, method: str, handle: SessionHandle, params: Mapping[str, Any]) -> SubmissionResult:
        try:
            result = await self._rpc.request(method, dict(params))
        except ResponseLost:
            # The frame was sent. A send-side OSError is the only not_sent path.
            return Unconfirmed(kind="unconfirmed", native_work_ref=None)
        except OSError:
            return NotSubmitted(kind="not_submitted", code="not_sent")
        except RpcProtocolError as exc:
            _raise_if_unknown(exc)
            raise
        return _submission_from(handle, result)

    async def _session_request(self, method: str, params: Mapping[str, Any]) -> object:
        try:
            return await self._rpc.request(method, dict(params))
        except RpcProtocolError as exc:
            _raise_if_unknown(exc)
            raise

    async def _missing_primitive(self, method: str, handle: SessionHandle, primitive: str) -> None:
        try:
            await self._rpc.request(method, {"native_session_id": handle.native_session_id})
        except RpcProtocolError as exc:
            _raise_if_unknown(exc)
            if _remote_kind(exc) == "unsupported":
                raise UnsupportedPrimitive(primitive) from exc
            raise

    def _bind(self, handle: SessionHandle, authority: OperationAuthority, native_work_ref: str | None) -> None:
        context = OperationContext(
            native_session_id=handle.native_session_id,
            native_work_ref=native_work_ref,
            provider_session_id=handle.provider_session_id,
            session_generation=handle.session_generation,
            active_agent_run_id=self._remember_run(handle.native_session_id),
            ownership_epoch=handle.ownership_epoch,
            runtime_incarnation_id=handle.runtime_incarnation_id,
            inference_token=authority.inference_token,
            knowledge_token=authority.knowledge_token,
        )
        self.transport.bind(context)
        self._bound.add(handle.native_session_id)

    def _remember_run(self, native_session_id: str) -> str:
        run_id = self._run_ids.get(native_session_id)
        if run_id is None:
            run_id = str(uuid.uuid4())
            self._run_ids[native_session_id] = run_id
        return run_id

    def _queue_for(self, native_session_id: str) -> asyncio.Queue[NativeEvent]:
        queue = self._events.get(native_session_id)
        if queue is None:
            queue = asyncio.Queue()
            self._events[native_session_id] = queue
        return queue

    async def _consume(self) -> None:
        async for params in self._rpc.notifications():
            if not isinstance(params, NotificationParams):
                self.rejected_events += 1
                continue
            self._on_notification(params)

    def _on_notification(self, params: NotificationParams) -> None:
        method = params.method
        if method == "session/model_call" or method == "session/tool_call":
            self._on_audience(method, params.get("native_session_id"))
            return
        if method == "session/event":
            self._on_event(params)

    def _on_audience(self, method: str, native_session_id: object) -> None:
        if not isinstance(native_session_id, str) or native_session_id == "":
            self.rejected_events += 1
            return
        # An id this adapter did not bind must not call start_*; that would count as unattributed.
        if native_session_id not in self._bound:
            return
        if method == "session/model_call":
            self.transport.start_model_call(native_session_id)
            return
        self.transport.start_tool_call(native_session_id)

    def _on_event(self, params: Mapping[str, Any]) -> None:
        native_session_id = params.get("native_session_id")
        native_work_ref = params.get("native_work_ref")
        if not isinstance(native_session_id, str) or native_session_id == "":
            self.rejected_events += 1
            return
        if not isinstance(native_work_ref, str) or native_work_ref == "":
            self.rejected_events += 1
            return
        try:
            event = NativeEvent.model_validate(dict(params))
        except ValidationError:
            self.rejected_events += 1
            return
        self._queue_for(event.native_session_id).put_nowait(event)
