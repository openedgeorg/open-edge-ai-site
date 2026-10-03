"""Positive native-writer fencing on Kubernetes through the selected storage driver.

A replacement writer may attach a native storage unit only after the fence has, in order:

1. asked the obsolete writer to stop and observed the node agent (kubelet) report its containers
   terminated, or found that it could not;
2. observed the qualified Container Storage Interface (CSI) driver's completed detach for the
   obsolete node, which the external attacher records only after `ControllerUnpublishVolume`
   succeeds and which revokes that node's access at the storage backend for a qualified driver;
3. acknowledged that the unit is attached nowhere and that no live pod still mounts it.

A receipt needs step 3 plus positive evidence from step 1 or step 2, all from a driver identity the
deployment qualified. Kubernetes object state alone is never that evidence: a force-deleted pod may
still run on a partitioned node, an expired owner lease does not stop a process, a volume label is
metadata and a missing pod object proves nothing. Those observations are recorded and never accepted.

Every decision, receipt or refusal, is handed with its full evidence to a `FenceEvidenceSink`, which
retains it and returns a durable reference. The receipt's `fence_evidence_ref` is that reference, so a
receipt never rests on a Kubernetes object locator that later disappears; evidence that cannot be
retained yields no receipt. The qualification probe retains into its run directory; the protected
evidence store (Task 19) is the production sink.

A writer is the pod that mounts the unit's claim and is identified with the obsolete Process
Incarnation (ProInc) either by the `esp.openedge.dev/process-incarnation` annotation or by its pod
UID. The committed runtime pods carry no incarnation annotation: the lifecycle wiring (Task 17
supervision, Task 21 recovery) records either the annotation it sets or the pod UID it reads
(exposed to the runtime as `ESP_POD_UID`) as the runtime incarnation. Until then a supervisor-generated
id locates no pod, `stop_writer` reports `pod_object_absent`, and the fence fails closed.

`KubectlFenceDriver` is the selected driver binding. It always names its context and namespace,
never force-deletes, never deletes a VolumeAttachment and never taints a node; its only mutation is a
bounded `activeDeadlineSeconds` that makes the kubelet stop the obsolete pod's containers.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable, Iterable, Sequence
from datetime import UTC, datetime
from typing import Any, Literal, NoReturn, Protocol, cast

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from esp_provider_shared.storage_fence import FenceEvidenceMissing, FenceReceipt

INCARNATION_ANNOTATION = "esp.openedge.dev/process-incarnation"

EvidenceKind = Literal[
    # Positive revocation evidence.
    "process_stopped",
    "volume_access_revoked",
    "fence_acknowledged",
    # Observations that never fence a writer.
    "pod_force_deleted",
    "lease_expired",
    "volume_label_changed",
    "pod_object_absent",
    "termination_unconfirmed",
    "attachment_present",
    "driver_unqualified",
]
POSITIVE_REVOCATION: frozenset[str] = frozenset({"process_stopped", "volume_access_revoked"})
ACKNOWLEDGEMENT = "fence_acknowledged"


class DriverIdentity(BaseModel):
    """Exact storage driver identity the deployment qualified for writer revocation."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    csi_driver: str = Field(min_length=1)
    driver_version: str = Field(min_length=1)
    mechanism: Literal["csi-controller-unpublish"]


class WriterEvidence(BaseModel):
    """One driver observation about one obsolete writer of one storage unit."""

    model_config = ConfigDict(extra="forbid")
    storage_unit_id: str = Field(min_length=1)
    obsolete_incarnation_id: str = Field(min_length=1)
    kind: EvidenceKind
    driver: DriverIdentity
    observed_at: AwareDatetime
    evidence_ref: str = Field(min_length=1)
    detail: str = ""


class StorageFenceDriver(Protocol):
    @property
    def identity(self) -> DriverIdentity: ...

    async def stop_writer(self, unit_id: str, incarnation_id: str) -> Sequence[WriterEvidence]: ...

    async def revoke_access(self, unit_id: str, incarnation_id: str) -> Sequence[WriterEvidence]: ...

    async def acknowledge(self, unit_id: str, incarnation_id: str) -> Sequence[WriterEvidence]: ...


