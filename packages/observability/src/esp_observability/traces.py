"""§18.1–§18.3 traces. High-cardinality ids stay here, not on metric labels.

A telemetry failure is an observation gap. It is not a failed dispatch and it is not evidence.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from esp_contracts.api import STRICT
from esp_contracts.runtime import RunBinding

AdmissionOutcome = Literal["admitted", "duplicate_active", "rejected"]


class ChatTrace(BaseModel):
    """Every §18.1 field. Unknown measurements stay null; visitor text is not a field."""

    model_config = STRICT
    request_id: str | None = None
    conversation_id: str | None = None
    provider: str | None = None
    model: str | None = None
    brain_version: str | None = None
    canonical_brain_sha256: str | None = None
    provider_session_id: str | None = None
    latency_ms: int | None = None
    admission_decision_ms: int | None = None
    admission_outcome: AdmissionOutcome | None = None
    rejection_reason: str | None = None
    http_status: int | None = None
    time_to_first_token_ms: int | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_tokens: int | None = None
    retrieval_used: bool | None = None
    retrieval_calls: int | None = None
    retrieved_source_ids: list[str] = Field(default_factory=list)
    tool_errors: int | None = None
    completion_status: str | None = None


class InferenceTrace(BaseModel):
    """Every §18.2 field. The request body itself is not stored here."""

    model_config = STRICT
    inference_id: str | None = None
    request_id: str | None = None
    conversation_id: str | None = None
    provider: str | None = None
    model: str | None = None
    provider_session_id: str | None = None
    harness_instance_id: str | None = None
    runtime_incarnation_id: str | None = None
    session_generation: int | None = None
    active_agent_run_id: str | None = None
    native_work_ref: str | None = None
    ownership_epoch: int | None = None
    provider_request_id: str | None = None
    brain_version: str | None = None
    canonical_brain_sha256: str | None = None
    canonical_brain_bytes: int | None = None
    request_body_sha256: str | None = None
    request_body_bytes: int | None = None
    brain_start_offset: int | None = None
    brain_end_offset: int | None = None
    extracted_brain_sha256: str | None = None
    extracted_brain_bytes: int | None = None
    brain_presence_verified: bool | None = None
    harness_revision: str | None = None
    verifier_revision: str | None = None
    context_evidence_ref: str | None = None


class RecoveryTrace(BaseModel):
    """Every §18.3 field."""

    model_config = STRICT
    conversation_id: str | None = None
    native_session_id: str | None = None
    active_agent_run_id: str | None = None
    native_work_ref: str | None = None
    session_generation: int | None = None
    harness_instance_id: str | None = None
    runtime_incarnation_id: str | None = None
    worker_id: str | None = None
    ownership_epoch: int | None = None
    native_storage_unit_id: str | None = None
    session_state: str | None = None
    harness_instance_state: str | None = None
    recovery_group_id: str | None = None
    affected_session_count: int | None = None
    recovery_mode: str | None = None
    recovery_reason: str | None = None
    recovery_duration_ms: int | None = None
    admission_decision_ms: int | None = None
    qualification_id: str | None = None


class TraceSink:
    """In-process trace log. `failed` simulates a telemetry outage without touching evidence."""

    def __init__(self) -> None:
        self.chat: list[ChatTrace] = []
        self.inference: list[InferenceTrace] = []
        self.recovery: list[RecoveryTrace] = []
        self.retrieval_notes = 0
        self.failed = False

    def record_chat(self, trace: ChatTrace) -> None:
        self._accept()
        self.chat.append(trace)

    def record_inference(self, trace: InferenceTrace) -> None:
        self._accept()
        self.inference.append(trace)

    def record_recovery(self, trace: RecoveryTrace) -> None:
        self._accept()
        self.recovery.append(trace)

    def _accept(self) -> None:
        if self.failed:
            raise OSError("telemetry_down")


_sink = TraceSink()


def install_sink(sink: TraceSink) -> None:
    global _sink
    _sink = sink


def current_sink() -> TraceSink:
    return _sink


def record_chat_trace(trace: ChatTrace) -> None:
    _sink.record_chat(trace)


def record_inference_trace(trace: InferenceTrace) -> None:
    _sink.record_inference(trace)


def record_recovery_trace(trace: RecoveryTrace) -> None:
    _sink.record_recovery(trace)


def note_retrieval(redacted_query: object) -> None:
    """Count a retrieval observation. The caller passes an already redacted value, which is not stored."""
    if _sink.failed:
        return
    if not isinstance(redacted_query, dict):
        return
    _sink.retrieval_notes += 1


def dispatch_observation(*, evidence_persisted: bool, trace: InferenceTrace) -> str:
    """Evidence gates dispatch. Telemetry does not.

    Missing evidence blocks. A sink that raises after evidence was stored still returns
    `verified_dispatch`.
    """
    if not evidence_persisted:
        return "blocked"
    try:
        record_inference_trace(trace)
    except OSError:
        return "verified_dispatch"
    return "verified_dispatch"


def inference_trace_from_binding(
    binding: RunBinding,
    inference_id: str,
    *,
    request_body_sha256: str,
    request_body_bytes: int,
    context_evidence_ref: str | None,
) -> InferenceTrace:
    """Correlation fields copied from the authorized binding. No request bytes."""
    return InferenceTrace(
        inference_id=inference_id,
        conversation_id=binding.conversation_id,
        provider=binding.provider,
        model=binding.model,
        provider_session_id=binding.provider_session_id,
        harness_instance_id=binding.harness_instance_id,
        runtime_incarnation_id=binding.runtime_incarnation_id,
        session_generation=binding.session_generation,
        active_agent_run_id=binding.active_agent_run_id,
        native_work_ref=binding.native_work_ref,
        ownership_epoch=binding.ownership_epoch,
        brain_version=binding.brain_release_id,
        canonical_brain_sha256=binding.brain_hash,
        request_body_sha256=request_body_sha256,
        request_body_bytes=request_body_bytes,
        brain_presence_verified=True,
        context_evidence_ref=context_evidence_ref,
    )
