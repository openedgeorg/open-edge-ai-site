"""Versioned retrieval, precedence, and explicit dependency failures."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from esp_embeddings.embed import EmbeddingUnavailable, embed
from tests.support.corpus_lab import CorpusLab, build_corpus_lab


@pytest.fixture
async def corpus_lab(tmp_path: Path) -> AsyncIterator[CorpusLab]:
    lab = await build_corpus_lab(tmp_path)
    try:
        yield lab
    finally:
        await lab.close()


async def test_versions_conflicts_and_withdrawal(corpus_lab: CorpusLab) -> None:
    old = await corpus_lab.explicit_old_source()
    assert old.data.metadata.version == "1"
    assert "version one" in old.data.text
    assert "version two" not in old.data.text
    assert (await corpus_lab.equal_precedence_current_value()).code == "conflict"
    assert (await corpus_lab.search_private_canary()).data.hits == []
    assert (await corpus_lab.withdrawn_recorded_version()).code == "unavailable"
    assert await corpus_lab.quoted_locator_bytes() == corpus_lab.original_quote


async def test_access_faults_and_pins_stay_explicit(corpus_lab: CorpusLab) -> None:
    assert await corpus_lab.private_chunk_is_indexed()
    assert await corpus_lab.internal_canary_hits() == 1
    assert "BEGIN ESP CORE BRAIN" in await corpus_lab.marker_snippet()
    assert await corpus_lab.store_outage_code() == "unavailable"
    pinned = await corpus_lab.pinned_text_after_promotion()
    assert "promoted-substitution" not in pinned
    assert "version two" in pinned
    assert await corpus_lab.current_value_as_of() == "early"
    assert await corpus_lab.later_current_value() == "late"
    assert await corpus_lab.hybrid_mode() == "hybrid"
    assert await corpus_lab.lexical_mode_when_embeddings_unavailable() == "lexical"
    assert await corpus_lab.revision_mismatch_code() == "unavailable"
    assert await corpus_lab.missing_fact_code() == "not_found"
    assert await corpus_lab.private_resolve_code() == "forbidden"
    assert await corpus_lab.recorded_claim_text() == "synthetic fixture claim tied to the recorded quote"
    assert await corpus_lab.asset_bytes_match_hash()
    assert await corpus_lab.mcp_can_read()
    assert await corpus_lab.mcp_write_sqlstate() == "42501"
    assert corpus_lab.originals_preceded_index()


def test_unverified_embedder_does_not_invent_vectors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ESP_EMBEDDING_MODEL_DIR", raising=False)
    monkeypatch.delenv("ESP_EMBEDDING_LICENSE", raising=False)
    with pytest.raises(EmbeddingUnavailable):
        embed(["fixture"])


def test_embedding_image_denies_hosted_apis() -> None:
    text = Path("services/esp_embeddings/Dockerfile").read_text(encoding="utf-8")
    assert "HF_HUB_OFFLINE=1" in text
    assert "huggingface.co" not in text
    assert "EMBEDDINGS_NETWORK=deny" in text
