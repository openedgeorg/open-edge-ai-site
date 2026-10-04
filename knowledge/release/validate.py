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


def require_import_provenance(source_revision: str, owner_review_ref: str | None, manifest_revision: str) -> None:
    """A candidate import needs an owner review ref and the same source revision. No corpus is invented."""
    if not owner_review_ref:
        raise ReleaseError("unreviewed_import")
    if not source_revision or source_revision != manifest_revision:
        raise ReleaseError("import_revision_mismatch")
