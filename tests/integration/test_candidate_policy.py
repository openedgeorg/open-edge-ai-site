"""Isolated candidate admission and the packaged qualification boundary.

The candidate policy may admit an allowlisted pending runtime and a non-production release on the
isolated deployment's real application path. It must not change public eligibility or any
qualification record. The manifest and image checks below inspect configuration only; enforced
egress denial and storage fencing are proved by the live probes in tests/qualification.
"""

from __future__ import annotations

import copy
import inspect
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from esp_contracts.eligibility import (
    CandidateAdmissionPolicy,
    RuntimeQualificationRecord,
    eligible,
    policy_digest,
    publicly_eligible,
)
from esp_contracts.qualification import RuntimeProfile
from esp_db.client import open_db
from esp_provider_openai.codex_adapter import CODEX_NATIVE_SHA256
from esp_provider_xai.grok_build_adapter import GROK_NATIVE_SHA256
from scripts.migrate import migrate
from scripts.qualify import (
    CANDIDATE_POLICY_SCHEMA_PATH,
    CandidatePolicyInvalid,
    QualificationEnvironment,
    candidate_policy_errors,
    deploy_readiness_findings,
    isolation_findings,
    load_candidate_policy,
    prepare_qualification_manifests,
    render_qualification_manifests,
    runtime_image_findings,
)
from tests.support.database import APP_DSN
from tests.support.policy_lab import (
    CLUSTER_UID,
    PolicyLab,
    policy_document,
    synthetic_profile,
    synthetic_release,
)

ROOT = Path(__file__).resolve().parents[2]
CODEX_DOCKERFILE = ROOT / "infra" / "runtime" / "codex" / "Dockerfile"
GROK_DOCKERFILE = ROOT / "infra" / "runtime" / "grok" / "Dockerfile"
SYNTHETIC_DIGEST = "sha256:" + "1" * 64


@pytest.fixture
async def policy_lab() -> AsyncIterator[PolicyLab]:
    await migrate(APP_DSN)
    db = await open_db(APP_DSN)
    lab = PolicyLab(db, synthetic_profile(), synthetic_release())
    await lab.record_pending_candidate()
    try:
        yield lab
    finally:
        await db.close()


async def test_candidate_policy_does_not_change_public_eligibility(policy_lab: PolicyLab) -> None:
    before = await policy_lab.qualification_record()
    assert policy_lab.isolated_candidate_allowed()
    assert not await policy_lab.same_candidate_publicly_allowed()
    assert await policy_lab.qualification_status() == "pending"
    # Admitting the candidate on the isolated path wrote nothing: the record and the authority view agree.
    assert await policy_lab.qualification_record() == before
    assert await policy_lab.authority_qualification_status() == "pending"


def test_policy_admits_only_exact_allowlisted_runtime_and_content() -> None:
    profile = synthetic_profile()
    release = synthetic_release()
    policy = load_candidate_policy(json.dumps(policy_document(profile, release)).encode())
    assert eligible(profile, release, policy)
    other = "sha256:" + "2" * 64
    for changed in (
        {"image_digest": other},
        {"configuration_digest": other},
        {"tool_policy_digest": other},
        {"transport_digest": other},
        {"storage_profile": "test-only/other-storage"},
        {"harness_build": "codex-cli 0.159.3"},
        {"model": "gpt-other"},
        {"provider": "xai"},
    ):
        assert not eligible(synthetic_profile(**changed), release, policy), changed
    for changed_release in (
        {"canonical_brain_sha256": "f" * 64},
        {"behavior_sha256": "e" * 64},
        {"behavior_version": "qual-draft-a-behavior-2"},
        {"brain_version": "qual-draft-b"},
        {"corpus_release_id": "other-corpus"},
        {"status": "withdrawn"},
    ):
        assert not eligible(profile, synthetic_release(**changed_release), policy), changed_release
    # A reviewed or draft candidate is admissible on the isolated path; that never makes it public.
    assert eligible(profile, synthetic_release(status="reviewed"), policy)