class FenceEvidenceSink(Protocol):
    """Retains one fence decision with all of its evidence and returns a durable reference to it."""

    async def retain(
        self, unit_id: str, incarnation_id: str, evidence: Sequence[WriterEvidence], decision: str
    ) -> str: ...


class KubernetesStorageFence:
    """`StorageFence` on Kubernetes: stop, access revoke, acknowledgement, then a retained receipt."""

    def __init__(
        self,
        driver: StorageFenceDriver,
        *,
        qualified_drivers: Iterable[DriverIdentity],
        evidence_sink: FenceEvidenceSink,
    ) -> None:
        self._driver = driver
        self._qualified = frozenset(qualified_drivers)
        self._sink = evidence_sink
        self._evidence: dict[tuple[str, str], tuple[WriterEvidence, ...]] = {}

    def evidence(self, unit_id: str, incarnation_id: str) -> tuple[WriterEvidence, ...]:
        """Every observation of the last attempt, including the insufficient ones."""
        return self._evidence.get((unit_id, incarnation_id), ())

    async def fence_previous_writer(self, unit_id: str, incarnation_id: str) -> FenceReceipt:
        identity = self._driver.identity
        if not unit_id or not incarnation_id:
            raise FenceEvidenceMissing("writer_identity_missing")
        if identity not in self._qualified:
            self._evidence[(unit_id, incarnation_id)] = ()
            await self._refuse(unit_id, incarnation_id, (), "driver_not_qualified")
        collected: list[WriterEvidence] = []
        for step in (self._driver.stop_writer, self._driver.revoke_access, self._driver.acknowledge):
            try:
                observed = await step(unit_id, incarnation_id)
            except Exception:  # A failed step yields no evidence; it never fences.
                continue
            collected.extend(item for item in observed if _belongs(item, unit_id, incarnation_id, identity))
        evidence = tuple(collected)
        self._evidence[(unit_id, incarnation_id)] = evidence
        positives = [item for item in collected if item.kind in POSITIVE_REVOCATION]
        if not positives:
            await self._refuse(unit_id, incarnation_id, evidence, "no_positive_revocation")
        latest = max(item.observed_at for item in positives)
        acknowledgements = [item for item in collected if item.kind == ACKNOWLEDGEMENT and item.observed_at >= latest]
        if not acknowledgements:
            await self._refuse(unit_id, incarnation_id, evidence, "fence_unacknowledged")
        acknowledgement = acknowledgements[-1]
        try:
            reference = await self._sink.retain(unit_id, incarnation_id, evidence, "receipt")
        except Exception as exc:  # Unretained evidence cannot support a receipt.
            raise FenceEvidenceMissing("fence_evidence_unretained") from exc
        kinds = "+".join(sorted({item.kind for item in positives}) + [ACKNOWLEDGEMENT])
        return FenceReceipt(
            storage_unit_id=unit_id,
            obsolete_incarnation_id=incarnation_id,
            infrastructure_mechanism=(
                f"kubernetes/{identity.mechanism}:{identity.csi_driver}@{identity.driver_version}:{kinds}"
            ),
            verified_at=acknowledgement.observed_at,
            fence_evidence_ref=reference,
        )

    async def _refuse(
        self, unit_id: str, incarnation_id: str, evidence: Sequence[WriterEvidence], code: str
    ) -> NoReturn:
        try:
            await self._sink.retain(unit_id, incarnation_id, evidence, code)
        except Exception as exc:  # The refusal stands whether or not it could be retained.
            raise FenceEvidenceMissing(code) from exc
        raise FenceEvidenceMissing(code)


def _belongs(item: WriterEvidence, unit_id: str, incarnation_id: str, identity: DriverIdentity) -> bool:
    return (
        item.storage_unit_id == unit_id and item.obsolete_incarnation_id == incarnation_id and item.driver == identity
    )


