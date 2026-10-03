"""Application Backend settings. Insecure identity defaults and eligibility bypasses are refused.

There is no default session key, no public-eligibility or admission bypass setting and no way to make a
production cookie insecure. A recorded candidate policy is accepted only by an isolated qualification
deployment, and only when it is bound to that deployment's own cluster UID and deployment reference.
Local HTTP uses a separate development cookie and a loopback origin.
"""

from __future__ import annotations

import base64
import binascii
import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, ValidationError, model_validator

from esp_api.boundary import strict_json
from esp_contracts.api import STRICT
from esp_contracts.eligibility import CandidateAdmissionPolicy
from esp_contracts.ids import Provider
from esp_espcon.conversation import ConfiguredRuntime

Environment = Literal["production", "qualification", "development"]
SESSION_COOKIE = "__Host-esp_session"
DEVELOPMENT_COOKIE = "esp_dev_session"
MIN_KEY_BYTES = 32
_MIN_DISTINCT_KEY_BYTES = 16
_KID = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")
_BASE64URL = re.compile(r"[A-Za-z0-9_-]+")
_PLACEHOLDER_KIDS = frozenset({"example", "placeholder", "changeme", "change-me", "replace-me", "test"})
_BYPASS_NAME = re.compile(r"BYPASS|PUBLIC.*ELIGIB|INSECURE|SKIP_(?:CSRF|ORIGIN|AUTH|ELIGIB)", re.IGNORECASE)
_QUALIFICATION_SLUG = re.compile(r"qual-[a-z0-9]+(?:-[a-z0-9]+)*")
_QUALIFICATION_ONLY = (
    "ESP_CANDIDATE_POLICY_PATH",
    "ESP_QUALIFICATION_CLUSTER_UID",
    "ESP_QUALIFICATION_DEPLOYMENT_REF",
)
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


class ConfigurationError(ValueError):
    """Refused configuration. Findings name variables and rules, never key material."""

    def __init__(self, findings: Sequence[str]) -> None:
        self.findings = list(findings)
        super().__init__("configuration refused: " + "; ".join(self.findings))


class SessionKeyRing:
    """Cookie and CSRF HMAC keys by key ID. The first key signs; every key verifies during rotation."""

    __slots__ = ("_current", "_keys")

    def __init__(self, entries: Sequence[tuple[str, bytes]]) -> None:
        if not entries:
            raise ValueError("needs at least one key")
        self._current = entries[0][0]
        self._keys = dict(entries)

    @property
    def current_kid(self) -> str:
        return self._current

    @property
    def kids(self) -> tuple[str, ...]:
        return tuple(self._keys)

    def key(self, kid: str) -> bytes | None:
        return self._keys.get(kid)

    def __repr__(self) -> str:
        return f"SessionKeyRing(kids={list(self._keys)!r})"


def parse_session_keys(text: str) -> SessionKeyRing:
    """Parse `kid:base64url-key[,kid:base64url-key...]`. Messages never contain key material."""
    entries: list[tuple[str, bytes]] = []
    seen_keys: set[bytes] = set()
    for index, item in enumerate(text.split(","), start=1):
        kid, separator, encoded = item.strip().partition(":")
        if not separator or _KID.fullmatch(kid) is None:
            raise ValueError(f"entry {index} needs a lowercase key id and a key, as kid:base64url")
        if kid in _PLACEHOLDER_KIDS:
            raise ValueError(f"entry {index} uses the placeholder key id {kid!r}")
        if any(existing == kid for existing, _ in entries):
            raise ValueError(f"key id {kid!r} repeats")
        if _BASE64URL.fullmatch(encoded) is None:
            raise ValueError(f"entry {index} key is not base64url")
        try:
            key = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        except (binascii.Error, ValueError) as exc:
            raise ValueError(f"entry {index} key is not base64url") from exc
        if len(key) < MIN_KEY_BYTES:
            raise ValueError(f"entry {index} key is shorter than {MIN_KEY_BYTES} bytes")
        if len(set(key)) < _MIN_DISTINCT_KEY_BYTES:
            raise ValueError(f"entry {index} key is not random")
        if key in seen_keys:
            raise ValueError("a key repeats under another key id")
        seen_keys.add(key)
        entries.append((kid, key))
    return SessionKeyRing(entries)


