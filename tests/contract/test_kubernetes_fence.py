"""Kubernetes native-writer fencing: positive driver evidence only, then replacement attach.

Force deletion, an expired lease, a volume label or a missing pod object never become a fence
receipt. These contract tests use recorded API object shapes; the live proof is
tests/qualification/test_storage_fence.py on a real disposable cluster.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

import pytest

from esp_provider_shared.kubernetes_fence import (
    DriverIdentity,
    KubectlFenceDriver,
    KubernetesStorageFence,
    WriterEvidence,
)
from esp_provider_shared.storage_fence import FenceEvidenceMissing, StorageFence
from esp_provider_shared.supervisor import Supervisor
from tests.support.fake_harness import RuntimeLab
from tests.support.fake_kubernetes import CONTEXT, DRIVER, NAMESPACE, FakeCluster

UNIT = "native-codex-0"
OBSOLETE = "11111111-1111-4111-8111-111111111111"
REPLACEMENT = "22222222-2222-4222-8222-222222222222"
QUALIFIED = DriverIdentity(csi_driver=DRIVER, driver_version="0.0.0-test", mechanism="csi-controller-unpublish")
T0 = datetime(2026, 10, 3, 12, 0, tzinfo=UTC)


class ScriptedDriver:
    """Returns prepared observations and records the order the fence asked for them."""

    def __init__(
        self,
        *,
        stop: Sequence[WriterEvidence] = (),
        revoke: Sequence[WriterEvidence] = (),
        ack: Sequence[WriterEvidence] = (),
        identity: DriverIdentity = QUALIFIED,
        fail_stop: bool = False,
    ) -> None:
        self._stop = list(stop)
        self._revoke = list(revoke)
        self._ack = list(ack)
        self._identity = identity
        self._fail_stop = fail_stop
        self.steps: list[str] = []

    @property
    def identity(self) -> DriverIdentity:
        return self._identity

    async def stop_writer(self, unit_id: str, incarnation_id: str) -> Sequence[WriterEvidence]:
        self.steps.append("stop")
        if self._fail_stop:
            raise RuntimeError("api server unreachable")
        return self._stop

    async def revoke_access(self, unit_id: str, incarnation_id: str) -> Sequence[WriterEvidence]:
        self.steps.append("revoke")
        return self._revoke

    async def acknowledge(self, unit_id: str, incarnation_id: str) -> Sequence[WriterEvidence]:
        self.steps.append("ack")
        return self._ack


def _evidence(
    kind: str,
    *,
    at: datetime = T0,
    unit: str = UNIT,
    incarnation: str = OBSOLETE,
    driver: DriverIdentity = QUALIFIED,
) -> WriterEvidence:
    return WriterEvidence.model_validate(
        {
            "storage_unit_id": unit,
            "obsolete_incarnation_id": incarnation,
            "kind": kind,
            "driver": driver.model_dump(),
            "observed_at": at,
            "evidence_ref": f"k8s://test/{kind}/{unit}/{incarnation}",
        }
    )


async def test_positive_revocation_and_ack_yield_a_receipt_in_order() -> None:
    driver = ScriptedDriver(
        stop=[_evidence("process_stopped")],
        revoke=[_evidence("volume_access_revoked", at=T0 + timedelta(seconds=5))],
        ack=[_evidence("fence_acknowledged", at=T0 + timedelta(seconds=6))],
    )
    fence: StorageFence = KubernetesStorageFence(driver, qualified_drivers=[QUALIFIED])
    receipt = await fence.fence_previous_writer(UNIT, OBSOLETE)
    assert driver.steps == ["stop", "revoke", "ack"]
    assert receipt.storage_unit_id == UNIT
    assert receipt.obsolete_incarnation_id == OBSOLETE
    assert receipt.verified_at == T0 + timedelta(seconds=6)
    assert receipt.fence_evidence_ref == f"k8s://test/fence_acknowledged/{UNIT}/{OBSOLETE}"
    assert DRIVER in receipt.infrastructure_mechanism
    assert "0.0.0-test" in receipt.infrastructure_mechanism
    assert "process_stopped" in receipt.infrastructure_mechanism
    assert "volume_access_revoked" in receipt.infrastructure_mechanism


@pytest.mark.parametrize(
    "insufficient",
    ["pod_force_deleted", "lease_expired", "volume_label_changed", "pod_object_absent", "termination_unconfirmed"],
)
async def test_insufficient_signals_never_fence_even_with_an_ack(insufficient: str) -> None:
    driver = ScriptedDriver(
        stop=[_evidence(insufficient)],
        revoke=[_evidence("attachment_present")],
        ack=[_evidence("fence_acknowledged", at=T0 + timedelta(seconds=1))],
    )
    fence = KubernetesStorageFence(driver, qualified_drivers=[QUALIFIED])
    with pytest.raises(FenceEvidenceMissing):
        await fence.fence_previous_writer(UNIT, OBSOLETE)
    kinds = {item.kind for item in fence.evidence(UNIT, OBSOLETE)}
    assert insufficient in kinds


async def test_positive_revocation_without_ack_or_with_stale_ack_is_not_a_fence() -> None:
    no_ack = KubernetesStorageFence(ScriptedDriver(stop=[_evidence("process_stopped")]), qualified_drivers=[QUALIFIED])
    with pytest.raises(FenceEvidenceMissing):
        await no_ack.fence_previous_writer(UNIT, OBSOLETE)
    stale = ScriptedDriver(
        revoke=[_evidence("volume_access_revoked", at=T0 + timedelta(seconds=10))],
        ack=[_evidence("fence_acknowledged", at=T0)],
    )
    with pytest.raises(FenceEvidenceMissing):
        await KubernetesStorageFence(stale, qualified_drivers=[QUALIFIED]).fence_previous_writer(UNIT, OBSOLETE)


async def test_evidence_for_another_writer_or_driver_does_not_count() -> None:
    other_unit = ScriptedDriver(
        stop=[_evidence("process_stopped", unit="native-grok-0")],
        ack=[_evidence("fence_acknowledged", unit="native-grok-0")],
    )
    with pytest.raises(FenceEvidenceMissing):
        await KubernetesStorageFence(other_unit, qualified_drivers=[QUALIFIED]).fence_previous_writer(UNIT, OBSOLETE)
    other_incarnation = ScriptedDriver(
        stop=[_evidence("process_stopped", incarnation=REPLACEMENT)],
        ack=[_evidence("fence_acknowledged", incarnation=REPLACEMENT)],
    )
    with pytest.raises(FenceEvidenceMissing):
        await KubernetesStorageFence(other_incarnation, qualified_drivers=[QUALIFIED]).fence_previous_writer(
            UNIT, OBSOLETE
        )
    unqualified = DriverIdentity(
        csi_driver="other.csi.invalid", driver_version="1", mechanism="csi-controller-unpublish"
    )
    foreign = ScriptedDriver(
        identity=unqualified,
        stop=[_evidence("process_stopped", driver=unqualified)],
        ack=[_evidence("fence_acknowledged", driver=unqualified)],
    )
    fence = KubernetesStorageFence(foreign, qualified_drivers=[QUALIFIED])
    with pytest.raises(FenceEvidenceMissing, match="driver_not_qualified"):
        await fence.fence_previous_writer(UNIT, OBSOLETE)
    assert foreign.steps == []
    with pytest.raises(FenceEvidenceMissing, match="driver_not_qualified"):
        await KubernetesStorageFence(ScriptedDriver(), qualified_drivers=[]).fence_previous_writer(UNIT, OBSOLETE)


async def test_a_failed_stop_step_falls_through_to_driver_revocation() -> None:
    driver = ScriptedDriver(
        fail_stop=True,
        revoke=[_evidence("volume_access_revoked")],
        ack=[_evidence("fence_acknowledged", at=T0 + timedelta(seconds=1))],
    )
    receipt = await KubernetesStorageFence(driver, qualified_drivers=[QUALIFIED]).fence_previous_writer(UNIT, OBSOLETE)
    assert driver.steps == ["stop", "revoke", "ack"]
    assert "process_stopped" not in receipt.infrastructure_mechanism


async def test_supervisor_replacement_waits_for_a_kubernetes_receipt() -> None:
    lab = RuntimeLab()
    try:
        blocked = KubernetesStorageFence(
            ScriptedDriver(stop=[_evidence("pod_force_deleted")], ack=[_evidence("fence_acknowledged")]),
            qualified_drivers=[QUALIFIED],
        )
        supervisor = Supervisor(lab.adapter, blocked, instance_id=lab.instance_id)
        with pytest.raises(FenceEvidenceMissing):
            await supervisor.restart_incarnation(
                storage_unit_id=UNIT, obsolete_incarnation_id=OBSOLETE, replacement_incarnation_id=REPLACEMENT
            )
        assert supervisor.attached_incarnation(UNIT) is None
        fenced = KubernetesStorageFence(
            ScriptedDriver(
                stop=[_evidence("process_stopped")],
                revoke=[_evidence("volume_access_revoked")],
                ack=[_evidence("fence_acknowledged", at=T0 + timedelta(seconds=1))],
            ),
            qualified_drivers=[QUALIFIED],
        )
        supervisor = Supervisor(lab.adapter, fenced, instance_id=lab.instance_id)
        receipt = await supervisor.restart_incarnation(
            storage_unit_id=UNIT, obsolete_incarnation_id=OBSOLETE, replacement_incarnation_id=REPLACEMENT
        )
        assert supervisor.attached_incarnation(UNIT) == REPLACEMENT
        assert receipt.obsolete_incarnation_id == OBSOLETE
    finally:
        await lab.aclose()


def _driver(cluster: FakeCluster, *, act: bool = True, timeout: float = 0.2) -> KubectlFenceDriver:
    return KubectlFenceDriver(
        identity=QUALIFIED,
        kube_context=CONTEXT,
        namespace=NAMESPACE,
        run=cluster.run,
        act=act,
        poll_interval=0.01,
        stop_timeout=timeout,
        detach_timeout=timeout,
    )


async def test_kubectl_driver_stops_through_the_kubelet_and_waits_for_detach() -> None:
    cluster = FakeCluster()
    cluster.add_writer(pod="esp-codex-runtime-0", unit=UNIT, incarnation=OBSOLETE)
    fence = KubernetesStorageFence(_driver(cluster), qualified_drivers=[QUALIFIED])
    receipt = await fence.fence_previous_writer(UNIT, OBSOLETE)
    kinds = [item.kind for item in fence.evidence(UNIT, OBSOLETE)]
    assert kinds == ["process_stopped", "volume_access_revoked", "fence_acknowledged"]
    assert receipt.fence_evidence_ref.startswith("k8s://")
    assert all(call[:3] == ["kubectl", "--context", CONTEXT] for call in cluster.calls)
    # The only mutation is the bounded deadline that makes the kubelet stop the pod's containers.
    mutations = cluster.mutations()
    assert len(mutations) == 1
    assert "patch" in mutations[0] and '{"spec": {"activeDeadlineSeconds": 1}}' in mutations[0]
    flattened = " ".join(" ".join(call) for call in cluster.calls)
    assert "--force" not in flattened
    assert "--grace-period=0" not in flattened
    assert " delete " not in f" {flattened} "


async def test_kubectl_driver_refuses_force_deleted_absent_and_partitioned_writers() -> None:
    forced = FakeCluster()
    forced.add_writer(pod="esp-codex-runtime-0", unit=UNIT, incarnation=OBSOLETE, force_deleted=True)
    forced.stuck_detach.add(f"va-{UNIT}-node-a")
    fence = KubernetesStorageFence(_driver(forced), qualified_drivers=[QUALIFIED])
    with pytest.raises(FenceEvidenceMissing):
        await fence.fence_previous_writer(UNIT, OBSOLETE)
    assert {item.kind for item in fence.evidence(UNIT, OBSOLETE)} >= {"pod_force_deleted", "attachment_present"}
    assert forced.mutations() == []

    absent = FakeCluster()
    absent.add_writer(pod="esp-codex-runtime-0", unit=UNIT, incarnation=OBSOLETE)
    del absent.pods["esp-codex-runtime-0"]
    absent.partitioned_nodes.add("node-a")
    fence = KubernetesStorageFence(_driver(absent), qualified_drivers=[QUALIFIED])
    with pytest.raises(FenceEvidenceMissing):
        await fence.fence_previous_writer(UNIT, OBSOLETE)
    assert {item.kind for item in fence.evidence(UNIT, OBSOLETE)} >= {"pod_object_absent", "attachment_present"}

    partitioned = FakeCluster()
    partitioned.add_writer(pod="esp-codex-runtime-0", unit=UNIT, incarnation=OBSOLETE)
    partitioned.partitioned_nodes.add("node-a")
    fence = KubernetesStorageFence(_driver(partitioned), qualified_drivers=[QUALIFIED])
    with pytest.raises(FenceEvidenceMissing):
        await fence.fence_previous_writer(UNIT, OBSOLETE)
    assert {item.kind for item in fence.evidence(UNIT, OBSOLETE)} >= {"termination_unconfirmed", "attachment_present"}


async def test_kubectl_driver_observe_only_mode_never_stops_the_writer() -> None:
    cluster = FakeCluster()
    cluster.add_writer(pod="esp-codex-runtime-0", unit=UNIT, incarnation=OBSOLETE)
    fence = KubernetesStorageFence(_driver(cluster, act=False), qualified_drivers=[QUALIFIED])
    with pytest.raises(FenceEvidenceMissing):
        await fence.fence_previous_writer(UNIT, OBSOLETE)
    assert cluster.mutations() == []
    assert cluster.pods["esp-codex-runtime-0"]["status"]["phase"] == "Running"


async def test_kubectl_driver_requires_an_attaching_qualified_csi_driver() -> None:
    no_attach = FakeCluster(attach_required=False)
    no_attach.add_writer(pod="esp-codex-runtime-0", unit=UNIT, incarnation=OBSOLETE)
    fence = KubernetesStorageFence(_driver(no_attach), qualified_drivers=[QUALIFIED])
    with pytest.raises(FenceEvidenceMissing):
        await fence.fence_previous_writer(UNIT, OBSOLETE)
    assert "driver_unqualified" in {item.kind for item in fence.evidence(UNIT, OBSOLETE)}

    other_attacher = FakeCluster()
    other_attacher.add_writer(pod="esp-codex-runtime-0", unit=UNIT, incarnation=OBSOLETE, attacher="other.csi.invalid")
    fence = KubernetesStorageFence(_driver(other_attacher), qualified_drivers=[QUALIFIED])
    with pytest.raises(FenceEvidenceMissing):
        await fence.fence_previous_writer(UNIT, OBSOLETE)
    assert "driver_unqualified" in {item.kind for item in fence.evidence(UNIT, OBSOLETE)}


async def test_kubectl_driver_does_not_ack_while_another_writer_mounts_the_unit() -> None:
    cluster = FakeCluster()
    cluster.add_writer(pod="esp-codex-runtime-0", unit=UNIT, incarnation=OBSOLETE)
    cluster.add_writer(pod="esp-codex-runtime-1", unit=UNIT, incarnation=REPLACEMENT, node="node-b")
    fence = KubernetesStorageFence(_driver(cluster), qualified_drivers=[QUALIFIED])
    with pytest.raises(FenceEvidenceMissing):
        await fence.fence_previous_writer(UNIT, OBSOLETE)
    assert "fence_acknowledged" not in {item.kind for item in fence.evidence(UNIT, OBSOLETE)}


def test_kubectl_driver_requires_an_explicit_context() -> None:
    with pytest.raises(ValueError):
        KubectlFenceDriver(identity=QUALIFIED, kube_context="", namespace=NAMESPACE)
    with pytest.raises(ValueError):
        KubectlFenceDriver(identity=QUALIFIED, kube_context=CONTEXT, namespace="")
