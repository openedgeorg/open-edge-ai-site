"""Public HTTP shapes. Validation maps to the documented status codes."""

from __future__ import annotations

import math
from typing import Annotated, Literal, cast

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, ValidationError, model_validator

from esp_contracts.ids import HarnessName, Provider, UuidStr

STRICT = ConfigDict(extra="forbid")

MESSAGE_MAX_BYTES = 8192
PUBLIC_JSON_MAX_BYTES = 64 * 1024
SSE_SUBSCRIBER_MAX_BYTES = 256 * 1024
STRUCTURED_MAX_COLUMNS = 20
STRUCTURED_MAX_ROWS = 100

RuntimeStateName = Literal[
    "starting",
    "warm_idle",
    "running",
    "cancelling",
    "draining",
    "unloaded",
    "suspect",
    "recovering",
    "unavailable",
]
InstanceStateName = Literal["starting", "ready", "draining", "suspect", "failed", "stopped"]
SessionStatusName = Literal["starting", "restoring", "running", "recovering", "warm_idle"]
VerificationState = Literal["verified", "unverified", "unavailable"]


def _nonblank_message(value: str) -> str:
    if not value.strip():
        raise ValueError("message must be nonblank")
    if len(value.encode("utf-8")) > MESSAGE_MAX_BYTES:
        raise ValueError("message_too_large")
    return value


class SubmitMessage(BaseModel):
    """Exactly the three message-body fields. Provider overrides are rejected."""

    model_config = STRICT
    conversation_id: UuidStr
    client_request_id: Annotated[str, Field(min_length=1, max_length=200)]
    message: Annotated[str, AfterValidator(_nonblank_message)]


def parse_submit(value: object) -> SubmitMessage:
    return SubmitMessage.model_validate(value)


def http_status_for_validation(exc: ValidationError) -> int:
    """Oversized visitor text is 413. Every other validation failure is 400."""
    for error in exc.errors():
        if "message_too_large" in str(error.get("msg", "")):
            return 413
    return 400


class Citation(BaseModel):
    model_config = STRICT
    source_id: str = Field(min_length=1)
    version: str = Field(min_length=1)
    title: str
    locator: str = Field(min_length=1)
    quote: str | None = None
    verification_state: VerificationState


class AssetRef(BaseModel):
    model_config = STRICT
    asset_id: str = Field(min_length=1)
    version: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    alt: str
    source_id: str = Field(min_length=1)


class Usage(BaseModel):
    """Null counts mean the provider did not report that number."""

    model_config = STRICT
    input_tokens: int | None
    output_tokens: int | None
    cached_tokens: int | None

    @model_validator(mode="before")
    @classmethod
    def reject_bool_and_float(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        raw = cast(dict[str, object], value)
        for key in ("input_tokens", "output_tokens", "cached_tokens"):
            item = raw.get(key)
            if item is None:
                continue
            if isinstance(item, bool) or isinstance(item, float) or not isinstance(item, int):
                raise ValueError("token count must be a non-negative integer or null")
            if item < 0:
                raise ValueError("token count must be a non-negative integer or null")
        return cast(object, raw)


class StructuredData(BaseModel):
    model_config = STRICT
    caption: str
    columns: list[str] = Field(max_length=STRUCTURED_MAX_COLUMNS)
    rows: list[list[str | int | float | None]] = Field(max_length=STRUCTURED_MAX_ROWS)
    citation: Citation

    @model_validator(mode="after")
    def enforce_bounds(self) -> StructuredData:
        if len(self.columns) > STRUCTURED_MAX_COLUMNS or len(self.rows) > STRUCTURED_MAX_ROWS:
            raise ValueError("structured table bounds")
        width = len(self.columns)
        for row in self.rows:
            if len(row) != width:
                raise ValueError("structured row width")
            for cell in row:
                if isinstance(cell, bool) or (isinstance(cell, float) and not math.isfinite(cell)):
                    raise ValueError("non-finite structured cell")
        return self


class ErrorBody(BaseModel):
    model_config = STRICT
    code: str
    message: str
    retryable: bool


class ErrorResponse(BaseModel):
    """Clean rejection uses submitted false. Ambiguity uses submitted null."""

    model_config = STRICT
    error: ErrorBody
    submitted: bool | None


class ConversationView(BaseModel):
    model_config = STRICT
    id: UuidStr
    provider: Provider
    harness: HarnessName
    model: str | None
    brain_release_id: str
    behavior_version: str
    corpus_release_id: str
    status: Literal["active", "closed"]
    runtime_state: RuntimeStateName | None
    active_agent_run_id: UuidStr | None
    work_state: str | None = None


class SubmissionView(BaseModel):
    model_config = STRICT
    outcome: Literal[
        "accepted",
        "running",
        "completed",
        "not_started",
        "submission_unconfirmed",
        "cancelled",
        "failed",
    ]
    active_agent_run_id: str | None
    native_work_ref: str | None
    resubmission_allowed: bool
    runtime_state: RuntimeStateName | None


class ProviderOption(BaseModel):
    model_config = STRICT
    provider: Provider
    harness: HarnessName
    display_model: str
    eligible: bool
    available: bool


class Subject(BaseModel):
    model_config = STRICT
    subject_id: str = Field(min_length=1)
