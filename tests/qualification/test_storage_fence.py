"""Live native-writer fencing on the recorded storage driver (run only via scripts/qualify.py).

A real writer process appends `<incarnation> <time>` lines to a file on a ReadWriteOncePod (RWOP)
volume, so the volume itself shows which writer was alive and when.

Cooperative node (`test_replacement_writer_waits_for_a_real_fence_receipt`): an expired owner lease
(a real `coordination.k8s.io` Lease object held by the writer) and a relabelled claim must not yield a
receipt, and without a receipt a replacement must not run. Those verdicts count only while the writer
is demonstrably alive before and after the fence attempt (pod running and a fresh line on the volume);
a writer that died on its own is legitimately fenced, so that case is inconclusive, never a violation.
The positive receipt here comes from the kubelet-confirmed stop plus the driver's detach.

Isolated node (`test_partitioned_writer_is_fenced_only_by_driver_revocation`): the operator's recorded
isolation commands cut the writer's node off (kubelet stopped or node partitioned), so the kubelet
cannot stop the process. The writer's pod is then force-deleted. A fence attempt right after that
must refuse (the vanished pod object is not evidence). The receipt may come only from the qualified
driver's completed detach (ControllerUnpublishVolume, typically after the attach-detach controller's
forced-detach wait); a replacement on another node then writes, the node is restored, and a fresh mount
must show no line from the obsolete writer after its receipt. Without recorded isolation commands the
scenario fails, so the storage prerequisite stays pending.

Every fence decision is retained with its full evidence in the run directory and the receipt names that
retained record. Probe volumes are reclaimed: the probe switches each bound PersistentVolume (PV) to the
Delete reclaim policy before deleting its claim, so no backend volume is left behind.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import time
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from esp_provider_shared.kubernetes_fence import (
    INCARNATION_ANNOTATION,
    DriverIdentity,
    KubectlFenceDriver,
    KubernetesStorageFence,
    WriterEvidence,
)
from esp_provider_shared.storage_fence import FenceEvidenceMissing, FenceReceipt
from scripts.qualify import (
    LiveOutcome,
    force_delete_outcome,
    insufficient_signal_outcome,
    partitioned_writer_outcome,
    replacement_blocked_outcome,
    writer_recently_active,
    writes_after_receipt,
)
from tests.support.qualification_cluster import RUNTIME_IMAGE_KEYS, RUNTIME_PYTHON, QualificationCluster

NATIVE_ROOT = "/var/lib/esp/native"
LEASE_SECONDS = 30  # P §12.2 lease duration; the fence must not treat its expiry as evidence.
COOPERATIVE_DETACH_SECONDS = 360.0
# The attach-detach controller force-detaches from an unreachable node only after its 6-minute
# unmount wait; allow that plus the driver's ControllerUnpublishVolume.
ISOLATED_DETACH_SECONDS = 900.0
FENCE_CLOCK_SKEW_SECONDS = 2.0

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
import json, os, time
path = os.path.join(os.environ["ESP_NATIVE_ROOT"], "writer.log")
with open(path) as handle:
    entries = [line.split() for line in handle if line.strip()]
print(json.dumps({"now": time.time(), "entries": entries}))
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


def _pod(
    name: str, claim: str, incarnation: str, image: str, *, code: str, avoid_node: str | None = None
) -> dict[str, Any]:
    spec: dict[str, Any] = {
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
                "command": [RUNTIME_PYTHON, "-c", code, incarnation],
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
    }
    if avoid_node is not None:
        term = {"matchFields": [{"key": "metadata.name", "operator": "NotIn", "values": [avoid_node]}]}
        spec["affinity"] = {
            "nodeAffinity": {"requiredDuringSchedulingIgnoredDuringExecution": {"nodeSelectorTerms": [term]}}
        }
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "labels": {"esp.openedge.dev/role": "fence-probe"},
            "annotations": {INCARNATION_ANNOTATION: incarnation},
        },
        "spec": spec,
    }


def _expired_lease(name: str, holder: str) -> dict[str, Any]:
    stale = (datetime.now(UTC) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    return {
        "apiVersion": "coordination.k8s.io/v1",
        "kind": "Lease",
        "metadata": {"name": name, "labels": {"esp.openedge.dev/role": "fence-probe"}},
        "spec": {
            "holderIdentity": holder,
            "leaseDurationSeconds": LEASE_SECONDS,
            "acquireTime": stale,
            "renewTime": stale,
        },
    }


class RetainedFenceEvidence:
    """`FenceEvidenceSink` that retains each decision in the run directory under its content digest."""

    def __init__(self, cluster: QualificationCluster, label: str) -> None:
        self.cluster = cluster
        self.label = label

    async def retain(
        self, unit_id: str, incarnation_id: str, evidence: Sequence[WriterEvidence], decision: str
    ) -> str:
        payload = {
            "storage_unit_id": unit_id,
            "obsolete_incarnation_id": incarnation_id,
            "decision": decision,
            "evidence": [item.model_dump(mode="json") for item in evidence],
        }
        return self.cluster.keep_raw(f"fence-{self.label}-{decision}", json.dumps(payload, sort_keys=True))


class FenceProbe:
    def __init__(self, cluster: QualificationCluster, label: str = "probe") -> None:
        self.cluster = cluster
        self.label = label
        infrastructure = cluster.environment.infrastructure
        self.identity = DriverIdentity(
            csi_driver=infrastructure.csi_driver,
            driver_version=infrastructure.csi_driver_version,
            mechanism=infrastructure.fence_mechanism,
        )
        self.image = cluster.environment.images[RUNTIME_IMAGE_KEYS[cluster.provider]]
        suffix = uuid.uuid4().hex[:8]
        self.unit = f"esp-fence-probe-{suffix}"
        self.lease = f"esp-fence-lease-{suffix}"
        self.first = str(uuid.uuid4())
        self.second = str(uuid.uuid4())
        self.pods = {self.first: f"esp-fence-writer-a-{suffix}", self.second: f"esp-fence-writer-b-{suffix}"}
        self.extra_pods: list[str] = []

    def fence(
        self, *, act: bool, label: str, detach_timeout: float = COOPERATIVE_DETACH_SECONDS, stop_timeout: float = 120.0
    ) -> KubernetesStorageFence:
        driver = KubectlFenceDriver(
            identity=self.identity,
            kube_context=self.cluster.environment.kube_context,
            namespace=self.cluster.environment.namespace,
            act=act,
            stop_timeout=stop_timeout,
            detach_timeout=detach_timeout,
        )
        sink = RetainedFenceEvidence(self.cluster, f"{self.label}-{label}")
        return KubernetesStorageFence(driver, qualified_drivers=[self.identity], evidence_sink=sink)

    def attempt(self, fence: KubernetesStorageFence, incarnation: str) -> tuple[FenceReceipt | None, list[str]]:
        try:
            receipt = asyncio.run(fence.fence_previous_writer(self.unit, incarnation))
        except FenceEvidenceMissing:
            receipt = None
        return receipt, [item.kind for item in fence.evidence(self.unit, incarnation)]

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

    def node_of(self, pod: str) -> str:
        completed = self.cluster.kubectl("get", "pod", pod, "-o", "jsonpath={.spec.nodeName}")
        return completed.stdout.strip()

    def read_entries(self, pod: str) -> tuple[float, list[tuple[str, float]]] | None:
        completed = self.cluster.exec_python(pod, READER)
        if completed.returncode != 0:
            return None
        document = json.loads(completed.stdout)
        return float(document["now"]), [(str(item[0]), float(item[1])) for item in document["entries"]]

    def writer_alive(self, pod: str, incarnation: str) -> bool:
        """The pod runs and its writer appended a line moments ago, read on the writer's own node."""
        phase = self.cluster.kubectl("get", "pod", pod, "-o", "jsonpath={.status.phase}", check=False)
        if phase.returncode != 0 or phase.stdout.strip() != "Running":
            return False
        observed = self.read_entries(pod)
        return observed is not None and writer_recently_active(observed[1], incarnation, now=observed[0])

    def read_volume_once(self, timeout: float = 300.0) -> list[tuple[str, float]] | None:
        """A fresh mount of the volume after every writer has gone; returns all entries or None."""
        name = f"esp-fence-reader-{uuid.uuid4().hex[:8]}"
        self.extra_pods.append(name)
        self.create(_pod(name, self.unit, "reader", self.image, code=READER))
        if not self.wait_phase(name, "Succeeded", timeout):
            return None
        logs = self.cluster.kubectl("logs", name, "-c", "runtime", check=False)
        if logs.returncode != 0:
            return None
        document = json.loads(logs.stdout)
        return [(str(item[0]), float(item[1])) for item in document["entries"]]

    def node_ready(self, node: str) -> bool | None:
        completed = self.cluster.kubectl("get", "node", node, "-o", "json", check=False)
        if completed.returncode != 0:
            return None
        for condition in json.loads(completed.stdout).get("status", {}).get("conditions", []):
            if condition.get("type") == "Ready":
                return condition.get("status") == "True"
        return None

    def run_isolation(self, action: str, node: str) -> bool:
        isolation = self.cluster.environment.writer_isolation
        if isolation is None:
            return False
        argv = isolation.command("isolate" if action == "isolate" else "restore", node)
        try:
            completed = subprocess.run(
                argv, capture_output=True, text=True, timeout=isolation.timeout_seconds, check=False
            )
        except (OSError, subprocess.TimeoutExpired):
            return False
        if completed.returncode != 0:
            return False
        want_ready = action != "isolate"
        deadline = time.monotonic() + isolation.timeout_seconds
        while time.monotonic() < deadline:
            if self.node_ready(node) is want_ready:
                return True
            time.sleep(5.0)
        return False

    def cleanup(self) -> None:
        volume = self.cluster.kubectl("get", "pvc", self.unit, "-o", "jsonpath={.spec.volumeName}", check=False)
        volume_name = volume.stdout.strip() if volume.returncode == 0 else ""
        if volume_name:
            # Retain is the deployment's policy; the probe's own volume must not outlive the probe.
            reclaim = json.dumps({"spec": {"persistentVolumeReclaimPolicy": "Delete"}})
            self.cluster.kubectl("patch", "pv", volume_name, "--type=merge", "-p", reclaim, check=False)
        for pod in [*self.pods.values(), *self.extra_pods]:
            self.cluster.kubectl("delete", "pod", pod, "--ignore-not-found", "--wait=true", timeout=180, check=False)
        self.cluster.kubectl("delete", "lease", self.lease, "--ignore-not-found", check=False)
        self.cluster.kubectl("delete", "pvc", self.unit, "--ignore-not-found", "--wait=true", timeout=180, check=False)
        if volume_name:
            self.cluster.kubectl(
                "delete", "pv", volume_name, "--ignore-not-found", "--wait=true", timeout=300, check=False
            )


