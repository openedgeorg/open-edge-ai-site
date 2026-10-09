"""Atlas Node tests. Every tests/e2e/atlas_*.test.mjs file runs under `node --test`."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
E2E = ROOT / "tests" / "e2e"
TIMEOUT_SECONDS = 120


def discover() -> list[Path]:
    return sorted(E2E.glob("atlas_*.test.mjs"))


ATLAS_TESTS = discover()


def test_atlas_node_test_files_exist() -> None:
    assert len(ATLAS_TESTS) >= 1, f"no atlas_*.test.mjs files under {E2E}"


@pytest.mark.parametrize("path", ATLAS_TESTS, ids=lambda path: path.name)
def test_atlas_node_test_file_passes(path: Path) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    completed = subprocess.run(
        [node, "--test", str(path)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=TIMEOUT_SECONDS,
    )
    assert completed.returncode == 0, (
        f"{path.name} exited {completed.returncode}\n{completed.stdout}\n{completed.stderr}"
    )
