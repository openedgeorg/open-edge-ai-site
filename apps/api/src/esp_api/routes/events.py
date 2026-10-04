"""`GET /conversations/{id}/events`: connection-local normalized native events.

Owner-checked before the stream starts (another subject or a bad id is `404`). The first envelope, when
a run is current, is the database runtime status. Later envelopes are native notifications that still
match that authority. The sequence starts at 1 on every connection. A subscriber that would exceed
`SSE_SUBSCRIBER_MAX_BYTES` is detached; the rest of the run is status and native history, not a replay
buffer. This route never submits.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import cast

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from esp_api.auth import require_subject
from esp_api.boundary import NO_STORE, ApiError
from esp_contracts.api import SSE_SUBSCRIBER_MAX_BYTES, SessionStatusName
from esp_contracts.ids import Provider, new_id
from esp_contracts.runtime import AuthorityRecord, NativeEvent
from esp_db.client import Db, transaction
from esp_db.records import AUTHORITY_COLUMNS
from esp_espcon.conversation import ConversationNotFound, ConversationService
from esp_event_protocol.chat_event import ChatEvent, EventEnvelope, SessionStatus
from esp_event_protocol.normalize import encode_sse, normalize_event
from esp_provider_router.router import NativeRuntimeAdapter

router = APIRouter()

_PUBLIC_STATUS: dict[str, SessionStatusName] = {
    "starting": "starting",
    "running": "running",
    "warm_idle": "warm_idle",
    "cancelling": "recovering",
    "recovering": "recovering",
}


class EventAttachments:
    """Read current authority once and relay only the notifications already queued for that session."""

    def __init__(self, db: Db, adapters: Mapping[Provider, NativeRuntimeAdapter]) -> None:
        self._db = db
        self._pools: Sequence[object] = list(adapters.values())

    async def attach_events(self, subject_id: str, conversation_id: str) -> AsyncIterator[EventEnvelope]:
        record = await self._authority(subject_id, conversation_id)
        run_id = None if record is None else record.active_agent_run_id
        native_id = None if record is None else record.native_session_id
        if record is None or run_id is None or native_id is None:
            return
        connection_id = new_id()
        sequence = 1
        status = _PUBLIC_STATUS.get(record.runtime_state)
        if status is not None:
            yield _envelope(
                record,
                connection_id,
                sequence,
                SessionStatus(type="session_status", status=status),
                record.current_native_work_ref,
            )
            sequence += 1
        for event in await self._take(native_id):
            for chat in normalize_event(event, record):
                yield _envelope(record, connection_id, sequence, chat, event.native_work_ref)
                sequence += 1

    async def _authority(self, subject_id: str, conversation_id: str) -> AuthorityRecord | None:
        columns = ", ".join(AUTHORITY_COLUMNS)
        query = f"SELECT {columns} FROM current_authority WHERE conversation_id = %s AND owner_subject_id = %s"  # noqa: S608
        async with transaction(self._db) as tx:
            row = await tx.execute_one(query, (conversation_id, subject_id))
        if row is None:
            return None
        return AuthorityRecord.model_validate(row)

    async def _take(self, native_session_id: str) -> list[NativeEvent]:
        taken: list[NativeEvent] = []
        idle_passes = 0
        while idle_passes < 4:
            await asyncio.sleep(0)
            batch = _drain_session(self._pools, native_session_id)
            if batch:
                taken.extend(batch)
                idle_passes = 0
            else:
                idle_passes += 1
        return taken


def _envelope(
    record: AuthorityRecord,
    connection_id: str,
    sequence: int,
    event: ChatEvent,
    native_work_ref: str | None,
) -> EventEnvelope:
    run_id = record.active_agent_run_id
    if run_id is None:
        raise RuntimeError("an envelope requires a current run")
    return EventEnvelope(
        protocol_version=1,
        conversation_id=record.conversation_id,
        provider_session_id=record.provider_session_id,
        activeAgentRunId=run_id,
        nativeWorkRef=native_work_ref,
        connection_id=connection_id,
        sequence=sequence,
        event=event,
    )


def _drain_session(pools: Sequence[object], native_session_id: str) -> list[NativeEvent]:
    events: list[NativeEvent] = []
    for pool in pools:
        adapters = getattr(pool, "_adapters", None)
        if not isinstance(adapters, dict):
            continue
        for item in cast(Mapping[object, object], adapters).values():
            inner = cast(object, item[0] if isinstance(item, tuple) else item)
            queues = getattr(inner, "_events", None)
            if not isinstance(queues, dict):
                continue
            queue = cast(Mapping[object, object], queues).get(native_session_id)
            if not isinstance(queue, asyncio.Queue):
                continue
            event_queue = cast("asyncio.Queue[object]", queue)
            while True:
                try:
                    event = event_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                if isinstance(event, NativeEvent):
                    events.append(event)
    return events


@router.get("/conversations/{conversation_id}/events")
async def get_events(request: Request, conversation_id: str) -> StreamingResponse:
    subject = require_subject(request)
    conversations = request.app.state.conversations
    if not isinstance(conversations, ConversationService):
        raise RuntimeError("application has no conversation service")
    try:
        await conversations.get_conversation(subject.subject_id, conversation_id)
    except ConversationNotFound as exc:
        raise ApiError(404, "not_found", "No such conversation.") from exc
    attachments = request.app.state.events
    if not isinstance(attachments, EventAttachments):
        raise RuntimeError("application has no event attachments")

    async def body() -> AsyncIterator[bytes]:
        sent = 0
        async for envelope in attachments.attach_events(subject.subject_id, conversation_id):
            frame = encode_sse(envelope)
            if sent + len(frame) > SSE_SUBSCRIBER_MAX_BYTES:
                return
            sent += len(frame)
            yield frame

    return StreamingResponse(body(), media_type="text/event-stream", headers=dict(NO_STORE))
