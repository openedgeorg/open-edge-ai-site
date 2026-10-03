"""Provider Router: an ESP Conversation (EspCon)'s immutable provider selects its one fixed pool (P §7.2).

```text
conversation.provider = openai -> Codex Harness Instance Pool (HarInsPoo)
conversation.provider = xai    -> Grok Build Harness Instance Pool (HarInsPoo)
```

The mapping is fixed in code. Nothing here reads a model, harness or pool from a request, and an
unavailable pool is never replaced by the other provider's pool: there is no provider fallback.

`NativeRuntimeAdapter` is the routed pool contract the Application Backend holds for each pool. A pool
client addresses the Shared Harness Instance (ShaHarIns) and Process Incarnation (ProInc) that each
reservation or handle names (the supervisor control channel). Every operation carries the explicit
Harness Conversation Session (HarConSes) identity; none relies on a last-used session or a shared
process setting.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Literal, Protocol

from esp_contracts.api import SubmitMessage
from esp_contracts.ids import Provider
from esp_contracts.runtime import (
    NativeHistorySnapshot,
    NativeStatus,
    OperationAuthority,
    SessionHandle,
    SessionReservation,
    SubmissionResult,
)

PoolName = Literal["codex", "grok_build"]

POOL_FOR_PROVIDER: Mapping[Provider, PoolName] = MappingProxyType({"openai": "codex", "xai": "grok_build"})


class NativeRuntimeAdapter(Protocol):
    """One provider pool's native operations, each addressed to an explicit native session.

    `submit` reports `accepted` only on qualified native acceptance; a lost or unproven acknowledgement
    is `unconfirmed`, and `not_submitted` only when the input conclusively never reached the harness.
    Reads (`inspect`, `read_history`) start no native work.
    """

    async def create_session(self, reservation: SessionReservation) -> SessionHandle: ...

    async def resume_session(self, handle: SessionHandle) -> SessionHandle: ...

    async def submit(
        self, handle: SessionHandle, message: SubmitMessage, authority: OperationAuthority
    ) -> SubmissionResult: ...

    async def inspect(self, handle: SessionHandle, request_id: str | None = None) -> NativeStatus: ...

    async def read_history(self, handle: SessionHandle) -> NativeHistorySnapshot: ...


class PoolUnavailable(LookupError):
    """The provider's fixed pool has no configured client. Never answered with another pool."""


def resolve_pool(provider: Provider) -> PoolName:
    """The fixed pool for a provider. Anything other than `openai` or `xai` is refused."""
    pool = POOL_FOR_PROVIDER.get(provider)
    if pool is None:
        raise ValueError("unknown provider")
    return pool


class ProviderRouter:
    """Routes a provider to its own pool client and to nothing else."""

    def __init__(self, pools: Mapping[PoolName, NativeRuntimeAdapter]) -> None:
        self._pools: dict[PoolName, NativeRuntimeAdapter] = dict(pools)

    @classmethod
    def for_providers(cls, adapters: Mapping[Provider, NativeRuntimeAdapter]) -> ProviderRouter:
        """Build from adapters registered per provider, each placed under that provider's fixed pool."""
        return cls({resolve_pool(provider): adapter for provider, adapter in adapters.items()})

    def adapter_for(self, provider: Provider) -> NativeRuntimeAdapter:
        adapter = self._pools.get(resolve_pool(provider))
        if adapter is None:
            raise PoolUnavailable(provider)
        return adapter

    def pools(self) -> frozenset[PoolName]:
        return frozenset(self._pools)


__all__ = [
    "POOL_FOR_PROVIDER",
    "NativeRuntimeAdapter",
    "PoolName",
    "PoolUnavailable",
    "ProviderRouter",
    "resolve_pool",
]
