"""ID-routed JSON-RPC client over raw frames, plus the LSP byte codec."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Mapping
from typing import Any, Protocol, cast

FRAME_LIMIT_BYTES = 65536
_HEADER_END = b"\r\n\r\n"


class FrameTooLarge(Exception):
    """Encoded payload or declared Content-Length exceeds the frame limit."""


class ResponseLost(Exception):
    """The request frame was sent, or the stream ended, with no matching response."""


class RpcProtocolError(Exception):
    """JSON-RPC or framing failure. `args[0]` is the integer code when the peer sent one."""

    def __init__(self, code: object) -> None:
        super().__init__(code)
        self.data: object | None = None


class NotificationParams(dict[str, Any]):
    """Notification params. Compares equal to that dict; `method` is not a key."""

    method: str


def _notification(params: Mapping[str, Any], method: str) -> NotificationParams:
    note = NotificationParams(params)
    note.method = method
    return note


class FrameTransport(Protocol):
    async def send_frame(self, payload: bytes) -> None: ...

    async def recv_frame(self) -> bytes: ...


def encode_frame(payload: bytes, *, limit: int = FRAME_LIMIT_BYTES) -> bytes:
    if len(payload) > limit:
        raise FrameTooLarge(len(payload))
    return f"Content-Length: {len(payload)}\r\n\r\n".encode("ascii") + payload


def decode_frame(buffer: bytes, *, limit: int = FRAME_LIMIT_BYTES) -> tuple[bytes, int]:
    end = buffer.find(_HEADER_END)
    if end < 0:
        raise RpcProtocolError("incomplete")
    length = _declared_length(buffer[:end])
    if length > limit:
        raise FrameTooLarge(length)
    start = end + len(_HEADER_END)
    consumed = start + length
    if len(buffer) < consumed:
        raise RpcProtocolError("incomplete")
    return buffer[start:consumed], consumed


def _declared_length(header: bytes) -> int:
    try:
        text = header.decode("ascii")
    except UnicodeDecodeError as exc:
        raise RpcProtocolError("invalid header") from exc
    length: int | None = None
    for line in text.split("\r\n"):
        name, separator, raw = line.partition(":")
        if separator != ":" or name.lower() != "content-length":
            continue
        try:
            length = int(raw.strip())
        except ValueError as exc:
            raise RpcProtocolError("invalid content-length") from exc
    if length is None:
        raise RpcProtocolError("invalid header")
    if length < 0:
        raise RpcProtocolError("invalid content-length")
    return length


def _json_object(value: object) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    return cast(dict[str, Any], value)


def _protocol_error(error: object) -> RpcProtocolError:
    body = _json_object(error)
    if body is None:
        return RpcProtocolError(-32603)
    code: object = body.get("code", -32603)
    exc = RpcProtocolError(code)
    if "data" in body:
        exc.data = body["data"]
    return exc


def _clone(exc: BaseException) -> BaseException:
    if isinstance(exc, RpcProtocolError):
        cloned = RpcProtocolError(*exc.args)
        cloned.data = exc.data
        return cloned
    return exc.__class__(*exc.args)


class NativeRpcClient:
    """One reader task. In-flight calls are matched by JSON-RPC string id, not arrival order."""

    def __init__(self, transport: FrameTransport) -> None:
        self._transport = transport
        self._pending: dict[str, asyncio.Future[object]] = {}
        self._notifications: asyncio.Queue[NotificationParams] = asyncio.Queue()
        self._reader: asyncio.Task[None] | None = None
        self._terminal: BaseException | None = None
        self._lock = asyncio.Lock()

    async def request(self, method: str, params: object) -> object:
        request_id = str(uuid.uuid4())
        body = json.dumps(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        ).encode()
        if len(body) > FRAME_LIMIT_BYTES:
            raise FrameTooLarge(len(body))
        loop = asyncio.get_running_loop()
        future: asyncio.Future[object] = loop.create_future()
        async with self._lock:
            if self._terminal is not None:
                raise _clone(self._terminal)
            self._pending[request_id] = future
            self._ensure_reader()
        try:
            await self._transport.send_frame(body)
        except Exception:
            async with self._lock:
                self._pending.pop(request_id, None)
            if not future.done():
                future.cancel()
            raise
        return await future

    async def notifications(self) -> AsyncIterator[object]:
        async with self._lock:
            if self._terminal is None:
                self._ensure_reader()
        while True:
            yield await self._notifications.get()

    def _ensure_reader(self) -> None:
        if self._reader is not None and not self._reader.done():
            return
        if self._terminal is not None:
            return
        self._reader = asyncio.get_running_loop().create_task(self._read_loop())

    async def _read_loop(self) -> None:
        try:
            while self._terminal is None:
                try:
                    payload = await self._transport.recv_frame()
                except asyncio.CancelledError:
                    raise
                except ConnectionError as exc:
                    await self._terminate(ResponseLost(str(exc)))
                    return
                if payload == b"":
                    await self._terminate(ResponseLost("response lost"))
                    return
                if len(payload) > FRAME_LIMIT_BYTES:
                    await self._terminate(FrameTooLarge(len(payload)))
                    return
                try:
                    message = json.loads(payload)
                except json.JSONDecodeError:
                    await self._fail_current(RpcProtocolError("invalid json"))
                    continue
                await self._dispatch(message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._terminate(exc)

    async def _dispatch(self, message: object) -> None:
        body = _json_object(message)
        if body is None:
            await self._fail_current(RpcProtocolError("invalid message"))
            return
        method = body.get("method")
        if isinstance(method, str) and body.get("id") is None:
            params = _json_object(body.get("params", {}))
            await self._notifications.put(_notification({} if params is None else params, method))
            return
        request_id = body.get("id")
        if not isinstance(request_id, str):
            return
        if "error" not in body and "result" not in body:
            return
        async with self._lock:
            future = self._pending.pop(request_id, None)
        if future is None or future.done():
            return
        if "error" in body:
            future.set_exception(_protocol_error(body["error"]))
            return
        future.set_result(body["result"])

    async def _fail_current(self, exc: Exception) -> None:
        async with self._lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for future in pending:
            if not future.done():
                future.set_exception(_clone(exc))

    async def _terminate(self, exc: BaseException) -> None:
        async with self._lock:
            if self._terminal is not None:
                return
            self._terminal = exc
            pending = list(self._pending.values())
            self._pending.clear()
        for future in pending:
            if not future.done():
                future.set_exception(_clone(exc))
