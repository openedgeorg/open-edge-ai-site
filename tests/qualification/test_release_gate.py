"""The v1 release command stays blocked without a complete evidence bundle."""

from __future__ import annotations

import pytest

from scripts.release_gate import run_release


@pytest.mark.qualification
def test_release_milestone_is_blocked() -> None:
    assert run_release("v1") == 2
    assert run_release("section23") == 2
