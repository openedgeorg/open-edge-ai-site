"""Compare stored evidence with observed egress and provider usage.

Missing provider usage leaves coverage pending. It does not report a complete zero.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from esp_contracts.api import STRICT


class EvidenceInventory(BaseModel):
    model_config = STRICT
    inference_ids: list[str] = Field(default_factory=list)


class FlowInventory(BaseModel):
    model_config = STRICT
    dispatched_inference_ids: list[str] = Field(default_factory=list)


class ProviderUsage(BaseModel):
    """`available` is false when the read-only usage credential did not answer."""

    model_config = STRICT
    available: bool
    request_ids: list[str] = Field(default_factory=list)


class AuditResult(BaseModel):
    model_config = STRICT
    unobservable_count: int
    verified_forwarded_count: int
    coverage: Literal["complete", "pending"]
    unmatched_ids: list[str] = Field(default_factory=list)


def reconcile_egress(evidence: EvidenceInventory, flows: FlowInventory, usage: ProviderUsage) -> AuditResult:
    known = set(evidence.inference_ids)
    unmatched = [item for item in flows.dispatched_inference_ids if item not in known]
    if not usage.available:
        # A silent zero would hide dispatches the usage API never confirmed.
        return AuditResult(
            unobservable_count=len(flows.dispatched_inference_ids),
            verified_forwarded_count=0,
            coverage="pending",
            unmatched_ids=unmatched,
        )
    for item in usage.request_ids:
        if item not in known and item not in unmatched:
            unmatched.append(item)
    verified = [item for item in flows.dispatched_inference_ids if item in known]
    return AuditResult(
        unobservable_count=len(unmatched),
        verified_forwarded_count=len(verified),
        coverage="complete",
        unmatched_ids=unmatched,
    )