@dataclass(frozen=True)
class ApiSettings:
    environment: Environment
    public_origin: str
    database_url: str = field(repr=False)
    session_keys: SessionKeyRing
    session_max_age_seconds: int | None
    brain_release_id: str
    runtime_profiles_path: Path
    candidate_policy_path: Path | None
    qualification_cluster_uid: str | None
    qualification_deployment_ref: str | None

    @property
    def cookie_name(self) -> str:
        return DEVELOPMENT_COOKIE if self.environment == "development" else SESSION_COOKIE

    @property
    def secure_cookie(self) -> bool:
        return self.environment != "development"


def load_settings(environ: Mapping[str, str]) -> ApiSettings:
    """Validate the whole environment and report every finding at once."""

    def value(name: str) -> str | None:
        raw = environ.get(name)
        if raw is None or not raw.strip():
            return None
        return raw.strip()

    findings: list[str] = []
    environment = value("ESP_ENVIRONMENT")
    if environment not in ("production", "qualification", "development"):
        raise ConfigurationError(["ESP_ENVIRONMENT must be production, qualification or development"])
    for name in sorted(environ):
        if name.startswith("ESP_") and _BYPASS_NAME.search(name):
            findings.append(f"{name}: eligibility, identity and admission have no bypass or insecure setting")

    origin = value("ESP_PUBLIC_ORIGIN")
    if origin is None:
        findings.append("ESP_PUBLIC_ORIGIN is required")
    else:
        findings.extend(_origin_findings(origin, environment))

    keys: SessionKeyRing | None = None
    raw_keys = value("ESP_SESSION_KEYS")
    if raw_keys is None:
        findings.append("ESP_SESSION_KEYS is required: kid:base64url keys of at least 32 random bytes")
    else:
        try:
            keys = parse_session_keys(raw_keys)
        except ValueError as exc:
            findings.append(f"ESP_SESSION_KEYS {exc}")

    max_age: int | None = None
    raw_max_age = value("ESP_SESSION_MAX_AGE_SECONDS")
    if raw_max_age is None:
        if environment == "production":
            findings.append("ESP_SESSION_MAX_AGE_SECONDS is required in production; cookie expiry is a release input")
    elif not raw_max_age.isdigit() or int(raw_max_age) <= 0:
        findings.append("ESP_SESSION_MAX_AGE_SECONDS must be a positive whole number of seconds")
    else:
        max_age = int(raw_max_age)

    database_url = value("ESP_DATABASE_URL")
    brain_release_id = value("ESP_BRAIN_RELEASE_ID")
    profiles_path = value("ESP_RUNTIME_PROFILES_PATH")
    for name, present in (
        ("ESP_DATABASE_URL", database_url),
        ("ESP_BRAIN_RELEASE_ID", brain_release_id),
        ("ESP_RUNTIME_PROFILES_PATH", profiles_path),
    ):
        if present is None:
            findings.append(f"{name} is required")

    policy_path = value("ESP_CANDIDATE_POLICY_PATH")
    cluster_uid = value("ESP_QUALIFICATION_CLUSTER_UID")
    deployment_ref = value("ESP_QUALIFICATION_DEPLOYMENT_REF")
    if environment != "qualification":
        for name in _QUALIFICATION_ONLY:
            if value(name) is not None:
                findings.append(f"{name} is accepted only by an isolated qualification deployment")
    else:
        if policy_path is None:
            findings.append("ESP_CANDIDATE_POLICY_PATH is required by an isolated qualification deployment")
        cluster_uid = _cluster_uid(cluster_uid, findings)
        if deployment_ref is None or len(deployment_ref) > 63 or _QUALIFICATION_SLUG.fullmatch(deployment_ref) is None:
            findings.append("ESP_QUALIFICATION_DEPLOYMENT_REF must name the isolated qual-* deployment")

    if findings:
        raise ConfigurationError(findings)
    assert origin is not None and keys is not None
    assert database_url is not None and brain_release_id is not None and profiles_path is not None
    return ApiSettings(
        environment=environment,
        public_origin=origin,
        database_url=database_url,
        session_keys=keys,
        session_max_age_seconds=max_age,
        brain_release_id=brain_release_id,
        runtime_profiles_path=Path(profiles_path),
        candidate_policy_path=None if policy_path is None else Path(policy_path),
        qualification_cluster_uid=cluster_uid if environment == "qualification" else None,
        qualification_deployment_ref=deployment_ref if environment == "qualification" else None,
    )


