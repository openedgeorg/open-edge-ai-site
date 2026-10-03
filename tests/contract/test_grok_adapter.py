"""Task 12: exact Grok Build candidate (one long-lived ACP process) mapped onto the native adapter contract."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import subprocess
import sys
import tomllib
from collections.abc import AsyncIterator
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
    # B is still running natively; its acceptance came from replayed persisted history, not a terminal ack.
    assert isinstance(grok_lab.result_b, Accepted)
    session_b = grok_lab.handle_b.native_session_id
    assert grok_lab.result_b.work.native_session_id == session_b
    assert grok_lab.peer.sessions[session_b].held is not None
    loads = [params["sessionId"] for params in grok_lab.peer.requests_for("session/load")]
    assert session_b in loads
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
        {"sessionUpdate": "tool_call", "toolCallId": "c-1", "title": "esp_knowledge__esp.search", "status": "pending"},
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


async def test_in_flight_turn_history_is_provisional(grok_lab: GrokLab) -> None:
    await grok_lab.submit_a()
    snapshot = await asyncio.wait_for(grok_lab.adapter.read_history(grok_lab.handle_b), RPC_TIMEOUT)
    assistant = [item for item in snapshot.items if item.role == "assistant"]
    assert assistant and all(item.provisional for item in assistant)
    assert snapshot.status.status == "running"


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
    assert grok_lab.relay_records[-1].refused_reason == "closed_session"


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
    assert isinstance(first, Accepted)
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
    assert epochs[first.work.native_work_ref] == EPOCH
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
        _update({"sessionUpdate": "tool_call", "toolCallId": "c1", "title": "esp_knowledge__esp.search"}),
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


def test_esp_tool_names_mirror_the_knowledge_service() -> None:
    assert tuple(ESP_KNOWLEDGE_TOOLS) == get_args(EspToolName)
    assert ESP_KNOWLEDGE_SERVER == "esp_knowledge"


async def test_disallowed_tool_calls_and_model_drift_are_surfaced_and_counted(grok_lab: GrokLab) -> None:
    grok_lab.peer.keep_running.add(grok_lab.handle_a.native_session_id)
    grok_lab.peer.updates_during_next_prompt = [
        {"sessionUpdate": "tool_call", "toolCallId": "s1", "title": "run_terminal_command", "kind": "execute"},
        {"sessionUpdate": "tool_call", "toolCallId": "u1", "title": "use_tool", "kind": "other"},
        {"sessionUpdate": "tool_call", "toolCallId": "e1", "title": "esp_knowledge__esp.get_claim", "kind": "read"},
        {"sessionUpdate": "tool_call", "toolCallId": "x1", "title": "esp_knowledge__write_anything", "kind": "edit"},
        {
            "sessionUpdate": "config_option_update",
            "configOptions": [{"id": "model", "currentValue": "grok-4.6", "options": []}],
        },
    ]
    assert isinstance(await grok_lab.submit(grok_lab.handle_a, grok_lab.message_a, grok_lab.authority_a), Accepted)
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
