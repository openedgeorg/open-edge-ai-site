"""Live access to the recorded disposable qualification cluster for tests/qualification.

Every kubectl call names the recorded context and namespace explicitly, and the context/cluster
identity is rechecked before any call. A missing environment or refused context fails the live test
(never a skip), so `scripts/qualify.py` reports the prerequisite pending. Observations are appended to
the run's results file together with a digest of the raw probe output kept beside it.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Literal, cast

import pytest

from esp_contracts.ids import Provider
from scripts.qualify import (
    QUALIFICATION_ENV_VAR,
    QUALIFICATION_PROVIDER_VAR,
    QUALIFICATION_RESULTS_VAR,
    ContextRefused,
    LiveObservation,
    QualificationEnvironment,
    load_qualification_environment,
    observe_kube_context,
    require_disposable_context,
)

Outcome = Literal["satisfied", "violated", "inconclusive"]
Gate = Literal["network", "storage"]
RUNTIME_CONTAINER = "runtime"
RUNTIME_PYTHON = "/opt/esp/venv/bin/python"
RUNTIME_IMAGE_KEYS: dict[Provider, str] = {"openai": "esp-codex-runtime", "xai": "esp-grok-runtime"}


class QualificationCluster:
    def __init__(self, environment: QualificationEnvironment, provider: Provider, results: Path, kubectl: str) -> None:
        self.environment = environment
        self.provider: Provider = provider
        self.results = results
        self.raw_dir = results.parent / "raw"
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        self._kubectl = kubectl

    @classmethod
    def connect(cls) -> QualificationCluster:
        if not os.environ.get(QUALIFICATION_ENV_VAR):
            pytest.fail(f"{QUALIFICATION_ENV_VAR} is not set; run through scripts/qualify.py")
        environment = load_qualification_environment(os.environ)
        if environment is None:
            pytest.fail("qualification environment unavailable")
        try:
            require_disposable_context(environment, observe_kube_context(environment))
        except ContextRefused as exc:
            pytest.fail(f"kube context refused: {exc.code}")
        provider = os.environ.get(QUALIFICATION_PROVIDER_VAR)
        if provider not in ("openai", "xai"):
            pytest.fail(f"{QUALIFICATION_PROVIDER_VAR} must name openai or xai")
        results = os.environ.get(QUALIFICATION_RESULTS_VAR)
        if not results:
            pytest.fail(f"{QUALIFICATION_RESULTS_VAR} is not set; run through scripts/qualify.py")
        kubectl = shutil.which("kubectl")
        if kubectl is None:
            pytest.fail("kubectl unavailable")
        return cls(environment, provider, Path(results), kubectl)

    def kubectl(
        self, *args: str, stdin: str | None = None, timeout: float = 60.0, check: bool = True
    ) -> subprocess.CompletedProcess[str]:
        argv = [
            self._kubectl,
            "--context",
            self.environment.kube_context,
            "--namespace",
            self.environment.namespace,
            *args,
        ]
        completed = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=timeout, check=False)
        if check and completed.returncode != 0:
            pytest.fail(f"kubectl {' '.join(args[:3])} failed: {completed.stderr.strip()[:400]}")
        return completed

    def kubectl_json(self, *args: str) -> dict[str, Any]:
        return cast(dict[str, Any], json.loads(self.kubectl(*args, "-o", "json").stdout))

    def runtime_pod(self) -> dict[str, Any]:
        selector = f"esp.openedge.dev/role=harness-runtime,esp.openedge.dev/provider={self.provider}"
        pods = self.kubectl_json("get", "pods", "-l", selector)["items"]
        running = [pod for pod in pods if pod.get("status", {}).get("phase") == "Running"]
        if len(running) != 1:
            pytest.fail(f"expected one running {self.provider} runtime pod, found {len(running)}")
        return cast(dict[str, Any], running[0])

    @staticmethod
    def container_image(pod: dict[str, Any], container: str = RUNTIME_CONTAINER) -> str:
        for item in pod["spec"]["containers"]:
            if item["name"] == container:
                image = str(item["image"])
                if "@sha256:" not in image:
                    pytest.fail("runtime image is not digest-pinned")
                return image
        pytest.fail(f"container {container} not found")

    def exec_python(self, pod: str, code: str, *args: str, timeout: float = 60.0) -> subprocess.CompletedProcess[str]:
        return self.kubectl(
            "exec", pod, "-c", RUNTIME_CONTAINER, "--", RUNTIME_PYTHON, "-c", code, *args, timeout=timeout, check=False
        )

    def ephemeral_python(self, pod: dict[str, Any], code: str, *args: str, timeout: float = 180.0) -> str:
        """Run a probe in the runtime pod's own network namespace through an ephemeral container."""
        name = str(pod["metadata"]["name"])
        container = f"esp-probe-{uuid.uuid4().hex[:8]}"
        self.kubectl(
            "debug",
            f"pod/{name}",
            f"--image={self.container_image(pod)}",
            f"--target={RUNTIME_CONTAINER}",
            "--profile=restricted",
            f"--container={container}",
            "--quiet",
            "--",
            RUNTIME_PYTHON,
            "-c",
            code,
            *args,
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            current = self.kubectl_json("get", "pod", name)
            for status in current.get("status", {}).get("ephemeralContainerStatuses", []):
                if status.get("name") == container and "terminated" in status.get("state", {}):
                    return self.kubectl("logs", name, "-c", container).stdout
            time.sleep(2.0)
        pytest.fail(f"ephemeral probe {container} did not finish")

    def keep_raw(self, label: str, raw: str) -> str:
        digest = hashlib.sha256(raw.encode()).hexdigest()
        (self.raw_dir / f"{label}-{digest[:16]}.txt").write_text(raw, encoding="utf-8")
        return f"qualification://{self.environment.environment_id}/{label}/sha256:{digest}"

    def record(self, gate: Gate, scenario: str, outcome: Outcome, evidence_ref: str, detail: str = "") -> None:
        observation = LiveObservation(
            gate=gate,
            provider=self.provider,
            environment_id=self.environment.environment_id,
            scenario=scenario,
            outcome=outcome,
            evidence_ref=evidence_ref,
            detail=detail[:500],
        )
        with self.results.open("a", encoding="utf-8") as handle:
            handle.write(observation.model_dump_json() + "\n")
