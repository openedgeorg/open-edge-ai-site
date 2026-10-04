"""Strip visitor text, cookies and tokens before anything is logged."""

from __future__ import annotations

from collections.abc import Mapping
from typing import cast

_SECRET_KEY = (
    "message",
    "cookie",
    "csrf",
    "authorization",
    "token",
    "password",
    "secret",
    "query",
    "input",
    "ctx",
)


def redact_log(value: object) -> object:
    """Return a loggable copy. Exceptions keep their type and lose their arguments."""
    if isinstance(value, BaseException):
        return {"error_type": type(value).__name__}
    if isinstance(value, Mapping):
        redacted: dict[str, object] = {}
        items = cast(Mapping[object, object], value)
        for key, item in items.items():
            name = str(key).lower()
            if any(secret in name for secret in _SECRET_KEY):
                redacted[str(key)] = "[redacted]"
            else:
                redacted[str(key)] = redact_log(item)
        return redacted
    if isinstance(value, list | tuple):
        sequence = cast(list[object] | tuple[object, ...], value)
        return [redact_log(item) for item in sequence]
    return value
