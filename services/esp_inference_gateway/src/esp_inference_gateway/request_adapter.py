"""Strict JSON request parsing. Ordinary message text is not a privileged field."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, cast

from esp_espcon.brain_registry import ResolvedRelease


class VerificationError(Exception):
    """Fail closed. The message is a stable machine code."""


@dataclass
class InstructionField:
    path: str
    text: str


@dataclass
class ParsedRequest:
    document: dict[str, Any]
    fields: list[InstructionField] = field(default_factory=lambda: [])
    brain_action: Literal["present", "injected"] | None = None
    behavior_action: Literal["present", "injected"] | None = None


class RequestAdapter(Protocol):
    def parse_and_locate(self, raw: bytes) -> ParsedRequest: ...

    def inject_absent(self, parsed: ParsedRequest, release: ResolvedRelease) -> ParsedRequest: ...


_FORBIDDEN = {"previous_response_id", "store", "background", "truncation", "url", "image_url", "file_url"}


def load_strict(raw: bytes) -> dict[str, Any]:
    if raw.startswith((b"\xef\xbb\xbf", b"\xff\xfe", b"\xfe\xff")):
        raise VerificationError("invalid_utf8")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise VerificationError("invalid_utf8") from exc

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        document: dict[str, Any] = {}
        for key, value in items:
            if key in document:
                raise VerificationError("duplicate_key")
            document[key] = value
        return document

    def reject_constant(_name: str) -> None:
        raise VerificationError("non_finite_number")

    try:
        value = json.loads(text, object_pairs_hook=pairs, parse_constant=reject_constant)
    except VerificationError:
        raise
    except json.JSONDecodeError as exc:
        raise VerificationError("invalid_json") from exc
    if not isinstance(value, dict):
        raise VerificationError("unsupported_shape")
    document = cast(dict[str, Any], value)
    _reject_unsupported(document)
    return document


def read_path(document: dict[str, Any], path: str) -> str:
    current: Any = document
    for part in path.split("."):
        current = _step(current, part)
    if not isinstance(current, str):
        raise VerificationError("unsupported_shape")
    return current


def write_path(document: dict[str, Any], path: str, text: str) -> None:
    parts = path.split(".")
    current: Any = document
    for part in parts[:-1]:
        current = _step(current, part)
    last = parts[-1]
    if last.endswith("]") and "[" in last:
        name, index_text = last[:-1].split("[", 1)
        target = current[name] if name else current
        if not isinstance(target, list):
            raise VerificationError("unsupported_shape")
        items = cast(list[Any], target)
        items[int(index_text)] = text
        return
    if not isinstance(current, dict):
        raise VerificationError("unsupported_shape")
    current[last] = text


def dump_document(document: dict[str, Any]) -> bytes:
    return json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _step(current: Any, part: str) -> Any:
    if part.endswith("]") and "[" in part:
        name, index_text = part[:-1].split("[", 1)
        target = current[name] if name else current
        if not isinstance(target, list):
            raise VerificationError("unsupported_shape")
        items = cast(list[Any], target)
        return items[int(index_text)]
    if not isinstance(current, dict):
        raise VerificationError("unsupported_shape")
    mapping = cast(dict[str, Any], current)
    if part not in mapping:
        raise VerificationError("unsupported_shape")
    return mapping[part]


def _reject_unsupported(value: Any) -> None:
    if isinstance(value, dict):
        mapping = cast(dict[str, Any], value)
        for key, child in mapping.items():
            if key in _FORBIDDEN:
                raise VerificationError("unsupported_field")
            _reject_unsupported(child)
    elif isinstance(value, list):
        items = cast(list[Any], value)
        for child in items:
            _reject_unsupported(child)
