"""Task 13: network/storage prerequisites stay pending without real enforced evidence.

A provider `401` is a reached connection, not a denial. Deployment refuses every context except the
recorded disposable qualification cluster. Nothing here contacts a cluster or a provider: a recorded
`kubectl` stand-in answers context/identity questions and records every invocation.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import stat
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast

import pytest

from esp_contracts.eligibility import CandidateAdmissionPolicy
from esp_provider_shared.runtime_main import forbidden_runtime_material, key_material_report
from esp_provider_shared.runtime_main import main as runtime_main
from scripts.qualify import (
    REQUIRED_NETWORK_SCENARIOS,
    REQUIRED_STORAGE_SCENARIOS,
    TOOL_POLICY_PATH,
    EgressAttempt,
    IsolationGate,
    JunitSummary,
    KeyProbeReport,
    LiveObservation,
    OfferedToolsJudgement,
    QualificationEnvironment,
    classify_egress_attempt,
    classify_qualification,
    direct_egress_outcome,
    dns_internal_only_outcome,
    evaluate_live_evidence,
    forward_proxy_outcome,
    judge_offered_tools,
    key_material_outcomes,
    load_candidate_policy,
    load_tool_policy,
    offered_tools,
    tool_policy_violations,
)
from tests.qualification.test_egress import PROBE as EGRESS_PROBE
from tests.qualification.test_tool_policy import KEY_PROBE
from tests.support.policy_lab import CLUSTER_UID, policy_document, synthetic_profile, synthetic_release

ROOT = Path(__file__).resolve().parents[2]
CONTEXT = "esp-qualification-test"
ALL_PASSED = JunitSummary(tests=4, failures=0, errors=0, skipped=0)


def _attempt(**fields: object) -> EgressAttempt:
    base: dict[str, object] = {
        "scenario": "egress_provider_hostname_denied",
        "target": "api.openai.com:443",
        "resolved": True,
        "tcp_connected": False,
        "tls_established": None,
        "http_status": None,
        "error": None,
    }
    base.update(fields)
    return EgressAttempt.model_validate(base)


def test_a_provider_401_is_a_reached_connection_not_a_denial() -> None:
    assert classify_egress_attempt(_attempt(tcp_connected=True, tls_established=True, http_status=401)) == "reached"
    assert classify_egress_attempt(_attempt(tcp_connected=True)) == "reached"
    assert classify_egress_attempt(_attempt(http_status=403)) == "reached"
    for error in (
        "timeout",
        "host_unreachable",
        "network_unreachable",
        "permission_denied",
        "address_family_unsupported",
        "address_unavailable",
    ):
        assert classify_egress_attempt(_attempt(error=error)) == "denied", error
    assert classify_egress_attempt(_attempt(error="probe_crashed")) == "inconclusive"
    assert classify_egress_attempt(_attempt()) == "inconclusive"


def test_dns_failures_and_resets_are_not_enforced_denials() -> None:
    # A name that does not resolve was never attempted at the IP level (split DNS would pass it).
    assert classify_egress_attempt(_attempt(resolved=False, error="name_unresolved")) == "dns_only"
    # A reset may come from the remote host, which means packets left the cluster.
    for error in ("connection_refused", "connection_reset"):
        assert classify_egress_attempt(_attempt(error=error)) == "inconclusive", error


def test_direct_egress_needs_ip_level_denial_evidence() -> None:
    dns_only = _attempt(resolved=False, error="name_unresolved")
    ip_denied = _attempt(target="192.0.2.10:443", error="timeout")
    assert direct_egress_outcome([dns_only]) == "inconclusive"
    assert direct_egress_outcome([dns_only, ip_denied]) == "satisfied"
    assert direct_egress_outcome([ip_denied, _attempt(tcp_connected=True)]) == "violated"
    assert direct_egress_outcome([ip_denied, _attempt(error="connection_refused")]) == "inconclusive"
    assert direct_egress_outcome([]) == "inconclusive"


def _proxy(**fields: object) -> EgressAttempt:
    base: dict[str, object] = {
        "scenario": "egress_gateway_not_a_forward_proxy",
        "target": "esp-inference-gateway.esp-qualification.svc.cluster.local:8443",
        "tcp_connected": True,
        "request_form": "connect",
    }
    base.update(fields)
    return _attempt(**base)


def test_forward_proxy_refusal_needs_the_runtime_identity_and_an_http_4xx() -> None:
    authenticated = {"tls_established": True, "client_certificate": True}
    connect_403 = _proxy(http_status=403, **authenticated)
    absolute_405 = _proxy(http_status=405, request_form="absolute", **authenticated)
    assert forward_proxy_outcome([connect_403, absolute_405]) == "satisfied"
    # A gateway that requires mTLS refuses the handshake of a caller without an identity; that says
    # nothing about whether it proxies for an authenticated runtime.
    refused_handshake = [_proxy(error="tls_refused"), _proxy(error="tls_refused", request_form="absolute")]
    assert forward_proxy_outcome(refused_handshake) == "inconclusive"
    stalled = [
        _proxy(error="timeout", **authenticated),
        _proxy(error="timeout", request_form="absolute", **authenticated),
    ]
    assert forward_proxy_outcome(stalled) == "inconclusive"
    anonymous = [_proxy(http_status=403, tls_established=True), _proxy(http_status=403, request_form="absolute")]
    assert forward_proxy_outcome(anonymous) == "inconclusive"
    proxy_auth = [_proxy(http_status=407, **authenticated), absolute_405]
    assert forward_proxy_outcome(proxy_auth) == "inconclusive"
    assert forward_proxy_outcome([connect_403]) == "inconclusive"  # both request forms are required
    tunnel = _proxy(http_status=200, **authenticated)
    assert forward_proxy_outcome([tunnel, absolute_405]) == "violated"


def test_internal_only_dns_needs_every_external_name_unresolved() -> None:
    unresolved = _attempt(scenario="egress_runtime_dns_internal_only", resolved=False, error="name_unresolved")
    resolved = _attempt(scenario="egress_runtime_dns_internal_only", resolved=True)
    assert dns_internal_only_outcome([unresolved, unresolved]) == "satisfied"
    assert dns_internal_only_outcome([unresolved, resolved]) == "inconclusive"
    assert dns_internal_only_outcome([]) == "inconclusive"


_NO_IPV6_DRIVER = r"""
import errno, os, socket
_real = socket.socket
class _NoIPv6(_real):
    def __init__(self, family=-1, *args, **kwargs):
        if family == socket.AF_INET6:
            raise OSError(errno.EAFNOSUPPORT, "Address family not supported by protocol")
        super().__init__(family, *args, **kwargs)
