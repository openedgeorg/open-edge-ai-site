"""Privacy stays pending until a real peer-safe mechanism and an approved policy exist."""

from __future__ import annotations

import pytest

from esp_contracts.evaluation import ProductionConfig
from esp_contracts.runtime import SessionHandle
from scripts.history_lifecycle import delete_native_history, run_privacy, validate_release_readiness

_HASH = "ab" * 32
_UID = "00000000-0000-4000-8000-000000000001"


def _config(**overrides: object) -> ProductionConfig:
    data: dict[str, object] = {
        "region": "region-1",
        "encryption_owner": "owner",
        "key_owner": "owner",
        "runtime_identity": "esp-runtime",
        "web_identity": "esp-web",
        "knowledge_identity": "esp-knowledge",
        "native_retention": "30d",
        "evidence_retention": "365d",
        "metadata_retention": "30d",
        "telemetry_retention": "14d",
        "backup_retention": "30d",
        "cookie_lifetime": "12h",
        "qualified_profile_refs": ["profile-1"],
        "resident_limit": 2,
        "active_limit": 1,
        "deletion_required": True,
        "deletion_supported": False,
        "workload_digest": "workload-1",
        "transport_digest": "transport-1",
        "storage_profile": "storage-1",
    }
    data.update(overrides)
    return ProductionConfig.model_validate(data)


class PrivacyLab:
    def __init__(self) -> None:
        self.original_peer_history = "peer-native-1"

    def config_without_retention(self):
        return validate_release_readiness(_config(native_retention=""))

    async def browser_evidence_access(self) -> str:
        return "denied"

    async def knowledge_native_volume_access(self) -> str:
        return "denied"

    async def peer_history_after_target_deletion(self) -> str:
        handle = SessionHandle(
            conversation_id=_UID,
            provider_session_id=_UID,
            session_generation=1,
            native_session_id="native-target",
            harness_instance_id=_UID,
            runtime_incarnation_id=_UID,
            native_storage_unit_id="unit-1",
            state_location="local",
            ownership_epoch=1,
            provider="openai",
            model="candidate",
            brain_release_id="brain",
            brain_hash=_HASH,
            behavior_version="behavior",
            behavior_hash=_HASH,
            corpus_release_id="corpus",
            deployment_ref="dep",
        )
        result = delete_native_history(handle)
        assert result.status == "unsupported"
        return self.original_peer_history

    def required_but_unsupported_deletion(self):
        return validate_release_readiness(_config())


@pytest.fixture
def privacy_lab() -> PrivacyLab:
    return PrivacyLab()


@pytest.mark.qualification
async def test_privacy_policy_is_supported_and_peer_safe(privacy_lab: PrivacyLab) -> None:
    assert not privacy_lab.config_without_retention().ready
    assert await privacy_lab.browser_evidence_access() == "denied"
    assert await privacy_lab.knowledge_native_volume_access() == "denied"
    assert await privacy_lab.peer_history_after_target_deletion() == privacy_lab.original_peer_history
    assert not privacy_lab.required_but_unsupported_deletion().ready


@pytest.mark.qualification
def test_live_privacy_command_has_no_evidence() -> None:
    report = run_privacy("openai")
    assert report.status == "pending"
    assert report.empty_evidence
