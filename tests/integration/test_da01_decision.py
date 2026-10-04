"""DA-01 stays pending without a preapproved budget. A synthetic pass never publishes."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import psycopg
import pytest

from esp_contracts.ids import Provider
from esp_contracts.qualification import CapacityReport, QualificationResult, Reviewer
from scripts.da01 import decide_da01
from tests.support.database import APP_DSN

ROOT = Path(__file__).resolve().parents[2]
_DIGEST = "sha256:" + ("ab" * 32)


def _gate(provider: Provider, gate: str, *, complete: bool) -> QualificationResult:
    return QualificationResult(
        provider=provider,
        gate=gate,
        status="validated" if complete else "pending",
        g1a_complete=complete and gate == "g1",
        g1b_complete=complete and gate == "g1",
        g2_complete=complete and gate == "g2",
        functional_subgate_pass=complete,
        transport_integration_digest=_DIGEST,
        positive_observation_count=1 if complete else 0,
    )


def _capacity(**overrides: object) -> CapacityReport:
    data: dict[str, object] = {
        "provider": "openai",
        "measured": True,
        "within_budget": True,
        "preapproved": True,
        "transport_digest": _DIGEST,
        "budgets_transport_digest": _DIGEST,
        "criteria": [],
        "published": False,
    }
    data.update(overrides)
    return CapacityReport.model_validate(data)


class Da01Cases:
    def g2_without_capacity(self) -> QualificationResult:
        decision = decide_da01(
            _gate("openai", "g1", complete=True),
            _gate("openai", "g2", complete=True),
            None,
            _reviewer(),
        )
        return QualificationResult(provider="openai", gate="da01", status=decision.status, empty_evidence=True)

    def capacity_without_preapproved_budget(self) -> QualificationResult:
        decision = decide_da01(
            _gate("openai", "g1", complete=True),
            _gate("openai", "g2", complete=True),
            _capacity(preapproved=False),
            _reviewer(),
        )
        return QualificationResult(provider="openai", gate="da01", status=decision.status)

    def changed_transport_digest(self) -> QualificationResult:
        decision = decide_da01(
            _gate("openai", "g1", complete=True),
            _gate("openai", "g2", complete=True),
            _capacity(budgets_transport_digest="sha256:" + ("cd" * 32)),
            _reviewer(),
        )
        return QualificationResult(provider="openai", gate="da01", status=decision.status)

    def demonstrated_capacity_failure(self) -> QualificationResult:
        decision = decide_da01(
            _gate("openai", "g1", complete=True),
            _gate("openai", "g2", complete=True),
            _capacity(within_budget=False),
            _reviewer(),
        )
        return QualificationResult(provider="openai", gate="da01", status=decision.status)

    def openai_pass(self):
        return decide_da01(
            _gate("openai", "g1", complete=True),
            _gate("openai", "g2", complete=True),
            _capacity(criteria=_all_criteria()),
            _reviewer(),
        )


def _reviewer() -> Reviewer:
    return Reviewer(identity="qualification-admin", role="qualification_admin", reviewed_at=datetime.now(UTC))


def _all_criteria() -> list[str]:
    from esp_contracts.qualification import REQUIRED_DA01_CRITERIA

    return list(REQUIRED_DA01_CRITERIA)


@pytest.fixture
def da01_cases() -> Da01Cases:
    return Da01Cases()


def test_functional_recovery_is_insufficient(da01_cases: Da01Cases) -> None:
    assert da01_cases.g2_without_capacity().status == "pending"
    assert da01_cases.capacity_without_preapproved_budget().status == "pending"
    assert da01_cases.changed_transport_digest().status == "pending"
    assert da01_cases.demonstrated_capacity_failure().status == "invalidated"
    assert not da01_cases.openai_pass().qualifies_xai


def test_schema_has_no_silent_approved_defaults() -> None:
    schema = json.loads((ROOT / "docs/qualification/acceptance-budgets.schema.json").read_text(encoding="utf-8"))
    assert schema["additionalProperties"] is False
    assert "approved" in schema["required"]
    assert "acceptance-budgets.json" not in {path.name for path in (ROOT / "docs/qualification").iterdir()}
    for prop in schema["properties"].values():
        assert "default" not in prop


def test_synthetic_decision_does_not_publish(da01_cases: Da01Cases) -> None:
    before = _validated_rows()
    decision = da01_cases.openai_pass()
    after = _validated_rows()
    assert decision.status == "validated"
    assert decision.published is False
    assert decision.qualifies_openai is True
    assert before == after
    for name in ("openai", "xai"):
        candidate = json.loads((ROOT / "docs/qualification" / name / "candidate.json").read_text(encoding="utf-8"))
        assert candidate["status"] == "pending"


def _validated_rows() -> int:
    with psycopg.connect(APP_DSN, autocommit=True) as connection:
        row = connection.execute("SELECT count(*) FROM runtime_qualification WHERE status = 'validated'").fetchone()
    assert row is not None
    return int(row[0])
