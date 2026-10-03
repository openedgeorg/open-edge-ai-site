"""Task 11: exact Codex App Server candidate mapped onto the supervised native adapter contract."""

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
from typing import Any, cast

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
from esp_provider_openai.codex_adapter import (
    CODEX_BUILD,
    CODEX_CLIENT_NOTIFICATIONS,
    CODEX_METHODS,
    CODEX_MODEL_PROVIDER,
    CODEX_NATIVE_SHA256,
    CODEX_OPT_OUT_NOTIFICATIONS,
    CODEX_VERSION,
    CodexBindingMismatch,
    JsonlFrameTransport,
    UnloadUnconfirmed,
    codex_build_id,
    create_codex_adapter,
)
from esp_provider_openai.events import CODEX_EVENT_METHODS, CodexEventRejected, normalize_codex_notification
from esp_provider_shared.adapter import UnsupportedPrimitive
from esp_provider_shared.rpc import FRAME_LIMIT_BYTES, FrameTooLarge, NativeRpcClient, ResponseLost
from esp_provider_shared.transport_context import OperationContext, UnattributedCall
from scripts.qualify import (
    CodexObservation,
    codex_capability_report,
    essential_absences,
    observe_codex,
    summarize_definition,
)
from tests.support.codex_capture import (
    CANARY_A,
    CANARY_B,
    CANDIDATE_PATH,
    CAPTURE_PATH,
    CONFIG_PATH,
    CONV_A,
    CONV_C,
    PROV_A,
    PROV_C,
    RPC_TIMEOUT,
    CodexLab,
    lab_profile,
    load_capture,
    reservation,
    write_observation,
)
from tests.support.contracts import EPOCH

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
async def codex_lab() -> AsyncIterator[CodexLab]:
    lab = await CodexLab.start()
    try:
        yield lab
    finally:
        await lab.aclose()


# Plan scenario ----------------------------------------------------------------------------


async def test_codex_identity_acceptance_and_compaction(codex_lab: CodexLab) -> None:
    assert (await codex_lab.submit_a()).kind == "accepted"
    assert codex_lab.submitted_native_id == codex_lab.handle_a.native_session_id
    assert await codex_lab.peer_canary_in_history_a() is False
    assert await codex_lab.compaction_requests_without_scope() == 0
    # Positive captured-inference assertion: compaction actually produced attributed model requests.
    assert codex_lab.compaction_requests_forwarded >= 2
    assert codex_lab.peer.violations == []


# Acceptance and durable input correlation ---------------------------------------------------


async def test_accepted_work_is_the_native_turn_that_durably_holds_the_input(codex_lab: CodexLab) -> None:
    result = await codex_lab.submit_a()
    assert isinstance(result, Accepted)
    assert result.work.native_session_id == codex_lab.handle_a.native_session_id
    started = codex_lab.peer.requests_for("turn/start")
    params_a = next(p for p in started if p["clientUserMessageId"] == "req-canary-a")
    assert params_a["threadId"] == codex_lab.handle_a.native_session_id
    turn_a = codex_lab.peer.threads[codex_lab.handle_a.native_session_id].turns[0]
    assert result.work.native_work_ref == turn_a.id
    assert isinstance(codex_lab.result_b, Accepted)
    assert codex_lab.result_b.work.native_session_id == codex_lab.handle_b.native_session_id
    correlation_reads = codex_lab.peer.requests_for("thread/items/list")
    assert {"threadId": codex_lab.handle_a.native_session_id, "turnId": turn_a.id} in [
        {"threadId": p["threadId"], "turnId": p.get("turnId")} for p in correlation_reads
    ]


async def test_acknowledgement_without_durable_correlation_is_unconfirmed(codex_lab: CodexLab) -> None:
    codex_lab.peer.persist_user_messages = False
    result = await codex_lab.submit(codex_lab.handle_a, codex_lab.message_a, codex_lab.authority_a)
    assert isinstance(result, Unconfirmed)
    turn_a = codex_lab.peer.threads[codex_lab.handle_a.native_session_id].turns[0]
    assert result.native_work_ref == turn_a.id


async def test_lost_turn_ack_is_unconfirmed(codex_lab: CodexLab) -> None:
    codex_lab.peer.lose_next_turn_ack = True
    result = await asyncio.wait_for(
        codex_lab.adapter.submit(codex_lab.handle_a, codex_lab.message_a, codex_lab.authority_a), RPC_TIMEOUT
    )
    assert isinstance(result, Unconfirmed)
    assert result.native_work_ref is None


async def test_send_failure_before_write_is_not_submitted(codex_lab: CodexLab) -> None:
    codex_lab.peer.fail_next_send = True
    result = await asyncio.wait_for(
        codex_lab.adapter.submit(codex_lab.handle_a, codex_lab.message_a, codex_lab.authority_a), RPC_TIMEOUT
    )
    assert isinstance(result, NotSubmitted)
    assert result.code == "not_sent"
    assert codex_lab.peer.requests_for("turn/start") == []


async def test_native_rejection_is_not_submitted_only_without_durable_input(codex_lab: CodexLab) -> None:
    codex_lab.peer.reject_next_turn_start = True
    rejected = await codex_lab.submit(codex_lab.handle_a, codex_lab.message_a, codex_lab.authority_a)
    assert isinstance(rejected, NotSubmitted)
    assert rejected.code == "native_rejected"

    codex_lab.peer.reject_next_turn_start = True
    codex_lab.peer.record_input_before_rejection = True
    message = SubmitMessage(conversation_id=CONV_A, client_request_id="req-recorded", message="recorded anyway")
    ambiguous = await codex_lab.submit(codex_lab.handle_a, message, codex_lab.authority_a)
    assert isinstance(ambiguous, Unconfirmed)
    assert ambiguous.native_work_ref is not None


