"""Public exact versions only. Protected rows, script URLs and withdrawn bodies stay closed."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import FastAPI, Request
from fastapi.responses import Response
from fastapi.testclient import TestClient

from esp_api.auth import SubjectIdentity
from esp_api.boundary import ApiError, error_response
from esp_api.config import SessionKeyRing
from esp_api.routes.sources import router
from esp_contracts.api import Citation
from esp_contracts.knowledge import AssetRecord, KnowledgeErr, SourceMetadata, SourceRecord
from esp_knowledge_client.client import (
    AuthorizedNativeProvenance,
    PublishedCatalog,
    get_published_asset,
    get_published_source,
    verify_citation,
)
from esp_mcp.inspection import inspect_published_source

HASH = "cd" * 32


def _metadata(version: str, visibility: str = "public", status: str = "active") -> SourceMetadata:
    return SourceMetadata(
        source_id="src-1",
        version=version,
        title=f"Note {version}",
        content_hash=HASH,
        authority="owner",
        effective_date=datetime(2026, 1, 1, tzinfo=UTC),
        status=status,  # type: ignore[arg-type]
        source_owner="owner",
        visibility=visibility,  # type: ignore[arg-type]
        locator_start=0,
        locator_end=3,
    )


def _catalog() -> PublishedCatalog:
    catalog = PublishedCatalog()
    catalog.sources[("src-1", "v1")] = SourceRecord(
        metadata=_metadata("v1"),
        text="old",
        original_bytes_ref="sources/src-1/v1.txt",
    )
    catalog.sources[("src-1", "v2")] = SourceRecord(
        metadata=_metadata("v2"),
        text="new",
        original_bytes_ref="sources/src-1/v2.txt",
    )
    catalog.sources[("src-1", "secret")] = SourceRecord(
        metadata=_metadata("secret", visibility="internal"),
        text="hidden",
        original_bytes_ref="sources/src-1/secret.txt",
    )
    catalog.assets[("asset-1", "v1")] = AssetRecord(
        asset_id="asset-1",
        version="v1",
        mime="text/html",
        content_hash=HASH,
        object_ref="https://evil.example/asset",
        alt="nope",
        source_id="src-1",
        visibility="public",
        status="active",
    )
    return catalog


def test_exact_public_version_is_preserved_and_protected_rows_stay_closed() -> None:
    catalog = _catalog()
    old = get_published_source("src-1", "v1", catalog=catalog)
    assert not isinstance(old, KnowledgeErr) and old.data.text == "old"
    current = get_published_source("src-1", "v2", catalog=catalog)
    assert not isinstance(current, KnowledgeErr) and current.data.text == "new"
    hidden = inspect_published_source(catalog, "src-1", "secret")
    assert isinstance(hidden, KnowledgeErr) and hidden.code == "forbidden"
    asset = get_published_asset("asset-1", "v1", catalog=catalog)
    assert isinstance(asset, KnowledgeErr) and asset.code == "forbidden"
    unsafe = verify_citation(
        Citation(
            source_id="src-1",
            version="v1",
            title="x",
            locator="javascript:alert(1)",
            quote="old",
            verification_state="unverified",
        ),
        AuthorizedNativeProvenance(conversation_id="conv", excerpts=[]),
        catalog.sources[("src-1", "v1")],
    )
    assert unsafe.state == "unverified"


def test_source_route_requires_a_visitor_and_strips_withdrawn_text() -> None:
    catalog = _catalog()
    catalog.sources[("src-1", "gone")] = SourceRecord(
        metadata=_metadata("gone", status="withdrawn"),
        text="should-not-leak",
        original_bytes_ref="sources/src-1/gone.txt",
    )
    identity = SubjectIdentity(
        SessionKeyRing([("dev-key", b"k" * 32)]),
        cookie_name="esp_dev_session",
        secure=False,
        max_age_seconds=3600,
        public_origin="http://127.0.0.1:8765",
    )
    app = FastAPI()

    async def api_error(_request: Request, exc: Exception) -> Response:
        if not isinstance(exc, ApiError):
            raise exc
        return error_response(exc)

    app.add_exception_handler(ApiError, api_error)
    app.include_router(router)
    app.state.identity = identity
    app.state.source_catalog = catalog
    client = TestClient(app)
    assert client.get("/sources/src-1", params={"version": "v1"}).status_code == 401
    client.cookies.set("esp_dev_session", identity.issue_cookie("a" * 43))
    seen = client.get("/sources/src-1", params={"version": "v1"})
    assert seen.status_code == 200
    assert seen.json()["text"] == "old"
    assert seen.headers["x-content-type-options"] == "nosniff"
    withdrawn = client.get("/sources/src-1", params={"version": "gone"})
    assert withdrawn.status_code == 200
    assert withdrawn.json()["state"] == "unavailable"
    assert "should-not-leak" not in withdrawn.text
