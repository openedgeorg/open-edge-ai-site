"""Publish draft candidate bytes, then the manifest, then the selection pointer."""

from __future__ import annotations

from pathlib import Path

from esp_contracts.release import ReleaseError, ReleaseManifest
from esp_espcon.brain_registry import BrainRegistry
from knowledge.release.validate import require_digest, require_utf8


async def publish_candidate(
    directory: Path,
    manifest: ReleaseManifest,
    *,
    registry: BrainRegistry,
    release_id: str,
) -> ReleaseManifest:
    if manifest.status == "production":
        raise ReleaseError("production_publication_closed")
    brain = (directory / "canonical_brain.md").read_bytes()
    behavior = (directory / "behavior.md").read_bytes()
    require_utf8(brain)
    require_utf8(behavior)
    require_digest(brain, manifest.canonical_brain_sha256, manifest.canonical_brain_bytes)
    require_digest(behavior, manifest.behavior_sha256, manifest.behavior_bytes)
    prefix = f"draft/{release_id}"
    brain_receipt = await registry.store.put_immutable(
        f"{prefix}/canonical_brain.md",
        brain,
        {"kind": "brain", "namespace": "draft"},
    )
    behavior_receipt = await registry.store.put_immutable(
        f"{prefix}/behavior.md",
        behavior,
        {"kind": "behavior", "namespace": "draft"},
    )
    published = manifest.model_copy(
        update={
            "brain_artifact_ref": brain_receipt.reference,
            "behavior_artifact_ref": behavior_receipt.reference,
        }
    )
    manifest_receipt = await registry.store.put_immutable(
        f"{prefix}/manifest.json",
        published.model_dump_json().encode(),
        {"kind": "manifest", "namespace": "draft"},
    )
    registry.register(release_id, manifest_receipt)
    return published
