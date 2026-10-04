"""Conversation client. Playwright is not installed; Node drives the same controller."""

from __future__ import annotations

import json
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "tests" / "e2e" / "client_harness.mjs"


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