@pytest.mark.parametrize("line", [b"{not json", b"[]"], ids=["malformed", "non_object"])
async def test_local_frame_failure_during_turn_start_is_unconfirmed(codex_lab: CodexLab, line: bytes) -> None:
    # The client fails every in-flight request locally; the build still accepts and runs the turn.
    codex_lab.peer.persist_user_messages = False
    codex_lab.peer.raw_line_before_next_turn_ack = line
    result = await asyncio.wait_for(
        codex_lab.adapter.submit(codex_lab.handle_a, codex_lab.message_a, codex_lab.authority_a), RPC_TIMEOUT
    )
    assert isinstance(result, Unconfirmed)
    assert [turn.status for turn in codex_lab.peer.threads[codex_lab.handle_a.native_session_id].turns] == [
        "completed"
    ]


async def test_terminal_frame_failure_after_turn_start_is_unconfirmed(codex_lab: CodexLab) -> None:
    codex_lab.peer.raw_line_before_next_turn_ack = b" " * (FRAME_LIMIT_BYTES + 1)
    result = await asyncio.wait_for(
        codex_lab.adapter.submit(codex_lab.handle_a, codex_lab.message_a, codex_lab.authority_a), RPC_TIMEOUT
    )
    assert isinstance(result, Unconfirmed)
    assert result.native_work_ref is None
    assert len(codex_lab.peer.threads[codex_lab.handle_a.native_session_id].turns) == 1


async def test_read_side_os_error_after_send_is_unconfirmed_not_unsent(codex_lab: CodexLab) -> None:
    codex_lab.peer.recv_error_before_next_turn_ack = OSError(5, "Input/output error")
    result = await asyncio.wait_for(
        codex_lab.adapter.submit(codex_lab.handle_a, codex_lab.message_a, codex_lab.authority_a), RPC_TIMEOUT
    )
    assert isinstance(result, Unconfirmed)
    assert codex_lab.peer.requests_for("turn/start") != []


async def test_peer_internal_error_on_turn_start_is_not_a_conclusive_refusal(codex_lab: CodexLab) -> None:
    codex_lab.peer.reject_next_turn_start = True
    codex_lab.peer.reject_code = -32603
    result = await codex_lab.submit(codex_lab.handle_a, codex_lab.message_a, codex_lab.authority_a)
    assert isinstance(result, Unconfirmed)


async def test_steered_existing_turn_is_not_fresh_acceptance(codex_lab: CodexLab) -> None:
    codex_lab.peer.keep_running.add(codex_lab.handle_a.native_session_id)
    first = await codex_lab.submit(codex_lab.handle_a, codex_lab.message_a, codex_lab.authority_a)
    assert isinstance(first, Accepted)
    codex_lab.peer.steer_next_turn = True
    message = SubmitMessage(conversation_id=CONV_A, client_request_id="req-steer", message="merged into running work")
    steering = OperationAuthority(inference_token="inf-A-steer", knowledge_token="know-A-steer")
    steered = await codex_lab.submit(codex_lab.handle_a, message, steering)
    assert isinstance(steered, Unconfirmed)
    assert steered.native_work_ref == first.work.native_work_ref
    # The running turn keeps the binding of the operation that started it.
    current = codex_lab.adapter.transport.current(codex_lab.handle_a.native_session_id)
    assert current is not None
    assert (current.native_work_ref, current.inference_token) == (first.work.native_work_ref, "inf-A")


async def test_continue_work_without_native_primitive_sends_nothing(codex_lab: CodexLab) -> None:
    before = len(codex_lab.peer.requests)
    work = WorkRef(native_session_id=codex_lab.handle_a.native_session_id, native_work_ref="turn-x")
    result = await codex_lab.adapter.continue_work(codex_lab.handle_a, work, codex_lab.authority_a)
    assert isinstance(result, NotSubmitted)
    assert result.code == "continue_unsupported"
    assert len(codex_lab.peer.requests) == before


# Identity and fixed binding --------------------------------------------------------------


async def test_create_and_resume_pin_model_provider_and_policy(codex_lab: CodexLab) -> None:
    starts = codex_lab.peer.requests_for("thread/start")
    assert len(starts) == 2
    for params in starts:
        assert params["model"] == "codex-lab-model"
        assert params["modelProvider"] == CODEX_MODEL_PROVIDER
        assert params["approvalPolicy"] == "never"
        assert params["sandbox"] == "read-only"
        assert params["ephemeral"] is False
    assert codex_lab.handle_a.native_session_id != codex_lab.handle_b.native_session_id
    resumed = await codex_lab.adapter.resume_session(codex_lab.handle_a)
    assert resumed.native_session_id == codex_lab.handle_a.native_session_id
    resume = codex_lab.peer.requests_for("thread/resume")[-1]
    assert resume["threadId"] == codex_lab.handle_a.native_session_id
    assert resume["model"] == "codex-lab-model"
    assert resume["modelProvider"] == CODEX_MODEL_PROVIDER


async def test_model_or_provider_drift_is_rejected(codex_lab: CodexLab) -> None:
    with pytest.raises(CodexBindingMismatch):
        await codex_lab.adapter.create_session(reservation(CONV_A, PROV_A, model="another-model"))
    assert len(codex_lab.peer.requests_for("thread/start")) == 2
    codex_lab.peer.model_override = "fallback-model"
    with pytest.raises(CodexBindingMismatch):
        await codex_lab.adapter.create_session(reservation(CONV_A, PROV_A))
    with pytest.raises(CodexBindingMismatch):
        await codex_lab.adapter.resume_session(codex_lab.handle_b.model_copy(update={"model": "fallback-model"}))


async def test_sandbox_with_network_access_is_binding_drift(codex_lab: CodexLab) -> None:
    codex_lab.peer.sandbox_network_access = True
    with pytest.raises(CodexBindingMismatch, match="sandbox_drift"):
        await codex_lab.adapter.create_session(reservation(CONV_C, PROV_C))
    with pytest.raises(CodexBindingMismatch, match="sandbox_drift"):
        await codex_lab.adapter.resume_session(codex_lab.handle_a)


