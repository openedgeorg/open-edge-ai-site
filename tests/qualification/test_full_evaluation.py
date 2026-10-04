"""G3 stays pending until the owner supplies reviewed cases and both qualified profiles."""

from __future__ import annotations

import pytest

from scripts.evaluate import main


@pytest.mark.qualification
def test_g3_command_is_pending() -> None:
    assert main(["g3", "--provider", "openai", "--release", "unreviewed"]) == 2
    assert main(["g3", "--provider", "xai", "--release", "unreviewed"]) == 2