socket.socket = _NoIPv6
exec(compile(os.environ["ESP_TEST_PROBE"], "<egress-probe>", "exec"), {"__name__": "__main__"})
"""


def _run_egress_probe(targets: list[dict[str, object]], tmp_path: Path) -> list[dict[str, Any]]:
    completed = subprocess.run(
        [sys.executable, "-c", _NO_IPV6_DRIVER, json.dumps(targets)],
        env={**os.environ, "ESP_TEST_PROBE": EGRESS_PROBE, "ESP_CONTROL_TLS_DIR": str(tmp_path / "no-identity")},
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    return [json.loads(line) for line in completed.stdout.splitlines() if line.startswith("{")]


def _closed_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def test_egress_probe_maps_socket_failures_and_keeps_probing(tmp_path: Path) -> None:
    port = _closed_port()
    targets: list[dict[str, object]] = [
        {"scenario": "egress_provider_ipv6_denied", "host": "2001:db8::10", "port": 443, "family": "ipv6"},
        {
            "scenario": "egress_alternate_model_endpoints_denied",
            "host": "esp-probe-unresolvable.invalid",
            "port": port,
            "fallback_addresses": ["127.0.0.1"],
        },
        {
            "scenario": "egress_gateway_not_a_forward_proxy",
            "host": "127.0.0.1",
            "port": port,
            "tls": True,
            "client_identity": True,
            "request_form": "connect",
            "request": "CONNECT api.openai.com:443 HTTP/1.1\r\n\r\n",
        },
        {"scenario": "egress_internal_dns_resolved", "host": "localhost", "port": port, "resolve_only": True},
    ]
    observed = [EgressAttempt.model_validate(item) for item in _run_egress_probe(targets, tmp_path)]
    assert [item.scenario for item in observed] == [
        "egress_provider_ipv6_denied",
        "egress_alternate_model_endpoints_denied",
        "egress_alternate_model_endpoints_denied",
        "egress_gateway_not_a_forward_proxy",
        "egress_internal_dns_resolved",
    ]
    # An IPv6-less pod is a named outcome, not a crash that drops every later target.
    assert observed[0].error == "address_family_unsupported"
    # An unresolved name is followed by an IP-level attempt on the externally observed address.
    assert observed[1].error == "name_unresolved" and not observed[1].resolved
    assert observed[2].target == f"127.0.0.1:{port}" and observed[2].error == "connection_refused"
    # Without the runtime's mTLS identity the proxy probe does not even try.
    assert observed[3].error == "client_identity_unavailable" and not observed[3].tcp_connected
    assert observed[4].resolved


def _environment(**overrides: object) -> QualificationEnvironment:
    document: dict[str, Any] = {
        "environment_id": "qual-test-a",
        "disposable": True,
        "kube_context": CONTEXT,
        "cluster_uid": CLUSTER_UID,
        "namespace": "esp-qualification",
        "candidate_policy": "/nonexistent/policy.json",
        "images": {},
        "infrastructure": {
            "kubernetes_version": "test-only",
            "cni": "test-only-cni 0.0",
            "storage_class": "esp-qualification-native-rwop",
            "csi_driver": "csi.test.invalid",
            "csi_driver_version": "0.0.0-test",
            "fence_mechanism": "csi-controller-unpublish",
        },
        "provider_addresses": {
            "openai": {"ipv4": ["192.0.2.10"], "ipv6": ["2001:db8::10"]},
            "xai": {"ipv4": ["192.0.2.20"], "ipv6": ["2001:db8::20"]},
        },
        "evidence_export_dir": None,
    }
    document.update(overrides)
    return QualificationEnvironment.model_validate(document)


def _observations(gate: str, scenarios: tuple[str, ...], **override: str) -> list[LiveObservation]:
    return [
        LiveObservation.model_validate(
            {
                "gate": gate,
                "provider": "openai",
                "environment_id": "qual-test-a",
                "scenario": scenario,
                "outcome": override.get(scenario, "satisfied"),
                "evidence_ref": f"test-only://{scenario}",
            }
        )
        for scenario in scenarios
    ]


def _policy() -> CandidateAdmissionPolicy:
    return load_candidate_policy(json.dumps(policy_document(synthetic_profile(), synthetic_release())).encode())


@pytest.mark.parametrize(
    ("gate", "required"), [("network", REQUIRED_NETWORK_SCENARIOS), ("storage", REQUIRED_STORAGE_SCENARIOS)]
)
def test_complete_live_evidence_is_a_functional_pass_that_stays_pending(gate: str, required: tuple[str, ...]) -> None:
    environment = _environment()
    report = evaluate_live_evidence(
        cast(IsolationGate, gate), "openai", _observations(gate, required), ALL_PASSED, environment, _policy()
    )
    assert report.functional_subgate_pass
    assert report.status == "pending"
    assert classify_qualification(report) == "pending"
    assert set(report.scenario_ids) == set(required)
    assert report.positive_observation_count == len(required)
    assert report.environment_digest is not None and report.environment_digest.startswith("sha256:")
    assert report.allowlist_digest is not None and report.allowlist_digest.startswith("sha256:")
    if gate == "storage":
        assert report.storage_profile is not None and "csi.test.invalid@0.0.0-test" in report.storage_profile


def test_missing_skipped_inconclusive_or_foreign_evidence_stays_pending() -> None:
    environment = _environment()
    policy = _policy()
    partial = _observations("network", REQUIRED_NETWORK_SCENARIOS[:-1])
    report = evaluate_live_evidence("network", "openai", partial, ALL_PASSED, environment, policy)
    assert not report.functional_subgate_pass and report.status == "pending"
    assert f"{REQUIRED_NETWORK_SCENARIOS[-1]}_missing" in report.failed_criteria
    complete = _observations("network", REQUIRED_NETWORK_SCENARIOS)
    skipped = JunitSummary(tests=4, failures=0, errors=0, skipped=1)
    report = evaluate_live_evidence("network", "openai", complete, skipped, environment, policy)
    assert not report.functional_subgate_pass and report.skipped
    empty_run = JunitSummary(tests=0, failures=0, errors=0, skipped=0)
    assert not evaluate_live_evidence(
        "network", "openai", complete, empty_run, environment, policy
    ).functional_subgate_pass
    inconclusive = _observations("network", REQUIRED_NETWORK_SCENARIOS, egress_provider_ipv6_denied="inconclusive")
    report = evaluate_live_evidence("network", "openai", inconclusive, ALL_PASSED, environment, policy)
    assert not report.functional_subgate_pass
    assert "egress_provider_ipv6_denied_missing" in report.failed_criteria
    other_environment = _environment(environment_id="qual-test-b")
    report = evaluate_live_evidence("network", "openai", complete, ALL_PASSED, other_environment, policy)
    assert not report.functional_subgate_pass and report.positive_observation_count == 0
    report = evaluate_live_evidence("network", "xai", complete, ALL_PASSED, environment, policy)
    assert not report.functional_subgate_pass and report.empty_evidence


def test_a_demonstrated_bypass_invalidates() -> None:
    violated = _observations("network", REQUIRED_NETWORK_SCENARIOS, egress_provider_ipv4_denied="violated")
    report = evaluate_live_evidence("network", "openai", violated, ALL_PASSED, _environment(), _policy())
    assert report.status == "invalidated"
    assert classify_qualification(report) == "invalidated"
    assert "egress_provider_ipv4_denied_violated" in report.failed_criteria
    assert not report.functional_subgate_pass
    second_writer = _observations(
        "storage", REQUIRED_STORAGE_SCENARIOS, fence_single_writer_after_replacement="violated"
    )
    report = evaluate_live_evidence("storage", "openai", second_writer, ALL_PASSED, _environment(), _policy())
    assert report.status == "invalidated"


def test_tool_policy_allows_only_the_six_read_only_knowledge_tools() -> None:
    policy = load_tool_policy()
    assert policy.approved_mcp_tools == [
        "esp.search",
        "esp.get_source",
        "esp.get_claim",
        "esp.get_concept",
        "esp.get_asset",
        "esp.get_current_value",
    ]
    assert set(policy.denied_categories) >= {
        "shell",
        "repository_edit",
        "host_filesystem",
        "unapproved_network",
        "runtime_subagents",
        "background_model_work",
    }
    # G0 observations are carried truthfully: configuration is not enforcement.
    assert policy.status == "configured_not_demonstrated"
    assert all(entry.enforcement == "not_demonstrated" for entry in policy.providers.values())
    assert any("unified_exec" in note for note in policy.providers["openai"].g0_observations)
    assert any("unknown" in note for note in policy.providers["xai"].g0_observations)


def test_pending_candidate_manifests_name_the_current_tool_policy() -> None:
    digest = "sha256:" + hashlib.sha256(TOOL_POLICY_PATH.read_bytes()).hexdigest()
    for provider in ("openai", "xai"):
        candidate = json.loads((ROOT / "docs" / "qualification" / provider / "candidate.json").read_text())
        assert candidate["status"] == "pending"
        assert candidate["tool_policy_digest"] == digest
        assert "enforcement is not demonstrated" in candidate["notes"]
        # Nothing was built or selected, so these stay unrecorded rather than invented.
        assert candidate["runtime_image_digest"] is None
        assert candidate["storage_profile"] is None
        assert candidate["transport_integration_digest"] is None


def test_offered_tools_are_checked_against_the_policy_for_both_wire_shapes() -> None:
    policy = load_tool_policy()
    responses = json.dumps(
        {
            "model": "gpt-6-astra",
            "tools": [
                {"type": "function", "name": "mcp__esp_knowledge__esp_search", "parameters": {}},
                {"type": "function", "name": "mcp__esp_knowledge__esp_get_current_value", "parameters": {}},
            ],
        }
    ).encode()
    assert tool_policy_violations(offered_tools(responses), policy) == []
    chat = json.dumps(
        {"model": "x", "tools": [{"type": "function", "function": {"name": "esp_knowledge__esp.get_source"}}]}
    ).encode()
    assert tool_policy_violations(offered_tools(chat), policy) == []
    hostile = json.dumps(
        {
            "tools": [
                {"type": "function", "name": "exec_command"},
                {"type": "custom", "name": "apply_patch"},
                {"type": "web_search"},
                {"type": "local_shell"},
                {"type": "function", "function": {"name": "run_terminal_command"}},
                {"type": "function", "name": "mcp__other_server__esp_search"},
                "not-an-object",
            ]
        }
    ).encode()
    violations = tool_policy_violations(offered_tools(hostile), policy)
    for expected in (
        "unapproved_tool:exec_command",
        "builtin_tool:custom",
        "builtin_tool:web_search",
        "builtin_tool:local_shell",
        "unapproved_tool:run_terminal_command",
        "unapproved_tool:mcp__other_server__esp_search",
        "malformed_tool_entry",
    ):
        assert any(expected in violation for violation in violations), expected
    assert tool_policy_violations(offered_tools(b"{not json"), policy) == ["request_unparseable"]
    assert tool_policy_violations(offered_tools(b"{}"), policy) == []


# Synthetic, obviously fake credential shapes; none is a real key or token.
_FAKE_PEM = "-----BEGIN PRIVATE KEY-----\nTESTONLYTESTONLY\n-----END PRIVATE KEY-----\n"
_FAKE_CODEX_AUTH = {
    "OPENAI_API_KEY": None,
    "tokens": {
        "id_token": "test-only-id-token-value",
        "access_token": "test-only-access-token-value",
        "refresh_token": "test-only-refresh-token-value",
    },
}


def _native_homes(tmp_path: Path) -> tuple[dict[str, str], Path]:
    native = tmp_path / "native"
    codex_home, grok_home, home = native / "codex", native / "grok", native / "home"
    for directory in (codex_home / "sessions", grok_home, home):
        directory.mkdir(parents=True)
    etc_esp = tmp_path / "etc-esp"
    (etc_esp / "mtls").mkdir(parents=True)
    (etc_esp / "mtls" / "tls.key").write_text(_FAKE_PEM, encoding="utf-8")
    # The staged harness configurations are the negative control: no credential in them.
    (codex_home / "config.toml").write_bytes((ROOT / "infra/runtime/codex/config.toml").read_bytes())
    (grok_home / "config.toml").write_bytes((ROOT / "infra/runtime/grok/config.toml").read_bytes())
    # A transcript that merely mentions credential words (escaped JSON) is not a credential.
    transcript = json.dumps({"text": json.dumps({"access_token": "discussed-in-a-turn-only"})})
    (codex_home / "sessions" / "rollout.jsonl").write_text(transcript + "\n", encoding="utf-8")
    environ = {
        "PATH": "/usr/bin",
        "ESP_NATIVE_ROOT": str(native),
        "CODEX_HOME": str(codex_home),
        "GROK_HOME": str(grok_home),
        "HOME": str(home),
        "ESP_CONTROL_TLS_DIR": str(etc_esp / "mtls"),
    }
    return environ, etc_esp


def test_key_scan_covers_the_native_homes_where_harnesses_keep_credentials(tmp_path: Path) -> None:
    environ, etc_esp = _native_homes(tmp_path)
    clean = key_material_report(environ, fixed_roots=(str(etc_esp),))
    assert clean["files"] == {"provider": [], "signing": []}
    assert clean["environment"] == {"provider": [], "signing": []}
    assert not clean["truncated"] and clean["scanned_files"] == 3  # the allowed mTLS key is skipped
    codex_home, grok_home, home = Path(environ["CODEX_HOME"]), Path(environ["GROK_HOME"]), Path(environ["HOME"])
    (codex_home / "auth.json").write_text(json.dumps(_FAKE_CODEX_AUTH), encoding="utf-8")
    (grok_home / "credentials.json").write_text(json.dumps({"api_key": "test-only-xai-key-value"}), encoding="utf-8")
    (home / ".env").write_text("XAI_API_KEY=test-only-xai-key-value\n", encoding="utf-8")
    (etc_esp / "signing").mkdir()
    (etc_esp / "signing" / "key.pem").write_text(_FAKE_PEM, encoding="utf-8")
    found = key_material_report(environ, fixed_roots=(str(etc_esp),))
    assert sorted(found["files"]["provider"]) == sorted(
        [str(codex_home / "auth.json"), str(grok_home / "credentials.json"), str(home / ".env")]
    )
    # The control identity's own key is allowed; any other private key is signing material.
    assert found["files"]["signing"] == [str(etc_esp / "signing" / "key.pem")]


def test_key_scan_bounds_its_work_and_reports_truncation(tmp_path: Path) -> None:
    environ, etc_esp = _native_homes(tmp_path)
    report = key_material_report(environ, fixed_roots=(str(etc_esp),), max_files=2)
    assert report["truncated"]


def test_provider_and_signing_key_findings_are_classified_separately(tmp_path: Path) -> None:
    environ, etc_esp = _native_homes(tmp_path)
    (Path(environ["CODEX_HOME"]) / "auth.json").write_text(json.dumps(_FAKE_CODEX_AUTH), encoding="utf-8")
    report = key_material_report(
        {**environ, "ESP_SIGNING_KEY": "redacted", "OPENAI_API_KEY": "redacted"}, fixed_roots=(str(etc_esp),)
    )
    provider, signing = key_material_outcomes([], report)
    assert provider.outcome == "violated" and signing.outcome == "violated"
    assert any("auth.json" in item for item in provider.findings)
    assert "environment:OPENAI_API_KEY" in provider.findings
    assert signing.findings == ["environment:ESP_SIGNING_KEY"]
    only_provider = key_material_report(environ, fixed_roots=(str(etc_esp),))
    provider, signing = key_material_outcomes([], only_provider)
    assert provider.outcome == "violated" and signing.outcome == "satisfied"
    clean_environ, clean_etc = _native_homes(tmp_path / "clean")
    provider, signing = key_material_outcomes([], key_material_report(clean_environ, fixed_roots=(str(clean_etc),)))
    assert provider.outcome == signing.outcome == "satisfied"
    clean = key_material_report(clean_environ, fixed_roots=(str(clean_etc),))
    provider, _ = key_material_outcomes(["runtime:OPENAI_API_KEY"], clean)
    assert provider.outcome == "violated"
    truncated = key_material_report(clean_environ, fixed_roots=(str(clean_etc),), max_files=1)
    provider, signing = key_material_outcomes([], truncated)
    assert provider.outcome == signing.outcome == "inconclusive"


def test_live_key_probe_runs_the_runtime_images_scan(tmp_path: Path) -> None:
    environ, _ = _native_homes(tmp_path)
    (Path(environ["CODEX_HOME"]) / "auth.json").write_text(json.dumps(_FAKE_CODEX_AUTH), encoding="utf-8")
    completed = subprocess.run(
        [sys.executable, "-c", KEY_PROBE],
        env=environ,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    report = KeyProbeReport.model_validate_json(completed.stdout)
    assert report.files.provider == [str(Path(environ["CODEX_HOME"]) / "auth.json")]
    provider, signing = key_material_outcomes([], report)
    assert provider.outcome == "violated" and signing.outcome == "satisfied"


RUNTIME_IMAGE_DIGEST = "sha256:" + "1" * 64
POD_STARTED = datetime(2026, 10, 3, 12, 0, tzinfo=UTC)
JUDGED_AT = datetime(2026, 10, 3, 13, 0, tzinfo=UTC)
APPROVED_TOOLS: list[dict[str, Any]] = [
    {"type": "function", "name": "mcp__esp_knowledge__esp_search", "parameters": {}},
    {"type": "function", "name": "mcp__esp_knowledge__esp_get_claim", "parameters": {}},
]
APPROVED_REQUEST: dict[str, Any] = {"model": "gpt-6-astra", "tools": APPROVED_TOOLS}


def _export(
    tmp_path: Path,
    bodies: list[tuple[dict[str, Any], datetime]],
    **overrides: object,
) -> Path:
    """A gateway final-request export: bodies plus an index tied to the gateway's evidence proofs."""
    root = tmp_path / "export"
    directory = root / "openai"
    directory.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, object]] = []
    for number, (document, captured) in enumerate(bodies):
        body = json.dumps(document).encode()
        name = f"request-{number}.json"
        (directory / name).write_bytes(body)
        entries.append(
            {
                "inference_id": f"inf_{number:032x}",
                "captured_at": captured.isoformat(),
                "request_sha256": hashlib.sha256(body).hexdigest(),
                "body": name,
                "proof_ref": f"esp-object://evidence/inf_{number:032x}/proof#{'a' * 64}",
            }
        )
    index: dict[str, object] = {
        "export_format": "esp-final-request-export/1",
        "environment_id": "qual-test-a",
        "provider": "openai",
        "runtime_image_digest": RUNTIME_IMAGE_DIGEST,
        "exported_at": JUDGED_AT.isoformat(),
        "requests": entries,
    }
    index.update(overrides)
    (directory / "index.json").write_text(json.dumps(index), encoding="utf-8")
    return root


