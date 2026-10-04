"""Cancellation keeps the conversation guard until the native stop is confirmed (P §§12.4, 12.7, 12.11).

Intent survives an ownership-epoch change and a backend restart. A cancel the harness ignores or fails
records that group recovery is required and leaves every peer running. Stale events do not clear a
replacement run.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from esp_contracts.api import SubmissionView
from esp_espcon.conversation import ConversationNotFound
from esp_request_admission.admit import Rejected
from esp_runtime_harconses.lifecycle import SessionLifecycle
from esp_runtime_harconses.supervision import RunSupervision
from scripts.migrate import migrate
from tests.support.api_lab import RecordingTelemetry
from tests.support.database import APP_DSN
from tests.support.submission import SubmissionLab, close_submission_lab, open_submission_lab

PRIVATE = "cancel-private-draft-9f3a"


@pytest.fixture
async def lifecycle_lab(tmp_path: Path) -> AsyncIterator[SubmissionLab]:
    await migrate(APP_DSN)
    lab = await open_submission_lab(tmp_path, instances=[(16, 16)], provider_limit=32)
    try:
        yield lab
    finally:
        await close_submission_lab(lab)


async def test_cancel_route_confirms_before_releasing_the_guard(lifecycle_lab: SubmissionLab) -> None:
    visitor = await lifecycle_lab.visitor()
    conversation_id = await lifecycle_lab.created(visitor)
    conv = lifecycle_lab.conv(visitor.subject_id, conversation_id)
    accepted = await lifecycle_lab._accepted(conv, "life-http-cancel", PRIVATE)
    row = await lifecycle_lab.coordination(conv)
    run_id = str(row["active_agent_run_id"])
    path = f"/conversations/{conversation_id}/runs/{run_id}/cancel"
    stranger = await lifecycle_lab.visitor()
    denied = await stranger.client.post(path, headers=stranger.write_headers())
    missing_csrf = await visitor.client.post(
        path, headers={"origin": visitor.origin, "content-type": "application/json"}
    )
    wrong_run = str(uuid.uuid4())
    untouched = await visitor.client.post(
        f"/conversations/{conversation_id}/runs/{wrong_run}/cancel", headers=visitor.write_headers()
    )
    bad_uuid = await visitor.client.post(
        f"/conversations/not-a-uuid/runs/{run_id}/cancel", headers=visitor.write_headers()
    )
    held = await lifecycle_lab.coordination(conv)
    assert denied.status_code == 404
    assert missing_csrf.status_code == 403
    assert bad_uuid.status_code == 400
    assert untouched.status_code == 200
    untouched_view = SubmissionView.model_validate(untouched.json())
    assert untouched_view.active_agent_run_id == run_id
    assert untouched_view.resubmission_allowed is False
    assert held["cancel_requested_at"] is None
    assert held["runtime_state"] == "running"
    assert held["guard"] == row["guard"]
    process = lifecycle_lab._process_for(accepted.work.native_session_id)
    process.cancel_mode = "interrupt"
    confirmed = await visitor.client.post(path, headers=visitor.write_headers())
    assert confirmed.status_code == 200
    view = SubmissionView.model_validate(confirmed.json())
    released = await lifecycle_lab.coordination(conv)
    slots = await lifecycle_lab.run_slots(str(released["id"]))
    assert view.outcome == "cancelled"
    assert view.resubmission_allowed is False
    assert released["guard"] is None
    assert released["active_agent_run_id"] is None
    assert released["runtime_state"] == "warm_idle"
    assert released["cancel_requested_at"] is None
    assert "resident" in slots
    assert "active" not in slots
    assert process.cancel_requests == [(accepted.work.native_session_id, accepted.work.native_work_ref)]
    blob = await lifecycle_lab.metadata_blob()
    assert PRIVATE not in blob
    telemetry = lifecycle_lab.admission.api.telemetry
    assert isinstance(telemetry, RecordingTelemetry)
    assert PRIVATE not in repr(telemetry.events)
    assert isinstance(lifecycle_lab.lifecycle(), SessionLifecycle)
    assert isinstance(lifecycle_lab.supervision(), RunSupervision)


async def test_an_ignored_cancel_keeps_the_guard_and_blocks_replacement(lifecycle_lab: SubmissionLab) -> None:
    conv = await lifecycle_lab.conversation()
    peer = await lifecycle_lab.conversation()
    peer_run = await lifecycle_lab._accepted(peer, "life-intent-peer")
    subject = await lifecycle_lab._accepted(conv, "life-intent", PRIVATE)
    process = lifecycle_lab._process_for(subject.work.native_session_id)
    process.cancel_mode = "ignore"
    run_id = str((await lifecycle_lab.coordination(conv))["active_agent_run_id"])
    view = await lifecycle_lab.lifecycle().cancel_run(conv.subject_id, conv.conversation_id, run_id)
    held = await lifecycle_lab.coordination(conv)
    assert view.resubmission_allowed is False
    assert view.runtime_state == "cancelling"
    assert held["guard"] is not None
    assert held["runtime_state"] == "cancelling"
    assert held["cancel_requested_at"] is not None
    assert held["recovery_started_at"] is not None
    assert int(held["recovery_count"]) >= 1
    assert held["last_failure_code"] == "cancel_unconfirmed"
    assert int(held["ownership_epoch"]) == int((await lifecycle_lab.coordination(conv))["ownership_epoch"])
    peer_row = await lifecycle_lab.coordination(peer)
    assert peer_row["runtime_state"] == "running"
    instance = await lifecycle_lab.instance_row(str(held["harness_instance_id"]))
    assert str(instance["lifecycle_status"]) == "ready"
    await lifecycle_lab.execute(
        "UPDATE provider_session SET ownership_epoch = ownership_epoch + 1 WHERE conversation_id = %s AND is_current",
        (conv.conversation_id,),
    )
    await lifecycle_lab.execute(
        "UPDATE conversation SET active_provider_session_id = NULL WHERE id = %s", (conv.conversation_id,)
    )
    await lifecycle_lab.execute(
        """
        UPDATE provider_session
        SET active_agent_run_id = NULL, owner_lease_expires_at = NULL, active_agent_run_expires_at = NULL,
            runtime_state = 'warm_idle'
        WHERE conversation_id = %s AND is_current
        """,
        (conv.conversation_id,),
    )
    refused = await lifecycle_lab.admission.admit(conv, "life-intent-again")
    assert isinstance(refused, Rejected)
    assert refused.code == "conversation_busy"
    restarted = await lifecycle_lab.restarted_backend()
    supervision = restarted.app.state.supervision
    assert isinstance(supervision, RunSupervision)
    await supervision.consume_control_events()
    survived = await lifecycle_lab.coordination(conv)
    assert survived["cancel_requested_at"] is not None
    work = lifecycle_lab.cluster.session_store(subject.work.native_session_id).sessions[
        subject.work.native_session_id
    ].work_for("life-intent")
    peer_work = lifecycle_lab.cluster.session_store(peer_run.work.native_session_id).sessions[
        peer_run.work.native_session_id
    ].work_for("life-intent-peer")
    assert work is not None and work.status == "running"
    assert peer_work is not None and peer_work.status == "running"
    assert (await lifecycle_lab.coordination(peer))["runtime_state"] == "running"
    assert PRIVATE not in await lifecycle_lab.metadata_blob()
    with pytest.raises(ConversationNotFound):
        await lifecycle_lab.lifecycle().cancel_run("another-subject", conv.conversation_id, run_id)


async def test_a_failed_cancel_records_recovery_and_spares_the_peer(lifecycle_lab: SubmissionLab) -> None:
    conv = await lifecycle_lab.conversation()
    peer = await lifecycle_lab.conversation()
    peer_run = await lifecycle_lab._accepted(peer, "life-fail-peer")
    subject = await lifecycle_lab._accepted(conv, "life-fail-cancel")
    process = lifecycle_lab._process_for(subject.work.native_session_id)
    incarnation = str((await lifecycle_lab.instance_row(lifecycle_lab.instances[0]))["process_incarnation_id"])
    process.cancel_mode = "fail"
    run_id = str((await lifecycle_lab.coordination(conv))["active_agent_run_id"])
    wrong = await lifecycle_lab.lifecycle().cancel_run(conv.subject_id, conv.conversation_id, str(uuid.uuid4()))
    untouched = await lifecycle_lab.coordination(conv)
    assert wrong.active_agent_run_id == run_id
    assert wrong.resubmission_allowed is False
    assert untouched["cancel_requested_at"] is None
    assert untouched["runtime_state"] == "running"
    assert process.cancel_requests == []
    view = await lifecycle_lab.lifecycle().cancel_run(conv.subject_id, conv.conversation_id, run_id)
    held = await lifecycle_lab.coordination(conv)
    assert view.resubmission_allowed is False
    assert view.runtime_state == "cancelling"
    assert held["guard"] is not None
    assert held["runtime_state"] == "cancelling"
    assert held["cancel_requested_at"] is not None
    assert held["last_failure_code"] == "cancel_failed"
    assert int(held["recovery_count"]) == 1
    assert held["recovery_started_at"] is not None
    instance = await lifecycle_lab.instance_row(lifecycle_lab.instances[0])
    assert str(instance["lifecycle_status"]) == "ready"
    assert str(instance["process_incarnation_id"]) == incarnation
    peer_work = lifecycle_lab.cluster.session_store(peer_run.work.native_session_id).sessions[
        peer_run.work.native_session_id
    ].work_for("life-fail-peer")
    assert peer_work is not None and peer_work.status == "running"
    assert (await lifecycle_lab.coordination(peer))["guard"] is not None
    count = int(held["recovery_count"])
    await lifecycle_lab.lifecycle().cancel_run(conv.subject_id, conv.conversation_id, run_id)
    assert int((await lifecycle_lab.coordination(conv))["recovery_count"]) == count
    assert (await lifecycle_lab.coordination(conv))["guard"] is not None
