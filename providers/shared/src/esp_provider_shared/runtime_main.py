"""Runtime container entry for one Shared Harness Instance (ShaHarIns). Pending a qualified wiring.

The runtime image starts here. It refuses to run with any provider credential or signing-key material
in its environment: provider keys stay in the ESP Inference Gateway and the signing key stays with
the backend signing authority. The supervised native process, its control endpoint and its
attribution relays are not started until the lifecycle wiring and a qualified deployment
configuration exist, so this entry exits pending instead of listening.

`key_material_report` is the bounded file and environment scan the live qualification probe runs
inside the runtime container. It covers the mounted secret roots and the native volume, where the
harnesses keep their own state (`$CODEX_HOME/auth.json`, `$GROK_HOME`, `$HOME`), and classifies
provider credentials and signing material separately. It reports paths and names only, never values.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections.abc import Mapping, Sequence
from typing import TypedDict

# Credential-shaped names. Ordinary harness settings such as CODEX_HOME or GROK_HOME do not match.
_FORBIDDEN_NAME = re.compile(
    r"(?:^|_)(?:API_?KEY|SIGNING_?KEY|PRIVATE_?KEY|SECRET(?:_?KEY)?|ACCESS_?KEY|AUTH_?TOKEN|TOKEN|BEARER"
    r"|PASSWORD|CREDENTIALS?)(?:$|_)",
    re.IGNORECASE,
)
_FORBIDDEN_VALUE = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}|\bxai-[A-Za-z0-9_-]{16,}")
_SIGNING_NAME = re.compile(r"SIGNING|PRIVATE", re.IGNORECASE)
_PEM_PRIVATE = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")
PENDING_EXIT = 2
REFUSED_EXIT = 3

# File content. Provider key values are recognised anywhere; credential assignments (a JSON, TOML,
# YAML or dotenv key with a non-empty value, OAuth tokens included) only in configuration-like files,
# so a transcript that merely discusses credentials is not mistaken for one.
_PROVIDER_VALUE_BYTES = re.compile(rb"\bsk-[A-Za-z0-9_-]{16,}|\bxai-[A-Za-z0-9_-]{16,}")
_CREDENTIAL_ASSIGNMENT = re.compile(
    rb"[\"']?\b(?:OPENAI_API_KEY|XAI_API_KEY|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token"
    rb"|bearer[_-]?token|client[_-]?secret)\b[\"']?\s*[:=]\s*[\"']?[A-Za-z0-9._~+/=-]{8,}",
    re.IGNORECASE,
)
_PRIVATE_KEY_BYTES = re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")
_JWK_PRIVATE = re.compile(rb"\"d\"\s*:\s*\"[A-Za-z0-9_-]{16,}\"")
_CONFIG_NAME = re.compile(
    r"^(?:\.?auth[^/]*\.json|config[^/]*|\.?credentials[^/]*|\.env[^/]*|\.netrc|[^/]*\.(?:toml|ini|cfg|ya?ml))$",
    re.IGNORECASE,
)
SECRET_ROOTS: tuple[str, ...] = ("/etc/esp", "/var/run/secrets", "/run/secrets")
# Harness homes first: a file directly in a home is configuration-like, and each file is scanned once.
NATIVE_HOME_VARIABLES: tuple[str, ...] = ("CODEX_HOME", "GROK_HOME", "HOME", "ESP_NATIVE_ROOT")
DEFAULT_MAX_FILES = 20000
DEFAULT_HEAD_BYTES = 65536


class MaterialFindings(TypedDict):
    provider: list[str]
    signing: list[str]


class KeyMaterialReport(TypedDict):
    roots: list[str]
    environment: MaterialFindings
    files: MaterialFindings
    scanned_files: int
    unreadable: int
    truncated: bool


def forbidden_runtime_material(environ: Mapping[str, str]) -> list[str]:
    """Names of environment entries that look like provider credentials or signing keys."""
    return sorted(
        name for name, value in environ.items() if _FORBIDDEN_NAME.search(name) or _FORBIDDEN_VALUE.search(value)
    )


def classify_environment_material(environ: Mapping[str, str]) -> MaterialFindings:
    """Forbidden environment names split into signing material and provider credentials."""
    findings: MaterialFindings = {"provider": [], "signing": []}
    for name in forbidden_runtime_material(environ):
        signing = _SIGNING_NAME.search(name) is not None or _PEM_PRIVATE.search(environ[name]) is not None
        findings["signing" if signing else "provider"].append(name)
    return findings


def classify_file_material(head: bytes, *, config_like: bool) -> set[str]:
    """Kinds of key material in the first bytes of one file: `provider`, `signing`, both or none."""
    kinds: set[str] = set()
    if _PRIVATE_KEY_BYTES.search(head) or _JWK_PRIVATE.search(head):
        kinds.add("signing")
    if _PROVIDER_VALUE_BYTES.search(head) or (config_like and _CREDENTIAL_ASSIGNMENT.search(head)):
        kinds.add("provider")
    return kinds


def runtime_key_roots(environ: Mapping[str, str], fixed_roots: Sequence[str] = SECRET_ROOTS) -> list[str]:
    """Mounted secret roots plus the native volume and every harness home the environment names."""
    roots: list[str] = []
    for root in [*fixed_roots, *(environ.get(name, "") for name in NATIVE_HOME_VARIABLES)]:
        if root and root not in roots:
            roots.append(root)
    return roots


def key_material_report(
    environ: Mapping[str, str],
    *,
    fixed_roots: Sequence[str] = SECRET_ROOTS,
    max_files: int = DEFAULT_MAX_FILES,
    head_bytes: int = DEFAULT_HEAD_BYTES,
) -> KeyMaterialReport:
    """Scan the runtime's environment and files for key material. Paths and names only.

    The runtime's own control identity key (`$ESP_CONTROL_TLS_DIR/tls.key`) is the one private key a
    runtime holds. Projected secret files are symlinks into a timestamped directory, so files are
    compared and de-duplicated by resolved path. More than `max_files` files marks the scan truncated.
    """
    tls_dir = environ.get("ESP_CONTROL_TLS_DIR", "/etc/esp/mtls")
    allowed = {os.path.realpath(os.path.join(tls_dir, "tls.key"))}
    files: MaterialFindings = {"provider": [], "signing": []}
    seen: set[str] = set()
    scanned = unreadable = 0
    truncated = False
    roots = runtime_key_roots(environ, fixed_roots)
    for root in roots:
        if truncated:
            break
        for directory, _, names in os.walk(root):
            depth = 0 if directory == root else os.path.relpath(directory, root).count(os.sep) + 1
            for name in sorted(names):
                path = os.path.join(directory, name)
                resolved = os.path.realpath(path)
                if resolved in seen or resolved in allowed:
                    continue
                seen.add(resolved)
                if scanned >= max_files:
                    truncated = True
                    break
                scanned += 1
                try:
                    with open(path, "rb") as handle:
                        head = handle.read(head_bytes)
                except OSError:
                    unreadable += 1
                    continue
                config_like = depth == 0 or _CONFIG_NAME.match(name) is not None
                for kind in sorted(classify_file_material(head, config_like=config_like)):
                    files["provider" if kind == "provider" else "signing"].append(path)
            if truncated:
                break
    return {
        "roots": roots,
        "environment": classify_environment_material(environ),
        "files": files,
        "scanned_files": scanned,
        "unreadable": unreadable,
        "truncated": truncated,
    }


def main(argv: Sequence[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="esp-runtime")
    parser.add_argument("--harness", required=True, choices=["codex", "grok-build"])
    args = parser.parse_args(argv)
    found = forbidden_runtime_material(os.environ if environ is None else environ)
    if found:
        # Names only; values are never printed.
        print("runtime refuses key material in its environment: " + ", ".join(found), file=sys.stderr)
        return REFUSED_EXIT
    print(f"{args.harness} runtime supervision remains pending a qualified deployment configuration", file=sys.stderr)
    return PENDING_EXIT


if __name__ == "__main__":
    sys.exit(main())
