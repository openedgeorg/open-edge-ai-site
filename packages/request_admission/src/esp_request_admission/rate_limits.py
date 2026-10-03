"""Visitor request-rate counters in Valkey (P §7.5). Independent of execution capacity and authority.

Each check is one atomic Lua call (`lua/token_bucket.lua`) that updates the allowance and its expiry
together. Entries contain an opaque HMAC scope key and two integers; never a visitor identifier, message,
pending request, transcript or execution ownership. Passing a check reserves nothing.

Engineering choices: Valkey 8 through the `redis` Python client (RESP-compatible), HMAC-SHA-256 scope
keys, integer token-bucket units and bounded socket timeouts with client retries disabled. A counter
store that cannot answer within the bound raises `CounterStoreUnavailable`; admission then rejects new
input (`503 service_unavailable`) and keeps nothing for later.

There is no production rate policy here. Production numbers are a reviewed release input.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import math
from importlib import resources
from pathlib import Path
from typing import Protocol, cast
from urllib.parse import unquote, urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator
from redis.asyncio import Redis
from redis.asyncio.retry import Retry
from redis.backoff import NoBackoff
from redis.exceptions import NoScriptError, RedisError

MIN_SCOPE_KEY_BYTES = 32
KEY_PREFIX = "esp:rl:"
_POLICY_ID = r"^[a-z0-9][a-z0-9._-]{0,63}$"
_SCRIPT_PATH = "lua/token_bucket.lua"


class RatePolicy(BaseModel):
    """A token bucket: `capacity` burst, `refill` requests per `window_seconds`, entry `expiry_seconds`.

    Expiry must cover a full refill from empty, so an expired entry is exactly a full bucket and expiry
    never forgives an outstanding debt early.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    policy_id: str = Field(pattern=_POLICY_ID)
    window_seconds: int = Field(ge=1, le=86_400)
    capacity: int = Field(ge=1, le=1_000_000)
    refill: int = Field(ge=1, le=1_000_000)
    expiry_seconds: int = Field(ge=1, le=7 * 86_400)

    @model_validator(mode="after")
    def _expiry_covers_a_full_refill(self) -> RatePolicy:
        if self.expiry_seconds < math.ceil(self.capacity * self.window_seconds / self.refill):
            raise ValueError("expiry must cover a full refill from empty")
        return self


class RateDecision(BaseModel):
    """`retry_after_seconds` is manual-retry guidance only; nothing is retried automatically."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    allowed: bool
    retry_after_seconds: int | None = Field(default=None, ge=1)
    remaining: int = Field(ge=0)

    @model_validator(mode="after")
    def _retry_only_when_denied(self) -> RateDecision:
        if self.allowed == (self.retry_after_seconds is not None):
            raise ValueError("a denied decision carries retry guidance and an allowed one does not")
        return self


class CounterStoreUnavailable(Exception):
    """The counter store did not answer within its bound. The message is a stable machine code."""


class RateLimiter(Protocol):
    async def check_rate(self, subject_id: str, policy: RatePolicy) -> RateDecision: ...

    async def ping(self) -> bool: ...


def token_bucket_script() -> str:
    """The Lua source, from the installed package or, in a workspace checkout, the package's `lua/`."""
    packaged = resources.files("esp_request_admission").joinpath(_SCRIPT_PATH)
    if packaged.is_file():
        return packaged.read_text(encoding="utf-8")
    return (Path(__file__).resolve().parents[2] / _SCRIPT_PATH).read_text(encoding="utf-8")


