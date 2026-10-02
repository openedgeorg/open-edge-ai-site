"""Runtime identity, authority and native observation models. No I/O."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Mapping
from datetime import datetime
from typing import Annotated, Literal, Protocol

from pydantic import BaseModel, Field

from esp_contracts.api import STRICT, AssetRef, Citation, RuntimeStateName, StructuredData
from esp_contracts.ids import Audience, Int64, Provider, Sha256, UuidStr

InstanceStateName = Literal["starting", "ready", "draining", "suspect", "failed", "stopped"]
NativeWorkStatus = Literal["idle", "running", "completed", "interrupted", "failed", "unknown"]
QualificationStatus = Literal["pending", "validated", "invalidated"]

HARNESS_SESSION_STATES: tuple[RuntimeStateName, ...] = (
    "starting",
    "warm_idle",
    "running",
    "cancelling",
    "draining",
    "unloaded",
    "suspect",
    "recovering",
    "unavailable",
)
HARNESS_INSTANCE_STATES: tuple[InstanceStateName, ...] = (
    "starting",
    "ready",
    "draining",
    "suspect",
    "failed",
    "stopped",
)


class SessionStateInput(BaseModel):
    """Exact §12.11 runtime and instance states. Capacity rejection is not a saved state."""

    model_config = STRICT
    runtime_state: RuntimeStateName
    lifecycle_status: InstanceStateName


class RunBinding(BaseModel):
    model_config = STRICT
    conversation_id: UuidStr
    provider_session_id: UuidStr
    session_generation: int = Field(ge=1)
    native_session_id: str = Field(min_length=1)
    active_agent_run_id: UuidStr
    harness_instance_id: UuidStr
    runtime_incarnation_id: UuidStr
    ownership_epoch: Int64
    provider: Provider
    model: str = Field(min_length=1)
    brain_release_id: str = Field(min_length=1)
    brain_hash: Sha256
    behavior_version: str = Field(min_length=1)
    behavior_hash: Sha256
    corpus_release_id: str = Field(min_length=1)
    deployment_ref: str = Field(min_length=1)
    issued_at: datetime
    expires_at: datetime
    audience: Audience
    native_work_ref: str | None = None


class AdmissionAuthority(BaseModel):
    """Setup-scoped reservation. It never authorizes inference or MCP."""

    model_config = STRICT
    conversation_id: UuidStr
    provider_session_id: UuidStr
    session_generation: int = Field(ge=1)
    native_session_id: str | None
    active_agent_run_id: UuidStr
    ownership_epoch: Int64
    provider: Provider
    model: str | None
    brain_release_id: str
    brain_hash: Sha256
    behavior_version: str
    behavior_hash: Sha256
    corpus_release_id: str
    deployment_ref: str
    scope: Literal["setup"]


class OperationAuthority(BaseModel):
    model_config = STRICT
    inference_token: str = Field(min_length=1)
    knowledge_token: str = Field(min_length=1)


class SessionReservation(BaseModel):
    model_config = STRICT
    conversation_id: UuidStr
    provider_session_id: UuidStr
    session_generation: int = Field(ge=1)
    native_session_id: str | None
    harness_instance_id: UuidStr
    runtime_incarnation_id: UuidStr
    native_storage_unit_id: str = Field(min_length=1)
    state_location: str = Field(min_length=1)
    ownership_epoch: Int64
    provider: Provider
    model: str = Field(min_length=1)
    brain_release_id: str
    brain_hash: Sha256
    behavior_version: str
    behavior_hash: Sha256
    corpus_release_id: str
    deployment_ref: str


class SessionHandle(BaseModel):
    """Same pins as a reservation, with a non-null native identifier."""

    model_config = STRICT
    conversation_id: UuidStr
    provider_session_id: UuidStr
    session_generation: int = Field(ge=1)
    native_session_id: str = Field(min_length=1)
    harness_instance_id: UuidStr
    runtime_incarnation_id: UuidStr
    native_storage_unit_id: str = Field(min_length=1)
    state_location: str = Field(min_length=1)
    ownership_epoch: Int64
    provider: Provider
    model: str = Field(min_length=1)
    brain_release_id: str
    brain_hash: Sha256
    behavior_version: str
    behavior_hash: Sha256
    corpus_release_id: str
    deployment_ref: str


class WorkRef(BaseModel):
    model_config = STRICT
    native_session_id: str = Field(min_length=1)
    native_work_ref: str = Field(min_length=1)


class Accepted(BaseModel):
    model_config = STRICT
    kind: Literal["accepted"]
    work: WorkRef


class NotSubmitted(BaseModel):
    model_config = STRICT
    kind: Literal["not_submitted"]
    code: str = Field(min_length=1)


class Unconfirmed(BaseModel):
    model_config = STRICT
    kind: Literal["unconfirmed"]
    native_work_ref: str | None


SubmissionResult = Annotated[Accepted | NotSubmitted | Unconfirmed, Field(discriminator="kind")]


class NativeStatus(BaseModel):
    model_config = STRICT
    status: NativeWorkStatus
    native_work_ref: str | None = None
    request_id: str | None = None
    saved_input_available: bool


class HistoryItem(BaseModel):
    model_config = STRICT
    native_item_id: str = Field(min_length=1)
    native_work_ref: str | None
    role: Literal["user", "assistant"]
    text: str
    citations: list[Citation] = Field(default_factory=lambda: [])
    assets: list[AssetRef] = Field(default_factory=lambda: [])
    structured_data: list[StructuredData] = Field(default_factory=lambda: [])
    provisional: bool = False


class AuthorizedProvenance(BaseModel):
    """Source/tool observations retained by the owning harness, not an application transcript."""

    model_config = STRICT
    conversation_id: UuidStr
    native_session_id: str
    native_work_ref: str | None
    source_id: str
    version: str
    locator: str
    quote: str | None = None
    tool_name: str | None = None


class NativeHistorySnapshot(BaseModel):
    model_config = STRICT
    items: list[HistoryItem]
    native_cursor: str | None
    status: NativeStatus
    provenance: list[AuthorizedProvenance] = Field(default_factory=lambda: [])


class NativeEvent(BaseModel):
    """Missing native identity is rejected. There is no last-request heuristic."""

    model_config = STRICT
    native_session_id: str = Field(min_length=1)
    native_work_ref: str = Field(min_length=1)
    provider_session_id: UuidStr
    session_generation: int = Field(ge=1)
    active_agent_run_id: UuidStr
    ownership_epoch: Int64
    runtime_incarnation_id: UuidStr
    payload_type: str = Field(min_length=1)
    payload: dict[str, str | int | float | bool | None]


class AuthorityRecord(BaseModel):
    """Current primary-database authority. Tokens are not sufficient on their own."""

    model_config = STRICT
    conversation_id: UuidStr
    owner_subject_id: str
    provider: Provider
    provider_session_id: UuidStr
    session_generation: int
    is_current: bool
    native_session_id: str | None
    active_agent_run_id: UuidStr | None
    harness_instance_id: UuidStr | None
    runtime_incarnation_id: UuidStr | None
    ownership_epoch: Int64
    owner_lease_expires_at: datetime | None
    active_agent_run_expires_at: datetime | None = None
    brain_release_id: str
    brain_hash: Sha256
    behavior_version: str
    behavior_hash: Sha256
    corpus_release_id: str
    deployment_ref: str
    model: str | None
    qualification_status: QualificationStatus
    database_time: datetime
    runtime_state: RuntimeStateName
    guard_provider_session_id: UuidStr | None
    cancel_requested: bool = False
    recovery_count: int = 0
    recovery_started_at: datetime | None = None
    recovery_deadline_at: datetime | None = None
    current_request_id: str | None = None
    current_native_work_ref: str | None = None


class ProviderResponse(Protocol):
    """Provider status, rebuilt headers and the raw byte stream. Not a JSON payload."""

    status: int
    headers: Mapping[str, str]
    body: AsyncIterator[bytes]


class DispatchTicket(Protocol):
    """Write completion is separate from waiting on the provider response."""

    inference_id: str
    initiation: Mapping[str, str]
    write_completed: bool
    response: Awaitable[ProviderResponse]
