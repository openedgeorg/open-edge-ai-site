"""Evidence-gated proxy. The database fence does not wait for provider headers."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, cast

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse

from esp_contracts.runtime import DispatchTicket
from esp_db.client import Db
from esp_espcon.brain_registry import ResolvedRelease
from esp_execution_bindings.authorize import authorize_binding
from esp_execution_bindings.binding import AuthorizationError, TokenVerifier, verify_binding
from esp_execution_bindings.dispatch_fence import with_dispatch_authority
from esp_inference_gateway.adapters.openai_responses import OpenAIResponsesAdapter
from esp_inference_gateway.adapters.xai_responses import XAIResponsesAdapter
from esp_inference_gateway.brain_verifier import VerificationError, verify_and_serialize
from esp_inference_gateway.evidence_recorder import (
    EvidenceError,
    EvidenceRecorder,
    MemoryOutcomeStore,
    persist_verified_request,
    record_outcome,
)
from esp_inference_gateway.request_adapter import RequestAdapter
from esp_inference_gateway.response_relay import relay_response
from esp_inference_gateway.transport import ApprovedRoute, FencedTransport, TransportError
from esp_observability.traces import dispatch_observation, inference_trace_from_binding

__all__ = ["GatewayDependencies", "build_gateway", "dispatch_inference"]


@dataclass
class GatewayDependencies:
    db: Db
    verifier: TokenVerifier
    release: ResolvedRelease
    recorder: EvidenceRecorder
    routes: dict[str, ApprovedRoute]
    transport: FencedTransport
    outcome: MemoryOutcomeStore
    steps: list[str] = field(default_factory=lambda: [])


def build_gateway(deps: GatewayDependencies) -> FastAPI:
    app = FastAPI()

    @app.post("/openai/v1/responses")
    async def openai_responses(request: Request) -> StreamingResponse:
        return await _proxy(deps, request, "openai")

    @app.post("/xai/v1/responses")
    async def xai_responses(request: Request) -> StreamingResponse:
        return await _proxy(deps, request, "xai")

    return app


async def dispatch_inference(
    deps: GatewayDependencies,
    *,
    token: str,
    raw: bytes,
    provider: str,
) -> DispatchTicket:
    if not token:
        raise AuthorizationError("signature_invalid")
    binding = verify_binding(token, "inference", verifier=deps.verifier)
    if binding.provider != provider:
        raise AuthorizationError("authority_mismatch")
    await authorize_binding(binding, db=deps.db)
    _mark(deps, "authorize")
    adapter = _adapter(provider)
    verified = verify_and_serialize(raw, deps.release, adapter)
    if binding.brain_release_id != deps.release.release_id:
        raise VerificationError("artifact_mismatch")
    if verified.brain.sha256 != binding.brain_hash or verified.behavior.sha256 != binding.behavior_hash:
        raise VerificationError("artifact_mismatch")
    selected = deps.routes.get(provider)
    if selected is None or selected.provider != provider or selected.method != "POST":
        raise VerificationError("unsupported_field")
    document = json.loads(verified.body)
    if not isinstance(document, dict):
        raise VerificationError("unsupported_field")
    payload = cast(dict[str, Any], document)
    if payload.get("model") != selected.model:
        raise VerificationError("unsupported_field")
    _mark(deps, "verify")
    receipt = await persist_verified_request(binding, verified, recorder=deps.recorder)
    _mark(deps, "evidence_ack")

    async def start() -> DispatchTicket:
        _mark(deps, "reauthorize")
        ticket = await deps.transport.start(selected, verified.body, receipt)
        _mark(deps, "dispatch")
        return ticket

    ticket = await with_dispatch_authority(binding, start, db=deps.db)
    # Evidence is already durable. A telemetry failure must not turn this into a blocked dispatch.
    try:
        dispatch_observation(
            evidence_persisted=True,
            trace=inference_trace_from_binding(
                binding,
                receipt.inference_id,
                request_body_sha256=receipt.request_sha256,
                request_body_bytes=len(verified.body),
                context_evidence_ref=receipt.proof_ref,
            ),
        )
    except Exception:
        return ticket
    return ticket


async def _proxy(deps: GatewayDependencies, request: Request, provider: str) -> StreamingResponse:
    raw = await request.body()
    token = request.headers.get("esp-inference-token", "")
    try:
        ticket = await dispatch_inference(deps, token=token, raw=raw, provider=provider)
    except AuthorizationError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except VerificationError as exc:
        status = 413 if str(exc) == "context_overflow" else 422
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    except EvidenceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except TransportError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    try:
        upstream = await ticket.response
    except Exception as exc:
        await record_outcome(deps.outcome, ticket.inference_id, "uncertain")
        raise HTTPException(status_code=502, detail="provider_uncertain") from exc
    await record_outcome(deps.outcome, ticket.inference_id, "headers")
    return relay_response(upstream)


def _adapter(provider: str) -> RequestAdapter:
    if provider == "openai":
        return OpenAIResponsesAdapter()
    if provider == "xai":
        return XAIResponsesAdapter()
    raise VerificationError("unsupported_field")


def _mark(deps: GatewayDependencies, name: str) -> None:
    deps.steps.append(name)
