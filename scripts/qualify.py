"""Truthful qualification recorder.

Live gates stay pending until real evidence exists. A synthetic fixture cannot
insert a production qualification row.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import ipaddress
import json
import mmap
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import xml.etree.ElementTree as ElementTree
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Protocol, cast

import yaml
from jsonschema import Draft202012Validator
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError, field_validator

from esp_contracts.api import STRICT
from esp_contracts.eligibility import (
    QUALIFICATION_NAMESPACE,
    CandidateAdmissionPolicy,
    policy_digest,
)
from esp_contracts.ids import Provider, UuidStr
from esp_contracts.qualification import (
    REQUIRED_PRIMITIVES,
    CapabilityReport,
    PrimitiveEvidence,
    QualificationResult,
    RuntimeProfile,
)
from esp_provider_openai.codex_adapter import (
    CODEX_CLIENT_NOTIFICATIONS,
    CODEX_METHODS,
    CODEX_MODEL_PROVIDER,
    CODEX_NATIVE_SHA256,
    CODEX_OPT_OUT_NOTIFICATIONS,
    STDIO_READER_LIMIT,
    JsonlFrameTransport,
    codex_build_id,
)
from esp_provider_openai.events import CODEX_EVENT_METHODS
from esp_provider_shared.rpc import NativeRpcClient
from esp_provider_shared.runtime_main import forbidden_runtime_material
from esp_provider_xai.grok_build_adapter import (
    ACP_PROTOCOL_VERSION,
    GROK_CLIENT_NOTIFICATIONS,
    GROK_MCP_SESSION_HEADER,
    GROK_METHODS,
    GROK_NATIVE_SHA256,
    GROK_SESSION_HEADER,
    HOST_IDENTIFYING_META,
    AcpClientGuard,
    GrokStdioTransport,
    acp_initialize_params,
    grok_build_id,
)
from esp_provider_xai.grok_build_adapter import STDIO_READER_LIMIT as GROK_STDIO_READER_LIMIT

REQUIRED_G1_SCENARIOS: tuple[str, ...] = (
    "g1a_shared_main_process",
    "g1a_distinct_private_canaries",
    "g1a_mixed_brain_releases",
    "g1a_mixed_behavior_releases",
    "g1a_interleaved_requests",
    "g1a_interleaved_mcp",
    "g1a_repeated_turns",
    "g1a_multiple_tools",
    "g1a_native_retries",
    "g1a_automatic_compaction",
    "g1a_manual_compaction",
    "g1a_resume",
    "g1a_long_input",
    "g1a_absent_injection",
    "g1a_corrupt_block_rejected",
    "g1a_duplicate_block_rejected",
    "g1a_inert_pasted_markers",
    "g1a_stale_scopes",
    "g1a_disabled_auxiliary",
    "g1a_evidence_equality",
    "g1a_egress_denial",
    "g1b_owned_create",
    "g1b_conversation_saturation",
    "g1b_resident_saturation",
    "g1b_active_saturation",
    "g1b_provider_saturation",
    "g1b_rejected_input_not_executed_later",
    "g1b_presubmit_release",
    "g1b_ambiguous_acceptance_no_replay",
    "g1b_two_successive_messages",
    "g1b_peer_safe_cancel",
    "g1b_peer_safe_unload",
)

_COMMANDS = ("inspect", "network", "storage", "g1", "g2", "capacity", "da01", "privacy", "release")
_OPENAI_BINARIES = ("codex",)
_XAI_BINARIES = ("grok",)

ROOT = Path(__file__).resolve().parents[1]
CODEX_CONFIG_PATH = ROOT / "infra" / "runtime" / "codex" / "config.toml"
CODEX_CAPTURE_PATH = ROOT / "providers" / "openai" / "integration" / "protocol-schema.json"
CODEX_CAPTURE_FORMAT = "esp-codex-protocol-capture/1"
_PROBE_TIMEOUT_SECONDS = 20.0

# Primitives whose native operations the frozen mapping names. A present declaration is never runtime
# proof. A missing one is demonstrated absence only for the exact frozen build (live schema equals the
# frozen capture); on any other build the mapping does not apply until it is recaptured and reviewed.
CODEX_DECLARED_PRIMITIVES: dict[str, tuple[str, ...]] = {
    "create": (CODEX_METHODS["create"],),
    "resume": (CODEX_METHODS["resume"],),
    "unload": (CODEX_METHODS["unload"], CODEX_METHODS["loaded"]),
    "acceptance": (CODEX_METHODS["submit"], CODEX_METHODS["items"]),
    "status": (CODEX_METHODS["status"], CODEX_METHODS["history"]),
    "history": (CODEX_METHODS["history"],),
    "cancel": (CODEX_METHODS["cancel"],),
    "compaction": (CODEX_METHODS["compact"],),
}
# Automatic compaction runs inside an ordinary turn and needs no manual method, so a missing
# `thread/compact/start` does not show that compaction is absent.
_DECLARATION_CANNOT_SHOW_ABSENCE = frozenset({"compaction"})
ESSENTIAL_PRIMITIVES: tuple[str, ...] = tuple(name for name in REQUIRED_PRIMITIVES if not name.startswith("auxiliary_"))

# Definition name -> schema file holding it, relative to the generated bundle.
_CAPTURE_DEFINITIONS: dict[str, str] = {
    "Thread": "v2/ThreadReadResponse.json",
    "Turn": "v2/ThreadReadResponse.json",
    "TurnStatus": "v2/ThreadReadResponse.json",
    "TurnError": "v2/ThreadReadResponse.json",
    "ThreadStatus": "v2/ThreadReadResponse.json",
    "ThreadItem": "v2/ThreadReadResponse.json",
    "UserInput": "v2/ThreadReadResponse.json",
    "ThreadItemEntry": "v2/ThreadItemsListResponse.json",
    "TurnItemsView": "v2/ThreadTurnsListParams.json",
    "SortDirection": "v2/ThreadTurnsListParams.json",
    "ThreadUnsubscribeStatus": "v2/ThreadUnsubscribeResponse.json",
    "SandboxMode": "v2/ThreadStartParams.json",
    "SandboxPolicy": "v2/ThreadStartResponse.json",
    "ThreadTokenUsage": "v2/ThreadTokenUsageUpdatedNotification.json",
    "TokenUsageBreakdown": "v2/ThreadTokenUsageUpdatedNotification.json",
}


def classify_qualification(report: QualificationResult) -> str:
    """Pending unless evidence is complete. Demonstrated essential absence invalidates."""
    if report.essential_absence or report.status == "invalidated":
        return "invalidated"
    scenarios = set(report.scenario_ids)
    digests = (
        report.harness_build,
        report.runtime_image_digest,
        report.transport_integration_digest,
        report.storage_profile,
        report.tool_policy_digest,
        report.configuration_digest,
        report.environment_digest,
        report.allowlist_digest,
        report.evidence_bundle_ref,
        report.acceptance_budgets_ref,
        report.review_owner,
        report.reviewer,
    )
    complete = (
        report.status == "validated"
        and report.g1a_complete
        and report.g1b_complete
        and report.g2_complete
        and report.functional_subgate_pass
        and report.positive_observation_count > 0
        and not report.skipped
        and not report.empty_evidence
        and not report.failed_criteria
        and scenarios >= set(REQUIRED_G1_SCENARIOS)
        and all(digests)
    )
    if complete:
        return "validated"
    return "pending"


def inspect_candidate(provider: Provider, profile: RuntimeProfile | None = None) -> CapabilityReport:
    """Read the installed candidate without upgrading it. Missing hooks stay unproven."""
    if provider == "openai":
        return codex_capability_report(observe_codex(), profile)
    return grok_capability_report(observe_grok(), profile)


@dataclass
class CodexObservation:
    """What isolated, non-inference discovery observed from the installed Codex build."""

    binary_found: bool
    version: str | None = None
    binary_sha256: str | None = None
    native_label: str | None = None
    capture: dict[str, Any] | None = None
    frozen_capture: dict[str, Any] | None = None
    config_digest: str | None = None
    config_accepted: bool | None = None
    feature_conflicts: list[str] = field(default_factory=lambda: [])
    provider_capabilities: dict[str, bool] = field(default_factory=lambda: {})
    errors: list[str] = field(default_factory=lambda: [])
    # File name of a recorded observation; None when the installed build was actually executed.
    recorded_from: str | None = None

    @property
    def harness_build(self) -> str | None:
        """Canonical exact-build identity (`codex_build_id`), or the bare version when no digest exists."""
        if self.version is None:
            return None
        if self.binary_sha256 is None:
            return self.version
        return codex_build_id(self.version, self.binary_sha256)


class _RecordedObservation(BaseModel):
    """Serialized discovery facts. The frozen capture and configuration digest are always read fresh."""

    model_config = ConfigDict(extra="forbid", strict=True)

    binary_found: bool
    version: str | None = None
    binary_sha256: str | None = None
    native_label: str | None = None
    capture: dict[str, Any] | None = None
    config_accepted: bool | None = None
    feature_conflicts: list[str] = Field(default_factory=lambda: [])
    provider_capabilities: dict[str, bool] = Field(default_factory=lambda: {})
    errors: list[str] = Field(default_factory=lambda: [])


def codex_capability_report(observation: CodexObservation, profile: RuntimeProfile | None = None) -> CapabilityReport:
    """Declarations can show absence. Only protected live evidence could prove a primitive."""
    notes: list[str] = []
    if observation.recorded_from is not None:
        notes.append(
            f"Observation was loaded from the recorded observation file {observation.recorded_from}; "
            "the installed build was not executed."
        )
    if not observation.binary_found:
        notes.append("Candidate binary was not found. Discovery did not install or upgrade one.")
    else:
        notes.append(f"Installed build observed without treating it as proof: {observation.harness_build}")
    live = observation.capture
    frozen = observation.frozen_capture
    exact = live is not None and frozen is not None and live == frozen
    if live is not None and frozen is not None:
        if exact:
            notes.append(f"Installed build schema matches the frozen protocol capture sha256:{_json_digest(frozen)}.")
        else:
            notes.append(
                "Installed build schema differs from the frozen protocol capture; the frozen operation mapping "
                "does not apply to this build until it is recaptured and reviewed."
            )
    elif observation.binary_found and live is None:
        notes.append("Protocol schema could not be generated from the installed build.")
    declared = None if live is None else set(cast(list[str], live.get("client_requests", [])))
    primitives: list[PrimitiveEvidence] = []
    for name in REQUIRED_PRIMITIVES:
        methods = CODEX_DECLARED_PRIMITIVES.get(name)
        state: str = "unproven"
        if methods is not None and declared is not None:
            missing = [method for method in methods if method not in declared]
            if not missing:
                notes.append(f"{name}: declared as {', '.join(methods)}; a declaration is not runtime proof.")
            elif not exact:
                notes.append(
                    f"{name}: the installed build does not declare {', '.join(missing)} from the frozen mapping; "
                    "recapture and review before deciding absence."
                )
            elif name in _DECLARATION_CANNOT_SHOW_ABSENCE:
                notes.append(
                    f"{name}: the frozen build does not declare {', '.join(missing)}; that alone does not show "
                    "the capability is absent."
                )
            else:
                state = "absent"
                notes.append(f"{name}: the frozen build does not declare {', '.join(missing)}.")
        primitives.append(PrimitiveEvidence.model_validate({"name": name, "state": state, "evidence_ref": None}))
    notes.append(
        "model_context_hook: the build declares client_metadata[\"x-codex-turn-metadata\"] with thread_id and "
        "turn_id on Responses requests; the relay attribution hook is implemented but no live request capture exists."
    )
    notes.append("mcp_context_hook: the captured schema declares no per-call MCP identity; unproven.")
    notes.append(
        "compaction: no separate compaction endpoint was found in the build; "
        "compaction through the gateway is unproven."
    )
    if observation.config_digest is not None:
        if observation.config_accepted is True:
            notes.append(
                f"Runtime configuration sha256:{observation.config_digest} was accepted under --strict-config."
            )
        elif observation.config_accepted is False:
            notes.append(f"Runtime configuration sha256:{observation.config_digest} was not accepted by the build.")
    for feature in observation.feature_conflicts:
        notes.append(
            f"tool_policy: configuration disables feature {feature!r} but the build reports it enabled; "
            "disablement is not demonstrated."
        )
    if observation.provider_capabilities:
        listed = ", ".join(f"{key}={value}" for key, value in sorted(observation.provider_capabilities.items()))
        notes.append(f"Model provider capability listing (not enablement): {listed}.")
    for error in observation.errors:
        notes.append(f"Discovery error: {error}")
    notes.append(
        "No inference was performed (no model request, no credentials); model access and the candidate model "
        "identifier are unobserved."
    )
    return CapabilityReport(
        provider="openai",
        profile=profile,
        installed_version=observation.version,
        primitives=primitives,
        notes=notes,
    )


def essential_absences(report: CapabilityReport) -> list[str]:
    """Demonstrated absence of an essential primitive. Auxiliary paths being absent is not a failure."""
    return [item.name for item in report.primitives if item.state == "absent" and item.name in ESSENTIAL_PRIMITIVES]


def summarize_definition(definition: Mapping[str, Any]) -> dict[str, Any]:
    """Keep the shape facts a contract test can check: enum values, tagged variants, property names."""
    if "enum" in definition:
        return {"enum": list(cast(list[object], definition["enum"]))}
    raw_variants = definition.get("oneOf", definition.get("anyOf"))
    if isinstance(raw_variants, list):
        enums: list[object] = []
        tagged: dict[str, dict[str, list[str]]] = {}
        for raw in cast(list[object], raw_variants):
            if not isinstance(raw, dict):
                continue
            variant = cast(dict[str, Any], raw)
            if "enum" in variant:
                enums.extend(cast(list[object], variant["enum"]))
                continue
            properties = cast(dict[str, Any], variant.get("properties", {}))
            tag_schema = properties.get("type")
            tag_values = cast(dict[str, Any], tag_schema).get("enum") if isinstance(tag_schema, dict) else None
            if isinstance(tag_values, list) and tag_values:
                tagged[str(cast(list[object], tag_values)[0])] = _shape(variant)
        summary: dict[str, Any] = {}
        if tagged:
            summary["variants"] = dict(sorted(tagged.items()))
        if enums:
            summary["enum"] = enums
        return summary
    return _shape(definition)


def extract_codex_protocol(
    stable_dir: Path,
    experimental_dir: Path,
    *,
    harness_build: str,
    binary_sha256: str,
    native_label: str,
) -> dict[str, Any]:
    """Deterministic, sanitized extract of the generated app-server schema bundle."""
    client_requests = _methods(stable_dir / "ClientRequest.json")
    experimental_requests = _methods(experimental_dir / "ClientRequest.json")
    notification_refs = _method_params(stable_dir / "ServerNotification.json")
    request_refs = _method_params(stable_dir / "ClientRequest.json")
    shapes: dict[str, Any] = {}
    for method in sorted(set(CODEX_METHODS.values())):
        params_name = request_refs[method]
        result_name = params_name.removesuffix("Params") + "Response"
        shapes[method] = {
            "params": _shape(_schema(stable_dir, params_name)),
            "result": _shape(_schema(stable_dir, result_name)),
        }
    notification_shapes: dict[str, Any] = {}
    for method in sorted(set(CODEX_EVENT_METHODS) | {"thread/closed"}):
        notification_shapes[method] = _shape(_schema(stable_dir, notification_refs[method]))
    definitions: dict[str, Any] = {}
    for name, relative in sorted(_CAPTURE_DEFINITIONS.items()):
        document = _read_json(stable_dir / relative)
        definitions[name] = summarize_definition(cast(dict[str, Any], document["definitions"])[name])
    turn_start = _read_json(experimental_dir / "v2" / "TurnStartParams.json")
    thread_read = _read_json(stable_dir / "v2" / "ThreadReadParams.json")
    read_response = _read_json(stable_dir / "v2" / "ThreadReadResponse.json")
    thread_definition = cast(dict[str, Any], read_response["definitions"])["Thread"]
    declarations = {
        "turn/start.responsesapiClientMetadata": _description(turn_start, "responsesapiClientMetadata"),
        "thread/read.includeTurns": _description(thread_read, "includeTurns"),
        "Thread.ephemeral": _description(thread_definition, "ephemeral"),
    }
    return {
        "format": CODEX_CAPTURE_FORMAT,
        "harness_build": harness_build,
        "native_binary": {"package_path": native_label, "sha256": binary_sha256},
        "generator": {
            "stable": "codex app-server generate-json-schema --out <isolated tmp>",
            "experimental": "codex app-server generate-json-schema --experimental --out <isolated tmp>",
            "isolation": "env -i with temporary HOME and CODEX_HOME; no credentials; no model request",
        },
        "bundle_sha256": _bundle_digest(stable_dir),
        "experimental_bundle_sha256": _bundle_digest(experimental_dir),
        "client_requests": sorted(client_requests),
        "client_notifications": sorted(_methods(stable_dir / "ClientNotification.json")),
        "server_notifications": sorted(_methods(stable_dir / "ServerNotification.json")),
        "server_requests": sorted(_methods(stable_dir / "ServerRequest.json")),
        "experimental_client_requests": sorted(set(experimental_requests) - set(client_requests)),
        "esp_operation_mapping": dict(CODEX_METHODS),
        "esp_client_notifications": list(CODEX_CLIENT_NOTIFICATIONS),
        "shapes": shapes,
        "notification_shapes": notification_shapes,
        "definitions": definitions,
        "declarations": declarations,
    }


def load_codex_observation(
    path: Path,
    *,
    config_path: Path = CODEX_CONFIG_PATH,
    capture_path: Path = CODEX_CAPTURE_PATH,
) -> CodexObservation:
    """A recorded discovery observation, so ordinary tests never execute the installed build.

    It can only yield pending or demonstrated-absence results, never proof.
    """
    recorded = _RecordedObservation.model_validate_json(path.read_bytes())
    frozen, config_digest, errors = _repository_inputs(config_path, capture_path)
    return CodexObservation(
        binary_found=recorded.binary_found,
        version=recorded.version,
        binary_sha256=recorded.binary_sha256,
        native_label=recorded.native_label,
        capture=recorded.capture,
        frozen_capture=frozen,
        config_digest=config_digest,
        config_accepted=recorded.config_accepted,
        feature_conflicts=list(recorded.feature_conflicts),
        provider_capabilities=dict(recorded.provider_capabilities),
        errors=[*errors, *recorded.errors],
        recorded_from=path.name,
    )


def _repository_inputs(config_path: Path, capture_path: Path) -> tuple[dict[str, Any] | None, str | None, list[str]]:
    """Frozen capture and configuration digest. Unreadable inputs become discovery errors, not tracebacks."""
    errors: list[str] = []
    frozen: dict[str, Any] | None = None
    if capture_path.exists():
        try:
            frozen = _read_json(capture_path)
        except (OSError, ValueError) as exc:
            errors.append(f"frozen protocol capture unreadable: {type(exc).__name__}")
    config_digest: str | None = None
    if config_path.exists():
        try:
            config_digest = hashlib.sha256(config_path.read_bytes()).hexdigest()
        except OSError as exc:
            errors.append(f"runtime configuration unreadable: {type(exc).__name__}")
    return frozen, config_digest, errors


def observe_codex(
    *,
    config_path: Path = CODEX_CONFIG_PATH,
    capture_path: Path = CODEX_CAPTURE_PATH,
    which: Callable[[str], str | None] = shutil.which,
) -> CodexObservation:
    """Version, schema and initialize/capability listing only, with an isolated HOME and CODEX_HOME."""
    frozen, config_digest, errors = _repository_inputs(config_path, capture_path)
    wrapper = which(_OPENAI_BINARIES[0])
    if wrapper is None:
        return CodexObservation(binary_found=False, frozen_capture=frozen, config_digest=config_digest, errors=errors)
    try:
        native, label = _codex_native_binary(Path(wrapper))
    except OSError as exc:
        errors.append(f"native binary lookup failed: {type(exc).__name__}")
        native, label = None, None
    executable = native or Path(wrapper).resolve()
    binary_sha256: str | None = None
    try:
        binary_sha256 = _file_digest(executable)
    except OSError as exc:
        errors.append(f"native binary digest failed: {type(exc).__name__}")
    observation = CodexObservation(
        binary_found=True,
        binary_sha256=binary_sha256,
        native_label=label or executable.name,
        frozen_capture=frozen,
        config_digest=config_digest,
        errors=errors,
    )
    with tempfile.TemporaryDirectory(prefix="esp-codex-g0-") as raw_tmp:
        tmp = Path(raw_tmp)
        env = _isolated_env(tmp, needs_node=native is None)
        try:
            observation.version = _first_line(_run(executable, ["--version"], env, tmp))
            stable = tmp / "schema"
            experimental = tmp / "schema-experimental"
            _run(executable, ["app-server", "generate-json-schema", "--out", str(stable)], env, tmp)
            generate = ["app-server", "generate-json-schema"]
            _run(executable, [*generate, "--experimental", "--out", str(experimental)], env, tmp)
            harness_build = observation.harness_build
            if harness_build is not None and observation.binary_sha256 is not None:
                observation.capture = extract_codex_protocol(
                    stable,
                    experimental,
                    harness_build=harness_build,
                    binary_sha256=observation.binary_sha256,
                    native_label=observation.native_label or executable.name,
                )
        except (OSError, subprocess.SubprocessError, KeyError, ValueError) as exc:
            observation.errors.append(_sanitize(f"schema discovery failed: {exc}", tmp))
        if config_digest is not None:
            _observe_handshake(observation, executable, env, tmp, config_path)
    return observation


def _observe_handshake(
    observation: CodexObservation, executable: Path, env: dict[str, str], tmp: Path, config_path: Path
) -> None:
    codex_home = Path(env["CODEX_HOME"])
    try:
        (codex_home / "config.toml").write_bytes(config_path.read_bytes())
    except OSError as exc:
        observation.errors.append(f"runtime configuration could not be staged: {type(exc).__name__}")
        return
    try:
        listing = asyncio.run(_codex_handshake(executable, env, tmp))
    except Exception as exc:
        # Any startup or protocol failure is recorded and never treated as success.
        observation.config_accepted = False
        observation.errors.append(_sanitize(f"app-server handshake failed: {type(exc).__name__}: {exc}", tmp))
        stderr = tmp / "app-server.stderr"
        if stderr.exists():
            tail = stderr.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-3:]
            observation.errors.extend(_sanitize(line, tmp) for line in tail)
        return
    config = cast(dict[str, Any], listing["config"])
    observation.config_accepted = config.get("model_provider") == CODEX_MODEL_PROVIDER
    try:
        configured = tomllib.loads(config_path.read_text(encoding="utf-8")).get("features", {})
    except (OSError, ValueError) as exc:
        observation.errors.append(f"runtime configuration unreadable: {type(exc).__name__}")
        return
    disabled = {name for name, value in cast(dict[str, object], configured).items() if value is False}
    for feature in cast(list[dict[str, Any]], listing["features"]):
        if feature.get("name") in disabled and feature.get("enabled") is True:
            observation.feature_conflicts.append(str(feature["name"]))
    capabilities = cast(dict[str, object], listing["provider_capabilities"])
    observation.provider_capabilities = {
        key: value for key, value in sorted(capabilities.items()) if isinstance(value, bool)
    }


async def _codex_handshake(executable: Path, env: dict[str, str], tmp: Path) -> dict[str, Any]:
    with (tmp / "app-server.stderr").open("wb") as stderr:
        process = await asyncio.create_subprocess_exec(
            str(executable),
            "app-server",
            "--strict-config",
            "--listen",
            "stdio://",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr,
            env=env,
            cwd=str(tmp / "home"),
            limit=STDIO_READER_LIMIT,
        )
        if process.stdin is None or process.stdout is None:
            raise OSError("app-server pipes were not created")
        rpc = NativeRpcClient(JsonlFrameTransport(process.stdout, process.stdin))
        try:
            capabilities_request = {"optOutNotificationMethods": list(CODEX_OPT_OUT_NOTIFICATIONS)}
            initialize = {"clientInfo": {"name": "esp-qualify", "version": "1"}, "capabilities": capabilities_request}
            await _call(rpc, CODEX_METHODS["handshake"], initialize)
            await rpc.notify(CODEX_CLIENT_NOTIFICATIONS[0])
            config = await _call(rpc, "config/read", {"includeLayers": False})
            features: list[object] = []
            cursor: object = None
            for _ in range(20):
                params: dict[str, object] = {"limit": 500}
                if isinstance(cursor, str):
                    params["cursor"] = cursor
                page = await _call(rpc, "experimentalFeature/list", params)
                features.extend(cast(list[object], page.get("data", [])))
                cursor = page.get("nextCursor")
                if not isinstance(cursor, str):
                    break
            capabilities = await _call(rpc, "modelProvider/capabilities/read", {})
            await _call(rpc, CODEX_METHODS["loaded"], {})
            return {"config": config.get("config", {}), "features": features, "provider_capabilities": capabilities}
        finally:
            process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                process.kill()
                await process.wait()


async def _call(rpc: NativeRpcClient, method: str, params: object) -> dict[str, Any]:
    result = await asyncio.wait_for(rpc.request(method, params), timeout=_PROBE_TIMEOUT_SECONDS)
    if not isinstance(result, dict):
        raise ValueError(f"{method} returned a non-object result")
    return cast(dict[str, Any], result)


def _codex_native_binary(wrapper: Path) -> tuple[Path | None, str | None]:
    """The npm `codex` wrapper launches a vendored native binary; digest that binary, not the script."""
    resolved = wrapper.resolve()
    package_root = resolved.parent.parent
    vendor_root = package_root / "node_modules" / "@openai"
    candidates = sorted(vendor_root.glob("codex-*/vendor/*/bin/codex"))
    if not candidates:
        return None, None
    native = candidates[0]
    return native, native.relative_to(vendor_root.parent).as_posix()


def _isolated_env(tmp: Path, *, needs_node: bool) -> dict[str, str]:
    home = tmp / "home"
    codex_home = tmp / "codex_home"
    home.mkdir()
    codex_home.mkdir()
    path = "/usr/bin:/bin"
    node = shutil.which("node") if needs_node else None
    if node is not None:
        path = f"{Path(node).parent}:{path}"
    return {"PATH": path, "HOME": str(home), "CODEX_HOME": str(codex_home)}


def _run(executable: Path, arguments: list[str], env: dict[str, str], tmp: Path) -> str:
    completed = subprocess.run(
        [str(executable), *arguments],
        capture_output=True,
        text=True,
        timeout=_PROBE_TIMEOUT_SECONDS,
        check=False,
        env=env,
        cwd=str(tmp / "home"),
    )
    if completed.returncode != 0:
        raise ValueError(f"{arguments[0]} exited {completed.returncode}")
    return completed.stdout


def _first_line(text: str) -> str | None:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[0] if lines else None


def _sanitize(text: str, tmp: Path) -> str:
    return text.replace(str(tmp), "<isolated>")[:400]


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _bundle_digest(directory: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in directory.rglob("*") if item.is_file()):
        relative = path.relative_to(directory).as_posix()
        digest.update(f"{relative}\0{_file_digest(path)}\n".encode())
    return digest.hexdigest()


def _json_digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} is not a JSON object")
    return cast(dict[str, Any], value)


def _variants(path: Path) -> list[dict[str, Any]]:
    raw = cast(list[object], _read_json(path).get("oneOf", []))
    return [cast(dict[str, Any], item) for item in raw if isinstance(item, dict)]


def _method_name(variant: Mapping[str, Any]) -> str | None:
    method = cast(dict[str, Any], variant.get("properties", {})).get("method")
    values = cast(dict[str, Any], method).get("enum") if isinstance(method, dict) else None
    if isinstance(values, list) and values and isinstance(cast(list[object], values)[0], str):
        return cast(list[str], values)[0]
    return None


def _methods(path: Path) -> list[str]:
    return [name for name in (_method_name(variant) for variant in _variants(path)) if name is not None]


def _method_params(path: Path) -> dict[str, str]:
    refs: dict[str, str] = {}
    for variant in _variants(path):
        name = _method_name(variant)
        params = cast(dict[str, Any], variant.get("properties", {})).get("params")
        ref = cast(dict[str, Any], params).get("$ref") if isinstance(params, dict) else None
        if name is not None and isinstance(ref, str):
            refs[name] = ref.rsplit("/", 1)[-1]
    return refs


def _schema(bundle: Path, name: str) -> dict[str, Any]:
    for relative in (f"v2/{name}.json", f"v1/{name}.json", f"{name}.json"):
        path = bundle / relative
        if path.exists():
            return _read_json(path)
    raise KeyError(name)


def _shape(schema: Mapping[str, Any]) -> dict[str, list[str]]:
    properties = schema.get("properties", {})
    required = schema.get("required", [])
    names = sorted(cast(dict[str, Any], properties)) if isinstance(properties, dict) else []
    needed = sorted(cast(list[str], required)) if isinstance(required, list) else []
    return {"properties": names, "required": needed}


def _description(schema: Mapping[str, Any], field_name: str) -> str:
    properties = cast(dict[str, Any], schema.get("properties", {}))
    value = cast(dict[str, Any], properties[field_name]).get("description")
    if not isinstance(value, str):
        raise KeyError(field_name)
    return value


# Grok Build (xAI) G0 discovery --------------------------------------------------------------

GROK_CONFIG_PATH = ROOT / "infra" / "runtime" / "grok" / "config.toml"
GROK_CAPTURE_PATH = ROOT / "providers" / "xai" / "integration" / "protocol-capabilities.json"
GROK_CAPTURE_FORMAT = "esp-grok-protocol-capture/1"
# Byte strings searched for in the native binary. Presence is static evidence only: it is neither a
# declaration of runtime behaviour nor proof of it.
GROK_BINARY_MARKERS: tuple[str, ...] = (
    "initialize",
    "authenticate",
    "session/new",
    "session/load",
    "session/resume",
    "session/close",
    "session/list",
    "session/prompt",
    "session/cancel",
    "session/update",
    "session/set_config_option",
    "session/set_mode",
    "session/request_permission",
    "fs/read_text_file",
    "fs/write_text_file",
    "terminal/create",
    "x.ai/compact_conversation",
    "struct InitializeRequest",
    "struct NewSessionRequest",
    "struct NewSessionResponse",
    "struct LoadSessionRequest",
    "struct LoadSessionResponse",
    "struct ResumeSessionRequest",
    "struct CloseSessionRequest",
    "struct ListSessionsRequest",
    "struct PromptRequest",
    "struct PromptResponse",
    "struct CancelNotification",
    "struct SessionNotification",
    "struct RequestPermissionRequest",
    "messageId",
    "userMessageId",
    "stopReason",
    "configOptions",
    "currentValue",
    "user_message_chunk",
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call_update",
    "config_option_update",
    "end_turn",
    "max_turn_requests",
    "xai-grok-sampler/src/client.rs",
    GROK_SESSION_HEADER,
    "x-grok-conv-id",
    "x-grok-req-id",
    "x-grok-turn-idx",
    "x-grok-agent-id",
    GROK_MCP_SESSION_HEADER,
    "{{session_id}}",
)
_GROK_HELP: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("top_level_commands", ("--help",)),
    ("agent_modes", ("agent", "--help")),
    ("sessions_commands", ("sessions", "--help")),
)
# Baseline ACP v1 client requests, and the declared capability that gates each optional one.
_ACP_CLIENT_REQUESTS: tuple[tuple[str, str | None], ...] = (
    ("initialize", None),
    ("authenticate", None),
    ("session/new", None),
    ("session/prompt", None),
    ("session/set_config_option", None),
    ("session/set_mode", None),
    ("session/load", "loadSession"),
    ("session/resume", "sessionCapabilities.resume"),
    ("session/close", "sessionCapabilities.close"),
    ("session/list", "sessionCapabilities.list"),
)


def _shape_of(properties: list[str], required: list[str]) -> dict[str, list[str]]:
    return {"properties": sorted(properties), "required": sorted(required)}


# ACP protocol version 1 field names. The build declares protocolVersion 1 and ships no machine-readable
# schema; its binary carries the request types and the `messageId`/`userMessageId` fields used here.
ACP_V1_SHAPES: dict[str, Any] = {
    "initialize": {
        "params": _shape_of(["_meta", "clientCapabilities", "clientInfo", "protocolVersion"], ["protocolVersion"]),
        "result": _shape_of(
            ["_meta", "agentCapabilities", "agentInfo", "authMethods", "protocolVersion"], ["protocolVersion"]
        ),
    },
    "session/new": {
        "params": _shape_of(["_meta", "additionalDirectories", "cwd", "mcpServers"], ["cwd", "mcpServers"]),
        "result": _shape_of(["_meta", "configOptions", "models", "modes", "sessionId"], ["sessionId"]),
    },
    "session/load": {
        "params": _shape_of(
            ["_meta", "additionalDirectories", "cwd", "mcpServers", "sessionId"], ["cwd", "mcpServers", "sessionId"]
        ),
        "result": _shape_of(["_meta", "configOptions", "models", "modes"], []),
    },
    "session/resume": {
        "params": _shape_of(["_meta", "additionalDirectories", "cwd", "mcpServers", "sessionId"], ["cwd", "sessionId"]),
        "result": _shape_of(["_meta", "configOptions", "models", "modes"], []),
    },
    "session/close": {
        "params": _shape_of(["_meta", "sessionId"], ["sessionId"]),
        "result": _shape_of(["_meta"], []),
    },
    "session/prompt": {
        "params": _shape_of(["_meta", "messageId", "prompt", "sessionId"], ["prompt", "sessionId"]),
        "result": _shape_of(["_meta", "stopReason", "usage", "userMessageId"], ["stopReason"]),
    },
    "session/cancel": {"params": _shape_of(["_meta", "sessionId"], ["sessionId"])},
    "session/update": {"params": _shape_of(["_meta", "sessionId", "update"], ["sessionId", "update"])},
    "TextContent": _shape_of(["_meta", "annotations", "text", "type"], ["text", "type"]),
}
# Primitive -> declarations it needs: a binary marker or a capability declared at initialize. A present
# declaration is never runtime proof. A missing one is demonstrated absence only for the exact frozen
# build with a re-observed handshake; anything else stays unproven until recaptured and reviewed.
GROK_DECLARED_PRIMITIVES: dict[str, tuple[str, ...]] = {
    "create": ("marker:session/new", "marker:struct NewSessionRequest"),
    "resume": ("capability:sessionCapabilities.resume", "marker:struct ResumeSessionRequest"),
    "unload": ("capability:sessionCapabilities.close", "marker:struct CloseSessionRequest"),
    "history": ("capability:loadSession", "marker:struct LoadSessionRequest"),
    "acceptance": ("marker:messageId", "marker:userMessageId", "capability:loadSession"),
    "cancel": ("marker:struct CancelNotification",),
}


@dataclass
class GrokObservation:
    """What isolated, non-inference discovery observed from the installed Grok Build."""

    binary_found: bool
    version: str | None = None
    binary_sha256: str | None = None
    native_label: str | None = None
    static_capture: dict[str, Any] | None = None
    frozen_capture: dict[str, Any] | None = None
    # Sanitized ACP initialize result; None unless this run re-observed the handshake.
    acp_initialize: dict[str, Any] | None = None
    config_digest: str | None = None
    # True only when this run copied the runtime configuration into its isolated GROK_HOME.
    config_staged: bool = False
    network_isolated: bool | None = None
    errors: list[str] = field(default_factory=lambda: [])
    # File name of a recorded observation; None when the installed build was actually executed.
    recorded_from: str | None = None

    @property
    def harness_build(self) -> str | None:
        """Canonical exact-build identity (`grok_build_id`), or the bare version when no digest exists."""
        if self.version is None:
            return None
        if self.binary_sha256 is None:
            return self.version
        return grok_build_id(self.version, self.binary_sha256)


class _RecordedGrokObservation(BaseModel):
    """Serialized Grok discovery facts. The frozen capture and configuration digest are always read fresh."""

    model_config = ConfigDict(extra="forbid", strict=True)

    binary_found: bool
    version: str | None = None
    binary_sha256: str | None = None
    native_label: str | None = None
    static_capture: dict[str, Any] | None = None
    network_isolated: bool | None = None
    acp_initialize: dict[str, Any] | None = None
    errors: list[str] = Field(default_factory=lambda: [])


def load_grok_observation(
    path: Path,
    *,
    config_path: Path = GROK_CONFIG_PATH,
    capture_path: Path = GROK_CAPTURE_PATH,
) -> GrokObservation:
    """A recorded discovery observation, so ordinary tests never execute the installed build."""
    recorded = _RecordedGrokObservation.model_validate_json(path.read_bytes())
    frozen, config_digest, errors = _repository_inputs(config_path, capture_path)
    return GrokObservation(
        binary_found=recorded.binary_found,
        version=recorded.version,
        binary_sha256=recorded.binary_sha256,
        native_label=recorded.native_label,
        static_capture=recorded.static_capture,
        frozen_capture=frozen,
        acp_initialize=recorded.acp_initialize,
        config_digest=config_digest,
        network_isolated=recorded.network_isolated,
        errors=[*errors, *recorded.errors],
        recorded_from=path.name,
    )


def _network_isolation() -> list[str] | None:
    """Command prefix that runs the build in a fresh network namespace with no route out, or None."""
    unshare = shutil.which("unshare")
    if unshare is None:
        return None
    try:
        probe = subprocess.run([unshare, "-rn", "true"], capture_output=True, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return [unshare, "-rn"] if probe.returncode == 0 else None


def _run_isolated(argv: list[str], env: dict[str, str], cwd: Path) -> str:
    completed = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=_PROBE_TIMEOUT_SECONDS,
        check=False,
        env=env,
        cwd=str(cwd),
    )
    if completed.returncode != 0:
        raise ValueError(f"{' '.join(argv[-2:])} exited {completed.returncode}")
    return completed.stdout


def observe_grok(
    *,
    config_path: Path = GROK_CONFIG_PATH,
    capture_path: Path = GROK_CAPTURE_PATH,
    which: Callable[[str], str | None] = shutil.which,
    isolation: Callable[[], list[str] | None] = _network_isolation,
    runner: Callable[[list[str], dict[str, str], Path], str] = _run_isolated,
    acp_handshake: bool = False,
) -> GrokObservation:
    """Version, help and a static marker scan, run without network and with an isolated HOME/GROK_HOME.

    The ACP handshake starts `grok agent stdio` and runs only when `acp_handshake` is requested; it sends
    `initialize` and nothing else. No session, prompt or credential is ever involved.
    """
    frozen, config_digest, errors = _repository_inputs(config_path, capture_path)
    wrapper = which(_XAI_BINARIES[0])
    if wrapper is None:
        return GrokObservation(binary_found=False, frozen_capture=frozen, config_digest=config_digest, errors=errors)
    native = Path(wrapper).resolve()
    observation = GrokObservation(
        binary_found=True, native_label=native.name, frozen_capture=frozen, config_digest=config_digest, errors=errors
    )
    try:
        observation.binary_sha256 = _file_digest(native)
    except OSError as exc:
        errors.append(f"native binary digest failed: {type(exc).__name__}")
    prefix = isolation()
    if prefix is None:
        observation.network_isolated = False
        errors.append("network namespace isolation (unshare -rn) is unavailable; the build was not executed")
        return observation
    observation.network_isolated = True
    with tempfile.TemporaryDirectory(prefix="esp-grok-g0-") as raw_tmp:
        tmp = Path(raw_tmp)
        home = tmp / "home"
        grok_home = tmp / "grok_home"
        home.mkdir()
        grok_home.mkdir()
        if config_path.exists():
            try:
                staged = config_path.read_bytes()
                (grok_home / "config.toml").write_bytes(staged)
            except OSError as exc:
                errors.append(f"runtime configuration could not be staged: {type(exc).__name__}")
            else:
                # Only the exact digested file counts as staged.
                observation.config_staged = hashlib.sha256(staged).hexdigest() == observation.config_digest
        env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "GROK_HOME": str(grok_home), "GROK_DISABLE_AUTOUPDATER": "1"}
        command = [*prefix, str(native)]
        help_texts: dict[str, str] | None = None
        try:
            observation.version = _first_line(runner([*command, "--version"], env, home))
            help_texts = {name: runner([*command, *arguments], env, home) for name, arguments in _GROK_HELP}
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            errors.append(_sanitize(f"version or help discovery failed: {exc}", tmp))
        markers: dict[str, bool] | None = None
        try:
            markers = scan_binary_markers(native)
        except OSError as exc:
            errors.append(f"native binary marker scan failed: {type(exc).__name__}")
        if observation.version and observation.binary_sha256 and help_texts is not None and markers is not None:
            observation.static_capture = extract_grok_static(
                observation.version, observation.binary_sha256, native.name, help_texts, markers
            )
        if acp_handshake and observation.static_capture is not None:
            try:
                observation.acp_initialize = asyncio.run(_grok_handshake(command, env, home, tmp))
            except Exception as exc:
                # Any startup or protocol failure is recorded and never treated as success.
                errors.append(_sanitize(f"ACP handshake failed: {type(exc).__name__}: {exc}", tmp))
    return observation


def scan_binary_markers(path: Path) -> dict[str, bool]:
    """Byte-substring presence of each marker in the native binary. Nothing is executed."""
    with path.open("rb") as handle:
        try:
            mapped = mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
        except ValueError:
            return dict.fromkeys(GROK_BINARY_MARKERS, False)
        with mapped:
            return {marker: mapped.find(marker.encode()) != -1 for marker in GROK_BINARY_MARKERS}


def extract_grok_static(
    version: str, binary_sha256: str, label: str, help_texts: Mapping[str, str], markers: Mapping[str, bool]
) -> dict[str, Any]:
    """Deterministic, sanitized static facts of the installed build. No host path is recorded."""
    return {
        "version": version,
        "native_binary": {"label": label, "sha256": binary_sha256},
        "generator": {
            "version": "grok --version",
            "help": [f"grok {' '.join(arguments)}" for _, arguments in _GROK_HELP],
            "markers": "byte-substring scan of the native binary file; nothing executed",
            "isolation": (
                "unshare -rn (new network namespace, no route out); env -i with temporary HOME and GROK_HOME; "
                "GROK_DISABLE_AUTOUPDATER=1; runtime configuration staged; no credentials; no agent process"
            ),
        },
        "help": {name: _help_commands(help_texts.get(name, "")) for name, _ in _GROK_HELP},
        "markers": {marker: bool(markers.get(marker, False)) for marker in GROK_BINARY_MARKERS},
    }


def _help_commands(text: str) -> list[str]:
    names: list[str] = []
    in_commands = False
    for line in text.splitlines():
        if line.strip() == "Commands:":
            in_commands = True
            continue
        if not in_commands:
            continue
        if line.startswith("  ") and not line.startswith("   ") and line.strip():
            names.append(line.split()[0])
        elif names:
            break
    return names


def sanitize_grok_initialize(result: Mapping[str, Any], notifications: list[str]) -> dict[str, Any]:
    """Keep the protocol facts of an ACP initialize result; withhold host-identifying metadata."""
    meta = cast(dict[str, Any], result.get("_meta")) if isinstance(result.get("_meta"), dict) else {}
    auth_methods = cast(list[object], result.get("authMethods")) if isinstance(result.get("authMethods"), list) else []
    auth_ids: list[str] = []
    for entry in auth_methods:
        method_id = cast(dict[str, Any], entry).get("id") if isinstance(entry, dict) else None
        if isinstance(method_id, str):
            auth_ids.append(method_id)
    capabilities = result.get("agentCapabilities")
    return {
        "protocolVersion": result.get("protocolVersion"),
        "agentCapabilities": capabilities if isinstance(capabilities, dict) else {},
        "authMethodIds": sorted(auth_ids),
        "meta": {key: value for key, value in sorted(meta.items()) if key not in HOST_IDENTIFYING_META},
        "withheld_meta_keys": sorted(key for key in meta if key in HOST_IDENTIFYING_META),
        "notifications": sorted(set(notifications)),
    }


async def _grok_handshake(command: list[str], env: dict[str, str], cwd: Path, tmp: Path) -> dict[str, Any]:
    """`initialize` only, through the same client guard the supervisor uses. No session is created."""
    with (tmp / "agent.stderr").open("wb") as stderr:
        process = await asyncio.create_subprocess_exec(
            *command,
            "agent",
            "--no-leader",
            "stdio",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr,
            env=env,
            cwd=str(cwd),
            limit=GROK_STDIO_READER_LIMIT,
        )
        if process.stdin is None or process.stdout is None:
            raise OSError("agent pipes were not created")
        rpc = NativeRpcClient(AcpClientGuard(GrokStdioTransport(process.stdout, process.stdin)))
        methods: list[str] = []

        async def collect() -> None:
            async for note in rpc.notifications():
                method = getattr(note, "method", None)
                if isinstance(method, str):
                    methods.append(method)

        collector = asyncio.create_task(collect())
        try:
            result = await _call(rpc, GROK_METHODS["handshake"], acp_initialize_params("esp-qualify", "1"))
            await asyncio.sleep(0.5)
            return sanitize_grok_initialize(result, methods)
        finally:
            collector.cancel()
            process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                process.kill()
                await process.wait()


def _grok_declared(check: str, static: Mapping[str, Any], initialize: Mapping[str, Any]) -> bool:
    kind, _, name = check.partition(":")
    if kind == "marker":
        return cast(dict[str, Any], static.get("markers", {})).get(name) is True
    capabilities = cast(dict[str, Any], initialize.get("agentCapabilities", {}))
    if name == "loadSession":
        return capabilities.get("loadSession") is True
    group, _, key = name.partition(".")
    declared = capabilities.get(group)
    return isinstance(declared, dict) and key in cast(dict[str, Any], declared)


def acp_v1_declared(static: Mapping[str, Any], initialize: Mapping[str, Any] | None) -> dict[str, Any]:
    """The ACP v1 surface this build declares: methods whose marker is present and whose gate is declared."""
    markers = cast(dict[str, Any], static.get("markers", {}))
    requests: list[str] = []
    for method, gate in _ACP_CLIENT_REQUESTS:
        if markers.get(method) is not True:
            continue
        if gate is None or (initialize is not None and _grok_declared(f"capability:{gate}", static, initialize)):
            requests.append(method)
    return {
        "protocol_version": ACP_PROTOCOL_VERSION,
        "source": (
            "Agent Client Protocol version 1 as declared by the build at initialize; no machine-readable schema "
            "ships with the build; request types and messageId/userMessageId fields are corroborated by binary markers"
        ),
        "client_requests": requests,
        "client_notifications": list(GROK_CLIENT_NOTIFICATIONS),
        "agent_notifications": ["session/update"],
        "agent_requests": ["session/request_permission", "fs/read_text_file", "fs/write_text_file", "terminal/create"],
        "session_update_kinds": [
            "user_message_chunk",
            "agent_message_chunk",
            "agent_thought_chunk",
            "tool_call",
            "tool_call_update",
            "plan",
            "available_commands_update",
            "current_mode_update",
            "config_option_update",
            "session_info_update",
            "usage_update",
        ],
        "stop_reasons": ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"],
        "shapes": ACP_V1_SHAPES,
    }


def grok_protocol_capture(observation: GrokObservation) -> dict[str, Any] | None:
    """Capture to freeze. Handshake facts and G0 records carry over only for the same exact build."""
    static = observation.static_capture
    harness_build = observation.harness_build
    if static is None or harness_build is None or observation.binary_sha256 is None:
        return None
    frozen = observation.frozen_capture or {}
    same_build = frozen.get("harness_build") == harness_build
    initialize: dict[str, Any] | None
    if observation.acp_initialize is not None:
        if observation.config_staged:
            staged = f"the runtime configuration sha256:{observation.config_digest} staged as GROK_HOME/config.toml"
        else:
            staged = "no runtime configuration staged"
        initialize = {
            **observation.acp_initialize,
            "provenance": (
                f"re-observed by qualify inspect --acp-handshake (initialize only, network-isolated) with {staged}"
            ),
        }
    elif same_build and isinstance(frozen.get("acp_initialize"), dict):
        initialize = cast(dict[str, Any], frozen["acp_initialize"])
    else:
        initialize = None
    capture: dict[str, Any] = {
        "format": GROK_CAPTURE_FORMAT,
        "harness_build": harness_build,
        "static": static,
        "acp_initialize": initialize,
        "acp_v1": acp_v1_declared(static, initialize),
        "esp_operation_mapping": dict(GROK_METHODS),
        "esp_client_notifications": list(GROK_CLIENT_NOTIFICATIONS),
    }
    for key in ("config_reflections", "g0_observations"):
        if same_build and key in frozen:
            capture[key] = frozen[key]
    return capture


def grok_capability_report(observation: GrokObservation, profile: RuntimeProfile | None = None) -> CapabilityReport:
    """Declarations can show absence. Only protected live evidence could prove a primitive."""
    notes: list[str] = []
    if observation.recorded_from is not None:
        notes.append(
            f"Observation was loaded from the recorded observation file {observation.recorded_from}; "
            "the installed build was not executed."
        )
    if not observation.binary_found:
        notes.append("Candidate binary was not found. Discovery did not install or upgrade one.")
    else:
        notes.append(f"Installed build observed without treating it as proof: {observation.harness_build}")
    if observation.network_isolated is False:
        notes.append("Network namespace isolation was unavailable, so the installed build was not executed.")
    live = observation.static_capture
    frozen = observation.frozen_capture
    frozen_static = None if frozen is None else frozen.get("static")
    exact = live is not None and frozen_static is not None and live == frozen_static
    if live is not None and isinstance(frozen_static, dict):
        if exact:
            digest = _json_digest(cast(dict[str, Any], frozen_static))
            notes.append(
                f"Installed build matches the frozen capture sha256:{digest} "
                "(version, help surface and binary markers)."
            )
        else:
            notes.append(
                "Installed build differs from the frozen capture; the frozen operation mapping does not apply to "
                "this build until it is recaptured and reviewed."
            )
    handshake = observation.acp_initialize
    frozen_handshake = None if frozen is None or not exact else frozen.get("acp_initialize")
    declared_initialize = handshake if handshake is not None else frozen_handshake
    if handshake is not None:
        notes.append("The ACP initialize handshake was re-observed by this run (initialize only).")
    elif isinstance(frozen_handshake, dict):
        notes.append(
            "ACP initialize facts come from the frozen capture; this run started no agent process "
            "(--acp-handshake re-observes them)."
        )
    primitives: list[PrimitiveEvidence] = []
    for name in REQUIRED_PRIMITIVES:
        checks = GROK_DECLARED_PRIMITIVES.get(name)
        state: str = "unproven"
        if checks is not None and live is not None and isinstance(declared_initialize, dict):
            initialize = cast(dict[str, Any], declared_initialize)
            missing = [check for check in checks if not _grok_declared(check, live, initialize)]
            if not missing:
                notes.append(f"{name}: declared ({', '.join(checks)}); a declaration is not runtime proof.")
            elif not exact:
                notes.append(f"{name}: {', '.join(missing)} not found; recapture and review before deciding.")
            elif handshake is None:
                notes.append(f"{name}: {', '.join(missing)} not found; re-observe the handshake before deciding.")
            else:
                state = "absent"
                notes.append(f"{name}: the exact frozen build does not declare {', '.join(missing)}.")
        primitives.append(PrimitiveEvidence.model_validate({"name": name, "state": state, "evidence_ref": None}))
    markers = cast(dict[str, Any], (live or {}).get("markers", {}))
    notes.append(
        "status: ACP declares no per-turn status read; status derives from this connection's own prompt answers "
        "and the build's replayed persisted input; unproven."
    )
    notes.append(
        f"model_context_hook: the build's model-request client names {GROK_SESSION_HEADER} "
        f"(binary marker present={markers.get(GROK_SESSION_HEADER) is True}); the relay attribution hook is "
        "implemented but no live request capture shows the header on custom-endpoint requests."
    )
    notes.append(
        f"mcp_context_hook: the build documents MCP request headers with a {{{{session_id}}}} template, configured "
        f"as {GROK_MCP_SESSION_HEADER}; no live MCP request capture exists."
    )
    notes.append(
        "compaction: the build lists a `compact` command and auto-compacts by context window; compaction requests "
        "through the gateway are unproven."
    )
    notes.append(
        "auxiliary paths: recap, turn summary, title refresh, auto-wake, prompt suggestions, memory and subagents are "
        "disabled in the runtime configuration and auxiliary model slots name an unpinned model; not demonstrated."
    )
    notes.append(
        "tool_policy: deny rules, dontAsk mode and disabled features are configured and the client offers no "
        "file-system or terminal capability; the build does not validate rule tool names, so disablement is not "
        "demonstrated."
    )
    notes.append(
        "storage: sessions persist under GROK_HOME/sessions with cleanup disabled; persistence and resume after "
        "process replacement are unproven."
    )
    if isinstance(declared_initialize, dict):
        auth = cast(list[object], cast(dict[str, Any], declared_initialize).get("authMethodIds", []))
        notes.append(
            f"authentication: the build advertises sign-in methods {sorted(str(item) for item in auth)}; creating "
            "sessions against a custom base_url without signing in is unobserved."
        )
    if observation.config_digest is not None:
        frozen_provenance = ""
        if isinstance(frozen_handshake, dict):
            frozen_provenance = str(cast(dict[str, Any], frozen_handshake).get("provenance", ""))
        if handshake is not None and observation.config_staged:
            loaded = "loaded by this run's agent start (initialize only)"
        elif observation.config_digest in frozen_provenance:
            loaded = "loaded by the agent start of the frozen handshake (initialize only)"
        else:
            # Staged with a handshake is the first branch, so a staged file here served --version and help only.
            if observation.config_staged:
                this_run = "this run staged it for --version and help only"
            else:
                this_run = "this run did not stage it"
            loaded = (
                f"no recorded agent start has loaded this exact file ({this_run}, and the frozen handshake "
                "provenance names no such configuration), so a load failure is still possible; run inspect "
                "--acp-handshake --write-protocol-capture to observe it"
            )
        notes.append(
            f"Runtime configuration sha256:{observation.config_digest}: {loaded}; the build has no strict "
            "configuration mode, so acceptance of each key is not demonstrated."
        )
    if isinstance(frozen, dict) and exact:
        for record in cast(list[object], frozen.get("g0_observations", [])):
            if isinstance(record, dict):
                notes.append(f"G0 observation: {cast(dict[str, Any], record).get('observation')}")
    for error in observation.errors:
        notes.append(f"Discovery error: {error}")
    notes.append(
        "No inference was performed (no model request, no session, no credentials); model access and the xAI model "
        "identifier are unobserved."
    )
    return CapabilityReport(
        provider="xai",
        profile=profile,
        installed_version=observation.version,
        primitives=primitives,
        notes=notes,
    )


def record_qualification(report: QualificationResult, destination: Path, *, synthetic: bool) -> None:
    """Synthetic and fixture evidence never becomes a production qualification row."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if synthetic or (report.evidence_bundle_ref or "").startswith("synthetic:"):
        destination.write_text("[]\n", encoding="utf-8")
        return
    classification = classify_qualification(report)
    row = {
        "provider": report.provider,
        "gate": report.gate,
        "classification": classification,
        "production": False,
    }
    destination.write_text(json.dumps([row], indent=2) + "\n", encoding="utf-8")


