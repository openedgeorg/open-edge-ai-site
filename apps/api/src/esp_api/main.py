"""Process entry. Importing this module does not open a socket, a database pool or a runtime connection."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import NoReturn

from esp_api.config import ConfigurationError, load_candidate_policy, load_runtime_profiles, load_settings


def serve(environ: Mapping[str, str] | None = None) -> NoReturn:
    """Refuse insecure configuration, then decline to listen until runtime adapters are qualified.

    Everything `build_api` would refuse from files is checked before the pending answer: the runtime
    profiles must load, and a qualification deployment's candidate policy must load and be bound to it.
    """
    try:
        settings = load_settings(os.environ if environ is None else environ)
        load_runtime_profiles(settings)
        load_candidate_policy(settings)
    except ConfigurationError as exc:
        raise SystemExit("api configuration refused: " + "; ".join(exc.findings)) from None
    raise SystemExit(
        f"api listen remains pending native runtime adapters and a qualified {settings.environment} deployment"
    )


if __name__ == "__main__":
    serve()
