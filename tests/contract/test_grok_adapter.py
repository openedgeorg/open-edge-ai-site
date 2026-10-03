"""Task 12: exact Grok Build candidate (one long-lived ACP process) mapped onto the native adapter contract."""

from __future__ import annotations

import asyncio
import contextlib
import copy
import hashlib
import json
import subprocess
import sys
import tomllib
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any, cast, get_args

import pytest

from esp_contracts.api import SubmitMessage
from esp_contracts.qualification import REQUIRED_PRIMITIVES
from esp_contracts.runtime import (
    Accepted,
    NativeEvent,
    NotSubmitted,
    OperationAuthority,
    SessionHandle,
    Unconfirmed,
    WorkRef,
)
from esp_mcp.tools import EspToolName
from esp_provider_shared.adapter import UnsupportedPrimitive
from esp_provider_shared.rpc import FRAME_LIMIT_BYTES, FrameTooLarge, NativeRpcClient, ResponseLost
from esp_provider_shared.transport_context import OperationContext, UnattributedCall
from esp_provider_xai.events import (
    ESP_KNOWLEDGE_SERVER,
    ESP_KNOWLEDGE_TOOLS,
    GrokEventRejected,
    normalize_grok_update,
    terminal_events,
)
from esp_provider_xai.grok_build_adapter import (
    ACP_PROTOCOL_VERSION,
    GROK_BUILD,
    GROK_CLIENT_NOTIFICATIONS,
    GROK_COMPACT_COMMAND,
    GROK_MCP_SESSION_HEADER,
    GROK_METHODS,
    GROK_MODEL_CATALOG_KEY,
    GROK_NATIVE_SHA256,
    GROK_SESSION_CWD,
    GROK_SESSION_HEADER,
    GROK_VERSION,
    MAX_MODEL_REQUEST_BYTES,
    AcpClientGuard,
    GrokBindingMismatch,
    GrokCapabilityMissing,
    GrokSessionBusy,
    GrokSessionNotLoaded,
    GrokStdioTransport,
    create_grok_adapter,
    grok_build_id,
    grok_message_id,
)
from scripts.qualify import (
    GROK_DECLARED_PRIMITIVES,
    GrokObservation,
    essential_absences,
    grok_capability_report,
    grok_protocol_capture,
    observe_grok,
    sanitize_grok_initialize,
)
from tests.support.contracts import EPOCH
from tests.support.grok_capture import (
    AUXILIARY_MODEL,
    CANARY_A,
    CANARY_B,
    CANDIDATE_PATH,
    CAPTURE_PATH,
    CONFIG_PATH,
    CONV_A,
    CONV_C,
    LAB_HOST_META,
    LAB_MODEL,
    PROV_A,
    PROV_C,
    RPC_TIMEOUT,
    GrokLab,
    lab_profile,
    load_capture,
    reservation,
    write_grok_observation,
)

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
async def grok_lab() -> AsyncIterator[GrokLab]:
    lab = await GrokLab.start()
    try:
        yield lab
    finally:
        await lab.aclose()


# Plan scenario ----------------------------------------------------------------------------


async def test_grok_explicit_session_and_durable_acceptance(grok_lab: GrokLab) -> None:
    await grok_lab.submit_a()
    assert grok_lab.prompt_session_id == grok_lab.handle_a.native_session_id
    assert grok_lab.peer_canary not in await grok_lab.read_a_text()
    assert (await grok_lab.terminal_ack_without_durability()).kind == "unconfirmed"
    assert await grok_lab.unbound_auxiliary_requests() == 0
    # Positive observations: the auxiliary paths were actually exercised and the peer saw no off-capture call.
    assert grok_lab.auxiliary_attempts >= 3
    assert grok_lab.peer.violations == []


# Acceptance and durable input correlation ---------------------------------------------------


async def test_accepted_work_is_the_prompt_whose_input_native_history_holds(grok_lab: GrokLab) -> None:
    result = await grok_lab.submit_a()
    assert isinstance(result, Accepted)
    session_a = grok_lab.handle_a.native_session_id
    expected = grok_message_id(session_a, grok_lab.message_a.client_request_id)
    assert result.work == WorkRef(native_session_id=session_a, native_work_ref=expected)
    prompts = grok_lab.peer.requests_for("session/prompt")
    prompt_a = next(params for params in prompts if params["sessionId"] == session_a)
    assert prompt_a["messageId"] == expected
    assert prompt_a["prompt"] == [{"type": "text", "text": CANARY_A}]
    # B is still running natively. No replay is read over our own running prompt, so B is unconfirmed with
    # its deterministic reference, never accepted from a terminal ack or a mid-turn replay.
    session_b = grok_lab.handle_b.native_session_id
    expected_b = grok_message_id(session_b, grok_lab.message_b.client_request_id)
    assert grok_lab.result_b == Unconfirmed(kind="unconfirmed", native_work_ref=expected_b)
    assert grok_lab.peer.sessions[session_b].held is not None
    loads = [params["sessionId"] for params in grok_lab.peer.requests_for("session/load")]
    assert session_a in loads and session_b not in loads
    # Status reconciliation after B's turn confirms its saved input from the replay.
    grok_lab.peer.release(session_b)
    await grok_lab.peer.wait_idle()
    reconciled = await asyncio.wait_for(
        grok_lab.adapter.inspect(grok_lab.handle_b, grok_lab.message_b.client_request_id), RPC_TIMEOUT
    )
    assert (reconciled.status, reconciled.native_work_ref, reconciled.saved_input_available) == (
        "completed",
        expected_b,
        True,
    )
    assert grok_lab.peer.violations == []


async def test_message_ids_are_deterministic_per_session_and_request() -> None:
    first = grok_message_id("session-a", "req-1")
    assert first == grok_message_id("session-a", "req-1")
    assert first != grok_message_id("session-b", "req-1")
    assert first != grok_message_id("session-a", "req-2")


async def test_terminal_ack_without_durable_input_is_unconfirmed(grok_lab: GrokLab) -> None:
    grok_lab.peer.persist_user_messages = False
    result = await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a)
    assert isinstance(result, Unconfirmed)
    # The build named the user message in its terminal response, so the reference is native, not guessed.
    session_a = grok_lab.handle_a.native_session_id
    assert result.native_work_ref == grok_message_id(session_a, grok_lab.message_a.client_request_id)


async def test_lost_prompt_response_is_unconfirmed(grok_lab: GrokLab) -> None:
    grok_lab.peer.lose_next_prompt_response = True
    result = await asyncio.wait_for(
        grok_lab.adapter.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a), RPC_TIMEOUT
    )
    assert isinstance(result, Unconfirmed)
    assert result.native_work_ref is None


async def test_send_failure_before_write_is_not_submitted(grok_lab: GrokLab) -> None:
    grok_lab.peer.fail_next_send = True
    result = await asyncio.wait_for(
        grok_lab.adapter.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a), RPC_TIMEOUT
    )
    assert isinstance(result, NotSubmitted)
    assert result.code == "not_sent"
    assert grok_lab.adapter.transport.current(grok_lab.handle_a.native_session_id) is None


async def test_native_refusal_is_not_submitted_only_without_durable_input(grok_lab: GrokLab) -> None:
    grok_lab.peer.reject_next_prompt = True
    refused = await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a)
    assert isinstance(refused, NotSubmitted)
    assert refused.code == "native_rejected"
    grok_lab.peer.reject_next_prompt = True
    grok_lab.peer.record_input_before_rejection = True
    message = SubmitMessage(conversation_id=CONV_A, client_request_id="req-a-recorded", message="recorded anyway")
    recorded = await grok_lab.submit(grok_lab.handle_a, message, grok_lab.authority_a)
    assert isinstance(recorded, Unconfirmed)
    assert recorded.native_work_ref == grok_message_id(grok_lab.handle_a.native_session_id, "req-a-recorded")


@pytest.mark.parametrize("line", [b"{not json", b"[1, 2]"], ids=["malformed", "non_object"])
async def test_local_frame_failure_during_prompt_is_unconfirmed(grok_lab: GrokLab, line: bytes) -> None:
    grok_lab.peer.persist_user_messages = False
    grok_lab.peer.raw_line_before_next_prompt_response = line
    result = await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a)
    assert isinstance(result, Unconfirmed)


async def test_peer_internal_error_on_prompt_is_not_a_conclusive_refusal(grok_lab: GrokLab) -> None:
    grok_lab.peer.reject_next_prompt = True
    grok_lab.peer.reject_code = -32603
    result = await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a)
    assert isinstance(result, Unconfirmed)


async def test_second_prompt_on_a_busy_session_is_refused_without_sending(grok_lab: GrokLab) -> None:
    await grok_lab.submit_a()
    sent_before = len(grok_lab.peer.requests_for("session/prompt"))
    message = SubmitMessage(conversation_id=grok_lab.handle_b.conversation_id, client_request_id="req-b-2", message="x")
    result = await grok_lab.submit(grok_lab.handle_b, message, grok_lab.authority_b)
    assert isinstance(result, NotSubmitted)
    assert result.code == "prompt_in_flight"
    assert len(grok_lab.peer.requests_for("session/prompt")) == sent_before


async def test_continue_work_without_native_primitive_sends_nothing(grok_lab: GrokLab) -> None:
    sent_before = len(grok_lab.peer.requests)
    work = WorkRef(native_session_id=grok_lab.handle_a.native_session_id, native_work_ref="msg-1")
    result = await grok_lab.adapter.continue_work(grok_lab.handle_a, work, grok_lab.authority_a)
    assert isinstance(result, NotSubmitted)
    assert result.code == "continue_unsupported"
    assert len(grok_lab.peer.requests) == sent_before


# Session binding, handshake and profile -----------------------------------------------------


