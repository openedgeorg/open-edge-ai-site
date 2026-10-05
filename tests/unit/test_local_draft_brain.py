"""The local draft is what xAI injection places. The 56-byte canary is not."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from esp_contracts.release import ReleaseManifest
from esp_espcon.brain_registry import ResolvedRelease
from esp_inference_gateway.adapters.xai_responses import XAIResponsesAdapter
from esp_inference_gateway.brain_verifier import verify_and_serialize
from knowledge.release.local_draft import BRAIN_DIR, RELEASE_ID, load_behavior, load_brain

CANARY_SHA256 = "0f956bfa6968d29f45aae57ff9471911e22917415580fcdc91c5542ffab8b9d7"
CANARY_LENGTH = 56
CANARY_MARK = b"synthetic-canary brain A"
PREVIOUS_SHA256 = "b0d8d1284bbbb209fb7b82878b29b12ca548af087624902bcbc4ab5fc082793c"
PREVIOUS_LENGTH = 18514
SOURCE_PATH = Path("/home/ibmko/lab/oe/materials/Whitepaper/v0.2/notes-allowance-architecture-summary.md")
SOURCE_SHA256 = "64d61152a7a9497e2372d8aea13bcef6dd1b4c2a8e67a1ce72163ebed00c84ae"
SOURCE_LENGTH = 34170
BRAIN_SHA256 = "64992ad1e7890727873ee2505af5d18b61cd6afe5279684c088809fde45fc478"
BRAIN_LENGTH = 34918
LISTENER = Path("scripts/local_listen.py")


def _release() -> ResolvedRelease:
    brain = load_brain()
    behavior = load_behavior()
    manifest = ReleaseManifest(
        brain_version=RELEASE_ID,
        canonical_brain_sha256=hashlib.sha256(brain).hexdigest(),
        canonical_brain_bytes=len(brain),
        behavior_version=f"{RELEASE_ID}-behavior",
        behavior_sha256=hashlib.sha256(behavior).hexdigest(),
        behavior_bytes=len(behavior),
        source_revision="repo-local-draft-v2",
        created_at=datetime(2026, 10, 4, tzinfo=UTC),
        status="draft",
        brain_artifact_ref="pending-brain",
        behavior_artifact_ref="pending-behavior",
        corpus_release_id="local-compose-corpus",
    )
    return ResolvedRelease(release_id=RELEASE_ID, manifest=manifest, brain_bytes=brain, behavior_bytes=behavior)


def test_xai_messages_inject_the_local_draft_not_the_canary() -> None:
    brain = load_brain()
    behavior = load_behavior()
    source = SOURCE_PATH.read_bytes()
    assert RELEASE_ID == "local-draft-brain-v2"
    assert BRAIN_DIR.name == "local-draft-v2"
    assert len(brain) == BRAIN_LENGTH
    assert hashlib.sha256(brain).hexdigest() == BRAIN_SHA256
    assert len(source) == SOURCE_LENGTH
    assert hashlib.sha256(source).hexdigest() == SOURCE_SHA256
    assert brain.count(source) == 1
    source_at = brain.find(source)
    assert brain[source_at : source_at + len(source)] == source
    assert len(behavior) != 41
    assert len(brain) != CANARY_LENGTH
    assert hashlib.sha256(brain).hexdigest() != CANARY_SHA256
    assert CANARY_MARK not in brain
    assert b"synthetic-canary" not in brain
    assert b"synthetic-canary" not in behavior
    assert hashlib.sha256(brain).hexdigest() != PREVIOUS_SHA256
    assert len(brain) != PREVIOUS_LENGTH
    assert b"FIRST LOCAL DRAFT" not in brain

    release = _release()
    raw = json.dumps(
        {"model": "grok-4.7", "messages": [{"role": "user", "content": "what is ESP?"}]}
    ).encode()
    verified = verify_and_serialize(raw, release, XAIResponsesAdapter())
    assert verified.brain_action == "injected"
    assert verified.brain.content_path == "messages[0].content"
    assert verified.brain.length == len(brain)
    assert verified.brain.length == BRAIN_LENGTH
    assert verified.brain.length != CANARY_LENGTH
    assert verified.brain.length != PREVIOUS_LENGTH
    assert verified.brain.sha256 == hashlib.sha256(brain).hexdigest()
    assert verified.brain.sha256 == BRAIN_SHA256
    assert verified.brain.sha256 != CANARY_SHA256
    assert verified.brain.sha256 != PREVIOUS_SHA256
    assert CANARY_MARK not in verified.body
    assert b"synthetic-canary" not in verified.body

    document = json.loads(verified.body)
    content = document["messages"][0]["content"].encode("utf-8")
    extracted = content[verified.brain.start_offset : verified.brain.end_offset]
    assert extracted == brain
    assert len(extracted) == BRAIN_LENGTH
    assert hashlib.sha256(extracted).hexdigest() == BRAIN_SHA256
    assert len(extracted) != CANARY_LENGTH
    assert hashlib.sha256(extracted).hexdigest() != CANARY_SHA256
    assert CANARY_MARK not in extracted
    assert b"synthetic-canary" not in extracted
    assert len(extracted) != PREVIOUS_LENGTH
    assert hashlib.sha256(extracted).hexdigest() != PREVIOUS_SHA256
    assert b"FIRST LOCAL DRAFT" not in extracted
    assert document["messages"][0]["role"] == "system"
    assert document["messages"][1]["content"] == "what is ESP?"


def test_local_listener_selects_this_draft_when_the_file_is_present() -> None:
    """The listener file is local working-tree code. When it exists, it must publish this draft."""
    if not LISTENER.is_file():
        pytest.skip("scripts/local_listen.py is local working-tree code and is not in this checkout")
    text = LISTENER.read_text(encoding="utf-8")
    assert "from knowledge.release.local_draft import BRAIN_DIR, RELEASE_ID" in text
    assert 'RELEASE_ID = "local-compose-brain"' not in text
    assert "tests/fixtures/brain/release_a" not in text
    assert "synthetic-canary brain A" not in text
