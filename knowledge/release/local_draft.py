"""Names the initial local brain the compose listener publishes.

The essential content is the notes file at
`/home/ibmko/lab/oe/materials/Whitepaper/v0.2/notes-allowance-architecture-summary.md`.
This module is not an approved Brain release. `scripts/local_listen.py` imports
these constants. The synthetic fixtures under `tests/fixtures/brain/` stay as they are.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BRAIN_DIR = ROOT / "knowledge" / "brain" / "local-draft-v2"
RELEASE_ID = "local-draft-brain-v2"


def load_brain() -> bytes:
    return (BRAIN_DIR / "canonical_brain.md").read_bytes()


def load_behavior() -> bytes:
    return (BRAIN_DIR / "behavior.md").read_bytes()
