"""Synthetic contract fixtures. IDs are not live qualification evidence."""

from datetime import UTC, datetime, timedelta

import pytest

from esp_contracts.runtime import RunBinding

EPOCH = 9007199254740993


def binding_kwargs() -> dict[str, object]:
    now = datetime(2026, 10, 2, 12, 0, tzinfo=UTC)
    return {
        "conversation_id": "11111111-1111-4111-8111-111111111111",
        "provider_session_id": "22222222-2222-4222-8222-222222222222",
        "session_generation": 1,
        "native_session_id": "native-session-a",
        "active_agent_run_id": "33333333-3333-4333-8333-333333333333",
        "harness_instance_id": "44444444-4444-4444-8444-444444444444",
        "runtime_incarnation_id": "55555555-5555-4555-8555-555555555555",
        "ownership_epoch": EPOCH,
        "provider": "openai",
        "model": "configured-model",
        "brain_release_id": "fixture-brain-a",
        "brain_hash": "a" * 64,
        "behavior_version": "fixture-behavior-a",
        "behavior_hash": "b" * 64,
        "corpus_release_id": "fixture-corpus-a",
        "deployment_ref": "deployment-fixture",
        "issued_at": now,
        "expires_at": now + timedelta(seconds=30),
        "audience": "inference",
    }


@pytest.fixture
def valid_binding() -> RunBinding:
    return RunBinding.model_validate(binding_kwargs())


@pytest.fixture
def valid_message() -> dict[str, str]:
    return {
        "conversation_id": "11111111-1111-4111-8111-111111111111",
        "client_request_id": "browser-req-1",
        "message": "Why does ESP use a fixed provider?",
    }
