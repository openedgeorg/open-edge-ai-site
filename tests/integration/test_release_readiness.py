"""A package without retention, or with required but unsupported deletion, is not ready."""

from __future__ import annotations

from pathlib import Path

from esp_contracts.evaluation import ProductionConfig
from scripts.history_lifecycle import validate_release_readiness

ROOT = Path(__file__).resolve().parents[2]


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


def test_missing_retention_or_unsupported_deletion_is_not_ready() -> None:
    assert validate_release_readiness(_config(native_retention="")).ready is False
    assert validate_release_readiness(_config()).ready is False
    knowledge = (ROOT / "infra" / "k8s" / "base" / "knowledge.yaml").read_text(encoding="utf-8")
    runtime = (ROOT / "infra" / "k8s" / "base" / "runtimes.yaml").read_text(encoding="utf-8")
    assert "native-sessions" not in knowledge
    assert "native-sessions" in runtime
