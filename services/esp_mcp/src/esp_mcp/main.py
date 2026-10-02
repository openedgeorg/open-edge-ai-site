"""Process entry. Importing this module does not open a socket."""

from __future__ import annotations

import os

_REQUIRED = (
    "ESP_MCP_DATABASE_URL",
    "ESP_KNOWLEDGE_PUBLIC_KEY",
    "ESP_INSPECTION_IDENTITY",
)


def serve() -> None:
    """Refuse a signing key and do not listen without a qualified deployment."""
    if os.environ.get("ESP_MCP_SIGNING_KEY"):
        raise SystemExit("MCP process must not hold a signing key")
    missing = [name for name in _REQUIRED if not os.environ.get(name)]
    if missing:
        raise SystemExit("missing knowledge configuration: " + ", ".join(missing))
    raise SystemExit("knowledge listen remains pending a qualified deployment configuration")


if __name__ == "__main__":
    serve()
