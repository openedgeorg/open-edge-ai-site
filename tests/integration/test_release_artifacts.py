"""Immutable Brain bytes stay separate from the pinned behavior block."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from esp_contracts.release import ReleaseError
from esp_object_store.s3 import S3ObjectStore
from tests.support.release import ReleaseLab, build_release_lab


@pytest.fixture
async def release_lab(tmp_path: Path) -> AsyncIterator[ReleaseLab]:
    lab = await build_release_lab(tmp_path)
    yield lab


async def test_separate_pinned_artifacts_never_fall_back(release_lab: ReleaseLab) -> None:
    resolved = await release_lab.resolve("fixture-a")
    assert resolved.brain_bytes == release_lab.raw_a
    assert resolved.behavior_bytes == release_lab.behavior_a
    assert not await release_lab.publicly_eligible("fixture-a")
    with pytest.raises(ReleaseError, match="pinned_behavior_unavailable"):
        await release_lab.resolve_with_missing_behavior("fixture-a")


async def test_preserves_multibyte_crlf_and_trailing_newline(release_lab: ReleaseLab) -> None:
    assert b"\r\n" in release_lab.raw_a
    assert release_lab.raw_a.endswith(b"\n")
    assert "café".encode() in release_lab.raw_a
    assert "日本語".encode() in release_lab.raw_a
    assert "e\u0301".encode() in release_lab.raw_a
    resolved = await release_lab.resolve("fixture-a")
    assert resolved.brain_bytes == release_lab.raw_a
    assert resolved.behavior_bytes == release_lab.behavior_a


async def test_distinct_version_and_hash_identity(release_lab: ReleaseLab) -> None:
    first = await release_lab.resolve("fixture-a")
    second = await release_lab.resolve("fixture-b")
    assert first.manifest.brain_version != second.manifest.brain_version
    assert first.manifest.canonical_brain_sha256 != second.manifest.canonical_brain_sha256
    assert first.manifest.behavior_sha256 != second.manifest.behavior_sha256
    assert first.brain_bytes != second.brain_bytes
    assert first.behavior_bytes != second.behavior_bytes


async def test_refuses_different_overwrite_and_accepts_identical_bytes(release_lab: ReleaseLab) -> None:
    with pytest.raises(ReleaseError, match="immutable_conflict"):
        await release_lab.overwrite_different()
    receipt = await release_lab.overwrite_same()
    assert await release_lab.store.get("draft/same", receipt.version_id) == release_lab.raw_a


async def test_legacy_hash_translates_once_and_rejects_conflict(release_lab: ReleaseLab) -> None:
    translated = release_lab.translate_legacy()
    assert translated.canonical_brain_sha256 == release_lab.registry.hash_bytes(release_lab.raw_a)
    with pytest.raises(ReleaseError, match="legacy_hash_conflict"):
        release_lab.conflicting_legacy()


async def test_withdrawn_cache_is_unavailable_without_substitution(release_lab: ReleaseLab) -> None:
    warmed = await release_lab.resolve("fixture-a")
    assert warmed.brain_bytes == release_lab.raw_a
    await release_lab.withdraw("fixture-a")
    with pytest.raises(ReleaseError, match="release_withdrawn"):
        await release_lab.resolve("fixture-a")
    assert await release_lab.stored_brain("fixture-a") == release_lab.raw_a
    assert (await release_lab.resolve("fixture-b")).brain_bytes == release_lab.raw_b


async def test_new_publication_leaves_old_pin_bytes_unchanged(release_lab: ReleaseLab) -> None:
    before = await release_lab.resolve("fixture-a")
    await release_lab.resolve("fixture-b")
    after = await release_lab.resolve("fixture-a")
    assert after.brain_bytes == before.brain_bytes == release_lab.raw_a
    assert after.behavior_bytes == before.behavior_bytes == release_lab.behavior_a
    assert after.manifest.behavior_sha256 == before.manifest.behavior_sha256


async def test_partial_upload_cannot_enable_selection(release_lab: ReleaseLab) -> None:
    await release_lab.upload_brain_only("partial-release")
    with pytest.raises(ReleaseError, match="release_unavailable"):
        await release_lab.resolve("partial-release")


async def test_candidate_publication_rejects_production_status(release_lab: ReleaseLab) -> None:
    with pytest.raises(ReleaseError, match="production_publication_closed"):
        await release_lab.publish_production()


async def test_s3_store_refuses_conflicting_overwrite() -> None:
    store = S3ObjectStore(
        endpoint="127.0.0.1:59000",
        access_key="test",
        secret_key="test",
        bucket="esp-draft",
        secure=False,
    )
    body = b"synthetic-canary s3\r\ncaf\xc3\xa9\n"
    key = f"draft/s3-{uuid.uuid4()}"
    receipt = await store.put_immutable(key, body, {"kind": "brain", "namespace": "draft"})
    assert receipt.sha256 == receipt.version_id
    assert await store.get(key, receipt.version_id) == body
    again = await store.put_immutable(key, body, {"kind": "brain", "namespace": "draft"})
    assert again.reference == receipt.reference
    with pytest.raises(ReleaseError, match="immutable_conflict"):
        await store.put_immutable(key, body + b"x", {"kind": "brain", "namespace": "draft"})
