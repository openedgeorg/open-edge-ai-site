"""Truthful qualification recorder.

Live gates stay pending until real evidence exists. A synthetic fixture cannot
insert a production qualification row.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from esp_contracts.ids import Provider
from esp_contracts.qualification import (
    REQUIRED_PRIMITIVES,
    CapabilityReport,
    PrimitiveEvidence,
    QualificationResult,
    RuntimeProfile,
)

REQUIRED_G1_SCENARIOS: tuple[str, ...] = (
    "g1a_shared_main_process",
    "g1a_distinct_private_canaries",
    "g1a_mixed_brain_releases",
    "g1a_mixed_behavior_releases",
    "g1a_interleaved_requests",
    "g1a_interleaved_mcp",
    "g1a_repeated_turns",
    "g1a_multiple_tools",
    "g1a_native_retries",
    "g1a_automatic_compaction",
    "g1a_manual_compaction",
    "g1a_resume",
    "g1a_long_input",
    "g1a_absent_injection",
    "g1a_corrupt_block_rejected",
    "g1a_duplicate_block_rejected",
    "g1a_inert_pasted_markers",
    "g1a_stale_scopes",
    "g1a_disabled_auxiliary",
    "g1a_evidence_equality",
    "g1a_egress_denial",
    "g1b_owned_create",
    "g1b_conversation_saturation",
    "g1b_resident_saturation",
    "g1b_active_saturation",
    "g1b_provider_saturation",
    "g1b_rejected_input_not_executed_later",
    "g1b_presubmit_release",
    "g1b_ambiguous_acceptance_no_replay",
    "g1b_two_successive_messages",
    "g1b_peer_safe_cancel",
    "g1b_peer_safe_unload",
)

_COMMANDS = ("inspect", "network", "storage", "g1", "g2", "capacity", "da01", "privacy", "release")
_OPENAI_BINARIES = ("codex",)
_XAI_BINARIES = ("grok",)


def classify_qualification(report: QualificationResult) -> str:
    """Pending unless evidence is complete. Demonstrated essential absence invalidates."""
    if report.essential_absence or report.status == "invalidated":
        return "invalidated"
    scenarios = set(report.scenario_ids)
    digests = (
        report.harness_build,
        report.runtime_image_digest,
        report.transport_integration_digest,
        report.storage_profile,
        report.tool_policy_digest,
        report.configuration_digest,
        report.environment_digest,
        report.allowlist_digest,
        report.evidence_bundle_ref,
        report.acceptance_budgets_ref,
        report.review_owner,
        report.reviewer,
    )
    complete = (
        report.status == "validated"
        and report.g1a_complete
        and report.g1b_complete
        and report.g2_complete
        and report.functional_subgate_pass
        and report.positive_observation_count > 0
        and not report.skipped
        and not report.empty_evidence
        and not report.failed_criteria
        and scenarios >= set(REQUIRED_G1_SCENARIOS)
        and all(digests)
    )
    if complete:
        return "validated"
    return "pending"


def inspect_candidate(provider: Provider, profile: RuntimeProfile | None = None) -> CapabilityReport:
    """Read the installed candidate without upgrading it. Missing hooks stay unproven."""
    version = _installed_version(provider)
    primitives = [
        PrimitiveEvidence(name=name, state="unproven", evidence_ref=None) for name in REQUIRED_PRIMITIVES
    ]
    notes = ["No protected evidence reference is recorded for this primitive."]
    if version is None:
        notes.insert(0, "Candidate binary was not found. Discovery did not install or upgrade one.")
    else:
        notes.insert(0, f"Installed version string observed without treating it as proof: {version}")
    return CapabilityReport(
        provider=provider,
        profile=profile,
        installed_version=version,
        primitives=primitives,
        notes=notes,
    )


def record_qualification(report: QualificationResult, destination: Path, *, synthetic: bool) -> None:
    """Synthetic and fixture evidence never becomes a production qualification row."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if synthetic or (report.evidence_bundle_ref or "").startswith("synthetic:"):
        destination.write_text("[]\n", encoding="utf-8")
        return
    classification = classify_qualification(report)
    row = {
        "provider": report.provider,
        "gate": report.gate,
        "classification": classification,
        "production": False,
    }
    destination.write_text(json.dumps([row], indent=2) + "\n", encoding="utf-8")


def _installed_version(provider: Provider) -> str | None:
    names = _OPENAI_BINARIES if provider == "openai" else _XAI_BINARIES
    for name in names:
        path = shutil.which(name)
        if path is None:
            continue
        try:
            completed = subprocess.run(
                [path, "--version"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        text = (completed.stdout or completed.stderr).strip()
        return text.splitlines()[0] if text else path
    return None


def _report_for(command: str, provider: Provider, *, assume_essential_absent: bool) -> QualificationResult:
    version = _installed_version(provider) if command == "inspect" else None
    return QualificationResult(
        provider=provider,
        gate=command,
        status="invalidated" if assume_essential_absent else "pending",
        essential_absence=assume_essential_absent,
        failed_criteria=["essential_primitive_absent"] if assume_essential_absent else [],
        harness_build=version,
        empty_evidence=not assume_essential_absent,
        positive_observation_count=0,
        scenario_ids=[],
        g1a_complete=False,
        g1b_complete=False,
        g2_complete=False,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="qualify")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in _COMMANDS:
        command = sub.add_parser(name)
        command.add_argument("--provider", required=True, choices=["openai", "xai"])
        command.add_argument("--json", action="store_true")
        command.add_argument("--assume-essential-absent", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    provider: Provider = args.provider
    report = _report_for(args.command, provider, assume_essential_absent=args.assume_essential_absent)
    classification = classify_qualification(report)
    payload = report.model_dump(mode="json")
    payload["classification"] = classification
    if args.json:
        print(json.dumps(payload))
    else:
        print(classification)
        print(f"provider={provider} gate={args.command} observations={report.positive_observation_count}")
    if classification == "invalidated":
        return 3
    if classification == "validated" and args.command == "da01":
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
