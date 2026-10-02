"""Encrypt and acknowledge the exact request before any provider connection."""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from typing import Protocol, cast

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import BaseModel

from esp_contracts.api import STRICT
from esp_contracts.ids import Sha256
from esp_contracts.release import ReleaseError
from esp_contracts.runtime import RunBinding
from esp_inference_gateway.brain_verifier import VerifiedRequest
from esp_object_store.store import ObjectStore, parse_object_reference

__all__ = [
    "EvidenceError",
    "EvidenceKey",
    "EvidenceReceipt",
    "EvidenceRecorder",
    "MemoryOutcomeStore",
    "OutcomeAckError",
    "persist_verified_request",
    "record_outcome",
]


class EvidenceError(Exception):
    """No receipt means no provider connection."""


class OutcomeAckError(Exception):
    """The outcome store did not acknowledge. Do not replay the provider request."""


class EvidenceReceipt(BaseModel):
    model_config = STRICT
    inference_id: str
    request_ref: str
    proof_ref: str
    request_sha256: Sha256


class EvidenceKey:
    def __init__(self, raw: bytes) -> None:
        if len(raw) != 32:
            raise EvidenceError("evidence_key_invalid")
        self._aes = AESGCM(raw)

    def encrypt(self, body: bytes) -> bytes:
        nonce = os.urandom(12)
        sealed = self._aes.encrypt(nonce, body, b"esp-evidence-v1")
        return b"v1" + nonce + sealed

    def decrypt(self, blob: bytes) -> bytes:
        if len(blob) < 2 + 12 + 16 or not blob.startswith(b"v1"):
            raise EvidenceError("evidence_corrupt")
        nonce = blob[2:14]
        try:
            return self._aes.decrypt(nonce, blob[14:], b"esp-evidence-v1")
        except Exception as exc:
            raise EvidenceError("evidence_corrupt") from exc


class EvidenceRecorder:
    def __init__(self, store: ObjectStore, key: EvidenceKey) -> None:
        self.store = store
        self.key = key
        self.fail = False

    async def persist(self, binding: RunBinding, request: VerifiedRequest) -> EvidenceReceipt:
        if self.fail:
            raise EvidenceError("evidence_unavailable")
        inference_id = "inf_" + uuid.uuid4().hex
        plaintext_sha = hashlib.sha256(request.body).hexdigest()
        blob = self.key.encrypt(request.body)
        proof = {
            "inference_id": inference_id,
            "conversation_id": binding.conversation_id,
            "provider_session_id": binding.provider_session_id,
            "session_generation": binding.session_generation,
            "native_session_id": binding.native_session_id,
            "active_agent_run_id": binding.active_agent_run_id,
            "harness_instance_id": binding.harness_instance_id,
            "runtime_incarnation_id": binding.runtime_incarnation_id,
            "ownership_epoch": str(binding.ownership_epoch),
            "provider": binding.provider,
            "model": binding.model,
            "brain_release_id": binding.brain_release_id,
            "behavior_version": binding.behavior_version,
            "request_sha256": plaintext_sha,
            "request_length": len(request.body),
            "ciphertext_sha256": hashlib.sha256(blob).hexdigest(),
            "brain": request.brain.model_dump(),
            "behavior": request.behavior.model_dump(),
        }
        proof_bytes = json.dumps(proof, sort_keys=True, separators=(",", ":")).encode("utf-8")
        if request.body in proof_bytes:
            raise EvidenceError("proof_leaks_body")
        try:
            request_receipt = await self.store.put_immutable(
                f"evidence/{inference_id}/request",
                blob,
                {"kind": "encrypted-request"},
            )
            proof_receipt = await self.store.put_immutable(
                f"evidence/{inference_id}/proof",
                proof_bytes,
                {"kind": "request-proof"},
            )
        except ReleaseError as exc:
            raise EvidenceError("evidence_unavailable") from exc
        return EvidenceReceipt(
            inference_id=inference_id,
            request_ref=request_receipt.reference,
            proof_ref=proof_receipt.reference,
            request_sha256=plaintext_sha,
        )


async def persist_verified_request(
    binding: RunBinding,
    request: VerifiedRequest,
    *,
    recorder: EvidenceRecorder,
) -> EvidenceReceipt:
    return await recorder.persist(binding, request)


class OutcomeStore(Protocol):
    async def ack(self, inference_id: str, status: str) -> None: ...


class MemoryOutcomeStore:
    def __init__(self) -> None:
        self.records: list[tuple[str, str]] = []
        self.fail = False

    async def ack(self, inference_id: str, status: str) -> None:
        if self.fail:
            raise OutcomeAckError("outcome_unconfirmed")
        self.records.append((inference_id, status))


async def record_outcome(store: OutcomeStore, inference_id: str, status: str) -> str:
    try:
        await store.ack(inference_id, status)
    except OutcomeAckError:
        return "uncertain"
    return "recorded"


def load_proof(store_bytes: bytes) -> dict[str, object]:
    payload = json.loads(store_bytes)
    if not isinstance(payload, dict):
        raise EvidenceError("evidence_corrupt")
    return cast(dict[str, object], payload)


def reference_parts(reference: str) -> tuple[str, str]:
    return parse_object_reference(reference)