async def test_create_and_resume_pin_model_and_working_directory(grok_lab: GrokLab) -> None:
    created = grok_lab.peer.requests_for("session/new")
    assert len(created) == 2
    for params in created:
        assert params == {"cwd": GROK_SESSION_CWD, "mcpServers": []}
    resumed = await grok_lab.adapter.resume_session(grok_lab.handle_a)
    assert resumed == grok_lab.handle_a
    assert grok_lab.peer.requests_for("session/resume") == [
        {"sessionId": grok_lab.handle_a.native_session_id, "cwd": GROK_SESSION_CWD, "mcpServers": []}
    ]
    for _, params in grok_lab.peer.requests:
        text = json.dumps(params)
        assert "inf-A" not in text and "know-A" not in text
    assert grok_lab.peer.violations == []


async def test_model_option_drift_or_absence_is_rejected(grok_lab: GrokLab) -> None:
    grok_lab.peer.model_option_override = "grok-4.6"
    with pytest.raises(GrokBindingMismatch, match="model_drift"):
        await grok_lab.adapter.create_session(reservation(CONV_C, PROV_C))
    with pytest.raises(GrokBindingMismatch, match="model_drift"):
        await grok_lab.adapter.resume_session(grok_lab.handle_a)
    grok_lab.peer.model_option_override = None
    grok_lab.peer.omit_model_option = True
    with pytest.raises(GrokBindingMismatch, match="model_unverified"):
        await grok_lab.adapter.create_session(reservation(CONV_C, PROV_C))
    with pytest.raises(GrokBindingMismatch, match="model_pin_mismatch"):
        await grok_lab.adapter.create_session(reservation(CONV_C, PROV_C, model="other-model"))


async def test_factory_requires_exact_xai_build_profile() -> None:
    rpc = NativeRpcClient(AcpClientGuard(_NeverPeer()))
    with pytest.raises(ValueError, match="profile_provider_mismatch"):
        create_grok_adapter(rpc, lab_profile(provider="openai"))
    for label in (GROK_VERSION, f"{GROK_VERSION} sha256:{'0' * 64}", "grok 1.0.46 (2765805b9442) [stable]"):
        with pytest.raises(ValueError, match="unqualified_harness_build"):
            create_grok_adapter(rpc, lab_profile(harness_build=label))
    candidate = json.loads(CANDIDATE_PATH.read_text(encoding="utf-8"))
    adapter = create_grok_adapter(rpc, lab_profile(harness_build=candidate["harness_build"]))
    assert adapter.profile.harness_build == GROK_BUILD


async def test_handshake_offers_no_client_tools_and_returns_no_host_identity(grok_lab: GrokLab) -> None:
    initialize = grok_lab.peer.requests_for("initialize")
    assert initialize == [
        {
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False},
            "clientInfo": {"name": "esp-supervisor", "version": "1"},
        }
    ]
    summary = await GrokLab().adapter.initialize()
    text = json.dumps(summary)
    for value in LAB_HOST_META.values():
        assert str(value) not in text
    assert summary["protocolVersion"] == ACP_PROTOCOL_VERSION
    assert summary["agentVersion"] == "1.0.46"


@pytest.mark.parametrize(
    ("capabilities", "load_session", "missing"),
    [
        ({"list": {}, "close": {}}, True, "resume"),
        ({"list": {}, "resume": {}}, True, "close"),
        ({"list": {}, "resume": {}, "close": {}}, False, "loadSession"),
    ],
)
async def test_handshake_requires_the_declared_session_capabilities(
    capabilities: dict[str, object], load_session: bool, missing: str
) -> None:
    lab = GrokLab()
    lab.peer.declared_session_capabilities = capabilities
    lab.peer.declared_load_session = load_session
    with pytest.raises(GrokCapabilityMissing, match=missing):
        await asyncio.wait_for(lab.adapter.initialize(), RPC_TIMEOUT)


# Native history, resume, status, cancellation and unload --------------------------------------


async def test_history_is_session_scoped_replay_that_hides_reasoning_and_tools(grok_lab: GrokLab) -> None:
    await grok_lab.submit_a()
    grok_lab.peer.updates_during_next_prompt = [
        _esp_tool_call("c-1"),
        {"sessionUpdate": "plan", "entries": [{"content": "secret plan", "priority": "high", "status": "pending"}]},
    ]
    message = SubmitMessage(conversation_id=CONV_A, client_request_id="req-a-2", message="second question")
    assert isinstance(await grok_lab.submit(grok_lab.handle_a, message, grok_lab.authority_a), Accepted)
    snapshot = await asyncio.wait_for(grok_lab.adapter.read_history(grok_lab.handle_a), RPC_TIMEOUT)
    texts = [item.text for item in snapshot.items]
    roles = [item.role for item in snapshot.items]
    assert texts == [CANARY_A, f"reply to {CANARY_A}", "second question", "reply to second question"]
    assert roles == ["user", "assistant", "user", "assistant"]
    session_a = grok_lab.handle_a.native_session_id
    first = grok_message_id(session_a, grok_lab.message_a.client_request_id)
    assert [item.native_work_ref for item in snapshot.items[:2]] == [first, first]
    joined = "\n".join(texts)
    assert "hidden" not in joined and "secret plan" not in joined and CANARY_B not in joined
    assert snapshot.status.status == "completed"
    assert grok_lab.peer.requests_for("session/load")[-1] == {
        "sessionId": session_a,
        "cwd": GROK_SESSION_CWD,
        "mcpServers": [],
    }


async def test_history_replay_never_enters_the_live_event_stream(grok_lab: GrokLab) -> None:
    await grok_lab.submit_a()
    await _drain(grok_lab, grok_lab.handle_a)
    await grok_lab.history_text(grok_lab.handle_a)
    assert await _drain(grok_lab, grok_lab.handle_a) == []


async def test_history_of_a_running_session_is_refused_while_its_peer_stays_readable(grok_lab: GrokLab) -> None:
    await grok_lab.submit_a()
    sent_before = len(grok_lab.peer.requests)
    with pytest.raises(GrokSessionBusy):
        await asyncio.wait_for(grok_lab.adapter.read_history(grok_lab.handle_b), RPC_TIMEOUT)
    assert len(grok_lab.peer.requests) == sent_before
    assert await grok_lab.history_text(grok_lab.handle_a) == [CANARY_A, f"reply to {CANARY_A}"]
    assert (await asyncio.wait_for(grok_lab.adapter.inspect(grok_lab.handle_b), RPC_TIMEOUT)).status == "running"


async def test_resume_is_explicit_acp_resume_and_history_survives_unload(grok_lab: GrokLab) -> None:
    result = await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a)
    assert isinstance(result, Accepted)
    assert await grok_lab.adapter.unload(grok_lab.handle_a) == "unloaded"
    assert grok_lab.peer.sessions[grok_lab.handle_a.native_session_id].loaded is False
    await grok_lab.adapter.resume_session(grok_lab.handle_a)
    texts = await grok_lab.history_text(grok_lab.handle_a)
    assert texts == [CANARY_A, f"reply to {CANARY_A}"]
    methods = [name for name, _ in grok_lab.peer.requests]
    assert methods.index("session/close") < methods.index("session/resume") < len(methods)
    # Only the declared ACP operations were used: no headless or CLI resume path exists in this adapter.
    assert set(methods) <= set(GROK_METHODS.values()) | set(GROK_CLIENT_NOTIFICATIONS)


async def test_inspect_reports_running_terminal_and_request_correlation(grok_lab: GrokLab) -> None:
    await grok_lab.submit_a()
    status_b = await grok_lab.adapter.inspect(grok_lab.handle_b)
    session_b = grok_lab.handle_b.native_session_id
    assert status_b.status == "running"
    assert status_b.native_work_ref == grok_message_id(session_b, grok_lab.message_b.client_request_id)
    by_request = await grok_lab.adapter.inspect(grok_lab.handle_a, grok_lab.message_a.client_request_id)
    assert by_request.status == "completed"
    assert by_request.saved_input_available is True
    assert by_request.request_id == grok_lab.message_a.client_request_id
    unknown = await grok_lab.adapter.inspect(grok_lab.handle_a, "never-sent")
    assert unknown.saved_input_available is False
    assert unknown.native_work_ref is None
    # A replacement process on the same intact native storage never observed that prompt's answer:
    # the saved input is visible, the outcome is not.
    restarted = GrokLab()
    restarted.peer.sessions = grok_lab.peer.sessions
    after_restart = await asyncio.wait_for(
        restarted.adapter.inspect(grok_lab.handle_a, grok_lab.message_a.client_request_id), RPC_TIMEOUT
    )
    assert after_restart.status == "unknown"
    assert after_restart.saved_input_available is True


async def test_cancel_is_scoped_to_the_named_work_and_leaves_the_peer_running(grok_lab: GrokLab) -> None:
    grok_lab.peer.keep_running.add(grok_lab.handle_a.native_session_id)
    await grok_lab.submit_a()
    session_a = grok_lab.handle_a.native_session_id
    session_b = grok_lab.handle_b.native_session_id
    stale = WorkRef(native_session_id=session_a, native_work_ref="older-message")
    assert await grok_lab.adapter.cancel(grok_lab.handle_a, stale) == "unknown"
    assert grok_lab.peer.requests_for("session/cancel") == []
    work_a = WorkRef(native_session_id=session_a, native_work_ref=grok_message_id(session_a, "req-canary-a"))
    assert await grok_lab.adapter.cancel(grok_lab.handle_a, work_a) == "requested"
    await grok_lab.peer.wait_idle()
    assert grok_lab.peer.requests_for("session/cancel") == [{"sessionId": session_a}]
    assert (await grok_lab.adapter.inspect(grok_lab.handle_a, "req-canary-a")).status == "interrupted"
    assert grok_lab.peer.sessions[session_b].held is not None
    assert (await grok_lab.adapter.inspect(grok_lab.handle_b)).status == "running"
    with pytest.raises(ValueError, match="work_session_mismatch"):
        await grok_lab.adapter.cancel(grok_lab.handle_a, WorkRef(native_session_id=session_b, native_work_ref="x"))


