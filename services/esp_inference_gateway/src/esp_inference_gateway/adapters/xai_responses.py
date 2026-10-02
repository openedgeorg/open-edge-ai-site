"""xAI system messages are the privileged fields. User messages stay ordinary data."""

from __future__ import annotations

from typing import Any, cast

from esp_espcon.brain_registry import ResolvedRelease
from esp_inference_gateway.brain_injector import inject_missing_blocks
from esp_inference_gateway.request_adapter import InstructionField, ParsedRequest, VerificationError, load_strict


class XAIResponsesAdapter:
    def parse_and_locate(self, raw: bytes) -> ParsedRequest:
        document = load_strict(raw)
        if "instructions" in document or "input" in document or not isinstance(document.get("model"), str):
            raise VerificationError("unsupported_shape")
        messages_value = document.get("messages")
        if not isinstance(messages_value, list):
            raise VerificationError("unsupported_shape")
        messages = cast(list[Any], messages_value)
        fields: list[InstructionField] = []
        for index, message_value in enumerate(messages):
            if not isinstance(message_value, dict):
                continue
            message = cast(dict[str, Any], message_value)
            if message.get("role") != "system":
                continue
            content = message.get("content")
            if not isinstance(content, str):
                raise VerificationError("unsupported_shape")
            fields.append(InstructionField(f"messages[{index}].content", content))
        if not fields:
            messages.insert(0, {"role": "system", "content": ""})
            fields.append(InstructionField("messages[0].content", ""))
        return ParsedRequest(document, fields)

    def inject_absent(self, parsed: ParsedRequest, release: ResolvedRelease) -> ParsedRequest:
        return inject_missing_blocks(parsed, release)
