"""Conversation client. Playwright is not installed; Node drives the same controller.

Two layers: a few contract cases are driven from Python through `client_harness.mjs` (the real controller
behind a fake fetch, one JSON line at a time), and every `chat_client_*.test.mjs` file runs under `node --test`
(the real client against a fake backend that follows the API contract, on a manual clock).
"""

from __future__ import annotations

import contextlib
import json
import shutil
import subprocess
import tempfile
from collections.abc import Generator, Iterator
from pathlib import Path
from typing import cast

import pytest

try:  # POSIX only; without it the browser file is simply not serialised across sessions
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]

ROOT = Path(__file__).resolve().parents[2]
E2E = ROOT / "tests" / "e2e"
HARNESS = E2E / "client_harness.mjs"
CHAT_CLIENT_TESTS = sorted(E2E.glob("chat_client_*.test.mjs"))
BROWSER_FILE = "chat_client_browser.test.mjs"
# The same machine-wide lock the Atlas browser files use (tests/e2e/test_atlas.py): one Chrome file at a time.
LOCK_PATH = Path(tempfile.gettempdir()) / "atlas-browser-tests.lock"


@contextlib.contextmanager
def browser_lock() -> Generator[None]:
    if fcntl is None:
        yield
        return
    with LOCK_PATH.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