async def test_unload_closes_only_idle_sessions_and_releases_state(grok_lab: GrokLab) -> None:
    await grok_lab.submit_a()
    session_a = grok_lab.handle_a.native_session_id
    session_b = grok_lab.handle_b.native_session_id
    with pytest.raises(GrokSessionBusy):
        await grok_lab.adapter.unload(grok_lab.handle_b)
    assert grok_lab.peer.requests_for("session/close") == []
    assert session_a in grok_lab.adapter.tracked_sessions()
    assert await grok_lab.adapter.unload(grok_lab.handle_a) == "unloaded"
    assert grok_lab.peer.requests_for("session/close") == [{"sessionId": session_a}]
    assert session_a not in grok_lab.adapter.tracked_sessions()
    assert session_b in grok_lab.adapter.tracked_sessions()
    grok_lab.peer.emit_model_request(session_a, "auxiliary")
    # A closed session keeps no state, so it is refused like any session this process has not loaded.
    assert grok_lab.relay_records[-1].refused_reason == "unknown_session"


async def test_event_stream_opened_before_unload_keeps_receiving_after_resume(grok_lab: GrokLab) -> None:
    received: list[NativeEvent] = []

    async def consume() -> None:
        async for event in grok_lab.adapter.events(grok_lab.handle_a):
            received.append(event)

    consumer = asyncio.create_task(consume())
    try:
        assert isinstance(await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a), Accepted)
        assert await grok_lab.adapter.unload(grok_lab.handle_a) == "unloaded"
        await grok_lab.adapter.resume_session(grok_lab.handle_a)
        message = SubmitMessage(conversation_id=CONV_A, client_request_id="req-a-after", message="after resume")
        assert isinstance(await grok_lab.submit(grok_lab.handle_a, message, grok_lab.authority_a), Accepted)
        await asyncio.sleep(0.05)
    finally:
        consumer.cancel()
    after = grok_message_id(grok_lab.handle_a.native_session_id, "req-a-after")
    assert any(event.native_work_ref == after and event.payload_type == "turn_completed" for event in received)


def _esp_tool_call(call_id: str, tool: str = "esp_knowledge__esp.search") -> dict[str, Any]:
    return {
        "sessionUpdate": "tool_call",
        "toolCallId": call_id,
        "title": "Search",
        "kind": "read",
        "status": "pending",
        "toolName": tool,
    }


def _live_chunk(text: str) -> dict[str, Any]:
    return {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}, "messageId": "live-m"}


def _kinds(events: list[NativeEvent]) -> list[tuple[str, object]]:
    return [(event.payload_type, event.payload.get("text") or event.payload.get("item_id")) for event in events]


async def _running_a(lab: GrokLab) -> str:
    """Session A with our prompt still in flight, its events so far drained."""
    session_a = lab.handle_a.native_session_id
    lab.peer.keep_running.add(session_a)
    await lab.submit(lab.handle_a, lab.message_a, lab.authority_a)
    await _drain(lab, lab.handle_a)
    return session_a


def _session_methods(lab: GrokLab, session_id: str) -> list[str]:
    return [name for name, params in lab.peer.requests if params.get("sessionId") == session_id]


async def test_live_output_of_a_running_prompt_survives_a_status_read(grok_lab: GrokLab) -> None:
    session_a = await _running_a(grok_lab)
    grok_lab.peer.live_updates_during_load[session_a] = [
        (_live_chunk("LIVE-DELTA"), True),
        (_esp_tool_call("live-1"), True),
    ]
    await asyncio.wait_for(grok_lab.adapter.inspect(grok_lab.handle_a), RPC_TIMEOUT)
    grok_lab.peer.flush_live_updates(session_a)
    grok_lab.peer.update(
        session_a, {"sessionUpdate": "tool_call_update", "toolCallId": "live-1", "status": "completed"}
    )
    grok_lab.peer.release(session_a)
    await grok_lab.peer.wait_idle()
    kinds = _kinds(await _drain(grok_lab, grok_lab.handle_a))
    assert ("text_delta", "LIVE-DELTA") in kinds
    assert ("tool_started", "live-1") in kinds and ("tool_finished", "live-1") in kinds
    assert all(kind != "disallowed_item" for kind, _ in kinds)
    assert grok_lab.adapter.disallowed_items == 0


async def test_disallowed_tool_use_during_a_history_read_of_a_running_prompt_is_surfaced(grok_lab: GrokLab) -> None:
    session_a = await _running_a(grok_lab)
    shell = {"sessionUpdate": "tool_call", "toolCallId": "s9", "title": "Run", "kind": "execute"}
    grok_lab.peer.live_updates_during_load[session_a] = [({**shell, "toolName": "run_terminal_command"}, True)]
    with contextlib.suppress(GrokSessionBusy):
        await asyncio.wait_for(grok_lab.adapter.read_history(grok_lab.handle_a), RPC_TIMEOUT)
    grok_lab.peer.flush_live_updates(session_a)
    grok_lab.peer.release(session_a)
    await grok_lab.peer.wait_idle()
    assert ("disallowed_item", "s9") in _kinds(await _drain(grok_lab, grok_lab.handle_a))
    assert grok_lab.adapter.disallowed_items == 1


async def test_a_live_user_echo_is_never_durable_acceptance(grok_lab: GrokLab) -> None:
    session_a = grok_lab.handle_a.native_session_id
    expected = grok_message_id(session_a, grok_lab.message_a.client_request_id)
    grok_lab.peer.keep_running.add(session_a)
    grok_lab.peer.persist_user_messages = False
    echo = {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": CANARY_A}, "messageId": expected}
    grok_lab.peer.live_updates_during_load[session_a] = [(echo, False)]
    result = await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a)
    assert result == Unconfirmed(kind="unconfirmed", native_work_ref=expected)
    assert "session/load" not in _session_methods(grok_lab, session_a)


async def test_status_and_history_never_open_a_replay_over_our_running_prompt(grok_lab: GrokLab) -> None:
    session_a = grok_lab.handle_a.native_session_id
    request_id = grok_lab.message_a.client_request_id
    expected = grok_message_id(session_a, request_id)
    grok_lab.peer.keep_running.add(session_a)
    result = await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a)
    # Still running: acceptance is not confirmed mid-turn, but the reference is the deterministic one.
    assert result == Unconfirmed(kind="unconfirmed", native_work_ref=expected)
    status = await asyncio.wait_for(grok_lab.adapter.inspect(grok_lab.handle_a), RPC_TIMEOUT)
    assert (status.status, status.native_work_ref, status.saved_input_available) == ("running", expected, False)
    by_request = await asyncio.wait_for(grok_lab.adapter.inspect(grok_lab.handle_a, request_id), RPC_TIMEOUT)
    assert (by_request.status, by_request.native_work_ref, by_request.request_id) == ("running", expected, request_id)
    assert by_request.saved_input_available is False
    with pytest.raises(GrokSessionBusy):
        await asyncio.wait_for(grok_lab.adapter.inspect(grok_lab.handle_a, "older-request"), RPC_TIMEOUT)
    with pytest.raises(GrokSessionBusy):
        await asyncio.wait_for(grok_lab.adapter.read_history(grok_lab.handle_a), RPC_TIMEOUT)
    assert "session/load" not in _session_methods(grok_lab, session_a)
    # Status reconciliation after the turn confirms the saved input from the replay.
    grok_lab.peer.release(session_a)
    await grok_lab.peer.wait_idle()
    after = await asyncio.wait_for(grok_lab.adapter.inspect(grok_lab.handle_a, request_id), RPC_TIMEOUT)
    assert (after.status, after.native_work_ref, after.saved_input_available) == ("completed", expected, True)


async def test_a_prompt_waits_for_an_outstanding_history_read_of_its_session(grok_lab: GrokLab) -> None:
    grok_lab.peer.hold_loads = True
    reading = asyncio.create_task(grok_lab.adapter.read_history(grok_lab.handle_a))
    await grok_lab.peer.wait_for_requests("session/load", 1)
    submitting = asyncio.create_task(
        grok_lab.adapter.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a)
    )
    await asyncio.sleep(0.05)
    # The prompt is not sent while a replay window of the same session is open.
    assert grok_lab.peer.requests_for("session/prompt") == []
    grok_lab.peer.hold_loads = False
    grok_lab.peer.release_loads()
    snapshot, result = await asyncio.wait_for(asyncio.gather(reading, submitting), RPC_TIMEOUT)
    assert snapshot.items == []
    assert isinstance(result, Accepted)
    await grok_lab.peer.wait_idle()
    events = await _drain(grok_lab, grok_lab.handle_a)
    assert [event.payload_type for event in events] == ["text_delta", "turn_completed", "usage"]


async def test_history_and_status_reads_leave_an_unloaded_session_unloaded(grok_lab: GrokLab) -> None:
    session_a = grok_lab.handle_a.native_session_id
    assert isinstance(await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a), Accepted)
    assert await grok_lab.adapter.unload(grok_lab.handle_a) == "unloaded"
    assert await grok_lab.history_text(grok_lab.handle_a) == [CANARY_A, f"reply to {CANARY_A}"]
    assert grok_lab.peer.sessions[session_a].loaded is False
    request_id = grok_lab.message_a.client_request_id
    status = await asyncio.wait_for(grok_lab.adapter.inspect(grok_lab.handle_a, request_id), RPC_TIMEOUT)
    assert (status.status, status.saved_input_available) == ("unknown", True)
    assert grok_lab.peer.sessions[session_a].loaded is False
    methods = _session_methods(grok_lab, session_a)
    after_unload = methods[methods.index("session/close") + 1 :]
    assert after_unload == ["session/load", "session/close", "session/load", "session/close"]
    assert session_a not in grok_lab.adapter.tracked_sessions()
    grok_lab.peer.emit_model_request(session_a, "auxiliary")
    assert grok_lab.relay_records[-1].forwarded is False
    assert grok_lab.peer.violations == []


