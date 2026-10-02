"""OpenAI Responses instructions are the only privileged field for this adapter."""

from __future__ import annotations

from esp_espcon.brain_registry import ResolvedRelease
from esp_inference_gateway.brain_injector import inject_missing_blocks
from esp_inference_gateway.request_adapter import InstructionField, ParsedRequest, VerificationError, load_strict


class OpenAIResponsesAdapter:
    def parse_and_locate(self, raw: bytes) -> ParsedRequest:
        document = load_strict(raw)
        if "messages" in document or not isinstance(document.get("model"), str):
            raise VerificationError("unsupported_shape")
        instructions = document.get("instructions", "")
        if not isinstance(instructions, str):
            raise VerificationError("unsupported_shape")
        if "instructions" not in document:
            document["instructions"] = ""
        return ParsedRequest(document, [InstructionField("instructions", instructions)])

    def inject_absent(self, parsed: ParsedRequest, release: ResolvedRelease) -> ParsedRequest:
        return inject_missing_blocks(parsed, release)