def load_candidate_policy(settings: ApiSettings) -> CandidateAdmissionPolicy | None:
    """Read the recorded test-only policy and refuse it unless it is bound to this deployment."""
    if settings.candidate_policy_path is None:
        return None
    if settings.environment != "qualification":
        raise ConfigurationError(["a candidate policy is accepted only by an isolated qualification deployment"])
    try:
        raw = settings.candidate_policy_path.read_bytes()
    except OSError as exc:
        raise ConfigurationError(["ESP_CANDIDATE_POLICY_PATH cannot be read"]) from exc
    return bind_candidate_policy(parse_candidate_policy(raw), settings)


def parse_candidate_policy(raw: bytes) -> CandidateAdmissionPolicy:
    try:
        document = strict_json(raw)
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise ConfigurationError(["candidate policy is not strict JSON"]) from exc
    try:
        return CandidateAdmissionPolicy.model_validate(document)
    except ValidationError as exc:
        raise ConfigurationError([f"candidate policy rejected by the model: {exc.error_count()} errors"]) from exc


def bind_candidate_policy(policy: CandidateAdmissionPolicy, settings: ApiSettings) -> CandidateAdmissionPolicy:
    """The policy admits nothing outside the isolated deployment it names."""
    if settings.environment != "qualification":
        raise ConfigurationError(["a candidate policy is accepted only by an isolated qualification deployment"])
    if (
        policy.deployment.cluster_uid != settings.qualification_cluster_uid
        or policy.deployment.deployment_ref != settings.qualification_deployment_ref
    ):
        raise ConfigurationError(["candidate policy is bound to another deployment"])
    return policy


class RuntimeProfiles(BaseModel):
    """The exact runtime profile and deployment record of each configured provider pool."""

    model_config = STRICT
    profiles_format: Literal["esp-runtime-profiles/1"]
    runtimes: list[ConfiguredRuntime] = Field(min_length=1)

    @model_validator(mode="after")
    def _one_pool_per_provider(self) -> RuntimeProfiles:
        providers = [runtime.provider for runtime in self.runtimes]
        if len(set(providers)) != len(providers):
            raise ValueError("one runtime per provider")
        return self


def parse_runtime_profiles(raw: bytes) -> dict[Provider, ConfiguredRuntime]:
    try:
        document = strict_json(raw)
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise ConfigurationError(["runtime profiles are not strict JSON"]) from exc
    try:
        profiles = RuntimeProfiles.model_validate(document)
    except ValidationError as exc:
        raise ConfigurationError([f"runtime profiles rejected by the model: {exc.error_count()} errors"]) from exc
    return {runtime.provider: runtime for runtime in profiles.runtimes}


def load_runtime_profiles(settings: ApiSettings) -> dict[Provider, ConfiguredRuntime]:
    try:
        raw = settings.runtime_profiles_path.read_bytes()
    except OSError as exc:
        raise ConfigurationError(["ESP_RUNTIME_PROFILES_PATH cannot be read"]) from exc
    return parse_runtime_profiles(raw)


def _origin_findings(origin: str, environment: str) -> list[str]:
    try:
        parts = urlsplit(origin)
        hostname = parts.hostname
        port = parts.port
    except ValueError:
        return ["ESP_PUBLIC_ORIGIN must be a scheme://host[:port] origin"]
    canonical = f"{parts.scheme}://{parts.netloc}"
    if (
        parts.scheme not in ("http", "https")
        or not hostname
        or parts.username is not None
        or parts.password is not None
        or origin != canonical
        or origin != origin.lower()
        or (port is not None and port <= 0)
    ):
        return ["ESP_PUBLIC_ORIGIN must be a scheme://host[:port] origin"]
    if environment == "development":
        if hostname not in _LOOPBACK_HOSTS:
            return ["ESP_PUBLIC_ORIGIN must be a loopback origin in development"]
        return []
    if parts.scheme != "https":
        return ["ESP_PUBLIC_ORIGIN must be an https origin outside development"]
    return []


def _cluster_uid(value: str | None, findings: list[str]) -> str | None:
    if value is None:
        findings.append("ESP_QUALIFICATION_CLUSTER_UID is required by an isolated qualification deployment")
        return None
    try:
        return str(uuid.UUID(value))
    except ValueError:
        findings.append("ESP_QUALIFICATION_CLUSTER_UID must be the isolated cluster's UID")
        return None