def _receipt_ref(receipt: FenceReceipt | None) -> str:
    return json.dumps(receipt.model_dump(mode="json") if receipt is not None else None)


def test_replacement_writer_waits_for_a_real_fence_receipt() -> None:
    cluster = QualificationCluster.connect()
    probe = FenceProbe(cluster, "cooperative")
    outcomes: dict[str, LiveOutcome] = {}

    def record(scenario: str, outcome: LiveOutcome, ref: str, detail: str = "") -> None:
        outcomes[scenario] = outcome
        cluster.record("storage", scenario, outcome, ref, detail)

    writer = probe.pods[probe.first]
    try:
        probe.create(_claim(probe.unit, cluster.environment.infrastructure.storage_class))
        probe.create(_pod(writer, probe.unit, probe.first, probe.image, code=WRITER))
        if not probe.wait_phase(writer, "Running", 300):
            pytest.fail("first writer never ran")

        # An owner lease that expired without renewal proves nothing about the process: observe only.
        probe.create(_expired_lease(probe.lease, probe.first))
        before = probe.writer_alive(writer, probe.first)
        receipt, kinds = probe.attempt(probe.fence(act=False, label="lease", detach_timeout=5), probe.first)
        after = probe.writer_alive(writer, probe.first)
        detail = json.dumps({"alive": [before, after], "kinds": kinds})
        lease_receipt = receipt is not None
        outcome = insufficient_signal_outcome(
            receipt_issued=lease_receipt, writer_alive_before=before, writer_alive_after=after
        )
        record("fence_lease_expiry_insufficient", outcome, cluster.keep_raw("fence-lease", detail), detail)

        # Without a receipt the replacement must not run on the same volume while the writer runs.
        before = probe.writer_alive(writer, probe.first)
        probe.create(_pod(probe.pods[probe.second], probe.unit, probe.second, probe.image, code=WRITER))
        replacement_ran = probe.wait_phase(probe.pods[probe.second], "Running", 60)
        cluster.kubectl("delete", "pod", probe.pods[probe.second], "--wait=true", timeout=180)
        after = probe.writer_alive(writer, probe.first)
        detail = json.dumps({"alive": [before, after], "replacement_ran": replacement_ran})
        outcome = replacement_blocked_outcome(
            receipt_issued=lease_receipt,
            replacement_ran=replacement_ran,
            writer_alive_before=before,
            writer_alive_after=after,
        )
        record("fence_replacement_blocked_without_receipt", outcome, cluster.keep_raw("fence-blocked", detail), detail)

        # A relabelled claim is metadata, not revocation.
        cluster.kubectl(
            "label", "pvc", probe.unit, f"esp.openedge.dev/writer-incarnation={probe.second}", "--overwrite"
        )
        before = probe.writer_alive(writer, probe.first)
        receipt, kinds = probe.attempt(probe.fence(act=False, label="label", detach_timeout=5), probe.first)
        after = probe.writer_alive(writer, probe.first)
        detail = json.dumps({"alive": [before, after], "kinds": kinds})
        outcome = insufficient_signal_outcome(
            receipt_issued=receipt is not None, writer_alive_before=before, writer_alive_after=after
        )
        record("fence_volume_label_insufficient", outcome, cluster.keep_raw("fence-label", detail), detail)

        # Positive path on a healthy node: kubelet-confirmed stop, driver detach, acknowledgement.
        receipt, kinds = probe.attempt(probe.fence(act=True, label="positive"), probe.first)
        if receipt is not None:
            record("fence_positive_receipt", "satisfied", receipt.fence_evidence_ref, _receipt_ref(receipt))
        else:
            record("fence_positive_receipt", "inconclusive", cluster.keep_raw("fence-positive", json.dumps(kinds)))
        if receipt is None:
            pytest.fail("no positive fence receipt from the recorded driver")

        replacement = probe.pods[probe.second] + "-r"
        probe.pods[probe.second] = replacement
        probe.create(_pod(replacement, probe.unit, probe.second, probe.image, code=WRITER))
        if not probe.wait_phase(replacement, "Running", 300):
            pytest.fail("replacement writer never ran after the receipt")
        time.sleep(5)
        observed = probe.read_entries(replacement)
        entries = observed[1] if observed is not None else []
        first_replacement = next((index for index, (who, _) in enumerate(entries) if who == probe.second), None)
        late = writes_after_receipt(
            entries, probe.first, receipt_at=receipt.verified_at.timestamp(), skew=FENCE_CLOCK_SKEW_SECONDS
        )
        single: LiveOutcome
        if late or (
            first_replacement is not None and any(who == probe.first for who, _ in entries[first_replacement:])
        ):
            single = "violated"
        elif first_replacement is None:
            single = "inconclusive"
        else:
            single = "satisfied"
        ref = cluster.keep_raw("fence-single-writer", json.dumps(entries[-200:]))
        record("fence_single_writer_after_replacement", single, ref, json.dumps(late[:20]))

        assert outcomes == {scenario: "satisfied" for scenario in outcomes}, outcomes
    finally:
        probe.cleanup()


