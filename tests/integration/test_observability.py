"""Telemetry is not the correctness store. Evidence failure blocks; a trace outage does not."""

from __future__ import annotations

import json
from collections.abc import Iterator

import pytest
from pydantic import BaseModel, ValidationError

from esp_contracts.api import STRICT
from esp_observability.audit import AuditResult, EvidenceInventory, FlowInventory, ProviderUsage, reconcile_egress
from esp_observability.redaction import redact_log
from esp_observability.traces import (
    ChatTrace,
    InferenceTrace,
    RecoveryTrace,
    TraceSink,
    current_sink,
    dispatch_observation,
    install_sink,
)

_CHAT_FIELDS = {
    "request_id",
    "conversation_id",
    "provider",
    "model",
    "brain_version",
    "canonical_brain_sha256",
    "provider_session_id",
    "latency_ms",
    "admission_decision_ms",
    "admission_outcome",
    "rejection_reason",
    "http_status",
    "time_to_first_token_ms",
    "input_tokens",
    "output_tokens",
    "cached_tokens",
    "retrieval_used",
    "retrieval_calls",
    "retrieved_source_ids",
    "tool_errors",
    "completion_status",
}
_INFERENCE_FIELDS = {
    "inference_id",
    "request_id",
    "conversation_id",
    "provider",
    "model",
    "provider_session_id",
    "harness_instance_id",
    "runtime_incarnation_id",
    "session_generation",
    "active_agent_run_id",
    "native_work_ref",
    "ownership_epoch",
    "provider_request_id",
    "brain_version",
    "canonical_brain_sha256",
    "canonical_brain_bytes",
    "request_body_sha256",
    "request_body_bytes",
    "brain_start_offset",
    "brain_end_offset",
    "extracted_brain_sha256",
    "extracted_brain_bytes",
    "brain_presence_verified",
    "harness_revision",
    "verifier_revision",
    "context_evidence_ref",
}
_RECOVERY_FIELDS = {
    "conversation_id",
    "native_session_id",
    "active_agent_run_id",
    "native_work_ref",
    "session_generation",
    "harness_instance_id",
    "runtime_incarnation_id",
    "worker_id",
    "ownership_epoch",
    "native_storage_unit_id",
    "session_state",
    "harness_instance_state",
    "recovery_group_id",
    "affected_session_count",
    "recovery_mode",
    "recovery_reason",
    "recovery_duration_ms",
    "admission_decision_ms",
    "qualification_id",
}


class _Echo(BaseModel):
    model_config = STRICT
    message: str


class TraceLab:
    private_message = "visitor-private-canary-9f3c"
    cookie_secret = "cookie-secret-canary-aa91"

    def __init__(self) -> None:
        self.sink = TraceSink()
        install_sink(self.sink)

    async def dispatch_with_telemetry_down(self) -> str:
        self.sink.failed = True
        return dispatch_observation(evidence_persisted=True, trace=InferenceTrace(inference_id="inf-ok"))

    async def dispatch_with_evidence_down(self) -> str:
        self.sink.failed = False
        return dispatch_observation(evidence_persisted=False, trace=InferenceTrace(inference_id="inf-blocked"))

    async def all_logs_including_validation_errors(self) -> str:
        captured: list[object] = [
            redact_log({"message": self.private_message, "cookie": self.cookie_secret, "conversation_id": "c-1"}),
            redact_log({"headers": {"cookie": self.cookie_secret, "authorization": "Bearer " + self.cookie_secret}}),
        ]
        try:
            _Echo.model_validate({"message": self.private_message, "cookie": self.cookie_secret})
        except ValidationError as exc:
            captured.append(redact_log(exc))
        return json.dumps(captured)

    def audit_injected_unmatched_dispatch(self) -> AuditResult:
        return reconcile_egress(
            EvidenceInventory(inference_ids=["inf-a"]),
            FlowInventory(dispatched_inference_ids=["inf-a", "inf-unmatched"]),
            ProviderUsage(available=True, request_ids=["inf-a"]),
        )


async def test_correctness_store_and_telemetry_are_distinct(trace_lab: TraceLab) -> None:
    assert await trace_lab.dispatch_with_telemetry_down() == "verified_dispatch"
    assert await trace_lab.dispatch_with_evidence_down() == "blocked"
    logs = await trace_lab.all_logs_including_validation_errors()
    assert trace_lab.private_message not in logs
    assert trace_lab.cookie_secret not in logs
    assert trace_lab.audit_injected_unmatched_dispatch().unobservable_count == 1


def test_trace_models_carry_every_section_18_field() -> None:
    assert set(ChatTrace.model_fields) == _CHAT_FIELDS
    assert set(InferenceTrace.model_fields) == _INFERENCE_FIELDS
    assert set(RecoveryTrace.model_fields) == _RECOVERY_FIELDS
    trace = InferenceTrace(
        inference_id="inf-1",
        conversation_id="11111111-1111-4111-8111-111111111111",
        ownership_epoch=7,
        active_agent_run_id="33333333-3333-4333-8333-333333333333",
        brain_presence_verified=True,
    )
    assert trace.ownership_epoch == 7
    assert trace.active_agent_run_id == "33333333-3333-4333-8333-333333333333"


def test_missing_provider_usage_stays_pending() -> None:
    result = reconcile_egress(
        EvidenceInventory(inference_ids=["inf-a"]),
        FlowInventory(dispatched_inference_ids=["inf-a"]),
        ProviderUsage(available=False),
    )
    assert result.coverage == "pending"
    assert result.verified_forwarded_count == 0
    assert result.unobservable_count == 1


@pytest.fixture
def trace_lab() -> Iterator[TraceLab]:
    previous = current_sink()
    lab = TraceLab()
    try:
        yield lab
    finally:
        install_sink(previous)