async def test_factory_requires_exact_openai_build_profile() -> None:
    candidate = json.loads(CANDIDATE_PATH.read_text(encoding="utf-8"))
    rpc = NativeRpcClient(_RecordingTransport())
    with pytest.raises(ValueError, match="profile_provider_mismatch"):
        create_codex_adapter(rpc, lab_profile(provider="xai"))
    for label in (
        "codex-cli 0.0.1",
        # The version label alone does not identify the frozen binary.
        "codex-cli 0.159.3",
        # Same version string, different native binary.
        f"codex-cli 0.159.3 sha256:{'0' * 64}",
    ):
        with pytest.raises(ValueError, match="unqualified_harness_build"):
            create_codex_adapter(rpc, lab_profile(harness_build=label))
    adapter = create_codex_adapter(rpc, lab_profile(harness_build=candidate["harness_build"]))
    assert adapter.profile.harness_build == candidate["harness_build"]


# History, status, cancel and unload --------------------------------------------------------


async def test_history_is_thread_scoped_and_hides_reasoning(codex_lab: CodexLab) -> None:
    await codex_lab.submit_a()
    snapshot = await codex_lab.adapter.read_history(codex_lab.handle_a)
    roles = [(item.role, item.text) for item in snapshot.items]
    assert ("user", CANARY_A) in roles
    assert ("assistant", f"reply to {CANARY_A}") in roles
    assert all(CANARY_B not in text for _, text in roles)
    assert all("reasoning" not in item.native_item_id for item in snapshot.items)
    turn_a = codex_lab.peer.threads[codex_lab.handle_a.native_session_id].turns[0]
    assert {item.native_work_ref for item in snapshot.items} == {turn_a.id}
    history_b = await codex_lab.history_text(codex_lab.handle_b)
    assert CANARY_B in history_b
    assert all(CANARY_A not in text for text in history_b)
    for params in codex_lab.peer.requests_for("thread/turns/list"):
        assert params["threadId"] in {codex_lab.handle_a.native_session_id, codex_lab.handle_b.native_session_id}


async def test_inspect_maps_turn_status_and_request_correlation(codex_lab: CodexLab) -> None:
    await codex_lab.submit_a()
    status_a = await codex_lab.adapter.inspect(codex_lab.handle_a)
    assert status_a.status == "completed"
    status_b = await codex_lab.adapter.inspect(codex_lab.handle_b, "req-canary-b")
    turn_b = codex_lab.peer.threads[codex_lab.handle_b.native_session_id].turns[0]
    assert status_b.status == "running"
    assert status_b.native_work_ref == turn_b.id
    assert status_b.request_id == "req-canary-b"
    assert status_b.saved_input_available is True
    missing = await codex_lab.adapter.inspect(codex_lab.handle_b, "req-never-sent")
    assert missing.native_work_ref is None
    assert missing.saved_input_available is False


async def test_cancel_interrupts_only_the_named_turn(codex_lab: CodexLab) -> None:
    codex_lab.peer.keep_running.add(codex_lab.handle_a.native_session_id)
    result = await codex_lab.submit_a()
    assert isinstance(result, Accepted)
    assert await codex_lab.adapter.cancel(codex_lab.handle_a, result.work) == "requested"
    interrupt = codex_lab.peer.requests_for("turn/interrupt")[-1]
    assert interrupt == {"threadId": codex_lab.handle_a.native_session_id, "turnId": result.work.native_work_ref}
    await codex_lab.peer.wait_idle()
    assert (await codex_lab.adapter.inspect(codex_lab.handle_a)).status == "interrupted"
    assert (await codex_lab.adapter.inspect(codex_lab.handle_b)).status == "running"
    foreign = WorkRef(native_session_id=codex_lab.handle_b.native_session_id, native_work_ref="turn-b")
    with pytest.raises(ValueError, match="work_session_mismatch"):
        await codex_lab.adapter.cancel(codex_lab.handle_a, foreign)


async def test_unload_requires_native_unload_confirmation(codex_lab: CodexLab) -> None:
    await codex_lab.submit_a()
    assert await codex_lab.adapter.unload(codex_lab.handle_a) == "unloaded"
    assert codex_lab.peer.threads[codex_lab.handle_a.native_session_id].loaded is False
    assert codex_lab.peer.threads[codex_lab.handle_b.native_session_id].loaded is True
    assert (await codex_lab.adapter.inspect(codex_lab.handle_b)).status == "running"
    codex_lab.peer.keep_loaded_after_unsubscribe = True
    with pytest.raises(UnloadUnconfirmed):
        await codex_lab.adapter.unload(codex_lab.handle_b)


async def test_build_closed_thread_attributes_nothing(codex_lab: CodexLab) -> None:
    await codex_lab.submit_a()
    thread_b = codex_lab.handle_b.native_session_id
    turn_b = codex_lab.peer.threads[thread_b].turns[0].id
    # The build closes B while its turn never reported completion.
    codex_lab.peer.notify("thread/closed", {"threadId": thread_b})
    await codex_lab.peer.wait_idle()
    codex_lab.peer.emit_model_request(thread_b, turn_b, "turn")
    codex_lab.peer.emit_model_request(thread_b, "turn-after-close", "turn")
    assert [(record.forwarded, record.refused_reason) for record in codex_lab.relay_records[-2:]] == [
        (False, "stale_turn"),
        (False, "unbound_turn"),
    ]
    with pytest.raises(UnattributedCall):
        codex_lab.adapter.transport.refresh_tokens(thread_b, "inf-B2", "know-B2")


def _model_request(thread_id: str, turn_id: str) -> bytes:
    metadata = {"session_id": thread_id, "thread_id": thread_id, "turn_id": turn_id, "window_id": "w"}
    body = {"model": "codex-lab-model", "client_metadata": {"x-codex-turn-metadata": json.dumps(metadata)}}
    return json.dumps(body).encode()


