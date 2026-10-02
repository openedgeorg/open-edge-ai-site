"""Pending local embedder. This process does not listen and does not call a model host."""

from __future__ import annotations

import sys

from esp_embeddings.embed import EmbeddingUnavailable, embed


def serve() -> int:
    try:
        embed(["pin-check"])
    except EmbeddingUnavailable as exc:
        print(f"embedding candidate pending: {exc.code}", file=sys.stderr)
        return 2
    print("local embedding runtime is not enabled", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(serve())
