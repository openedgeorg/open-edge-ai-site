"""Live native-writer fencing on the recorded storage driver (run only via scripts/qualify.py).

A real writer process appends its incarnation to a file on a ReadWriteOncePod (RWOP) volume. A lease
that is never renewed, a relabelled claim and a force-deleted pod must not yield a fence receipt. Only
the kubelet-confirmed stop plus the CSI driver's completed detach, acknowledged by the fence, lets a
replacement writer attach, and afterwards the volume must show a single writer.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any

import pytest

from esp_provider_shared.kubernetes_fence import (
    INCARNATION_ANNOTATION,
    DriverIdentity,
    KubectlFenceDriver,
    KubernetesStorageFence,
)
from esp_provider_shared.storage_fence import FenceEvidenceMissing, FenceReceipt
from tests.support.qualification_cluster import RUNTIME_PYTHON, Outcome, QualificationCluster

NATIVE_ROOT = "/var/lib/esp/native"
LEASE_SECONDS = 30  # P §12.2 database-clock lease; the fence must not treat its expiry as evidence.

WRITER = r"""
import os, sys, time
path = os.path.join(os.environ["ESP_NATIVE_ROOT"], "writer.log")
while True:
    with open(path, "a") as handle:
        handle.write("%s %.6f\n" % (sys.argv[1], time.time()))
        handle.flush()
        os.fsync(handle.fileno())
    time.sleep(0.5)
"""

READER = r"""
import json, os
path = os.path.join(os.environ["ESP_NATIVE_ROOT"], "writer.log")
with open(path) as handle:
    print(json.dumps([line.split() for line in handle if line.strip()]))
