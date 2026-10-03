"""Codex App Server notifications as explicit-identity native events.

Identity comes only from the notification's own `threadId` and turn id, checked against the
operation context bound for that thread. Hidden reasoning never becomes an event.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from esp_contracts.runtime import NativeEvent
from esp_provider_shared.transport_context import OperationContext

ESP_MCP_SERVER = "esp_knowledge"

# Work-scoped notifications this adapter maps. Every name is in the captured server notification list.
CODEX_EVENT_METHODS: frozenset[str] = frozenset(
    {
        "turn/started",
        "turn/completed",
        "item/started",
        "item/completed",
        "item/agentMessage/delta",
        "error",
        "thread/tokenUsage/updated",
        "model/rerouted",
        "thread/compacted",
    }
)

# Never surfaced, even if the build sends them despite the initialize opt-out.
HIDDEN_METHODS: frozenset[str] = frozenset(
    {
        "item/reasoning/textDelta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/summaryPartAdded",
        "item/plan/delta",
    }
)

# Item types that are part of an informational turn. Anything else is a policy violation.
_QUIET_ITEM_TYPES = frozenset({"userMessage", "reasoning", "plan"})
_TURN_STATUS = {"completed": "completed", "interrupted": "interrupted", "failed": "failed", "inProgress": "running"}

_Payload = dict[str, str | int | float | bool | None]


class CodexEventRejected(Exception):
    """A mapped notification lacked explicit native identity or named an unbound thread."""


def normalize_codex_notification(
    method: str,
    params: Mapping[str, Any],
    context: OperationContext | None,
) -> NativeEvent | None:
    """Return the event, or None for notifications that are not public work events."""
    if method in HIDDEN_METHODS or method not in CODEX_EVENT_METHODS:
        return None
    thread_id = params.get("threadId")
    turn_id = notification_turn_id(method, params)
    if not isinstance(thread_id, str) or thread_id == "" or turn_id is None:
        raise CodexEventRejected("missing_native_identity")
    if context is None or context.native_session_id != thread_id:
        raise CodexEventRejected("unbound_thread")
    mapped = _payload(method, params)
    if mapped is None:
        return None
    payload_type, payload = mapped
    return NativeEvent(
        native_session_id=thread_id,
        native_work_ref=turn_id,
        provider_session_id=context.provider_session_id,
        session_generation=context.session_generation,
        active_agent_run_id=context.active_agent_run_id,
        ownership_epoch=context.ownership_epoch,
        runtime_incarnation_id=context.runtime_incarnation_id,
        payload_type=payload_type,
        payload=payload,
    )


def notification_turn_id(method: str, params: Mapping[str, Any]) -> str | None:
    """Turn id carried by a notification, from the turn object or the explicit `turnId` field."""
    if method in {"turn/started", "turn/completed"}:
        turn = _object(params.get("turn"))
        value = None if turn is None else turn.get("id")
    else:
        value = params.get("turnId")
    if isinstance(value, str) and value != "":
        return value
    return None


def _payload(method: str, params: Mapping[str, Any]) -> tuple[str, _Payload] | None:
    if method == "item/agentMessage/delta":
        return "text_delta", {"text": _text(params.get("delta")), "item_id": _text(params.get("itemId"))}
    if method == "turn/started":
        return "turn_started", {"status": "running"}
    if method == "turn/completed":
        return _turn_completed(params)
    if method == "item/started" or method == "item/completed":
        return _item(method, params)
    if method == "error":
        error = _object(params.get("error")) or {}
        return "error", {"message": _text(error.get("message")), "will_retry": params.get("willRetry") is True}
    if method == "thread/tokenUsage/updated":
        return _usage(params)
    if method == "model/rerouted":
        return "model_rerouted", {
            "from_model": _text(params.get("fromModel")),
            "to_model": _text(params.get("toModel")),
            "reason": _text(params.get("reason")),
        }
    if method == "thread/compacted":
        return "compaction", {"item_id": None}
    return None


def _turn_completed(params: Mapping[str, Any]) -> tuple[str, _Payload]:
    turn = _object(params.get("turn")) or {}
    status = _TURN_STATUS.get(_text(turn.get("status")), "unknown")
    error = _object(turn.get("error"))
    message = None if error is None else _text(error.get("message"))
    return "turn_completed", {"status": status, "error": message}


def _item(method: str, params: Mapping[str, Any]) -> tuple[str, _Payload] | None:
    item = _object(params.get("item"))
    if item is None:
        raise CodexEventRejected("missing_item")
    item_type = _text(item.get("type"))
    item_id = _text(item.get("id"))
    completed = method == "item/completed"
    if item_type in _QUIET_ITEM_TYPES:
        return None
    if item_type == "agentMessage":
        if not completed:
            return None
        return "assistant_message", {"item_id": item_id, "text": _text(item.get("text"))}
    if item_type == "contextCompaction":
        return ("compaction", {"item_id": item_id}) if completed else None
    if item_type == "mcpToolCall" and item.get("server") == ESP_MCP_SERVER:
        tool = f"{ESP_MCP_SERVER}.{_text(item.get('tool'))}"
        if completed:
            return "tool_finished", {"tool": tool, "item_id": item_id, "status": _text(item.get("status"))}
        return "tool_started", {"tool": tool, "item_id": item_id}
    # Shell, file edits, web search, image generation, subagents and unknown items are not part of the
    # informational profile. They surface so supervision can stop the work and record the violation.
    phase = "completed" if completed else "started"
    return "disallowed_item", {"item_type": item_type, "item_id": item_id, "phase": phase}


def _usage(params: Mapping[str, Any]) -> tuple[str, _Payload]:
    usage = _object(params.get("tokenUsage")) or {}
    last = _object(usage.get("last")) or {}
    return "usage", {
        "input_tokens": _int(last.get("inputTokens")),
        "output_tokens": _int(last.get("outputTokens")),
        "cached_input_tokens": _int(last.get("cachedInputTokens")),
    }


def _object(value: object) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return cast(dict[str, Any], value)
    return None


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _int(value: object) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None
