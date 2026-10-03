"""Grok Build ACP `session/update` notifications as explicit-identity native events.

ACP updates name their session (`sessionId`) but not a turn. The work reference is therefore the
prompt this adapter itself sent on that session (its client-generated `messageId`); ACP runs at most
one prompt turn per session, and an update that arrives while no prompt of ours is in flight is
rejected instead of guessed. Hidden reasoning, plans and replayed user input never become events.
"""

from __future__ import annotations

from collections.abc import Mapping, MutableMapping
from typing import Any, cast

from esp_contracts.runtime import NativeEvent
from esp_provider_shared.transport_context import OperationContext

# Key of the Knowledge Service entry in infra/runtime/grok/config.toml `[mcp_servers]`.
ESP_KNOWLEDGE_SERVER = "esp_knowledge"
# The six model-visible Knowledge Service tools (services/esp_mcp). Grok Build reaches an MCP tool
# through its qualified catalog key `server__tool`.
ESP_KNOWLEDGE_TOOLS: tuple[str, ...] = (
    "esp.search",
    "esp.get_source",
    "esp.get_claim",
    "esp.get_concept",
    "esp.get_asset",
    "esp.get_current_value",
)
_QUALIFIED_ESP_TOOLS = {f"{ESP_KNOWLEDGE_SERVER}__{tool}": tool for tool in ESP_KNOWLEDGE_TOOLS}

# Session updates that are not public work events: hidden reasoning, plans, replayed user input,
# command lists, mode and session metadata, and context-window gauges.
QUIET_UPDATES: frozenset[str] = frozenset(
    {
        "agent_thought_chunk",
        "plan",
        "user_message_chunk",
        "available_commands_update",
        "current_mode_update",
        "session_info_update",
        "usage_update",
    }
)
# ACP tool kinds that change files, run commands or fetch from the network. Never informational.
_MUTATING_KINDS = frozenset({"execute", "edit", "delete", "move", "fetch"})
_STOP_STATUS = {"end_turn": "completed", "cancelled": "interrupted"}

_Payload = dict[str, str | int | float | bool | None]


class GrokEventRejected(Exception):
    """An update lacked explicit native identity or named a session with no operation in flight."""


def normalize_grok_update(
    params: Mapping[str, Any],
    context: OperationContext | None,
    tool_calls: MutableMapping[str, str],
    *,
    pinned_model_option: str | None = None,
) -> NativeEvent | None:
    """Return the event, or None for updates that are not public work events.

    `tool_calls` maps the operation's ESP tool call ids to their tool so a later status update can
    finish them. `pinned_model_option` is the model option the session was created with.
    """
    session_id = params.get("sessionId")
    update = _object(params.get("update"))
    if not isinstance(session_id, str) or session_id == "" or update is None:
        raise GrokEventRejected("missing_native_identity")
    if context is None or context.native_session_id != session_id:
        raise GrokEventRejected("unbound_session")
    if context.native_work_ref is None or context.native_work_ref == "":
        raise GrokEventRejected("missing_work_ref")
    mapped = _payload(update, tool_calls, pinned_model_option)
    if mapped is None:
        return None
    payload_type, payload = mapped
    return _event(context, payload_type, payload)


def terminal_events(
    context: OperationContext,
    result: Mapping[str, Any],
    *,
    compaction: bool = False,
) -> list[NativeEvent]:
    """Events for a `session/prompt` response, which in ACP is the end of that prompt turn."""
    stop_reason = _text(result.get("stopReason"))
    status = _STOP_STATUS.get(stop_reason, "failed")
    kind = "compaction" if compaction else "turn_completed"
    events = [_event(context, kind, {"status": status, "stop_reason": stop_reason})]
    usage = _object(result.get("usage"))
    if usage is not None:
        events.append(
            _event(
                context,
                "usage",
                {
                    "input_tokens": _int(usage.get("inputTokens")),
                    "output_tokens": _int(usage.get("outputTokens")),
                    "cached_input_tokens": _int(usage.get("cachedReadTokens")),
                },
            )
        )
    return events


def stop_status(stop_reason: object) -> str:
    """Native work status for an ACP stop reason: completed, interrupted or failed."""
    return _STOP_STATUS.get(_text(stop_reason), "failed")


def model_option(options: object) -> str | None:
    """Current value of the session's `model` config option, if the build reported one."""
    if not isinstance(options, list):
        return None
    for entry in cast(list[object], options):
        option = _object(entry)
        if option is not None and option.get("id") == "model":
            value = option.get("currentValue")
            return value if isinstance(value, str) else None
    return None


def _event(context: OperationContext, payload_type: str, payload: _Payload) -> NativeEvent:
    return NativeEvent(
        native_session_id=context.native_session_id,
        native_work_ref=cast(str, context.native_work_ref),
        provider_session_id=context.provider_session_id,
        session_generation=context.session_generation,
        active_agent_run_id=context.active_agent_run_id,
        ownership_epoch=context.ownership_epoch,
        runtime_incarnation_id=context.runtime_incarnation_id,
        payload_type=payload_type,
        payload=payload,
    )


def _payload(
    update: Mapping[str, Any],
    tool_calls: MutableMapping[str, str],
    pinned_model_option: str | None,
) -> tuple[str, _Payload] | None:
    kind = _text(update.get("sessionUpdate"))
    if kind in QUIET_UPDATES:
        return None
    if kind == "agent_message_chunk":
        content = _object(update.get("content")) or {}
        if content.get("type") != "text":
            return None
        return "text_delta", {"text": _text(content.get("text")), "message_id": _text(update.get("messageId"))}
    if kind == "tool_call":
        return _tool_call(update, tool_calls)
    if kind == "tool_call_update":
        return _tool_call_update(update, tool_calls)
    if kind == "config_option_update":
        current = model_option(update.get("configOptions"))
        if current is not None and pinned_model_option is not None and current != pinned_model_option:
            return "model_rerouted", {"from_model": pinned_model_option, "to_model": current, "reason": "config_option"}
        return None
    return None


def _tool_name(update: Mapping[str, Any]) -> str:
    meta = _object(update.get("_meta")) or {}
    tool = _object(meta.get("x.ai/tool")) or {}
    for candidate in (tool.get("name"), update.get("toolName"), update.get("title")):
        if isinstance(candidate, str) and candidate != "":
            return candidate
    return ""


def _tool_call(update: Mapping[str, Any], tool_calls: MutableMapping[str, str]) -> tuple[str, _Payload]:
    call_id = _text(update.get("toolCallId"))
    name = _tool_name(update)
    tool = _QUALIFIED_ESP_TOOLS.get(name)
    if tool is not None and _text(update.get("kind")) not in _MUTATING_KINDS:
        tool_calls[call_id] = tool
        return "tool_started", {"tool": tool, "item_id": call_id}
    # Shell, file, web, subagent, MCP dispatcher and unknown tools are not part of the informational
    # profile. They surface so supervision can stop the work and record the violation.
    return "disallowed_item", {"item_type": name or _text(update.get("kind")), "item_id": call_id, "phase": "started"}


def _tool_call_update(update: Mapping[str, Any], tool_calls: MutableMapping[str, str]) -> tuple[str, _Payload] | None:
    call_id = _text(update.get("toolCallId"))
    tool = tool_calls.get(call_id)
    if tool is None:
        status = _text(update.get("status"))
        return "disallowed_item", {"item_type": _tool_name(update), "item_id": call_id, "phase": status or "update"}
    status = _text(update.get("status"))
    if status not in {"completed", "failed"}:
        return None
    del tool_calls[call_id]
    return "tool_finished", {"tool": tool, "item_id": call_id, "status": status}


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