async def test_submit_on_a_session_not_loaded_here_sends_nothing(grok_lab: GrokLab) -> None:
    assert await grok_lab.adapter.unload(grok_lab.handle_a) == "unloaded"
    sent_before = len(grok_lab.peer.requests)
    result = await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a)
    assert result == NotSubmitted(kind="not_submitted", code="session_not_loaded")
    assert len(grok_lab.peer.requests) == sent_before
    # A replacement process that never created or resumed the session has not loaded it either.
    restarted = GrokLab()
    restarted.peer.sessions = grok_lab.peer.sessions
    replaced = await asyncio.wait_for(
        restarted.adapter.submit(grok_lab.handle_b, grok_lab.message_b, grok_lab.authority_b), RPC_TIMEOUT
    )
    assert replaced == NotSubmitted(kind="not_submitted", code="session_not_loaded")
    assert restarted.peer.requests == []
    assert grok_lab.peer.violations == []


async def test_compaction_of_a_session_not_loaded_here_sends_nothing(grok_lab: GrokLab) -> None:
    assert await grok_lab.adapter.unload(grok_lab.handle_a) == "unloaded"
    sent_before = len(grok_lab.peer.requests)
    with pytest.raises(GrokSessionNotLoaded):
        await asyncio.wait_for(grok_lab.adapter.compact(grok_lab.handle_a, grok_lab.authority_a), RPC_TIMEOUT)
    assert len(grok_lab.peer.requests) == sent_before
    assert grok_lab.adapter.transport.current(grok_lab.handle_a.native_session_id) is None


async def test_resume_waits_for_a_history_read_that_reopens_an_unloaded_session(grok_lab: GrokLab) -> None:
    session_a = grok_lab.handle_a.native_session_id
    assert isinstance(await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a), Accepted)
    assert await grok_lab.adapter.unload(grok_lab.handle_a) == "unloaded"
    loads_before = len(grok_lab.peer.requests_for("session/load"))
    grok_lab.peer.hold_loads = True
    reading = asyncio.create_task(grok_lab.adapter.read_history(grok_lab.handle_a))
    await grok_lab.peer.wait_for_requests("session/load", loads_before + 1)
    resuming = asyncio.create_task(grok_lab.adapter.resume_session(grok_lab.handle_a))
    await asyncio.sleep(0.05)
    assert grok_lab.peer.requests_for("session/resume") == []
    grok_lab.peer.hold_loads = False
    grok_lab.peer.release_loads()
    await asyncio.wait_for(asyncio.gather(reading, resuming), RPC_TIMEOUT)
    assert _session_methods(grok_lab, session_a)[-3:] == ["session/load", "session/close", "session/resume"]
    assert grok_lab.peer.sessions[session_a].loaded is True
    assert session_a in grok_lab.adapter.tracked_sessions()


# A caller that stops waiting (cancellation, a bounded wait) abandons only its wait. The native request is
# still outstanding on the wire, so the session stays as closed to other work as it was while the caller
# waited, and the request's follow-up (the transient close, forgetting a closed session) still happens.


async def _read(lab: GrokLab, read: str) -> object:
    if read == "inspect":
        return await lab.adapter.inspect(lab.handle_a)
    return await lab.adapter.read_history(lab.handle_a)


async def _abandon(task: asyncio.Task[Any]) -> None:
    """Cancel the caller's wait, which must end at once even though the native request is held."""
    task.cancel()
    await asyncio.wait({task}, timeout=RPC_TIMEOUT)
    assert task.cancelled()


async def _until(condition: Callable[[], bool]) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + RPC_TIMEOUT
    while not condition():
        if loop.time() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.005)


@pytest.mark.parametrize("read", ["read_history", "inspect"])
async def test_a_cancelled_read_keeps_prompts_off_its_session_until_the_build_answers_the_load(
    grok_lab: GrokLab, read: str
) -> None:
    session_a = grok_lab.handle_a.native_session_id
    shell = {"sessionUpdate": "tool_call", "toolCallId": "s1", "title": "Run", "kind": "execute"}
    grok_lab.peer.updates_during_next_prompt = [{**shell, "toolName": "run_terminal_command"}]
    assert isinstance(await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a), Accepted)
    await _drain(grok_lab, grok_lab.handle_a)
    refused = grok_lab.adapter.disallowed_items
    assert refused == 1
    prompts = len(grok_lab.peer.requests_for("session/prompt"))
    grok_lab.peer.hold_loads = True
    reading = asyncio.create_task(_read(grok_lab, read))
    await grok_lab.peer.wait_for_requests("session/load", len(grok_lab.peer.requests_for("session/load")) + 1)
    await _abandon(reading)
    grok_lab.peer.keep_running.add(session_a)
    second = SubmitMessage(conversation_id=CONV_A, client_request_id="req-a-2", message="second question")
    submitting = asyncio.create_task(grok_lab.adapter.submit(grok_lab.handle_a, second, grok_lab.authority_a))
    await asyncio.sleep(0.05)
    # The abandoned load is still outstanding, so its replay window is still open: no prompt starts.
    assert len(grok_lab.peer.requests_for("session/prompt")) == prompts
    grok_lab.peer.hold_loads = False
    grok_lab.peer.release_loads()
    result = await asyncio.wait_for(submitting, RPC_TIMEOUT)
    assert result == Unconfirmed(kind="unconfirmed", native_work_ref=grok_message_id(session_a, "req-a-2"))
    await grok_lab.peer.wait_idle()
    # The abandoned replay (old reply, old shell call) never reaches the new prompt's stream or its counts.
    assert _kinds(await _drain(grok_lab, grok_lab.handle_a)) == [("text_delta", "reply to second question")]
    assert grok_lab.adapter.disallowed_items == refused
    assert _session_methods(grok_lab, session_a)[-2:] == ["session/load", "session/prompt"]
    grok_lab.peer.release(session_a)
    await grok_lab.peer.wait_idle()
    assert grok_lab.peer.violations == []


async def test_a_cancelled_read_of_an_unloaded_session_still_closes_it(grok_lab: GrokLab) -> None:
    session_a = grok_lab.handle_a.native_session_id
    assert isinstance(await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a), Accepted)
    assert await grok_lab.adapter.unload(grok_lab.handle_a) == "unloaded"
    grok_lab.peer.hold_loads = True
    reading = asyncio.create_task(grok_lab.adapter.read_history(grok_lab.handle_a))
    await grok_lab.peer.wait_for_requests("session/load", len(grok_lab.peer.requests_for("session/load")) + 1)
    await _abandon(reading)
    grok_lab.peer.hold_loads = False
    grok_lab.peer.release_loads()
    await _until(lambda: session_a not in grok_lab.adapter.tracked_sessions())
    await grok_lab.peer.wait_idle()
    # The read stayed residency-neutral although nobody waited for it.
    assert grok_lab.peer.sessions[session_a].loaded is False
    methods = _session_methods(grok_lab, session_a)
    assert methods[methods.index("session/close") + 1 :] == ["session/load", "session/close"]
    assert grok_lab.peer.violations == []


async def test_a_cancelled_unload_finishes_before_its_session_is_used_again(grok_lab: GrokLab) -> None:
    session_a = grok_lab.handle_a.native_session_id
    grok_lab.peer.hold_closes = True
    unloading = asyncio.create_task(grok_lab.adapter.unload(grok_lab.handle_a))
    await grok_lab.peer.wait_for_requests("session/close", 1)
    await _abandon(unloading)
    submitting = asyncio.create_task(
        grok_lab.adapter.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a)
    )
    await asyncio.sleep(0.05)
    # The close is still outstanding: nothing else is sent to the session until the build answers it.
    assert grok_lab.peer.requests_for("session/prompt") == []
    grok_lab.peer.hold_closes = False
    grok_lab.peer.release_closes()
    # Once the build closed the session, the adapter has forgotten it too.
    result = await asyncio.wait_for(submitting, RPC_TIMEOUT)
    assert result == NotSubmitted(kind="not_submitted", code="session_not_loaded")
    assert grok_lab.peer.requests_for("session/prompt") == []
    assert grok_lab.peer.sessions[session_a].loaded is False
    assert session_a not in grok_lab.adapter.tracked_sessions()
    assert grok_lab.peer.violations == []


async def test_a_cancelled_resume_is_tracked_once_the_build_answers(grok_lab: GrokLab) -> None:
    session_a = grok_lab.handle_a.native_session_id
    assert await grok_lab.adapter.unload(grok_lab.handle_a) == "unloaded"
    grok_lab.peer.hold_resumes = True
    resuming = asyncio.create_task(grok_lab.adapter.resume_session(grok_lab.handle_a))
    await grok_lab.peer.wait_for_requests("session/resume", 1)
    await _abandon(resuming)
    loads = len(grok_lab.peer.requests_for("session/load"))
    reading = asyncio.create_task(grok_lab.adapter.read_history(grok_lab.handle_a))
    await asyncio.sleep(0.05)
    # A read waits for the outstanding resume instead of loading, and transiently closing, the session.
    assert len(grok_lab.peer.requests_for("session/load")) == loads
    grok_lab.peer.hold_resumes = False
    grok_lab.peer.release_resumes()
    await asyncio.wait_for(reading, RPC_TIMEOUT)
    # The build resumed the session, so the adapter tracks it as loaded and the read left it resident.
    assert _session_methods(grok_lab, session_a)[-2:] == ["session/resume", "session/load"]
    assert grok_lab.peer.sessions[session_a].loaded is True
    assert session_a in grok_lab.adapter.tracked_sessions()
    assert isinstance(await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a), Accepted)
    assert grok_lab.peer.violations == []


async def test_unload_drops_events_nobody_reads(grok_lab: GrokLab) -> None:
    session_a = grok_lab.handle_a.native_session_id
    assert isinstance(await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a), Accepted)
    assert await grok_lab.adapter.unload(grok_lab.handle_a) == "unloaded"
    assert session_a not in grok_lab.adapter.tracked_sessions()
    await grok_lab.adapter.resume_session(grok_lab.handle_a)
    assert await _drain(grok_lab, grok_lab.handle_a) == []


