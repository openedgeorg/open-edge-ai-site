"""Map a native notification to the website event union, or to nothing.

A stale epoch, incarnation, run, or work reference publishes nothing. Terminal output names the
confirmed native work and cannot speak for a replacement run. Invalid payloads are dropped, not echoed.
"""

from __future__ import annotations

import json
from typing import cast

from pydantic import ValidationError

from esp_contracts.api import AssetRef, Citation, SessionStatusName, StructuredData, Usage
from esp_contracts.runtime import AuthorityRecord, NativeEvent
from esp_event_protocol.chat_event import (
    AssetEvent,
    ChatEvent,
    CitationEvent,
    Done,
    ErrorEvent,
    EventEnvelope,
    OutputReset,
    SessionStatus,
    StructuredDataEvent,
    TextDelta,
    ToolFinished,
    ToolStarted,
    UsageEvent,
)

_KIND = {
    "text_delta": "text_delta",
    "text.delta": "text_delta",
    "assistant_delta": "text_delta",
    "citation": "citation",
    "tool_started": "tool_started",
    "tool.started": "tool_started",
    "tool_finished": "tool_finished",
    "tool.finished": "tool_finished",
    "asset": "asset",
    "usage": "usage",
    "session_status": "session_status",
    "output_reset": "output_reset",
    "error": "error",
    "done": "done",
    "turn_completed": "done",
    "structured_data": "structured_data",
}
_SESSION_STATUS = frozenset({"starting", "restoring", "running", "recovering", "warm_idle"})


def normalize_event(event: NativeEvent, authority: AuthorityRecord) -> list[ChatEvent]:
    """Current-authority events only. Anything else is an empty publication."""
    if not _same_authority(event, authority):
        return []
    kind = _KIND.get(event.payload_type)
    if kind is None:
        return []
    if kind != "session_status" and not _same_work(event, authority):
        return []
    built = _build(kind, event, authority)
    if built is None:
        return []
    return [built]


def encode_sse(envelope: EventEnvelope) -> bytes:
    """One SSE frame. Names and JSON use the public aliases."""
    data = envelope.model_dump_json(by_alias=True)
    return f"event: {envelope.event.type}\ndata: {data}\n\n".encode()


def _same_authority(event: NativeEvent, authority: AuthorityRecord) -> bool:
    if not authority.is_current:
        return False
    native_id = authority.native_session_id
    return (
        event.provider_session_id == authority.provider_session_id
        and event.active_agent_run_id == authority.active_agent_run_id
        and event.ownership_epoch == authority.ownership_epoch
        and event.runtime_incarnation_id == authority.runtime_incarnation_id
        and event.session_generation == authority.session_generation
        and (native_id is None or event.native_session_id == native_id)
    )


def _same_work(event: NativeEvent, authority: AuthorityRecord) -> bool:
    current = authority.current_native_work_ref
    return current is not None and event.native_work_ref == current


def _build(kind: str, event: NativeEvent, authority: AuthorityRecord) -> ChatEvent | None:
    payload = event.payload
    try:
        if kind == "text_delta":
            text = payload.get("text")
            if not isinstance(text, str):
                return None
            return TextDelta(type="text_delta", text=text)
        if kind == "citation":
            return CitationEvent(type="citation", citation=Citation.model_validate(_citation(payload)))
        if kind == "tool_started":
            tool = payload.get("tool")
            if not isinstance(tool, str):
                return None
            return ToolStarted(type="tool_started", tool=tool)
        if kind == "tool_finished":
            tool = payload.get("tool")
            if not isinstance(tool, str):
                return None
            return ToolFinished(type="tool_finished", tool=tool)
        if kind == "asset":
            return AssetEvent(type="asset", asset=_asset(payload))
        if kind == "usage":
            return UsageEvent(type="usage", usage=Usage.model_validate(_usage(payload)))
        if kind == "session_status":
            status = payload.get("status")
            if not isinstance(status, str) or status not in _SESSION_STATUS:
                return None
            return SessionStatus(type="session_status", status=cast(SessionStatusName, status))
        if kind == "output_reset":
            named = payload.get("activeAgentRunId")
            if isinstance(named, str) and named != authority.active_agent_run_id:
                return None
            run_id = authority.active_agent_run_id
            if run_id is None:
                return None
            return OutputReset(type="output_reset", activeAgentRunId=run_id)
        if kind == "error":
            code = payload.get("code")
            message = payload.get("message")
            retryable = payload.get("retryable")
            if not isinstance(code, str) or not isinstance(message, str) or not isinstance(retryable, bool):
                return None
            return ErrorEvent(type="error", code=code, message=message, retryable=retryable)
        if kind == "done":
            return Done(type="done", nativeWorkRef=event.native_work_ref)
        if kind == "structured_data":
            raw = payload.get("table")
            if not isinstance(raw, str):
                return None
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                return None
            return StructuredDataEvent(type="structured_data", data=StructuredData.model_validate(parsed))
    except ValidationError:
        return None
    return None


def _citation(payload: dict[str, str | int | float | bool | None]) -> dict[str, object]:
    quote = payload.get("quote")
    return {
        "source_id": payload.get("source_id"),
        "version": payload.get("version"),
        "title": payload.get("title"),
        "locator": payload.get("locator"),
        "quote": quote if isinstance(quote, str) else None,
        "verification_state": payload.get("verification_state"),
    }


def _asset(payload: dict[str, str | int | float | bool | None]) -> AssetRef:
    return AssetRef.model_validate(
        {
            "asset_id": payload.get("asset_id"),
            "version": payload.get("version"),
            "kind": payload.get("kind"),
            "alt": payload.get("alt"),
            "source_id": payload.get("source_id"),
        }
    )


def _usage(payload: dict[str, str | int | float | bool | None]) -> dict[str, object]:
    return {
        "input_tokens": payload.get("input_tokens"),
        "output_tokens": payload.get("output_tokens"),
        "cached_tokens": payload.get("cached_tokens"),
    }
