"""Process entry. Importing this module does not open a socket, a database pool or a runtime connection."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import NoReturn

from esp_api.config import ConfigurationError, load_settings


def serve(environ: Mapping[str, str] | None = None) -> NoReturn:
    """Refuse insecure configuration, then decline to listen until runtime adapters are qualified."""
    try:
        settings = load_settings(os.environ if environ is None else environ)
    except ConfigurationError as exc:
        raise SystemExit("api configuration refused: " + "; ".join(exc.findings)) from None
    raise SystemExit(
        f"api listen remains pending native runtime adapters and a qualified {settings.environment} deployment"
    )


if __name__ == "__main__":
    serve()
