"""G1 coverage fails closed. A stub, a dropped scenario, or the same Brain twice is not a pass."""

from __future__ import annotations

import json
import subprocess
import tomllib
from collections.abc import Mapping
from pathlib import Path

import pytest
from pydantic import ValidationError

from scripts.gate_coverage import G1_SCENARIOS, Gate1Observation, evaluate_gate1, run_gate1
from scripts.qualify import (
    REQUIRED_G1_SCENARIOS,
    ComposeQualificationEnvironment,
    LiveSessionEvidence,
    QualificationEnvironment,
    attempt_compose_gate1,
    default_compose_qualification_environment,
    launch_gateway_sessions,
    parse_proc_net_address,
)


def _almost() -> Gate1Observation:
    return Gate1Observation(
        actual_main_process_count=1,
        max_overlapping_native_sessions=2,
        brain_versions=["brain-a", "brain-b"],
        brain_hashes=["a" * 64, "b" * 64],
        behavior_versions=["beh-a", "beh-b"],
        captured_inference_count=2,
        compaction_inference_count=1,
        scenario_ids=list(G1_SCENARIOS),
    )


def test_scenario_list_matches_the_qualify_contract() -> None:
    assert set(G1_SCENARIOS) == set(REQUIRED_G1_SCENARIOS)


def test_removed_scenario_or_same_brain_stays_pending() -> None:
    dropped = _almost()
    dropped.scenario_ids = dropped.scenario_ids[:-1]
    assert evaluate_gate1("openai", dropped).status == "pending"
    assert not evaluate_gate1("openai", dropped).g1a_complete

    same = _almost()
    same.same_brain_pair = True
    same.brain_hashes = ["a" * 64, "a" * 64]
    assert evaluate_gate1("xai", same).status == "pending"
    assert not evaluate_gate1("xai", same).g1b_complete

    stub = _almost()
    stub.stub = True
    assert evaluate_gate1("openai", stub).status == "pending"


def test_bypass_invalidates_and_live_command_has_no_bundle(monkeypatch: pytest.MonkeyPatch) -> None:
    leaked = _almost()
    leaked.bypass_count = 1
    assert evaluate_gate1("openai", leaked).status == "invalidated"
    assert evaluate_gate1("openai", leaked).failed_criteria == ["safety_failure"]

    def attempt(
        provider: str, environ: Mapping[str, str]
    ) -> tuple[Gate1Observation, list[str], str | None]:
        del environ
        assert provider == "openai"
        return (
            Gate1Observation(stub=False),
            ["g1_attempt_codex:started", "g1_attempt_grok:started", "g1_attempt_brain:unobserved"],
            "sha256:" + "a" * 64,
        )

    monkeypatch.setattr("scripts.qualify.attempt_compose_gate1", attempt)
    live = run_gate1("openai", None)
    assert live.status == "pending"
    assert live.empty_evidence
    assert live.positive_observation_count == 0
    assert not live.g1a_complete
    assert not live.g1b_complete
    assert "g1_attempt_codex:started" in live.failed_criteria
    assert "g1_attempt_grok:started" in live.failed_criteria
    assert "g1_attempt_brain:unobserved" in live.failed_criteria
    assert live.environment_digest == "sha256:" + "a" * 64


def test_conversation_isolation_and_missing_brain_invalidate() -> None:
    isolated = _almost()
    isolated.conversation_isolation_failures = 1
    isolation = evaluate_gate1("openai", isolated)
    assert isolation.status == "invalidated"
    assert "conversation_isolation_failure" in isolation.failed_criteria

    bare = _almost()
    bare.brain_hashes = []
    bare.brain_versions = []
    missing_brain = evaluate_gate1("xai", bare)
    assert missing_brain.status == "invalidated"
    assert "brain_absent" in missing_brain.failed_criteria


def test_proc_address_decodes_loopback() -> None:
    assert parse_proc_net_address("0100007F:1F90") == ("127.0.0.1", 8080)
    assert parse_proc_net_address("00000000000000000000000001000000:01BB")[0] == "::1"
    assert parse_proc_net_address("00000000000000000000000001000000:01BB")[1] == 443


def _ok(argv: list[str], env: Mapping[str, str], timeout: float) -> subprocess.CompletedProcess[str]:
    del env, timeout
    return subprocess.CompletedProcess(argv, 0, "", "")