def test_public_eligibility_has_no_policy_input_and_needs_validated_matching_record() -> None:
    assert "policy" not in inspect.signature(publicly_eligible).parameters
    assert not any("public" in name or "bypass" in name for name in CandidateAdmissionPolicy.model_fields)
    profile = synthetic_profile()
    released = synthetic_release(
        status="production", evaluation_ref="test-only-eval", qualification_refs=["test-qual-public"]
    )
    # In-memory only: never written to any database or manifest.
    validated = _record(profile, status="validated")
    assert publicly_eligible(profile, released, validated)
    assert not publicly_eligible(profile, released, _record(profile, status="pending"))
    assert not publicly_eligible(profile, released, None)
    assert not publicly_eligible(profile, synthetic_release(status="reviewed"), validated)
    assert not publicly_eligible(profile, released.model_copy(update={"evaluation_ref": None}), validated)
    assert not publicly_eligible(profile, released.model_copy(update={"qualification_refs": ["other"]}), validated)
    assert not publicly_eligible(synthetic_profile(image_digest=SYNTHETIC_DIGEST), released, validated)
    assert not publicly_eligible(profile, released, validated.model_copy(update={"failed_criteria": ["x"]}))
    assert not publicly_eligible(profile, released, validated.model_copy(update={"reviewed_by": None}))


def test_schema_and_model_agree_on_isolated_policies() -> None:
    profile = synthetic_profile()
    release = synthetic_release()
    valid = policy_document(profile, release)
    assert candidate_policy_errors(valid) == []
    assert load_candidate_policy(json.dumps(valid).encode()).deployment.public_ingress is False
    schema = json.loads(CANDIDATE_POLICY_SCHEMA_PATH.read_text(encoding="utf-8"))
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    invalid: list[dict[str, Any]] = []
    top_level: tuple[tuple[str, object], ...] = (
        ("public_eligible", True),
        ("bypass_public_gate", True),
        ("data_namespace", "esp-production"),
        ("credential_namespace", "production/gateway"),
        ("runtimes", []),
        ("content", []),
        ("recorded_at", "2026-10-03T00:00:00"),
    )
    for key, value in top_level:
        document = copy.deepcopy(valid)
        document[key] = value
        invalid.append(document)
    for key, value in (
        ("public_ingress", True),
        ("environment", "production"),
        ("namespace", "default"),
        ("cluster_uid", "not-a-uid"),
    ):
        document = copy.deepcopy(valid)
        document["deployment"][key] = value
        invalid.append(document)
    unpinned = copy.deepcopy(valid)
    unpinned["runtimes"][0]["image_digest"] = "latest"
    invalid.append(unpinned)
    extra_runtime_field = copy.deepcopy(valid)
    extra_runtime_field["runtimes"][0]["validated"] = True
    invalid.append(extra_runtime_field)
    for document in invalid:
        assert candidate_policy_errors(document), document
        with pytest.raises(CandidatePolicyInvalid):
            load_candidate_policy(json.dumps(document).encode())
    # The digest identifies the exact recorded allowlist used by a qualification run.
    policy = load_candidate_policy(json.dumps(valid).encode())
    assert policy_digest(policy).startswith("sha256:")
    assert policy_digest(policy) == policy_digest(load_candidate_policy(json.dumps(valid, indent=2).encode()))


def test_rendered_qualification_manifests_isolate_candidates() -> None:
    documents = render_qualification_manifests()
    assert isolation_findings(documents) == []
    kinds = {document["kind"] for document in documents}
    assert "Ingress" not in kinds
    assert {document["metadata"].get("namespace") for document in documents if document["kind"] != "Namespace"} <= {
        "esp-qualification",
        None,
    }
    services = [document for document in documents if document["kind"] == "Service"]
    assert services
    assert all(service["spec"].get("type", "ClusterIP") == "ClusterIP" for service in services)
    runtimes = _runtime_pods(documents)
    assert {pod["metadata"]["labels"]["esp.openedge.dev/provider"] for pod in runtimes} == {"openai", "xai"}
    claims = [document for document in documents if document["kind"] == "PersistentVolumeClaim"]
    assert claims
    assert all(claim["spec"]["accessModes"] == ["ReadWriteOncePod"] for claim in claims)


