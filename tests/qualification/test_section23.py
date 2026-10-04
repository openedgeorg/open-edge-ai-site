"""Section 23 stays pending without approved content and both DA-01 decisions."""

from __future__ import annotations

import pytest

from scripts.evaluate import main


@pytest.mark.qualification
def test_section23_command_is_pending() -> None:
    assert main(["section23", "--provider", "openai", "--release", "unreviewed"]) == 2
    assert main(["section23", "--provider", "xai", "--release", "unreviewed"]) == 2
