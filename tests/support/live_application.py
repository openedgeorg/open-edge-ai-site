"""Real-application gate fixture. Without a recorded evidence bundle every gate stays pending."""

from __future__ import annotations

from dataclasses import dataclass

from esp_contracts.ids import Provider
from esp_contracts.qualification import QualificationResult
from scripts.gate_coverage import run_gate1


@dataclass
class LiveApplication:
    provider: Provider = "openai"

    async def gate1(self) -> QualificationResult:
        return run_gate1(self.provider, None)
