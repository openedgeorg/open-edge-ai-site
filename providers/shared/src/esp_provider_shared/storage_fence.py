"""Positive revocation evidence before a storage writer may be replaced."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field, field_validator


class FenceEvidenceMissing(Exception):
    """No positive revocation evidence exists for this storage writer."""


class FenceReceipt(BaseModel):
    """Proof that the obsolete incarnation was fenced. Every field is required."""

    model_config = ConfigDict(extra="forbid")

    storage_unit_id: str
    obsolete_incarnation_id: str
    infrastructure_mechanism: str
    verified_at: datetime
    fence_evidence_ref: str = Field(min_length=1)

    @field_validator("verified_at")
    @classmethod
    def _aware_utc(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("verified_at must be timezone-aware UTC")
        return value.astimezone(UTC)


class StorageFence(Protocol):
    async def fence_previous_writer(self, unit_id: str, incarnation_id: str) -> FenceReceipt: ...


class ContractStorageFence:
    """Receipts are returned only for a pair previously recorded with a non-empty evidence ref."""

    def __init__(self) -> None:
        self._observed: dict[tuple[str, str], str] = {}

    def observe_revocation(self, unit_id: str, incarnation_id: str, evidence_ref: str) -> None:
        if evidence_ref == "":
            raise FenceEvidenceMissing("empty fence evidence")
        self._observed[(unit_id, incarnation_id)] = evidence_ref

    async def fence_previous_writer(self, unit_id: str, incarnation_id: str) -> FenceReceipt:
        # No stored observation means the writer is not fenced. Do not invent a receipt.
        evidence_ref = self._observed.get((unit_id, incarnation_id))
        if evidence_ref is None:
            raise FenceEvidenceMissing("no revocation evidence")
        return FenceReceipt(
            storage_unit_id=unit_id,
            obsolete_incarnation_id=incarnation_id,
            infrastructure_mechanism="contract-test-observation",
            verified_at=datetime.now(UTC),
            fence_evidence_ref=evidence_ref,
        )