def test_isolation_findings_detect_public_exposure_and_runtime_escapes() -> None:
    base = render_qualification_manifests()

    def mutated(change: Any) -> list[str]:
        documents = copy.deepcopy(base)
        change(documents)
        return isolation_findings(documents)

    def add_ingress(documents: list[dict[str, Any]]) -> None:
        documents.append(
            {
                "apiVersion": "networking.k8s.io/v1",
                "kind": "Ingress",
                "metadata": {"name": "public", "namespace": "esp-qualification"},
                "spec": {},
            }
        )

    def load_balancer(documents: list[dict[str, Any]]) -> None:
        next(d for d in documents if d["kind"] == "Service")["spec"]["type"] = "LoadBalancer"

    def writable_root(documents: list[dict[str, Any]]) -> None:
        _runtime_pods(documents)[0]["spec"]["containers"][0]["securityContext"]["readOnlyRootFilesystem"] = False

    def provider_key(documents: list[dict[str, Any]]) -> None:
        container = _runtime_pods(documents)[0]["spec"]["containers"][0]
        container.setdefault("env", []).append(
            {"name": "OPENAI_API_KEY", "valueFrom": {"secretKeyRef": {"name": "provider", "key": "key"}}}
        )

    def host_network(documents: list[dict[str, Any]]) -> None:
        _runtime_pods(documents)[1]["spec"]["hostNetwork"] = True

    def drop_default_deny(documents: list[dict[str, Any]]) -> None:
        documents[:] = [d for d in documents if not (d["kind"] == "NetworkPolicy" and d["spec"]["podSelector"] == {})]

    def open_runtime_egress(documents: list[dict[str, Any]]) -> None:
        policy = next(
            d
            for d in documents
            if d["kind"] == "NetworkPolicy"
            and d["spec"]["podSelector"].get("matchLabels", {}).get("esp.openedge.dev/role") == "harness-runtime"
            and "Egress" in d["spec"]["policyTypes"]
        )
        policy["spec"]["egress"].append({"to": [{"ipBlock": {"cidr": "0.0.0.0/0"}}]})

    def root_user(documents: list[dict[str, Any]]) -> None:
        _runtime_pods(documents)[0]["spec"]["securityContext"]["runAsUser"] = 0

    def scratch_volume(documents: list[dict[str, Any]]) -> None:
        pod = _runtime_pods(documents)[0]
        pod["spec"]["volumes"].append({"name": "scratch", "emptyDir": {}})
        pod["spec"]["containers"][0]["volumeMounts"].append({"name": "scratch", "mountPath": "/scratch"})

    assert any("public_ingress" in finding for finding in mutated(add_ingress))
    assert any("public_service" in finding for finding in mutated(load_balancer))
    assert any("writable_root" in finding for finding in mutated(writable_root))
    assert any("runtime_secret_env" in finding for finding in mutated(provider_key))
    assert any("host_network" in finding for finding in mutated(host_network))
    assert any("default_deny_missing" in finding for finding in mutated(drop_default_deny))
    assert any("runtime_egress_unrestricted" in finding for finding in mutated(open_runtime_egress))
    assert any("runtime_user" in finding for finding in mutated(root_user))
    assert any("runtime_writable_mount" in finding for finding in mutated(scratch_volume))


def test_runtime_pods_expose_their_uid_as_the_incarnation_identity() -> None:
    for pod in _runtime_pods(render_qualification_manifests()):
        annotations = pod["metadata"].get("annotations") or {}
        # No placeholder incarnation: the lifecycle records the annotation or the pod UID.
        assert "esp.openedge.dev/process-incarnation" not in annotations
        env = {item["name"]: item for item in pod["spec"]["containers"][0]["env"]}
        assert env["ESP_POD_UID"]["valueFrom"] == {"fieldRef": {"fieldPath": "metadata.uid"}}


def test_gateway_egress_excludes_every_reserved_and_translated_range() -> None:
    documents = render_qualification_manifests()
    assert not [finding for finding in isolation_findings(documents) if "reserved_range_open" in finding]

    def reopen(cidr: str) -> list[str]:
        changed = copy.deepcopy(documents)
        policy = next(d for d in changed if d["kind"] == "NetworkPolicy" and d["metadata"]["name"] == "gateway-egress")
        for rule in policy["spec"]["egress"]:
            for peer in rule.get("to", []):
                block = peer.get("ipBlock")
                if block is not None:
                    block["except"] = [item for item in block.get("except", []) if item != cidr]
        return [finding for finding in isolation_findings(changed) if "reserved_range_open" in finding]

    for cidr in ("0.0.0.0/8", "127.0.0.0/8", "10.0.0.0/8", "64:ff9b::/96", "::ffff:0:0/96", "fc00::/7"):
        assert any(cidr in finding for finding in reopen(cidr)), cidr


def test_committed_manifests_need_the_recorded_environment_before_deployment() -> None:
    documents = render_qualification_manifests()
    profile = synthetic_profile(image_digest=SYNTHETIC_DIGEST)
    xai_profile = synthetic_profile(provider="xai", model="esp-configured-xai-model", image_digest="sha256:" + "3" * 64)
    release = synthetic_release()
    document = policy_document(profile, release)
    document["runtimes"].append(
        {
            **document["runtimes"][0],
            "provider": "xai",
            "model": xai_profile.model,
            "image_digest": xai_profile.image_digest,
        }
    )
    policy = load_candidate_policy(json.dumps(document).encode())
    environment = _environment()
    # As committed, images are unpinned and the storage driver is unselected: not deployable.
    raw = deploy_readiness_findings(documents, environment, policy)
    assert any(finding.startswith("image_not_pinned") for finding in raw)
    assert any(finding.startswith("storage_provisioner") for finding in raw)
    prepared = prepare_qualification_manifests(documents, environment)
    assert deploy_readiness_findings(prepared, environment, policy) == []
    assert isolation_findings(prepared) == []
    # A runtime image outside the recorded allowlist is refused even when digest-pinned.
    foreign = _environment(codex_image="registry.test.invalid/esp-codex-runtime@sha256:" + "9" * 64)
    findings = deploy_readiness_findings(prepare_qualification_manifests(documents, foreign), foreign, policy)
    assert any(finding.startswith("runtime_image_not_allowlisted") for finding in findings)


