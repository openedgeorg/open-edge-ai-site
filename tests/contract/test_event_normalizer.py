"""Current-authority normalization of the §7.3 event union. No database and no inference."""

from __future__ import annotations

from datetime import UTC, datetime

from esp_contracts.runtime import AuthorityRecord, NativeEvent
from esp_event_protocol.normalize import normalize_event

_HASH = "a" * 64
_NOW = datetime(2026, 10, 4, tzinfo=UTC)


def _authority(**overrides: object) -> AuthorityRecord:
    data: dict[str, object] = {
        "conversation_id": "11111111-1111-4111-8111-111111111111",
        "owner_subject_id": "subject-a",
        "provider": "openai",
        "provider_session_id": "22222222-2222-4222-8222-222222222222",
        "session_generation": 1,
        "is_current": True,
        "native_session_id": "native-current",
        "active_agent_run_id": "33333333-3333-4333-8333-333333333333",
        "harness_instance_id": "44444444-4444-4444-8444-444444444444",
        "runtime_incarnation_id": "55555555-5555-4555-8555-555555555555",
        "ownership_epoch": 4,
        "owner_lease_expires_at": _NOW,
        "active_agent_run_expires_at": _NOW,
        "brain_release_id": "brain-1",
        "brain_hash": _HASH,
        "behavior_version": "behavior-1",
        "behavior_hash": _HASH,
        "corpus_release_id": "corpus-1",
        "deployment_ref": "66666666-6666-4666-8666-666666666666",
        "model": "model-a",
        "qualification_status": "pending",
        "database_time": _NOW,
        "runtime_state": "running",
        "guard_provider_session_id": "22222222-2222-4222-8222-222222222222",
        "current_request_id": "req-1",
        "current_native_work_ref": "work-current",
    }
    data.update(overrides)
    return AuthorityRecord.model_validate(data)


def _event(payload_type: str, payload: dict[str, str | int | float | bool | None], **overrides: object) -> NativeEvent:
    authority = _authority()
    data: dict[str, object] = {
        "native_session_id": authority.native_session_id,
        "native_work_ref": authority.current_native_work_ref,
        "provider_session_id": authority.provider_session_id,
        "session_generation": authority.session_generation,
        "active_agent_run_id": authority.active_agent_run_id,
        "ownership_epoch": authority.ownership_epoch,
        "runtime_incarnation_id": authority.runtime_incarnation_id,
        "payload_type": payload_type,
        "payload": payload,
    }
    data.update(overrides)
    return NativeEvent.model_validate(data)


def test_all_variants_and_aliases() -> None:
    authority = _authority()
    table = (
        '{"caption":"c","columns":["a"],"rows":[["x"]],'
        '"citation":{"source_id":"s","version":"1","title":"t","locator":"L1",'
        '"quote":null,"verification_state":"unverified"}}'
    )
    cases = [
        ("text_delta", {"text": "hello"}, {"type": "text_delta", "text": "hello"}),
        ("text.delta", {"text": "aliased"}, {"type": "text_delta", "text": "aliased"}),
        (
            "citation",
            {
                "source_id": "src",
                "version": "v1",
                "title": "Title",
                "locator": "p1",
                "quote": "quoted",
                "verification_state": "unverified",
            },
            {
                "type": "citation",
                "citation": {
                    "source_id": "src",
                    "version": "v1",
                    "title": "Title",
                    "locator": "p1",
                    "quote": "quoted",
                    "verification_state": "unverified",
                },
            },
        ),
        ("tool_started", {"tool": "search"}, {"type": "tool_started", "tool": "search"}),
        ("tool.finished", {"tool": "search"}, {"type": "tool_finished", "tool": "search"}),
        (
            "asset",
            {"asset_id": "a1", "version": "v1", "kind": "image", "alt": "diagram", "source_id": "src"},
            {
                "type": "asset",
                "asset": {"asset_id": "a1", "version": "v1", "kind": "image", "alt": "diagram", "source_id": "src"},
            },
        ),
        (
            "usage",
            {"input_tokens": 3, "output_tokens": 1, "cached_tokens": None},
            {"type": "usage", "usage": {"input_tokens": 3, "output_tokens": 1, "cached_tokens": None}},
        ),
        ("session_status", {"status": "running"}, {"type": "session_status", "status": "running"}),
        ("output_reset", {}, {"type": "output_reset", "activeAgentRunId": authority.active_agent_run_id}),
        (
            "error",
            {"code": "unavailable", "message": "later", "retryable": True},
            {"type": "error", "code": "unavailable", "message": "later", "retryable": True},
        ),
        ("turn_completed", {"status": "completed"}, {"type": "done", "nativeWorkRef": "work-current"}),
        ("structured_data", {"table": table}, None),
    ]
    for payload_type, payload, expected in cases:
        published = normalize_event(_event(payload_type, payload), authority)
        assert len(published) == 1, payload_type
        dumped = published[0].model_dump(by_alias=True)
        if expected is not None:
            assert dumped == expected
        else:
            assert dumped["type"] == "structured_data"
            assert dumped["data"]["columns"] == ["a"]


def test_stale_epoch_and_replacement_work_publish_nothing() -> None:
    authority = _authority()
    stale = _event("text_delta", {"text": "old"}, ownership_epoch=authority.ownership_epoch - 1)
    assert normalize_event(stale, authority) == []
    replacement = authority.model_copy(update={"current_native_work_ref": "work-next"})
    late_done = _event("done", {"status": "completed"})
    assert normalize_event(late_done, replacement) == []
    current = normalize_event(_event("text_delta", {"text": "now"}), authority)
    assert [item.model_dump() for item in current] == [{"type": "text_delta", "text": "now"}]


def test_interleaved_origins_keep_only_the_current_work() -> None:
    authority = _authority()
    events = [
        _event("text_delta", {"text": "stale"}, ownership_epoch=1),
        _event("text_delta", {"text": "current"}),
        _event("text_delta", {"text": "other-work"}, native_work_ref="work-other"),
        _event("session_status", {"status": "running"}, native_work_ref="work-other"),
    ]
    published = [item for event in events for item in normalize_event(event, authority)]
    assert [item.model_dump() for item in published] == [
        {"type": "text_delta", "text": "current"},
        {"type": "session_status", "status": "running"},
    ]


def test_unknown_usage_and_invalid_payloads_are_dropped() -> None:
    authority = _authority()
    string_count = _event("usage", {"input_tokens": "many", "output_tokens": 1, "cached_tokens": None})
    bool_count = _event("usage", {"input_tokens": True, "output_tokens": 1, "cached_tokens": None})
    assert normalize_event(string_count, authority) == []
    assert normalize_event(bool_count, authority) == []
    assert normalize_event(_event("text_delta", {}), authority) == []
    assert normalize_event(_event("mystery", {"text": "nope"}), authority) == []
    foreign_run = "99999999-9999-4999-8999-999999999999"
    reset = _event("output_reset", {"activeAgentRunId": foreign_run})
    assert normalize_event(reset, authority) == []
    retired = authority.model_copy(update={"is_current": False})
    assert normalize_event(_event("text_delta", {"text": "x"}), retired) == []
