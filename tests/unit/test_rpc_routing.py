"""ID-routed JSON-RPC framing. No adapter and no supervisor."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from esp_provider_shared.rpc import (
    FRAME_LIMIT_BYTES,
    FrameTooLarge,
    NativeRpcClient,
    ResponseLost,
    decode_frame,
    encode_frame,
)


def parse_frame(payload: bytes) -> dict[str, Any]:
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


def _success(request_id: object, result: dict[str, object]) -> bytes:
    return json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}).encode()


class ScriptedTransport:
    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self._inbox: asyncio.Queue[bytes] = asyncio.Queue()
        self._notify = asyncio.Event()

    async def send_frame(self, payload: bytes) -> None:
        self.sent.append(payload)
        self._notify.set()

    async def recv_frame(self) -> bytes:
        return await self._inbox.get()

    def enqueue(self, payload: bytes) -> None:
        self._inbox.put_nowait(payload)

    async def wait_sent(self, count: int) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 2
        while len(self.sent) < count:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise AssertionError(f"timed out waiting for {count} frames; saw {len(self.sent)}")
            self._notify.clear()
            if len(self.sent) >= count:
                return
            try:
                await asyncio.wait_for(self._notify.wait(), timeout=remaining)
            except TimeoutError:
                continue


class ReversingTransport:
    """Buffers until two requests are sent, then answers the second id first."""

    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self._inbox: asyncio.Queue[bytes] = asyncio.Queue()

    async def send_frame(self, payload: bytes) -> None:
        self.sent.append(payload)
        if len(self.sent) < 2:
            return
        first = parse_frame(self.sent[0])
        second = parse_frame(self.sent[1])
        self._inbox.put_nowait(_success(second["id"], {"marker": second["params"]["marker"]}))
        self._inbox.put_nowait(_success(first["id"], {"marker": first["params"]["marker"]}))

    async def recv_frame(self) -> bytes:
        return await self._inbox.get()


class ClosingTransport:
    def __init__(self) -> None:
        self.sent: list[bytes] = []

    async def send_frame(self, payload: bytes) -> None:
        self.sent.append(payload)

    async def recv_frame(self) -> bytes:
        raise ConnectionError("eof")


async def test_reversed_responses_follow_request_ids() -> None:
    transport = ReversingTransport()
    client = NativeRpcClient(transport)

    async def call(marker: str) -> object:
        return await client.request("session/submit", {"marker": marker})

    first, second = await asyncio.wait_for(asyncio.gather(call("A"), call("B")), timeout=2)
    assert first == {"marker": "A"}
    assert second == {"marker": "B"}
    ids = [parse_frame(payload)["id"] for payload in transport.sent]
    assert len(ids) == 2
    assert ids[0] != ids[1]
    assert all(isinstance(item, str) and item for item in ids)


async def test_unknown_response_id_does_not_complete_inflight_request() -> None:
    transport = ScriptedTransport()
    client = NativeRpcClient(transport)
    pending = asyncio.create_task(client.request("session/inspect", {"native_session_id": "n-1"}))
    await transport.wait_sent(1)
    message = parse_frame(transport.sent[0])
    assert isinstance(message["id"], str)
    transport.enqueue(_success("unknown-response-id", {"stolen": True}))
    transport.enqueue(_success(message["id"], {"ok": True}))
    result = await asyncio.wait_for(pending, timeout=2)
    assert result == {"ok": True}


async def test_notifications_are_not_responses() -> None:
    transport = ScriptedTransport()
    client = NativeRpcClient(transport)
    seen: list[object] = []

    async def watch() -> None:
        async for params in client.notifications():
            seen.append(params)
            return

    watcher = asyncio.create_task(watch())
    await asyncio.sleep(0)
    pending = asyncio.create_task(client.request("session/inspect", {"native_session_id": "n-1"}))
    await transport.wait_sent(1)
    request_id = parse_frame(transport.sent[0])["id"]
    transport.enqueue(
        json.dumps(
            {"jsonrpc": "2.0", "method": "session/event", "params": {"native_session_id": "n-1"}}
        ).encode()
    )
    transport.enqueue(_success(request_id, {"status": "idle", "saved_input_available": False}))
    result = await asyncio.wait_for(pending, timeout=2)
    await asyncio.wait_for(watcher, timeout=2)
    assert result == {"status": "idle", "saved_input_available": False}
    assert seen == [{"native_session_id": "n-1"}]


def test_frame_limit_rejects_declared_oversize_without_body() -> None:
    with pytest.raises(FrameTooLarge):
        decode_frame(b"Content-Length: 65537\r\n\r\n")
    with pytest.raises(FrameTooLarge):
        encode_frame(b"x" * (FRAME_LIMIT_BYTES + 1))
    encoded = encode_frame(b"x" * FRAME_LIMIT_BYTES)
    assert encoded == b"Content-Length: 65536\r\n\r\n" + (b"x" * FRAME_LIMIT_BYTES)
    payload, consumed = decode_frame(encoded)
    assert payload == b"x" * FRAME_LIMIT_BYTES
    assert consumed == len(encoded)


async def test_response_lost_when_stream_ends_after_send() -> None:
    transport = ClosingTransport()
    client = NativeRpcClient(transport)
    with pytest.raises(ResponseLost):
        await asyncio.wait_for(client.request("session/submit", {"native_session_id": "n-1"}), timeout=2)
    assert transport.sent, "request frame was not sent"
