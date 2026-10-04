"""Pure §12.7 mapping. Every action has resubmit false."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from esp_contracts.api import STRICT

ReconciliationName = Literal[
    "lazy_reload",
    "clear_not_started",
    "keep_unresolved",
    "read_completed",
    "continue_saved",
    "unavailable",
]


class NativeObservedState(BaseModel):
    """What the owning harness reported. Not a reason to submit the visitor text again."""

    model_config = STRICT
    native_status: Literal["idle", "running", "completed", "interrupted", "failed", "unknown"]
    acceptance: Literal["none", "accepted", "rejected", "ambiguous"]
    saved_input_available: bool
    qualified_continuation: bool
    persisted_cancellation: bool
    write_capable_tool: bool = False
    idempotent_write_qualified: bool = False
    storage_accessible: bool = True
    resume_failed: bool = False
    partial_output: bool = False
    native_work_ref: str | None = None


class ReconciliationAction(BaseModel):
    model_config = STRICT
    action: ReconciliationName
    native_work_ref: str | None = None
    reason: str = Field(min_length=1)
    resubmit: Literal[False] = False


def reconcile_after_interrupt(observed: NativeObservedState) -> ReconciliationAction:
    """Map one native observation to a single non-replaying action."""
    ref = observed.native_work_ref
    if observed.persisted_cancellation:
        return _action("keep_unresolved", ref, "cancelled")
    if observed.write_capable_tool and not observed.idempotent_write_qualified:
        return _action("unavailable", ref, "write_not_qualified")
    if observed.resume_failed or not observed.storage_accessible:
        return _action("unavailable", ref, "resume_failed")
    if observed.acceptance in ("none", "rejected"):
        return _action("clear_not_started", ref, "not_started")
    if observed.acceptance == "ambiguous" or observed.native_status == "unknown":
        return _action("keep_unresolved", ref, "ambiguous")
    if observed.native_status == "completed":
        return _action("read_completed", ref, "completed")
    if (
        observed.native_status == "interrupted"
        and observed.qualified_continuation
        and observed.saved_input_available
        and not observed.partial_output
    ):
        return _action("continue_saved", ref, "qualified_continuation")
    if observed.partial_output or observed.native_status == "interrupted":
        return _action("keep_unresolved", ref, "partial_or_unqualified")
    if observed.native_status == "idle" and observed.saved_input_available:
        return _action("lazy_reload", ref, "idle_saved")
    return _action("unavailable", ref, "unclassified")


def _action(action: ReconciliationName, ref: str | None, reason: str) -> ReconciliationAction:
    return ReconciliationAction(action=action, native_work_ref=ref, reason=reason, resubmit=False)