def _judge(root: Path) -> OfferedToolsJudgement:
    return judge_offered_tools(
        root,
        provider="openai",
        environment_id="qual-test-a",
        runtime_image_digest=RUNTIME_IMAGE_DIGEST,
        not_before=POD_STARTED,
        now=JUDGED_AT,
        policy=load_tool_policy(),
    )


def test_offered_tools_are_judged_only_on_bound_gateway_evidence(tmp_path: Path) -> None:
    during = POD_STARTED + timedelta(minutes=5)
    judged = _judge(_export(tmp_path / "ok", [(APPROVED_REQUEST, during)]))
    assert judged.outcome == "satisfied", judged.reasons
    # Each judged body is identified by its digest and the gateway inference it was captured for.
    body = json.dumps(APPROVED_REQUEST).encode()
    assert [item.sha256 for item in judged.requests] == [hashlib.sha256(body).hexdigest()]
    assert judged.requests[0].inference_id == f"inf_{0:032x}"
    assert judged.requests[0].approved_tools == ["mcp__esp_knowledge__esp_search", "mcp__esp_knowledge__esp_get_claim"]
    hostile: dict[str, Any] = {"tools": [{"type": "function", "name": "exec_command"}, *APPROVED_TOOLS]}
    assert _judge(_export(tmp_path / "bad", [(APPROVED_REQUEST, during), (hostile, during)])).outcome == "violated"