class ValkeyRateLimiter:
    """Atomic token buckets in Valkey under opaque HMAC scope keys. Holds no visitor data."""

    def __init__(self, client: Redis, *, scope_key: bytes, timeout_seconds: float) -> None:
        if len(scope_key) < MIN_SCOPE_KEY_BYTES:
            raise ValueError(f"the counter scope key needs at least {MIN_SCOPE_KEY_BYTES} bytes")
        if timeout_seconds <= 0:
            raise ValueError("the counter store timeout must be positive")
        self._client = client
        self._scope_key = scope_key
        self._timeout = timeout_seconds
        self._script = token_bucket_script()
        self._sha = hashlib.sha1(self._script.encode("utf-8"), usedforsecurity=False).hexdigest()

    def __repr__(self) -> str:
        return "ValkeyRateLimiter(scope_key=<redacted>)"

    def key_for(self, subject_id: str, policy: RatePolicy) -> str:
        """The opaque entry key. A changed policy, subject or scope secret is a different key."""
        if not subject_id:
            raise ValueError("subject identifier required")
        material = "\x00".join(
            (
                "esp-rate/v1",
                policy.policy_id,
                str(policy.window_seconds),
                str(policy.capacity),
                str(policy.refill),
                subject_id,
            )
        )
        digest = hmac.new(self._scope_key, material.encode("utf-8"), hashlib.sha256).hexdigest()
        return KEY_PREFIX + digest

    async def check_rate(self, subject_id: str, policy: RatePolicy) -> RateDecision:
        """Spend one request from the subject's bucket, updating count and expiry atomically."""
        key = self.key_for(subject_id, policy)
        args = (
            str(policy.capacity),
            str(policy.refill),
            str(policy.window_seconds * 1000),
            str(policy.expiry_seconds * 1000),
        )
        try:
            async with asyncio.timeout(self._timeout * 2):
                try:
                    reply = await self._client.evalsha(self._sha, 1, key, *args)
                except NoScriptError:
                    # NOSCRIPT means the script did not run; EVAL is the same single atomic call.
                    reply = await self._client.eval(self._script, 1, key, *args)
        except (RedisError, OSError, TimeoutError) as exc:
            raise CounterStoreUnavailable("counter_store_unavailable") from exc
        return _decision(reply)

    async def ping(self) -> bool:
        try:
            async with asyncio.timeout(self._timeout * 2):
                await self._client.script_exists(self._sha)
        except (RedisError, OSError, TimeoutError):
            return False
        return True

    async def aclose(self) -> None:
        await self._client.aclose()


def open_counter_client(url: str, *, timeout_seconds: float) -> Redis:
    """A Valkey client with bounded connect/read time and no client-side retries.

    `url` is `redis://` or `rediss://` (TLS) `[user:password@]host:port[/db]`.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("redis", "rediss") or not parts.hostname:
        raise ValueError("the counter store URL must be redis:// or rediss://host:port[/db]")
    path = parts.path.strip("/")
    if path and not path.isdigit():
        raise ValueError("the counter store database must be a number")
    return Redis(
        host=parts.hostname,
        port=parts.port or 6379,
        db=int(path) if path else 0,
        username=unquote(parts.username) if parts.username else None,
        password=unquote(parts.password) if parts.password else None,
        ssl=parts.scheme == "rediss",
        socket_timeout=timeout_seconds,
        socket_connect_timeout=timeout_seconds,
        retry=Retry(NoBackoff(), 0),
        health_check_interval=0,
    )


def connect_rate_limiter(url: str, *, scope_key: bytes, timeout_seconds: float) -> ValkeyRateLimiter:
    """A rate limiter for one backend instance. Every instance shares the same `scope_key` secret."""
    if len(scope_key) < MIN_SCOPE_KEY_BYTES:
        raise ValueError(f"the counter scope key needs at least {MIN_SCOPE_KEY_BYTES} bytes")
    return ValkeyRateLimiter(
        open_counter_client(url, timeout_seconds=timeout_seconds),
        scope_key=scope_key,
        timeout_seconds=timeout_seconds,
    )


def _decision(reply: object) -> RateDecision:
    if not isinstance(reply, list):
        raise CounterStoreUnavailable("counter_store_reply_invalid")
    items = cast(list[object], reply)
    if len(items) != 3:
        raise CounterStoreUnavailable("counter_store_reply_invalid")
    values: list[int] = []
    for item in items:
        if isinstance(item, bool) or not isinstance(item, int):
            raise CounterStoreUnavailable("counter_store_reply_invalid")
        values.append(item)
    allowed, retry_after_ms, remaining = values
    if allowed == 1:
        return RateDecision(allowed=True, retry_after_seconds=None, remaining=max(0, remaining))
    return RateDecision(
        allowed=False,
        retry_after_seconds=max(1, math.ceil(retry_after_ms / 1000)),
        remaining=max(0, remaining),
    )


__all__ = [
    "KEY_PREFIX",
    "CounterStoreUnavailable",
    "RateDecision",
    "RateLimiter",
    "RatePolicy",
    "ValkeyRateLimiter",
    "connect_rate_limiter",
    "open_counter_client",
    "token_bucket_script",
]
