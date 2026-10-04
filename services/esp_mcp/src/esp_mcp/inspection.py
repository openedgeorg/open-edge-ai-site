"""Public inspection for MCP. The protected native and evidence stores stay unread."""

from __future__ import annotations

from esp_contracts.api import Citation
from esp_contracts.knowledge import AssetRecord, CitationVerification, KnowledgeErr, KnowledgeOk, SourceRecord
from esp_knowledge_client.client import (
    AuthorizedNativeProvenance,
    PublishedCatalog,
    get_published_asset,
    get_published_source,
    verify_citation,
)

__all__ = [
    "AuthorizedNativeProvenance",
    "PublishedCatalog",
    "get_published_asset",
    "get_published_source",
    "inspect_published_asset",
    "inspect_published_source",
    "verify_citation",
]


def inspect_published_source(
    catalog: PublishedCatalog,
    source_id: str,
    version: str,
) -> KnowledgeOk[SourceRecord] | KnowledgeErr:
    """Read a manifest-listed public source. Protected rows stay forbidden."""
    locked = PublishedCatalog(sources=catalog.sources, assets=catalog.assets, allow_protected=False)
    return get_published_source(source_id, version, catalog=locked)


def inspect_published_asset(
    catalog: PublishedCatalog,
    asset_id: str,
    version: str,
) -> KnowledgeOk[AssetRecord] | KnowledgeErr:
    locked = PublishedCatalog(sources=catalog.sources, assets=catalog.assets, allow_protected=False)
    return get_published_asset(asset_id, version, catalog=locked)


def inspect_citation(
    citation: Citation,
    provenance: AuthorizedNativeProvenance,
    source: SourceRecord | None,
) -> CitationVerification:
    """Verify from retained provenance. This does not start a run or refetch a turn."""
    return verify_citation(citation, provenance, source)