async def test_an_open_event_stream_is_tracked_state_until_it_closes(grok_lab: GrokLab) -> None:
    session_a = grok_lab.handle_a.native_session_id
    received: list[NativeEvent] = []

    async def consume() -> None:
        async for event in grok_lab.adapter.events(grok_lab.handle_a):
            received.append(event)

    consumer = asyncio.create_task(consume())
    assert isinstance(await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a), Accepted)
    assert await grok_lab.adapter.unload(grok_lab.handle_a) == "unloaded"
    # The open stream keeps its queue, and that queue is state this adapter reports.
    assert session_a in grok_lab.adapter.tracked_sessions()
    consumer.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await consumer
    assert session_a not in grok_lab.adapter.tracked_sessions()
    assert [event.payload_type for event in received] == ["text_delta", "turn_completed", "usage"]


async def test_compaction_output_is_not_public_and_the_command_is_not_history(grok_lab: GrokLab) -> None:
    assert isinstance(await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a), Accepted)
    await _drain(grok_lab, grok_lab.handle_a)
    grok_lab.peer.compaction_output = "COMPACTION-SUMMARY"
    grok_lab.peer.persist_compaction_command = True
    assert await asyncio.wait_for(grok_lab.adapter.compact(grok_lab.handle_a, grok_lab.authority_a), RPC_TIMEOUT) == (
        "completed"
    )
    await grok_lab.peer.wait_idle()
    events = await _drain(grok_lab, grok_lab.handle_a)
    assert [event.payload_type for event in events] == ["compaction", "usage"]
    assert await grok_lab.history_text(grok_lab.handle_a) == [CANARY_A, f"reply to {CANARY_A}"]


async def test_export_and_delete_are_unsupported_without_guessing_a_method(grok_lab: GrokLab) -> None:
    sent_before = len(grok_lab.peer.requests)
    with pytest.raises(UnsupportedPrimitive) as export:
        await grok_lab.adapter.export_history(grok_lab.handle_a)
    assert export.value.primitive == "export"
    with pytest.raises(UnsupportedPrimitive) as delete:
        await grok_lab.adapter.delete_history(grok_lab.handle_a)
    assert delete.value.primitive == "delete"
    assert len(grok_lab.peer.requests) == sent_before


# Request-scoped model and MCP attribution ---------------------------------------------------


async def test_model_requests_are_attributed_by_session_header_to_the_in_flight_prompt(grok_lab: GrokLab) -> None:
    await grok_lab.submit_a()
    turns = grok_lab.forwarded("turn")
    assert len(turns) == 2
    session_a = grok_lab.handle_a.native_session_id
    session_b = grok_lab.handle_b.native_session_id
    by_session = {record.attributed_session: record for record in turns}
    assert by_session[session_a].token == "inf-A"
    assert by_session[session_a].attributed_work == grok_message_id(session_a, "req-canary-a")
    assert by_session[session_b].token == "inf-B"
    assert by_session[session_b].attributed_work == grok_message_id(session_b, "req-canary-b")
    assert grok_lab.adapter.transport.attributed_model_starts() == 2


async def test_token_refresh_applies_to_the_in_flight_operation(grok_lab: GrokLab) -> None:
    await grok_lab.submit_a()
    session_b = grok_lab.handle_b.native_session_id
    grok_lab.adapter.transport.refresh_tokens(session_b, "inf-B-refreshed", "know-B-refreshed")
    grok_lab.peer.emit_model_request(session_b, "turn")
    assert grok_lab.relay_records[-1].token == "inf-B-refreshed"
    grok_lab.peer.emit_mcp_call(session_b, "esp_knowledge__esp.search")
    assert grok_lab.mcp_records[-1].token == "know-B-refreshed"


async def test_manual_compaction_uses_the_declared_command_and_binds_the_scope(grok_lab: GrokLab) -> None:
    await grok_lab.submit_a()
    assert await grok_lab.compaction_requests_without_scope() == 0
    # Positive captured-inference assertion: manual and automatic compaction produced attributed requests.
    assert grok_lab.compaction_requests_forwarded >= 3
    commands = [p for p in grok_lab.peer.requests_for("session/prompt") if p["prompt"][0]["text"] == "/compact"]
    assert len(commands) == 1
    assert commands[0]["sessionId"] == grok_lab.handle_a.native_session_id
    assert GROK_COMPACT_COMMAND == "/compact"
    assert grok_lab.adapter.transport.current(grok_lab.handle_a.native_session_id) is None


async def test_compaction_on_a_busy_session_is_refused_without_sending(grok_lab: GrokLab) -> None:
    await grok_lab.submit_a()
    sent_before = len(grok_lab.peer.requests_for("session/prompt"))
    with pytest.raises(GrokSessionBusy):
        await grok_lab.adapter.compact(grok_lab.handle_b, grok_lab.authority_b)
    assert len(grok_lab.peer.requests_for("session/prompt")) == sent_before


async def test_unbound_unlabelled_or_malformed_model_requests_are_refused(grok_lab: GrokLab) -> None:
    await grok_lab.submit_a()
    session_a = grok_lab.handle_a.native_session_id
    session_b = grok_lab.handle_b.native_session_id
    refused_before = grok_lab.adapter.transport.unattributed_starts
    cases: list[tuple[str, dict[str, Any]]] = [
        ("unbound_session", {"session_id": session_a}),
        ("missing_session_header", {"session_id": session_b, "session_header": False}),
        ("model_not_pinned", {"session_id": session_b, "model": AUXILIARY_MODEL}),
        ("invalid_body", {"session_id": session_b, "body": b'{"model":"a","model":"b"}'}),
        ("invalid_body", {"session_id": session_b, "body": b'{"model": NaN}'}),
        ("oversize", {"session_id": session_b, "body": b" " * (MAX_MODEL_REQUEST_BYTES + 1)}),
        ("unknown_session", {"session_id": "not-a-session"}),
    ]
    for reason, kwargs in cases:
        session_id = cast(str, kwargs.pop("session_id"))
        if session_id == "not-a-session":
            with pytest.raises(UnattributedCall, match=reason):
                grok_lab.adapter.attribute_model_request(
                    {GROK_SESSION_HEADER: session_id}, json.dumps({"model": LAB_MODEL}).encode()
                )
            continue
        grok_lab.peer.emit_model_request(session_id, "auxiliary", **kwargs)
        assert grok_lab.relay_records[-1].forwarded is False
        assert grok_lab.relay_records[-1].refused_reason == reason
    assert grok_lab.adapter.transport.unattributed_starts - refused_before == len(cases)


async def test_mcp_requests_are_attributed_by_the_documented_session_header(grok_lab: GrokLab) -> None:
    grok_lab.peer.mcp_calls_during_next_prompt = ["esp_knowledge__esp.search"]
    await grok_lab.submit_a()
    assert len(grok_lab.mcp_records) == 1
    record = grok_lab.mcp_records[0]
    session_a = grok_lab.handle_a.native_session_id
    assert record.forwarded is True
    assert record.token == "know-A"
    assert record.attributed_session == session_a
    assert record.attributed_work == grok_message_id(session_a, "req-canary-a")
    grok_lab.peer.emit_mcp_call(session_a, "esp_knowledge__esp.search")
    assert grok_lab.mcp_records[-1].refused_reason == "unbound_session"
    grok_lab.peer.emit_mcp_call(grok_lab.handle_b.native_session_id, "esp_knowledge__esp.search", session_header=False)
    assert grok_lab.mcp_records[-1].refused_reason == "missing_session_header"
    assert grok_lab.adapter.transport.attributed_tool_starts() == 1


# Events -------------------------------------------------------------------------------------


async def _drain(lab: GrokLab, handle: SessionHandle) -> list[NativeEvent]:
    seen: list[NativeEvent] = []

    async def one() -> NativeEvent:
        async for event in lab.adapter.events(handle):
            return event
        raise AssertionError("event stream ended")

    while True:
        try:
            seen.append(await asyncio.wait_for(one(), 0.05))
        except TimeoutError:
            return seen


async def test_events_carry_explicit_session_identity_and_operation_scope(grok_lab: GrokLab) -> None:
    await grok_lab.submit_a()
    events_a = await _drain(grok_lab, grok_lab.handle_a)
    session_a = grok_lab.handle_a.native_session_id
    work_a = grok_message_id(session_a, "req-canary-a")
    assert [event.payload_type for event in events_a] == ["text_delta", "turn_completed", "usage"]
    assert all(event.native_session_id == session_a and event.native_work_ref == work_a for event in events_a)
    assert all(event.provider_session_id == PROV_A and event.ownership_epoch == EPOCH for event in events_a)
    assert events_a[0].payload["text"] == f"reply to {CANARY_A}"
    assert events_a[1].payload == {"status": "completed", "stop_reason": "end_turn"}
    assert events_a[2].payload == {"input_tokens": 12, "output_tokens": 5, "cached_input_tokens": 2}
    events_b = await _drain(grok_lab, grok_lab.handle_b)
    assert [event.payload_type for event in events_b] == ["text_delta"]
    assert all(CANARY_A not in json.dumps(event.payload) for event in events_b)


async def test_late_events_keep_the_epoch_of_the_operation_that_produced_them(grok_lab: GrokLab) -> None:
    session_a = grok_lab.handle_a.native_session_id
    grok_lab.peer.keep_running.add(session_a)
    first = await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a)
    assert isinstance(first, Unconfirmed) and first.native_work_ref is not None
    grok_lab.peer.update(session_a, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "x"}})
    grok_lab.peer.release(session_a)
    await grok_lab.peer.wait_idle()
    replacement = grok_lab.handle_a.model_copy(update={"ownership_epoch": EPOCH + 1})
    authority = OperationAuthority(inference_token="inf-A2", knowledge_token="know-A2")
    message = SubmitMessage(conversation_id=CONV_A, client_request_id="req-a-next", message="next question")
    second = await grok_lab.submit(replacement, message, authority)
    assert isinstance(second, Accepted)
    events = await _drain(grok_lab, grok_lab.handle_a)
    epochs = {event.native_work_ref: event.ownership_epoch for event in events}
    assert epochs[first.native_work_ref] == EPOCH
    assert epochs[second.work.native_work_ref] == EPOCH + 1


