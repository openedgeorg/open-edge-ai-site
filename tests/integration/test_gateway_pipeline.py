"""Ordered evidence, real sockets, and origin-specific relay."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

import httpcore
import httpx
import pytest

from esp_execution_bindings.binding import AuthorizationError
from esp_inference_gateway.server import build_gateway
from tests.support.wire_server import WireLab, build_wire_lab


@pytest.fixture
async def wire_lab(tmp_path: Path) -> AsyncIterator[WireLab]:
    lab = await build_wire_lab(tmp_path)
    try:
        yield lab
    finally:
        await lab.close()


async def test_evidence_and_real_write_are_ordered(wire_lab: WireLab) -> None:
    trace = await wire_lab.forward_one()
    assert trace.steps == ["authorize", "verify", "evidence_ack", "reauthorize", "dispatch"]
    assert trace.provider_body == trace.decrypted_evidence_body
    assert trace.upstream_headers["authorization"] == "Bearer gw-test-secret"
    assert "esp-inference-token" not in trace.upstream_headers
    assert await wire_lab.starts_after_evidence_failure() == 0
    assert await wire_lab.starts_when_process_revocation_wins() == 0
    assert await wire_lab.stale_mutations_when_dispatch_wins() == 0


async def test_split_frames_statuses_and_lost_outcome_do_not_replay(wire_lab: WireLab) -> None:
    wire_lab.server.chunks = [b"\xc3", b"\xa9", b"\n"]
    trace = await wire_lab.forward_one()
    assert trace.response_body == "é\n".encode()
    assert trace.status == 200
    wire_lab.server.chunks = None
    wire_lab.server.status = 429
    denied = await wire_lab.forward_one()
    assert denied.status == 429
    wire_lab.server.status = 302
    redirected = await wire_lab.forward_one()
    assert redirected.status == 302
    assert wire_lab.server.requests == 3
    wire_lab.server.drop_early = True
    before = wire_lab.server.accepts
    with pytest.raises((httpcore.ProtocolError, httpcore.ReadError)):
        await wire_lab.forward_one()
    assert wire_lab.server.accepts == before + 1
    wire_lab.server.drop_early = False
    wire_lab.server.status = 200
    seen = wire_lab.server.requests
    assert await wire_lab.lost_outcome_does_not_replay() == seen + 1


async def test_two_origins_do_not_mix(tmp_path: Path) -> None:
    first = await build_wire_lab(tmp_path / "a", user_text="canary-origin-a")
    second = await build_wire_lab(tmp_path / "b", user_text="canary-origin-b")
    try:
        left, right = await asyncio.gather(first.forward_one(), second.forward_one())
    finally:
        await first.close()
        await second.close()
    assert b"canary-origin-a" in left.provider_body
    assert b"canary-origin-b" not in left.provider_body
    assert b"canary-origin-b" in right.provider_body
    assert b"canary-origin-a" not in right.provider_body
    assert left.provider_body == left.decrypted_evidence_body
    assert right.provider_body == right.decrypted_evidence_body


async def test_app_strips_caller_credentials(wire_lab: WireLab) -> None:
    app = build_gateway(wire_lab.deps)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://esp") as client:
        response = await client.post(
            "/openai/v1/responses",
            content=wire_lab.raw,
            headers={"esp-inference-token": wire_lab.token, "authorization": "Bearer visitor"},
        )
        wrong_provider = await client.post(
            "/xai/v1/responses",
            content=wire_lab.raw,
            headers={"esp-inference-token": wire_lab.token},
        )
        wrong_audience = await client.post(
            "/openai/v1/responses",
            content=wire_lab.raw,
            headers={"esp-inference-token": wire_lab.knowledge_token},
        )
    assert response.status_code == 200
    assert response.content == b"data: hello\n\n"
    assert wire_lab.server.headers["authorization"] == "Bearer gw-test-secret"
    assert "esp-inference-token" not in wire_lab.server.headers
    assert wrong_provider.status_code == 403
    assert wrong_audience.status_code == 403
    with pytest.raises(AuthorizationError):
        await dispatch_from_empty(wire_lab)


async def dispatch_from_empty(wire_lab: WireLab) -> None:
    from esp_inference_gateway.server import dispatch_inference

    await dispatch_inference(wire_lab.deps, token="", raw=wire_lab.raw, provider="openai")
