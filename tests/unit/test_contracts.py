"""Task 1: wire aliases, epochs, strict input, and the eleven event variants."""

import math

import pytest
from pydantic import ValidationError

from esp_contracts.api import http_status_for_validation, parse_submit
from esp_contracts.release import ReleaseManifest
from esp_contracts.runtime import (
    HARNESS_INSTANCE_STATES,
    HARNESS_SESSION_STATES,
    DispatchTicket,
    ProviderResponse,
    RunBinding,
    SessionStateInput,
)
from esp_event_protocol.chat_event import parse_chat_event
from tests.support.contracts import EPOCH, binding_kwargs


def test_wire_aliases_epochs_and_strict_input(valid_binding: RunBinding, valid_message: dict[str, str]) -> None:
    assert valid_binding.model_dump(mode="json")["ownership_epoch"] == "9007199254740993"
    assert (
        parse_chat_event({"type": "output_reset", "activeAgentRunId": "run"}).model_dump(by_alias=True)[
            "activeAgentRunId"
        ]
        == "run"
    )
    with pytest.raises(ValidationError):
        parse_submit({**valid_message, "provider": "xai"})
    with pytest.raises(ValidationError):
        parse_submit({**valid_message, "message": "😀" * 2049})


def test_epoch_roundtrip_preserves_integers_above_js_safe_range(valid_binding: RunBinding) -> None:
    payload = valid_binding.model_dump(mode="json")
    assert isinstance(payload["ownership_epoch"], str)
    restored = RunBinding.model_validate(payload)
    assert restored.ownership_epoch == EPOCH
    assert restored.ownership_epoch == 9007199254740993


def test_epoch_rejects_lossy_forms() -> None:
    base = binding_kwargs()
    for bad in (1.5, True, "9e15", "0900", "9007199254740993.0"):
        with pytest.raises(ValidationError):
            RunBinding.model_validate({**base, "ownership_epoch": bad})


def test_unknown_event_and_state_rejected() -> None:
    with pytest.raises(ValidationError):
        parse_chat_event({"type": "reasoning", "text": "hidden"})
    with pytest.raises(ValidationError):
        SessionStateInput.model_validate({"runtime_state": "queued", "lifecycle_status": "ready"})
    with pytest.raises(ValidationError):
        SessionStateInput.model_validate({"runtime_state": "warm_idle", "lifecycle_status": "booting"})
    assert set(HARNESS_SESSION_STATES) == {
        "starting",
        "warm_idle",
        "running",
        "cancelling",
        "draining",
        "unloaded",
        "suspect",
        "recovering",
        "unavailable",
    }
    assert set(HARNESS_INSTANCE_STATES) == {"starting", "ready", "draining", "suspect", "failed", "stopped"}


def test_usage_nulls_mean_unknown() -> None:
    event = parse_chat_event(
        {"type": "usage", "usage": {"input_tokens": None, "output_tokens": None, "cached_tokens": None}}
    )
    dumped = event.model_dump()
    assert dumped["usage"]["input_tokens"] is None
    assert dumped["usage"]["output_tokens"] is None
    assert dumped["usage"]["cached_tokens"] is None


def test_structured_data_column_and_row_bounds() -> None:
    citation = {
        "source_id": "src",
        "version": "1",
        "title": "Fixture",
        "locator": "p1",
        "quote": None,
        "verification_state": "unverified",
    }
    columns = [f"c{i}" for i in range(20)]
    row = ["cell"] * 20
    ok = {
        "type": "structured_data",
        "data": {"caption": "bounds", "columns": columns, "rows": [row for _ in range(100)], "citation": citation},
    }
    parse_chat_event(ok)
    with pytest.raises(ValidationError):
        parse_chat_event(
            {
                "type": "structured_data",
                "data": {
                    "caption": "wide",
                    "columns": columns + ["extra"],
                    "rows": [["cell"] * 21],
                    "citation": citation,
                },
            }
        )
    with pytest.raises(ValidationError):
        parse_chat_event(
            {
                "type": "structured_data",
                "data": {
                    "caption": "tall",
                    "columns": ["only"],
                    "rows": [["x"] for _ in range(101)],
                    "citation": citation,
                },
            }
        )
    with pytest.raises(ValidationError):
        parse_chat_event(
            {
                "type": "structured_data",
                "data": {
                    "caption": "nan",
                    "columns": ["n"],
                    "rows": [[math.nan]],
                    "citation": citation,
                },
            }
        )


@pytest.mark.parametrize(
    "payload",
    [
        {"type": "text_delta", "text": "hello"},
        {
            "type": "citation",
            "citation": {
                "source_id": "src",
                "version": "1",
                "title": "T",
                "locator": "L",
                "quote": "q",
                "verification_state": "unverified",
            },
        },
        {"type": "tool_started", "tool": "esp.search"},
        {"type": "tool_finished", "tool": "esp.search"},
        {
            "type": "asset",
            "asset": {"asset_id": "a", "version": "1", "kind": "image", "alt": "alt", "source_id": "src"},
        },
        {"type": "usage", "usage": {"input_tokens": 1, "output_tokens": None, "cached_tokens": 0}},
        {"type": "session_status", "status": "warm_idle"},
        {"type": "output_reset", "activeAgentRunId": "run-1"},
        {"type": "error", "code": "capacity_unavailable", "message": "full", "retryable": True},
        {"type": "done", "nativeWorkRef": "work-1"},
        {
            "type": "structured_data",
            "data": {
                "caption": "one",
                "columns": ["k"],
                "rows": [["v"]],
                "citation": {
                    "source_id": "src",
                    "version": "1",
                    "title": "T",
                    "locator": "L",
                    "quote": None,
                    "verification_state": "unverified",
                },
            },
        },
    ],
)
def test_eleven_event_variants_roundtrip(payload: dict[str, object]) -> None:
    event = parse_chat_event(payload)
    dumped = event.model_dump(by_alias=True, mode="json")
    again = parse_chat_event(dumped)
    assert again == event
    assert dumped["type"] == payload["type"]
    for key, value in payload.items():
        assert dumped[key] == value


def test_submit_message_byte_limit_and_http_mapping(valid_message: dict[str, str]) -> None:
    parse_submit({**valid_message, "message": "😀" * 2048})
    with pytest.raises(ValidationError):
        parse_submit({**valid_message, "message": "   "})
    with pytest.raises(ValidationError) as oversized:
        parse_submit({**valid_message, "message": "😀" * 2049})
    assert http_status_for_validation(oversized.value) == 413
    with pytest.raises(ValidationError) as extra:
        parse_submit({**valid_message, "provider": "xai"})
    assert http_status_for_validation(extra.value) == 400


def test_release_status_and_protocols_exist() -> None:
    with pytest.raises(ValidationError):
        ReleaseManifest.model_validate({"status": "stub"})
    assert "body" in ProviderResponse.__annotations__
    assert "status" in ProviderResponse.__annotations__
    assert "inference_id" in DispatchTicket.__annotations__
    assert "response" in DispatchTicket.__annotations__


def test_unknown_binding_field_rejected() -> None:
    with pytest.raises(ValidationError):
        RunBinding.model_validate({**binding_kwargs(), "transcript": "no"})
