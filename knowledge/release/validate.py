"""Check raw artifact bytes without rewriting them."""

from __future__ import annotations

import hashlib

from esp_contracts.release import ReleaseError


def require_utf8(body: bytes) -> None:
    try:
        body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ReleaseError("invalid_utf8") from exc


def require_digest(body: bytes, digest: str, size: int) -> None:
    if len(body) != size or hashlib.sha256(body).hexdigest() != digest:
        raise ReleaseError("artifact_hash_mismatch")
