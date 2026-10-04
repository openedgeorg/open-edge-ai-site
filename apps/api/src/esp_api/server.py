"""Application Backend service factory and its explicit dependency container.

`build_api` refuses inconsistent dependencies instead of serving with them: a candidate policy outside
an isolated qualification deployment, a policy bound to another deployment, a qualification deployment
without its policy, an identity that disagrees with the settings, or a configured runtime without an
adapter. There are no hidden global dependencies.

`/livez` and `/readyz` are internal probes; the public edge must not route them. Readiness depends only
on the Application Database, which status and history need. A provider outage or an unavailable rate
counter store rejects new input elsewhere and never makes the backend unready.

Message submission composes immediate admission (`AdmissionController`) with the Runtime Session Manager
(`SessionManager`), which routes each conversation's fixed provider to its own pool (`ProviderRouter`).
A counter store needs its reviewed rate policy. Without a counter store every new message is refused as
`503 service_unavailable` before admission reserves anything (P §7.5); status and history still work.

Every response keeps the clean rejection shape. An unexpected exception becomes a fixed-text
`500 internal_error` that echoes nothing from the exception; the exception still propagates to the
server so it is logged there, not in the response.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Protocol

import psycopg
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from esp_api.auth import SubjectIdentity, identity_router
from esp_api.boundary import NO_STORE, ApiError, error_response
from esp_api.config import ApiSettings, ConfigurationError, bind_candidate_policy
from esp_api.routes.cancel import router as cancel_router
from esp_api.routes.conversations import router as conversations_router
from esp_api.routes.events import EventAttachments
from esp_api.routes.events import router as events_router
from esp_api.routes.history import router as history_router
from esp_api.routes.messages import drain_submissions
from esp_api.routes.messages import router as messages_router
from esp_api.routes.status import router as status_router
from esp_contracts.eligibility import CandidateAdmissionPolicy
from esp_contracts.ids import Provider
from esp_contracts.runtime import SubmissionResult
from esp_db.client import Db, transaction
from esp_espcon.brain_registry import BrainRegistry
from esp_espcon.conversation import ConfiguredRuntime, ConversationService
from esp_execution_bindings.binding import TokenSigner
from esp_provider_router.router import NativeRuntimeAdapter, ProviderRouter
from esp_request_admission.admit import AdmissionController
from esp_request_admission.rate_limits import CounterStoreUnavailable, RateDecision, RatePolicy
from esp_runtime_harconses.lifecycle import SessionLifecycle
from esp_runtime_harconses.manager import SessionLimits, SessionManager
from esp_runtime_harconses.supervision import RunSupervision

__all__ = [
    "ApiDependencies",
    "CounterStore",
    "NativeRuntimeAdapter",
    "NullTelemetry",
    "Telemetry",
    "build_api",
]

_READINESS_TIMEOUT_SECONDS = 2.0


class CounterStore(Protocol):
    """Rate-limit counter store (P §7.5). Its outage rejects new submissions, not status or history."""

    async def ping(self) -> bool: ...

    async def check_rate(self, subject_id: str, policy: RatePolicy) -> RateDecision: ...


class _AbsentCounterStore:
    """No counter store is configured: every rate check is an outage, so no new input is admitted."""

    async def ping(self) -> bool:
        return False

    async def check_rate(self, subject_id: str, policy: RatePolicy) -> RateDecision:
        raise CounterStoreUnavailable("counter_store_unconfigured")


# Never consulted: the absent counter store refuses before reading any policy.
_UNCONFIGURED_RATE_POLICY = RatePolicy(
    policy_id="unconfigured", window_seconds=1, capacity=1, refill=1, expiry_seconds=1
)


class Telemetry(Protocol):
    """Payload-free operational events: names and identifiers only, never visitor text or secrets."""

    def emit(self, name: str, attributes: Mapping[str, str]) -> None: ...


class NullTelemetry:
    def emit(self, name: str, attributes: Mapping[str, str]) -> None:
        return None


@dataclass(frozen=True)
class ApiDependencies:
    """Everything the Application Backend uses. `signer` mints operation scopes after native setup.

    `adapters` holds one pool client per provider (`NativeRuntimeAdapter`); the router places each under
    that provider's fixed pool. `rate_policy` is the reviewed visitor rate policy the counter store
    enforces. `session_limits` bounds setup, acceptance confirmation and native reads.
    """

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
    rate_policy: RatePolicy | None = None
    session_limits: SessionLimits = field(default_factory=SessionLimits)


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncGenerator[None]:
    yield
    # Detached submissions settle (bounded) before shutdown; what is left keeps its guard.
    await drain_submissions(app)


def build_api(deps: ApiDependencies) -> FastAPI:
    _require_consistent(deps)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=_lifespan)
    app.state.deps = deps
    app.state.identity = deps.identity
    app.state.telemetry = deps.telemetry
    conversations = ConversationService(
        deps.db,
        deps.releases,
        release_id=deps.settings.brain_release_id,
        runtimes=deps.runtimes,
        candidate_policy=deps.candidate_policy,
    )
    app.state.conversations = conversations
    admission = AdmissionController(
        deps.db,
        conversations,
        rates=deps.counters if deps.counters is not None else _AbsentCounterStore(),
        rate_policy=deps.rate_policy if deps.rate_policy is not None else _UNCONFIGURED_RATE_POLICY,
    )
    app.state.admission = admission
    sessions = SessionManager(
        deps.db,
        ProviderRouter.for_providers(deps.adapters),
        deps.signer,
        admission,
        limits=deps.session_limits,
        telemetry=deps.telemetry,
    )
    app.state.sessions = sessions
    lifecycle = SessionLifecycle(deps.db, deps.adapters, deps.signer, sessions.resident_reads)
    app.state.lifecycle = lifecycle
    app.state.supervision = RunSupervision(lifecycle)
    app.state.events = EventAttachments(deps.db, deps.adapters)
    submissions: set[asyncio.Task[SubmissionResult]] = set()
    app.state.submissions = submissions

    async def api_error(request: Request, exc: Exception) -> Response:
        if not isinstance(exc, ApiError):
            raise exc
        return error_response(exc)

    async def unexpected_error(request: Request, exc: Exception) -> Response:
        return error_response(ApiError(500, "internal_error", "The request could not be completed."))

    app.add_exception_handler(ApiError, api_error)
    app.add_exception_handler(Exception, unexpected_error)
    app.include_router(identity_router)
    app.include_router(conversations_router)
    app.include_router(messages_router)
    app.include_router(status_router)
    app.include_router(history_router)
    app.include_router(cancel_router)
    app.include_router(events_router)

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
    if deps.counters is not None and deps.rate_policy is None:
        raise ConfigurationError(["a counter store needs its reviewed rate policy"])
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