async def test_updates_without_an_in_flight_operation_are_rejected_and_counted(grok_lab: GrokLab) -> None:
    await grok_lab.submit_a()
    await _drain(grok_lab, grok_lab.handle_a)
    rejected_before = grok_lab.adapter.rejected_events
    grok_lab.peer.start_background_turn(grok_lab.handle_a.native_session_id)
    grok_lab.peer.notify("session/update", {"update": {"sessionUpdate": "agent_message_chunk"}})
    await grok_lab.peer.wait_idle()
    assert await _drain(grok_lab, grok_lab.handle_a) == []
    assert grok_lab.adapter.rejected_events - rejected_before == 2
    assert grok_lab.adapter.unbound_updates == 1


def _context(session_id: str = "session-a", work_ref: str | None = "msg-a") -> OperationContext:
    return OperationContext(
        native_session_id=session_id,
        native_work_ref=work_ref,
        provider_session_id=PROV_A,
        session_generation=1,
        active_agent_run_id="33333333-3333-4333-8333-333333333331",
        ownership_epoch=EPOCH,
        runtime_incarnation_id="55555555-5555-4555-8555-555555555551",
        inference_token="inf-A",
        knowledge_token="know-A",
    )


def _update(update: dict[str, Any], session_id: str = "session-a") -> dict[str, Any]:
    return {"sessionId": session_id, "update": update}


def test_normalize_maps_updates_and_hides_reasoning() -> None:
    context = _context()
    tools: dict[str, str] = {}
    text = normalize_grok_update(
        _update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}, "messageId": "m"}),
        context,
        tools,
    )
    assert text is not None and text.payload_type == "text_delta" and text.payload == {"text": "hi", "message_id": "m"}
    assert text.native_work_ref == "msg-a"
    for hidden in ("agent_thought_chunk", "plan", "user_message_chunk", "available_commands_update", "usage_update"):
        secret = {"sessionUpdate": hidden, "content": {"type": "text", "text": "secret"}, "messageId": "m"}
        assert normalize_grok_update(_update(secret), context, tools) is None
    with pytest.raises(GrokEventRejected, match="missing_native_identity"):
        normalize_grok_update({"update": {"sessionUpdate": "agent_message_chunk"}}, context, tools)
    with pytest.raises(GrokEventRejected, match="unbound_session"):
        normalize_grok_update(_update({"sessionUpdate": "agent_message_chunk"}, "session-b"), context, tools)
    with pytest.raises(GrokEventRejected, match="unbound_session"):
        normalize_grok_update(_update({"sessionUpdate": "agent_message_chunk"}), None, tools)
    with pytest.raises(GrokEventRejected, match="missing_work_ref"):
        normalize_grok_update(_update({"sessionUpdate": "agent_message_chunk"}), _context(work_ref=None), tools)
    started = normalize_grok_update(
        _update(
            {
                "sessionUpdate": "tool_call",
                "toolCallId": "c1",
                "title": "Search",
                "toolName": "esp_knowledge__esp.search",
            }
        ),
        context,
        tools,
    )
    assert started is not None and started.payload == {"tool": "esp.search", "item_id": "c1"}
    finished = normalize_grok_update(
        _update({"sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed"}), context, tools
    )
    assert finished is not None and finished.payload_type == "tool_finished"
    assert finished.payload == {"tool": "esp.search", "item_id": "c1", "status": "completed"}
    events = terminal_events(context, {"stopReason": "cancelled"})
    assert [(event.payload_type, event.payload) for event in events] == [
        ("turn_completed", {"status": "interrupted", "stop_reason": "cancelled"})
    ]
    refusal = terminal_events(context, {"stopReason": "refusal", "usage": {"inputTokens": True}})
    assert refusal[0].payload == {"status": "failed", "stop_reason": "refusal"}
    assert refusal[1].payload == {"input_tokens": None, "output_tokens": None, "cached_input_tokens": None}


def test_tool_identity_is_the_structured_name_never_the_display_title() -> None:
    context = _context()
    tools: dict[str, str] = {}
    titled = normalize_grok_update(
        _update(
            {"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "esp_knowledge__esp.search", "kind": "read"}
        ),
        context,
        tools,
    )
    assert titled is not None and titled.payload_type == "disallowed_item"
    named = normalize_grok_update(_update(_esp_tool_call("t2")), context, tools)
    assert named is not None and named.payload == {"tool": "esp.search", "item_id": "t2"}
    meta_named = {
        "sessionUpdate": "tool_call",
        "toolCallId": "t3",
        "title": "Claim",
        "kind": "read",
        "_meta": {"x.ai/tool": {"name": "esp_knowledge__esp.get_claim"}},
    }
    meta = normalize_grok_update(_update(meta_named), context, tools)
    assert meta is not None and meta.payload == {"tool": "esp.get_claim", "item_id": "t3"}
    assert tools == {"t2": "esp.search", "t3": "esp.get_claim"}


def test_esp_tool_names_mirror_the_knowledge_service() -> None:
    assert tuple(ESP_KNOWLEDGE_TOOLS) == get_args(EspToolName)
    assert ESP_KNOWLEDGE_SERVER == "esp_knowledge"


async def test_disallowed_tool_calls_and_model_drift_are_surfaced_and_counted(grok_lab: GrokLab) -> None:
    grok_lab.peer.keep_running.add(grok_lab.handle_a.native_session_id)
    grok_lab.peer.updates_during_next_prompt = [
        {
            "sessionUpdate": "tool_call",
            "toolCallId": "s1",
            "title": "Run",
            "kind": "execute",
            "toolName": "run_terminal_command",
        },
        {
            "sessionUpdate": "tool_call",
            "toolCallId": "u1",
            "title": "Use tool",
            "kind": "other",
            "toolName": "use_tool",
        },
        _esp_tool_call("e1", "esp_knowledge__esp.get_claim"),
        {
            "sessionUpdate": "tool_call",
            "toolCallId": "x1",
            "title": "Write",
            "kind": "edit",
            "toolName": "esp_knowledge__write",
        },
        {
            "sessionUpdate": "config_option_update",
            "configOptions": [{"id": "model", "currentValue": "grok-4.6", "options": []}],
        },
    ]
    assert isinstance(await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a), Unconfirmed)
    events = await _drain(grok_lab, grok_lab.handle_a)
    kinds = [(event.payload_type, event.payload.get("item_id")) for event in events]
    assert ("disallowed_item", "s1") in kinds
    assert ("disallowed_item", "u1") in kinds
    assert ("disallowed_item", "x1") in kinds
    assert ("tool_started", "e1") in kinds
    assert grok_lab.adapter.disallowed_items == 3
    drift = [event for event in events if event.payload_type == "model_rerouted"]
    assert len(drift) == 1 and drift[0].payload["to_model"] == "grok-4.6"
    assert grok_lab.adapter.model_reroutes == 1


# Tool disablement on both sides ----------------------------------------------------------------


async def test_client_guard_refuses_agent_requests_for_files_terminals_and_permissions(grok_lab: GrokLab) -> None:
    grok_lab.peer.agent_requests_during_next_prompt = [
        ("fs/read_text_file", {"path": "/etc/passwd"}),
        ("fs/write_text_file", {"path": "/tmp/x", "content": "x"}),
        ("terminal/create", {"command": "sh"}),
        (
            "session/request_permission",
            {
                "toolCall": {"toolCallId": "t1"},
                "options": [
                    {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "deny", "name": "Deny", "kind": "reject_once"},
                ],
            },
        ),
        ("session/request_permission", {"toolCall": {"toolCallId": "t2"}, "options": []}),
    ]
    assert isinstance(await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a), Accepted)
    responses = {response["id"]: response for response in grok_lab.peer.agent_request_responses}
    assert len(responses) == 5
    for request_id in ("agent-1", "agent-2", "agent-3", "agent-5"):
        assert responses[request_id]["error"]["code"] == -32601
        assert "result" not in responses[request_id]
    assert responses["agent-4"]["result"] == {"outcome": {"outcome": "selected", "optionId": "deny"}}
    assert grok_lab.guard.refused == [
        "fs/read_text_file",
        "fs/write_text_file",
        "terminal/create",
        "session/request_permission",
        "session/request_permission",
    ]


def test_runtime_config_disables_server_tools_auxiliary_work_and_static_identity() -> None:
    config = tomllib.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    models = config["models"]
    assert models["default"] == GROK_MODEL_CATALOG_KEY
    model = config["model"][GROK_MODEL_CATALOG_KEY]
    assert model["api_backend"] == "chat_completions"
    assert model["base_url"].startswith("http://127.0.0.1:")
    for static_identity in ("api_key", "env_key", "extra_headers", "env_http_headers", "auth_provider", "query_params"):
        assert static_identity not in model
        assert static_identity not in models
    for slot in ("session_summary", "prompt_suggestion", "image_description", "web_search"):
        assert models[slot] == AUXILIARY_MODEL
    assert set(models["disabled_models"]) >= {"grok-4.6", "grok-4.5"}
    assert config["ui"]["permission_mode"] == "dontAsk"
    assert config["ui"]["prompt_suggestions"] is False
    assert config["permission"]["allow"] == [f"MCPTool({ESP_KNOWLEDGE_SERVER}__*)"]
    for denied in ("Bash", "Read", "Edit", "Write", "Grep", "Glob", "WebSearch", "WebFetch", "Task"):
        assert denied in config["permission"]["deny"]
    assert not any(rule.startswith("MCPTool") for rule in config["permission"]["deny"])
    assert config["disable_web_search"] is True
    assert config["subagents"]["enabled"] is False
    assert config["sandbox"]["profile"] == "strict"
    assert config["storage"]["cleanup_ttl_days"] == 0
    features = config["features"]
    for feature in (
        "session_recap",
        "turn_summary",
        "title_refresh",
        "auto_wake",
        "voice_mode",
        "cancel_rewind",
        "remote_fetch",
        "backend_tools",
        "web_fetch",
        "write_file",
        "image_gen",
        "video_gen",
        "codebase_indexing",
    ):
        assert features[feature] is False
    assert features["telemetry"] == "off"
    assert config["memory"]["enabled"] is False
    assert config["memory_v2"]["enabled"] is False
    assert config["cli"]["auto_update"] is False
    assert config["cli"]["use_leader"] is False
    assert list(config["mcp_servers"]) == [ESP_KNOWLEDGE_SERVER]
    server = config["mcp_servers"][ESP_KNOWLEDGE_SERVER]
    assert server["url"].startswith("http://127.0.0.1:")
    assert server["headers"] == {GROK_MCP_SESSION_HEADER: "{{session_id}}"}
    for vendor in ("claude", "cursor"):
        assert all(value is False for value in config["compat"][vendor].values())