def test_vacuous_stale_foreign_or_unbound_tool_evidence_is_inconclusive(tmp_path: Path) -> None:
    during = POD_STARTED + timedelta(minutes=5)
    # A body offering no tool at all says nothing about the approved tools.
    assert _judge(_export(tmp_path / "empty", [({}, during)])).outcome == "inconclusive"
    assert _judge(_export(tmp_path / "none", [])).outcome == "inconclusive"
    # Captured before this runtime pod started, or claimed for the future.
    stale = POD_STARTED - timedelta(minutes=1)
    assert _judge(_export(tmp_path / "stale", [(APPROVED_REQUEST, stale)])).outcome == "inconclusive"
    future = JUDGED_AT + timedelta(minutes=1)
    assert _judge(_export(tmp_path / "future", [(APPROVED_REQUEST, future)])).outcome == "inconclusive"
    # Another environment's or another image's export.
    foreign = _export(tmp_path / "foreign", [(APPROVED_REQUEST, during)], environment_id="qual-test-b")
    assert _judge(foreign).outcome == "inconclusive"
    other_image = _export(tmp_path / "image", [(APPROVED_REQUEST, during)], runtime_image_digest="sha256:" + "9" * 64)
    assert _judge(other_image).outcome == "inconclusive"
    # A body that is not the request the gateway recorded.
    tampered = _export(tmp_path / "tampered", [(APPROVED_REQUEST, during)])
    (tampered / "openai" / "request-0.json").write_text(json.dumps({"tools": []}), encoding="utf-8")
    assert _judge(tampered).outcome == "inconclusive"
    # Loose hand-placed files without the gateway index are not evidence.
    loose = tmp_path / "loose" / "openai"
    loose.mkdir(parents=True)
    (loose / "request.json").write_text(json.dumps(APPROVED_REQUEST), encoding="utf-8")
    assert _judge(tmp_path / "loose").outcome == "inconclusive"
    # A stale body that shows a violation is not counted against this runtime either.
    hostile = {"tools": [{"type": "function", "name": "exec_command"}]}
    assert _judge(_export(tmp_path / "old-hostile", [(hostile, stale)])).outcome == "inconclusive"


