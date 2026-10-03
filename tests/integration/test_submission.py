"""Submit once and reconcile native acceptance and status (P §§7.1, 12.4, 12.7, 13).

Real PostgreSQL as the restricted `esp_app` role, real Valkey counters and the real shared native
adapter (`HarnessAdapter` over `NativeRpcClient`) reach an in-memory native harness. A lost
acknowledgement, a transport refusal and a native refusal therefore take the adapter's real paths.
Only proved native acceptance is reported as accepted; uncertainty keeps the guard and is never a clean
rejection; conclusive non-acceptance releases the reservation and permits a manual resubmission.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import time
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest

from esp_api.config import ConfigurationError
from esp_api.server import build_api
from esp_contracts.api import ErrorResponse, SubmissionView, SubmitMessage
from esp_contracts.ids import Audience
from esp_contracts.runtime import Accepted, NotSubmitted, SubmissionResult, Unconfirmed
from esp_espcon.conversation import ConversationNotFound
from esp_execution_bindings.binding import verify_binding
from esp_execution_bindings.dispatch_fence import revoke_mapping
from esp_provider_router.router import POOL_FOR_PROVIDER, ProviderRouter, resolve_pool
from esp_request_admission.admit import Admitted, DuplicateActive, Rejected
from esp_request_admission.rate_limits import RatePolicy, open_counter_client
from esp_runtime_harconses.manager import SessionLimits
from scripts.migrate import migrate
from tests.support.admission import LAB_RATE_POLICY, VALKEY_URL
from tests.support.database import APP_DSN
from tests.support.submission import (
    DRAFT,
    NativeCluster,
    PoolClient,
    SubmissionLab,
    close_submission_lab,
    open_submission_lab,
    post_message,
)


@pytest.fixture
async def submission_lab(tmp_path: Path) -> AsyncIterator[SubmissionLab]:
    await migrate(APP_DSN)
    lab = await open_submission_lab(tmp_path)
    try:
        yield lab
    finally:
        await close_submission_lab(lab)


def body(conversation_id: str, request_id: str, message: str = DRAFT, **extra: object) -> dict[str, object]:
    return {"conversation_id": conversation_id, "client_request_id": request_id, "message": message, **extra}


def sse_envelopes(text: str) -> list[dict[str, Any]]:
    envelopes: list[dict[str, Any]] = []
    for frame in text.split("\n\n"):
        data = [line[len("data: ") :] for line in frame.split("\n") if line.startswith("data: ")]
        if data:
            envelopes.append(json.loads("\n".join(data)))
    return envelopes


# The plan's named acceptance-fault test


async def test_lost_acceptance_is_not_a_clean_rejection(submission_lab: SubmissionLab) -> None:
    assert (await submission_lab.fail_before_send()).kind == "not_submitted"
    assert (await submission_lab.lose_ack_after_native_save()).kind == "unconfirmed"
    assert await submission_lab.guard_held_after_unknown()
    assert await submission_lab.duplicate_active_submit_count() == 1
    assert await submission_lab.completed_after_backend_restart() == submission_lab.native_answer
    assert not (await submission_lab.uncorrelated_old_request()).resubmission_allowed


# Routing


def test_each_provider_routes_to_its_fixed_pool() -> None:
    assert resolve_pool("openai") == "codex"
    assert resolve_pool("xai") == "grok_build"
    assert dict(POOL_FOR_PROVIDER) == {"openai": "codex", "xai": "grok_build"}
    codex, grok = PoolClient(NativeCluster()), PoolClient(NativeCluster())
    router = ProviderRouter.for_providers({"openai": codex, "xai": grok})
    assert router.adapter_for("openai") is codex
    assert router.adapter_for("xai") is grok
    with pytest.raises(ValueError):
        resolve_pool("anthropic")  # type: ignore[arg-type]


def test_a_missing_pool_is_unavailable_not_rerouted() -> None:
    router = ProviderRouter.for_providers({"openai": PoolClient(NativeCluster())})
    with pytest.raises(LookupError):
        router.adapter_for("xai")


# Conclusive non-acceptance


async def test_refused_before_send_releases_the_reservation_and_permits_manual_resubmit(
    submission_lab: SubmissionLab,
) -> None:
    conv = await submission_lab.conversation()
    admitted = await submission_lab.admit(conv, "req-refused")
    submission_lab.process.refuse_send.add("session/submit")
    result = await submission_lab.manager().submit_message(admitted, submission_lab.message(conv, "req-refused"))

    assert isinstance(result, NotSubmitted)
    assert result.code == "not_sent"
    assert submission_lab.cluster.submissions("req-refused") == 0
    mapping = await submission_lab.mapping(conv)
    assert mapping is not None
    assert await submission_lab.guard(conv) is None
    assert mapping["active_agent_run_id"] is None
    assert mapping["current_request_id"] is None
    assert await submission_lab.run_slots(str(mapping["id"])) == ["resident"]
    assert mapping["native_session_id"] is not None

    retried = await submission_lab.submit(conv, "req-refused")
    assert isinstance(retried, Accepted)
    assert submission_lab.cluster.submissions("req-refused") == 1


async def test_native_refusal_is_conclusive_and_released(submission_lab: SubmissionLab) -> None:
    conv = await submission_lab.conversation()
    submission_lab.process.native_refusal = "native_rejected"
    result = await submission_lab.submit(conv, "req-native-refusal")
    assert isinstance(result, NotSubmitted)
    assert result.code == "native_rejected"
    assert await submission_lab.guard(conv) is None


async def test_setup_failure_reports_not_started_and_keeps_the_mapping(submission_lab: SubmissionLab) -> None:
    conv = await submission_lab.conversation()
    submission_lab.process.fail.add("session/create")
    result = await submission_lab.submit(conv, "req-setup-fails")

    assert isinstance(result, NotSubmitted)
    assert result.code == "create_failed"
    assert submission_lab.process.calls["session/submit"] == 0
    mapping = await submission_lab.mapping(conv)
    assert mapping is not None
    assert mapping["native_session_id"] is None
    assert mapping["active_agent_run_id"] is None
    assert await submission_lab.guard(conv) is None

    retried = await submission_lab.submit(conv, "req-setup-fails")
    assert isinstance(retried, Accepted)


async def test_setup_timeout_is_bounded_and_not_started(tmp_path: Path) -> None:
    await migrate(APP_DSN)
    lab = await open_submission_lab(
        tmp_path, limits=SessionLimits(acceptance_budget_seconds=0.5, read_timeout_seconds=1)
    )
    try:
        conv = await lab.conversation()
        lab.process.hang.add("session/create")
        started = time.monotonic()
        result = await lab.submit(conv, "req-setup-hangs")
        elapsed = time.monotonic() - started
        assert isinstance(result, NotSubmitted)
        assert result.code == "setup_timeout"
        assert elapsed < 2.0
        assert await lab.guard(conv) is None
        assert lab.process.calls["session/submit"] == 0
    finally:
        await close_submission_lab(lab)


async def test_native_id_is_registered_conditionally_before_scopes_are_minted(submission_lab: SubmissionLab) -> None:
    conv = await submission_lab.conversation()
    admitted = await submission_lab.admit(conv, "req-revoked-in-setup")

    async def revoke_during_create(_params: dict[str, Any]) -> None:
        assert await revoke_mapping(
            submission_lab.admission.admin,
            admitted.reservation.provider_session_id,
            admitted.reservation.ownership_epoch,
        )

    submission_lab.process.before["session/create"] = revoke_during_create
    result = await submission_lab.manager().submit_message(
        admitted, submission_lab.message(conv, "req-revoked-in-setup")
    )

    assert isinstance(result, NotSubmitted)
    assert result.code == "authority_changed"
    assert submission_lab.process.calls["session/submit"] == 0
    assert submission_lab.process.submitted_tokens == []
    mapping = await submission_lab.mapping(conv)
    assert mapping is not None
    assert mapping["native_session_id"] is None
    assert mapping["runtime_state"] == "unavailable"


async def test_accepted_submission_carries_scopes_for_the_registered_native_id(submission_lab: SubmissionLab) -> None:
    conv = await submission_lab.conversation()
    admitted = await submission_lab.admit(conv, "req-scoped")
    observed: dict[str, Any] = {}

    async def observe_registration(params: dict[str, Any]) -> None:
        mapping = await submission_lab.mapping(conv)
        assert mapping is not None
        observed.update(mapping)
        observed["submitted_native_id"] = params["native_session_id"]

    submission_lab.process.before["session/submit"] = observe_registration
    result = await submission_lab.manager().submit_message(admitted, submission_lab.message(conv, "req-scoped"))

    assert isinstance(result, Accepted)
    native_id = result.work.native_session_id
    assert observed["native_session_id"] == native_id == observed["submitted_native_id"]
    assert observed["runtime_state"] == "running"
    assert native_id in submission_lab.cluster.processes[admitted.reservation.harness_instance_id].loaded
    [(token_native_id, inference_token, knowledge_token)] = submission_lab.process.submitted_tokens
    assert token_native_id == native_id
    audiences: tuple[tuple[str, Audience], ...] = ((inference_token, "inference"), (knowledge_token, "knowledge"))
    for token, audience in audiences:
        binding = verify_binding(token, audience, verifier=submission_lab.verifier)
        assert binding.native_session_id == native_id
        assert binding.active_agent_run_id == admitted.authority.active_agent_run_id
        assert binding.ownership_epoch == admitted.authority.ownership_epoch
        assert binding.harness_instance_id == admitted.reservation.harness_instance_id
        assert binding.brain_hash == admitted.reservation.brain_hash
    mapping = await submission_lab.mapping(conv)
    assert mapping is not None
    assert mapping["current_native_work_ref"] == result.work.native_work_ref
    assert await submission_lab.guard(conv) == admitted.reservation.provider_session_id


async def test_setup_uses_only_the_reserved_instance(submission_lab: SubmissionLab) -> None:
    other = await submission_lab.add_instance(resident=4, active=4)
    conv = await submission_lab.conversation()
    admitted = await submission_lab.admit(conv, "req-placed")
    reserved = submission_lab.cluster.processes[admitted.reservation.harness_instance_id]
    result = await submission_lab.manager().submit_message(admitted, submission_lab.message(conv, "req-placed"))
    assert isinstance(result, Accepted)
    assert result.work.native_session_id in reserved.loaded
    unreserved = other if other is not reserved else submission_lab.process
    assert unreserved.calls["session/create"] == 0


async def test_resident_and_resumed_sessions_submit_to_the_same_native_id(submission_lab: SubmissionLab) -> None:
    conv = await submission_lab.conversation()
    first = await submission_lab.submit(conv, "req-first")
    assert isinstance(first, Accepted)
    native_id = first.work.native_session_id
    store = submission_lab.cluster.session_store(native_id)
    store.complete(native_id, "req-first", "first answer")
    await submission_lab.terminal_clear(conv)

    creates = submission_lab.process.calls["session/create"]
    second = await submission_lab.submit(conv, "req-second")
    assert isinstance(second, Accepted)
    assert second.work.native_session_id == native_id
    assert submission_lab.process.calls["session/create"] == creates
    assert submission_lab.process.calls["session/resume"] == 0

    store.complete(native_id, "req-second", "second answer")
    await submission_lab.terminal_clear(conv)
    await submission_lab.unload(conv)
    third = await submission_lab.submit(conv, "req-third")
    assert isinstance(third, Accepted)
    assert third.work.native_session_id == native_id
    assert submission_lab.process.calls["session/resume"] == 1
    assert submission_lab.process.calls["session/create"] == creates
    assert store.texts(native_id)[:4] == [DRAFT, "first answer", DRAFT, "second answer"]


async def test_two_conversations_on_one_process_keep_distinct_native_sessions(submission_lab: SubmissionLab) -> None:
    conv_a, conv_b = await submission_lab.conversation(), await submission_lab.conversation()
    result_a, result_b = await asyncio.gather(
        submission_lab.submit(conv_a, "req-a", "canary A", backend=0),
        submission_lab.submit(conv_b, "req-b", "canary B", backend=1),
    )
    assert isinstance(result_a, Accepted) and isinstance(result_b, Accepted)
    assert result_a.work.native_session_id != result_b.work.native_session_id
    history_a = await submission_lab.manager().read_authorized_history(conv_a.subject_id, conv_a.conversation_id)
    history_b = await submission_lab.manager().read_authorized_history(conv_b.subject_id, conv_b.conversation_id)
    assert [item.text for item in history_a.items] == ["canary A"]
    assert [item.text for item in history_b.items] == ["canary B"]


# Uncertainty


async def test_withheld_acknowledgement_is_unconfirmed_within_the_budget(tmp_path: Path) -> None:
    await migrate(APP_DSN)
    lab = await open_submission_lab(
        tmp_path, limits=SessionLimits(acceptance_budget_seconds=0.5, read_timeout_seconds=1)
    )
    try:
        conv = await lab.conversation()
        admitted = await lab.admit(conv, "req-withheld")
        lab.process.withhold_submit_ack = True
        started = time.monotonic()
        result = await lab.manager().submit_message(admitted, lab.message(conv, "req-withheld"))
        assert time.monotonic() - started < 2.0
        assert isinstance(result, Unconfirmed)
        assert await lab.guard(conv) == admitted.reservation.provider_session_id
        assert lab.cluster.submissions("req-withheld") == 1
        mapping = await lab.mapping(conv)
        assert mapping is not None
        assert mapping["active_agent_run_id"] == admitted.authority.active_agent_run_id
        view = await lab.manager().inspect_submission(conv.subject_id, conv.conversation_id, "req-withheld")
        assert view.outcome == "running"
        assert view.native_work_ref is not None
        assert not view.resubmission_allowed
    finally:
        await close_submission_lab(lab)


async def test_unknown_submission_is_never_submitted_again(submission_lab: SubmissionLab) -> None:
    result = await submission_lab.lose_ack_after_native_save()
    assert isinstance(result, Unconfirmed)
    conv, admitted = await submission_lab.unknown_state()
    repeated = await submission_lab.admission.admit(conv, admitted.client_request_id, backend=1)
    assert isinstance(repeated, DuplicateActive)
    other = await submission_lab.admission.admit(conv, "req-another", backend=1)
    assert isinstance(other, Rejected) and other.code == "conversation_busy"
    assert submission_lab.cluster.submissions(admitted.client_request_id) == 1


# HTTP boundary


async def test_accepted_stream_is_constructed_only_after_native_acceptance(submission_lab: SubmissionLab) -> None:
    visitor = await submission_lab.visitor()
    conversation_id = await submission_lab.created(visitor)
    response = await post_message(visitor, conversation_id, body(conversation_id, "req-http-accepted"))

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["x-esp-acceptance"] == "accepted"
    mapping = await submission_lab.mapping(conversation_id)
    assert mapping is not None
    [envelope] = sse_envelopes(response.text)
    assert envelope["protocol_version"] == 1
    assert envelope["conversation_id"] == conversation_id
    assert envelope["provider_session_id"] == mapping["id"]
    assert envelope["activeAgentRunId"] == mapping["active_agent_run_id"]
    assert envelope["nativeWorkRef"] == mapping["current_native_work_ref"] is not None
    assert envelope["sequence"] == 1
    assert envelope["event"] == {"type": "session_status", "status": "running"}
    assert submission_lab.cluster.submissions("req-http-accepted") == 1


async def test_lost_acknowledgement_is_a_409_with_status_link(submission_lab: SubmissionLab) -> None:
    visitor = await submission_lab.visitor()
    conversation_id = await submission_lab.created(visitor)
    submission_lab.process.lose_ack_after_save = True
    response = await post_message(visitor, conversation_id, body(conversation_id, "req-http-lost"))

    assert response.status_code == 409
    assert "x-esp-acceptance" not in response.headers or response.headers["x-esp-acceptance"] == "unconfirmed"
    payload = response.json()
    assert payload["error"]["code"] == "submission_unconfirmed"
    assert payload["error"]["retryable"] is False
    assert payload["submitted"] is None
    assert payload["resubmission_allowed"] is False
    assert payload["status_url"] == f"/conversations/{conversation_id}/status?client_request_id=req-http-lost"
    assert await submission_lab.guard(conversation_id) is not None

    other = submission_lab.same_browser(visitor, 1)
    status = await other.client.get(payload["status_url"])
    assert status.status_code == 200
    view = SubmissionView.model_validate(status.json())
    assert view.outcome == "running"
    assert not view.resubmission_allowed


async def test_not_submitted_is_a_clean_rejection_and_the_draft_can_be_resent(submission_lab: SubmissionLab) -> None:
    visitor = await submission_lab.visitor()
    conversation_id = await submission_lab.created(visitor)
    submission_lab.process.refuse_send.add("session/submit")
    response = await post_message(visitor, conversation_id, body(conversation_id, "req-http-refused"))

    assert response.status_code == 503
    error = ErrorResponse.model_validate(response.json())
    assert error.submitted is False
    assert error.error.code == "service_unavailable"
    assert error.error.retryable is True
    assert await submission_lab.guard(conversation_id) is None

    retried = await post_message(visitor, conversation_id, body(conversation_id, "req-http-refused"))
    assert retried.status_code == 200
    assert retried.headers["x-esp-acceptance"] == "accepted"


async def test_no_input_is_stored_by_the_application(submission_lab: SubmissionLab) -> None:
    visitor = await submission_lab.visitor()
    conversation_id = await submission_lab.created(visitor)
    accepted_text = f"accepted canary {uuid.uuid4().hex}"
    lost_text = f"lost canary {uuid.uuid4().hex}"
    refused_text = f"refused canary {uuid.uuid4().hex}"
    assert (
        await post_message(visitor, conversation_id, body(conversation_id, "req-c1", accepted_text))
    ).status_code == 200
    await submission_lab.terminal_clear(conversation_id)
    submission_lab.process.lose_ack_after_save = True
    assert (await post_message(visitor, conversation_id, body(conversation_id, "req-c2", lost_text))).status_code == 409

    second = await submission_lab.visitor(1)
    other_id = await submission_lab.created(second)
    submission_lab.process.refuse_send.add("session/submit")
    assert (await post_message(second, other_id, body(other_id, "req-c3", refused_text))).status_code == 503
    for text in (accepted_text, lost_text, refused_text):
        assert await submission_lab.admission.stored_text_occurrences(text) == []


async def test_provider_override_is_rejected_before_admission(submission_lab: SubmissionLab) -> None:
    visitor = await submission_lab.visitor()
    conversation_id = await submission_lab.created(visitor)
    limiter = submission_lab.admission.backends[0].limiter
    for override in ({"provider": "xai"}, {"harness": "grok-build"}, {"model": "another-model"}):
        response = await post_message(visitor, conversation_id, body(conversation_id, "req-override", **override))
        assert response.status_code == 400
        error = ErrorResponse.model_validate(response.json())
        assert error.error.code == "provider_override_rejected"
        assert error.submitted is False
    assert await submission_lab.mapping(conversation_id) is None
    assert submission_lab.cluster.total_calls() == 0
    client = open_counter_client(VALKEY_URL, timeout_seconds=1.0)
    try:
        assert await client.exists(limiter.key_for(visitor.subject_id, LAB_RATE_POLICY)) == 0
    finally:
        await client.aclose()


async def test_request_validation_happens_before_admission(submission_lab: SubmissionLab) -> None:
    visitor = await submission_lab.visitor()
    conversation_id = await submission_lab.created(visitor)
    other_id = str(uuid.uuid4())

    mismatched = await post_message(visitor, conversation_id, body(other_id, "req-mismatch"))
    assert mismatched.status_code == 400
    assert ErrorResponse.model_validate(mismatched.json()).error.code == "conversation_mismatch"
    oversized = await post_message(visitor, conversation_id, body(conversation_id, "req-big", "x" * 8193))
    assert oversized.status_code == 413
    blank = await post_message(visitor, conversation_id, body(conversation_id, "req-blank", "   "))
    assert blank.status_code == 400
    unknown = await post_message(visitor, conversation_id, body(conversation_id, "req-extra", priority="high"))
    assert unknown.status_code == 400
    assert ErrorResponse.model_validate(unknown.json()).error.code == "invalid_request"
    missing_csrf = await visitor.client.post(
        f"/conversations/{conversation_id}/messages",
        content=json.dumps(body(conversation_id, "req-csrf")).encode(),
        headers=visitor.write_headers(csrf=""),
    )
    assert missing_csrf.status_code == 403
    assert await submission_lab.mapping(conversation_id) is None
    assert submission_lab.cluster.total_calls() == 0


async def test_another_owner_cannot_submit_or_inspect(submission_lab: SubmissionLab) -> None:
    owner = await submission_lab.visitor()
    conversation_id = await submission_lab.created(owner)
    intruder = await submission_lab.visitor(1)

    response = await post_message(intruder, conversation_id, body(conversation_id, "req-intruder"))
    assert response.status_code == 404
    assert ErrorResponse.model_validate(response.json()).submitted is False
    status = await intruder.client.get(f"/conversations/{conversation_id}/status?client_request_id=req-intruder")
    assert status.status_code == 404
    assert ErrorResponse.model_validate(status.json()).submitted is None
    assert await submission_lab.mapping(conversation_id) is None
    assert submission_lab.cluster.total_calls() == 0
    with pytest.raises(ConversationNotFound):
        await submission_lab.manager().inspect_submission(intruder.subject_id, conversation_id, "req-intruder")


async def test_rejections_before_submission_keep_their_codes(submission_lab: SubmissionLab) -> None:
    visitor = await submission_lab.visitor()
    conversation_id = await submission_lab.created(visitor)
    submission_lab.process.lose_ack_after_save = True
    assert (await post_message(visitor, conversation_id, body(conversation_id, "req-owner"))).status_code == 409
    busy = await post_message(visitor, conversation_id, body(conversation_id, "req-other"))
    assert busy.status_code == 409
    error = ErrorResponse.model_validate(busy.json())
    assert error.error.code == "conversation_busy"
    assert error.submitted is False
    assert submission_lab.cluster.submissions("req-other") == 0


# Status


async def test_status_reconciles_without_model_work(submission_lab: SubmissionLab) -> None:
    conv = await submission_lab.conversation()
    manager = submission_lab.manager()
    before = await manager.inspect_submission(conv.subject_id, conv.conversation_id, "req-status")
    assert before.outcome == "not_started" and before.resubmission_allowed
    assert before.active_agent_run_id is None and before.runtime_state is None

    admitted = await submission_lab.admit(conv, "req-status")
    in_setup = await manager.inspect_submission(conv.subject_id, conv.conversation_id, "req-status")
    assert in_setup.outcome == "not_started"
    assert not in_setup.resubmission_allowed
    assert in_setup.active_agent_run_id == admitted.authority.active_agent_run_id

    result = await manager.submit_message(admitted, submission_lab.message(conv, "req-status"))
    assert isinstance(result, Accepted)
    work_calls = submission_lab.cluster.work_calls()
    running = await submission_lab.manager(1).inspect_submission(conv.subject_id, conv.conversation_id, "req-status")
    assert running.outcome == "running"
    assert running.native_work_ref == result.work.native_work_ref
    assert running.active_agent_run_id == admitted.authority.active_agent_run_id
    assert running.runtime_state == "running"

    native_id = result.work.native_session_id
    submission_lab.cluster.session_store(native_id).complete(native_id, "req-status", "done natively")
    completed = await manager.inspect_submission(conv.subject_id, conv.conversation_id, "req-status")
    assert completed.outcome == "completed"
    assert not completed.resubmission_allowed
    assert completed.active_agent_run_id == admitted.authority.active_agent_run_id
    assert completed.runtime_state == "running"
    assert await submission_lab.guard(conv) == admitted.reservation.provider_session_id
    assert submission_lab.cluster.work_calls() == work_calls

    await submission_lab.terminal_clear(conv)
    later = await submission_lab.submit(conv, "req-status-later")
    assert isinstance(later, Accepted)
    old = await manager.inspect_submission(conv.subject_id, conv.conversation_id, "req-status")
    assert old.outcome == "completed"
    assert old.active_agent_run_id is None
    assert old.native_work_ref == result.work.native_work_ref


async def test_status_of_an_old_request_without_a_native_session_is_not_started(
    submission_lab: SubmissionLab,
) -> None:
    conv = await submission_lab.conversation()
    submission_lab.process.fail.add("session/create")
    failed = await submission_lab.submit(conv, "req-never-native")
    assert isinstance(failed, NotSubmitted)
    view = await submission_lab.manager().inspect_submission(conv.subject_id, conv.conversation_id, "req-never-native")
    assert view.outcome == "not_started"
    assert view.resubmission_allowed


async def test_status_is_unavailable_when_native_inspection_fails(submission_lab: SubmissionLab) -> None:
    visitor = await submission_lab.visitor()
    conversation_id = await submission_lab.created(visitor)
    assert (await post_message(visitor, conversation_id, body(conversation_id, "req-inspect"))).status_code == 200
    submission_lab.process.fail.add("session/inspect")
    response = await visitor.client.get(f"/conversations/{conversation_id}/status?client_request_id=req-inspect")
    assert response.status_code == 503
    error = ErrorResponse.model_validate(response.json())
    assert error.error.code == "service_unavailable"
    assert error.submitted is None
    assert error.error.retryable is True
    missing = await visitor.client.get(f"/conversations/{conversation_id}/status")
    assert missing.status_code == 400


async def test_duplicate_returns_status_without_a_second_submission(submission_lab: SubmissionLab) -> None:
    visitor = await submission_lab.visitor()
    conversation_id = await submission_lab.created(visitor)
    first = await post_message(visitor, conversation_id, body(conversation_id, "req-dup-http"))
    assert first.status_code == 200
    again = await post_message(
        submission_lab.same_browser(visitor, 1), conversation_id, body(conversation_id, "req-dup-http")
    )
    assert again.status_code == 200
    assert again.headers["x-esp-acceptance"] == "duplicate"
    assert again.headers["content-type"].startswith("application/json")
    view = SubmissionView.model_validate(again.json())
    assert view.outcome == "running"
    assert submission_lab.cluster.submissions("req-dup-http") == 1


async def test_a_request_that_admission_could_not_place_submits_nothing(submission_lab: SubmissionLab) -> None:
    visitor = await submission_lab.visitor()
    conversation_id = await submission_lab.created(visitor)
    await submission_lab.admission.set_provider(limit=0)
    response = await post_message(visitor, conversation_id, body(conversation_id, "req-no-capacity"))
    assert response.status_code == 503
    error = ErrorResponse.model_validate(response.json())
    assert error.error.code == "capacity_unavailable"
    assert error.submitted is False
    assert submission_lab.cluster.total_calls() == 0


async def test_submission_needs_the_same_request_identity(submission_lab: SubmissionLab) -> None:
    conv = await submission_lab.conversation()
    admitted = await submission_lab.admit(conv, "req-identity")
    with pytest.raises(ValueError):
        await submission_lab.manager().submit_message(
            admitted,
            SubmitMessage(conversation_id=conv.conversation_id, client_request_id="req-other-identity", message=DRAFT),
        )
    assert submission_lab.cluster.total_calls() == 0


async def test_scopes_are_not_minted_after_the_lease_expired(submission_lab: SubmissionLab) -> None:
    conv = await submission_lab.conversation()
    admitted = await submission_lab.admit(conv, "req-lease")

    async def expire_lease(_params: dict[str, Any]) -> None:
        await submission_lab.execute(
            "UPDATE provider_session SET owner_lease_expires_at = now() - interval '1 second' WHERE id = %s",
            (admitted.reservation.provider_session_id,),
        )

    submission_lab.process.before["session/create"] = expire_lease
    result = await submission_lab.manager().submit_message(admitted, submission_lab.message(conv, "req-lease"))
    assert isinstance(result, NotSubmitted)
    assert result.code == "lease_expired"
    assert submission_lab.process.calls["session/submit"] == 0
    assert submission_lab.process.submitted_tokens == []


async def test_cancellation_intent_during_setup_stops_the_submission(submission_lab: SubmissionLab) -> None:
    conv = await submission_lab.conversation()
    admitted = await submission_lab.admit(conv, "req-cancelled-setup")

    async def request_cancel(_params: dict[str, Any]) -> None:
        await submission_lab.execute(
            "UPDATE provider_session SET cancel_requested_at = now() WHERE id = %s",
            (admitted.reservation.provider_session_id,),
        )

    submission_lab.process.before["session/create"] = request_cancel
    result = await submission_lab.manager().submit_message(
        admitted, submission_lab.message(conv, "req-cancelled-setup")
    )
    assert isinstance(result, NotSubmitted)
    assert result.code == "authority_changed"
    assert submission_lab.process.calls["session/submit"] == 0
    # Nothing reached the harness, so the cancelled run is released like any other unsubmitted one.
    mapping = await submission_lab.mapping(conv)
    assert mapping is not None
    assert mapping["active_agent_run_id"] is None
    assert await submission_lab.guard(conv) is None


async def test_rate_limited_messages_are_refused_with_retry_guidance(submission_lab: SubmissionLab) -> None:
    tight = RatePolicy(
        policy_id="test-submission-tight", window_seconds=3600, capacity=1, refill=1, expiry_seconds=3600
    )
    runtime = await submission_lab.restarted_backend(rate_policy=tight)
    visitor = await submission_lab.admission.api.visitor(runtime.app)
    submission_lab.admission.track_counter(visitor.subject_id, tight)
    first_id, second_id = await submission_lab.created(visitor), await submission_lab.created(visitor)
    assert (await post_message(visitor, first_id, body(first_id, "req-rate-1"))).status_code == 200
    limited = await post_message(visitor, second_id, body(second_id, "req-rate-2"))
    assert limited.status_code == 429
    assert int(limited.headers["retry-after"]) >= 1
    error = ErrorResponse.model_validate(limited.json())
    assert error.error.code == "rate_limited"
    assert error.submitted is False
    assert await submission_lab.mapping(second_id) is None
    assert submission_lab.cluster.submissions("req-rate-2") == 0


async def test_without_a_counter_store_messages_are_refused_but_status_works(submission_lab: SubmissionLab) -> None:
    api = submission_lab.admission.api
    visitor = await api.visitor(api.build())
    conversation_id = await submission_lab.created(visitor)
    response = await post_message(visitor, conversation_id, body(conversation_id, "req-no-counters"))
    assert response.status_code == 503
    error = ErrorResponse.model_validate(response.json())
    assert error.error.code == "service_unavailable"
    assert error.submitted is False
    assert await submission_lab.mapping(conversation_id) is None
    status = await visitor.client.get(f"/conversations/{conversation_id}/status?client_request_id=req-no-counters")
    assert status.status_code == 200
    assert SubmissionView.model_validate(status.json()).outcome == "not_started"
    with pytest.raises(ConfigurationError):
        build_api(dataclasses.replace(api.dependencies(), counters=submission_lab.admission.backends[0].limiter))


async def test_an_abandoned_http_request_still_settles_its_submission(submission_lab: SubmissionLab) -> None:
    visitor = await submission_lab.visitor()
    conversation_id = await submission_lab.created(visitor)
    entered, proceed = asyncio.Event(), asyncio.Event()

    async def hold_create(_params: dict[str, Any]) -> None:
        entered.set()
        await proceed.wait()

    submission_lab.process.before["session/create"] = hold_create
    request = asyncio.create_task(post_message(visitor, conversation_id, body(conversation_id, "req-abandoned")))
    await asyncio.wait_for(entered.wait(), timeout=2)
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request
    proceed.set()
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        mapping = await submission_lab.mapping(conversation_id)
        if mapping is not None and mapping["current_native_work_ref"] is not None:
            break
        await asyncio.sleep(0.02)
    mapping = await submission_lab.mapping(conversation_id)
    assert mapping is not None
    assert mapping["current_native_work_ref"] is not None
    assert submission_lab.cluster.submissions("req-abandoned") == 1
    assert await submission_lab.guard(conversation_id) == mapping["id"]


async def test_an_unexpected_failure_after_admission_is_never_a_clean_rejection(
    submission_lab: SubmissionLab, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime = submission_lab.runtime(0)
    real_submit = runtime.manager.submit_message

    async def submit_then_fail(admitted: Admitted, message: SubmitMessage) -> SubmissionResult:
        await real_submit(admitted, message)
        raise RuntimeError("the manager failed after the input may have been sent")

    monkeypatch.setattr(runtime.manager, "submit_message", submit_then_fail)
    visitor = await submission_lab.visitor()
    conversation_id = await submission_lab.created(visitor)
    response = await post_message(visitor, conversation_id, body(conversation_id, "req-unexpected"))

    assert response.status_code == 409
    assert response.json()["submitted"] is None
    assert response.json()["error"]["code"] == "submission_unconfirmed"
    assert submission_lab.cluster.submissions("req-unexpected") == 1
