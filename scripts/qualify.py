"""Truthful qualification recorder.

Live gates stay pending until real evidence exists. A synthetic fixture cannot
insert a production qualification row.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import tomllib
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

from pydantic import BaseModel, ConfigDict, Field

from esp_contracts.ids import Provider
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
    CODEX_OPT_OUT_NOTIFICATIONS,
    STDIO_READER_LIMIT,
    JsonlFrameTransport,
    codex_build_id,
)
from esp_provider_openai.events import CODEX_EVENT_METHODS
from esp_provider_shared.rpc import NativeRpcClient

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
    version = _installed_version(provider)
    primitives = [
        PrimitiveEvidence(name=name, state="unproven", evidence_ref=None) for name in REQUIRED_PRIMITIVES
    ]
    notes = ["No protected evidence reference is recorded for this primitive."]
    if version is None:
        notes.insert(0, "Candidate binary was not found. Discovery did not install or upgrade one.")
    else:
        notes.insert(0, f"Installed version string observed without treating it as proof: {version}")
    return CapabilityReport(
        provider=provider,
        profile=profile,
        installed_version=version,
        primitives=primitives,
        notes=notes,
    )


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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="qualify")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in _COMMANDS:
        command = sub.add_parser(name)
        command.add_argument("--provider", required=True, choices=["openai", "xai"])
        command.add_argument("--json", action="store_true")
        command.add_argument("--assume-essential-absent", action="store_true")
        if name == "inspect":
            command.add_argument(
                "--write-protocol-capture",
                action="store_true",
                help="openai only: freeze the installed build's sanitized protocol extract for review",
            )
            command.add_argument(
                "--observation-file",
                type=Path,
                default=None,
                help="openai only: report a recorded discovery observation instead of executing the installed build",
            )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    provider: Provider = args.provider
    write_capture = bool(getattr(args, "write_protocol_capture", False))
    observation_file: Path | None = getattr(args, "observation_file", None)
    if write_capture and provider != "openai":
        parser.error("--write-protocol-capture is only defined for --provider openai")
    if observation_file is not None and provider != "openai":
        parser.error("--observation-file is only defined for --provider openai")
    if observation_file is not None and write_capture:
        parser.error("--observation-file cannot refreeze the protocol capture; that needs real discovery")
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
            capabilities = inspect_candidate(provider)
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


if __name__ == "__main__":
    sys.exit(main())