async def test_unload_and_delete_release_thread_state_and_binding(codex_lab: CodexLab) -> None:
    await codex_lab.submit_a()
    thread_a = codex_lab.handle_a.native_session_id
    thread_b = codex_lab.handle_b.native_session_id
    turn_b = codex_lab.peer.threads[thread_b].turns[0].id
    transport = codex_lab.adapter.transport
    # B's turn is still running, so B is bound; deleting it sends no thread/closed.
    assert transport.start_model_call(thread_b)["token"] == "inf-B"
    await codex_lab.adapter.delete_history(codex_lab.handle_b)
    with pytest.raises(UnattributedCall):
        transport.start_model_call(thread_b)
    with pytest.raises(UnattributedCall):
        transport.refresh_tokens(thread_b, "inf-B2", "know-B2")
    with pytest.raises(UnattributedCall, match="unbound_turn"):
        codex_lab.adapter.attribute_model_request(_model_request(thread_b, turn_b))
    assert thread_b not in codex_lab.adapter.tracked_threads()
    assert thread_a in codex_lab.adapter.tracked_threads()
    assert await codex_lab.adapter.unload(codex_lab.handle_a) == "unloaded"
    assert codex_lab.adapter.tracked_threads() == frozenset()
    with pytest.raises(UnattributedCall):
        transport.start_model_call(thread_a)


async def test_export_is_unsupported_without_guessing_a_method(codex_lab: CodexLab) -> None:
    before = len(codex_lab.peer.requests)
    with pytest.raises(UnsupportedPrimitive) as caught:
        await codex_lab.adapter.export_history(codex_lab.handle_a)
    assert caught.value.primitive == "export"
    assert len(codex_lab.peer.requests) == before


# Per-operation model attribution --------------------------------------------------------------


async def test_model_requests_are_attributed_from_native_turn_metadata(codex_lab: CodexLab) -> None:
    await codex_lab.submit_a()
    turns = codex_lab.forwarded("turn")
    by_thread = {record.emitting_thread: record for record in turns}
    assert by_thread[codex_lab.handle_a.native_session_id].token == "inf-A"
    assert by_thread[codex_lab.handle_b.native_session_id].token == "inf-B"
    for record in turns:
        assert record.attributed_thread == record.emitting_thread
    assert codex_lab.adapter.transport.unattributed_starts == 0


async def test_manual_compaction_binds_the_supplied_scope_before_the_native_call(codex_lab: CodexLab) -> None:
    handle_c = await codex_lab.create_unbound_c()
    authority_c = OperationAuthority(inference_token="inf-C", knowledge_token="know-C")
    assert await codex_lab.adapter.compact(handle_c, authority_c) == "requested"
    await codex_lab.peer.wait_idle()
    records = [r for r in codex_lab.relay_records if r.emitting_thread == handle_c.native_session_id]
    assert len(records) == 1
    assert records[0].kind == "compaction"
    assert records[0].forwarded is True
    assert records[0].token == "inf-C"
    assert codex_lab.peer.requests_for("thread/compact/start") == [{"threadId": handle_c.native_session_id}]


async def test_unbound_stale_or_unlabelled_model_requests_are_refused(codex_lab: CodexLab) -> None:
    await codex_lab.submit_a()
    handle_c = await codex_lab.create_unbound_c()
    turn_a = codex_lab.peer.threads[codex_lab.handle_a.native_session_id].turns[0]
    before = codex_lab.adapter.transport.unattributed_starts
    codex_lab.peer.emit_model_request(handle_c.native_session_id, "background-turn", "compaction")
    codex_lab.peer.emit_model_request(codex_lab.handle_a.native_session_id, turn_a.id, "turn")
    codex_lab.peer.emit_model_request(codex_lab.handle_b.native_session_id, "turn-x", "turn", metadata=False)
    refused = [record for record in codex_lab.relay_records if not record.forwarded]
    assert [record.refused_reason for record in refused] == [
        "unbound_turn",
        "stale_turn",
        "missing_turn_metadata",
    ]
    assert codex_lab.adapter.transport.unattributed_starts == before + 3
    with pytest.raises(UnattributedCall, match="invalid_body"):
        codex_lab.adapter.attribute_model_request(b'{"client_metadata": {}, "client_metadata": {}}')


async def test_superseded_turn_model_requests_keep_their_own_scope(codex_lab: CodexLab) -> None:
    thread_a = codex_lab.handle_a.native_session_id
    codex_lab.peer.keep_running.add(thread_a)
    first = await codex_lab.submit(codex_lab.handle_a, codex_lab.message_a, codex_lab.authority_a)
    assert isinstance(first, Accepted)
    replacement = codex_lab.handle_a.model_copy(update={"ownership_epoch": EPOCH + 1})
    authority = OperationAuthority(inference_token="inf-A2", knowledge_token="know-A2")
    message = SubmitMessage(conversation_id=CONV_A, client_request_id="req-a-next", message="next question")
    second = await codex_lab.submit(replacement, message, authority)
    assert isinstance(second, Accepted)
    codex_lab.peer.emit_model_request(thread_a, first.work.native_work_ref, "turn")
    codex_lab.peer.emit_model_request(thread_a, second.work.native_work_ref, "turn")
    late, current = codex_lab.relay_records[-2:]
    assert (late.forwarded, late.token, late.attributed_turn) == (True, "inf-A", first.work.native_work_ref)
    assert (current.forwarded, current.token, current.attributed_turn) == (True, "inf-A2", second.work.native_work_ref)


