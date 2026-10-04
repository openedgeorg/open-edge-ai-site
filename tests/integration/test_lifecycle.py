"""Terminal release, leases, idle residency and peer-safe drain (P §§12.2–12.8, 12.11).

The database clock decides leases and idle expiry. A browser connection, a status read and a missing
token stream do not. Real PostgreSQL and the native fake; no inference.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from esp_execution_bindings.binding import AuthorizationError, verify_binding
from esp_execution_bindings.provider_release import clear_finished_run
from esp_request_admission.admit import RUN_DEADLINE_SECONDS, Admitted
from esp_runtime_harconses.lifecycle import SessionLifecycle
from esp_runtime_harconses.supervision import RunSupervision
from scripts.migrate import migrate
from tests.support.api_lab import RecordingTelemetry
from tests.support.database import APP_DSN
from tests.support.submission import (
    DRAFT,
    SubmissionLab,
    close_submission_lab,
    open_submission_lab,
    post_message,
)

PRIVATE = "lifecycle-private-draft-9f3a"


@pytest.fixture
async def lifecycle_lab(tmp_path: Path) -> AsyncIterator[SubmissionLab]:
    await migrate(APP_DSN)
    lab = await open_submission_lab(tmp_path, instances=[(16, 16)], provider_limit=32)
    try:
        yield lab
    finally:
        await close_submission_lab(lab)


def _body(conversation_id: str, request_id: str, message: str = DRAFT) -> dict[str, object]:
    return {"conversation_id": conversation_id, "client_request_id": request_id, "message": message}


async def test_terminal_release_allows_two_messages(lifecycle_lab: SubmissionLab) -> None:
    assert await lifecycle_lab.two_sequential_messages_native_count() == 2
    assert await lifecycle_lab.resident_at_idle_seconds(899)
    assert not await lifecycle_lab.resident_at_idle_seconds(900)
    assert await lifecycle_lab.peer_runs_after_unload()
    assert await lifecycle_lab.guard_until_cancel_confirmed()
    assert not await lifecycle_lab.old_epoch_event_clears_replacement()


async def test_disconnect_and_status_do_not_govern_the_run(lifecycle_lab: SubmissionLab) -> None:
    """HTTP lifetime and a missing token stream neither stop the run nor extend idle nor kill the process."""
    visitor = await lifecycle_lab.visitor()
    conversation_id = await lifecycle_lab.created(visitor)
    conv = lifecycle_lab.conv(visitor.subject_id, conversation_id)
    entered, proceed = asyncio.Event(), asyncio.Event()

    async def hold_create(_params: dict[str, Any]) -> None:
        entered.set()
        await proceed.wait()

    lifecycle_lab.process.before["session/create"] = hold_create
    request = asyncio.create_task(
        post_message(visitor, conversation_id, _body(conversation_id, "life-disconnect", PRIVATE))
    )
    await asyncio.wait_for(entered.wait(), timeout=2)
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request
    proceed.set()
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        row = await lifecycle_lab.coordination(conv)
        if row["current_native_work_ref"] is not None:
            break
        await asyncio.sleep(0.02)
    running = await lifecycle_lab.coordination(conv)
    assert running["runtime_state"] == "running"
    assert running["guard"] is not None
    incarnation = str((await lifecycle_lab.instance_row(str(running["harness_instance_id"])))["process_incarnation_id"])
    status = await visitor.client.get(
        f"/conversations/{conversation_id}/status", params={"client_request_id": "life-disconnect"}
    )
    history = await visitor.client.get(f"/conversations/{conversation_id}/history")
    await visitor.client.aclose()
    await lifecycle_lab.consume()
    after = await lifecycle_lab.coordination(conv)
    instance = await lifecycle_lab.instance_row(str(running["harness_instance_id"]))
    native_id = str(after["native_session_id"])
    work = lifecycle_lab.cluster.session_store(native_id).sessions[native_id].work_for("life-disconnect")
    assert status.status_code == 200
    assert history.status_code == 200
    assert after["runtime_state"] == "running"
    assert after["guard"] == running["guard"]
    assert after["active_agent_run_id"] == running["active_agent_run_id"]
    assert after["last_used_at"] == running["last_used_at"]
    assert int(after["recovery_count"]) == 0
    assert after["recovery_started_at"] is None
    assert str(instance["lifecycle_status"]) == "ready"
    assert str(instance["process_incarnation_id"]) == incarnation
    assert work is not None and work.status == "running"
    lifecycle_lab.process.finish(native_id, "life-disconnect", announce=False)
    await lifecycle_lab.consume()
    idle = await lifecycle_lab.coordination(conv)
    assert idle["runtime_state"] == "warm_idle"
    owner = lifecycle_lab.same_browser(visitor, 0)
    again = await owner.client.get(
        f"/conversations/{conversation_id}/status", params={"client_request_id": "life-disconnect"}
    )
    assert again.status_code == 200
    assert (await lifecycle_lab.coordination(conv))["last_used_at"] == idle["last_used_at"]
    now = await lifecycle_lab.age_last_used(conv, 900)
    await lifecycle_lab.lifecycle().evict_idle(now)
    assert not await lifecycle_lab.resident(conv)
    blob = await lifecycle_lab.metadata_blob()
    assert PRIVATE not in blob
    telemetry = lifecycle_lab.admission.api.telemetry
    assert isinstance(telemetry, RecordingTelemetry)
    assert PRIVATE not in repr(telemetry.events)


async def test_a_restarted_consumer_reconciles_terminal_native_status(lifecycle_lab: SubmissionLab) -> None:
    conv = await lifecycle_lab.conversation()
    accepted = await lifecycle_lab._accepted(conv, "life-restart", PRIVATE)
    native_id = accepted.work.native_session_id
    lifecycle_lab.cluster.session_store(native_id).complete(native_id, "life-restart", "answer-kept-on-the-harness")
    restarted = await lifecycle_lab.restarted_backend()
    supervision = restarted.app.state.supervision
    assert isinstance(supervision, RunSupervision)
    await supervision.consume_control_events()
    row = await lifecycle_lab.coordination(conv)
    slots = await lifecycle_lab.run_slots(str(row["id"]))
    assert row["guard"] is None
    assert row["active_agent_run_id"] is None
    assert row["runtime_state"] == "warm_idle"
    assert row["current_request_id"] is None
    assert "resident" in slots
    assert "active" not in slots
    assert "provider" not in slots
    blob = await lifecycle_lab.metadata_blob()
    assert PRIVATE not in blob
    assert "answer-kept-on-the-harness" not in blob


async def test_a_failed_terminal_write_is_retried_after_the_database_recovers(lifecycle_lab: SubmissionLab) -> None:
    conv = await lifecycle_lab.conversation()
    accepted = await lifecycle_lab._accepted(conv, "life-lock", PRIVATE)
    binding = await lifecycle_lab.run_binding(conv)
    holder = await lifecycle_lab.admission.hold_mapping(conv)
    try:
        cleared = await lifecycle_lab.lifecycle().finish_run(binding, accepted.work)
    finally:
        await holder.release()
    assert cleared is False
    held = await lifecycle_lab.coordination(conv)
    assert held["guard"] is not None
    assert held["active_agent_run_id"] is not None
    assert "active" in await lifecycle_lab.run_slots(str(held["id"]))
    lifecycle_lab.process.finish(accepted.work.native_session_id, "life-lock", announce=False)
    await lifecycle_lab.consume()
    released = await lifecycle_lab.coordination(conv)
    assert released["guard"] is None
    assert released["active_agent_run_id"] is None
    assert released["runtime_state"] == "warm_idle"
    assert released["current_request_id"] is None
    assert PRIVATE not in await lifecycle_lab.metadata_blob()


async def test_renewal_refreshes_both_tokens_and_keeps_the_run_deadline(lifecycle_lab: SubmissionLab) -> None:
    conv = await lifecycle_lab.conversation()
    await lifecycle_lab._accepted(conv, "life-renew", PRIVATE)
    before = await lifecycle_lab.coordination(conv)
    deadline = before["active_agent_run_expires_at"]
    binding = await lifecycle_lab.run_binding(conv)
    authority = await lifecycle_lab.lifecycle().renew_ownership(binding)
    assert authority.inference_token != authority.knowledge_token
    inference = verify_binding(authority.inference_token, "inference", verifier=lifecycle_lab.verifier)
    knowledge = verify_binding(authority.knowledge_token, "knowledge", verifier=lifecycle_lab.verifier)
    assert inference.audience == "inference"
    assert knowledge.audience == "knowledge"
    assert inference.expires_at == knowledge.expires_at
    after = await lifecycle_lab.coordination(conv)
    assert after["active_agent_run_expires_at"] == deadline
    assert after["owner_lease_expires_at"] > before["owner_lease_expires_at"]
    assert after["last_used_at"] == before["last_used_at"]
    assert int(after["ownership_epoch"]) == int(before["ownership_epoch"])
    remaining = after["owner_lease_expires_at"] - await lifecycle_lab.database_now()
    assert timedelta(seconds=25) < remaining <= timedelta(seconds=31)
    await lifecycle_lab.lifecycle().renew_ownership(await lifecycle_lab.run_binding(conv))
    assert (await lifecycle_lab.coordination(conv))["active_agent_run_expires_at"] == deadline
    span = deadline - before["last_used_at"]
    assert timedelta(seconds=RUN_DEADLINE_SECONDS - 2) <= span <= timedelta(seconds=RUN_DEADLINE_SECONDS + 2)
    await lifecycle_lab.execute(
        """
        UPDATE provider_session
        SET owner_lease_expires_at = transaction_timestamp() + make_interval(secs => 24)
        WHERE conversation_id = %s AND is_current
        """,
        (conv.conversation_id,),
    )
    marks = len(lifecycle_lab.runtime().pool.refreshed)
    await lifecycle_lab.consume()
    renewed = await lifecycle_lab.coordination(conv)
    renewed_for = renewed["owner_lease_expires_at"] - await lifecycle_lab.database_now()
    assert renewed["active_agent_run_expires_at"] == deadline
    assert len(lifecycle_lab.runtime().pool.refreshed) > marks
    assert timedelta(seconds=25) < renewed_for <= timedelta(seconds=31)
    quiet_marks = len(lifecycle_lab.runtime().pool.refreshed)
    lease_now = renewed["owner_lease_expires_at"]
    await lifecycle_lab.consume()
    quiet = await lifecycle_lab.coordination(conv)
    assert quiet["owner_lease_expires_at"] == lease_now
    assert len(lifecycle_lab.runtime().pool.refreshed) == quiet_marks
    await lifecycle_lab.execute(
        """
        UPDATE provider_session
        SET owner_lease_expires_at = transaction_timestamp() - make_interval(secs => 1)
        WHERE conversation_id = %s AND is_current
        """,
        (conv.conversation_id,),
    )
    with pytest.raises(AuthorizationError):
        await lifecycle_lab.lifecycle().renew_ownership(await lifecycle_lab.run_binding(conv))
    expired = await lifecycle_lab.coordination(conv)
    assert expired["active_agent_run_expires_at"] == deadline
    assert expired["owner_lease_expires_at"] < await lifecycle_lab.database_now()
    assert PRIVATE not in await lifecycle_lab.metadata_blob()


async def test_finish_run_clears_only_its_own_epoch_and_keeps_residency(lifecycle_lab: SubmissionLab) -> None:
    conv = await lifecycle_lab.conversation()
    accepted = await lifecycle_lab._accepted(conv, "life-finish")
    binding = await lifecycle_lab.run_binding(conv)
    lifecycle_lab.process.finish(accepted.work.native_session_id, "life-finish", announce=False)
    assert await lifecycle_lab.lifecycle().finish_run(binding, accepted.work) is True
    row = await lifecycle_lab.coordination(conv)
    slots = await lifecycle_lab.run_slots(str(row["id"]))
    assert row["guard"] is None
    assert row["active_agent_run_id"] is None
    assert row["current_native_work_ref"] is None
    assert row["current_request_id"] is None
    assert row["owner_lease_expires_at"] is None
    assert row["active_agent_run_expires_at"] is None
    assert row["cancel_requested_at"] is None
    assert row["runtime_state"] == "warm_idle"
    assert "resident" in slots
    assert "active" not in slots
    assert "provider" not in slots
    assert await lifecycle_lab.lifecycle().finish_run(binding, accepted.work) is False
    second = await lifecycle_lab._accepted(conv, "life-finish-next")
    current = await lifecycle_lab.run_binding(conv)
    stale = current.model_copy(
        update={"active_agent_run_id": str(uuid.uuid4()), "ownership_epoch": current.ownership_epoch - 1}
    )
    assert await lifecycle_lab.lifecycle().finish_run(stale, second.work) is False
    assert await lifecycle_lab.lifecycle().finish_run(binding, accepted.work) is False
    still = await lifecycle_lab.coordination(conv)
    assert still["active_agent_run_id"] == current.active_agent_run_id
    assert still["guard"] is not None
    assert still["runtime_state"] == "running"
    assert "active" in await lifecycle_lab.run_slots(str(still["id"]))
    assert isinstance(lifecycle_lab.lifecycle(), SessionLifecycle)


async def test_a_provider_failure_releases_the_running_request(lifecycle_lab: SubmissionLab) -> None:
    """A non-success provider completion never finishes the reply, and must still free the run."""
    conv = await lifecycle_lab.conversation()
    accepted = await lifecycle_lab._accepted(conv, "life-provider-403")
    binding = await lifecycle_lab.run_binding(conv)
    assert binding.native_work_ref == accepted.work.native_work_ref
    wrong = binding.model_copy(update={"native_work_ref": "other-work"})
    assert (
        await clear_finished_run(
            lifecycle_lab.admission.admin, wrong, native_work_ref=wrong.native_work_ref, provider_failure=True
        )
        is False
    )
    held = await lifecycle_lab.coordination(conv)
    assert held["runtime_state"] == "running"
    assert held["current_request_id"] == "life-provider-403"
    # The inference token is minted before the native work reference is stored.
    minted = binding.model_copy(update={"native_work_ref": None})
    assert (
        await clear_finished_run(lifecycle_lab.admission.admin, minted, native_work_ref=None, provider_failure=True)
        is True
    )
    row = await lifecycle_lab.coordination(conv)
    assert row["runtime_state"] == "warm_idle"
    assert row["runtime_state"] != "running"
    assert row["current_request_id"] is None
    assert row["active_agent_run_id"] is None
    assert row["current_native_work_ref"] is None
    assert row["guard"] is None
    result = await lifecycle_lab.admission.admit(conv, "life-provider-403-next")
    assert isinstance(result, Admitted)


async def test_a_finished_reply_releases_the_running_request(lifecycle_lab: SubmissionLab) -> None:
    conv = await lifecycle_lab.conversation()
    accepted = await lifecycle_lab._accepted(conv, "life-release")
    lifecycle_lab.process.finish(accepted.work.native_session_id, "life-release", announce=False)
    await lifecycle_lab.consume()
    row = await lifecycle_lab.coordination(conv)
    assert row["runtime_state"] == "warm_idle"
    assert row["runtime_state"] != "running"
    assert row["current_request_id"] is None
    assert row["active_agent_run_id"] is None
    assert row["guard"] is None
    result = await lifecycle_lab.admission.admit(conv, "life-release-next")
    assert isinstance(result, Admitted)


async def test_busy_sessions_stay_resident_and_a_failed_unload_keeps_the_peer(lifecycle_lab: SubmissionLab) -> None:
    running = await lifecycle_lab.conversation()
    cancelling = await lifecycle_lab.conversation()
    recovering = await lifecycle_lab.conversation()
    await lifecycle_lab._accepted(running, "life-busy-run")
    await lifecycle_lab._accepted(cancelling, "life-busy-cancel")
    await lifecycle_lab.execute(
        """
        UPDATE provider_session
        SET runtime_state = 'cancelling', cancel_requested_at = transaction_timestamp()
        WHERE conversation_id = %s AND is_current
        """,
        (cancelling.conversation_id,),
    )
    recovered = await lifecycle_lab._accepted(recovering, "life-busy-recover")
    await lifecycle_lab._finish_and_consume(recovering, "life-busy-recover", recovered.work.native_session_id)
    await lifecycle_lab.execute(
        """
        UPDATE provider_session
        SET runtime_state = 'recovering', recovery_started_at = transaction_timestamp(), recovery_count = 1
        WHERE conversation_id = %s AND is_current
        """,
        (recovering.conversation_id,),
    )
    now = await lifecycle_lab.database_now()
    for conv in (running, cancelling, recovering):
        await lifecycle_lab.age_last_used(conv, 900)
    evicted = await lifecycle_lab.lifecycle().evict_idle(now)
    held_ids = {
        str((await lifecycle_lab.coordination(running))["id"]),
        str((await lifecycle_lab.coordination(cancelling))["id"]),
        str((await lifecycle_lab.coordination(recovering))["id"]),
    }
    assert held_ids.isdisjoint(evicted)
    assert await lifecycle_lab.resident(running)
    assert await lifecycle_lab.resident(cancelling)
    assert await lifecycle_lab.resident(recovering)
    peer = await lifecycle_lab.conversation()
    subject = await lifecycle_lab.conversation()
    peer_run = await lifecycle_lab._accepted(peer, "life-unsup-peer")
    subject_run = await lifecycle_lab._accepted(subject, "life-unsup-idle")
    await lifecycle_lab._finish_and_consume(subject, "life-unsup-idle", subject_run.work.native_session_id)
    process = lifecycle_lab._process_for(subject_run.work.native_session_id)
    incarnation = str((await lifecycle_lab.instance_row(lifecycle_lab.instances[0]))["process_incarnation_id"])
    process.unload_mode = "unsupported"
    aged = await lifecycle_lab.age_last_used(subject, 900)
    released = await lifecycle_lab.lifecycle().evict_idle(aged)
    row = await lifecycle_lab.coordination(subject)
    assert str(row["id"]) not in released
    assert row["runtime_state"] == "recovering"
    assert int(row["recovery_count"]) >= 1
    assert row["recovery_started_at"] is not None
    assert row["recovery_deadline_at"] is not None
    assert row["last_failure_code"] == "unload_unsupported"
    assert await lifecycle_lab.resident(subject)
    peer_row = await lifecycle_lab.coordination(peer)
    assert peer_row["runtime_state"] == "running"
    assert peer_row["guard"] is not None
    instance = await lifecycle_lab.instance_row(lifecycle_lab.instances[0])
    assert str(instance["lifecycle_status"]) == "ready"
    assert str(instance["process_incarnation_id"]) == incarnation
    peer_work = lifecycle_lab.cluster.session_store(peer_run.work.native_session_id).sessions[
        peer_run.work.native_session_id
    ].work_for("life-unsup-peer")
    assert peer_work is not None and peer_work.status == "running"
    count = int(row["recovery_count"])
    await lifecycle_lab.lifecycle().evict_idle(await lifecycle_lab.age_last_used(subject, 900))
    assert int((await lifecycle_lab.coordination(subject))["recovery_count"]) == count


async def test_an_in_place_read_keeps_the_session_on_its_process(lifecycle_lab: SubmissionLab) -> None:
    conv = await lifecycle_lab.conversation()
    accepted = await lifecycle_lab._accepted(conv, "life-read")
    await lifecycle_lab._finish_and_consume(conv, "life-read", accepted.work.native_session_id)
    now = await lifecycle_lab.age_last_used(conv, 900)
    started, release = asyncio.Event(), asyncio.Event()

    async def during() -> None:
        started.set()
        await release.wait()

    lifecycle_lab.process.during_read = during
    read = asyncio.create_task(lifecycle_lab.manager().read_authorized_history(conv.subject_id, conv.conversation_id))
    await asyncio.wait_for(started.wait(), timeout=2)
    try:
        await asyncio.wait_for(lifecycle_lab.lifecycle().evict_idle(now), timeout=2)
    except TimeoutError:
        release.set()
        await read
        raise AssertionError("eviction waited on an in-place read instead of leaving the session resident") from None
    assert await lifecycle_lab.resident(conv)
    assert (await lifecycle_lab.coordination(conv))["runtime_state"] == "warm_idle"
    release.set()
    snapshot = await read
    lifecycle_lab.process.during_read = None
    assert snapshot.items
    assert (await lifecycle_lab.coordination(conv))["last_used_at"] == (
        await lifecycle_lab.coordination(conv)
    )["last_used_at"]
    await lifecycle_lab.lifecycle().evict_idle(await lifecycle_lab.database_now())
    assert not await lifecycle_lab.resident(conv)
    unloaded = await lifecycle_lab.coordination(conv)
    assert unloaded["runtime_state"] == "unloaded"
    assert unloaded["native_session_id"] == accepted.work.native_session_id
    assert unloaded["harness_instance_id"] is not None


async def test_drain_stops_only_after_resident_sessions_are_unloaded(lifecycle_lab: SubmissionLab) -> None:
    conv = await lifecycle_lab.conversation()
    accepted = await lifecycle_lab._accepted(conv, "life-drain")
    instance = str((await lifecycle_lab.coordination(conv))["harness_instance_id"])
    assert await lifecycle_lab.lifecycle().drain_instance(instance) == "draining"
    marked = await lifecycle_lab.instance_row(instance)
    assert str(marked["lifecycle_status"]) == "draining"
    assert marked["drain_started_at"] is not None
    other = await lifecycle_lab.add_instance(resident=4, active=4)
    fresh = await lifecycle_lab.conversation()
    await lifecycle_lab._accepted(fresh, "life-drain-other")
    assert str((await lifecycle_lab.coordination(fresh))["harness_instance_id"]) == other.instance_id
    assert lifecycle_lab._process_for(accepted.work.native_session_id).cancel_requests == []
    assert (await lifecycle_lab.coordination(conv))["runtime_state"] == "running"
    assert await lifecycle_lab.lifecycle().drain_instance(instance) == "draining"
    await lifecycle_lab._finish_and_consume(conv, "life-drain", accepted.work.native_session_id)
    assert await lifecycle_lab.resident(conv)
    assert await lifecycle_lab.lifecycle().drain_instance(instance) == "stopped"
    assert not await lifecycle_lab.resident(conv)
    assert (await lifecycle_lab.coordination(conv))["runtime_state"] == "unloaded"
    assert str((await lifecycle_lab.instance_row(instance))["lifecycle_status"]) == "stopped"
    assert await lifecycle_lab.lifecycle().drain_instance(instance) == "stopped"
    assert (await lifecycle_lab.coordination(fresh))["runtime_state"] == "running"
    doomed = await lifecycle_lab.add_instance()
    await lifecycle_lab.execute(
        "UPDATE harness_instance SET lifecycle_status = 'failed' WHERE id = %s", (doomed.instance_id,)
    )
    assert await lifecycle_lab.lifecycle().drain_instance(doomed.instance_id) == "draining"
    assert str((await lifecycle_lab.instance_row(doomed.instance_id))["lifecycle_status"]) == "failed"
    with pytest.raises(ValueError):
        await lifecycle_lab.lifecycle().drain_instance(str(uuid.uuid4()))
