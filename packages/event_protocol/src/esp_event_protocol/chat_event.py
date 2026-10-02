"""Exact §7.3 event union plus the versioned structured_data extension."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from esp_contracts.api import (
    STRICT,
    AssetRef,
    Citation,
    SessionStatusName,
    StructuredData,
    Usage,
)

PROTOCOL_VERSION = 1


class TextDelta(BaseModel):
    model_config = STRICT
    type: Literal["text_delta"]
    text: str


class CitationEvent(BaseModel):
    model_config = STRICT
    type: Literal["citation"]
    citation: Citation


class ToolStarted(BaseModel):
    model_config = STRICT
    type: Literal["tool_started"]
    tool: str = Field(min_length=1)


class ToolFinished(BaseModel):
    model_config = STRICT
    type: Literal["tool_finished"]
    tool: str = Field(min_length=1)


class AssetEvent(BaseModel):
    model_config = STRICT
    type: Literal["asset"]
    asset: AssetRef


class UsageEvent(BaseModel):
    model_config = STRICT
    type: Literal["usage"]
    usage: Usage


class SessionStatus(BaseModel):
    model_config = STRICT
    type: Literal["session_status"]
    status: SessionStatusName


class OutputReset(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    type: Literal["output_reset"]
    active_agent_run_id: str = Field(alias="activeAgentRunId", min_length=1)


class ErrorEvent(BaseModel):
    model_config = STRICT
    type: Literal["error"]
    code: str = Field(min_length=1)
    message: str
    retryable: bool


class Done(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    type: Literal["done"]
    native_work_ref: str = Field(alias="nativeWorkRef", min_length=1)


class StructuredDataEvent(BaseModel):
    model_config = STRICT
    type: Literal["structured_data"]
    data: StructuredData


ChatEvent = Annotated[
    TextDelta
    | CitationEvent
    | ToolStarted
    | ToolFinished
    | AssetEvent
    | UsageEvent
    | SessionStatus
    | OutputReset
    | ErrorEvent
    | Done
    | StructuredDataEvent,
    Field(discriminator="type"),
]

_ADAPTER: TypeAdapter[ChatEvent] = TypeAdapter(ChatEvent)


def parse_chat_event(value: object) -> ChatEvent:
    return _ADAPTER.validate_python(value)


class EventEnvelope(BaseModel):
    """Connection-local sequence. It is not a durable cursor."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    protocol_version: Literal[1] = PROTOCOL_VERSION
    conversation_id: str = Field(min_length=1)
    provider_session_id: str = Field(min_length=1)
    active_agent_run_id: str = Field(alias="activeAgentRunId", min_length=1)
    native_work_ref: str | None = Field(alias="nativeWorkRef")
    connection_id: str = Field(min_length=1)
    sequence: int = Field(ge=1)
    event: ChatEvent
