"""Recorded Kubernetes API objects behind a scripted `kubectl` runner.

This is a contract double for the fence driver's interpretation of pod, PersistentVolumeClaim (PVC),
PersistentVolume (PV), VolumeAttachment and CSIDriver objects. It is not storage-fencing evidence:
only tests/qualification/test_storage_fence.py against a real disposable cluster provides that.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Sequence
from typing import Any

from esp_provider_shared.kubernetes_fence import INCARNATION_ANNOTATION, KubectlError, KubectlNotFound

CONTEXT = "esp-qualification-test"
NAMESPACE = "esp-qualification"
DRIVER = "csi.test.invalid"


class FakeCluster:
    """Pods, claims, volumes and attachments that evolve the way the kubelet and attacher would."""

    def __init__(self, *, driver: str = DRIVER, attach_required: bool = True) -> None:
        self.calls: list[list[str]] = []
        self.pods: dict[str, dict[str, Any]] = {}
        self.claims: dict[str, dict[str, Any]] = {}
        self.volumes: dict[str, dict[str, Any]] = {}
        self.attachments: dict[str, dict[str, Any]] = {}
        self.csidrivers: dict[str, dict[str, Any]] = {
            driver: {"metadata": {"name": driver, "uid": "csidriver-uid"}, "spec": {"attachRequired": attach_required}}
        }
        self.partitioned_nodes: set[str] = set()
        self.stuck_detach: set[str] = set()
        self.resource_version = 100

    def add_writer(
        self,
        *,
        pod: str,
        unit: str,
        incarnation: str,
        node: str = "node-a",
        attacher: str = DRIVER,
        force_deleted: bool = False,
        annotate: bool = True,
    ) -> None:
        volume = f"pv-{unit}"
        self.claims[unit] = {"metadata": {"name": unit, "uid": f"uid-{unit}"}, "spec": {"volumeName": volume}}
        self.volumes[volume] = {
            "metadata": {"name": volume, "uid": f"uid-{volume}", "resourceVersion": "7"},
            "spec": {"csi": {"driver": attacher, "volumeHandle": f"handle-{unit}"}},
        }
        self.attachments[f"va-{unit}-{node}"] = {
            "metadata": {"name": f"va-{unit}-{node}", "uid": f"uid-va-{unit}"},
            "spec": {"attacher": attacher, "nodeName": node, "source": {"persistentVolumeName": volume}},
            "status": {"attached": True},
        }
        metadata: dict[str, Any] = {"name": pod, "uid": f"uid-{pod}", "resourceVersion": "11"}
        if annotate:
            metadata["annotations"] = {INCARNATION_ANNOTATION: incarnation}
        if force_deleted:
            metadata["deletionTimestamp"] = "2026-10-03T00:00:00Z"
            metadata["deletionGracePeriodSeconds"] = 0
        self.pods[pod] = {
            "metadata": metadata,
            "spec": {
                "nodeName": node,
                "restartPolicy": "Never",
                "volumes": [{"name": "native", "persistentVolumeClaim": {"claimName": unit}}],
                "containers": [{"name": "runtime"}],
            },
            "status": {
                "phase": "Running",
                "containerStatuses": [
                    {"name": "runtime", "containerID": f"containerd://{pod}-1", "state": {"running": {}}}
                ],
            },
        }

    def mutations(self) -> list[list[str]]:
        verbs = {"patch", "delete", "create", "apply", "label", "annotate", "replace", "edit", "scale", "taint"}
        return [call for call in self.calls if any(verb in call for verb in verbs)]

    async def run(self, argv: Sequence[str]) -> str:
        call = list(argv)
        self.calls.append(call)
        if call[:3] != ["kubectl", "--context", CONTEXT] or "--namespace" not in call:
            raise KubectlError("unexpected kubectl prefix")
        args = call[call.index("--namespace") + 2 :]
        args = [arg for arg in args if not arg.startswith("--request-timeout")]
        self._advance()
        verb = args[0]
        if verb == "get":
            return self._get(args[1:])
        if verb == "patch":
            return self._patch(args[1:])
        raise KubectlError(f"verb not supported by the recorded cluster: {verb}")

    def _advance(self) -> None:
        self.resource_version += 1
        for pod in self.pods.values():
            node = pod["spec"]["nodeName"]
            if node in self.partitioned_nodes:
                continue
            if pod["spec"].get("activeDeadlineSeconds") is not None and pod["status"]["phase"] == "Running":
                pod["status"]["phase"] = "Failed"
                pod["status"]["reason"] = "DeadlineExceeded"
                for status in pod["status"]["containerStatuses"]:
                    status["state"] = {"terminated": {"exitCode": 137, "reason": "Error"}}
                pod["metadata"]["resourceVersion"] = str(self.resource_version)
        for name, attachment in list(self.attachments.items()):
            node = attachment["spec"]["nodeName"]
            volume = attachment["spec"]["source"]["persistentVolumeName"]
            if node in self.partitioned_nodes or name in self.stuck_detach:
                continue
            in_use = any(
                pod["spec"]["nodeName"] == node
                and pod["status"]["phase"] not in ("Failed", "Succeeded")
                and f"pv-{_claim(pod)}" == volume
                for pod in self.pods.values()
            )
            if not in_use:
                del self.attachments[name]

    def _get(self, args: list[str]) -> str:
        kind = args[0]
        name = args[1] if len(args) > 1 and not args[1].startswith("-") else None
        collections: dict[str, dict[str, dict[str, Any]]] = {
            "pods": self.pods,
            "pod": self.pods,
            "pvc": self.claims,
            "persistentvolumeclaim": self.claims,
            "pv": self.volumes,
            "persistentvolume": self.volumes,
            "volumeattachments": self.attachments,
            "volumeattachment": self.attachments,
            "csidriver": self.csidrivers,
            "csidrivers": self.csidrivers,
        }
        collection = collections[kind]
        if name is None:
            return json.dumps(
                {
                    "items": [copy.deepcopy(item) for item in collection.values()],
                    "metadata": {"resourceVersion": str(self.resource_version)},
                }
            )
        if name not in collection:
            raise KubectlNotFound(f'{kind} "{name}" not found')
        return json.dumps(copy.deepcopy(collection[name]))

    def _patch(self, args: list[str]) -> str:
        kind, name = args[0], args[1]
        if kind != "pod" or name not in self.pods:
            raise KubectlNotFound(f'{kind} "{name}" not found')
        patch = json.loads(args[args.index("-p") + 1])
        self.pods[name]["spec"].update(patch["spec"])
        return ""


def _claim(pod: dict[str, Any]) -> str:
    for volume in pod["spec"]["volumes"]:
        claim = volume.get("persistentVolumeClaim")
        if claim is not None:
            return str(claim["claimName"])
    return ""
