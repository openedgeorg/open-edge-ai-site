"""Atlas Node tests. Every tests/e2e/atlas_*.test.mjs file runs under `node --test`.

The browser files (atlas_browser*.test.mjs) drive headless Chrome against the real site/index.html
and the real site/js/atlas*.js. The conversation client in their page is chosen by ATLAS_CHAT
(see tests/e2e/atlas_browser_support.mjs):

* ``double`` (what the default run below uses): tests/fixtures/atlas_chat_double/app.js is served at
  /js/app.js. The run depends only on what is committed, so it passes on a clean checkout of the
  repository whatever state site/js/app.js, api.js and state.js are in.
* ``real``: the working tree's own site/js/app.js is served. It needs a chat client that can follow
  a stream, fill the history, settle and send the CSRF header; the second test below skips, saying
  what is missing, when the tree has none of that.

What the real run adds over the double run: the double paints like the live client because it is a
self-contained port of the working-tree client (site/js/app.js, api.js, state.js) as of 2026-10-10;
the sha256 of those three files is recorded in the header of the fixture. It is not an independent
reconstruction, and it can drift from the live client. Only a run on the real client notices a change
in how the shipped client really paints (its element updates, its timing, its request headers).
atlas_chat_double.test.mjs and atlas_browser_double.test.mjs keep the double honest: they play the
same scripted scenarios against both clients and compare phases, rows, drafts, storage and every
request. What no run covers: citations and the source panel of the live client, and the live API.

`node --test` runs test FILES in parallel and every browser file starts its own Chrome, so the
browser files run here one at a time (``--test-concurrency=1``, one pytest item per file, and a
machine-wide lock so that two pytest sessions do not start browser files side by side either).
"""

from __future__ import annotations

import contextlib
import functools
import json
import os
import shutil
import subprocess
import tempfile
from collections.abc import Generator, Sequence
from pathlib import Path

import pytest

try:  # POSIX only; without it the browser files are simply not serialised across sessions
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]

ROOT = Path(__file__).resolve().parents[2]
E2E = ROOT / "tests" / "e2e"
SUPPORT = E2E / "atlas_browser_support.mjs"
DOUBLE = ROOT / "tests" / "fixtures" / "atlas_chat_double" / "app.js"
TIMEOUT_SECONDS = 120
BROWSER_TIMEOUT_SECONDS = 360
LOCK_PATH = Path(tempfile.gettempdir()) / "atlas-browser-tests.lock"


def discover() -> list[Path]:
    return sorted(E2E.glob("atlas_*.test.mjs"))


ATLAS_TESTS = discover()
BROWSER_TESTS = [path for path in ATLAS_TESTS if path.name.startswith("atlas_browser")]
# This file serves BOTH clients itself, whatever ATLAS_CHAT says, so a second run with ATLAS_CHAT=real adds nothing.
BOTH_CLIENTS_ITSELF = {"atlas_browser_double.test.mjs"}
REAL_CLIENT_TESTS = [path for path in BROWSER_TESTS if path.name not in BOTH_CLIENTS_ITSELF]


@contextlib.contextmanager
def browser_lock() -> Generator[None]:
    """One browser file at a time on this machine (they are timing sensitive and each starts a Chrome)."""
    if fcntl is None:
        yield
        return
    with LOCK_PATH.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def run_node_test(
    node: str,
    path: Path,
    *,
    chat: str | None = None,
    extra_args: Sequence[str] = (),
    timeout: int = TIMEOUT_SECONDS,
) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    if chat is not None:
        env["ATLAS_CHAT"] = chat
    return subprocess.run(
        [node, "--test", *extra_args, str(path)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
    )


def assert_passed(path: Path, completed: subprocess.CompletedProcess[str]) -> None:
    assert completed.returncode == 0, (
        f"{path.name} exited {completed.returncode}\n{completed.stdout}\n{completed.stderr}"
    )


@functools.cache
def real_chat_capability(node: str) -> tuple[bool, tuple[str, ...]]:
    """Ask the browser support module (the one place that knows) whether the working tree's chat client can run."""
    script = (
        f"import({json.dumps(SUPPORT.as_uri())})"
        ".then((m) => process.stdout.write(JSON.stringify(m.realChatCapability())));"
    )
    completed = subprocess.run(
        [node, "-e", script],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
        env={key: value for key, value in os.environ.items() if key != "ATLAS_CHAT"},
    )
    assert completed.returncode == 0, completed.stderr
    answer = json.loads(completed.stdout)
    return bool(answer["ok"]), tuple(str(item) for item in answer["missing"])


def test_atlas_node_test_files_exist() -> None:
    assert len(ATLAS_TESTS) >= 1, f"no atlas_*.test.mjs files under {E2E}"
    assert len(BROWSER_TESTS) >= 2, "the browser suites are missing"


def test_atlas_chat_double_is_self_contained() -> None:
    """The stand-in client must not lean on the files whose state it makes the browser suites independent of."""
    source = DOUBLE.read_text(encoding="utf-8")
    for line in source.splitlines():
        stripped = line.strip()
        assert not stripped.startswith("import "), f"the double must not import anything: {stripped}"
        assert 'from "./' not in stripped and "from '../" not in stripped, stripped
    assert "export function createController" in source
    for method in ("boot", "send", "reload", "focus", "stream", "showHistory", "follow"):
        assert f"{method}(" in source, f"the double has no {method}"


def test_atlas_browser_suites_default_to_the_double() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    script = (
        f"import({json.dumps(SUPPORT.as_uri())})"
        ".then((m) => process.stdout.write(JSON.stringify({"
        " mode: m.CHAT_SETUP.mode, served: m.siteFileFor('/js/app.js'), api: m.siteFileFor('/js/api.js') })));"
    )
    env = {key: value for key, value in os.environ.items() if key != "ATLAS_CHAT"}
    completed = subprocess.run(
        [node, "-e", script], cwd=ROOT, check=False, capture_output=True, text=True, timeout=30, env=env
    )
    assert completed.returncode == 0, completed.stderr
    answer = json.loads(completed.stdout)
    assert answer["mode"] == "double"
    assert Path(answer["served"]) == DOUBLE
    assert Path(answer["api"]) == ROOT / "site" / "js" / "api.js"


@pytest.mark.parametrize("path", ATLAS_TESTS, ids=lambda path: path.name)
def test_atlas_node_test_file_passes(path: Path) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    if path in BROWSER_TESTS:
        with browser_lock():
            completed = run_node_test(
                node,
                path,
                chat="double",
                extra_args=("--test-concurrency=1",),
                timeout=BROWSER_TIMEOUT_SECONDS,
            )
    else:
        completed = run_node_test(node, path)
    assert_passed(path, completed)


@pytest.mark.parametrize("path", REAL_CLIENT_TESTS, ids=lambda path: f"{path.name}[real chat client]")
def test_atlas_browser_file_passes_with_the_working_trees_chat_client(path: Path) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    capable, missing = real_chat_capability(node)
    if not capable:
        pytest.skip("the working tree's own chat client cannot run the browser suites: " + "; ".join(missing))
    with browser_lock():
        completed = run_node_test(
            node,
            path,
            chat="real",
            extra_args=("--test-concurrency=1",),
            timeout=BROWSER_TIMEOUT_SECONDS,
        )
    assert_passed(path, completed)
