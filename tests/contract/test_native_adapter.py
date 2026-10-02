"""Supervised native adapter: isolation, attribution, fence, and control admission."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest

from esp_contracts.runtime import NativeEvent, SessionHandle
from esp_provider_shared.adapter import UnknownNativeId, UnsupportedPrimitive
from esp_provider_shared.rpc import FRAME_LIMIT_BYTES, FrameTooLarge, NativeRpcClient, decode_frame
from esp_provider_shared.storage_fence import FenceEvidenceMissing
from esp_provider_shared.supervisor import (
    Supervisor,
    UnauthorizedControl,
    WorkloadKeyForbidden,
    authenticate_caller,
)
from esp_provider_shared.transport_context import HookProfileInput, UnattributedCall
from tests.support.fake_harness import BACKEND_FINGERPRINT, OPERATOR_FINGERPRINT, RuntimeLab

REPLACEMENT_INCARNATION = "66666666-6666-4666-8666-666666666666"


class _OversizeTransport:
    async def send_frame(self, payload: bytes) -> None:
        return None

    async def recv_frame(self) -> bytes:
        return b"x" * (FRAME_LIMIT_BYTES + 1)


@pytest.fixture
async def runtime_lab() -> AsyncIterator[RuntimeLab]:
    lab = RuntimeLab()
    try:
        yield lab
    finally:
        await lab.aclose()


def _handles(runtime_lab: RuntimeLab) -> tuple[SessionHandle, SessionHandle]:
    assert runtime_lab.handle_a is not None
    assert runtime_lab.handle_b is not None
    return runtime_lab.handle_a, runtime_lab.handle_b


async def test_interleaved_native_operations_remain_isolated(runtime_lab: RuntimeLab) -> None:
    a, b = await runtime_lab.interleave_with_reversed_rpc_responses()
    assert a.text == "private-canary-A"
    assert b.text == "private-canary-B"
    assert await runtime_lab.peer_after_cancel_a() == "running"
    assert await runtime_lab.unattributed_model_or_tool_starts() == 0
    lost = await runtime_lab.lose_submit_ack()
    assert lost.kind == "unconfirmed"
    assert lost.native_work_ref is None


async def test_attributed_calls_carry_audience_from_operation_context(runtime_lab: RuntimeLab) -> None:
    await runtime_lab.interleave_with_reversed_rpc_responses()
    handle_a, handle_b = _handles(runtime_lab)
    assert len(runtime_lab.model_starts) == 2
    assert len(runtime_lab.tool_starts) == 2
    models = {item["native_session_id"]: item for item in runtime_lab.model_starts}
    tools = {item["native_session_id"]: item for item in runtime_lab.tool_starts}
    assert models[handle_a.native_session_id]["audience"] == "inference"
    assert models[handle_a.native_session_id]["token"] == "inf-A"
    assert models[handle_b.native_session_id]["audience"] == "inference"
    assert models[handle_b.native_session_id]["token"] == "inf-B"
    assert tools[handle_a.native_session_id]["audience"] == "knowledge"
    assert tools[handle_a.native_session_id]["token"] == "know-A"
    assert tools[handle_b.native_session_id]["audience"] == "knowledge"
    assert tools[handle_b.native_session_id]["token"] == "know-B"
    for item in runtime_lab.model_starts + runtime_lab.tool_starts:
        if item["native_session_id"] == handle_b.native_session_id:
            assert item["token"] not in {"inf-A", "know-A"}


async def test_frame_over_limit_is_rejected(runtime_lab: RuntimeLab) -> None:
    await runtime_lab.interleave_with_reversed_rpc_responses()
    with pytest.raises(FrameTooLarge):
        decode_frame(b"Content-Length: 65537\r\n\r\n")
    client = NativeRpcClient(_OversizeTransport())
    with pytest.raises(FrameTooLarge):
        await asyncio.wait_for(client.request("session/inspect", {"native_session_id": "native-a"}), timeout=2)
    handle_a, handle_b = _handles(runtime_lab)
    assert await runtime_lab.history_text(handle_a) == "private-canary-A"
    assert await runtime_lab.history_text(handle_b) == "private-canary-B"


async def test_unknown_native_id_is_rejected(runtime_lab: RuntimeLab) -> None:
    await runtime_lab.interleave_with_reversed_rpc_responses()
    handle_a, handle_b = _handles(runtime_lab)
    ghost = handle_a.model_copy(update={"native_session_id": "native-does-not-exist"})
    with pytest.raises(UnknownNativeId):
        await runtime_lab.adapter.inspect(ghost)
    assert await runtime_lab.history_text(handle_a) == "private-canary-A"
    assert await runtime_lab.history_text(handle_b) == "private-canary-B"


async def test_supervisor_restart_requires_positive_fence(runtime_lab: RuntimeLab) -> None:
    await runtime_lab.interleave_with_reversed_rpc_responses()
    handle_a, handle_b = _handles(runtime_lab)
    unit = handle_a.native_storage_unit_id
    obsolete = handle_a.runtime_incarnation_id
    with pytest.raises(FenceEvidenceMissing):
        await runtime_lab.supervisor.restart_incarnation(
            storage_unit_id=unit,
            obsolete_incarnation_id=obsolete,
            replacement_incarnation_id=REPLACEMENT_INCARNATION,
        )
    assert runtime_lab.supervisor.attached_incarnation(unit) is None
    runtime_lab.fence.observe_revocation(unit, obsolete, "evidence://fence/positive-1")
    receipt = await runtime_lab.supervisor.restart_incarnation(
        storage_unit_id=unit,
        obsolete_incarnation_id=obsolete,
        replacement_incarnation_id=REPLACEMENT_INCARNATION,
    )
    assert receipt.storage_unit_id == unit
    assert receipt.obsolete_incarnation_id == obsolete
    assert receipt.infrastructure_mechanism == "contract-test-observation"
    assert receipt.fence_evidence_ref == "evidence://fence/positive-1"
    assert receipt.verified_at.tzinfo is not None
    assert receipt.verified_at.utcoffset() is not None
    assert runtime_lab.supervisor.attached_incarnation(unit) == REPLACEMENT_INCARNATION
    status = await runtime_lab.adapter.inspect(handle_b)
    assert status.status == "running"


async def test_unauthorized_control_caller_is_rejected(runtime_lab: RuntimeLab) -> None:
    anonymous = authenticate_caller(None, runtime_lab.anchors)
    random_caller = authenticate_caller("12" * 32, runtime_lab.anchors)
    assert anonymous.role == "anonymous"
    assert anonymous.mtls_authenticated is False
    assert anonymous.peer_id == ""
    assert random_caller.role == "anonymous"
    assert random_caller.mtls_authenticated is False
    assert random_caller.peer_id == ""
    before = runtime_lab.fake.submit_count
    with pytest.raises(UnauthorizedControl, match="unauthorized"):
        await runtime_lab.supervisor.call(anonymous, "submit", {"native_session_id": "native-a"})
    with pytest.raises(UnauthorizedControl, match="unauthorized"):
        await runtime_lab.supervisor.call(random_caller, "submit", {"native_session_id": "native-a"})
    assert runtime_lab.fake.submit_count == before

    backend = authenticate_caller(BACKEND_FINGERPRINT, runtime_lab.anchors)
    assert backend.role == "backend"
    assert backend.peer_id == "backend-1"
    assert backend.mtls_authenticated is True
    handle = runtime_lab.sample_handle().model_dump(mode="json")
    with pytest.raises(UnauthorizedControl, match="operator_permission_required"):
        await runtime_lab.supervisor.call(backend, "export", {"handle": handle})
    with pytest.raises(UnauthorizedControl, match="operator_permission_required"):
        await runtime_lab.supervisor.call(backend, "delete", {"handle": handle})
    assert runtime_lab.fake.export_count == 0
    assert runtime_lab.fake.delete_count == 0
    with pytest.raises(UnauthorizedControl, match="method_not_allowlisted"):
        await runtime_lab.supervisor.call(backend, "shell", {})
    assert runtime_lab.fake.submit_count == before

    operator = authenticate_caller(OPERATOR_FINGERPRINT, runtime_lab.anchors)
    assert operator.role == "operator"
    assert operator.peer_id == "operator-1"
    assert operator.mtls_authenticated is True
    with pytest.raises(UnsupportedPrimitive) as caught:
        await runtime_lab.supervisor.call(operator, "export", {"handle": handle})
    assert caught.value.primitive == "export"


async def test_workload_has_no_signing_key(runtime_lab: RuntimeLab) -> None:
    with pytest.raises(WorkloadKeyForbidden):
        Supervisor(runtime_lab.adapter, runtime_lab.fence, instance_id=runtime_lab.instance_id, signer=object())
    material = runtime_lab.supervisor.workload_material()
    assert material["instance_id"] == runtime_lab.instance_id
    assert "signing_key" not in material
    rendered = " ".join(material.values())
    assert "PRIVATE" not in rendered
    assert "signing_key" not in rendered

    await runtime_lab.interleave_with_reversed_rpc_responses()
    handle_a, _handle_b = _handles(runtime_lab)
    backend = authenticate_caller(BACKEND_FINGERPRINT, runtime_lab.anchors)
    assert runtime_lab.transport.start_model_call(handle_a.native_session_id)["token"] == "inf-A"
    for forbidden in ("signing_key", "private_key"):
        params = {
            "native_session_id": handle_a.native_session_id,
            "inference_token": "inf-should-not-apply",
            "knowledge_token": "know-A",
            forbidden: "do-not-store",
        }
        with pytest.raises(WorkloadKeyForbidden):
            await runtime_lab.supervisor.call(backend, "token-refresh", params)
    assert runtime_lab.transport.start_model_call(handle_a.native_session_id)["token"] == "inf-A"
    await runtime_lab.supervisor.call(
        backend,
        "token-refresh",
        {
            "native_session_id": handle_a.native_session_id,
            "inference_token": "inf-rotated",
            "knowledge_token": "know-A",
        },
    )
    started = runtime_lab.transport.start_model_call(handle_a.native_session_id)
    assert started["audience"] == "inference"
    assert started["token"] == "inf-rotated"
    assert started["native_session_id"] == handle_a.native_session_id


async def test_export_and_delete_absent_are_unsupported_not_success(runtime_lab: RuntimeLab) -> None:
    await runtime_lab.interleave_with_reversed_rpc_responses()
    handle_a, handle_b = _handles(runtime_lab)
    operator = authenticate_caller(OPERATOR_FINGERPRINT, runtime_lab.anchors)
    exported = handle_a.model_dump(mode="json")
    deleted = handle_b.model_dump(mode="json")
    with pytest.raises(UnsupportedPrimitive) as export_error:
        await runtime_lab.supervisor.call(operator, "export", {"handle": exported})
    assert export_error.value.primitive == "export"
    with pytest.raises(UnsupportedPrimitive) as delete_error:
        await runtime_lab.supervisor.call(operator, "delete", {"handle": deleted})
    assert delete_error.value.primitive == "delete"
    assert runtime_lab.fake.export_count >= 1
    assert runtime_lab.fake.delete_count >= 1
    assert await runtime_lab.history_text(handle_a) == "private-canary-A"
    assert await runtime_lab.history_text(handle_b) == "private-canary-B"


async def test_stdio_wrapper_cannot_invent_context(runtime_lab: RuntimeLab) -> None:
    await runtime_lab.interleave_with_reversed_rpc_responses()
    handle_a, _handle_b = _handles(runtime_lab)
    runtime_lab.transport.bind_from_stdio_wrapper(
        {"ESP_NATIVE_SESSION_ID": "forged", "ESP_INFERENCE_TOKEN": "forged-token"}
    )
    started = runtime_lab.transport.start_model_call(handle_a.native_session_id)
    assert started["token"] == "inf-A"
    assert started["audience"] == "inference"
    runtime_lab.transport.note_profile_input(HookProfileInput(hook_patch_digest="c" * 64, profile_digest="d" * 64))
    with pytest.raises(UnattributedCall):
        runtime_lab.transport.start_model_call("forged")
    with pytest.raises(UnattributedCall):
        runtime_lab.transport.start_model_call("profile-only-id")


async def test_events_are_demultiplexed_by_native_id(runtime_lab: RuntimeLab) -> None:
    await runtime_lab.interleave_with_reversed_rpc_responses()
    handle_a, handle_b = _handles(runtime_lab)
    before = runtime_lab.adapter.rejected_events
    runtime_lab.fake.notify(
        "session/event",
        runtime_lab.event_params(handle_b, text="only-b", work="work-event-b", run_id=runtime_lab.run_b),
    )
    runtime_lab.fake.notify("session/event", {"payload_type": "text", "payload": {"text": "missing-id"}})
    runtime_lab.fake.notify(
        "session/event",
        runtime_lab.event_params(handle_a, text="only-a", work="work-event-a", run_id=runtime_lab.run_a),
    )
    await runtime_lab.fake.wait_idle()
    assert runtime_lab.adapter.rejected_events >= before + 1

    async def first_event() -> NativeEvent:
        async for event in runtime_lab.adapter.events(handle_a):
            return event
        raise AssertionError("event stream ended without a yield")

    event = await asyncio.wait_for(first_event(), timeout=2)
    assert event.native_session_id == handle_a.native_session_id
    assert event.native_work_ref == "work-event-a"
    assert event.payload["text"] == "only-a"
    assert runtime_lab.adapter.rejected_events >= 1