def test_partitioned_writer_is_fenced_only_by_driver_revocation() -> None:
    cluster = QualificationCluster.connect()
    if cluster.environment.writer_isolation is None:
        pytest.fail("no writer isolation commands are recorded for this environment")
    probe = FenceProbe(cluster, "isolated")
    writer = probe.pods[probe.first]
    node = ""
    isolated = False
    try:
        probe.create(_claim(probe.unit, cluster.environment.infrastructure.storage_class))
        probe.create(_pod(writer, probe.unit, probe.first, probe.image, code=WRITER))
        if not probe.wait_phase(writer, "Running", 300):
            pytest.fail("first writer never ran")
        node = probe.node_of(writer)
        alive = probe.writer_alive(writer, probe.first)
        isolated = alive and probe.run_isolation("isolate", node)

        # The pod object disappears while the process keeps running on the isolated node.
        cluster.kubectl("delete", "pod", writer, "--force", "--grace-period=0", check=False)
        early, early_kinds = probe.attempt(
            probe.fence(act=True, label="force-deleted", detach_timeout=30, stop_timeout=30), probe.first
        )
        receipt = early
        if receipt is None and isolated:
            receipt, _ = probe.attempt(
                probe.fence(act=True, label="driver-revoked", detach_timeout=ISOLATED_DETACH_SECONDS), probe.first
            )

        replacement_wrote = False
        if receipt is not None:
            replacement = probe.pods[probe.second]
            probe.create(_pod(replacement, probe.unit, probe.second, probe.image, code=WRITER, avoid_node=node))
            if probe.wait_phase(replacement, "Running", 300):
                time.sleep(10)
                observed = probe.read_entries(replacement)
                replacement_wrote = observed is not None and any(who == probe.second for who, _ in observed[1])

        # Bring the node back: the old process meets its deleted pod; any write it lands now is visible.
        restored = probe.run_isolation("restore", node) if isolated else True
        if restored:
            time.sleep(30)
        cluster.kubectl("delete", "pod", probe.pods[probe.second], "--ignore-not-found", "--wait=true", timeout=180)
        entries = probe.read_volume_once() if receipt is not None else None
        late = (
            writes_after_receipt(
                entries, probe.first, receipt_at=receipt.verified_at.timestamp(), skew=FENCE_CLOCK_SKEW_SECONDS
            )
            if receipt is not None and entries is not None
            else []
        )
        detail = json.dumps(
            {
                "node": node,
                "writer_alive_before_isolation": alive,
                "isolated": isolated,
                "restored": restored,
                "early_kinds": early_kinds,
                "receipt": receipt.model_dump(mode="json") if receipt is not None else None,
                "replacement_wrote": replacement_wrote,
                "fresh_mount_read": entries is not None,
                "late_writes": late[:20],
            }
        )
        ref = cluster.keep_raw("fence-isolated", detail)
        forced = force_delete_outcome(
            isolated=isolated, writer_alive_before=alive, early_receipt=early is not None, late_writes=len(late)
        )
        cluster.record("storage", "fence_force_delete_insufficient", forced, ref, detail)
        partitioned = partitioned_writer_outcome(
            isolated=isolated and entries is not None,
            receipt_issued=receipt is not None,
            replacement_wrote=replacement_wrote,
            late_writes=len(late),
        )
        cluster.record("storage", "fence_partitioned_writer_revoked", partitioned, ref, detail)
        assert forced == "satisfied" and partitioned == "satisfied", detail
    finally:
        if isolated and node:
            probe.run_isolation("restore", node)
        probe.cleanup()
