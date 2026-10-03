"""Atomic Valkey rate counters: one script updates the allowance and its expiry together.

Every check here runs against real Valkey from several independent clients. Entries hold an opaque
HMAC scope key and two integers; nothing else is ever written.
"""

from __future__ import annotations

import asyncio
import re
import time
import uuid
from collections.abc import AsyncIterator

import pytest
from pydantic import ValidationError

from esp_request_admission.rate_limits import (
    CounterStoreUnavailable,
    RatePolicy,
    connect_rate_limiter,
    token_bucket_script,
)
from tests.support.admission import UNREACHABLE_VALKEY_URL, VALKEY_URL, RateLab, open_rate_lab

OUTAGE_BUDGET_SECONDS = 1.5
OPAQUE_KEY = re.compile(r"esp:rl:[0-9a-f]{64}")


@pytest.fixture
async def rate_lab() -> AsyncIterator[RateLab]:
    lab = await open_rate_lab()
    try:
        yield lab
    finally:
        await lab.close()


def subject() -> str:
    return f"test-rate-subject-{uuid.uuid4().hex}"


async def test_concurrent_checks_never_exceed_capacity(rate_lab: RateLab) -> None:
    policy = RatePolicy(policy_id="test-rate-burst", window_seconds=3600, capacity=5, refill=1, expiry_seconds=18000)
    visitor = subject()
    key = rate_lab.key(visitor, policy)
    decisions = await asyncio.gather(
        *(rate_lab.limiters[index % len(rate_lab.limiters)].check_rate(visitor, policy) for index in range(40))
    )
    assert sum(decision.allowed for decision in decisions) == 5
    for decision in decisions:
        if decision.allowed:
            assert decision.retry_after_seconds is None
        else:
            assert decision.retry_after_seconds is not None and 1 <= decision.retry_after_seconds <= 3600
            assert decision.remaining == 0
    ttl = await rate_lab.raw.pttl(key)
    assert 0 < ttl <= 18000 * 1000


async def test_entries_hold_only_an_opaque_key_and_integers(rate_lab: RateLab) -> None:
    policy = RatePolicy(policy_id="test-rate-shape", window_seconds=60, capacity=3, refill=3, expiry_seconds=60)
    visitor = subject()
    key = rate_lab.key(visitor, policy)
    decision = await rate_lab.limiters[0].check_rate(visitor, policy)
    assert decision.allowed and decision.remaining == 2
    assert OPAQUE_KEY.fullmatch(key)
    assert visitor not in key and policy.policy_id not in key
    entry = await rate_lab.entry(key)
    assert set(entry) == {"t", "ts"}
    assert all(re.fullmatch(r"[0-9]+", value) for value in entry.values())
    script = token_bucket_script()
    assert "HSET" in script and "PEXPIRE" in script and "TIME" in script


async def test_scope_keys_separate_secrets_policies_and_subjects(rate_lab: RateLab) -> None:
    policy = RatePolicy(policy_id="test-rate-scope", window_seconds=60, capacity=1, refill=1, expiry_seconds=60)
    revised = policy.model_copy(update={"capacity": 2, "expiry_seconds": 120})
    other_secret = connect_rate_limiter(VALKEY_URL, scope_key=b"\x01" * 16 + b"\x02" * 16, timeout_seconds=0.5)
    try:
        visitor = subject()
        keys = {
            rate_lab.limiters[0].key_for(visitor, policy),
            rate_lab.limiters[0].key_for(visitor, revised),
            rate_lab.limiters[0].key_for(subject(), policy),
            other_secret.key_for(visitor, policy),
        }
    finally:
        await other_secret.aclose()
    assert len(keys) == 4
    assert rate_lab.limiters[1].key_for(visitor, policy) == rate_lab.limiters[0].key_for(visitor, policy)


async def test_expiry_is_set_with_every_update_and_only_drops_a_full_bucket(rate_lab: RateLab) -> None:
    policy = RatePolicy(policy_id="test-rate-expiry", window_seconds=1, capacity=1, refill=1, expiry_seconds=1)
    visitor = subject()
    key = rate_lab.key(visitor, policy)
    first = await rate_lab.limiters[0].check_rate(visitor, policy)
    second = await rate_lab.limiters[1].check_rate(visitor, policy)
    assert first.allowed and not second.allowed
    assert second.retry_after_seconds == 1
    for _ in range(5):
        await rate_lab.limiters[2].check_rate(visitor, policy)
        assert 0 < await rate_lab.raw.pttl(key) <= 1000
    await asyncio.sleep(1.2)
    assert await rate_lab.raw.exists(key) == 0
    assert (await rate_lab.limiters[3].check_rate(visitor, policy)).allowed


async def test_refill_is_proportional_and_capped_at_capacity(rate_lab: RateLab) -> None:
    policy = RatePolicy(policy_id="test-rate-refill", window_seconds=1, capacity=2, refill=4, expiry_seconds=1)
    visitor = subject()
    rate_lab.key(visitor, policy)
    drained = [await rate_lab.limiters[0].check_rate(visitor, policy) for _ in range(3)]
    assert [decision.allowed for decision in drained] == [True, True, False]
    assert drained[2].retry_after_seconds == 1
    await asyncio.sleep(0.6)
    refilled = [await rate_lab.limiters[1].check_rate(visitor, policy) for _ in range(3)]
    assert [decision.allowed for decision in refilled] == [True, True, False]


def test_policy_refuses_an_expiry_that_would_forgive_a_debt_early() -> None:
    with pytest.raises(ValidationError):
        RatePolicy(policy_id="test-rate-short", window_seconds=60, capacity=10, refill=1, expiry_seconds=599)
    with pytest.raises(ValidationError):
        RatePolicy(policy_id="Bad Policy", window_seconds=60, capacity=1, refill=1, expiry_seconds=60)
    with pytest.raises(ValidationError):
        RatePolicy(policy_id="test-rate-zero", window_seconds=60, capacity=0, refill=1, expiry_seconds=60)
    with pytest.raises(ValidationError):
        RatePolicy.model_validate(
            {"policy_id": "x", "window_seconds": 1, "capacity": 1, "refill": 1, "expiry_seconds": 1, "extra": 1}
        )
    assert RatePolicy(policy_id="test-rate-ok", window_seconds=60, capacity=10, refill=1, expiry_seconds=600)


def test_short_or_missing_scope_secret_is_refused() -> None:
    with pytest.raises(ValueError):
        connect_rate_limiter(VALKEY_URL, scope_key=b"short", timeout_seconds=0.5)


async def test_counter_store_outage_is_reported_promptly() -> None:
    policy = RatePolicy(policy_id="test-rate-outage", window_seconds=60, capacity=1, refill=1, expiry_seconds=60)
    limiter = connect_rate_limiter(UNREACHABLE_VALKEY_URL, scope_key=b"\x05" * 32, timeout_seconds=0.5)
    try:
        started = time.perf_counter()
        with pytest.raises(CounterStoreUnavailable):
            await limiter.check_rate(subject(), policy)
        assert time.perf_counter() - started <= OUTAGE_BUDGET_SECONDS
        assert await limiter.ping() is False
    finally:
        await limiter.aclose()


async def test_reachable_counter_store_answers_ping(rate_lab: RateLab) -> None:
    assert await rate_lab.limiters[0].ping() is True