async def test_stdio_transport_frames_bounds_and_write_uncertainty() -> None:
    reader = asyncio.StreamReader(limit=FRAME_LIMIT_BYTES + 2)
    writer = _FakeWriter()
    transport = GrokStdioTransport(reader, writer)
    await transport.send_frame(b'{"id":"1"}')
    assert writer.written == [b'{"id":"1"}\n']
    with pytest.raises(ValueError, match="newline"):
        await transport.send_frame(b'{"a":\n1}')
    reader.feed_data(b'{"id":"1","result":{}}\n')
    assert await transport.recv_frame() == b'{"id":"1","result":{}}'
    reader.feed_data(b"x" * (FRAME_LIMIT_BYTES + 1) + b"\n")
    with pytest.raises(FrameTooLarge):
        await transport.recv_frame()
    reader.feed_eof()
    assert await transport.recv_frame() == b""
    with pytest.raises(ConnectionError):
        await GrokStdioTransport(asyncio.StreamReader(), _FakeWriter(closing=True)).send_frame(b"{}")
    uncertain = GrokStdioTransport(asyncio.StreamReader(), _FakeWriter(drain_error=BrokenPipeError()))
    with pytest.raises(ResponseLost):
        await uncertain.send_frame(b"{}")


class _FakeWriter:
    def __init__(self, *, closing: bool = False, drain_error: BaseException | None = None) -> None:
        self.written: list[bytes] = []
        self._closing = closing
        self._drain_error = drain_error

    def is_closing(self) -> bool:
        return self._closing

    def write(self, data: bytes) -> None:
        self.written.append(data)

    async def drain(self) -> None:
        if self._drain_error is not None:
            raise self._drain_error


class _NeverPeer:
    async def send_frame(self, payload: bytes) -> None:
        raise AssertionError("no frame expected")

    async def recv_frame(self) -> bytes:
        await asyncio.Event().wait()
        return b""


# Frozen capture, profile configuration and G0 inventory ---------------------------------------


def test_protocol_capture_freezes_the_exact_build_and_operation_mapping() -> None:
    capture = load_capture()
    assert capture["harness_build"] == GROK_BUILD
    static = capture["static"]
    assert static["version"] == GROK_VERSION
    assert static["native_binary"]["sha256"] == GROK_NATIVE_SHA256
    assert capture["esp_operation_mapping"] == dict(GROK_METHODS)
    acp = capture["acp_v1"]
    assert set(GROK_METHODS.values()) <= set(acp["client_requests"])
    assert acp["client_notifications"] == list(GROK_CLIENT_NOTIFICATIONS)
    assert "messageId" in acp["shapes"]["session/prompt"]["params"]["properties"]
    assert "userMessageId" in acp["shapes"]["session/prompt"]["result"]["properties"]
    initialize = capture["acp_initialize"]
    assert initialize["protocolVersion"] == ACP_PROTOCOL_VERSION
    assert initialize["agentCapabilities"]["loadSession"] is True
    assert set(initialize["agentCapabilities"]["sessionCapabilities"]) >= {"resume", "close"}
    markers = static["markers"]
    for marker in (GROK_SESSION_HEADER, "messageId", "userMessageId", "{{session_id}}", "struct PromptRequest"):
        assert markers[marker] is True
    text = CAPTURE_PATH.read_text(encoding="utf-8")
    for withheld in ("hostname", "currentWorkingDirectory", "agentInstanceId", "agentId"):
        assert withheld in initialize["withheld_meta_keys"]
    assert "/home/" not in text and "ibmko" not in text


def test_candidate_manifest_records_digests_and_stays_pending() -> None:
    candidate = json.loads(CANDIDATE_PATH.read_text(encoding="utf-8"))
    schema = json.loads((ROOT / "docs" / "qualification" / "manifest.schema.json").read_text(encoding="utf-8"))
    assert set(candidate) <= set(schema["properties"])
    assert candidate["status"] == "pending"
    assert candidate["harness_build"] == GROK_BUILD
    config_digest = hashlib.sha256(CONFIG_PATH.read_bytes()).hexdigest()
    assert candidate["configuration_digest"] == f"sha256:{config_digest}"
    assert hashlib.sha256(CAPTURE_PATH.read_bytes()).hexdigest() in candidate["notes"]
    for field in ("validated_resident_session_limit", "validated_active_turn_limit", "review_owner", "reviewed_at"):
        assert candidate[field] is None
    assert candidate["evidence_bundle_ref"] is None
    assert "not a validated Grok Build record" in candidate["notes"]
    assert "headless" in candidate["notes"]
    # Provenance precision: the digest names a file no agent start has loaded, and the handshake is transcribed.
    assert "a file the build has not loaded" in candidate["notes"]
    assert "manual transcription" in candidate["notes"]
    assert "inspect --provider xai --acp-handshake --write-protocol-capture" in candidate["notes"]
    readme = (ROOT / "providers" / "xai" / "integration" / "README.md").read_text(encoding="utf-8")
    assert "a file the build has not loaded" in readme
    assert "manual transcription" in readme


def _observation(static: dict[str, Any] | None = None, **overrides: object) -> GrokObservation:
    frozen = load_capture()
    live = copy.deepcopy(frozen["static"]) if static is None else static
    values: dict[str, Any] = {
        "binary_found": True,
        "version": GROK_VERSION,
        "binary_sha256": GROK_NATIVE_SHA256,
        "static_capture": live,
        "frozen_capture": frozen,
        "config_digest": "0" * 64,
        "network_isolated": True,
    }
    values.update(overrides)
    return GrokObservation(**values)


def test_exact_build_identity_agrees_across_capture_manifest_inspect_and_factory() -> None:
    candidate = json.loads(CANDIDATE_PATH.read_text(encoding="utf-8"))
    assert GROK_BUILD == grok_build_id(GROK_VERSION, GROK_NATIVE_SHA256)
    assert load_capture()["harness_build"] == GROK_BUILD
    assert candidate["harness_build"] == GROK_BUILD
    assert _observation().harness_build == GROK_BUILD


def test_declarations_never_prove_a_primitive() -> None:
    report = grok_capability_report(_observation())
    assert [item.name for item in report.primitives] == list(REQUIRED_PRIMITIVES)
    assert all(item.state == "unproven" for item in report.primitives)
    assert all(item.evidence_ref is None for item in report.primitives)
    assert essential_absences(report) == []
    notes = "\n".join(report.notes)
    assert "matches the frozen capture" in notes
    assert GROK_SESSION_HEADER in notes
    assert "No inference was performed" in notes
    assert "no recorded agent start has loaded this exact file" in notes


def test_static_drift_is_pending_until_recaptured() -> None:
    static = copy.deepcopy(load_capture()["static"])
    static["markers"]["session/close"] = False
    initialize = sanitize_grok_initialize(_initialize_without("close"), [])
    report = grok_capability_report(_observation(static, acp_initialize=initialize))
    assert all(item.state == "unproven" for item in report.primitives)
    assert any("recapture" in note for note in report.notes)


def test_exact_build_lacking_a_declared_capability_is_demonstrated_absence() -> None:
    initialize = sanitize_grok_initialize(_initialize_without("close"), [])
    report = grok_capability_report(_observation(acp_initialize=initialize))
    states = {item.name: item.state for item in report.primitives}
    assert states["unload"] == "absent"
    assert states["status"] == "unproven"
    assert states["compaction"] == "unproven"
    assert essential_absences(report) == ["unload"]
    assert set(GROK_DECLARED_PRIMITIVES) >= {"create", "resume", "unload", "history", "acceptance", "cancel"}


def _initialize_without(capability: str) -> dict[str, Any]:
    initialize = copy.deepcopy(load_capture()["acp_initialize"])
    result: dict[str, Any] = {
        "protocolVersion": initialize["protocolVersion"],
        "agentCapabilities": initialize["agentCapabilities"],
        "authMethods": [{"id": method} for method in initialize["authMethodIds"]],
        "_meta": {**initialize["meta"], **LAB_HOST_META},
    }
    del result["agentCapabilities"]["sessionCapabilities"][capability]
    return result


def test_handshake_extract_withholds_host_identifying_fields() -> None:
    initialize = sanitize_grok_initialize(_initialize_without("list"), ["_x.ai/mcp/servers_updated"])
    text = json.dumps(initialize)
    for value in LAB_HOST_META.values():
        assert str(value) not in text
    assert set(initialize["withheld_meta_keys"]) == set(LAB_HOST_META)
    assert initialize["notifications"] == ["_x.ai/mcp/servers_updated"]


def test_discovery_without_network_isolation_does_not_execute_the_build(tmp_path: Path) -> None:
    executed: list[list[str]] = []
    fake = tmp_path / "grok"
    fake.write_bytes(b"\x7fELF not really")

    def runner(argv: list[str], env: dict[str, str], cwd: Path) -> str:
        executed.append(argv)
        return ""

    observation = observe_grok(which=lambda _name: str(fake), isolation=lambda: None, runner=runner)
    assert executed == []
    assert observation.network_isolated is False
    assert any("network" in error for error in observation.errors)
    report = grok_capability_report(observation)
    assert all(item.state == "unproven" for item in report.primitives)