class KubectlError(Exception):
    """kubectl failed; no observation can be taken from it."""


class KubectlNotFound(KubectlError):
    """The named object does not exist."""


KubectlRunner = Callable[[Sequence[str]], Awaitable[str]]


async def run_kubectl(argv: Sequence[str], *, timeout: float = 30.0) -> str:
    process = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout)
    except TimeoutError as exc:
        process.kill()
        await process.wait()
        raise KubectlError("kubectl timed out") from exc
    if process.returncode != 0:
        message = stderr.decode(errors="replace").strip()
        if "NotFound" in message or "not found" in message:
            raise KubectlNotFound(message[:300])
        raise KubectlError(message[:300])
    return stdout.decode()


class KubectlFenceDriver:
    """Kubernetes API observations through kubectl, scoped to one explicit context and namespace.

    Writers are located by the claim they mount and the process-incarnation annotation or pod UID;
    location is not proof. With `act=False` the driver only observes and never stops a writer.
    """

    def __init__(
        self,
        *,
        identity: DriverIdentity,
        kube_context: str,
        namespace: str,
        run: KubectlRunner | None = None,
        act: bool = True,
        poll_interval: float = 2.0,
        stop_timeout: float = 120.0,
        detach_timeout: float = 360.0,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if not kube_context:
            raise ValueError("an explicit kube context is required")
        if not namespace:
            raise ValueError("an explicit namespace is required")
        self._identity = identity
        self._context = kube_context
        self._namespace = namespace
        self._run: KubectlRunner = run if run is not None else run_kubectl
        self._act = act
        self._poll = poll_interval
        self._stop_timeout = stop_timeout
        self._detach_timeout = detach_timeout
        self._clock: Callable[[], datetime] = clock if clock is not None else (lambda: datetime.now(UTC))
        self._writer_nodes: dict[tuple[str, str], str] = {}

    @property
    def identity(self) -> DriverIdentity:
        return self._identity

    async def stop_writer(self, unit_id: str, incarnation_id: str) -> Sequence[WriterEvidence]:
        pods = (await self._get("pods"))["items"]
        writers = [pod for pod in pods if _mounts(pod, unit_id) and _is_incarnation(pod, incarnation_id)]
        claim_ref = self._ref(f"persistentvolumeclaims/{unit_id}")
        if not writers:
            return [
                self._evidence("pod_object_absent", unit_id, incarnation_id, claim_ref, "no pod for the incarnation")
            ]
        if len(writers) > 1:
            return [self._evidence("termination_unconfirmed", unit_id, incarnation_id, claim_ref, "several pods")]
        pod = writers[0]
        name = str(pod["metadata"]["name"])
        uid = str(pod["metadata"].get("uid", ""))
        node = str(pod["spec"].get("nodeName") or "")
        if node:
            self._writer_nodes[(unit_id, incarnation_id)] = node
        if _force_deleted(pod):
            return [self._evidence("pod_force_deleted", unit_id, incarnation_id, self._pod_ref(pod), f"node={node}")]
        running = _running_container_ids(pod)
        if self._act and not _terminal(pod):
            patch = json.dumps({"spec": {"activeDeadlineSeconds": 1}})
            await self._kubectl("patch", "pod", name, "--type=merge", "-p", patch)
        deadline = time.monotonic() + self._stop_timeout
        while True:
            try:
                current = await self._get("pod", name)
            except KubectlNotFound:
                return [self._evidence("pod_object_absent", unit_id, incarnation_id, self._pod_ref(pod), "pod removed")]
            if str(current["metadata"].get("uid", "")) != uid:
                return [
                    self._evidence("pod_object_absent", unit_id, incarnation_id, self._pod_ref(pod), "pod replaced")
                ]
            if _force_deleted(current):
                return [self._evidence("pod_force_deleted", unit_id, incarnation_id, self._pod_ref(current), node)]
            if _terminal(current) and _all_terminated(current, running):
                detail = (
                    f"node={node}; phase={current['status'].get('phase')}; reason={current['status'].get('reason')}"
                )
                return [self._evidence("process_stopped", unit_id, incarnation_id, self._pod_ref(current), detail)]
            if time.monotonic() >= deadline:
                return [
                    self._evidence(
                        "termination_unconfirmed", unit_id, incarnation_id, self._pod_ref(current), f"node={node}"
                    )
                ]
            await asyncio.sleep(self._poll)

    async def revoke_access(self, unit_id: str, incarnation_id: str) -> Sequence[WriterEvidence]:
        volume = await self._volume(unit_id)
        if volume is None:
            return []
        unqualified = await self._unqualified_driver(unit_id, incarnation_id, volume)
        if unqualified is not None:
            return [unqualified]
        volume_name = str(volume["metadata"]["name"])
        node = self._writer_nodes.get((unit_id, incarnation_id))
        deadline = time.monotonic() + self._detach_timeout
        while True:
            listing = await self._get("volumeattachments")
            relevant = [
                item
                for item in listing["items"]
                if _attachment_volume(item) == volume_name and (node is None or _attachment_node(item) == node)
            ]
            foreign = [item for item in relevant if item.get("spec", {}).get("attacher") != self._identity.csi_driver]
            if foreign:
                return [
                    self._evidence("driver_unqualified", unit_id, incarnation_id, self._va_ref(volume_name), "attacher")
                ]
            if not relevant:
                version = str(listing.get("metadata", {}).get("resourceVersion", ""))
                ref = self._va_ref(volume_name) + f"&node={node or '*'}&resourceVersion={version}"
                detail = f"no VolumeAttachment for {volume_name} on {node or 'any node'}"
                return [self._evidence("volume_access_revoked", unit_id, incarnation_id, ref, detail)]
            if time.monotonic() >= deadline:
                names = ",".join(str(item["metadata"]["name"]) for item in relevant)
                return [self._evidence("attachment_present", unit_id, incarnation_id, self._va_ref(volume_name), names)]
            await asyncio.sleep(self._poll)

    async def acknowledge(self, unit_id: str, incarnation_id: str) -> Sequence[WriterEvidence]:
        volume = await self._volume(unit_id)
        if volume is None:
            return []
        unqualified = await self._unqualified_driver(unit_id, incarnation_id, volume)
        if unqualified is not None:
            return [unqualified]
        volume_name = str(volume["metadata"]["name"])
        attachments = [
            item for item in (await self._get("volumeattachments"))["items"] if _attachment_volume(item) == volume_name
        ]
        if attachments:
            names = ",".join(str(item["metadata"]["name"]) for item in attachments)
            return [self._evidence("attachment_present", unit_id, incarnation_id, self._va_ref(volume_name), names)]
        live = [pod for pod in (await self._get("pods"))["items"] if _mounts(pod, unit_id) and not _terminal(pod)]
        if live:
            names = ",".join(str(pod["metadata"]["name"]) for pod in live)
            return [self._evidence("termination_unconfirmed", unit_id, incarnation_id, self._ref("pods"), names)]
        metadata = volume["metadata"]
        ref = f"k8s://{self._context}/persistentvolumes/{volume_name}?uid={metadata.get('uid', '')}"
        ref += f"&resourceVersion={metadata.get('resourceVersion', '')}"
        return [self._evidence(ACKNOWLEDGEMENT, unit_id, incarnation_id, ref, "attached nowhere; no live mount")]

    async def _volume(self, unit_id: str) -> dict[str, Any] | None:
        claim = await self._get("pvc", unit_id)
        volume_name = claim.get("spec", {}).get("volumeName")
        if not volume_name:
            return None
        return await self._get("pv", str(volume_name))

    async def _unqualified_driver(
        self, unit_id: str, incarnation_id: str, volume: dict[str, Any]
    ) -> WriterEvidence | None:
        driver_name = volume.get("spec", {}).get("csi", {}).get("driver")
        ref = self._ref(f"csidrivers/{self._identity.csi_driver}")
        if driver_name != self._identity.csi_driver:
            return self._evidence("driver_unqualified", unit_id, incarnation_id, ref, f"volume driver {driver_name}")
        try:
            driver = await self._get("csidriver", self._identity.csi_driver)
        except KubectlNotFound:
            return self._evidence("driver_unqualified", unit_id, incarnation_id, ref, "CSIDriver object missing")
        if driver.get("spec", {}).get("attachRequired") is not True:
            # Without attach/detach there is no ControllerUnpublishVolume to revoke node access.
            return self._evidence("driver_unqualified", unit_id, incarnation_id, ref, "attachRequired is not true")
        return None

    async def _get(self, *args: str) -> dict[str, Any]:
        return cast(dict[str, Any], json.loads(await self._kubectl("get", *args, "-o", "json")))

    async def _kubectl(self, *args: str) -> str:
        argv = ["kubectl", "--context", self._context, "--namespace", self._namespace, "--request-timeout=10s", *args]
        return await self._run(argv)

    def _evidence(self, kind: EvidenceKind, unit_id: str, incarnation_id: str, ref: str, detail: str) -> WriterEvidence:
        return WriterEvidence(
            storage_unit_id=unit_id,
            obsolete_incarnation_id=incarnation_id,
            kind=kind,
            driver=self._identity,
            observed_at=self._clock(),
            evidence_ref=ref,
            detail=detail,
        )

    def _ref(self, path: str) -> str:
        return f"k8s://{self._context}/namespaces/{self._namespace}/{path}"

    def _pod_ref(self, pod: dict[str, Any]) -> str:
        metadata = pod["metadata"]
        version = metadata.get("resourceVersion", "")
        return self._ref(f"pods/{metadata['name']}?uid={metadata.get('uid', '')}&resourceVersion={version}")

    def _va_ref(self, volume_name: str) -> str:
        return f"k8s://{self._context}/volumeattachments?persistentVolume={volume_name}"


def _mounts(pod: dict[str, Any], claim: str) -> bool:
    for volume in pod.get("spec", {}).get("volumes", []):
        source = volume.get("persistentVolumeClaim")
        if source is not None and source.get("claimName") == claim:
            return True
    return False


def _is_incarnation(pod: dict[str, Any], incarnation_id: str) -> bool:
    """The pod is the incarnation by its recorded annotation or by its own UID."""
    metadata = cast(dict[str, Any], pod.get("metadata") or {})
    annotations = cast(dict[str, Any], metadata.get("annotations") or {})
    return incarnation_id in (annotations.get(INCARNATION_ANNOTATION), metadata.get("uid"))


def _force_deleted(pod: dict[str, Any]) -> bool:
    metadata = pod.get("metadata", {})
    return metadata.get("deletionTimestamp") is not None and metadata.get("deletionGracePeriodSeconds") == 0


def _terminal(pod: dict[str, Any]) -> bool:
    return pod.get("status", {}).get("phase") in ("Failed", "Succeeded")


def _running_container_ids(pod: dict[str, Any]) -> dict[str, str]:
    observed: dict[str, str] = {}
    for status in pod.get("status", {}).get("containerStatuses", []):
        container_id = status.get("containerID")
        if container_id:
            observed[str(status["name"])] = str(container_id)
    return observed


def _all_terminated(pod: dict[str, Any], before: dict[str, str]) -> bool:
    """Every container reports a kubelet-recorded termination of the same container instance."""
    statuses = pod.get("status", {}).get("containerStatuses", [])
    names = {str(container["name"]) for container in pod.get("spec", {}).get("containers", [])}
    if not statuses or {str(status["name"]) for status in statuses} != names:
        return False
    for status in statuses:
        if "terminated" not in status.get("state", {}):
            return False
        previous = before.get(str(status["name"]))
        if previous is not None and status.get("containerID") not in (None, previous):
            return False
    return True


def _attachment_volume(item: dict[str, Any]) -> str | None:
    return item.get("spec", {}).get("source", {}).get("persistentVolumeName")


def _attachment_node(item: dict[str, Any]) -> str | None:
    return item.get("spec", {}).get("nodeName")
