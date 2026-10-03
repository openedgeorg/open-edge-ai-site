"""Owned native history through the owning adapter only (P §§11.1, 12.3, 12.8; plan Task 16).

History is read from the conversation's own native session. A resident session is read in place. A saved,
unloaded session is read only under a non-waiting, bounded residency reservation on an instance that
mounts its storage, and only while no other process can have it loaded. Nothing here starts native
work: no create, resume, submit or continue. History is empty only before any native session exists;
existing history that cannot be read is unavailable, never a fabricated empty transcript.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from esp_contracts.api import Citation, ErrorResponse
from esp_contracts.runtime import (
    Accepted,
    AuthorizedProvenance,
    HistoryItem,
    NativeHistorySnapshot,
    NativeStatus,
)
from esp_event_protocol.history import authorized_history, empty_history
from esp_runtime_harconses.manager import NativeReadUnavailable
from scripts.migrate import migrate
from tests.support.database import APP_DSN
from tests.support.submission import DRAFT, SubmissionLab, close_submission_lab, open_submission_lab, post_message


@pytest.fixture
async def submission_lab(tmp_path: Path) -> AsyncIterator[SubmissionLab]:
    await migrate(APP_DSN)
    lab = await open_submission_lab(tmp_path)
    try:
        yield lab
    finally:
        await close_submission_lab(lab)


async def _accepted_conversation(lab: SubmissionLab, request_id: str = "req-history") -> tuple[str, str, Accepted]:
    conv = await lab.conversation()
    result = await lab.submit(conv, request_id)
    assert isinstance(result, Accepted)
    return conv.subject_id, conv.conversation_id, result


async def test_history_is_empty_only_before_allocation(submission_lab: SubmissionLab) -> None:
    visitor = await submission_lab.visitor()
    conversation_id = await submission_lab.created(visitor)
    response = await visitor.client.get(f"/conversations/{conversation_id}/history")
    assert response.status_code == 200, response.text
    snapshot = NativeHistorySnapshot.model_validate(response.json())
    assert snapshot == empty_history()
    assert submission_lab.cluster.total_calls() == 0


async def test_another_owner_gets_no_history(submission_lab: SubmissionLab) -> None:
    owner = await submission_lab.visitor()
    conversation_id = await submission_lab.created(owner)
    assert (
        await post_message(
            owner,
            conversation_id,
            {
                "conversation_id": conversation_id,
                "client_request_id": "req-owned",
                "message": DRAFT,
            },
        )
    ).status_code == 200
    intruder = await submission_lab.visitor(1)
    response = await intruder.client.get(f"/conversations/{conversation_id}/history")
    assert response.status_code == 404
    assert ErrorResponse.model_validate(response.json()).submitted is None
    assert DRAFT not in response.text


async def test_resident_history_is_read_in_place_from_another_backend(submission_lab: SubmissionLab) -> None:
    subject_id, conversation_id, accepted = await _accepted_conversation(submission_lab)
    native_id = accepted.work.native_session_id
    submission_lab.cluster.session_store(native_id).complete(native_id, "req-history", submission_lab.native_answer)
    slots_before = await submission_lab.slot_rows()
    work_calls = submission_lab.cluster.work_calls()
    restarted = await submission_lab.restarted_backend()

    snapshot = await restarted.manager.read_authorized_history(subject_id, conversation_id)

    assert [(item.role, item.text) for item in snapshot.items] == [
        ("user", DRAFT),
        ("assistant", submission_lab.native_answer),
    ]
    assert all(item.native_work_ref == accepted.work.native_work_ref for item in snapshot.items)
    assert snapshot.status.status == "completed"
    assert submission_lab.cluster.work_calls() == work_calls
    assert restarted.pool.calls["read_history"] == 1
    assert submission_lab.process.transient_reads == 0
    assert await submission_lab.slot_rows() == slots_before


async def test_unloaded_history_is_read_under_a_bounded_residency_reservation(submission_lab: SubmissionLab) -> None:
    subject_id, conversation_id, accepted = await _accepted_conversation(submission_lab)
    native_id = accepted.work.native_session_id
    submission_lab.cluster.session_store(native_id).complete(native_id, "req-history", submission_lab.native_answer)
    await submission_lab.terminal_clear(conversation_id)
    await submission_lab.unload(conversation_id)
    instance = submission_lab.instances[0]
    observed: list[int] = []

    async def count_free_lockable_rows() -> None:
        observed.append(await submission_lab.lockable_free_resident_rows(instance))

    submission_lab.process.during_read = count_free_lockable_rows
    free_before = await submission_lab.free_resident_rows(instance)
    slots_before = await submission_lab.slot_rows()
    mapping_before = await submission_lab.mapping(conversation_id)

    snapshot = await submission_lab.manager(1).read_authorized_history(subject_id, conversation_id)

    assert [item.text for item in snapshot.items] == [DRAFT, submission_lab.native_answer]
    assert observed == [free_before - 1]
    assert submission_lab.process.transient_reads == 1
    assert native_id not in submission_lab.process.loaded
    assert await submission_lab.slot_rows() == slots_before
    assert await submission_lab.mapping(conversation_id) == mapping_before
    assert submission_lab.cluster.work_calls() == 2


async def test_unloaded_history_is_unavailable_without_residency(submission_lab: SubmissionLab) -> None:
    subject_id, conversation_id, _accepted = await _accepted_conversation(submission_lab)
    await submission_lab.terminal_clear(conversation_id)
    await submission_lab.unload(conversation_id)
    await submission_lab.fill_resident(submission_lab.instances[0])
    reads = submission_lab.process.calls["session/history"]

    with pytest.raises(NativeReadUnavailable) as raised:
        await submission_lab.manager().read_authorized_history(subject_id, conversation_id)
    assert raised.value.reason == "residency_unavailable"
    assert submission_lab.process.calls["session/history"] == reads


async def test_history_over_http_is_unavailable_not_empty_when_it_cannot_be_read(submission_lab: SubmissionLab) -> None:
    visitor = await submission_lab.visitor()
    conversation_id = await submission_lab.created(visitor)
    assert (
        await post_message(
            visitor,
            conversation_id,
            {
                "conversation_id": conversation_id,
                "client_request_id": "req-unreadable",
                "message": DRAFT,
            },
        )
    ).status_code == 200
    await submission_lab.terminal_clear(conversation_id)
    await submission_lab.unload(conversation_id)
    await submission_lab.fill_resident(submission_lab.instances[0])

    response = await visitor.client.get(f"/conversations/{conversation_id}/history")
    assert response.status_code == 503
    error = ErrorResponse.model_validate(response.json())
    assert error.error.code == "history_unavailable"
    assert error.error.retryable is True
    assert error.submitted is None
    assert "items" not in response.json()


async def test_locked_residency_is_not_awaited(submission_lab: SubmissionLab) -> None:
    subject_id, conversation_id, _accepted = await _accepted_conversation(submission_lab)
    await submission_lab.terminal_clear(conversation_id)
    await submission_lab.unload(conversation_id)
    holder = await submission_lab.admission.hold_free_slots("resident", submission_lab.instances[0])
    try:
        started = time.monotonic()
        with pytest.raises(NativeReadUnavailable) as raised:
            await submission_lab.manager().read_authorized_history(subject_id, conversation_id)
        assert time.monotonic() - started < 1.5
        assert raised.value.reason == "residency_unavailable"
    finally:
        await holder.release()


async def test_unloaded_history_can_use_another_instance_on_the_same_storage(submission_lab: SubmissionLab) -> None:
    subject_id, conversation_id, accepted = await _accepted_conversation(submission_lab)
    await submission_lab.terminal_clear(conversation_id)
    await submission_lab.unload(conversation_id)
    await submission_lab.fill_resident(submission_lab.instances[0])
    same_storage = await submission_lab.add_instance(storage_unit=submission_lab.process.store.unit_id)

    snapshot = await submission_lab.manager().read_authorized_history(subject_id, conversation_id)

    assert [item.text for item in snapshot.items] == [DRAFT]
    assert same_storage.transient_reads == 1
    assert accepted.work.native_session_id not in same_storage.loaded


async def test_a_session_resident_on_an_unready_instance_is_not_read_elsewhere(submission_lab: SubmissionLab) -> None:
    subject_id, conversation_id, _accepted = await _accepted_conversation(submission_lab)
    same_storage = await submission_lab.add_instance(storage_unit=submission_lab.process.store.unit_id)
    await submission_lab.admission.set_instance(submission_lab.instances[0], lifecycle_status="suspect")

    with pytest.raises(NativeReadUnavailable) as raised:
        await submission_lab.manager().read_authorized_history(subject_id, conversation_id)
    assert raised.value.reason == "resident_instance_unavailable"
    assert same_storage.calls["session/history"] == 0
    assert submission_lab.process.calls["session/history"] == 0


async def test_a_native_read_failure_is_unavailable(submission_lab: SubmissionLab) -> None:
    subject_id, conversation_id, _accepted = await _accepted_conversation(submission_lab)
    submission_lab.process.fail.add("session/history")
    with pytest.raises(NativeReadUnavailable) as raised:
        await submission_lab.manager().read_authorized_history(subject_id, conversation_id)
    assert raised.value.reason == "native_read_failed"


async def test_a_hung_native_read_is_bounded(submission_lab: SubmissionLab) -> None:
    subject_id, conversation_id, _accepted = await _accepted_conversation(submission_lab)
    submission_lab.process.hang.add("session/history")
    started = time.monotonic()
    with pytest.raises(NativeReadUnavailable):
        await submission_lab.manager().read_authorized_history(subject_id, conversation_id)
    assert time.monotonic() - started < submission_lab.limits.read_timeout_seconds + 1.0


async def test_a_history_read_holds_off_concurrent_placement_of_the_same_session(submission_lab: SubmissionLab) -> None:
    subject_id, conversation_id, _accepted = await _accepted_conversation(submission_lab)
    await submission_lab.terminal_clear(conversation_id)
    await submission_lab.unload(conversation_id)
    outcomes: list[str] = []

    async def admit_during_read() -> None:
        conv = submission_lab.conv(subject_id, conversation_id)
        result = await submission_lab.admission.admit(conv, "req-during-read", backend=1)
        outcomes.append(result.kind)

    submission_lab.process.during_read = admit_during_read
    snapshot = await submission_lab.manager().read_authorized_history(subject_id, conversation_id)
    assert [item.text for item in snapshot.items] == [DRAFT]
    assert outcomes == ["rejected"]
    assert submission_lab.process.calls["session/resume"] == 0


async def test_history_marks_open_output_provisional_and_keeps_only_owned_provenance(
    submission_lab: SubmissionLab,
) -> None:
    subject_id, conversation_id, accepted = await _accepted_conversation(submission_lab)
    native_id = accepted.work.native_session_id
    work = submission_lab.cluster.session_store(native_id).sessions[native_id].works[0]
    work.partial = "partial output so far"
    owned = AuthorizedProvenance(
        conversation_id=conversation_id,
        native_session_id=native_id,
        native_work_ref=work.work_ref,
        source_id="src-owned",
        version="v1",
        locator="p1",
    )
    foreign = owned.model_copy(update={"conversation_id": "11111111-1111-4111-8111-111111111119"})
    work.provenance = [owned, foreign]

    snapshot = await submission_lab.manager(1).read_authorized_history(subject_id, conversation_id)

    assert [(item.role, item.text, item.provisional) for item in snapshot.items] == [
        ("user", DRAFT, False),
        ("assistant", "partial output so far", True),
    ]
    assert snapshot.provenance == [owned]


# Authorized normalization (packages/event_protocol history.py)


def _citation(state: str) -> Citation:
    return Citation.model_validate(
        {"source_id": "src-test", "version": "v1", "title": "t", "locator": "p1", "verification_state": state}
    )


def test_authorized_history_filters_foreign_provenance_and_untrusted_verification() -> None:
    conversation_id = "11111111-1111-4111-8111-111111111111"
    other_conversation = "11111111-1111-4111-8111-111111111112"
    snapshot = NativeHistorySnapshot(
        items=[
            HistoryItem(native_item_id="w1:user", native_work_ref="w1", role="user", text="q"),
            HistoryItem(
                native_item_id="w1:assistant",
                native_work_ref="w1",
                role="assistant",
                text="a",
                citations=[_citation("verified"), _citation("unavailable")],
            ),
            HistoryItem(native_item_id="w1:assistant", native_work_ref="w1", role="assistant", text="dup"),
            HistoryItem(native_item_id="w2:assistant", native_work_ref="w2", role="assistant", text="partial"),
        ],
        native_cursor=None,
        status=NativeStatus(status="running", native_work_ref="w2", saved_input_available=True),
        provenance=[
            AuthorizedProvenance(
                conversation_id=conversation_id,
                native_session_id="native-a",
                native_work_ref="w1",
                source_id="src-test",
                version="v1",
                locator="p1",
            ),
            AuthorizedProvenance(
                conversation_id=other_conversation,
                native_session_id="native-a",
                native_work_ref="w1",
                source_id="src-other",
                version="v1",
                locator="p1",
            ),
            AuthorizedProvenance(
                conversation_id=conversation_id,
                native_session_id="native-b",
                native_work_ref="w1",
                source_id="src-peer",
                version="v1",
                locator="p1",
            ),
        ],
    )
    authorized = authorized_history(snapshot, conversation_id=conversation_id, native_session_id="native-a")

    assert [item.native_item_id for item in authorized.items] == ["w1:user", "w1:assistant", "w2:assistant"]
    assert [c.verification_state for c in authorized.items[1].citations] == ["unverified", "unavailable"]
    assert [item.provisional for item in authorized.items] == [False, False, True]
    assert [p.source_id for p in authorized.provenance] == ["src-test"]
    assert authorized.status == snapshot.status


def test_empty_history_is_idle_with_nothing_saved() -> None:
    empty = empty_history()
    assert empty.items == [] and empty.provenance == [] and empty.native_cursor is None
    assert empty.status == NativeStatus(status="idle", saved_input_available=False)
