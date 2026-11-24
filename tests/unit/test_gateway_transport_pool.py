"""The gateway hands each pooled connection back, so the pool does not run dry after a few model calls.

Before the fix `_chunks` read the response body but never closed the response, so every model call kept one of the
pool's ten connections for good. After a few turns of the live chat each new call waited five seconds for a free
connection, failed with a PoolTimeout and was reported as `provider_uncertain`.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from collections.abc import AsyncIterator

import pytest

from esp_contracts.ids import Provider
from esp_inference_gateway.evidence_recorder import EvidenceReceipt
from esp_inference_gateway.transport import ApprovedRoute, FencedTransport

POOL_SIZE = 10
BODY = b'{"ok":true,"padding":"' + b"x" * 2000 + b'"}'


async def _serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """A keep-alive HTTP/1.1 server that answers every POST with the same JSON body."""
    try:
        while True:
            head = await reader.readuntil(b"\r\n\r\n")
            length = 0
            for line in head.split(b"\r\n"):
                if line.lower().startswith(b"content-length:"):
                    length = int(line.split(b":", 1)[1])
            await reader.readexactly(length)
            writer.write(
                b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: "
                + str(len(BODY)).encode()
                + b"\r\nconnection: keep-alive\r\n\r\n"
                + BODY
            )
            await writer.drain()
    except (asyncio.IncompleteReadError, ConnectionError):
        pass
    finally:
        writer.close()


@pytest.fixture
async def server() -> AsyncIterator[str]:
    listener = await asyncio.start_server(_serve, "127.0.0.1", 0)
    port = listener.sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}/v1/chat/completions"
    finally:
        listener.close()
        await listener.wait_closed()


def _route(url: str) -> ApprovedRoute:
    provider: Provider = "xai"
    return ApprovedRoute(provider=provider, method="POST", url=url, model="m", credential_ref="xai")


def _receipt(body: bytes) -> EvidenceReceipt:
    return EvidenceReceipt(
        inference_id=str(uuid.uuid4()), request_ref="r", proof_ref="p", request_sha256=hashlib.sha256(body).hexdigest()
    )


async def _call(transport: FencedTransport, route: ApprovedRoute, *, read_body: bool) -> int:
    body = json.dumps({"model": "m", "messages": []}).encode()
    ticket = await transport.start(route, body, _receipt(body))
    response = await asyncio.wait_for(ticket.response, 10)
    stream = response.body
    if read_body:
        received = b""
        async for chunk in stream:
            received += chunk
        assert received == BODY
    else:
        # A consumer that stops reading (a closed browser, a cancelled relay) closes the stream early.
        close = getattr(stream, "aclose", None)
        assert close is not None
        await close()
    return response.status


async def test_more_calls_than_the_pool_holds_all_succeed(server: str) -> None:
    transport = FencedTransport({"xai": "test-secret"})
    try:
        statuses = [await _call(transport, _route(server), read_body=True) for _ in range(POOL_SIZE * 3)]
    finally:
        await transport.aclose()
    assert statuses == [200] * (POOL_SIZE * 3)


async def test_concurrent_calls_beyond_the_pool_size_succeed_in_rounds(server: str) -> None:
    transport = FencedTransport({"xai": "test-secret"})
    try:
        for _ in range(5):
            statuses = await asyncio.gather(*[_call(transport, _route(server), read_body=True) for _ in range(3)])
            assert statuses == [200, 200, 200]
    finally:
        await transport.aclose()


async def test_a_response_that_is_closed_unread_gives_its_connection_back(server: str) -> None:
    transport = FencedTransport({"xai": "test-secret"})
    try:
        for _ in range(POOL_SIZE + 3):
            assert await _call(transport, _route(server), read_body=False) == 200
        assert await _call(transport, _route(server), read_body=True) == 200
    finally:
        await transport.aclose()
