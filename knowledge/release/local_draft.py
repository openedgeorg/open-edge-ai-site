"""Names the first local draft the compose listener publishes.

This module is not an approved Brain release. `scripts/local_listen.py` imports
these constants. The synthetic fixtures under `tests/fixtures/brain/` stay as they are.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BRAIN_DIR = ROOT / "knowledge" / "brain" / "local-draft-v1"
RELEASE_ID = "local-draft-brain-v1"


def load_brain() -> bytes:
    return (BRAIN_DIR / "canonical_brain.md").read_bytes()


def load_behavior() -> bytes:
    return (BRAIN_DIR / "behavior.md").read_bytes()
