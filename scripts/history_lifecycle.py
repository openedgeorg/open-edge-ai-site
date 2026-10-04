"""Native history export and deletion. Unsupported deletion is a failure, not a silent success."""

from __future__ import annotations

from esp_contracts.evaluation import NativeDeletionResult, ProductionConfig, ReadinessResult
from esp_contracts.ids import Provider
from esp_contracts.qualification import QualificationResult
from esp_contracts.runtime import NativeHistorySnapshot, NativeStatus, SessionHandle


def validate_release_readiness(config: ProductionConfig) -> ReadinessResult:
    missing: list[str] = []
    for name in (
        "native_retention",
        "evidence_retention",
        "metadata_retention",
        "telemetry_retention",
        "backup_retention",
        "cookie_lifetime",
    ):
        if not str(getattr(config, name)).strip():
            missing.append(name)
    if not config.qualified_profile_refs:
        missing.append("qualified_profile_refs")
    if config.deletion_required and not config.deletion_supported:
        missing.append("deletion_unsupported")
    return ReadinessResult(ready=not missing, missing=missing, invalid=[], stale=[], evidence_refs=[])


def export_native_history(handle: SessionHandle) -> NativeHistorySnapshot:
    """Return an empty snapshot for this handle only. Peer sessions are not read."""
    if not handle.native_session_id:
        raise ValueError("missing native session")
    return NativeHistorySnapshot(
        items=[],
        native_cursor=None,
        status=NativeStatus(status="unknown", native_work_ref=None, request_id=None, saved_input_available=False),
        provenance=[],
    )


def delete_native_history(handle: SessionHandle) -> NativeDeletionResult:
    """No peer-safe native deletion mechanism is selected. The call does not edit native files."""
    del handle
    return NativeDeletionResult(status="unsupported", reason="peer_safe_deletion_not_selected")


def run_privacy(provider: Provider) -> QualificationResult:
    """No approved retention evidence is recorded. The privacy gate stays pending."""
    return QualificationResult(
        provider=provider,
        gate="privacy",
        status="pending",
        empty_evidence=True,
        failed_criteria=["missing_privacy_evidence"],
    )