async def test_unknown_or_unowned_turns_on_a_bound_thread_are_refused(codex_lab: CodexLab) -> None:
    await codex_lab.submit_a()
    await _drain(codex_lab, codex_lab.handle_b)
    thread_a = codex_lab.handle_a.native_session_id
    thread_b = codex_lab.handle_b.native_session_id
    before = codex_lab.adapter.transport.unattributed_starts
    # A's ESP turn has completed; a turn id the adapter never saw is not that run's work.
    codex_lab.peer.emit_model_request(thread_a, "never-seen-turn", "turn")
    # B is bound to its running turn; another native turn on B was started by no ESP operation.
    background = codex_lab.peer.start_background_turn(thread_b)
    await codex_lab.peer.wait_idle()
    rejected_before = codex_lab.adapter.rejected_events
    codex_lab.peer.notify(
        "item/agentMessage/delta", {"threadId": thread_b, "turnId": background, "itemId": "bg-1", "delta": "bg"}
    )
    await codex_lab.peer.wait_idle()
    codex_lab.peer.emit_model_request(thread_b, background, "turn")
    refused = codex_lab.relay_records[-2:]
    assert [(record.forwarded, record.refused_reason) for record in refused] == [
        (False, "unbound_turn"),
        (False, "unbound_turn"),
    ]
    assert codex_lab.adapter.transport.unattributed_starts == before + 2
    assert codex_lab.adapter.rejected_events == rejected_before + 1
    assert all(event.native_work_ref != background for event in await _drain(codex_lab, codex_lab.handle_b))


async def test_conclusive_non_submission_releases_the_pending_binding(codex_lab: CodexLab) -> None:
    thread_a = codex_lab.handle_a.native_session_id
    thread_b = codex_lab.handle_b.native_session_id
    codex_lab.peer.reject_next_turn_start = True
    rejected = await codex_lab.submit(codex_lab.handle_a, codex_lab.message_a, codex_lab.authority_a)
    assert isinstance(rejected, NotSubmitted)
    codex_lab.peer.fail_next_send = True
    unsent = await codex_lab.submit(codex_lab.handle_b, codex_lab.message_b, codex_lab.authority_b)
    assert isinstance(unsent, NotSubmitted)
    codex_lab.peer.emit_model_request(thread_a, "turn-after-rejection", "turn")
    codex_lab.peer.emit_model_request(thread_b, "turn-after-unsent", "turn")
    assert [(record.forwarded, record.refused_reason) for record in codex_lab.relay_records[-2:]] == [
        (False, "unbound_turn"),
        (False, "unbound_turn"),
    ]
    for thread_id in (thread_a, thread_b):
        assert codex_lab.adapter.transport.current(thread_id) is None
        with pytest.raises(UnattributedCall):
            codex_lab.adapter.transport.refresh_tokens(thread_id, "inf-x", "know-x")


async def test_completed_turn_leaves_its_thread_idle(codex_lab: CodexLab) -> None:
    await codex_lab.submit_a()
    thread_a = codex_lab.handle_a.native_session_id
    thread_b = codex_lab.handle_b.native_session_id
    assert codex_lab.adapter.transport.current(thread_a) is None
    with pytest.raises(UnattributedCall):
        codex_lab.adapter.transport.start_model_call(thread_a)
    running = codex_lab.adapter.transport.current(thread_b)
    assert running is not None
    assert running.native_work_ref == codex_lab.peer.threads[thread_b].turns[0].id


async def test_pending_operation_owns_only_turns_it_could_have_started(codex_lab: CodexLab) -> None:
    thread_a = codex_lab.handle_a.native_session_id
    background = codex_lab.peer.start_background_turn(thread_a)
    await codex_lab.peer.wait_idle()
    codex_lab.peer.hold_turn_acks = 2
    submit_a = asyncio.create_task(
        codex_lab.adapter.submit(codex_lab.handle_a, codex_lab.message_a, codex_lab.authority_a)
    )
    while not codex_lab.peer.requests_for("turn/start"):
        await asyncio.sleep(0.01)
    # A waits for its turn id: a turn not named yet may be A's, a turn already announced before A was sent is not.
    codex_lab.peer.emit_model_request(thread_a, "not-yet-named", "turn")
    codex_lab.peer.emit_model_request(thread_a, background, "turn")
    named, announced = codex_lab.relay_records[-2:]
    assert (named.forwarded, named.token) == (True, "inf-A")
    assert (announced.forwarded, announced.refused_reason) == (False, "unbound_turn")
    await codex_lab.submit(codex_lab.handle_b, codex_lab.message_b, codex_lab.authority_b)
    assert isinstance(await asyncio.wait_for(submit_a, RPC_TIMEOUT), Accepted)


# Events --------------------------------------------------------------------------------


async def test_events_carry_explicit_native_identity(codex_lab: CodexLab) -> None:
    await codex_lab.submit_a()

    async def first_event() -> NativeEvent:
        async for event in codex_lab.adapter.events(codex_lab.handle_a):
            return event
        raise AssertionError("event stream ended")

    event = await asyncio.wait_for(first_event(), RPC_TIMEOUT)
    turn_a = codex_lab.peer.threads[codex_lab.handle_a.native_session_id].turns[0]
    assert event.native_session_id == codex_lab.handle_a.native_session_id
    assert event.native_work_ref == turn_a.id
    assert event.provider_session_id == codex_lab.handle_a.provider_session_id
    assert event.ownership_epoch == EPOCH
    seen: list[NativeEvent] = [event]
    while True:
        try:
            seen.append(await asyncio.wait_for(first_event(), 0.05))
        except TimeoutError:
            break
    kinds = [item.payload_type for item in seen]
    assert "text_delta" in kinds
    assert "turn_completed" in kinds
    assert all("reasoning" not in kind for kind in kinds)
    assert all(item.native_session_id == codex_lab.handle_a.native_session_id for item in seen)


async def _drain(lab: CodexLab, handle: SessionHandle) -> list[NativeEvent]:
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


