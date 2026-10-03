"""Application Backend service factory and its explicit dependency container.

`build_api` refuses inconsistent dependencies instead of serving with them: a candidate policy outside
an isolated qualification deployment, a policy bound to another deployment, a qualification deployment
without its policy, an identity that disagrees with the settings, or a configured runtime without an
adapter. There are no hidden global dependencies.

`/livez` and `/readyz` are internal probes; the public edge must not route them. Readiness depends only
on the Application Database, which status and history need. A provider outage or an unavailable rate
counter store rejects new input elsewhere and never makes the backend unready.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

import psycopg
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from esp_api.auth import SubjectIdentity, identity_router
from esp_api.boundary import NO_STORE, ApiError, error_response
from esp_api.config import ApiSettings, ConfigurationError, bind_candidate_policy
from esp_api.routes.conversations import router as conversations_router
from esp_contracts.eligibility import CandidateAdmissionPolicy
from esp_contracts.ids import Provider
from esp_contracts.runtime import SessionHandle, SessionReservation
from esp_db.client import Db, transaction
from esp_espcon.brain_registry import BrainRegistry
from esp_espcon.conversation import ConfiguredRuntime, ConversationService
from esp_execution_bindings.binding import TokenSigner

__all__ = [
    "ApiDependencies",
    "CounterStore",
    "NativeRuntimeAdapter",
    "NullTelemetry",
    "Telemetry",
    "build_api",
]

_READINESS_TIMEOUT_SECONDS = 2.0


class NativeRuntimeAdapter(Protocol):
    """The fixed provider's native adapter. Conversation creation never calls it."""

    async def create_session(self, reservation: SessionReservation) -> SessionHandle: ...


class CounterStore(Protocol):
    """Rate-limit counter store (P §7.5). Its outage rejects new submissions, not status or history."""

    async def ping(self) -> bool: ...


class Telemetry(Protocol):
    """Payload-free operational events: names and identifiers only, never visitor text or secrets."""

    def emit(self, name: str, attributes: Mapping[str, str]) -> None: ...


class NullTelemetry:
    def emit(self, name: str, attributes: Mapping[str, str]) -> None:
        return None


@dataclass(frozen=True)
class ApiDependencies:
    """Everything the Application Backend uses. `signer` mints setup and operation scopes later."""

    db: Db
    settings: ApiSettings
    identity: SubjectIdentity
    releases: BrainRegistry
    runtimes: Mapping[Provider, ConfiguredRuntime]
    adapters: Mapping[Provider, NativeRuntimeAdapter]
    candidate_policy: CandidateAdmissionPolicy | None
    signer: TokenSigner
    counters: CounterStore | None
    telemetry: Telemetry


def build_api(deps: ApiDependencies) -> FastAPI:
    _require_consistent(deps)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.deps = deps
    app.state.identity = deps.identity
    app.state.telemetry = deps.telemetry
    app.state.conversations = ConversationService(
        deps.db,
        deps.releases,
        release_id=deps.settings.brain_release_id,
        runtimes=deps.runtimes,
        candidate_policy=deps.candidate_policy,
    )

    async def api_error(request: Request, exc: Exception) -> Response:
        if not isinstance(exc, ApiError):
            raise exc
        return error_response(exc)

    app.add_exception_handler(ApiError, api_error)
    app.include_router(identity_router)
    app.include_router(conversations_router)

    @app.get("/livez")
    async def livez() -> JSONResponse:
        return JSONResponse({"status": "alive"}, headers=NO_STORE)

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        database = await _database_ready(deps.db)
        counters = (
            "absent" if deps.counters is None else ("ok" if await _counters_ready(deps.counters) else "unavailable")
        )
        body = {
            "status": "ready" if database else "unavailable",
            "database": "ok" if database else "unavailable",
            "counters": counters,
        }
        return JSONResponse(body, status_code=200 if database else 503, headers=NO_STORE)

    return app


def _require_consistent(deps: ApiDependencies) -> None:
    settings = deps.settings
    if deps.candidate_policy is not None:
        bind_candidate_policy(deps.candidate_policy, settings)
    elif settings.environment == "qualification":
        raise ConfigurationError(["an isolated qualification deployment needs its bound candidate policy"])
    identity = deps.identity
    if (
        identity.cookie_name != settings.cookie_name
        or identity.secure != settings.secure_cookie
        or identity.public_origin != settings.public_origin
        or identity.max_age_seconds != settings.session_max_age_seconds
    ):
        raise ConfigurationError(["the subject identity disagrees with the settings"])
    for provider, runtime in deps.runtimes.items():
        if runtime.provider != provider:
            raise ConfigurationError([f"runtime for {provider} is registered under another provider"])
        if provider not in deps.adapters:
            raise ConfigurationError([f"runtime for {provider} has no native adapter"])


async def _database_ready(db: Db) -> bool:
    try:
        async with asyncio.timeout(_READINESS_TIMEOUT_SECONDS):
            async with transaction(db) as tx:
                row = await tx.execute_one("SELECT 1 AS ok")
    except (psycopg.Error, TimeoutError):
        return False
    return row is not None and row["ok"] == 1


async def _counters_ready(counters: CounterStore) -> bool:
    try:
        async with asyncio.timeout(_READINESS_TIMEOUT_SECONDS):
            return await counters.ping()
    except Exception:
        return False
