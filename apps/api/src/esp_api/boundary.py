"""HTTP boundary helpers: the clean rejection shape and bounded strict JSON bodies.

Rejected bodies are never echoed: messages are fixed text chosen here, not request content.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

from esp_contracts.api import PUBLIC_JSON_MAX_BYTES, ErrorBody, ErrorResponse

NO_STORE = {"cache-control": "no-store"}


class ApiError(Exception):
    """A clean rejection: `{error:{code,message,retryable},submitted:false}` with a fixed message.

    `submitted` is `None` where the answer says nothing about whether input was submitted: status and
    history reads, whose failure must never read as "not submitted".
    """

    def __init__(
        self, status_code: int, code: str, message: str, *, retryable: bool = False, submitted: bool | None = False
    ) -> None:
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.retryable = retryable
        self.submitted = submitted


def error_response(error: ApiError) -> JSONResponse:
    body = ErrorResponse(
        error=ErrorBody(code=error.code, message=error.message, retryable=error.retryable),
        submitted=error.submitted,
    )
    return JSONResponse(body.model_dump(mode="json"), status_code=error.status_code, headers=NO_STORE)


def strict_json(raw: bytes) -> object:
    """Parse UTF-8 JSON without a byte-order mark, duplicate keys or non-finite numbers."""
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ValueError("byte-order mark")
    text = raw.decode("utf-8")

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def constant(name: str) -> object:
        raise ValueError(f"non-finite number {name}")

    return json.loads(text, object_pairs_hook=pairs, parse_constant=constant)


async def read_json_body(
    request: Request, *, limit: int = PUBLIC_JSON_MAX_BYTES, allow_empty: bool = False
) -> object | None:
    """Read at most `limit` bytes and parse them strictly. Oversized is 413, anything malformed 400."""
    declared = request.headers.get("content-length")
    if declared is not None:
        if not declared.isdigit():
            raise ApiError(400, "invalid_request", "The request body length is invalid.")
        if int(declared) > limit:
            raise _too_large()
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise _too_large()
        chunks.append(chunk)
    raw = b"".join(chunks)
    if not raw:
        if allow_empty:
            return None
        raise ApiError(400, "invalid_request", "A JSON request body is required.")
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type != "application/json":
        raise ApiError(400, "invalid_request", "The request body must be application/json.")
    try:
        return strict_json(raw)
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise ApiError(400, "invalid_request", "The request body is not valid JSON.") from exc


def _too_large() -> ApiError:
    return ApiError(413, "payload_too_large", "The request body is larger than the public JSON limit.")