async def test_late_events_keep_the_epoch_of_the_turn_that_produced_them(codex_lab: CodexLab) -> None:
    first = await codex_lab.submit(codex_lab.handle_a, codex_lab.message_a, codex_lab.authority_a)
    assert isinstance(first, Accepted)
    replacement = codex_lab.handle_a.model_copy(update={"ownership_epoch": EPOCH + 1})
    authority = OperationAuthority(inference_token="inf-A2", knowledge_token="know-A2")
    message = SubmitMessage(conversation_id=CONV_A, client_request_id="req-a-next", message="next question")
    second = await codex_lab.submit(replacement, message, authority)
    assert isinstance(second, Accepted)
    await _drain(codex_lab, codex_lab.handle_a)
    thread_a = codex_lab.handle_a.native_session_id
    for turn_id, text in ((first.work.native_work_ref, "late-old"), (second.work.native_work_ref, "current")):
        params = {"threadId": thread_a, "turnId": turn_id, "itemId": f"{turn_id}-x", "delta": text}
        codex_lab.peer.notify("item/agentMessage/delta", params)
    await codex_lab.peer.wait_idle()
    by_text = {event.payload["text"]: event for event in await _drain(codex_lab, codex_lab.handle_a)}
    assert by_text["late-old"].ownership_epoch == EPOCH
    assert by_text["late-old"].native_work_ref == first.work.native_work_ref
    assert by_text["current"].ownership_epoch == EPOCH + 1


def _context(thread_id: str = "thread-a") -> OperationContext:
    return OperationContext(
        native_session_id=thread_id,
        native_work_ref=None,
        provider_session_id=PROV_A,
        session_generation=1,
        active_agent_run_id="33333333-3333-4333-8333-333333333331",
        ownership_epoch=EPOCH,
        runtime_incarnation_id="55555555-5555-4555-8555-555555555551",
        inference_token="inf-A",
        knowledge_token="know-A",
    )


def test_normalize_requires_identity_and_filters_hidden_work() -> None:
    context = _context()
    delta = normalize_codex_notification(
        "item/agentMessage/delta",
        {"threadId": "thread-a", "turnId": "turn-1", "itemId": "i-1", "delta": "hello"},
        context,
    )
    assert delta is not None
    assert delta.payload_type == "text_delta"
    assert delta.payload["text"] == "hello"
    with pytest.raises(CodexEventRejected):
        normalize_codex_notification("item/agentMessage/delta", {"threadId": "thread-a", "delta": "x"}, context)
    with pytest.raises(CodexEventRejected):
        normalize_codex_notification(
            "item/agentMessage/delta", {"threadId": "thread-a", "turnId": "t", "itemId": "i", "delta": "x"}, None
        )
    with pytest.raises(CodexEventRejected):
        normalize_codex_notification(
            "item/agentMessage/delta",
            {"threadId": "thread-b", "turnId": "t", "itemId": "i", "delta": "x"},
            context,
        )
    hidden = normalize_codex_notification(
        "item/reasoning/textDelta", {"threadId": "thread-a", "turnId": "t", "itemId": "i", "delta": "secret"}, context
    )
    assert hidden is None
    reasoning_item = normalize_codex_notification(
        "item/completed",
        {"threadId": "thread-a", "turnId": "t", "completedAtMs": 0, "item": {"type": "reasoning", "id": "r"}},
        context,
    )
    assert reasoning_item is None
    shell = normalize_codex_notification(
        "item/started",
        {
            "threadId": "thread-a",
            "turnId": "t",
            "startedAtMs": 0,
            "item": {"type": "commandExecution", "id": "c", "command": "ls", "commandActions": [], "cwd": "/"},
        },
        context,
    )
    assert shell is not None
    assert shell.payload_type == "disallowed_item"
    assert shell.payload["item_type"] == "commandExecution"
    rerouted = normalize_codex_notification(
        "model/rerouted",
        {"threadId": "thread-a", "turnId": "t", "fromModel": "m1", "toModel": "m2", "reason": "highRiskCyberActivity"},
        context,
    )
    assert rerouted is not None
    assert rerouted.payload_type == "model_rerouted"
    assert rerouted.payload["to_model"] == "m2"


async def test_model_reroute_and_disallowed_items_are_counted(codex_lab: CodexLab) -> None:
    await codex_lab.submit_a()
    await _drain(codex_lab, codex_lab.handle_a)
    thread_a = codex_lab.handle_a.native_session_id
    turn_a = codex_lab.peer.threads[thread_a].turns[0]
    rejected_before = codex_lab.adapter.rejected_events
    codex_lab.peer.notify(
        "model/rerouted",
        {"threadId": thread_a, "turnId": turn_a.id, "fromModel": "codex-lab-model", "toModel": "x", "reason": "r"},
    )
    no_actions: list[object] = []
    shell = {"type": "commandExecution", "id": "cmd-1", "command": "ls", "commandActions": no_actions, "cwd": "/"}
    codex_lab.peer.notify("item/started", {"threadId": thread_a, "turnId": turn_a.id, "startedAtMs": 0, "item": shell})
    codex_lab.peer.notify("item/agentMessage/delta", {"threadId": thread_a, "delta": "no turn id"})
    await codex_lab.peer.wait_idle()
    assert codex_lab.adapter.model_reroutes == 1
    assert codex_lab.adapter.disallowed_items == 1
    assert codex_lab.adapter.rejected_events == rejected_before + 1
    events = await _drain(codex_lab, codex_lab.handle_a)
    assert [event.payload_type for event in events] == ["model_rerouted", "disallowed_item"]
    disallowed = events[1]
    assert disallowed.native_work_ref == turn_a.id
    assert disallowed.payload == {"item_type": "commandExecution", "item_id": "cmd-1", "phase": "started"}
    # Only the deliberately identity-less delta breaks the captured shape.
    assert [v for v in codex_lab.peer.violations if "agentMessage/delta" not in v] == []


# Transport and handshake ------------------------------------------------------------------


class _RecordingTransport:
    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self._never: asyncio.Queue[bytes] = asyncio.Queue()

    async def send_frame(self, payload: bytes) -> None:
        self.sent.append(payload)

    async def recv_frame(self) -> bytes:
        return await self._never.get()


