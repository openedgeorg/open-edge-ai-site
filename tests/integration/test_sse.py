"""Bounded SSE reconnect. Delivery is connection-local and never resubmits native work."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from esp_contracts.api import SSE_SUBSCRIBER_MAX_BYTES
from esp_contracts.runtime import AuthorityRecord, NativeEvent
from esp_db.authority import read_current_authority
from esp_event_protocol.normalize import normalize_event
from esp_runtime_harconses.supervision import RunSupervision
from scripts.migrate import migrate
from tests.support.database import APP_DSN
from tests.support.submission import SubmissionLab, close_submission_lab, open_submission_lab, post_message

_FLOOD = 400
_CHUNK = 800


class SseLab:
    """One accepted submission and the native notifications a subscriber may or may not read."""

    def __init__(self, inner: SubmissionLab) -> None:
        self.inner = inner
        self.conversation_id = ""
        self.native_work_ref = ""
        self.run_id = ""
        self.authority: AuthorityRecord | None = None
        self.visitor: Any = None

    async def prepare(self) -> None:
        self.visitor = await self.inner.visitor()
        self.conversation_id = await self.inner.created(self.visitor)
        response = await post_message(
            self.visitor,
            self.conversation_id,
            {
                "conversation_id": self.conversation_id,
                "client_request_id": "sse-main",
                "message": "sse draft",
            },
        )
        assert response.status_code == 200, response.text
        mapping = await self.inner.mapping(self.conversation_id)
        assert mapping is not None
        self.native_work_ref = str(mapping["current_native_work_ref"])
        self.run_id = str(mapping["active_agent_run_id"])
        record = await read_current_authority(self.inner.runtime().backend.db, str(mapping["id"]))
        assert record is not None
        self.authority = record

    def normalize_stale_event(self) -> list[object]:
        authority = self._authority()
        event = self._event("text_delta", {"text": "stale"}, ownership_epoch=authority.ownership_epoch - 1)
        return normalize_event(event, authority)

    def done_json(self) -> dict[str, Any]:
        published = normalize_event(self._event("done", {"status": "completed"}), self._authority())
        assert len(published) == 1
        return published[0].model_dump(by_alias=True)

    def reset_json(self) -> dict[str, Any]:
        published = normalize_event(self._event("output_reset", {}), self._authority())
        assert len(published) == 1
        return published[0].model_dump(by_alias=True)

    async def maximum_subscriber_bytes(self) -> int:
        await self._flood(_FLOOD, _CHUNK)
        response = await self._events(self.visitor)
        size = len(response.content)
        assert size > SSE_SUBSCRIBER_MAX_BYTES // 2
        assert size < _FLOOD * _CHUNK
        return size

    async def new_connection_first_sequence(self) -> int:
        response = await self._events(self.visitor)
        envelopes = _envelopes(response.text)
        assert envelopes
        return int(envelopes[0]["sequence"])

    async def native_submits_after_reconnect(self) -> int:
        runtime = await self.inner.restarted_backend()
        index = self.inner.runtimes.index(runtime)
        visitor = self.inner.same_browser(self.visitor, index)
        response = await self._events(visitor)
        assert response.status_code == 200
        return self.inner.cluster.submissions("sse-main")

    async def push_text(self, text: str, **overrides: object) -> None:
        self._notify(self._event("text_delta", {"text": text}, **overrides))
        await self._pump()

    async def consume(self) -> None:
        supervision = self.inner.runtime().app.state.supervision
        assert isinstance(supervision, RunSupervision)
        await supervision.consume_control_events()

    def _authority(self) -> AuthorityRecord:
        assert self.authority is not None
        return self.authority

    def _event(
        self, payload_type: str, payload: dict[str, str | int | float | bool | None], **overrides: object
    ) -> NativeEvent:
        authority = self._authority()
        assert authority.native_session_id is not None
        assert authority.active_agent_run_id is not None
        assert authority.runtime_incarnation_id is not None
        data: dict[str, object] = {
            "native_session_id": authority.native_session_id,
            "native_work_ref": self.native_work_ref,
            "provider_session_id": authority.provider_session_id,
            "session_generation": authority.session_generation,
            "active_agent_run_id": authority.active_agent_run_id,
            "ownership_epoch": authority.ownership_epoch,
            "runtime_incarnation_id": authority.runtime_incarnation_id,
            "payload_type": payload_type,
            "payload": payload,
        }
        data.update(overrides)
        return NativeEvent.model_validate(data)

    def _notify(self, event: NativeEvent) -> None:
        authority = self._authority()
        assert authority.harness_instance_id is not None
        process = self.inner.cluster.processes[authority.harness_instance_id]
        process.notify("session/event", event.model_dump(mode="json"))

    async def _flood(self, count: int, width: int) -> None:
        text = "x" * width
        for _ in range(count):
            self._notify(self._event("text_delta", {"text": text}))
        await self._pump(expected=count)

    async def _pump(self, *, expected: int = 1) -> None:
        deadline = asyncio.get_running_loop().time() + 2.0
        while self.inner.runtime().pool.pending_control_events() < expected:
            if asyncio.get_running_loop().time() > deadline:
                pending = self.inner.runtime().pool.pending_control_events()
                raise AssertionError(f"native events did not queue: pending={pending} expected={expected}")
            await asyncio.sleep(0)

    async def _events(self, visitor: Any) -> httpx.Response:
        response = await visitor.client.get(f"/conversations/{self.conversation_id}/events")
        assert response.status_code == 200, response.text
        return response


def _envelopes(text: str) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for frame in text.split("\n\n"):
        data = [line[len("data: ") :] for line in frame.split("\n") if line.startswith("data: ")]
        if data:
            found.append(json.loads("\n".join(data)))
    return found


@pytest.fixture
async def sse_lab(tmp_path: Path) -> AsyncIterator[SseLab]:
    await migrate(APP_DSN)
    inner = await open_submission_lab(tmp_path, instances=[(16, 16)], provider_limit=32)
    lab = SseLab(inner)
    try:
        await lab.prepare()
        yield lab
    finally:
        await close_submission_lab(inner)


async def test_stream_aliases_bounds_and_no_resubmit(sse_lab: SseLab) -> None:
    assert sse_lab.normalize_stale_event() == []
    assert sse_lab.done_json()["nativeWorkRef"] == sse_lab.native_work_ref
    assert sse_lab.reset_json()["activeAgentRunId"] == sse_lab.run_id
    assert await sse_lab.maximum_subscriber_bytes() <= 262144
    assert await sse_lab.new_connection_first_sequence() == 1
    assert await sse_lab.native_submits_after_reconnect() == 1


async def test_no_subscriber_does_not_resubmit_or_finish_text(sse_lab: SseLab) -> None:
    await sse_lab.push_text("unread delta")
    await sse_lab.consume()
    assert sse_lab.inner.cluster.submissions("sse-main") == 1
    mapping = await sse_lab.inner.mapping(sse_lab.conversation_id)
    assert mapping is not None
    assert mapping["runtime_state"] == "running"
    assert mapping["active_agent_run_id"] == sse_lab.run_id


async def test_stream_drops_stale_origin_and_keeps_current_text(sse_lab: SseLab) -> None:
    stale_epoch = sse_lab._authority().ownership_epoch + 1
    sse_lab._notify(sse_lab._event("text_delta", {"text": "stale"}, ownership_epoch=stale_epoch))
    sse_lab._notify(sse_lab._event("text_delta", {"text": "current"}))
    await sse_lab._pump(expected=2)
    response = await sse_lab._events(sse_lab.visitor)
    texts = [item["event"].get("text") for item in _envelopes(response.text)]
    assert "stale" not in texts
    assert "current" in texts


async def test_events_are_owner_scoped(sse_lab: SseLab) -> None:
    stranger = await sse_lab.inner.visitor()
    denied = await stranger.client.get(f"/conversations/{sse_lab.conversation_id}/events")
    missing = await sse_lab.visitor.client.get("/conversations/not-a-uuid/events")
    assert denied.status_code == 404
    assert denied.json()["error"]["code"] == "not_found"
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "not_found"
    assert sse_lab.inner.cluster.submissions("sse-main") == 1
