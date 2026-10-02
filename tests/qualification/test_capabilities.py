"""Live capability inventory. A passing unit recorder is not this evidence."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def test_installed_candidates_are_not_validated() -> None:
    root = Path(__file__).resolve().parents[2]
    for provider in ("openai", "xai"):
        completed = subprocess.run(
            [sys.executable, "scripts/qualify.py", "inspect", "--provider", provider, "--json"],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
        assert completed.returncode != 0
        payload = json.loads(completed.stdout)
        assert payload["classification"] == "pending"
        assert payload["status"] != "validated"
