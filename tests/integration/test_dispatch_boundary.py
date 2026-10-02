"""The shared fence covers the socket write and ends before response headers."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from tests.support.wire_server import WireLab, build_wire_lab


@pytest.fixture
async def wire_lab(tmp_path: Path) -> AsyncIterator[WireLab]:
    lab = await build_wire_lab(tmp_path)
    try:
        yield lab
    finally:
        await lab.close()


async def test_bytes_wait_for_the_write_hook_and_the_transaction_ends(wire_lab: WireLab, tmp_path: Path) -> None:
    wire_lab.server.got_body.clear()
    wire_lab.transport.probe.allow_write.clear()
    wire_lab.server.hold_headers = True
    wire_lab.server.release_headers.clear()
    task = asyncio.create_task(wire_lab.forward_one())
    await asyncio.wait_for(wire_lab.transport.probe.write_reached.wait(), timeout=5)
    assert wire_lab.server.got_body.is_set() is False
    wire_lab.transport.probe.allow_write.set()
    await asyncio.wait_for(wire_lab.handed_off.wait(), timeout=5)
    async with wire_lab.db.pool.connection() as connection:
        async with connection.transaction():
            cursor = await connection.execute(
                "SELECT esp_try_fence(%s, %s, true) AS locked",
                (str(wire_lab.incarnation_id), str(wire_lab.session_id)),
            )
            row = await cursor.fetchone()
    assert row is not None and row["locked"] is True
    wire_lab.server.release_headers.set()
    trace = await asyncio.wait_for(task, timeout=5)
    assert trace.provider_body == trace.decrypted_evidence_body
    assert trace.status == 200

    expired = await build_wire_lab(tmp_path / "expired")
    try:
        assert await expired.starts_after_lease_expiry() == 0
    finally:
        await expired.close()
    closed = await build_wire_lab(tmp_path / "closed")
    try:
        assert await closed.starts_when_database_is_lost() == 0
    finally:
        await closed.close()
