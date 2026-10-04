"""Controlled publication. Synthetic cases and a single provider report cannot select production."""

from __future__ import annotations

from pathlib import Path

from esp_contracts.release import ReleaseError, ReleaseManifest
from knowledge.evals.schema import EvaluationReport


def prepare_candidate(source_directory: Path, source_revision: str, owner_review_ref: str) -> ReleaseManifest:
    """Refuse to mint a manifest from an unreviewed directory. This does not read or invent Brain bytes."""
    del source_directory
    if not owner_review_ref or not source_revision:
        raise ReleaseError("review_required")
    raise ReleaseError("approved_content_absent")


def publish_release(
    candidate_id: str,
    review_ref: str,
    evaluations: list[EvaluationReport],
    qualification_refs: list[str],
) -> bool:
    """True only when a review and both providers' reviewed reports are present. It writes nothing."""
    del candidate_id, qualification_refs
    if not review_ref:
        return False
    providers = {item.provider for item in evaluations if item.content_reviewed and item.positive_inference_count > 0}
    return providers == {"openai", "xai"}


def promote_release(release_id: str, pins: dict[str, str]) -> dict[str, str]:
    """Selection metadata only. Existing conversation pins are copied unchanged."""
    del release_id
    return dict(pins)


def withdraw_release(release_id: str, reason: str, pins: dict[str, str]) -> dict[str, str]:
    """Withdrawal does not rewrite artifact bytes or pinned conversations."""
    del release_id, reason
    return dict(pins)
