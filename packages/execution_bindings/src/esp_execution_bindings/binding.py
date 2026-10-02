"""Sign operation tokens. Verification uses only the public key."""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from typing import Any, Literal, cast

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from esp_contracts.ids import Audience
from esp_contracts.runtime import AuthorityRecord, OperationAuthority, RunBinding


class AuthorizationError(Exception):
    """Fail closed. The message is a stable machine code."""


class TokenVerifier:
    """Public verification key. This is not a signing secret."""

    def __init__(self, public_key: Ed25519PublicKey) -> None:
        self._public_key = public_key

    def verify(self, payload: bytes, signature: bytes) -> None:
        try:
            self._public_key.verify(signature, payload)
        except InvalidSignature as exc:
            raise AuthorizationError("signature_invalid") from exc


class TokenSigner:
    """Private key used only while minting. Do not place it in a runtime, gateway, or MCP process."""

    def __init__(self, private_key: Ed25519PrivateKey) -> None:
        self._private_key = private_key

    @staticmethod
    def generate() -> tuple[TokenSigner, TokenVerifier]:
        private_key = Ed25519PrivateKey.generate()
        return TokenSigner(private_key), TokenVerifier(private_key.public_key())

    def sign(self, payload: bytes) -> bytes:
        return self._private_key.sign(payload)


def mint_operation_authority(record: AuthorityRecord, *, signer: TokenSigner) -> OperationAuthority:
    _require_operation_record(record)
    return OperationAuthority(
        inference_token=_issue(record, "inference", signer),
        knowledge_token=_issue(record, "knowledge", signer),
    )


def mint_setup_authority(record: AuthorityRecord, *, signer: TokenSigner) -> str:
    payload = {
        "provider_session_id": record.provider_session_id,
        "scope": "setup",
        "token_use": "setup",
    }
    return _token(payload, signer)


def verify_binding(token: str, audience: Audience, *, verifier: TokenVerifier) -> RunBinding:
    payload = _verified_payload(token, verifier)
    if payload.get("token_use") != "operation":
        raise AuthorizationError("setup_scope")
    binding_payload = payload.get("binding")
    if not isinstance(binding_payload, dict):
        raise AuthorizationError("signature_invalid")
    binding = RunBinding.model_validate(binding_payload)
    if binding.audience != audience:
        raise AuthorizationError("audience_mismatch")
    return binding


def _issue(record: AuthorityRecord, audience: Literal["inference", "knowledge"], signer: TokenSigner) -> str:
    if record.native_session_id is None or record.active_agent_run_id is None:
        raise AuthorizationError("native_id_unregistered")
    if record.harness_instance_id is None or record.runtime_incarnation_id is None or record.model is None:
        raise AuthorizationError("authority_unavailable")
    if record.owner_lease_expires_at is None or record.active_agent_run_expires_at is None:
        raise AuthorizationError("lease_expired")
    binding = RunBinding(
        conversation_id=record.conversation_id,
        provider_session_id=record.provider_session_id,
        session_generation=record.session_generation,
        native_session_id=record.native_session_id,
        active_agent_run_id=record.active_agent_run_id,
        harness_instance_id=record.harness_instance_id,
        runtime_incarnation_id=record.runtime_incarnation_id,
        ownership_epoch=record.ownership_epoch,
        provider=record.provider,
        model=record.model,
        brain_release_id=record.brain_release_id,
        brain_hash=record.brain_hash,
        behavior_version=record.behavior_version,
        behavior_hash=record.behavior_hash,
        corpus_release_id=record.corpus_release_id,
        deployment_ref=record.deployment_ref,
        issued_at=record.database_time,
        expires_at=record.owner_lease_expires_at,
        audience=audience,
        native_work_ref=record.current_native_work_ref,
    )
    return _token({"binding": binding.model_dump(mode="json"), "token_use": "operation"}, signer)


def _require_operation_record(record: AuthorityRecord) -> None:
    if record.native_session_id is None:
        raise AuthorizationError("native_id_unregistered")
    if record.runtime_state != "running" or record.cancel_requested or not record.is_current:
        raise AuthorizationError("authority_unavailable")


def _token(payload: Mapping[str, Any], signer: TokenSigner) -> str:
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    signature = signer.sign(body)
    return f"v1.{_encode(body)}.{_encode(signature)}"


def _verified_payload(token: str, verifier: TokenVerifier) -> dict[str, object]:
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "v1":
        raise AuthorizationError("signature_invalid")
    try:
        body = _decode(parts[1])
        signature = _decode(parts[2])
    except ValueError as exc:
        raise AuthorizationError("signature_invalid") from exc
    verifier.verify(body, signature)
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise AuthorizationError("signature_invalid") from exc
    if not isinstance(payload, dict):
        raise AuthorizationError("signature_invalid")
    return cast(dict[str, object], payload)


def _encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)