def test_runtime_images_are_pinned_non_root_and_exact_build() -> None:
    codex = CODEX_DOCKERFILE.read_text(encoding="utf-8")
    grok = GROK_DOCKERFILE.read_text(encoding="utf-8")
    assert runtime_image_findings(codex, harness="codex") == []
    assert runtime_image_findings(grok, harness="grok-build") == []
    assert CODEX_NATIVE_SHA256 in codex
    assert GROK_NATIVE_SHA256 in grok
    assert any(f.startswith("base_not_pinned") for f in runtime_image_findings(_unpin(codex), harness="codex"))
    assert any(f.startswith("user") for f in runtime_image_findings(_root_user(codex), harness="codex"))
    assert any(
        f.startswith("harness_digest")
        for f in runtime_image_findings(codex.replace(CODEX_NATIVE_SHA256, "0" * 64), harness="codex")
    )
    assert any(
        f.startswith("secret_in_image")
        for f in runtime_image_findings(codex + "\nENV OPENAI_API_KEY=placeholder\n", harness="codex")
    )
    assert any(
        f.startswith("network_fetch")
        for f in runtime_image_findings(codex + "\nRUN curl -fsSL https://example.invalid/x\n", harness="codex")
    )
    assert any(f.startswith("harness_digest") for f in runtime_image_findings(codex, harness="grok-build"))


def _record(profile: RuntimeProfile, *, status: str) -> RuntimeQualificationRecord:
    return RuntimeQualificationRecord.model_validate(
        {
            "id": "test-qual-public",
            "design_assumption_id": "DA-01",
            "provider": profile.provider,
            "harness_revision": profile.harness_build,
            "image_digest": profile.image_digest,
            "configuration_digest": profile.configuration_digest,
            "transport_digest": profile.transport_digest,
            "storage_profile": profile.storage_profile,
            "tool_policy_digest": profile.tool_policy_digest,
            "status": status,
            "resident_session_limit": 2,
            "active_turn_limit": 2,
            "acceptance_budgets_ref": "test-only-budgets",
            "evidence_bundle_ref": "test-only-evidence",
            "failed_criteria": [],
            "reviewed_by": "test-only-reviewer",
            "reviewed_at": datetime(2026, 10, 3, tzinfo=UTC),
        }
    )


def _runtime_pods(documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        document
        for document in documents
        if document["kind"] == "Pod"
        and document["metadata"].get("labels", {}).get("esp.openedge.dev/role") == "harness-runtime"
    ]


def _environment(codex_image: str | None = None) -> QualificationEnvironment:
    return QualificationEnvironment.model_validate(
        {
            "environment_id": "qual-test-a",
            "disposable": True,
            "kube_context": "esp-qualification-test",
            "cluster_uid": CLUSTER_UID,
            "namespace": "esp-qualification",
            "candidate_policy": "/nonexistent/test-policy.json",
            "images": {
                "esp-codex-runtime": codex_image or "registry.test.invalid/esp-codex-runtime@" + SYNTHETIC_DIGEST,
                "esp-grok-runtime": "registry.test.invalid/esp-grok-runtime@sha256:" + "3" * 64,
                "esp-service": "registry.test.invalid/esp-service@sha256:" + "4" * 64,
                "esp-embeddings": "registry.test.invalid/esp-embeddings@sha256:" + "5" * 64,
            },
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
    )


def _unpin(dockerfile: str) -> str:
    lines: list[str] = []
    for line in dockerfile.splitlines():
        if line.startswith("FROM ") and "@sha256:" in line:
            reference, _, rest = line[len("FROM ") :].partition(" ")
            line = f"FROM {reference.split('@', 1)[0]} {rest}"
        lines.append(line)
    return "\n".join(lines)


def _root_user(dockerfile: str) -> str:
    return "\n".join("USER 0:0" if line.startswith("USER ") else line for line in dockerfile.splitlines())