async def test_handshake_sends_initialize_then_initialized_notification(codex_lab: CodexLab) -> None:
    names = [name for name, _ in codex_lab.peer.requests[:2]]
    assert names == ["initialize", "initialized"]
    params = codex_lab.peer.requests[0][1]
    assert params["capabilities"]["experimentalApi"] is False
    assert set(params["capabilities"]["optOutNotificationMethods"]) == set(CODEX_OPT_OUT_NOTIFICATIONS)
    capture = load_capture()
    assert set(CODEX_OPT_OUT_NOTIFICATIONS) <= set(capture["server_notifications"])
    assert set(CODEX_CLIENT_NOTIFICATIONS) <= set(capture["client_notifications"])


async def test_rpc_notify_sends_a_frame_without_id() -> None:
    transport = _RecordingTransport()
    client = NativeRpcClient(transport)
    await client.notify("initialized")
    await client.notify("custom", {"a": 1})
    first, second = (json.loads(frame) for frame in transport.sent)
    assert "id" not in first
    assert first["method"] == "initialized"
    assert "params" not in first
    assert second["params"] == {"a": 1}
    with pytest.raises(FrameTooLarge):
        await client.notify("big", {"x": "y" * FRAME_LIMIT_BYTES})


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


async def test_jsonl_transport_frames_bounds_and_write_uncertainty() -> None:
    reader = asyncio.StreamReader(limit=FRAME_LIMIT_BYTES + 2)
    writer = _FakeWriter()
    transport = JsonlFrameTransport(reader, writer)
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
        await JsonlFrameTransport(asyncio.StreamReader(), _FakeWriter(closing=True)).send_frame(b"{}")
    uncertain = JsonlFrameTransport(asyncio.StreamReader(), _FakeWriter(drain_error=BrokenPipeError()))
    with pytest.raises(ResponseLost):
        await uncertain.send_frame(b"{}")


# Frozen capture, profile configuration and G0 inventory ---------------------------------------


def test_protocol_capture_freezes_the_exact_build_and_operation_mapping() -> None:
    capture = load_capture()
    assert capture["harness_build"] == CODEX_BUILD
    assert len(capture["native_binary"]["sha256"]) == 64
    assert capture["esp_operation_mapping"] == dict(CODEX_METHODS)
    assert set(CODEX_METHODS.values()) <= set(capture["client_requests"])
    assert set(CODEX_EVENT_METHODS) <= set(capture["server_notifications"])
    assert set(CODEX_METHODS.values()) <= set(capture["shapes"])
    assert "clientUserMessageId" in capture["shapes"]["turn/start"]["params"]["properties"]
    assert "clientId" in capture["definitions"]["ThreadItem"]["variants"]["userMessage"]["properties"]
    declaration = capture["declarations"]["turn/start.responsesapiClientMetadata"]
    for key in ("x-codex-turn-metadata", "thread_id", "turn_id"):
        assert key in declaration
    assert "session/submit" not in capture["client_requests"]


def test_runtime_config_routes_through_attribution_relay_without_static_identity() -> None:
    config = tomllib.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    assert config["model_provider"] == CODEX_MODEL_PROVIDER
    provider = config["model_providers"][CODEX_MODEL_PROVIDER]
    assert provider["wire_api"] == "responses"
    assert provider["base_url"].startswith("http://127.0.0.1:")
    for static_identity in ("http_headers", "env_http_headers", "env_key", "experimental_bearer_token", "auth"):
        assert static_identity not in provider
    assert provider["request_max_retries"] == 0
    assert provider["stream_max_retries"] == 0
    assert provider["supports_websockets"] is False
    assert config["approval_policy"] == "never"
    assert config["sandbox_mode"] == "read-only"
    assert config["web_search"] == "disabled"
    assert config["history"]["persistence"] == "none"
    assert config["shell_environment_policy"]["inherit"] == "none"
    assert config["analytics"]["enabled"] is False
    for feature in ("shell_tool", "unified_exec", "multi_agent", "memories", "image_generation", "apps", "plugins"):
        assert config["features"][feature] is False
    assert "mcp_servers" not in config


def test_candidate_manifest_records_digests_and_stays_pending() -> None:
    candidate = json.loads(CANDIDATE_PATH.read_text(encoding="utf-8"))
    schema = json.loads((ROOT / "docs" / "qualification" / "manifest.schema.json").read_text(encoding="utf-8"))
    assert set(candidate) <= set(schema["properties"])
    assert candidate["status"] == "pending"
    capture = load_capture()
    assert CODEX_BUILD in candidate["harness_build"]
    assert capture["native_binary"]["sha256"] in candidate["harness_build"]
    config_digest = hashlib.sha256(CONFIG_PATH.read_bytes()).hexdigest()
    assert candidate["configuration_digest"] == f"sha256:{config_digest}"
    capture_digest = hashlib.sha256(CAPTURE_PATH.read_bytes()).hexdigest()
    assert capture_digest in candidate["notes"]
    for field in ("validated_resident_session_limit", "validated_active_turn_limit", "review_owner", "reviewed_at"):
        assert candidate[field] is None
    assert "not a validated Codex record" in candidate["notes"]
    assert candidate["evidence_bundle_ref"] is None


def _observation(capture: dict[str, Any] | None = None, **overrides: object) -> CodexObservation:
    frozen = load_capture()
    live = copy.deepcopy(frozen) if capture is None else capture
    values: dict[str, Any] = {
        "binary_found": True,
        "version": CODEX_VERSION,
        "binary_sha256": frozen["native_binary"]["sha256"],
        "capture": live,
        "frozen_capture": frozen,
        "config_digest": "0" * 64,
        "config_accepted": True,
    }
    values.update(overrides)
    return CodexObservation(**values)


