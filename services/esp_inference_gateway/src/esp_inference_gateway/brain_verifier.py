"""Serialize once, then re-extract both privileged blocks from that buffer."""

from __future__ import annotations

import hashlib
from typing import Any, Literal

from pydantic import BaseModel

from esp_contracts.api import STRICT
from esp_espcon.brain_registry import ResolvedRelease
from esp_inference_gateway.brain_injector import frame_block
from esp_inference_gateway.request_adapter import (
    ParsedRequest,
    RequestAdapter,
    VerificationError,
    dump_document,
    load_strict,
    read_path,
    write_path,
)

# Deployment cap for the final provider body. It is not the browser's 8192-byte message limit.
DEFAULT_MAX_REQUEST_BYTES = 1_048_576

__all__ = ["BlockProof", "VerificationError", "VerifiedRequest", "verify_and_serialize"]


class BlockProof(BaseModel):
    model_config = STRICT
    content_path: str
    start_offset: int
    end_offset: int
    sha256: str
    length: int
    action: Literal["present", "injected"]


class VerifiedRequest(BaseModel):
    model_config = STRICT
    body: bytes
    body_sha256: str
    body_length: int
    brain: BlockProof
    behavior: BlockProof

    @property
    def brain_action(self) -> str:
        return self.brain.action

    @property
    def behavior_action(self) -> str:
        return self.behavior.action


def verify_and_serialize(
    raw: bytes,
    release: ResolvedRelease,
    adapter: RequestAdapter,
    *,
    max_request_bytes: int = DEFAULT_MAX_REQUEST_BYTES,
) -> VerifiedRequest:
    if len(raw) > max_request_bytes:
        raise VerificationError("context_overflow")
    _require_artifact(release)
    parsed = adapter.parse_and_locate(raw)
    updated = adapter.inject_absent(parsed, release)
    for item in updated.fields:
        write_path(updated.document, item.path, item.text)
    body = dump_document(updated.document)
    if len(body) > max_request_bytes:
        raise VerificationError("context_overflow")
    reparsed = load_strict(body)
    brain = _proof(
        reparsed,
        updated,
        release.brain_bytes,
        release.manifest.brain_version,
        "brain",
        updated.brain_action,
    )
    behavior = _proof(
        reparsed,
        updated,
        release.behavior_bytes,
        release.manifest.behavior_version,
        "behavior",
        updated.behavior_action,
    )
    return VerifiedRequest(
        body=body,
        body_sha256=hashlib.sha256(body).hexdigest(),
        body_length=len(body),
        brain=brain,
        behavior=behavior,
    )


def _require_artifact(release: ResolvedRelease) -> None:
    pairs = (
        (release.brain_bytes, release.manifest.canonical_brain_sha256, release.manifest.canonical_brain_bytes),
        (release.behavior_bytes, release.manifest.behavior_sha256, release.manifest.behavior_bytes),
    )
    for body, digest, size in pairs:
        try:
            body.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise VerificationError("artifact_mismatch") from exc
        if not body or len(body) != size or hashlib.sha256(body).hexdigest() != digest:
            raise VerificationError("artifact_mismatch")


def _proof(
    document: dict[str, Any],
    parsed: ParsedRequest,
    payload: bytes,
    version: str,
    kind: str,
    action: Literal["present", "injected"] | None,
) -> BlockProof:
    if action not in {"present", "injected"}:
        raise VerificationError("verification_failed")
    framed = frame_block(kind, version, payload)
    begin = framed[: framed.find(payload)]
    matches: list[tuple[str, int]] = []
    for item in parsed.fields:
        text = read_path(document, item.path).encode("utf-8")
        start = text.find(framed)
        if start >= 0:
            matches.append((item.path, start + len(begin)))
    if len(matches) != 1:
        raise VerificationError("verification_failed")
    path, start_offset = matches[0]
    return BlockProof(
        content_path=path,
        start_offset=start_offset,
        end_offset=start_offset + len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
        length=len(payload),
        action=action,
    )
