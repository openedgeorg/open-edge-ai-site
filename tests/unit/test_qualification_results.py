"""Task 2: missing evidence stays pending and never writes a production qualification row."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from scripts.qualify import REQUIRED_G1_SCENARIOS, classify_qualification, record_qualification
from tests.support.candidate_probe import QualificationCases
from tests.support.codex_capture import write_observation
from tests.support.grok_capture import write_grok_observation


def test_missing_or_empty_evidence_cannot_qualify(qualification_cases: QualificationCases) -> None:
    for case in qualification_cases.missing_binary_skipped_empty_or_unproven:
        assert classify_qualification(case) == "pending"
    assert classify_qualification(qualification_cases.essential_absent) == "invalidated"
    assert classify_qualification(qualification_cases.g2_only) == "pending"


def test_required_scenarios_and_positive_counts(qualification_cases: QualificationCases) -> None:
    assert set(REQUIRED_G1_SCENARIOS) == qualification_cases.expected_g1_scenarios
    assert set(qualification_cases.expected_da01_criteria) == {
        "multiple_sessions",
        "parallel_runs",
        "immediate_admission",
        "request_scoped_identity",
        "privacy_isolation",
        "bounded_residency",
        "native_persistence",
        "native_history_binding",
        "group_crash_recovery",
        "capacity_and_cost",
        "release_compatibility",
    }
    complete = qualification_cases.synthetic_complete
    assert complete.positive_observation_count > 0
    assert classify_qualification(complete) == "validated"


def test_synthetic_complete_fixture_never_writes_production_row(
    qualification_cases: QualificationCases, tmp_path: Path
) -> None:
    destination = tmp_path / "runtime_qualification.json"
    record_qualification(qualification_cases.synthetic_complete, destination, synthetic=True)
    assert json.loads(destination.read_text(encoding="utf-8")) == []


def test_cli_pending_and_invalidated_are_nonzero(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[2]
    # A recorded observation keeps the ordinary suite from executing the installed Codex build.
    recorded = ["--observation-file", str(write_observation(tmp_path / "observation.json"))]
    hermetic = {"PATH": str(tmp_path / "no-binaries"), "HOME": str(tmp_path)}
    pending = subprocess.run(
        [sys.executable, "scripts/qualify.py", "inspect", "--provider", "openai", *recorded],
        cwd=root,
        env=hermetic,
        capture_output=True,
        text=True,
        check=False,
    )
    assert pending.returncode != 0
    assert "pending" in pending.stdout
    # Likewise for the installed Grok Build.
    recorded_xai = ["--observation-file", str(write_grok_observation(tmp_path / "grok-observation.json"))]
    xai = subprocess.run(
        [sys.executable, "scripts/qualify.py", "inspect", "--provider", "xai", *recorded_xai],
        cwd=root,
        env=hermetic,
        capture_output=True,
        text=True,
        check=False,
    )
    assert xai.returncode != 0
    assert "pending" in xai.stdout
    invalidated = subprocess.run(
        [
            sys.executable,
            "scripts/qualify.py",
            "inspect",
            "--provider",
            "openai",
            "--assume-essential-absent",
            *recorded,
        ],
        cwd=root,
        env=hermetic,
        capture_output=True,
        text=True,
        check=False,
    )
    assert invalidated.returncode != 0
    assert "invalidated" in invalidated.stdout


@pytest.fixture
def qualification_cases() -> QualificationCases:
    return QualificationCases()
