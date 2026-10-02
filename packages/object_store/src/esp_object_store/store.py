"""Content-addressed files. A partial temp file never becomes the selected object."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from esp_contracts.release import ReleaseError


@dataclass(frozen=True)
class ObjectReceipt:
    version_id: str
    sha256: str
    reference: str


class ObjectStore(Protocol):
    async def put_immutable(self, key: str, body: bytes, metadata: dict[str, str]) -> ObjectReceipt: ...

    async def get(self, key: str, version_id: str | None = None) -> bytes: ...


def object_reference(key: str, version_id: str) -> str:
    return f"esp-object://{key}#{version_id}"


def parse_object_reference(reference: str) -> tuple[str, str]:
    prefix = "esp-object://"
    if not reference.startswith(prefix) or "#" not in reference[len(prefix) :]:
        raise ReleaseError("artifact_reference_invalid")
    key, version_id = reference[len(prefix) :].split("#", 1)
    if not key or not version_id:
        raise ReleaseError("artifact_reference_invalid")
    return key, version_id


class FileObjectStore:
    def __init__(self, root: Path) -> None:
        self.root = root

    async def put_immutable(self, key: str, body: bytes, metadata: dict[str, str]) -> ObjectReceipt:
        path = self._path(key)
        digest = hashlib.sha256(body).hexdigest()
        if path.is_file():
            existing = path.read_bytes()
            if existing != body:
                raise ReleaseError("immutable_conflict")
            return self._receipt(key, digest)
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_name(path.name + ".partial")
        partial.write_bytes(body)
        os.replace(partial, path)
        meta_path = path.with_name(path.name + ".meta.json")
        meta_path.write_text(json.dumps(metadata, sort_keys=True), encoding="utf-8")
        return self._receipt(key, digest)

    async def get(self, key: str, version_id: str | None = None) -> bytes:
        path = self._path(key)
        if not path.is_file():
            raise ReleaseError("object_unavailable")
        body = path.read_bytes()
        digest = hashlib.sha256(body).hexdigest()
        if version_id is not None and version_id != digest:
            raise ReleaseError("object_version_mismatch")
        return body

    def _receipt(self, key: str, digest: str) -> ObjectReceipt:
        return ObjectReceipt(version_id=digest, sha256=digest, reference=object_reference(key, digest))

    def _path(self, key: str) -> Path:
        parts = Path(key).parts
        if not key or key.startswith("/") or ".." in parts:
            raise ReleaseError("object_key_invalid")
        root = self.root.resolve()
        path = (root / key).resolve()
        if not path.is_relative_to(root):
            raise ReleaseError("object_key_invalid")
        return path