def _installed_version(provider: Provider) -> str | None:
    names = _OPENAI_BINARIES if provider == "openai" else _XAI_BINARIES
    for name in names:
        path = shutil.which(name)
        if path is None:
            continue
        try:
            completed = subprocess.run(
                [path, "--version"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        text = (completed.stdout or completed.stderr).strip()
        return text.splitlines()[0] if text else path
    return None


def _report_for(
    command: str,
    provider: Provider,
    *,
    assume_essential_absent: bool,
    capabilities: CapabilityReport | None = None,
    harness_build: str | None = None,
    configuration_digest: str | None = None,
) -> QualificationResult:
    absent = [] if capabilities is None else essential_absences(capabilities)
    essential_absence = assume_essential_absent or bool(absent)
    failed = ["essential_primitive_absent"] if assume_essential_absent else [f"{name}_absent" for name in absent]
    if harness_build is None and command == "inspect":
        harness_build = capabilities.installed_version if capabilities is not None else _installed_version(provider)
    return QualificationResult(
        provider=provider,
        gate=command,
        status="invalidated" if essential_absence else "pending",
        essential_absence=essential_absence,
        failed_criteria=failed,
        harness_build=harness_build,
        configuration_digest=configuration_digest,
        empty_evidence=not essential_absence,
        positive_observation_count=0,
        scenario_ids=[],
        g1a_complete=False,
        g1b_complete=False,
        g2_complete=False,
    )


# ---------------------------------------------------------------------------------------------------
# Isolated qualification packaging, model egress, tool policy and native-writer fencing (Task 13).
#
# `network` and `storage` are G1/G2 prerequisites. They run the live probes in tests/qualification only
# against the recorded disposable qualification cluster, refuse every other kube context, and stay
# pending (exit 2) whenever the environment, the enforced denial or the positive fence is not
# demonstrated. A complete run is a functional prerequisite pass (exit 0); DA-01 stays pending.
# ---------------------------------------------------------------------------------------------------

QUALIFICATION_DIR = ROOT / "infra" / "k8s" / "qualification"
CANDIDATE_POLICY_SCHEMA_PATH = QUALIFICATION_DIR / "candidate-policy.schema.json"
TOOL_POLICY_PATH = ROOT / "infra" / "runtime" / "tool-policy.json"
QUALIFICATION_ENV_VAR = "ESP_QUALIFICATION_ENV"
QUALIFICATION_RESULTS_VAR = "ESP_QUALIFICATION_RESULTS"
QUALIFICATION_PROVIDER_VAR = "ESP_QUALIFICATION_PROVIDER"
IsolationGate = Literal["network", "storage"]
LIVE_PROBE_MODULES: dict[str, tuple[str, ...]] = {
    "network": ("tests/qualification/test_egress.py", "tests/qualification/test_tool_policy.py"),
    "storage": ("tests/qualification/test_storage_fence.py",),
}
REQUIRED_NETWORK_SCENARIOS: tuple[str, ...] = (
    "egress_provider_hostname_denied",
    "egress_provider_ipv4_denied",
    "egress_provider_ipv6_denied",
    "egress_provider_redirect_hop_denied",
    "egress_alternate_model_endpoints_denied",
    "egress_gateway_not_a_forward_proxy",
    "egress_internal_dns_resolved",
    "egress_runtime_dns_internal_only",
    "egress_gateway_path_observed",
    "egress_knowledge_path_observed",
    "tools_offered_only_approved",
    "tools_runtime_shell_absent",
    "tools_runtime_root_read_only",
    "tools_runtime_provider_keys_absent",
    "tools_runtime_signing_keys_absent",
    "control_anonymous_refused",
)
REQUIRED_STORAGE_SCENARIOS: tuple[str, ...] = (
    "fence_lease_expiry_insufficient",
    "fence_replacement_blocked_without_receipt",
    "fence_volume_label_insufficient",
    "fence_positive_receipt",
    "fence_single_writer_after_replacement",
    "fence_force_delete_insufficient",
    "fence_partitioned_writer_revoked",
)
_LIVE_PROBE_TIMEOUT_SECONDS = 3600.0
_KUBECTL_TIMEOUT_SECONDS = 15.0
_PINNED_IMAGE = re.compile(r"@sha256:[0-9a-f]{64}$")
_RUNTIME_ROLE = "harness-runtime"
_ROLE_LABEL = "esp.openedge.dev/role"
_RUNTIME_EGRESS_ROLES = frozenset({"inference-gateway", "knowledge", "telemetry-collector"})
_CLUSTER_SCOPED_KINDS = frozenset(
    {"Namespace", "StorageClass", "CSIDriver", "ClusterRole", "ClusterRoleBinding", "PriorityClass"}
)
_PUBLIC_KINDS = frozenset({"Ingress", "IngressClass", "Gateway", "HTTPRoute", "GRPCRoute", "TLSRoute", "TCPRoute"})
_WORKLOAD_KINDS = frozenset({"Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"})
_PUBLIC_FLAG = re.compile(r"PUBLIC.*(?:ELIGIB|BYPASS)|BYPASS", re.IGNORECASE)
# Address ranges the gateway's public egress must never reach: this-network, private, shared,
# loopback, link-local, multicast and reserved IPv4; IPv4-mapped, NAT64-translated, unique-local,
# link-local and multicast IPv6 (a translated or mapped address can reach a private IPv4 host).
_GATEWAY_EGRESS_RESERVED: tuple[str, ...] = (
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "224.0.0.0/4",
    "240.0.0.0/4",
    "::/128",
    "::1/128",
    "::ffff:0:0/96",
    "64:ff9b::/96",
    "64:ff9b:1::/48",
    "fc00::/7",
    "fe80::/10",
    "ff00::/8",
)


class CandidatePolicyInvalid(ValueError):
    """The recorded candidate policy failed the committed schema or the strict model."""


class QualificationEnvironmentInvalid(ValueError):
    """The qualification environment record is unreadable or malformed."""


class ManifestRenderError(RuntimeError):
    """The qualification manifests could not be rendered offline."""


class DeploymentFailed(RuntimeError):
    """kubectl did not apply the prepared manifests to the recorded context."""


class ContextRefused(Exception):
    """A kube context other than the recorded disposable qualification cluster."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


_IMAGE_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


class InfrastructureIdentity(BaseModel):
    """Exact infrastructure the evidence was collected on. Engineering choices, recorded per run.

    The record is an operator's claim until the cluster confirms it. Before anything is deployed or
    probed, `observe_infrastructure` reads the recorded cluster and `infrastructure_mismatches` refuses
    any difference: the API server's `gitVersion` must equal `kubernetes_version`, the CSIDriver object
    named `csi_driver` must exist and require attachment, and every digest in `cni_image_digests` and
    `csi_image_digests` must belong to a running container. The CNI name and the CSI driver version
    have no API of their own, so those running image digests are what bind them.
    """

    model_config = STRICT
    kubernetes_version: str = Field(min_length=1)
    cni: str = Field(min_length=1)
    cni_image_digests: list[str] = Field(min_length=1)
    storage_class: str = Field(min_length=1)
    csi_driver: str = Field(min_length=1)
    csi_driver_version: str = Field(min_length=1)
    csi_image_digests: list[str] = Field(min_length=1)
    fence_mechanism: Literal["csi-controller-unpublish"]

    @field_validator("cni_image_digests", "csi_image_digests")
    @classmethod
    def _image_digests(cls, values: list[str]) -> list[str]:
        for value in values:
            if _IMAGE_DIGEST.fullmatch(value) is None:
                raise ValueError("image digests must be sha256:<64 lowercase hex>")
        return values


class ObservedInfrastructure(BaseModel):
    """What the recorded cluster reports about itself through the recorded context. Read-only.

    `None` means the value could not be read; it never matches a record.
    """

    model_config = STRICT
    kubernetes_version: str | None
    csi_driver_uid: str | None
    csi_attach_required: bool | None
    running_image_digests: list[str] | None


class ProviderAddresses(BaseModel):
    """Provider endpoint addresses observed outside the cluster, probed as direct-IP bypass attempts."""

    model_config = STRICT
    ipv4: list[str] = Field(min_length=1)
    ipv6: list[str] = Field(min_length=1)

    @field_validator("ipv4")
    @classmethod
    def _ipv4(cls, values: list[str]) -> list[str]:
        for value in values:
            ipaddress.IPv4Address(value)
        return values

    @field_validator("ipv6")
    @classmethod
    def _ipv6(cls, values: list[str]) -> list[str]:
        for value in values:
            ipaddress.IPv6Address(value)
        return values


class WriterIsolation(BaseModel):
    """Operator commands that cut one node off from the control plane and bring it back.

    The partitioned-writer storage scenario needs a writer process that keeps running, and keeps
    landing writes on its volume, while the kubelet cannot stop it. Suitable mechanisms stop the node
    agent (kubelet) and leave the container runtime running, or partition the node's control-plane path
    while its storage path stays up. How that is done is infrastructure specific (for example an SSH
    command or a cloud firewall rule), so the environment records it explicitly.

    Mechanisms that stop or freeze the writer cannot satisfy the scenario: powering off or stopping
    the node (a cloud stop), freezing it (`docker pause` of a kind node), or a partition that also cuts
    the node's storage network. The writer then lands nothing after isolation is confirmed, or stops
    landing writes long before the driver's revocation, so its silence after the receipt proves nothing
    about revocation and `partitioned_writer_outcome` records `inconclusive`.

    Each command is an argv list run without a shell by the live storage probe only; `{node}` is
    replaced by the writer's node name. The probe restores the node whenever it issued an isolate
    command, whether or not the command succeeded or the node was seen to change state.
    """

    model_config = STRICT
    mechanism: str = Field(min_length=1)
    isolate: list[str] = Field(min_length=1)
    restore: list[str] = Field(min_length=1)
    timeout_seconds: float = Field(default=180.0, gt=0, le=1800)

    @field_validator("isolate", "restore")
    @classmethod
    def _names_the_node(cls, argv: list[str]) -> list[str]:
        if not any("{node}" in part for part in argv):
            raise ValueError("isolation commands must name the node through the {node} placeholder")
        return argv

    def command(self, action: Literal["isolate", "restore"], node: str) -> list[str]:
        argv = self.isolate if action == "isolate" else self.restore
        return [part.replace("{node}", node) for part in argv]


class QualificationEnvironment(BaseModel):
    """The explicitly configured disposable qualification environment. Nothing else is deployable."""

    model_config = STRICT
    environment_id: str = Field(pattern=r"^qual-[a-z0-9]+(?:-[a-z0-9]+)*$")
    disposable: Literal[True]
    kube_context: str = Field(min_length=1)
    cluster_uid: UuidStr
    namespace: Literal["esp-qualification"]
    candidate_policy: str = Field(min_length=1)
    images: dict[str, str]
    infrastructure: InfrastructureIdentity
    provider_addresses: dict[Provider, ProviderAddresses]
    evidence_export_dir: str | None = None
    evidence_output_dir: str | None = None
    writer_isolation: WriterIsolation | None = None


@dataclass(frozen=True)
class ObservedContext:
    kubectl: str | None
    current_context: str | None
    cluster_uid: str | None


class EgressAttempt(BaseModel):
    """One connection attempt from inside the runtime pod's network namespace.

    `client_certificate` is true only when the probe presented the runtime's own mounted mTLS
    identity; `request_form` names the proxy request shape (`connect` or `absolute`).
    """

    model_config = STRICT
    scenario: str
    target: str
    resolved: bool
    tcp_connected: bool
    tls_established: bool | None
    http_status: int | None
    error: str | None
    client_certificate: bool = False
    server_verified: bool | None = None
    request_form: Literal["connect", "absolute"] | None = None


LiveOutcome = Literal["satisfied", "violated", "inconclusive"]


class LiveObservation(BaseModel):
    model_config = STRICT
    gate: IsolationGate
    provider: Provider
    environment_id: str
    scenario: str
    outcome: LiveOutcome
    evidence_ref: str = Field(min_length=1)
    detail: str = ""


class JunitSummary(BaseModel):
    model_config = STRICT
    tests: int
    failures: int
    errors: int
    skipped: int


class ToolCategory(BaseModel):
    model_config = STRICT
    description: str
    native_names: dict[Provider, list[str]]


class ModelVisibleTools(BaseModel):
    model_config = STRICT
    allowed_types: list[str] = Field(min_length=1)
    name_pattern: str = Field(min_length=1)
    status: str


class ProviderToolPolicy(BaseModel):
    model_config = STRICT
    harness: str
    configuration: str
    enforcement: Literal["not_demonstrated", "demonstrated"]
    g0_observations: list[str]


class ToolPolicy(BaseModel):
    model_config = STRICT
    policy_format: Literal["esp-tool-policy/1"]
    status: Literal["configured_not_demonstrated", "demonstrated"]
    summary: str
    approved_mcp_server: str
    approved_mcp_tools: list[str]
    model_visible: ModelVisibleTools
    denied_categories: dict[str, ToolCategory]
    enforcement_layers: list[str]
    providers: dict[Provider, ProviderToolPolicy]
    required_live_evidence: list[str]


class OfferedTool(BaseModel):
    model_config = STRICT
    type: str | None = None
    name: str | None = None
    malformed: bool = False


@dataclass
class IsolationGateOutcome:
    report: QualificationResult
    infrastructure: InfrastructureIdentity | None = None
    evidence_dir: Path | None = None
    observed_infrastructure: ObservedInfrastructure | None = None


def _strict_json(raw: bytes | str) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"duplicate key {key!r}")
            result[key] = value
        return result

    return json.loads(raw, object_pairs_hook=pairs)


class _SchemaValidator(Protocol):
    """The part of the jsonschema validator API used here, with an explicit type."""

    def iter_errors(self, instance: object) -> Iterator[Any]: ...


def candidate_policy_errors(document: object) -> list[str]:
    """Errors from the committed JSON Schema; empty when the document conforms."""
    schema = json.loads(CANDIDATE_POLICY_SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = cast(_SchemaValidator, Draft202012Validator(schema))
    errors = validator.iter_errors(document)
    messages: list[str] = []
    for error in errors:
        location = "/".join(str(part) for part in cast(Iterable[object], error.absolute_path)) or "<root>"
        messages.append(f"{location}: {error.message}")
    return sorted(messages)


def load_candidate_policy(raw: bytes) -> CandidateAdmissionPolicy:
    """Both the committed schema and the strict model must accept the recorded policy."""
    try:
        document = _strict_json(raw)
    except ValueError as exc:
        raise CandidatePolicyInvalid("candidate policy is not strict JSON") from exc
    errors = candidate_policy_errors(document)
    if errors:
        raise CandidatePolicyInvalid("; ".join(errors[:5]))
    try:
        return CandidateAdmissionPolicy.model_validate(document)
    except ValidationError as exc:
        raise CandidatePolicyInvalid(f"candidate policy rejected by the model: {exc.error_count()} errors") from exc


def load_qualification_environment(environ: Mapping[str, str]) -> QualificationEnvironment | None:
    """None when no environment is configured; malformed records raise."""
    location = environ.get(QUALIFICATION_ENV_VAR)
    if not location:
        return None
    try:
        return QualificationEnvironment.model_validate(_strict_json(Path(location).read_bytes()))
    except (OSError, ValueError) as exc:
        raise QualificationEnvironmentInvalid(type(exc).__name__) from exc


def environment_digest(environment: QualificationEnvironment) -> str:
    canonical = json.dumps(environment.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode()).hexdigest()


def tool_policy_digest(path: Path = TOOL_POLICY_PATH) -> str:
    return "sha256:" + _file_digest(path)


def observe_kube_context(environment: QualificationEnvironment) -> ObservedContext:
    """Read the current context and the recorded context's cluster identity. Never mutates."""
    kubectl = shutil.which("kubectl")
    if kubectl is None:
        return ObservedContext(kubectl=None, current_context=None, cluster_uid=None)
    current = _kubectl_read([kubectl, "config", "current-context"])
    uid = _kubectl_read(
        [
            kubectl,
            "--context",
            environment.kube_context,
            f"--request-timeout={int(_KUBECTL_TIMEOUT_SECONDS)}s",
            "get",
            "namespace",
            "kube-system",
            "-o",
            "jsonpath={.metadata.uid}",
        ]
    )
    return ObservedContext(kubectl=kubectl, current_context=current, cluster_uid=uid)


def _kubectl_read(argv: list[str]) -> str | None:
    try:
        completed = subprocess.run(
            argv, capture_output=True, text=True, timeout=_KUBECTL_TIMEOUT_SECONDS + 5, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    value = completed.stdout.strip()
    return value if completed.returncode == 0 and value else None


def require_disposable_context(environment: QualificationEnvironment, observed: ObservedContext) -> None:
    """Refuse every context except the recorded disposable cluster, identified by its kube-system UID."""
    if observed.kubectl is None:
        raise ContextRefused("kubectl_unavailable")
    if observed.current_context is None:
        raise ContextRefused("no_current_context")
    if observed.current_context != environment.kube_context:
        raise ContextRefused("context_mismatch")
    if observed.cluster_uid is None:
        raise ContextRefused("cluster_identity_unverified")
    if observed.cluster_uid != environment.cluster_uid:
        raise ContextRefused("cluster_identity_mismatch")


def observe_infrastructure(environment: QualificationEnvironment, kubectl: str) -> ObservedInfrastructure:
    """Read the server version, the CSIDriver object and the running image digests. Never mutates.

    Only call this after `require_disposable_context` accepted the recorded context.
    """
    base = [kubectl, "--context", environment.kube_context, f"--request-timeout={int(_KUBECTL_TIMEOUT_SECONDS)}s"]
    version = _json_object(_kubectl_read([*base, "version", "-o", "json"]))
    server = cast(dict[str, Any], version.get("serverVersion") or {}) if version is not None else {}
    git_version = server.get("gitVersion")
    driver = _json_object(
        _kubectl_read([*base, "get", "csidriver", environment.infrastructure.csi_driver, "-o", "json"])
    )
    driver_uid: str | None = None
    attach_required: bool | None = None
    if driver is not None:
        metadata = cast(dict[str, Any], driver.get("metadata") or {})
        spec = cast(dict[str, Any], driver.get("spec") or {})
        if metadata.get("name") == environment.infrastructure.csi_driver and isinstance(metadata.get("uid"), str):
            driver_uid = str(metadata["uid"])
            attach = spec.get("attachRequired")
            attach_required = attach if isinstance(attach, bool) else None
    pods = _json_object(
        _kubectl_read([*base, "get", "pods", "--all-namespaces", "--field-selector=status.phase=Running", "-o", "json"])
    )
    running: list[str] | None = None
    if pods is not None and isinstance(pods.get("items"), list):
        running = sorted(running_image_digests(cast(list[object], pods["items"])))
    return ObservedInfrastructure(
        kubernetes_version=git_version if isinstance(git_version, str) and git_version else None,
        csi_driver_uid=driver_uid,
        csi_attach_required=attach_required,
        running_image_digests=running,
    )


def _json_object(raw: str | None) -> dict[str, Any] | None:
    if raw is None:
        return None
    try:
        document = json.loads(raw)
    except ValueError:
        return None
    return cast(dict[str, Any], document) if isinstance(document, dict) else None


def running_image_digests(pods: Sequence[object]) -> set[str]:
    """Digests of the images behind containers the kubelet reports running."""
    digests: set[str] = set()
    for pod in pods:
        if not isinstance(pod, dict):
            continue
        status = cast(dict[str, Any], cast(dict[str, Any], pod).get("status") or {})
        for container in cast(list[dict[str, Any]], status.get("containerStatuses") or []):
            if "running" not in cast(dict[str, Any], container.get("state") or {}):
                continue
            for reference in (container.get("imageID"), container.get("image")):
                found = re.search(r"sha256:[0-9a-f]{64}$", str(reference or ""))
                if found is not None:
                    digests.add(found.group(0))
    return digests


def infrastructure_mismatches(identity: InfrastructureIdentity, observed: ObservedInfrastructure) -> list[str]:
    """Every way the cluster differs from the recorded infrastructure; empty only when it all matches."""
    findings: list[str] = []
    if observed.kubernetes_version is None:
        findings.append("kubernetes_version_unobserved")
    elif observed.kubernetes_version != identity.kubernetes_version:
        findings.append(f"kubernetes_version_mismatch:{observed.kubernetes_version}")
    if observed.csi_driver_uid is None:
        findings.append(f"csi_driver_absent:{identity.csi_driver}")
    elif observed.csi_attach_required is not True:
        # Without attachment there is no ControllerUnpublishVolume, so no driver revocation evidence.
        findings.append(f"csi_driver_not_attaching:{identity.csi_driver}")
    if observed.running_image_digests is None:
        findings.append("running_images_unobserved")
    else:
        running = set(observed.running_image_digests)
        findings.extend(
            f"cni_image_not_running:{digest}" for digest in identity.cni_image_digests if digest not in running
        )
        findings.extend(
            f"csi_image_not_running:{digest}" for digest in identity.csi_image_digests if digest not in running
        )
    return findings


def render_qualification_manifests(directory: Path = QUALIFICATION_DIR) -> list[dict[str, Any]]:
    """Offline `kubectl kustomize` render. Contacts no cluster."""
    kubectl = shutil.which("kubectl")
    if kubectl is None:
        raise ManifestRenderError("kubectl unavailable")
    completed = subprocess.run(
        [kubectl, "kustomize", str(directory)], capture_output=True, text=True, timeout=60, check=False
    )
    if completed.returncode != 0:
        raise ManifestRenderError(completed.stderr.strip()[:300])
    documents: list[dict[str, Any]] = []
    for document in yaml.safe_load_all(completed.stdout):
        if isinstance(document, dict):
            documents.append(cast(dict[str, Any], document))
    return documents


def _labels(document: Mapping[str, Any]) -> dict[str, str]:
    return cast(dict[str, str], document.get("metadata", {}).get("labels") or {})


def _name(document: Mapping[str, Any]) -> str:
    return str(document.get("metadata", {}).get("name", "?"))


def _pod_specs(document: Mapping[str, Any]) -> list[tuple[str, dict[str, Any], dict[str, str]]]:
    """(name, pod spec, pod labels) for every workload kind."""
    kind = document.get("kind")
    if kind not in _WORKLOAD_KINDS:
        return []
    spec = cast(dict[str, Any], document.get("spec") or {})
    if kind == "Pod":
        return [(_name(document), spec, _labels(document))]
    if kind == "CronJob":
        spec = cast(dict[str, Any], spec.get("jobTemplate", {}).get("spec") or {})
    template = cast(dict[str, Any], spec.get("template") or {})
    return [(_name(document), cast(dict[str, Any], template.get("spec") or {}), _labels(template))]


def _containers(spec: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [*spec.get("initContainers", []), *spec.get("containers", [])]


def _is_runtime(labels: Mapping[str, str]) -> bool:
    return labels.get(_ROLE_LABEL) == _RUNTIME_ROLE


def _selects(policy: Mapping[str, Any], labels: Mapping[str, str]) -> bool:
    selector = cast(dict[str, Any], policy.get("spec", {}).get("podSelector") or {})
    if selector.get("matchExpressions"):
        return True  # conservatively treat expression selectors as possibly selecting the pod
    match = cast(dict[str, str], selector.get("matchLabels") or {})
    return all(labels.get(key) == value for key, value in match.items())


def _policy_types(policy: Mapping[str, Any]) -> set[str]:
    spec = policy.get("spec", {})
    declared = set(cast(list[str], spec.get("policyTypes") or []))
    if not declared:
        declared.add("Ingress")
        if "egress" in spec:
            declared.add("Egress")
    return declared


def _is_dns_peer(peer: Mapping[str, Any]) -> bool:
    namespace = cast(dict[str, Any], cast(dict[str, Any], peer.get("namespaceSelector") or {}).get("matchLabels") or {})
    pods = cast(dict[str, Any], cast(dict[str, Any], peer.get("podSelector") or {}).get("matchLabels") or {})
    return namespace == {"kubernetes.io/metadata.name": "kube-system"} and pods == {"k8s-app": "kube-dns"}


def _runtime_network_findings(policy: Mapping[str, Any]) -> list[str]:
    name = _name(policy)
    spec = policy.get("spec", {})
    findings: list[str] = []
    types = _policy_types(policy)
    if "Egress" in types:
        for rule in cast(list[dict[str, Any]], spec.get("egress") or []):
            peers = cast(list[dict[str, Any]], rule.get("to") or [])
            ports = cast(list[dict[str, Any]], rule.get("ports") or [])
            if not peers or not ports:
                findings.append(f"runtime_egress_unrestricted:{name}")
                continue
            for peer in peers:
                if _is_dns_peer(peer):
                    if any(port.get("port") != 53 for port in ports):
                        findings.append(f"runtime_egress_unrestricted:{name}")
                    continue
                if "ipBlock" in peer or "namespaceSelector" in peer:
                    findings.append(f"runtime_egress_unrestricted:{name}")
                    continue
                role = cast(dict[str, Any], peer.get("podSelector") or {}).get("matchLabels", {}).get(_ROLE_LABEL)
                if role not in _RUNTIME_EGRESS_ROLES:
                    findings.append(f"runtime_egress_unrestricted:{name}:{role}")
    if "Ingress" in types:
        for rule in cast(list[dict[str, Any]], spec.get("ingress") or []):
            peers = cast(list[dict[str, Any]], rule.get("from") or [])
            ports = cast(list[dict[str, Any]], rule.get("ports") or [])
            backend_only = bool(peers) and all(
                set(peer) == {"podSelector"}
                and cast(dict[str, Any], peer["podSelector"]).get("matchLabels") == {_ROLE_LABEL: "api"}
                for peer in peers
            )
            control_only = bool(ports) and all(port.get("port") in (9443, "control") for port in ports)
            if not (backend_only and control_only):
                findings.append(f"runtime_ingress_unrestricted:{name}")
    return findings


def isolation_findings(documents: Sequence[Mapping[str, Any]]) -> list[str]:
    """Configuration that would expose a candidate or let a runtime escape. Empty means none found.

    This inspects configuration only; it is not evidence that the CNI or the kubelet enforces it.
    """
    findings: list[str] = []
    namespaces = [d for d in documents if d.get("kind") == "Namespace" and _name(d) == QUALIFICATION_NAMESPACE]
    if not namespaces or _labels(namespaces[0]).get("esp.openedge.dev/environment") != "isolated-qualification":
        findings.append("namespace_unlabelled")
    policies = [d for d in documents if d.get("kind") == "NetworkPolicy"]
    default_deny = any(
        not (d.get("spec", {}).get("podSelector") or {})
        and {"Ingress", "Egress"} <= set(d.get("spec", {}).get("policyTypes") or [])
        and not d.get("spec", {}).get("ingress")
        and not d.get("spec", {}).get("egress")
        for d in policies
    )
    if not default_deny:
        findings.append("default_deny_missing")
    for document in documents:
        kind = str(document.get("kind"))
        name = _name(document)
        if kind in _PUBLIC_KINDS:
            findings.append(f"public_ingress:{kind}/{name}")
        namespace = document.get("metadata", {}).get("namespace")
        if kind not in _CLUSTER_SCOPED_KINDS and namespace != QUALIFICATION_NAMESPACE:
            findings.append(f"foreign_namespace:{kind}/{name}")
        if kind == "Service":
            spec = document.get("spec", {})
            if spec.get("type", "ClusterIP") != "ClusterIP" or spec.get("externalIPs"):
                findings.append(f"public_service:{name}")
        if kind == "NetworkPolicy":
            egress_peers = [
                peer
                for rule in cast(list[dict[str, Any]], document.get("spec", {}).get("egress") or [])
                for peer in cast(list[dict[str, Any]], rule.get("to") or [])
            ]
            selector = cast(dict[str, Any], document.get("spec", {}).get("podSelector") or {})
            gateway_only = selector.get("matchLabels") == {_ROLE_LABEL: "inference-gateway"}
            if any("ipBlock" in peer for peer in egress_peers) and not gateway_only:
                findings.append(f"external_egress:{name}")
            findings.extend(_ip_block_findings(name, egress_peers))
        for workload, spec, labels in _pod_specs(document):
            findings.extend(_workload_findings(workload, spec, labels))
            if _is_runtime(labels):
                findings.extend(_runtime_pod_findings(workload, spec))
                for policy in policies:
                    if _selects(policy, labels):
                        findings.extend(_runtime_network_findings(policy))
    return sorted(set(findings))


def _ip_block_findings(name: str, peers: Sequence[Mapping[str, Any]]) -> list[str]:
    """Every reserved range inside an allowed ipBlock must be carved out by one of its exceptions."""
    findings: list[str] = []
    for peer in peers:
        block = cast(dict[str, Any], peer.get("ipBlock") or {})
        if not block:
            continue
        try:
            allowed = ipaddress.ip_network(str(block.get("cidr", "")), strict=False)
            exceptions = cast(list[object], block.get("except") or [])
            excepted = [ipaddress.ip_network(str(item), strict=False) for item in exceptions]
        except ValueError:
            findings.append(f"egress_ip_block_invalid:{name}")
            continue
        for reserved_text in _GATEWAY_EGRESS_RESERVED:
            reserved = ipaddress.ip_network(reserved_text)
            if reserved.version != allowed.version or not _subnet_of(reserved, allowed):
                continue
            if not any(item.version == reserved.version and _subnet_of(reserved, item) for item in excepted):
                findings.append(f"egress_reserved_range_open:{name}:{reserved_text}")
    return findings


IpNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network


def _subnet_of(inner: IpNetwork, outer: IpNetwork) -> bool:
    return (
        inner.version == outer.version
        and int(outer.network_address) <= int(inner.network_address)
        and int(inner.broadcast_address) <= int(outer.broadcast_address)
    )


def _workload_findings(name: str, spec: Mapping[str, Any], labels: Mapping[str, str]) -> list[str]:
    findings: list[str] = []
    if spec.get("hostNetwork"):
        findings.append(f"host_network:{name}")
    if spec.get("hostPID") or spec.get("hostIPC"):
        findings.append(f"host_namespace:{name}")
    role = labels.get(_ROLE_LABEL)
    if role is not None and not _mounts_mtls_identity(spec):
        findings.append(f"mtls_identity_missing:{name}")
    for volume in cast(list[dict[str, Any]], spec.get("volumes") or []):
        if "hostPath" in volume:
            findings.append(f"host_path:{name}/{volume.get('name')}")
        secret = str(cast(dict[str, Any], volume.get("secret") or {}).get("secretName", ""))
        if "provider-credentials" in secret and role != "inference-gateway":
            findings.append(f"provider_credentials_outside_gateway:{name}")
        if "signing-key" in secret and role != "api":
            findings.append(f"signing_key_outside_backend:{name}")
    for container in _containers(spec):
        context = cast(dict[str, Any], container.get("securityContext") or {})
        if context.get("privileged"):
            findings.append(f"privileged:{name}/{container.get('name')}")
        if any("hostPort" in port for port in cast(list[dict[str, Any]], container.get("ports") or [])):
            findings.append(f"host_port:{name}/{container.get('name')}")
        for variable in cast(list[dict[str, Any]], container.get("env") or []):
            if _PUBLIC_FLAG.search(str(variable.get("name", ""))):
                findings.append(f"public_eligibility_flag:{name}/{variable.get('name')}")
            ref = cast(dict[str, Any], cast(dict[str, Any], variable.get("valueFrom") or {}).get("secretKeyRef") or {})
            if "provider-credentials" in str(ref.get("name", "")) and role != "inference-gateway":
                findings.append(f"provider_credentials_outside_gateway:{name}")
    return findings


_MTLS_MOUNT_PATH = "/etc/esp/mtls"


def _mounts_mtls_identity(spec: Mapping[str, Any]) -> bool:
    """Every container mounts a Secret read-only at the mTLS identity path."""
    volumes = cast(list[dict[str, Any]], spec.get("volumes") or [])
    secrets = {str(volume.get("name")) for volume in volumes if "secret" in volume}
    containers = _containers(spec)
    return bool(containers) and all(
        any(
            mount.get("mountPath") == _MTLS_MOUNT_PATH
            and mount.get("readOnly") is True
            and str(mount.get("name")) in secrets
            for mount in cast(list[dict[str, Any]], container.get("volumeMounts") or [])
        )
        for container in containers
    )


def _runtime_pod_findings(name: str, spec: Mapping[str, Any]) -> list[str]:
    findings: list[str] = []
    pod_context = cast(dict[str, Any], spec.get("securityContext") or {})
    if pod_context.get("runAsNonRoot") is not True or pod_context.get("runAsUser") in (0, None):
        findings.append(f"runtime_user:{name}")
    if spec.get("automountServiceAccountToken") is not False:
        findings.append(f"service_account_token:{name}")
    volumes = {str(v.get("name")): v for v in cast(list[dict[str, Any]], spec.get("volumes") or [])}
    for volume_name, volume in volumes.items():
        if not ({"persistentVolumeClaim", "secret", "configMap", "projected"} & set(volume)):
            findings.append(f"runtime_writable_mount:{name}/{volume_name}")
    for container in _containers(spec):
        container_name = str(container.get("name"))
        context = cast(dict[str, Any], container.get("securityContext") or {})
        if context.get("readOnlyRootFilesystem") is not True:
            findings.append(f"writable_root:{name}/{container_name}")
        if context.get("allowPrivilegeEscalation") is not False:
            findings.append(f"privilege_escalation:{name}/{container_name}")
        if "ALL" not in cast(list[str], cast(dict[str, Any], context.get("capabilities") or {}).get("drop") or []):
            findings.append(f"capabilities:{name}/{container_name}")
        if context.get("runAsUser") == 0:
            findings.append(f"runtime_user:{name}")
        for variable in cast(list[dict[str, Any]], container.get("env") or []):
            if "secretKeyRef" in cast(dict[str, Any], variable.get("valueFrom") or {}):
                findings.append(f"runtime_secret_env:{name}/{variable.get('name')}")
            if forbidden_runtime_material({str(variable.get("name", "")): str(variable.get("value", ""))}):
                findings.append(f"runtime_secret_env:{name}/{variable.get('name')}")
        if any("secretRef" in source for source in cast(list[dict[str, Any]], container.get("envFrom") or [])):
            findings.append(f"runtime_secret_env:{name}/envFrom")
        for mount in cast(list[dict[str, Any]], container.get("volumeMounts") or []):
            volume = volumes.get(str(mount.get("name")), {})
            if "persistentVolumeClaim" in volume:
                continue
            if mount.get("readOnly") is not True:
                findings.append(f"runtime_writable_mount:{name}/{mount.get('name')}")
    return findings


def prepare_qualification_manifests(
    documents: Sequence[Mapping[str, Any]], environment: QualificationEnvironment
) -> list[dict[str, Any]]:
    """Substitute the recorded digest-pinned images and the recorded CSI driver. Pure."""
    prepared = [copy.deepcopy(dict(document)) for document in documents]
    for document in prepared:
        if document.get("kind") == "StorageClass" and _name(document) == environment.infrastructure.storage_class:
            document["provisioner"] = environment.infrastructure.csi_driver
        for _, spec, _ in _pod_specs(document):
            for container in _containers(spec):
                image = str(container.get("image", ""))
                if image in environment.images:
                    container["image"] = environment.images[image]
    return prepared


def deploy_readiness_findings(
    documents: Sequence[Mapping[str, Any]], environment: QualificationEnvironment, policy: CandidateAdmissionPolicy
) -> list[str]:
    """Reasons the rendered manifests may not be applied to the recorded environment."""
    findings = list(isolation_findings(documents))
    if policy.deployment.cluster_uid != environment.cluster_uid:
        findings.append("policy_cluster_mismatch")
    storage_class = environment.infrastructure.storage_class
    classes = [d for d in documents if d.get("kind") == "StorageClass" and _name(d) == storage_class]
    if not classes:
        findings.append(f"storage_class_missing:{storage_class}")
    else:
        provisioner = str(classes[0].get("provisioner", ""))
        if provisioner != environment.infrastructure.csi_driver:
            state = "unselected" if provisioner.endswith(".invalid") else "mismatch"
            findings.append(f"storage_provisioner_{state}:{provisioner}")
    for document in documents:
        if document.get("kind") == "PersistentVolumeClaim":
            if document.get("spec", {}).get("storageClassName") != storage_class:
                findings.append(f"storage_class_mismatch:{_name(document)}")
        for workload, spec, labels in _pod_specs(document):
            for container in _containers(spec):
                image = str(container.get("image", ""))
                if _PINNED_IMAGE.search(image) is None:
                    findings.append(f"image_not_pinned:{image}")
                    continue
                if _is_runtime(labels):
                    provider = labels.get("esp.openedge.dev/provider")
                    digest = image.rsplit("@", 1)[1]
                    allowed = {runtime.image_digest for runtime in policy.runtimes if runtime.provider == provider}
                    if digest not in allowed:
                        findings.append(f"runtime_image_not_allowlisted:{workload}")
    return sorted(set(findings))


def _dockerfile_instructions(text: str) -> list[tuple[str, str]]:
    instructions: list[tuple[str, str]] = []
    buffer = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.endswith("\\"):
            buffer += line[:-1] + " "
            continue
        buffer += line
        keyword, _, rest = buffer.partition(" ")
        instructions.append((keyword.upper(), rest.strip()))
        buffer = ""
    if buffer:
        keyword, _, rest = buffer.partition(" ")
        instructions.append((keyword.upper(), rest.strip()))
    return instructions


def _declared_names(keyword: str, rest: str) -> dict[str, str]:
    if keyword == "ARG":
        name, _, value = rest.partition("=")
        return {name.strip(): value.strip()}
    pairs = re.findall(r'([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|\S*)', rest)
    if pairs:
        return {name: value.strip('"') for name, value in pairs}
    name, _, value = rest.partition(" ")
    return {name: value}


def runtime_image_findings(dockerfile: str, *, harness: Literal["codex", "grok-build"]) -> list[str]:
    """Pinned bases, the exact harness digest, a numeric non-root user, no credentials, no network fetch."""
    expected = CODEX_NATIVE_SHA256 if harness == "codex" else GROK_NATIVE_SHA256
    config = "infra/runtime/codex/config.toml" if harness == "codex" else "infra/runtime/grok/config.toml"
    instructions = _dockerfile_instructions(dockerfile)
    findings: list[str] = []
    stages: set[str] = set()
    final: list[tuple[str, str]] = []
    for keyword, rest in instructions:
        if keyword == "FROM":
            parts = [part for part in rest.split() if not part.startswith("--")]
            reference = parts[0] if parts else ""
            if reference not in stages and _PINNED_IMAGE.search(reference) is None:
                findings.append(f"base_not_pinned:{reference}")
            if len(parts) >= 3 and parts[1].upper() == "AS":
                stages.add(parts[2])
            final = []
            continue
        final.append((keyword, rest))
        if keyword in ("ENV", "ARG"):
            for name in forbidden_runtime_material(_declared_names(keyword, rest)):
                findings.append(f"secret_in_image:{name}")
        if keyword == "RUN":
            lowered = rest.lower()
            unpinned_pip = "pip install" in lowered and "--no-index" not in lowered
            if re.search(r"\b(curl|wget)\b|git clone", lowered) or unpinned_pip:
                findings.append(f"network_fetch:{rest[:60]}")
            for command in re.split(r"&&|;|\|\|", lowered):
                if "pip install" in command and "--require-hashes" not in command:
                    findings.append(f"unhashed_pip_install:{' '.join(command.split())[:200]}")
            if "apt-get update" in lowered and "--snapshot" not in lowered:
                findings.append("unpinned_packages")
        if keyword == "ADD" and re.search(r"https?://", rest):
            findings.append(f"network_fetch:{rest[:60]}")
    if not any(keyword == "RUN" and expected in rest and "sha256sum --check" in rest for keyword, rest in instructions):
        findings.append("harness_digest_unverified")
    users = [rest for keyword, rest in final if keyword == "USER"]
    if not users or re.fullmatch(r"[1-9][0-9]*:[1-9][0-9]*", users[-1]) is None:
        findings.append(f"user_not_numeric_non_root:{users[-1] if users else 'missing'}")
    entrypoints = [rest for keyword, rest in final if keyword == "ENTRYPOINT"]
    if not entrypoints or not entrypoints[-1].startswith("["):
        findings.append("entrypoint_not_exec_form")
    copies = " ".join(rest for keyword, rest in final if keyword == "COPY")
    if config not in copies:
        findings.append("runtime_config_not_packaged")
    if "infra/runtime/tool-policy.json" not in copies:
        findings.append("tool_policy_not_packaged")
    runs = [rest for keyword, rest in final if keyword == "RUN"]
    findings.extend(_shell_removal_findings(runs[-1] if runs else None))
    return sorted(set(findings))


# Every shell binary the Ubuntu base ships, under both halves of the merged /usr. Removing them is
# defence in depth: interpreters such as python3 (the runtime entry) and perl-base remain, so the tool
# policy and its live checks, not the absence of interpreters, keep a tool from running commands.
RUNTIME_SHELL_PATHS: tuple[str, ...] = (
    "/bin/sh",
    "/bin/bash",
    "/bin/dash",
    "/bin/rbash",
    "/usr/bin/sh",
    "/usr/bin/bash",
    "/usr/bin/dash",
    "/usr/bin/rbash",
)


def _shell_removal_findings(last_run: str | None) -> list[str]:
    """The final RUN must be an exec-form `rm` (it cannot need a shell) naming every shell binary."""
    try:
        parsed: object = json.loads(last_run) if last_run is not None and last_run.startswith("[") else None
    except ValueError:
        parsed = None
    argv = [str(item) for item in cast(list[object], parsed)] if isinstance(parsed, list) else []
    if not argv or argv[0].rsplit("/", 1)[-1] != "rm":
        return ["shell_not_removed"]
    removed = set(argv[1:])
    return [f"shell_not_removed:{path}" for path in RUNTIME_SHELL_PATHS if path not in removed]


# Connect-level failures that mean no TCP session left the pod: a dropped SYN (timeout), a local
# unreachable or permission refusal, or no route/stack for the address family at all. A reset or a
# refusal is not on this list: it can come from the remote host, which means packets left the cluster.
_DENIAL_ERRORS = frozenset(
    {
        "timeout",
        "host_unreachable",
        "network_unreachable",
        "permission_denied",
        "address_family_unsupported",
        "address_unavailable",
    }
)
_NAME_UNRESOLVED = "name_unresolved"
_PROXY_REQUEST_FORMS = frozenset({"connect", "absolute"})


def classify_egress_attempt(attempt: EgressAttempt) -> Literal["denied", "reached", "dns_only", "inconclusive"]:
    """Any completed connection or HTTP status is `reached`, a provider 401 included.

    A name that did not resolve is `dns_only`: nothing was attempted at the IP level, so split DNS
    alone would look like a denial. It never counts as enforced egress denial.
    """
    if attempt.tcp_connected or attempt.tls_established or attempt.http_status is not None:
        return "reached"
    if attempt.error == _NAME_UNRESOLVED:
        return "dns_only"
    if attempt.error in _DENIAL_ERRORS:
        return "denied"
    return "inconclusive"


def direct_egress_outcome(attempts: Sequence[EgressAttempt]) -> LiveOutcome:
    """A direct-model scenario: any reach violates; otherwise every IP-level attempt must be denied."""
    classes = [classify_egress_attempt(attempt) for attempt in attempts]
    if "reached" in classes:
        return "violated"
    ip_level = [item for item in classes if item != "dns_only"]
    if ip_level and all(item == "denied" for item in ip_level):
        return "satisfied"
    return "inconclusive"


def forward_proxy_outcome(attempts: Sequence[EgressAttempt]) -> LiveOutcome:
    """The gateway must refuse CONNECT and absolute-form proxying from an authenticated runtime.

    Only an HTTP-level 4xx returned over a TLS session in which the probe presented the runtime's own
    mTLS identity is a refusal. A failed handshake, a post-connect timeout, an anonymous caller or a
    `407` (a proxy asking for credentials) proves nothing either way. A 1xx/2xx answer is proxying.
    """
    if any(attempt.http_status is not None and attempt.http_status < 300 for attempt in attempts):
        return "violated"
    refused = [
        attempt
        for attempt in attempts
        if attempt.client_certificate
        and attempt.tls_established
        and attempt.http_status is not None
        and 400 <= attempt.http_status < 500
        and attempt.http_status != 407
    ]
    forms = {attempt.request_form for attempt in refused}
    if attempts and len(refused) == len(attempts) and _PROXY_REQUEST_FORMS <= forms:
        return "satisfied"
    return "inconclusive"


def dns_internal_only_outcome(attempts: Sequence[EgressAttempt]) -> LiveOutcome:
    """Runtime DNS serves cluster names only: every external name must fail to resolve in the pod.

    External resolution through the cluster resolver is a DNS exfiltration channel. It is recorded as
    inconclusive (the restriction is not demonstrated) rather than as a model-egress bypass.
    """
    if attempts and all(not attempt.resolved and attempt.error == _NAME_UNRESOLVED for attempt in attempts):
        return "satisfied"
    return "inconclusive"


class KeyFindings(BaseModel):
    model_config = STRICT
    provider: list[str]
    signing: list[str]


class KeyProbeReport(BaseModel):
    """`esp_provider_shared.runtime_main.key_material_report` as printed by the runtime-container probe."""

    model_config = STRICT
    roots: list[str]
    environment: KeyFindings
    files: KeyFindings
    scanned_files: int
    unreadable: int
    truncated: bool


@dataclass(frozen=True)
class ScenarioVerdict:
    outcome: LiveOutcome
    findings: list[str]


_SIGNING_SPEC_NAME = re.compile(r"SIGNING|PRIVATE", re.IGNORECASE)


def key_material_outcomes(
    spec_findings: Sequence[str], report: KeyProbeReport | Mapping[str, Any]
) -> tuple[ScenarioVerdict, ScenarioVerdict]:
    """(provider keys absent, signing keys absent). Any finding violates; a truncated scan is inconclusive."""
    probe = report if isinstance(report, KeyProbeReport) else KeyProbeReport.model_validate(report)
    provider = [f"pod_spec:{item}" for item in spec_findings if not _SIGNING_SPEC_NAME.search(item)]
    signing = [f"pod_spec:{item}" for item in spec_findings if _SIGNING_SPEC_NAME.search(item)]
    provider += [f"environment:{name}" for name in probe.environment.provider]
    provider += [f"file:{path}" for path in probe.files.provider]
    signing += [f"environment:{name}" for name in probe.environment.signing]
    signing += [f"file:{path}" for path in probe.files.signing]

    def verdict(findings: list[str]) -> ScenarioVerdict:
        if findings:
            return ScenarioVerdict("violated", findings)
        return ScenarioVerdict("inconclusive" if probe.truncated else "satisfied", findings)

    return verdict(provider), verdict(signing)


WRITER_ACTIVITY_WINDOW_SECONDS = 5.0


def writer_recently_active(
    entries: Sequence[tuple[str, float]],
    incarnation: str,
    *,
    now: float,
    window: float = WRITER_ACTIVITY_WINDOW_SECONDS,
) -> bool:
    """The writer appended to the volume within `window` seconds of `now`, both read on its own node."""
    times = [at for who, at in entries if who == incarnation]
    return bool(times) and 0.0 <= now - max(times) <= window


def writes_after_receipt(
    entries: Sequence[tuple[str, float]], incarnation: str, *, receipt_at: float, skew: float
) -> list[tuple[str, float]]:
    """Entries the obsolete writer landed on the volume after its fence receipt (beyond clock skew)."""
    return [(who, at) for who, at in entries if who == incarnation and at > receipt_at + skew]


def insufficient_signal_outcome(
    *, receipt_issued: bool, writer_alive_before: bool, writer_alive_after: bool
) -> LiveOutcome:
    """An insufficient signal (expired lease, relabelled claim) observed while the writer runs.

    The verdict is only meaningful while the writer is demonstrably alive before and after the fence
    attempt: a writer that died on its own is legitimately fenced, so its receipt is no violation.
    """
    if not (writer_alive_before and writer_alive_after):
        return "inconclusive"
    return "violated" if receipt_issued else "satisfied"


def replacement_blocked_outcome(
    *, receipt_issued: bool, replacement_ran: bool, writer_alive_before: bool, writer_alive_after: bool
) -> LiveOutcome:
    """Without a receipt a replacement must not run on the volume while the first writer runs."""
    if not (writer_alive_before and writer_alive_after):
        return "inconclusive"
    if replacement_ran or receipt_issued:
        return "violated"
    return "satisfied"


def force_delete_outcome(
    *, isolated: bool, writer_alive_before: bool, early_receipt: bool, late_writes: int
) -> LiveOutcome:
    """A force-deleted pod on an isolated node: the vanished pod object must not produce a receipt."""
    if early_receipt and late_writes:
        return "violated"
    if not (isolated and writer_alive_before) or early_receipt:
        return "inconclusive"
    return "satisfied"


def partitioned_writer_outcome(
    *,
    isolated_at: float | None,
    revoked_at: float | None,
    obsolete_writes: Sequence[float] | None,
    receipt_issued: bool,
    replacement_wrote: bool,
    late_writes: int,
    window: float,
    skew: float,
) -> LiveOutcome:
    """A writer the kubelet cannot stop is fenced only by driver revocation: no write lands after the receipt.

    Silence after the receipt shows revocation only if the obsolete writer was demonstrably still
    running, with a working storage path, until the driver revoked its access. The evidence:

    - `isolated_at`: when the writer's node was first observed not Ready (the probe's clock), or None;
    - `revoked_at`: when the fence observed the driver's `volume_access_revoked` (the probe's clock), or None;
    - `obsolete_writes`: the times of the obsolete writer's lines read on a fresh mount after every
      writer has gone (the writer's clock), or None when the volume could not be read;
    - `late_writes`: how many of those lines landed after the receipt (beyond clock skew).

    `satisfied` needs a receipt, a replacement that wrote on another node, no late write, at least one
    landed write after `isolated_at + skew`, and a last landed write no earlier than
    `revoked_at - window - skew`. A writer that was stopped or frozen with its node (a cloud stop,
    `docker pause`) lands nothing after isolation; a writer whose storage path was cut with its control
    path stops landing long before the revocation. Neither proves that the driver revoked anything, so
    both are `inconclusive`. Any late write is `violated`.
    """
    if late_writes:
        return "violated"
    if not (receipt_issued and replacement_wrote):
        return "inconclusive"
    if isolated_at is None or revoked_at is None or obsolete_writes is None or revoked_at <= isolated_at:
        return "inconclusive"
    after_isolation = [at for at in obsolete_writes if at > isolated_at + skew]
    if not after_isolation or max(after_isolation) < revoked_at - window - skew:
        return "inconclusive"
    return "satisfied"


def load_tool_policy(path: Path = TOOL_POLICY_PATH) -> ToolPolicy:
    return ToolPolicy.model_validate(_strict_json(path.read_bytes()))


def offered_tools(body: bytes) -> list[OfferedTool] | None:
    """Tools a final model request offers. None when the request body is not strict JSON."""
    try:
        document = _strict_json(body)
    except ValueError:
        return None
    if not isinstance(document, dict):
        return None
    tools = cast(dict[str, Any], document).get("tools", [])
    if not isinstance(tools, list):
        return [OfferedTool(malformed=True)]
    offered: list[OfferedTool] = []
    for entry in cast(list[object], tools):
        if not isinstance(entry, dict):
            offered.append(OfferedTool(malformed=True))
            continue
        item = cast(dict[str, Any], entry)
        function = item.get("function")
        name = item.get("name")
        if name is None and isinstance(function, dict):
            name = cast(dict[str, Any], function).get("name")
        kind = item.get("type")
        offered.append(
            OfferedTool(type=kind if isinstance(kind, str) else None, name=name if isinstance(name, str) else None)
        )
    return offered


def tool_policy_violations(offered: Sequence[OfferedTool] | None, policy: ToolPolicy) -> list[str]:
    if offered is None:
        return ["request_unparseable"]
    pattern = re.compile(policy.model_visible.name_pattern)
    violations: list[str] = []
    for tool in offered:
        if tool.malformed:
            violations.append("malformed_tool_entry")
        elif tool.type not in policy.model_visible.allowed_types:
            violations.append(f"builtin_tool:{tool.type}")
        elif tool.name is None or pattern.fullmatch(tool.name) is None:
            violations.append(f"unapproved_tool:{tool.name}")
    return violations


def approved_tool_names(offered: Sequence[OfferedTool] | None, policy: ToolPolicy) -> list[str]:
    """Offered tools that are approved read-only knowledge tools under the policy's name rule."""
    if offered is None:
        return []
    pattern = re.compile(policy.model_visible.name_pattern)
    return [
        tool.name
        for tool in offered
        if not tool.malformed
        and tool.type in policy.model_visible.allowed_types
        and tool.name is not None
        and pattern.fullmatch(tool.name) is not None
    ]


FINAL_REQUEST_EXPORT_FORMAT = "esp-final-request-export/1"
FINAL_REQUEST_INDEX = "index.json"


class FinalRequestEntry(BaseModel):
    """One final model request the gateway recorded, as exported from its protected evidence.

    `request_sha256` is the gateway proof's plaintext request digest (EvidenceRecorder) and
    `proof_ref` locates that proof, so an auditor can tie the body back to the gateway's record.
    """

    model_config = STRICT
    inference_id: str = Field(pattern=r"^inf_[0-9a-f]{32}$")
    captured_at: AwareDatetime
    request_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    body: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*\.json$")
    proof_ref: str = Field(min_length=1)


class FinalRequestExport(BaseModel):
    """`<evidence_export_dir>/<provider>/index.json`: the export of one runtime's final requests."""

    model_config = STRICT
    export_format: Literal["esp-final-request-export/1"]
    environment_id: str = Field(min_length=1)
    provider: Provider
    runtime_image_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    exported_at: AwareDatetime
    requests: list[FinalRequestEntry]


class JudgedRequest(BaseModel):
    model_config = STRICT
    inference_id: str
    body: str
    proof_ref: str
    sha256: str | None
    captured_at: datetime
    bound: bool
    problems: list[str]
    violations: list[str]
    approved_tools: list[str]


class OfferedToolsJudgement(BaseModel):
    model_config = STRICT
    outcome: LiveOutcome
    reasons: list[str]
    requests: list[JudgedRequest]


def judge_offered_tools(
    export_dir: Path,
    *,
    provider: Provider,
    environment_id: str,
    runtime_image_digest: str,
    not_before: datetime,
    now: datetime,
    policy: ToolPolicy,
) -> OfferedToolsJudgement:
    """Judge the final requests that the gateway captured for this environment's running runtime.

    Only bodies listed in the gateway export index count, and only when the export names this
    environment, provider and running runtime image, each body's SHA-256 equals the digest the gateway
    recorded, and its capture time lies within the running runtime's lifetime (`not_before`..`now`).
    Any bound body offering an unapproved tool violates. The scenario is satisfied only when every
    listed body is bound and at least one offers an approved knowledge tool; otherwise inconclusive.
    """
    directory = export_dir / provider
    try:
        export = FinalRequestExport.model_validate(_strict_json((directory / FINAL_REQUEST_INDEX).read_bytes()))
    except OSError:
        return OfferedToolsJudgement(outcome="inconclusive", reasons=["export_index_missing"], requests=[])
    except ValueError:
        return OfferedToolsJudgement(outcome="inconclusive", reasons=["export_index_invalid"], requests=[])
    reasons: list[str] = []
    if export.environment_id != environment_id:
        reasons.append("export_environment_mismatch")
    if export.provider != provider:
        reasons.append("export_provider_mismatch")
    if export.runtime_image_digest != runtime_image_digest:
        reasons.append("export_runtime_image_mismatch")
    if reasons:
        return OfferedToolsJudgement(outcome="inconclusive", reasons=reasons, requests=[])
    if not export.requests:
        return OfferedToolsJudgement(outcome="inconclusive", reasons=["no_final_requests"], requests=[])
    seen: set[str] = set()
    judged: list[JudgedRequest] = []
    for entry in export.requests:
        problems: list[str] = []
        if entry.inference_id in seen:
            problems.append("duplicate_inference_id")
        seen.add(entry.inference_id)
        if entry.captured_at < not_before:
            problems.append("captured_before_runtime_start")
        if entry.captured_at > now:
            problems.append("captured_after_judgement")
        try:
            body = (directory / entry.body).read_bytes()
        except OSError:
            body = None
            problems.append("body_missing")
        digest = hashlib.sha256(body).hexdigest() if body is not None else None
        if digest is not None and digest != entry.request_sha256:
            problems.append("body_digest_mismatch")
        bound = not problems and body is not None
        offered = offered_tools(body) if bound and body is not None else None
        judged.append(
            JudgedRequest(
                inference_id=entry.inference_id,
                body=entry.body,
                proof_ref=entry.proof_ref,
                sha256=digest,
                captured_at=entry.captured_at,
                bound=bound,
                problems=problems,
                violations=tool_policy_violations(offered, policy) if bound else [],
                approved_tools=approved_tool_names(offered, policy) if bound else [],
            )
        )
    if any(item.violations for item in judged):
        return OfferedToolsJudgement(outcome="violated", reasons=["unapproved_tool_offered"], requests=judged)
    reasons = sorted({f"{item.inference_id}:{problem}" for item in judged for problem in item.problems})
    if not any(item.approved_tools for item in judged):
        reasons.append("no_approved_tool_offered")
    outcome: LiveOutcome = "inconclusive" if reasons else "satisfied"
    return OfferedToolsJudgement(outcome=outcome, reasons=reasons, requests=judged)


def read_junit(path: Path) -> JunitSummary:
    """Totals from a pytest JUnit XML report. A missing or unreadable report is an empty run."""
    try:
        root = ElementTree.parse(path).getroot()
    except (OSError, ElementTree.ParseError):
        return JunitSummary(tests=0, failures=0, errors=0, skipped=0)
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    totals = {"tests": 0, "failures": 0, "errors": 0, "skipped": 0}
    for suite in suites:
        for key in totals:
            totals[key] += int(suite.get(key, "0"))
    return JunitSummary(**totals)


def read_live_observations(path: Path) -> list[LiveObservation]:
    if not path.exists():
        return []
    observations: list[LiveObservation] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            observations.append(LiveObservation.model_validate_json(line))
    return observations


def evaluate_live_evidence(
    gate: IsolationGate,
    provider: Provider,
    observations: Sequence[LiveObservation],
    junit: JunitSummary,
    environment: QualificationEnvironment,
    policy: CandidateAdmissionPolicy,
) -> QualificationResult:
    """Functional prerequisite pass only with every scenario positively satisfied and a clean run.

    A demonstrated bypass or second writer invalidates; anything missing, skipped or inconclusive is
    pending. DA-01 itself stays pending either way.
    """
    required = REQUIRED_NETWORK_SCENARIOS if gate == "network" else REQUIRED_STORAGE_SCENARIOS
    relevant = [
        item
        for item in observations
        if item.gate == gate and item.provider == provider and item.environment_id == environment.environment_id
    ]
    violated = sorted({item.scenario for item in relevant if item.outcome == "violated"})
    satisfied = {item.scenario for item in relevant if item.outcome == "satisfied"} - set(violated)
    missing = [scenario for scenario in required if scenario not in satisfied and scenario not in violated]
    incomplete = junit.tests == 0 or junit.failures > 0 or junit.errors > 0 or junit.skipped > 0
    failed = [f"{scenario}_violated" for scenario in violated] + [f"{scenario}_missing" for scenario in missing]
    if incomplete:
        failed.append("live_probe_run_incomplete")
    infrastructure = environment.infrastructure
    storage_profile = (
        f"kubernetes/{infrastructure.fence_mechanism}:{infrastructure.csi_driver}@{infrastructure.csi_driver_version}"
        f"/{infrastructure.storage_class}/ReadWriteOncePod"
    )
    return QualificationResult(
        provider=provider,
        gate=gate,
        status="invalidated" if violated else "pending",
        functional_subgate_pass=not violated and not missing and not incomplete,
        failed_criteria=failed,
        scenario_ids=sorted(satisfied & set(required)),
        positive_observation_count=sum(
            1 for item in relevant if item.outcome == "satisfied" and item.scenario in required
        ),
        environment_digest=environment_digest(environment),
        allowlist_digest=policy_digest(policy),
        storage_profile=storage_profile if gate == "storage" else None,
        tool_policy_digest=tool_policy_digest() if gate == "network" else None,
        skipped=junit.skipped > 0,
        empty_evidence=not relevant,
    )


def deploy_qualification(
    environment: QualificationEnvironment,
    observed: ObservedContext,
    documents: Sequence[Mapping[str, Any]],
    policy_raw: bytes,
) -> None:
    """Server-side apply to the recorded context only; the caller already verified that context."""
    require_disposable_context(environment, observed)
    assert observed.kubectl is not None
    configmap = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": "esp-candidate-policy",
            "namespace": environment.namespace,
            "labels": {"app.kubernetes.io/part-of": "esp"},
        },
        "data": {"policy.json": policy_raw.decode()},
    }
    payload = yaml.safe_dump_all([*documents, configmap], sort_keys=False)
    completed = subprocess.run(
        [
            observed.kubectl,
            "--context",
            environment.kube_context,
            "apply",
            "--server-side",
            "--field-manager=esp-qualify",
            "-f",
            "-",
        ],
        input=payload,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    if completed.returncode != 0:
        raise DeploymentFailed(completed.stderr.strip()[:300])


def run_live_probes(
    gate: IsolationGate, provider: Provider, environment_path: Path, run_dir: Path
) -> tuple[list[LiveObservation], JunitSummary]:
    """Run the live qualification modules against the recorded environment; never as ordinary pytest."""
    results = run_dir / "observations.jsonl"
    junit = run_dir / "junit.xml"
    env = dict(os.environ)
    env.update(
        {
            QUALIFICATION_ENV_VAR: str(environment_path),
            QUALIFICATION_RESULTS_VAR: str(results),
            QUALIFICATION_PROVIDER_VAR: provider,
        }
    )
    argv = [
        sys.executable,
        "-m",
        "pytest",
        *[str(ROOT / module) for module in LIVE_PROBE_MODULES[gate]],
        "-p",
        "no:cacheprovider",
        "-o",
        "addopts=",
        f"--junitxml={junit}",
        "-q",
    ]
    try:
        completed = subprocess.run(
            argv, cwd=ROOT, env=env, capture_output=True, text=True, timeout=_LIVE_PROBE_TIMEOUT_SECONDS, check=False
        )
        (run_dir / "pytest.log").write_text(completed.stdout + completed.stderr, encoding="utf-8")
    except subprocess.TimeoutExpired:
        (run_dir / "pytest.log").write_text("live probes timed out\n", encoding="utf-8")
    try:
        observations = read_live_observations(results)
    except ValueError:
        observations = []
    return observations, read_junit(junit)


def _pending_isolation(gate: IsolationGate, provider: Provider, failed: list[str]) -> QualificationResult:
    return QualificationResult(
        provider=provider,
        gate=gate,
        status="pending",
        failed_criteria=failed,
        empty_evidence=True,
        positive_observation_count=0,
        scenario_ids=[],
    )


def run_isolation_gate(
    gate: IsolationGate, provider: Provider, *, deploy: bool, environ: Mapping[str, str]
) -> IsolationGateOutcome:
    try:
        environment = load_qualification_environment(environ)
    except QualificationEnvironmentInvalid as exc:
        return IsolationGateOutcome(_pending_isolation(gate, provider, [f"qualification_environment_invalid:{exc}"]))
    if environment is None:
        return IsolationGateOutcome(_pending_isolation(gate, provider, ["qualification_environment_unconfigured"]))
    infrastructure = environment.infrastructure
    try:
        policy_raw = Path(environment.candidate_policy).read_bytes()
        policy = load_candidate_policy(policy_raw)
    except (OSError, CandidatePolicyInvalid):
        return IsolationGateOutcome(_pending_isolation(gate, provider, ["candidate_policy_invalid"]), infrastructure)
    if policy.deployment.cluster_uid != environment.cluster_uid:
        failed = ["candidate_policy_environment_mismatch"]
        return IsolationGateOutcome(_pending_isolation(gate, provider, failed), infrastructure)
    observed = observe_kube_context(environment)
    try:
        require_disposable_context(environment, observed)
    except ContextRefused as exc:
        return IsolationGateOutcome(
            _pending_isolation(gate, provider, [f"kube_context_refused:{exc.code}"]), infrastructure
        )
    assert observed.kubectl is not None
    seen = observe_infrastructure(environment, observed.kubectl)
    mismatches = infrastructure_mismatches(infrastructure, seen)
    if mismatches:
        failed = ["infrastructure_unverified", *mismatches]
        return IsolationGateOutcome(
            _pending_isolation(gate, provider, failed), infrastructure, observed_infrastructure=seen
        )
    if environment.evidence_output_dir is None:
        if deploy:
            refused = _deploy_refusal(gate, provider, environment, policy, policy_raw, observed)
            if refused is not None:
                return IsolationGateOutcome(refused, infrastructure, observed_infrastructure=seen)
        with tempfile.TemporaryDirectory(prefix="esp-qualify-") as scratch:
            observations, junit = run_live_probes(gate, provider, Path(environ[QUALIFICATION_ENV_VAR]), Path(scratch))
        report = evaluate_live_evidence(gate, provider, observations, junit, environment, policy)
        # Evidence that is not retained cannot support a functional pass.
        report = report.model_copy(
            update={
                "functional_subgate_pass": False,
                "failed_criteria": [*report.failed_criteria, "evidence_output_unconfigured"],
            }
        )
        return IsolationGateOutcome(report, infrastructure, observed_infrastructure=seen)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    run_dir = Path(environment.evidence_output_dir) / f"{gate}-{provider}-{stamp}"
    try:
        run_dir.mkdir(parents=True, exist_ok=False)
    except OSError:
        # Nothing is deployed or probed when its evidence cannot be retained.
        failed = ["evidence_output_unwritable"]
        return IsolationGateOutcome(
            _pending_isolation(gate, provider, failed), infrastructure, observed_infrastructure=seen
        )
    refused = _deploy_refusal(gate, provider, environment, policy, policy_raw, observed) if deploy else None
    if refused is not None:
        report = refused
    else:
        observations, junit = run_live_probes(gate, provider, Path(environ[QUALIFICATION_ENV_VAR]), run_dir)
        report = evaluate_live_evidence(gate, provider, observations, junit, environment, policy)
    report = report.model_copy(update={"evidence_bundle_ref": f"file://{run_dir}"})
    outcome = IsolationGateOutcome(report, infrastructure, run_dir, seen)
    try:
        retain_isolation_result(outcome)
    except OSError:
        # A result that is printed but not retained beside its evidence cannot support a pass.
        report = report.model_copy(
            update={
                "functional_subgate_pass": False,
                "failed_criteria": [*report.failed_criteria, "evidence_output_unwritable"],
            }
        )
        outcome = IsolationGateOutcome(report, infrastructure, run_dir, seen)
    return outcome


def _deploy_refusal(
    gate: IsolationGate,
    provider: Provider,
    environment: QualificationEnvironment,
    policy: CandidateAdmissionPolicy,
    policy_raw: bytes,
    observed: ObservedContext,
) -> QualificationResult | None:
    """Deploy the prepared manifests to the recorded context; a pending result when that is refused."""
    try:
        documents = prepare_qualification_manifests(render_qualification_manifests(), environment)
    except ManifestRenderError:
        return _pending_isolation(gate, provider, ["manifest_render_failed"])
    findings = deploy_readiness_findings(documents, environment, policy)
    if findings:
        return _pending_isolation(gate, provider, ["manifests_not_deployable", *findings])
    try:
        deploy_qualification(environment, observed, documents, policy_raw)
    except (ContextRefused, DeploymentFailed):
        return _pending_isolation(gate, provider, ["deploy_failed"])
    return None


ISOLATION_RESULT_FILE = "result.json"


def isolation_payload(outcome: IsolationGateOutcome) -> dict[str, Any]:
    """The gate result as printed by the CLI and retained beside the run's evidence."""
    report = outcome.report
    payload = report.model_dump(mode="json")
    payload["classification"] = classify_qualification(report)
    payload["infrastructure"] = (
        outcome.infrastructure.model_dump(mode="json") if outcome.infrastructure is not None else None
    )
    payload["observed_infrastructure"] = (
        outcome.observed_infrastructure.model_dump(mode="json") if outcome.observed_infrastructure is not None else None
    )
    payload["evidence_dir"] = str(outcome.evidence_dir) if outcome.evidence_dir is not None else None
    return payload


def retain_isolation_result(outcome: IsolationGateOutcome) -> None:
    """Write the gate result into the run's evidence directory, next to the observations it judged."""
    if outcome.evidence_dir is None:
        raise OSError("no evidence directory for this run")
    text = json.dumps(isolation_payload(outcome), indent=2, sort_keys=True) + "\n"
    (outcome.evidence_dir / ISOLATION_RESULT_FILE).write_text(text, encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="qualify")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in _COMMANDS:
        command = sub.add_parser(name)
        command.add_argument("--provider", required=True, choices=["openai", "xai"])
        command.add_argument("--json", action="store_true")
        command.add_argument("--assume-essential-absent", action="store_true")
        if name in ("network", "storage"):
            command.add_argument(
                "--deploy",
                action="store_true",
                help="apply the rendered qualification manifests first; refused outside the recorded cluster",
            )
        if name == "inspect":
            command.add_argument(
                "--write-protocol-capture",
                action="store_true",
                help="freeze the installed build's sanitized protocol extract for review",
            )
            command.add_argument(
                "--observation-file",
                type=Path,
                default=None,
                help="report a recorded discovery observation instead of executing the installed build",
            )
            command.add_argument(
                "--acp-handshake",
                action="store_true",
                help="xai only: also start `grok agent stdio` in the isolation for an initialize-only handshake",
            )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    provider: Provider = args.provider
    write_capture = bool(getattr(args, "write_protocol_capture", False))
    observation_file: Path | None = getattr(args, "observation_file", None)
    acp_handshake = bool(getattr(args, "acp_handshake", False))
    if observation_file is not None and write_capture:
        parser.error("--observation-file cannot refreeze the protocol capture; that needs real discovery")
    if observation_file is not None and acp_handshake:
        parser.error("--observation-file cannot be combined with --acp-handshake; that needs real discovery")
    if acp_handshake and provider != "xai":
        parser.error("--acp-handshake is only defined for --provider xai")
    if args.command in ("network", "storage"):
        return _isolation_main(args.command, provider, args)
    capabilities: CapabilityReport | None = None
    harness_build: str | None = None
    configuration_digest: str | None = None
    if args.command == "inspect":
        if provider == "openai":
            if observation_file is None:
                observation = observe_codex()
            else:
                try:
                    observation = load_codex_observation(observation_file)
                except (OSError, ValueError) as exc:
                    parser.error(f"--observation-file could not be read: {type(exc).__name__}")
            if write_capture:
                if observation.capture is None:
                    print("protocol capture unavailable; nothing written", file=sys.stderr)
                    return 2
                CODEX_CAPTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
                CODEX_CAPTURE_PATH.write_text(
                    json.dumps(observation.capture, indent=2, sort_keys=True) + "\n", encoding="utf-8"
                )
                observation.frozen_capture = observation.capture
            capabilities = codex_capability_report(observation)
            harness_build = observation.harness_build
            if observation.config_digest is not None:
                configuration_digest = f"sha256:{observation.config_digest}"
        else:
            if observation_file is None:
                grok = observe_grok(acp_handshake=acp_handshake)
            else:
                try:
                    grok = load_grok_observation(observation_file)
                except (OSError, ValueError) as exc:
                    parser.error(f"--observation-file could not be read: {type(exc).__name__}")
            if write_capture:
                capture = grok_protocol_capture(grok)
                if capture is None:
                    print("protocol capture unavailable; nothing written", file=sys.stderr)
                    return 2
                GROK_CAPTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
                GROK_CAPTURE_PATH.write_text(json.dumps(capture, indent=2, sort_keys=True) + "\n", encoding="utf-8")
                grok.frozen_capture = capture
            capabilities = grok_capability_report(grok)
            harness_build = grok.harness_build
            if grok.config_digest is not None:
                configuration_digest = f"sha256:{grok.config_digest}"
    if args.command == "g1":
        from scripts.gate_coverage import run_gate1

        report = run_gate1(provider, None)
    else:
        report = _report_for(
            args.command,
            provider,
            assume_essential_absent=args.assume_essential_absent,
            capabilities=capabilities,
            harness_build=harness_build,
            configuration_digest=configuration_digest,
        )
    classification = classify_qualification(report)
    payload = report.model_dump(mode="json")
    payload["classification"] = classification
    if capabilities is not None:
        payload["capability_report"] = capabilities.model_dump(mode="json")
    if args.json:
        print(json.dumps(payload))
    else:
        print(classification)
        print(f"provider={provider} gate={args.command} observations={report.positive_observation_count}")
        if capabilities is not None:
            states = " ".join(f"{item.name}={item.state}" for item in capabilities.primitives)
            print(f"primitives: {states}")
            for note in capabilities.notes:
                print(f"note: {note}")
    if classification == "invalidated":
        return 3
    if classification == "validated" and args.command == "da01":
        return 0
    return 2


def _isolation_main(command: IsolationGate, provider: Provider, args: argparse.Namespace) -> int:
    if args.assume_essential_absent:
        report = _report_for(command, provider, assume_essential_absent=True)
        outcome = IsolationGateOutcome(report)
    else:
        outcome = run_isolation_gate(command, provider, deploy=bool(args.deploy), environ=os.environ)
    report = outcome.report
    classification = classify_qualification(report)
    payload = isolation_payload(outcome)
    if args.json:
        print(json.dumps(payload))
    else:
        print(classification)
        print(
            f"provider={provider} gate={command} observations={report.positive_observation_count} "
            f"functional_subgate_pass={str(report.functional_subgate_pass).lower()}"
        )
        for criterion in report.failed_criteria:
            print(f"failed: {criterion}")
    if classification == "invalidated":
        return 3
    if report.functional_subgate_pass:
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
