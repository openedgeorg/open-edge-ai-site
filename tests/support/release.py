"""Release lab for immutable Brain and behavior pins. Fixtures are synthetic canaries."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path

from esp_contracts.release import ReleaseManifest, ReleaseStatus
from esp_espcon.brain_registry import BrainRegistry, ResolvedRelease
from esp_object_store.store import FileObjectStore, ObjectReceipt
from knowledge.release.manifest import manifest_from_document
from knowledge.release.publish import publish_candidate

FIXTURES = Path("tests/fixtures/brain")
CREATED = datetime(2026, 10, 2, tzinfo=UTC)


def _sha(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def _read(release: str, name: str) -> bytes:
    return (FIXTURES / release / name).read_bytes()


def manifest_for(
    release_id: str, brain: bytes, behavior: bytes, status: ReleaseStatus = "draft"
) -> ReleaseManifest:
    return ReleaseManifest(
        brain_version=release_id,
        canonical_brain_sha256=_sha(brain),
        canonical_brain_bytes=len(brain),
        behavior_version=f"{release_id}-behavior",
        behavior_sha256=_sha(behavior),
        behavior_bytes=len(behavior),
        source_revision="synthetic-canary",
        created_at=CREATED,
        status=status,
        brain_artifact_ref="pending-brain",
        behavior_artifact_ref="pending-behavior",
        corpus_release_id="synthetic-corpus",
    )


class ReleaseLab:
    def __init__(self, registry: BrainRegistry, store: FileObjectStore) -> None:
        self.registry = registry
        self.store = store
        self.raw_a = _read("release_a", "canonical_brain.md")
        self.behavior_a = _read("release_a", "behavior.md")
        self.raw_b = _read("release_b", "canonical_brain.md")
        self.behavior_b = _read("release_b", "behavior.md")

    async def resolve(self, release_id: str) -> ResolvedRelease:
        return await self.registry.resolve_release(release_id)

    async def publicly_eligible(self, release_id: str) -> bool:
        return await self.registry.publicly_eligible(release_id)

    async def resolve_with_missing_behavior(self, release_id: str) -> ResolvedRelease:
        return await self.registry.resolve_without_behavior(release_id)

    async def overwrite_different(self) -> None:
        await self.store.put_immutable("draft/conflict", b"one", {"role": "canary"})
        await self.store.put_immutable("draft/conflict", b"two", {"role": "canary"})

    async def overwrite_same(self) -> ObjectReceipt:
        first = await self.store.put_immutable("draft/same", self.raw_a, {"role": "canary"})
        second = await self.store.put_immutable("draft/same", self.raw_a, {"role": "canary"})
        assert first.version_id == second.version_id
        assert first.sha256 == second.sha256 == _sha(self.raw_a)
        assert first.reference == second.reference
        return second

    def translate_legacy(self) -> ReleaseManifest:
        document: dict[str, object] = manifest_for("legacy-a", self.raw_a, self.behavior_a).model_dump(mode="json")
        document.pop("canonical_brain_sha256")
        document["brain_sha256"] = _sha(self.raw_a)
        return manifest_from_document(document)

    def conflicting_legacy(self) -> ReleaseManifest:
        document: dict[str, object] = manifest_for("legacy-b", self.raw_a, self.behavior_a).model_dump(mode="json")
        document["brain_sha256"] = _sha(self.behavior_a)
        return manifest_from_document(document)

    async def withdraw(self, release_id: str) -> None:
        await self.registry.withdraw(release_id)

    async def stored_brain(self, release_id: str) -> bytes:
        return await self.registry.read_brain_bytes(release_id)

    async def upload_brain_only(self, release_id: str) -> None:
        await self.store.put_immutable(f"draft/{release_id}/canonical_brain.md", self.raw_a, {"role": "brain"})

    async def publish_production(self) -> ReleaseManifest:
        manifest = manifest_for("fixture-prod", self.raw_a, self.behavior_a, status="production")
        return await publish_candidate(
            FIXTURES / "release_a",
            manifest,
            registry=self.registry,
            release_id="fixture-prod",
        )


async def _publish(registry: BrainRegistry, release_id: str, directory: str, brain: bytes, behavior: bytes) -> None:
    manifest = manifest_for(release_id, brain, behavior)
    await publish_candidate(FIXTURES / directory, manifest, registry=registry, release_id=release_id)


async def build_release_lab(tmp_path: Path) -> ReleaseLab:
    store = FileObjectStore(tmp_path / "objects")
    registry = BrainRegistry(store, tmp_path / "registry")
    lab = ReleaseLab(registry, store)
    await _publish(registry, "fixture-a", "release_a", lab.raw_a, lab.behavior_a)
    await _publish(registry, "fixture-b", "release_b", lab.raw_b, lab.behavior_b)
    return lab