def test_runtime_entry_refuses_provider_and_signing_key_material() -> None:
    assert forbidden_runtime_material({"PATH": "/usr/bin", "HOME": "/var/lib/esp/native/home"}) == []
    found = forbidden_runtime_material(
        {
            "OPENAI_API_KEY": "redacted",
            "XAI_API_KEY": "redacted",
            "ESP_SIGNING_KEY": "redacted",
            "SOMETHING": "sk-proj-abcdefabcdefabcdef",
            "OTHER": "-----BEGIN PRIVATE KEY-----",
        }
    )
    assert set(found) == {"OPENAI_API_KEY", "XAI_API_KEY", "ESP_SIGNING_KEY", "SOMETHING", "OTHER"}
    assert runtime_main(["--harness", "codex"], {"OPENAI_API_KEY": "redacted"}) == 3
    assert runtime_main(["--harness", "codex"], {"PATH": "/usr/bin"}) == 2


def _hermetic_env(tmp_path: Path, **extra: str) -> dict[str, str]:
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path), "KUBECONFIG": str(tmp_path / "missing")}
    env.update(extra)
    return env


def _qualify(args: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "scripts/qualify.py", *args],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )


@pytest.mark.parametrize("gate", ["network", "storage"])
@pytest.mark.parametrize("provider", ["openai", "xai"])
def test_unconfigured_environment_is_pending_and_nonzero(tmp_path: Path, gate: str, provider: str) -> None:
    completed = _qualify([gate, "--provider", provider, "--json"], _hermetic_env(tmp_path))
    assert completed.returncode == 2
    payload = json.loads(completed.stdout)
    assert payload["classification"] == "pending"
    assert payload["status"] == "pending"
    assert payload["functional_subgate_pass"] is False
    assert "qualification_environment_unconfigured" in payload["failed_criteria"]