def test_compose_attempt_does_not_ask_for_a_cluster(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def runner(argv: list[str], env: Mapping[str, str], timeout: float) -> subprocess.CompletedProcess[str]:
        del env, timeout
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 7, "", "compose failed in test")

    def sessions(environment: ComposeQualificationEnvironment, work_root: Path) -> LiveSessionEvidence:
        del work_root
        assert environment.runtime == "compose"
        assert environment.gateway_openai_base_url.startswith("http://127.0.0.1:")
        assert environment.gateway_xai_base_url.startswith("http://127.0.0.1:")
        return LiveSessionEvidence(
            notes=["g1_attempt_codex:started", "g1_attempt_grok:started", "g1_attempt_brain:unobserved"]
        )

    monkeypatch.setattr("scripts.qualify.launch_gateway_sessions", sessions)
    kube = tmp_path / "cluster.json"
    kube.write_text(
        json.dumps(
            {
                "kube_context": "prod",
                "cluster_uid": "00000000-0000-4000-8000-000000000001",
                "namespace": "esp-qualification",
            }
        ),
        encoding="utf-8",
    )
    observation, notes, digest = attempt_compose_gate1(
        "openai",
        {"ESP_QUALIFICATION_ENV": str(kube)},
        command_runner=runner,
        session_launcher=sessions,
    )
    joined = " ".join(" ".join(argv) for argv in calls)
    assert "kubectl" not in joined
    assert "esp-qualification" not in joined
    assert "compose.yaml" in joined
    assert "esp_inference_gateway.main" in joined
    assert observation.stub is False
    assert observation.brain_hashes == []
    assert "g1_attempt_cluster_record_ignored" in notes
    assert any(item.startswith("g1_attempt_compose_exit:7") for item in notes)
    assert any(item.startswith("g1_attempt_compose_command:") for item in notes)
    assert digest is not None and digest.startswith("sha256:")


def test_default_g1_launcher_is_the_live_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, str] = {}

    def sessions(environment: ComposeQualificationEnvironment, work_root: Path) -> LiveSessionEvidence:
        del work_root
        seen["openai"] = environment.gateway_openai_base_url
        seen["xai"] = environment.gateway_xai_base_url
        return LiveSessionEvidence(notes=["g1_attempt_codex:replaced", "g1_attempt_grok:replaced"])

    monkeypatch.setattr("scripts.qualify.launch_gateway_sessions", sessions)
    _, notes, _ = attempt_compose_gate1("xai", {}, command_runner=_ok)
    assert notes[-2:] == ["g1_attempt_codex:replaced", "g1_attempt_grok:replaced"] or (
        "g1_attempt_codex:replaced" in notes and "g1_attempt_grok:replaced" in notes
    )
    assert seen["openai"].startswith("http://127.0.0.1:")
    assert seen["xai"].startswith("http://127.0.0.1:")


def test_missing_clis_are_recorded_and_do_not_pass(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def missing_binary(name: str) -> str | None:
        del name
        return None

    monkeypatch.setattr("scripts.qualify.shutil.which", missing_binary)
    evidence = launch_gateway_sessions(default_compose_qualification_environment(), tmp_path)
    assert "g1_attempt_codex:binary_missing" in evidence.notes
    assert "g1_attempt_grok:binary_missing" in evidence.notes
    assert evidence.conversation_isolation_failures == 0
    assert evidence.bypass_count == 0
    assert "g1_attempt_brain:unobserved" in evidence.notes


def test_grok_launch_pins_loopback_auth_method(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def grok_only(name: str) -> str | None:
        if name == "grok":
            return "/usr/bin/false"
        return None

    async def stop_before_cli(*_args: object, **_kwargs: object) -> tuple[list[str], int, str]:
        raise OSError("stopped before the cli")

    monkeypatch.setattr("scripts.qualify.shutil.which", grok_only)
    monkeypatch.setattr("scripts.qualify._grok_session", stop_before_cli)
    environment = default_compose_qualification_environment()
    evidence = launch_gateway_sessions(environment, tmp_path)
    assert "g1_attempt_grok_auth_method:xai.api_key" in evidence.notes
    assert "g1_attempt_codex:binary_missing" in evidence.notes
    staged_path = tmp_path / "grok" / "config.toml"
    staged = tomllib.loads(staged_path.read_text(encoding="utf-8"))
    assert staged["model"]["esp-grok"]["base_url"] == environment.gateway_xai_base_url
    assert staged["model"]["esp-grok"]["api_key"] == "esp-local-gateway"
    assert "auth.x.ai" not in staged_path.read_text(encoding="utf-8")
    public = environment.model_dump(mode="json")
    public["gateway_xai_base_url"] = "https://api.x.ai:443/v1"
    with pytest.raises(ValidationError):
        ComposeQualificationEnvironment.model_validate(public)


def test_compose_environment_rejects_cluster_fields() -> None:
    base = default_compose_qualification_environment().model_dump(mode="json")
    for extra in (
        {"kube_context": "esp"},
        {"cluster_uid": "00000000-0000-4000-8000-000000000001"},
        {"namespace": "esp-qualification"},
        {"provider_addresses": {"openai": {"ipv4": ["192.0.2.10"], "ipv6": ["2001:db8::10"]}}},
        {"infrastructure": {"fence_mechanism": "csi-controller-unpublish"}},
        {"writer_isolation": {"mechanism": "ssh", "isolate": ["x"], "restore": ["y"]}},
    ):
        with pytest.raises(ValidationError):
            ComposeQualificationEnvironment.model_validate({**base, **extra})
    with pytest.raises(ValidationError):
        QualificationEnvironment.model_validate(base)
