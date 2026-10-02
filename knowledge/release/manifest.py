"""Translate the §8.3 legacy brain hash once. Conflicting names are rejected."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError

from esp_contracts.release import ReleaseError, ReleaseManifest


def manifest_from_document(document: Mapping[str, Any]) -> ReleaseManifest:
    data = dict(document)
    legacy = data.pop("brain_sha256", None)
    canonical = data.get("canonical_brain_sha256")
    if legacy is not None and canonical is not None and legacy != canonical:
        raise ReleaseError("legacy_hash_conflict")
    if canonical is None and legacy is not None:
        data["canonical_brain_sha256"] = legacy
    try:
        return ReleaseManifest.model_validate(data)
    except ValidationError as exc:
        raise ReleaseError("manifest_invalid") from exc
