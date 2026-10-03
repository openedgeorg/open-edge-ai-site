"""Runtime container entry for one Shared Harness Instance (ShaHarIns). Pending a qualified wiring.

The runtime image starts here. It refuses to run with any provider credential or signing-key material
in its environment: provider keys stay in the ESP Inference Gateway and the signing key stays with
the backend signing authority. The supervised native process, its control endpoint and its
attribution relays are not started until the lifecycle wiring and a qualified deployment
configuration exist, so this entry exits pending instead of listening.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections.abc import Mapping, Sequence

# Credential-shaped names. Ordinary harness settings such as CODEX_HOME or GROK_HOME do not match.
_FORBIDDEN_NAME = re.compile(
    r"(?:^|_)(?:API_?KEY|SIGNING_?KEY|PRIVATE_?KEY|SECRET(?:_?KEY)?|ACCESS_?KEY|AUTH_?TOKEN|TOKEN|BEARER"
    r"|PASSWORD|CREDENTIALS?)(?:$|_)",
    re.IGNORECASE,
)
_FORBIDDEN_VALUE = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}|\bxai-[A-Za-z0-9_-]{16,}")
PENDING_EXIT = 2
REFUSED_EXIT = 3


def forbidden_runtime_material(environ: Mapping[str, str]) -> list[str]:
    """Names of environment entries that look like provider credentials or signing keys."""
    return sorted(
        name for name, value in environ.items() if _FORBIDDEN_NAME.search(name) or _FORBIDDEN_VALUE.search(value)
    )


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
