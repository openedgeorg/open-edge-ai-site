"""Every §12.7 row refuses to resubmit."""

from __future__ import annotations

from esp_recovery.reconcile import NativeObservedState, reconcile_after_interrupt


def _state(**overrides: object) -> NativeObservedState:
    data: dict[str, object] = {
        "native_status": "idle",
        "acceptance": "accepted",
        "saved_input_available": True,
        "qualified_continuation": False,
        "persisted_cancellation": False,
        "native_work_ref": "work-1",
    }
    data.update(overrides)
    return NativeObservedState.model_validate(data)


def test_eight_rows_never_resubmit() -> None:
    cases = [
        (_state(native_status="idle"), "lazy_reload"),
        (_state(acceptance="none", native_status="failed"), "clear_not_started"),
        (_state(acceptance="rejected"), "clear_not_started"),
        (_state(acceptance="ambiguous", native_status="running"), "keep_unresolved"),
        (_state(native_status="completed"), "read_completed"),
        (
            _state(native_status="interrupted", qualified_continuation=True, saved_input_available=True),
            "continue_saved",
        ),
        (_state(native_status="interrupted", partial_output=True, qualified_continuation=True), "keep_unresolved"),
        (_state(native_status="interrupted", resume_failed=True, qualified_continuation=True), "unavailable"),
        (
            _state(native_status="interrupted", qualified_continuation=True, write_capable_tool=True),
            "unavailable",
        ),
        (
            _state(native_status="interrupted", persisted_cancellation=True, qualified_continuation=True),
            "keep_unresolved",
        ),
    ]
    for observed, action in cases:
        decision = reconcile_after_interrupt(observed)
        assert decision.action == action
        assert decision.resubmit is False
