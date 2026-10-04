"""Public exact-version source and asset inspection. Withdrawn versions return no substitute body."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from esp_api.auth import require_subject
from esp_api.boundary import NO_STORE, ApiError
from esp_contracts.knowledge import KnowledgeErr
from esp_knowledge_client.client import PublishedCatalog, get_published_asset, get_published_source

router = APIRouter()

_HEADERS = {**NO_STORE, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'"}


def catalog_of(request: Request) -> PublishedCatalog:
    catalog = getattr(request.app.state, "source_catalog", None)
    if not isinstance(catalog, PublishedCatalog):
        return PublishedCatalog()
    return catalog


@router.get("/sources/{source_id}")
async def get_source(request: Request, source_id: str, version: str) -> JSONResponse:
    require_subject(request)
    result = get_published_source(source_id, version, catalog=catalog_of(request))
    if isinstance(result, KnowledgeErr):
        raise ApiError(404 if result.code == "not_found" else 403, result.code, "The source is not available.")
    record = result.data
    if record.metadata.status == "withdrawn":
        return JSONResponse(
            {
                "state": "unavailable",
                "source_id": source_id,
                "version": version,
                "message": "This version was withdrawn.",
            },
            headers=_HEADERS,
        )
    return JSONResponse(
        {
            "state": "available",
            "source_id": record.metadata.source_id,
            "version": record.metadata.version,
            "title": record.metadata.title,
            "authority": record.metadata.authority,
            "locator_start": record.metadata.locator_start,
            "locator_end": record.metadata.locator_end,
            "text": record.text,
        },
        headers=_HEADERS,
    )


@router.get("/assets/{asset_id}")
async def get_asset(request: Request, asset_id: str, version: str) -> JSONResponse:
    require_subject(request)
    result = get_published_asset(asset_id, version, catalog=catalog_of(request))
    if isinstance(result, KnowledgeErr):
        raise ApiError(404 if result.code == "not_found" else 403, result.code, "The asset is not available.")
    record = result.data
    if record.status == "withdrawn":
        return JSONResponse(
            {
                "state": "unavailable",
                "asset_id": asset_id,
                "version": version,
                "message": "This version was withdrawn.",
            },
            headers=_HEADERS,
        )
    return JSONResponse(
        {
            "state": "available",
            "asset_id": record.asset_id,
            "version": record.version,
            "mime": record.mime,
            "alt": record.alt,
            "source_id": record.source_id,
        },
        headers=_HEADERS,
    )