def test_exact_build_identity_agrees_across_capture_manifest_inspect_and_factory() -> None:
    capture = load_capture()
    candidate = json.loads(CANDIDATE_PATH.read_text(encoding="utf-8"))
    assert CODEX_BUILD == codex_build_id(CODEX_VERSION, CODEX_NATIVE_SHA256)
    assert capture["harness_build"] == CODEX_BUILD
    assert capture["native_binary"]["sha256"] == CODEX_NATIVE_SHA256
    assert candidate["harness_build"] == CODEX_BUILD
    assert _observation().harness_build == CODEX_BUILD
    assert lab_profile().harness_build == CODEX_BUILD


def test_declared_protocol_never_proves_a_primitive() -> None:
    report = codex_capability_report(_observation())
    assert [item.name for item in report.primitives] == list(REQUIRED_PRIMITIVES)
    assert all(item.state == "unproven" and item.evidence_ref is None for item in report.primitives)
    assert essential_absences(report) == []
    text = " ".join(report.notes)
    assert "No inference was performed" in text
    assert "matches the frozen protocol capture" in text


def test_schema_drift_is_pending_until_recaptured() -> None:
    live = copy.deepcopy(load_capture())
    live["client_requests"] = [name for name in live["client_requests"] if name != "turn/interrupt"]
    live["native_binary"]["sha256"] = "f" * 64
    report = codex_capability_report(_observation(live, binary_sha256="f" * 64))
    # The frozen mapping does not apply to another build, so a renamed method is not demonstrated absence.
    assert all(item.state == "unproven" for item in report.primitives)
    assert essential_absences(report) == []
    assert any("differs from the frozen protocol capture" in note for note in report.notes)
    assert any("turn/interrupt" in note and "recapture" in note for note in report.notes)


def test_exact_frozen_build_lacking_a_mapped_method_is_demonstrated_absence() -> None:
    frozen = copy.deepcopy(load_capture())
    frozen["client_requests"] = [name for name in frozen["client_requests"] if name != "turn/interrupt"]
    report = codex_capability_report(_observation(frozen, frozen_capture=frozen))
    states = {item.name: item.state for item in report.primitives}
    assert states["cancel"] == "absent"
    assert essential_absences(report) == ["cancel"]
    # Automatic compaction needs no manual method, so its absence is never decided from declarations.
    frozen["client_requests"] = [name for name in frozen["client_requests"] if name != "thread/compact/start"]
    compaction = codex_capability_report(_observation(frozen, frozen_capture=frozen))
    assert {item.name: item.state for item in compaction.primitives}["compaction"] == "unproven"


def test_missing_binary_and_feature_conflicts_stay_pending() -> None:
    missing = codex_capability_report(CodexObservation(binary_found=False))
    assert all(item.state == "unproven" for item in missing.primitives)
    assert any("not found" in note for note in missing.notes)
    conflicted = codex_capability_report(_observation(feature_conflicts=["unified_exec"]))
    assert {item.name: item.state for item in conflicted.primitives}["tool_policy"] == "unproven"
    assert any("unified_exec" in note for note in conflicted.notes)


def test_summarize_definition_keeps_only_shape_facts() -> None:
    assert summarize_definition({"enum": ["a", "b"], "type": "string"}) == {"enum": ["a", "b"]}
    tagged = {
        "oneOf": [
            {"properties": {"type": {"enum": ["idle"]}}, "required": ["type"]},
            {"properties": {"type": {"enum": ["active"]}, "flags": {"type": "array"}}, "required": ["type", "flags"]},
        ]
    }
    assert summarize_definition(tagged) == {
        "variants": {
            "active": {"properties": ["flags", "type"], "required": ["flags", "type"]},
            "idle": {"properties": ["type"], "required": ["type"]},
        }
    }
    plain = {"properties": {"b": {"description": "x"}, "a": {}}, "required": ["b"]}
    assert summarize_definition(plain) == {"properties": ["a", "b"], "required": ["b"]}


def _hermetic_env(tmp_path: Path) -> dict[str, str]:
    """No PATH entry can resolve the installed `codex`, so discovery would report it missing."""
    return {"PATH": str(tmp_path / "no-binaries"), "HOME": str(tmp_path)}


def test_discovery_errors_are_reported_as_pending(tmp_path: Path) -> None:
    corrupt = tmp_path / "protocol-schema.json"
    corrupt.write_text("{not json", encoding="utf-8")
    not_a_binary = tmp_path / "codex"
    not_a_binary.mkdir()
    observation = observe_codex(capture_path=corrupt, which=lambda _name: str(not_a_binary))
    assert observation.binary_found is True
    assert observation.frozen_capture is None
    assert observation.binary_sha256 is None
    assert observation.capture is None
    errors = " ".join(observation.errors)
    assert "frozen protocol capture" in errors
    assert "binary digest" in errors
    report = codex_capability_report(observation)
    assert all(item.state == "unproven" for item in report.primitives)
    assert essential_absences(report) == []


def test_cli_inspect_openai_reports_pending_inventory(tmp_path: Path) -> None:
    observation = write_observation(tmp_path / "observation.json")
    completed = subprocess.run(
        [
            sys.executable,
            "scripts/qualify.py",
            "inspect",
            "--provider",
            "openai",
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
    assert payload["harness_build"] == CODEX_BUILD
    report = cast(dict[str, Any], payload["capability_report"])
    names = [item["name"] for item in report["primitives"]]
    assert names == list(REQUIRED_PRIMITIVES)
    assert all(item["state"] != "proven" for item in report["primitives"])
    assert any("recorded observation" in note for note in report["notes"])
    assert payload["status"] == "pending"


def test_cli_recorded_observation_cannot_refreeze_or_apply_to_xai(tmp_path: Path) -> None:
    observation = write_observation(tmp_path / "observation.json")
    base = [sys.executable, "scripts/qualify.py", "inspect", "--observation-file", str(observation)]
    for extra in (["--provider", "openai", "--write-protocol-capture"], ["--provider", "xai"]):
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
