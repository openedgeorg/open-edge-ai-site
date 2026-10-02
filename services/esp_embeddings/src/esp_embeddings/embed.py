"""Pinned local embedding candidate.

The proposed model is sentence-transformers/all-MiniLM-L6-v2 at 384 dimensions.
This module does not download weights and does not call a hosted embedding API.
Until a qualified local runtime verifies the license, tokenizer, and weight digest,
embed() stays unavailable. Draft tests inject their own embedder; those vectors are
not this candidate and cannot be recorded as a reviewed or production index.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PINNED_MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2"
PINNED_DIMENSION = 384
PINNED_TOKENIZER = "bert-wordpiece-uncased"


class EmbeddingUnavailable(Exception):
    def __init__(self, code: str = "embeddings_unavailable") -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class EmbeddingBatch:
    revision: str
    dimension: int
    vectors: list[list[float]]


def embed(texts: list[str]) -> EmbeddingBatch:
    del texts
    raise _unavailable_reason()


def _unavailable_reason() -> EmbeddingUnavailable:
    model_dir = os.environ.get("ESP_EMBEDDING_MODEL_DIR", "")
    license_file = os.environ.get("ESP_EMBEDDING_LICENSE", "")
    if not model_dir or not license_file:
        return EmbeddingUnavailable("embeddings_unavailable")
    root = Path(model_dir)
    license_path = Path(license_file)
    if not root.is_dir() or not license_path.is_file():
        return EmbeddingUnavailable("embeddings_unavailable")
    license_text = license_path.read_text(encoding="utf-8", errors="replace")[:8192]
    if PINNED_MODEL_ID not in license_text or PINNED_TOKENIZER not in license_text:
        return EmbeddingUnavailable("license_unverified")
    weights = list(root.glob("*.safetensors")) + list(root.glob("*.bin"))
    if not weights:
        return EmbeddingUnavailable("weights_unverified")
    # A mounted directory is not a qualified runtime. Do not invent vectors.
    return EmbeddingUnavailable("runtime_unverified")