class _Node:
    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            ["node", str(HARNESS)],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )

    def call(self, method: str, **payload: object) -> object:
        assert self.proc.stdin is not None
        assert self.proc.stdout is not None
        self.proc.stdin.write(json.dumps({"method": method, **payload}) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        body = json.loads(line)
        if "error" in body:
            raise AssertionError(f"client harness failed on {method}: {body['error']}")
        result = body["result"]
        return result

    def close(self) -> None:
        if self.proc.stdin is not None:
            self.proc.stdin.close()
        self.proc.terminate()
        self.proc.wait(timeout=5)


class Page:
    def __init__(self, node: _Node) -> None:
        self.node = node

    def reload(self) -> None:
        self.node.call("reload")

    def get_by_role(self, role: str, *, name: str, exact: bool = False) -> Locator:
        del role, exact
        assert name == "Send"
        return Locator(self.node)


class Locator:
    def __init__(self, node: _Node) -> None:
        self.node = node

    def to_be_disabled(self) -> None:
        assert self.node.call("send_disabled") is True


class BrowserLab:
    def __init__(self, node: _Node) -> None:
        self.node = node

    def lose_acceptance_response(self) -> None:
        self.node.call("lose")

    def send_once(self, page: Page, text: str) -> None:
        del page
        self.node.call("send", text=text)

    def wait_for_status_check(self) -> None:
        assert _as_int(self.node.call("status_gets")) >= 1

    @property
    def post_count(self) -> int:
        return _as_int(self.node.call("post_count"))


def expect(locator: Locator) -> Locator:
    return locator


@pytest.fixture
def node_client() -> Iterator[_Node]:
    client = _Node()
    yield client
    client.close()


def _as_int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise AssertionError("expected an integer from the client harness")
    return value


@pytest.fixture
def page(node_client: _Node) -> Page:
    return Page(node_client)


@pytest.fixture
def browser_lab(node_client: _Node) -> BrowserLab:
    return BrowserLab(node_client)


def test_uncertain_submit_checks_status_before_retry(page: Page, browser_lab: BrowserLab) -> None:
    browser_lab.lose_acceptance_response()
    browser_lab.send_once(page, "draft canary")
    assert browser_lab.post_count == 1
    page.reload()
    browser_lab.wait_for_status_check()
    assert browser_lab.post_count == 1
    expect(page.get_by_role("button", name="Send", exact=True)).to_be_disabled()


def test_rate_limit_keeps_the_draft_until_manual_retry(page: Page, browser_lab: BrowserLab) -> None:
    browser_lab.node.call("rate_limit")
    browser_lab.send_once(page, "keep me")
    assert browser_lab.post_count == 1
    page.node.call("focus")
    assert browser_lab.post_count == 1
    assert page.node.call("draft") == "keep me"
    assert page.node.call("send_disabled") is False
    assert page.node.call("local_writes") == 0


def test_unconfirmed_submission_is_checked_with_its_request_id_and_never_offered_a_retry(
    page: Page, browser_lab: BrowserLab
) -> None:
    browser_lab.lose_acceptance_response()
    browser_lab.send_once(page, "did it go?")
    request_id = _bodies(page.node)[0]["client_request_id"]
    assert page.node.call("phase") == "reconciling"
    assert page.node.call("send_disabled") is True
    assert _actions(page.node)["retry"] is False
    assert page.node.call("draft") == "", "the pending question is not turned into a draft"
    for _ in range(3):
        page.reload()
    assert browser_lab.post_count == 1
    assert _bodies(page.node)[0]["client_request_id"] == request_id
    assert _actions(page.node)["retry"] is False
    assert "will not be sent again" in str(page.node.call("status_text"))


def test_a_status_that_allows_resubmission_offers_one_safe_retry_with_the_same_request_id(
    page: Page, browser_lab: BrowserLab
) -> None:
    page.node.call("set_status", reply=_status("not_started", resubmission_allowed=True, run=None, work=None))
    browser_lab.lose_acceptance_response()
    browser_lab.send_once(page, "never arrived")
    assert page.node.call("phase") == "failed"
    assert _actions(page.node)["retry"] is True
    assert page.node.call("send_disabled") is False
    page.node.call("accept")
    page.node.call("set_status", reply=_status("running"))
    page.node.call("send", text="", options={"retry": True})
    bodies = _bodies(page.node)
    assert len(bodies) == 2
    assert bodies[1]["client_request_id"] == bodies[0]["client_request_id"]
    assert bodies[1]["message"] == "never arrived"
    assert page.node.call("phase") == "running"


def test_a_status_that_says_running_is_consumed_not_treated_as_another_reconciling(
    page: Page, browser_lab: BrowserLab
) -> None:
    page.node.call("set_status", reply=_status("running"))
    browser_lab.lose_acceptance_response()
    browser_lab.send_once(page, "slow one")
    assert page.node.call("phase") == "running"
    assert _actions(page.node)["cancel"] is True, "the status named the run, so Cancel is offered"
    assert browser_lab.post_count == 1


def test_refresh_never_resends_an_accepted_question(page: Page, browser_lab: BrowserLab) -> None:
    page.node.call("accept")
    page.node.call("set_status", reply=_status("running"))
    browser_lab.send_once(page, "hello there")
    assert page.node.call("phase") == "running"
    for _ in range(3):
        page.reload()
        assert browser_lab.post_count == 1
    saved = page.node.call("saved")
    assert isinstance(saved, dict)
    assert saved["requestId"] == _bodies(page.node)[0]["client_request_id"]
    assert saved["submitted"] == "hello there"


def test_the_unsent_draft_survives_a_reload_and_is_not_a_pending_question(page: Page) -> None:
    page.node.call("edit_draft", text="Could you give a household example?")
    page.reload()
    assert page.node.call("draft") == "Could you give a household example?"
    saved = page.node.call("saved")
    assert isinstance(saved, dict)
    assert saved["submitted"] == ""
    assert "undefined" not in json.dumps(saved)


def _status(
    outcome: str, *, resubmission_allowed: bool = False, run: str | None = "run-1", work: str | None = "work-1"
) -> dict[str, object]:
    """A SubmissionView as GET /status answers it."""
    return {
        "outcome": outcome,
        "resubmission_allowed": resubmission_allowed,
        "active_agent_run_id": run,
        "native_work_ref": work,
        "runtime_state": "running",
    }


def _bodies(node: _Node) -> list[dict[str, str]]:
    bodies = node.call("post_bodies")
    assert isinstance(bodies, list)
    return cast("list[dict[str, str]]", bodies)


def _actions(node: _Node) -> dict[str, object]:
    actions = node.call("actions")
    assert isinstance(actions, dict)
    return cast("dict[str, object]", actions)


@pytest.mark.parametrize("path", CHAT_CLIENT_TESTS, ids=lambda path: path.name)
def test_chat_client_node_suite_passes(path: Path) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    command = [node, "--test", "--test-concurrency=1", str(path)]
    if path.name == BROWSER_FILE:
        with browser_lock():
            completed = subprocess.run(command, cwd=ROOT, check=False, capture_output=True, text=True, timeout=360)
    else:
        completed = subprocess.run(command, cwd=ROOT, check=False, capture_output=True, text=True, timeout=120)
    detail = f"{path.name} exited {completed.returncode}\n{completed.stdout}\n{completed.stderr}"
    assert completed.returncode == 0, detail