def _fake_kubectl(tmp_path: Path, *, current_context: str, cluster_uid: str) -> Path:
    """A recorded kubectl stand-in: answers context/identity reads, logs everything, refuses the rest.

    Offline `kustomize` rendering is passed through to the real kubectl; nothing reaches a cluster.
    """
    real = shutil.which("kubectl")
    assert real is not None
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "kubectl.log"
    script = bin_dir / "kubectl"
    script.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        f"log = {str(log)!r}\n"
        "args = sys.argv[1:]\n"
        "with open(log, 'a', encoding='utf-8') as handle:\n"
        "    handle.write(json.dumps(args) + '\\n')\n"
        "if args[:1] == ['kustomize']:\n"
        f"    os.execv({real!r}, [{real!r}, *args])\n"
        "if args[:2] == ['config', 'current-context']:\n"
        f"    print({current_context!r})\n"
        "    sys.exit(0)\n"
        "if 'kube-system' in args and 'namespace' in args:\n"
        f"    print({cluster_uid!r}, end='')\n"
        "    sys.exit(0)\n"
        "if 'apply' in args:\n"
        "    sys.stdin.read()\n"
        "    print('applied (recorded stand-in)')\n"
        "    sys.exit(0)\n"
        "print('recorded stand-in has no cluster', file=sys.stderr)\n"
        "sys.exit(1)\n",
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return bin_dir


