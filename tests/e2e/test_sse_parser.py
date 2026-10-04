"""SSE frames can split inside a UTF-8 character. The parser emits one JSON event per frame."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_split_utf8_frames_parse_as_two_events() -> None:
    completed = subprocess.run(
        ["node", str(ROOT / "tests" / "e2e" / "sse_harness.mjs")],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["events"] == [{"id": "one"}, {"id": "two", "text": "é"}]
