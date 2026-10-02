"""Identity primitives shared by every ESP service. No I/O."""

from __future__ import annotations

import re
import uuid
from typing import Annotated, Literal

from pydantic import BeforeValidator, PlainSerializer

Provider = Literal["openai", "xai"]
Audience = Literal["inference", "knowledge"]
HarnessName = Literal["codex", "grok-build"]

_INT64_TEXT = re.compile(r"-?(0|[1-9][0-9]*)")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_INT64_MIN = -9223372036854775808
_INT64_MAX = 9223372036854775807


def parse_int64(value: object) -> int:
    """Accept a Python int or a canonical decimal string. Reject lossy forms."""
    if isinstance(value, bool) or isinstance(value, float) or not isinstance(value, (int, str)):
        raise ValueError("int64 must be an integer or canonical decimal string")
    if isinstance(value, str):
        if _INT64_TEXT.fullmatch(value) is None:
            raise ValueError("int64 must be an integer or canonical decimal string")
        parsed = int(value)
    else:
        parsed = value
    if parsed < _INT64_MIN or parsed > _INT64_MAX:
        raise ValueError("int64 out of range")
    return parsed


Int64 = Annotated[
    int,
    BeforeValidator(parse_int64),
    PlainSerializer(lambda value: str(value), return_type=str, when_used="json"),
]


def parse_sha256(value: object) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise ValueError("sha256 must be 64 lowercase hex characters")
    return value


Sha256 = Annotated[str, BeforeValidator(parse_sha256)]


def parse_uuid_str(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("uuid string required")
    try:
        parsed = uuid.UUID(value)
    except ValueError as exc:
        raise ValueError("uuid string required") from exc
    return str(parsed)


UuidStr = Annotated[str, BeforeValidator(parse_uuid_str)]


def new_id() -> str:
    return str(uuid.uuid4())
