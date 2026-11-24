"""Provider bytes leave only through the pinned httpcore anyio write hook."""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import AsyncIterator, Awaitable, Mapping
from typing import Any, cast
from urllib.parse import urlsplit

import httpcore
from httpcore._backends.anyio import AnyIOBackend
from pydantic import BaseModel

from esp_contracts.api import STRICT
from esp_contracts.ids import Provider
from esp_contracts.runtime import DispatchTicket, ProviderResponse
from esp_inference_gateway.evidence_recorder import EvidenceReceipt

__all__ = ["ApprovedRoute", "FencedTransport", "TransportError", "WriteProbe"]

# httpcore 1.0.9 writes cleartext HTTP/1.1 through AnyIOStream.write -> ByteStream.send.
# TLS ciphertext is sent inside anyio after start_tls and is not a separate httpcore hook.
WRITE_BOUNDARY = "httpcore.AnyIOStream.write"


class TransportError(Exception):
    def __init__(self, code: str, *, possibly_initiated: bool = False) -> None:
        super().__init__(code)
        self.possibly_initiated = possibly_initiated


class ApprovedRoute(BaseModel):
    """Allowlisted method, URL and model. The caller cannot select the upstream."""

    model_config = STRICT
    provider: Provider
    method: str
    url: str
    model: str
    credential_ref: str


class WriteProbe:
    """Test gate in front of the real socket send. Production leaves the gate open."""

    def __init__(self) -> None:
        self.allow_write = asyncio.Event()
        self.allow_write.set()
        self.write_reached = asyncio.Event()
        self.body_written = asyncio.Event()
        self.connects = 0
        self.writes: list[bytes] = []
        self.handed_bytes = bytearray()
        self.possibly_initiated = False
        self.expected_body = b""

    async def before_connect(self) -> None:
        self.connects += 1

    async def before_write(self, buffer: bytes) -> None:
        del buffer
        self.write_reached.set()
        await self.allow_write.wait()

    def after_write(self, buffer: bytes) -> None:
        self.writes.append(buffer)
        self.handed_bytes.extend(buffer)
        self.possibly_initiated = True
        if self.expected_body and self.expected_body in self.handed_bytes:
            self.body_written.set()


class _ProbedStream(httpcore.AsyncNetworkStream):
    def __init__(self, inner: httpcore.AsyncNetworkStream, probe: WriteProbe) -> None:
        self._inner = inner
        self._probe = probe

    async def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        return await self._inner.read(max_bytes, timeout)

    async def write(self, buffer: bytes, timeout: float | None = None) -> None:
        await self._probe.before_write(buffer)
        await self._inner.write(buffer, timeout)
        self._probe.after_write(buffer)

    async def aclose(self) -> None:
        await self._inner.aclose()

    async def start_tls(
        self,
        ssl_context: Any,
        server_hostname: str | None = None,
        timeout: float | None = None,
    ) -> httpcore.AsyncNetworkStream:
        secured = await self._inner.start_tls(ssl_context, server_hostname, timeout)
        return _ProbedStream(secured, self._probe)

    def get_extra_info(self, info: str) -> Any:
        return self._inner.get_extra_info(info)


class _ProbedBackend(AnyIOBackend):
    def __init__(self, probe: WriteProbe) -> None:
        self._probe = probe

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        await self._probe.before_connect()
        stream = await super().connect_tcp(host, port, timeout, local_address, socket_options)
        return _ProbedStream(stream, self._probe)


class _LiveResponse:
    def __init__(self, status: int, headers: Mapping[str, str], body: AsyncIterator[bytes]) -> None:
        self.status = status
        self.headers = headers
        self.body = body


class _LiveTicket:
    def __init__(
        self,
        inference_id: str,
        initiation: Mapping[str, str],
        write_completed: bool,
        response: Awaitable[ProviderResponse],
    ) -> None:
        self.inference_id = inference_id
        self.initiation = initiation
        self.write_completed = write_completed
        self.response = response


