"""Resolve a release only from its own immutable manifest and artifact bytes."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

from pydantic import BaseModel

from esp_contracts.api import STRICT
from esp_contracts.release import ReleaseError, ReleaseManifest
from esp_object_store.store import ObjectReceipt, ObjectStore, parse_object_reference


class ResolvedRelease(BaseModel):
    model_config = STRICT
    release_id: str
    manifest: ReleaseManifest
    brain_bytes: bytes
    behavior_bytes: bytes


class _Selection(BaseModel):
    model_config = STRICT
    release_id: str
    manifest_key: str
    manifest_version_id: str
    withdrawn: bool = False


class BrainRegistry:
    def __init__(self, store: ObjectStore, registry_dir: Path) -> None:
        self.store = store
        self.registry_dir = registry_dir
        self._cache: dict[str, ResolvedRelease] = {}

    @staticmethod
    def hash_bytes(body: bytes) -> str:
        return hashlib.sha256(body).hexdigest()

    def register(self, release_id: str, receipt: ObjectReceipt) -> None:
        existing = self._read(release_id)
        key, version_id = parse_object_reference(receipt.reference)
        if existing is not None:
            if existing.withdrawn:
                raise ReleaseError("release_withdrawn")
            if existing.manifest_key != key or existing.manifest_version_id != version_id:
                raise ReleaseError("immutable_conflict")
            return
        self._write(
            _Selection(
                release_id=release_id,
                manifest_key=key,
                manifest_version_id=version_id,
            )
        )

    async def resolve_release(self, release_id: str) -> ResolvedRelease:
        selection = self._read(release_id)
        if selection is None:
            raise ReleaseError("release_unavailable")
        if selection.withdrawn:
            self._cache.pop(release_id, None)
            raise ReleaseError("release_withdrawn")
        cached = self._cache.get(release_id)
        if cached is not None:
            return cached
        manifest = await self._manifest(selection)
        brain = await self._artifact(manifest.brain_artifact_ref, "pinned_brain_unavailable")
        behavior = await self._artifact(manifest.behavior_artifact_ref, "pinned_behavior_unavailable")
        self._require_exact(brain, manifest.canonical_brain_sha256, manifest.canonical_brain_bytes)
        self._require_exact(behavior, manifest.behavior_sha256, manifest.behavior_bytes)
        resolved = ResolvedRelease(
            release_id=release_id,
            manifest=manifest,
            brain_bytes=brain,
            behavior_bytes=behavior,
        )
        self._cache[release_id] = resolved
        return resolved

    async def resolve_without_behavior(self, release_id: str) -> ResolvedRelease:
        """Prove a pin whose behavior object was never stored cannot fall back."""
        selection = self._read(release_id)
        if selection is None:
            raise ReleaseError("release_unavailable")
        manifest = await self._manifest(selection)
        missing = manifest.model_copy(
            update={
                "behavior_artifact_ref": (
                    "esp-object://draft/"
                    + release_id
                    + "/missing-behavior#"
                    + ("f" * 64)
                )
            }
        )
        side_id = release_id + "-missing-behavior"
        body = missing.model_dump_json().encode()
        receipt = await self.store.put_immutable(
            f"draft/{side_id}/manifest.json",
            body,
            {"kind": "manifest", "namespace": "draft"},
        )
        self.register(side_id, receipt)
        return await self.resolve_release(side_id)

    async def publicly_eligible(self, release_id: str) -> bool:
        selection = self._read(release_id)
        if selection is None or selection.withdrawn:
            return False
        manifest = await self._manifest(selection)
        complete = manifest.evaluation_ref is not None and len(manifest.qualification_refs) > 0
        return manifest.status == "production" and complete

    async def withdraw(self, release_id: str) -> None:
        selection = self._read(release_id)
        if selection is None:
            raise ReleaseError("release_unavailable")
        self._cache.pop(release_id, None)
        self._write(selection.model_copy(update={"withdrawn": True}))

    async def read_brain_bytes(self, release_id: str) -> bytes:
        """Read the pinned Brain object even after selection withdrawal. Never substitute."""
        selection = self._read(release_id)
        if selection is None:
            raise ReleaseError("release_unavailable")
        manifest = await self._manifest(selection)
        return await self._artifact(manifest.brain_artifact_ref, "pinned_brain_unavailable")

    async def _manifest(self, selection: _Selection) -> ReleaseManifest:
        raw = await self.store.get(selection.manifest_key, selection.manifest_version_id)
        return ReleaseManifest.model_validate_json(raw)

    async def _artifact(self, reference: str, missing_code: str) -> bytes:
        key, version_id = parse_object_reference(reference)
        try:
            return await self.store.get(key, version_id)
        except ReleaseError as exc:
            if exc.args and exc.args[0] == "object_unavailable":
                raise ReleaseError(missing_code) from exc
            raise

    def _require_exact(self, body: bytes, digest: str, size: int) -> None:
        if len(body) != size or hashlib.sha256(body).hexdigest() != digest:
            raise ReleaseError("artifact_hash_mismatch")

    def _path(self, release_id: str) -> Path:
        if not release_id or "/" in release_id or "\\" in release_id or release_id in {".", ".."}:
            raise ReleaseError("release_id_invalid")
        self.registry_dir.mkdir(parents=True, exist_ok=True)
        return self.registry_dir / f"{release_id}.json"

    def _read(self, release_id: str) -> _Selection | None:
        path = self._path(release_id)
        if not path.is_file():
            return None
        return _Selection.model_validate_json(path.read_text(encoding="utf-8"))

    def _write(self, selection: _Selection) -> None:
        path = self._path(selection.release_id)
        partial = path.with_suffix(".json.partial")
        partial.write_text(selection.model_dump_json(), encoding="utf-8")
        os.replace(partial, path)