def _configured(tmp_path: Path, *, codex_image_digest: str) -> Path:
    profile = synthetic_profile(image_digest="sha256:" + "1" * 64)
    release = synthetic_release()
    document = policy_document(profile, release)
    document["runtimes"].append(
        {
            **document["runtimes"][0],
            "provider": "xai",
            "model": "esp-configured-xai-model",
            "image_digest": "sha256:" + "3" * 64,
        }
    )
    policy_path = tmp_path / "policy.json"
    policy_path.write_text(json.dumps(document), encoding="utf-8")
    environment = _environment(
        candidate_policy=str(policy_path),
        evidence_output_dir=str(tmp_path / "evidence"),
        images={
            "esp-codex-runtime": "registry.test.invalid/esp-codex-runtime@" + codex_image_digest,
            "esp-grok-runtime": "registry.test.invalid/esp-grok-runtime@sha256:" + "3" * 64,
            "esp-service": "registry.test.invalid/esp-service@sha256:" + "4" * 64,
            "esp-embeddings": "registry.test.invalid/esp-embeddings@sha256:" + "5" * 64,
        },
    )
    path = tmp_path / "environment.json"
    path.write_text(environment.model_dump_json(), encoding="utf-8")
    return path


def _logged(tmp_path: Path) -> list[list[str]]:
    log = tmp_path / "kubectl.log"
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]