def test_discovery_errors_are_reported_as_pending(tmp_path: Path) -> None:
    corrupt = tmp_path / "protocol-capabilities.json"
    corrupt.write_text("{not json", encoding="utf-8")
    not_a_binary = tmp_path / "grok"
    not_a_binary.mkdir()
    observation = observe_grok(
        capture_path=corrupt,
        which=lambda _name: str(not_a_binary),
        isolation=lambda: ["unshare", "-rn"],
        runner=lambda argv, env, cwd: "",
    )
    assert any("capture unreadable" in error for error in observation.errors)
    assert any("digest failed" in error for error in observation.errors)
    assert all(item.state == "unproven" for item in grok_capability_report(observation).primitives)


def test_discovery_runs_only_version_and_help_inside_the_isolation(tmp_path: Path) -> None:
    calls: list[tuple[list[str], dict[str, str]]] = []
    native = tmp_path / "grok-1.0.46-linux-x86_64"
    native.write_bytes(b"session/new\x00x-grok-session-id\x00messageId")
    link = tmp_path / "grok"
    link.symlink_to(native)

    def runner(argv: list[str], env: dict[str, str], cwd: Path) -> str:
        calls.append((argv, env))
        if argv[-1] == "--version":
            return f"{GROK_VERSION}\n"
        return "Commands:\n  stdio  Run the agent over stdio\n\nOptions:\n"

    observation = observe_grok(which=lambda _name: str(link), isolation=lambda: ["unshare", "-rn"], runner=runner)
    assert observation.native_label == native.name
    assert observation.binary_sha256 == hashlib.sha256(native.read_bytes()).hexdigest()
    assert calls and all(argv[:2] == ["unshare", "-rn"] for argv, _ in calls)
    assert all("agent" not in argv or "--help" in argv for argv, _ in calls)
    for _, env in calls:
        assert set(env) <= {"PATH", "HOME", "GROK_HOME", "GROK_DISABLE_AUTOUPDATER"}
        assert env["HOME"] != str(Path.home())
    assert observation.static_capture is not None
    assert observation.static_capture["markers"]["x-grok-session-id"] is True
    assert observation.static_capture["markers"]["session/load"] is False
    assert observation.acp_initialize is None


_STUB_AGENT = """
import json, os, sys
record_path = {record!r}
result = json.loads({result!r})
first = json.loads(sys.stdin.readline())
note = {{"jsonrpc": "2.0", "method": "_x.ai/mcp/servers_updated", "params": {{"mcpServers": []}}}}
sys.stdout.write(json.dumps(note) + "\\n")
sys.stdout.write(json.dumps({{"jsonrpc": "2.0", "id": first["id"], "result": result}}) + "\\n")
sys.stdout.flush()
rest = [json.loads(line) for line in sys.stdin.read().splitlines() if line.strip()]
with open(record_path, "w", encoding="utf-8") as handle:
    json.dump(
        {{
            "argv": sys.argv[1:],
            # The interpreter itself adds LC_CTYPE under a C locale (PEP 538); everything else was passed in.
            "env": sorted(set(os.environ) - {{"LC_CTYPE"}}),
            "methods": [message.get("method") for message in [first, *rest]],
            "params": first.get("params"),
            "stdin_closed": True,
        }},
        handle,
    )
"""


def _stub_handshake(tmp_path: Path, result: dict[str, Any], config_path: Path = CONFIG_PATH) -> GrokObservation:
    """`--acp-handshake` without the installed build: an injected prefix runs a stub agent that answers one line."""
    record = tmp_path / "stub-record.json"
    stub = tmp_path / "grok-1.0.46-linux-x86_64"
    stub.write_text(_STUB_AGENT.format(record=str(record), result=json.dumps(result)), encoding="utf-8")

    def runner(argv: list[str], env: dict[str, str], cwd: Path) -> str:
        if argv[-1] == "--version":
            return f"{GROK_VERSION}\n"
        return "Commands:\n  stdio  Run the agent over stdio\n\nOptions:\n"

    return observe_grok(
        config_path=config_path,
        which=lambda _name: str(stub),
        isolation=lambda: [sys.executable],
        runner=runner,
        acp_handshake=True,
    )


def test_acp_handshake_sends_only_initialize_and_stops_the_agent(tmp_path: Path) -> None:
    record = tmp_path / "stub-record.json"
    result = _initialize_without("list")
    observation = _stub_handshake(tmp_path, result)
    assert observation.errors == []
    assert observation.config_staged is True
    initialize = observation.acp_initialize
    assert initialize is not None
    assert initialize == sanitize_grok_initialize(result, ["_x.ai/mcp/servers_updated"])
    assert set(initialize["withheld_meta_keys"]) == set(LAB_HOST_META)
    text = json.dumps(initialize)
    for value in LAB_HOST_META.values():
        assert str(value) not in text
    # The stub saw exactly one initialize request, then end of input: the client shut the agent down.
    seen = json.loads(record.read_text(encoding="utf-8"))
    assert seen["argv"] == ["agent", "--no-leader", "stdio"]
    assert seen["methods"] == ["initialize"]
    assert seen["params"]["clientCapabilities"] == {
        "fs": {"readTextFile": False, "writeTextFile": False},
        "terminal": False,
    }
    assert seen["stdin_closed"] is True
    assert set(seen["env"]) <= {"PATH", "HOME", "GROK_HOME", "GROK_DISABLE_AUTOUPDATER"}
    report = grok_capability_report(observation)
    assert any("re-observed by this run" in note for note in report.notes)
    assert any("loaded by this run's agent start" in note for note in report.notes)
    capture = grok_protocol_capture(observation)
    assert capture is not None
    assert str(observation.config_digest) in capture["acp_initialize"]["provenance"]


def test_a_handshake_without_a_configuration_file_claims_nothing_was_staged(tmp_path: Path) -> None:
    absent = _stub_handshake(tmp_path, _initialize_without("list"), config_path=tmp_path / "absent.toml")
    assert absent.acp_initialize is not None and absent.config_digest is None
    capture = grok_protocol_capture(absent)
    assert capture is not None
    provenance = capture["acp_initialize"]["provenance"]
    assert "staged as GROK_HOME/config.toml" not in provenance and "None" not in provenance
    assert "no runtime configuration staged" in provenance


def test_a_configuration_that_could_not_be_staged_is_never_claimed_loaded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The file exists and has a digest, but copying it into the isolated GROK_HOME fails.
    original = Path.write_bytes

    def refuse_config(self: Path, data: bytes) -> int:
        if self.name == "config.toml":
            raise PermissionError("staging refused")
        return original(self, data)

    monkeypatch.setattr(Path, "write_bytes", refuse_config)
    unstaged = _stub_handshake(tmp_path, _initialize_without("list"))
    monkeypatch.undo()
    assert unstaged.acp_initialize is not None and unstaged.config_digest is not None
    assert "runtime configuration could not be staged: PermissionError" in unstaged.errors
    notes = "\n".join(grok_capability_report(unstaged).notes)
    assert "loaded by this run's agent start" not in notes
    assert "no recorded agent start has loaded this exact file (this run did not stage it" in notes
    capture = grok_protocol_capture(unstaged)
    assert capture is not None
    assert "staged as GROK_HOME/config.toml" not in capture["acp_initialize"]["provenance"]


def test_a_configuration_that_changed_after_its_digest_is_not_claimed_staged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = tmp_path / "config.toml"
    config.write_bytes(CONFIG_PATH.read_bytes())
    original = Path.read_bytes
    reads: list[Path] = []

    def edited_after_first_read(self: Path) -> bytes:
        data = original(self)
        if self == config:
            reads.append(self)
            if len(reads) > 1:
                return data + b"\n# edited after the digest was taken\n"
        return data

    monkeypatch.setattr(Path, "read_bytes", edited_after_first_read)
    observation = _stub_handshake(tmp_path, _initialize_without("list"), config_path=config)
    monkeypatch.undo()
    assert len(reads) == 2 and observation.config_digest == hashlib.sha256(config.read_bytes()).hexdigest()
    assert observation.acp_initialize is not None
    assert observation.config_staged is False
    assert all("loaded by this run's agent start" not in note for note in grok_capability_report(observation).notes)


def _hermetic_env(tmp_path: Path) -> dict[str, str]:
    """No PATH entry can resolve the installed `grok`, so discovery would report it missing."""
    return {"PATH": str(tmp_path / "no-binaries"), "HOME": str(tmp_path)}


def test_cli_inspect_xai_reports_pending_inventory(tmp_path: Path) -> None:
    observation = write_grok_observation(tmp_path / "observation.json")
    completed = subprocess.run(
        [
            sys.executable,
            "scripts/qualify.py",
            "inspect",
            "--provider",
            "xai",
            "--json",
            "--observation-file",
            str(observation),
        ],
        cwd=ROOT,
        env=_hermetic_env(tmp_path),
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert completed.returncode == 2, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["classification"] == "pending"
    assert payload["status"] == "pending"
    assert payload["harness_build"] == GROK_BUILD
    assert payload["configuration_digest"] == f"sha256:{hashlib.sha256(CONFIG_PATH.read_bytes()).hexdigest()}"
    report = cast(dict[str, Any], payload["capability_report"])
    assert [item["name"] for item in report["primitives"]] == list(REQUIRED_PRIMITIVES)
    assert all(item["state"] == "unproven" for item in report["primitives"])
    assert any("recorded observation" in note for note in report["notes"])


def test_cli_recorded_grok_observation_cannot_refreeze_or_handshake(tmp_path: Path) -> None:
    observation = write_grok_observation(tmp_path / "observation.json")
    base = [sys.executable, "scripts/qualify.py", "inspect", "--observation-file", str(observation)]
    for extra in (
        ["--provider", "xai", "--write-protocol-capture"],
        ["--provider", "xai", "--acp-handshake"],
        ["--provider", "openai"],
    ):
        completed = subprocess.run(
            [*base, *extra],
            cwd=ROOT,
            env=_hermetic_env(tmp_path),
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
        assert completed.returncode == 2
        assert "--observation-file" in completed.stderr
    assert hashlib.sha256(CAPTURE_PATH.read_bytes()).hexdigest() in CANDIDATE_PATH.read_text(encoding="utf-8")
