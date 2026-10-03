"""Live tool-policy enforcement in the actual runtime container (run only via scripts/qualify.py).

Configuration is not enforcement: the G0 inventory showed the Codex build reporting `unified_exec`
enabled despite its configuration, and the Grok Build ignoring unknown keys. These probes therefore
look at what the runtime actually offers and holds: the final requests the gateway captured, the
container's executables and writable paths, its environment and mounted material, and its control
endpoint's refusal of an unauthenticated caller.

Final requests come from `<evidence_export_dir>/<provider>/index.json`, the export of the gateway's
protected evidence (format `esp-final-request-export/1`, see `scripts/qualify.py` FinalRequestExport).
A body counts only when the index binds it to this environment, the running runtime image, a capture
time within the running pod's lifetime and the gateway's recorded request digest.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from scripts.qualify import (
    KeyProbeReport,
    judge_offered_tools,
    key_material_outcomes,
    load_tool_policy,
)
from tests.support.qualification_cluster import RUNTIME_IMAGE_KEYS, QualificationCluster

ROOT_WRITE_PROBE = r"""
import json, os
results = {}
for path in ("/", "/etc", "/opt/esp", "/usr", "/tmp", "/var/tmp"):
    target = os.path.join(path, ".esp-write-probe")
    try:
        with open(target, "w") as handle:
            handle.write("x")
        os.remove(target)
        results[path] = "written"
    except OSError as exc:
        results[path] = "refused:%s" % exc.errno
native = os.path.join(os.environ.get("ESP_NATIVE_ROOT", "/var/lib/esp/native"), ".esp-write-probe")
try:
    with open(native, "w") as handle:
        handle.write("x")
    os.remove(native)
    results["native"] = "written"
except OSError as exc:
    results["native"] = "refused:%s" % exc.errno
print(json.dumps(results))
"""

# The runtime image's own bounded scan: mounted secret roots plus the native volume and the harness
# homes ($CODEX_HOME/auth.json, $GROK_HOME, $HOME), provider and signing material classified apart.
KEY_PROBE = r"""
import json, os
from esp_provider_shared.runtime_main import key_material_report
print(json.dumps(key_material_report(dict(os.environ))))
"""

CONTROL_PROBE = r"""
import json, socket, ssl
out = {"connected": False, "tls": None, "http_status": None, "error": None}
try:
    sock = socket.create_connection(("127.0.0.1", 9443), timeout=5)
    out["connected"] = True
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    tls = context.wrap_socket(sock, server_hostname="localhost")
    out["tls"] = True
    request = b"POST /control/inspect HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n"
    tls.sendall(request + b"Connection: close\r\n\r\n{}")
    head = tls.recv(64).decode("latin-1")
    if head.startswith("HTTP/"):
        out["http_status"] = int(head.split()[1])
except ssl.SSLError:
    out["error"] = "tls_refused"
except OSError as exc:
    out["error"] = "os_error_%s" % exc.errno