"""


def _claim(name: str, storage_class: str) -> dict[str, Any]:
    return {
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": {"name": name, "labels": {"esp.openedge.dev/role": "fence-probe"}},
        "spec": {
            "accessModes": ["ReadWriteOncePod"],
            "storageClassName": storage_class,
            "resources": {"requests": {"storage": "1Gi"}},
        },
    }


def _writer(name: str, claim: str, incarnation: str, image: str) -> dict[str, Any]:
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "labels": {"esp.openedge.dev/role": "fence-probe"},
            "annotations": {INCARNATION_ANNOTATION: incarnation},
        },
        "spec": {
            "restartPolicy": "Never",
            "automountServiceAccountToken": False,
            "enableServiceLinks": False,
            "securityContext": {
                "runAsNonRoot": True,
                "runAsUser": 65532,
                "runAsGroup": 65532,
                "fsGroup": 65532,
                "seccompProfile": {"type": "RuntimeDefault"},
            },
            "containers": [
                {
                    "name": "runtime",
                    "image": image,
                    "command": [RUNTIME_PYTHON, "-c", WRITER, incarnation],
                    "env": [{"name": "ESP_NATIVE_ROOT", "value": NATIVE_ROOT}],
                    "securityContext": {
                        "allowPrivilegeEscalation": False,
                        "readOnlyRootFilesystem": True,
                        "capabilities": {"drop": ["ALL"]},
                    },
                    "volumeMounts": [{"name": "native", "mountPath": NATIVE_ROOT}],
                }
            ],
            "volumes": [{"name": "native", "persistentVolumeClaim": {"claimName": claim}}],
        },
    }


class FenceProbe:
    def __init__(self, cluster: QualificationCluster) -> None:
        self.cluster = cluster
        infrastructure = cluster.environment.infrastructure
        self.identity = DriverIdentity(
            csi_driver=infrastructure.csi_driver,
            driver_version=infrastructure.csi_driver_version,
            mechanism=infrastructure.fence_mechanism,
        )
        key = "esp-codex-runtime" if cluster.provider == "openai" else "esp-grok-runtime"
        self.image = cluster.environment.images[key]
        suffix = uuid.uuid4().hex[:8]
        self.unit = f"esp-fence-probe-{suffix}"
        self.first = str(uuid.uuid4())
        self.second = str(uuid.uuid4())
        self.pods = {self.first: f"esp-fence-writer-a-{suffix}", self.second: f"esp-fence-writer-b-{suffix}"}

    def fence(self, *, act: bool, detach_timeout: float = 360.0) -> KubernetesStorageFence:
        driver = KubectlFenceDriver(
            identity=self.identity,
            kube_context=self.cluster.environment.kube_context,
            namespace=self.cluster.environment.namespace,
            act=act,
            detach_timeout=detach_timeout,
        )
        return KubernetesStorageFence(driver, qualified_drivers=[self.identity])

    def create(self, document: dict[str, Any]) -> None:
        self.cluster.kubectl("create", "-f", "-", stdin=json.dumps(document))

    def wait_phase(self, pod: str, phase: str, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            current = self.cluster.kubectl("get", "pod", pod, "-o", "jsonpath={.status.phase}", check=False)
            if current.returncode == 0 and current.stdout.strip() == phase:
                return True
            time.sleep(2.0)
        return False

    def log_entries(self, pod: str) -> list[tuple[str, float]]:
        completed = self.cluster.exec_python(pod, READER)
        if completed.returncode != 0:
            pytest.fail(f"reader failed: {completed.stderr.strip()[:200]}")
        return [(str(item[0]), float(item[1])) for item in json.loads(completed.stdout)]

    def cleanup(self) -> None:
        for pod in self.pods.values():
            self.cluster.kubectl("delete", "pod", pod, "--ignore-not-found", "--wait=true", timeout=180, check=False)
        self.cluster.kubectl("delete", "pvc", self.unit, "--ignore-not-found", "--wait=true", timeout=180, check=False)


def _refused(fence: KubernetesStorageFence, unit: str, incarnation: str) -> tuple[bool, list[str]]:
    try:
        asyncio.run(fence.fence_previous_writer(unit, incarnation))
    except FenceEvidenceMissing:
        return True, [item.kind for item in fence.evidence(unit, incarnation)]
    return False, [item.kind for item in fence.evidence(unit, incarnation)]


def test_replacement_writer_waits_for_a_real_fence_receipt() -> None:
    cluster = QualificationCluster.connect()
    probe = FenceProbe(cluster)
    outcomes: dict[str, str] = {}

    def record(scenario: str, outcome: Outcome, ref: str, detail: str = "") -> None:
        outcomes[scenario] = outcome
        cluster.record("storage", scenario, outcome, ref, detail)

    try:
        probe.create(_claim(probe.unit, cluster.environment.infrastructure.storage_class))
        probe.create(_writer(probe.pods[probe.first], probe.unit, probe.first, probe.image))
        if not probe.wait_phase(probe.pods[probe.first], "Running", 300):
            pytest.fail("first writer never ran")

        # An owner lease that is never renewed proves nothing about the process: observe only.
        time.sleep(LEASE_SECONDS + 5)
        refused, kinds = _refused(probe.fence(act=False, detach_timeout=5), probe.unit, probe.first)
        ref = cluster.keep_raw("fence-lease", json.dumps(kinds))
        record("fence_lease_expiry_insufficient", "satisfied" if refused else "violated", ref, json.dumps(kinds))

        # Without a receipt the replacement must not run on the same volume.
        probe.create(_writer(probe.pods[probe.second], probe.unit, probe.second, probe.image))
        replacement_ran = probe.wait_phase(probe.pods[probe.second], "Running", 60)
        cluster.kubectl("delete", "pod", probe.pods[probe.second], "--wait=true", timeout=180)
        blocked = refused and not replacement_ran
        ref = cluster.keep_raw("fence-blocked", json.dumps({"refused": refused, "replacement_ran": replacement_ran}))
        record("fence_replacement_blocked_without_receipt", "satisfied" if blocked else "violated", ref)

        # A relabelled claim is metadata, not revocation.
        cluster.kubectl(
            "label", "pvc", probe.unit, f"esp.openedge.dev/writer-incarnation={probe.second}", "--overwrite"
        )
        refused, kinds = _refused(probe.fence(act=False, detach_timeout=5), probe.unit, probe.first)
        ref = cluster.keep_raw("fence-label", json.dumps(kinds))
        record("fence_volume_label_insufficient", "satisfied" if refused else "violated", ref, json.dumps(kinds))

        # Positive path: kubelet-confirmed stop, driver detach, acknowledgement.
        fence = probe.fence(act=True)
        receipt: FenceReceipt | None
        try:
            receipt = asyncio.run(fence.fence_previous_writer(probe.unit, probe.first))
        except FenceEvidenceMissing:
            receipt = None
        evidence = [item.model_dump(mode="json") for item in fence.evidence(probe.unit, probe.first)]
        ref = cluster.keep_raw(
            "fence-positive", json.dumps({"receipt": receipt and receipt.model_dump(mode="json"), "evidence": evidence})
        )
        record("fence_positive_receipt", "satisfied" if receipt else "inconclusive", ref)
        if receipt is None:
            pytest.fail("no positive fence receipt from the recorded driver")

        probe.pods[probe.second] = probe.pods[probe.second] + "-r"
        probe.create(_writer(probe.pods[probe.second], probe.unit, probe.second, probe.image))
        if not probe.wait_phase(probe.pods[probe.second], "Running", 300):
            pytest.fail("replacement writer never ran after the receipt")
        time.sleep(5)
        entries = probe.log_entries(probe.pods[probe.second])
        first_replacement = next((index for index, (who, _) in enumerate(entries) if who == probe.second), None)
        single: Outcome
        if first_replacement is None:
            single = "inconclusive"
        elif any(who == probe.first for who, _ in entries[first_replacement:]):
            single = "violated"
        else:
            single = "satisfied"
        ref = cluster.keep_raw("fence-single-writer", json.dumps(entries[-200:]))
        record("fence_single_writer_after_replacement", single, ref)

        # Force deletion is never the basis of a receipt.
        cluster.kubectl("delete", "pod", probe.pods[probe.second], "--force", "--grace-period=0", check=False)
        forced = probe.fence(act=True, detach_timeout=1)
        refused, kinds = _refused(forced, probe.unit, probe.second)
        counted = (not refused) and "process_stopped" in kinds
        ref = cluster.keep_raw("fence-force", json.dumps({"refused": refused, "kinds": kinds}))
        record("fence_force_delete_insufficient", "violated" if counted else "satisfied", ref, json.dumps(kinds))

        assert outcomes == {scenario: "satisfied" for scenario in outcomes}, outcomes
    finally:
        probe.cleanup()
