"""Process entry. Importing this module does not open a socket or a provider connection."""

from __future__ import annotations

import os

_REQUIRED = (
    "ESP_DATABASE_URL",
    "ESP_EVIDENCE_KEY",
    "ESP_OPENAI_UPSTREAM",
    "ESP_XAI_UPSTREAM",
    "ESP_PROVIDER_CREDENTIAL_REF",
)


def serve() -> None:
    missing = [name for name in _REQUIRED if not os.environ.get(name)]
    if missing:
        raise SystemExit("missing gateway configuration: " + ", ".join(missing))
    raise SystemExit("gateway listen remains pending a qualified deployment configuration")


if __name__ == "__main__":
    serve()