class FencedTransport:
    def __init__(self, credentials: Mapping[str, str], probe: WriteProbe | None = None) -> None:
        self.credentials = dict(credentials)
        self.probe = probe or WriteProbe()
        self._used: set[str] = set()
        self._tasks: list[asyncio.Task[None]] = []
        self._pool = httpcore.AsyncConnectionPool(
            network_backend=_ProbedBackend(self.probe),
            retries=0,
            http2=False,
            max_connections=10,
        )

    async def aclose(self) -> None:
        for task in self._tasks:
            task.cancel()
        await self._pool.aclose()

    async def start(self, route: ApprovedRoute, body: bytes, receipt: EvidenceReceipt) -> DispatchTicket:
        if route.method != "POST" or not route.url.startswith(("http://", "https://")):
            raise TransportError("unsupported_route")
        secret = self.credentials.get(route.credential_ref, "")
        if not secret:
            raise TransportError("credential_unavailable")
        if receipt.inference_id in self._used:
            raise TransportError("replay_forbidden")
        if receipt.request_sha256 != hashlib.sha256(body).hexdigest():
            raise TransportError("evidence_mismatch")
        self._used.add(receipt.inference_id)
        self.probe.expected_body = body
        self.probe.body_written.clear()
        loop = asyncio.get_running_loop()
        pending: asyncio.Future[ProviderResponse] = loop.create_future()
        request = httpcore.Request(
            route.method,
            route.url,
            headers=[
                (b"host", _host_header(route.url)),
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                (b"accept", b"text/event-stream, application/json"),
                (b"authorization", f"Bearer {secret}".encode()),
            ],
            content=body,
            extensions={"timeout": {"connect": 5.0, "write": 5.0, "pool": 5.0}},
        )
        task = asyncio.create_task(self._exchange(request, pending))
        self._tasks.append(task)
        await self.probe.body_written.wait()
        if not self.probe.possibly_initiated:
            _retrieve(pending)
            raise TransportError("not_initiated")
        initiation = {
            "boundary": WRITE_BOUNDARY,
            "request_sha256": receipt.request_sha256,
            "request_ref": receipt.request_ref,
            "proof_ref": receipt.proof_ref,
        }
        return _LiveTicket(receipt.inference_id, initiation, True, cast(Awaitable[ProviderResponse], pending))

    async def _exchange(self, request: httpcore.Request, pending: asyncio.Future[ProviderResponse]) -> None:
        try:
            upstream = await self._pool.handle_async_request(request)
            headers = {
                name.decode("latin-1"): value.decode("latin-1")
                for name, value in upstream.headers
            }
            response = _LiveResponse(upstream.status, headers, _ClosingBody(upstream))
            if not pending.done():
                pending.set_result(response)
        except Exception as exc:
            if not pending.done():
                pending.set_exception(exc)
            if not self.probe.body_written.is_set():
                self.probe.body_written.set()


def _host_header(url: str) -> bytes:
    parts = urlsplit(url)
    host = parts.hostname or ""
    if parts.port is None or parts.port in {80, 443}:
        return host.encode()
    return f"{host}:{parts.port}".encode()


def _retrieve(pending: asyncio.Future[ProviderResponse]) -> None:
    if pending.done() and not pending.cancelled():
        pending.exception()


class _ClosingBody:
    """The upstream body as an async iterator that hands the pooled connection back when it ends or is closed.

    The connection returns to the pool only when the response is closed, not when its body ends. Without this every
    model call kept one of the pool's ten connections for good, and after a few turns each new call failed with a
    PoolTimeout that the gateway reported as `provider_uncertain`. A consumer that stops early calls `aclose`.
    """

    def __init__(self, upstream: Any) -> None:
        self._upstream = upstream
        self._chunks = cast(AsyncIterator[bytes], upstream.aiter_stream().__aiter__())
        self._closed = False

    def __aiter__(self) -> _ClosingBody:
        return self

    async def __anext__(self) -> bytes:
        try:
            chunk = await self._chunks.__anext__()
        except BaseException:
            await self.aclose()
            raise
        return bytes(chunk)

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._upstream.aclose()
