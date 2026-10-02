"""Inject a missing privileged block. Never repair a block that is already present."""

from __future__ import annotations

from typing import Literal

from esp_espcon.brain_registry import ResolvedRelease
from esp_inference_gateway.request_adapter import InstructionField, ParsedRequest, VerificationError


def frame_block(kind: str, version: str, body: bytes) -> bytes:
    if kind == "brain":
        begin = f"----- BEGIN ESP CORE BRAIN v{version} -----\n".encode()
        end = f"\n----- END ESP CORE BRAIN v{version} -----".encode()
    else:
        begin = f"----- BEGIN ESP BEHAVIOR v{version} -----\n".encode()
        end = f"\n----- END ESP BEHAVIOR v{version} -----".encode()
    return begin + body + end


def _span_count(raw: bytes, needle: bytes) -> int:
    count = 0
    start = 0
    while True:
        found = raw.find(needle, start)
        if found < 0:
            return count
        count += 1
        start = found + 1


def inject_missing_blocks(parsed: ParsedRequest, release: ResolvedRelease) -> ParsedRequest:
    if not parsed.fields:
        raise VerificationError("unsupported_shape")
    parsed.brain_action = _place(
        parsed.fields,
        frame_block("brain", release.manifest.brain_version, release.brain_bytes),
        release.brain_bytes,
        b"----- BEGIN ESP CORE BRAIN",
        "brain_mismatch",
        "brain_version_mismatch",
    )
    parsed.behavior_action = _place(
        parsed.fields,
        frame_block("behavior", release.manifest.behavior_version, release.behavior_bytes),
        release.behavior_bytes,
        b"----- BEGIN ESP BEHAVIOR",
        "behavior_mismatch",
        "behavior_version_mismatch",
    )
    return parsed


def _place(
    fields: list[InstructionField],
    framed: bytes,
    payload: bytes,
    generic_prefix: bytes,
    mismatch_code: str,
    version_code: str,
) -> Literal["present", "injected"]:
    found = 0
    for item in fields:
        raw = item.text.encode("utf-8")
        if generic_prefix in raw:
            _require_exact(raw, framed, payload, generic_prefix, mismatch_code, version_code)
            found += 1
    if found > 1:
        raise VerificationError("duplicate_block")
    if found == 1:
        return "present"
    target = fields[0]
    existing = target.text.encode("utf-8")
    if existing and not existing.endswith(b"\n"):
        existing += b"\n"
    target.text = (existing + framed).decode("utf-8")
    return "injected"


def _require_exact(
    raw: bytes,
    framed: bytes,
    payload: bytes,
    generic_prefix: bytes,
    mismatch_code: str,
    version_code: str,
) -> None:
    begin = framed[: framed.find(payload)]
    end = framed[framed.find(payload) + len(payload) :]
    exact_hits = _span_count(raw, framed)
    if exact_hits > 1:
        raise VerificationError("duplicate_block")
    if exact_hits == 1:
        start = raw.find(framed)
        outside = raw[:start] + raw[start + len(framed) :]
        if generic_prefix in outside:
            raise VerificationError("duplicate_block")
        return
    if begin not in raw:
        raise VerificationError(version_code)
    if raw.count(begin) > 1:
        raise VerificationError("duplicate_block")
    content_at = raw.find(begin) + len(begin)
    end_at = raw.find(end, content_at)
    if end_at < 0:
        raise VerificationError("malformed_block")
    if raw[content_at:end_at] != payload:
        raise VerificationError(mismatch_code)
    outside = raw[: content_at - len(begin)] + raw[end_at + len(end) :]
    if generic_prefix in outside:
        raise VerificationError("duplicate_block")
