"""Citations verify only against the same conversation's authorized native history."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from esp_contracts.api import Citation
from esp_contracts.knowledge import SourceMetadata, SourceRecord
from esp_knowledge_client.client import AuthorizedNativeProvenance, ProvenanceExcerpt, verify_citation

HASH = "ab" * 32
QUOTE = "The exact quote."


def _source(status: str = "active", text: str = QUOTE) -> SourceRecord:
    return SourceRecord(
        metadata=SourceMetadata(
            source_id="src-1",
            version="v1",
            title="Recorded note",
            content_hash=HASH,
            authority="owner",
            effective_date=datetime(2026, 1, 1, tzinfo=UTC),
            status=status,  # type: ignore[arg-type]
            source_owner="owner",
            visibility="public",
            locator_start=0,
            locator_end=len(QUOTE),
        ),
        text=text,
        original_bytes_ref="sources/src-1/v1.txt",
    )


def _citation(quote: str | None = QUOTE) -> Citation:
    return Citation(
        source_id="src-1",
        version="v1",
        title="Recorded note",
        locator="0:16",
        quote=quote,
        verification_state="unverified",
    )


def _provenance(conversation_id: str, quote: str = QUOTE) -> AuthorizedNativeProvenance:
    return AuthorizedNativeProvenance(
        conversation_id=conversation_id,
        excerpts=[
            ProvenanceExcerpt(
                conversation_id=conversation_id,
                source_id="src-1",
                version="v1",
                locator="0:16",
                quote=quote,
            )
        ],
    )


class CitationLab:
    def __init__(self) -> None:
        self.manufactured_run_tokens = 0
        self.source = _source()

    async def old_authorized_tool_provenance(self):
        return verify_citation(_citation(), _provenance("conv-same"), self.source)

    async def other_conversation_provenance(self):
        foreign = _provenance("conv-other")
        foreign = foreign.model_copy(update={"conversation_id": "conv-same"})
        return verify_citation(_citation(), foreign, self.source)

    async def inexact_displayed_quote(self):
        return verify_citation(_citation("The exact quote!"), _provenance("conv-same"), self.source)

    async def withdraw_recorded_version(self):
        return verify_citation(_citation(), _provenance("conv-same"), _source("withdrawn"))


@pytest.fixture
def citation_lab() -> CitationLab:
    return CitationLab()


async def test_citation_can_use_same_conversation_native_history(citation_lab: CitationLab) -> None:
    assert (await citation_lab.old_authorized_tool_provenance()).state == "verified"
    assert (await citation_lab.other_conversation_provenance()).state == "unverified"
    assert (await citation_lab.inexact_displayed_quote()).state == "unverified"
    assert (await citation_lab.withdraw_recorded_version()).state == "unavailable"
    assert citation_lab.manufactured_run_tokens == 0