def test_deploy_refuses_any_other_current_context(tmp_path: Path) -> None:
    environment = _configured(tmp_path, codex_image_digest="sha256:" + "1" * 64)
    bin_dir = _fake_kubectl(tmp_path, current_context="production-admin", cluster_uid=CLUSTER_UID)
    env = _hermetic_env(
        tmp_path, PATH=f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}", ESP_QUALIFICATION_ENV=str(environment)
    )
    completed = _qualify(["network", "--provider", "openai", "--deploy", "--json"], env)
    assert completed.returncode == 2
    payload = json.loads(completed.stdout)
    assert payload["classification"] == "pending"
    assert "kube_context_refused:context_mismatch" in payload["failed_criteria"]
    assert not any("apply" in call for call in _logged(tmp_path))


def test_deploy_refuses_a_matching_context_name_on_another_cluster(tmp_path: Path) -> None:
    environment = _configured(tmp_path, codex_image_digest="sha256:" + "1" * 64)
    bin_dir = _fake_kubectl(tmp_path, current_context=CONTEXT, cluster_uid="00000000-0000-4000-8000-000000000000")
    env = _hermetic_env(
        tmp_path, PATH=f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}", ESP_QUALIFICATION_ENV=str(environment)
    )
    completed = _qualify(["storage", "--provider", "xai", "--deploy", "--json"], env)
    assert completed.returncode == 2
    payload = json.loads(completed.stdout)
    assert "kube_context_refused:cluster_identity_mismatch" in payload["failed_criteria"]
    assert not any("apply" in call for call in _logged(tmp_path))


def test_deploy_refuses_runtime_images_outside_the_recorded_allowlist(tmp_path: Path) -> None:
    environment = _configured(tmp_path, codex_image_digest="sha256:" + "9" * 64)
    bin_dir = _fake_kubectl(tmp_path, current_context=CONTEXT, cluster_uid=CLUSTER_UID)
    env = _hermetic_env(
        tmp_path, PATH=f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}", ESP_QUALIFICATION_ENV=str(environment)
    )
    completed = _qualify(["network", "--provider", "openai", "--deploy", "--json"], env)
    assert completed.returncode == 2
    payload = json.loads(completed.stdout)
    assert "manifests_not_deployable" in payload["failed_criteria"]
    assert any(item.startswith("runtime_image_not_allowlisted") for item in payload["failed_criteria"])
    assert not any("apply" in call for call in _logged(tmp_path))


def test_recorded_context_deploys_explicitly_and_live_probes_without_a_cluster_stay_pending(tmp_path: Path) -> None:
    environment = _configured(tmp_path, codex_image_digest="sha256:" + "1" * 64)
    bin_dir = _fake_kubectl(tmp_path, current_context=CONTEXT, cluster_uid=CLUSTER_UID)
    env = _hermetic_env(
        tmp_path, PATH=f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}", ESP_QUALIFICATION_ENV=str(environment)
    )
    completed = _qualify(["network", "--provider", "openai", "--deploy", "--json"], env)
    assert completed.returncode == 2, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["classification"] == "pending"
    assert payload["functional_subgate_pass"] is False
    assert payload["positive_observation_count"] == 0
    assert "live_probe_run_incomplete" in payload["failed_criteria"]
    assert f"{REQUIRED_NETWORK_SCENARIOS[0]}_missing" in payload["failed_criteria"]
    applies = [call for call in _logged(tmp_path) if "apply" in call]
    assert len(applies) == 1
    assert applies[0][:2] == ["--context", CONTEXT]
    assert "--server-side" in applies[0]
    assert payload["infrastructure"]["csi_driver"] == "csi.test.invalid"
