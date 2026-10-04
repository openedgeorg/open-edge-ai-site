"""Control consumer registered apart from request and stream handlers.

Correctness does not depend on a background loop: callers invoke `consume_control_events` directly.
A lifespan task would race lease renewal, which counts token refreshes exactly.
"""

from __future__ import annotations

from esp_runtime_harconses.lifecycle import SessionLifecycle


class RunSupervision:
    """HTTP-independent reconciliation of native control events and unresolved runs."""

    def __init__(self, lifecycle: SessionLifecycle) -> None:
        self._lifecycle = lifecycle

    async def consume_control_events(self) -> None:
        await self._lifecycle.consume_control_events()
