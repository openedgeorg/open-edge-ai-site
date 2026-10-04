"""History and source panels use text nodes. A script locator is not a URL."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_history_text_is_not_parsed_as_html() -> None:
    completed = subprocess.run(
        ["node", str(ROOT / "tests" / "e2e" / "render_harness.mjs")],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["text"] == "<script>alert(1)</script>"
    assert payload["usedMarkup"] is True
    assert payload["panelGone"] is True
    assert payload["focusRestored"] is True
    assert "javascript:alert(1)" in payload["locatorText"]
    assert "unverified" in payload["locatorText"]