print(json.dumps(out))
"""


@pytest.fixture(scope="module")
def cluster() -> QualificationCluster:
    return QualificationCluster.connect()


def test_final_requests_offer_only_the_approved_knowledge_tools(cluster: QualificationCluster) -> None:
    export = cluster.environment.evidence_export_dir
    if export is None:
        pytest.fail("no exported final-request evidence for this run")
    pod = cluster.runtime_pod()
    digest = cluster.container_image(pod).rsplit("@", 1)[1]
    recorded = cluster.environment.images.get(RUNTIME_IMAGE_KEYS[cluster.provider], "")
    if not recorded.endswith("@" + digest):
        pytest.fail("the running runtime image is not the recorded environment's image")
    started = pod.get("status", {}).get("startTime")
    if not started:
        pytest.fail("the runtime pod has no start time")
    judgement = judge_offered_tools(
        Path(export),
        provider=cluster.provider,
        environment_id=cluster.environment.environment_id,
        runtime_image_digest=digest,
        not_before=datetime.fromisoformat(str(started)),
        now=datetime.now(UTC),
        policy=load_tool_policy(),
    )
    # The retained record names every judged body by inference id, gateway proof and SHA-256.
    ref = cluster.keep_raw(f"offered-tools-{cluster.provider}", judgement.model_dump_json())
    cluster.record("network", "tools_offered_only_approved", judgement.outcome, ref, json.dumps(judgement.reasons))
    assert judgement.outcome == "satisfied", judgement.reasons


def test_runtime_container_has_no_shell(cluster: QualificationCluster) -> None:
    pod = str(cluster.runtime_pod()["metadata"]["name"])
    outcomes: dict[str, str] = {}
    for shell in ("/bin/sh", "/bin/bash", "/usr/bin/sh", "/usr/bin/bash", "/bin/dash"):
        completed = cluster.kubectl("exec", pod, "-c", "runtime", "--", shell, "-c", "true", check=False)
        outcomes[shell] = "ran" if completed.returncode == 0 else completed.stderr.strip()[:160]
    ref = cluster.keep_raw(f"shell-{cluster.provider}", json.dumps(outcomes))
    ran = [shell for shell, outcome in outcomes.items() if outcome == "ran"]
    cluster.record(
        "network", "tools_runtime_shell_absent", "violated" if ran else "satisfied", ref, json.dumps(outcomes)
    )
    assert ran == []


def test_runtime_root_is_read_only_and_only_the_native_volume_is_writable(cluster: QualificationCluster) -> None:
    pod = str(cluster.runtime_pod()["metadata"]["name"])
    completed = cluster.exec_python(pod, ROOT_WRITE_PROBE)
    if completed.returncode != 0:
        pytest.fail(f"write probe failed to run: {completed.stderr.strip()[:200]}")
    results: dict[str, str] = json.loads(completed.stdout)
    ref = cluster.keep_raw(f"writable-{cluster.provider}", completed.stdout)
    written = [path for path, outcome in results.items() if path != "native" and outcome == "written"]
    if written:
        cluster.record("network", "tools_runtime_root_read_only", "violated", ref, json.dumps(results))
    elif results.get("native") == "written":
        cluster.record("network", "tools_runtime_root_read_only", "satisfied", ref, json.dumps(results))
    else:
        cluster.record("network", "tools_runtime_root_read_only", "inconclusive", ref, json.dumps(results))
    assert written == [] and results.get("native") == "written"


def test_runtime_holds_no_provider_or_signing_keys(cluster: QualificationCluster) -> None:
    pod = cluster.runtime_pod()
    name = str(pod["metadata"]["name"])
    spec_findings: list[str] = []
    for container in pod["spec"]["containers"]:
        for variable in container.get("env", []):
            if "secretKeyRef" in variable.get("valueFrom", {}):
                spec_findings.append(f"{container['name']}:{variable['name']}")
        for source in container.get("envFrom", []):
            if "secretRef" in source:
                spec_findings.append(f"{container['name']}:envFrom")
    completed = cluster.exec_python(name, KEY_PROBE, timeout=300)
    if completed.returncode != 0:
        pytest.fail(f"key probe failed to run: {completed.stderr.strip()[:200]}")
    report = KeyProbeReport.model_validate_json(completed.stdout)
    ref = cluster.keep_raw(
        f"keys-{cluster.provider}", json.dumps({"spec": spec_findings, "probe": report.model_dump(mode="json")})
    )
    provider, signing = key_material_outcomes(spec_findings, report)
    for scenario, verdict in (
        ("tools_runtime_provider_keys_absent", provider),
        ("tools_runtime_signing_keys_absent", signing),
    ):
        cluster.record("network", scenario, verdict.outcome, ref, json.dumps(verdict.findings))
    assert provider.outcome == "satisfied" and signing.outcome == "satisfied", (provider, signing)


def test_control_endpoint_refuses_an_unauthenticated_caller(cluster: QualificationCluster) -> None:
    pod = str(cluster.runtime_pod()["metadata"]["name"])
    completed = cluster.exec_python(pod, CONTROL_PROBE)
    if completed.returncode != 0:
        pytest.fail(f"control probe failed to run: {completed.stderr.strip()[:200]}")
    result = json.loads(completed.stdout)
    ref = cluster.keep_raw(f"control-{cluster.provider}", completed.stdout)
    status = result["http_status"]
    if status is not None and 200 <= status < 300:
        outcome = "violated"
    elif result["connected"] and (result["error"] == "tls_refused" or status in (401, 403)):
        outcome = "satisfied"
    else:
        outcome = "inconclusive"
    cluster.record("network", "control_anonymous_refused", outcome, ref, completed.stdout)
    assert outcome == "satisfied"
