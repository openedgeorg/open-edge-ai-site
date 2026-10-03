"""Provider options and owned ESP Conversation (EspCon) metadata.

`POST /conversations` takes exactly `{provider}`; any other property, including a model, harness,
release or deployment, is a 400 before anything is read. Creation needs a released Brain and a matching
validated deployment publicly, or the bound isolated-candidate policy in a qualification deployment; it
allocates no native session. Another subject's conversation is indistinguishable from a missing one.
"""

from __future__ import annotations

from collections.abc import Mapping

import psycopg
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, ValidationError

from esp_api.auth import require_csrf, require_same_origin, require_subject
from esp_api.boundary import NO_STORE, ApiError, read_json_body
from esp_contracts.api import STRICT, ConversationView, ProviderOption
from esp_contracts.ids import Provider
from esp_espcon.conversation import ConversationIneligible, ConversationNotFound, ConversationService

router = APIRouter()


class CreateConversation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    provider: Provider


class ConversationList(BaseModel):
    model_config = STRICT
    conversations: list[ConversationView]


class ProviderList(BaseModel):
    model_config = STRICT
    providers: list[ProviderOption]


def conversations_of(request: Request) -> ConversationService:
    service = request.app.state.conversations
    if not isinstance(service, ConversationService):
        raise RuntimeError("application has no conversation service")
    return service


def _emit(request: Request, name: str, attributes: Mapping[str, str]) -> None:
    request.app.state.telemetry.emit(name, attributes)


@router.get("/providers")
async def list_providers(request: Request) -> JSONResponse:
    try:
        options = await conversations_of(request).list_eligible_providers()
    except psycopg.OperationalError as exc:
        raise _unavailable() from exc
    return JSONResponse(ProviderList(providers=options).model_dump(mode="json"), headers=NO_STORE)


@router.post("/conversations")
async def create_conversation(request: Request) -> JSONResponse:
    require_same_origin(request)
    subject = require_subject(request)
    require_csrf(request, subject)
    body = await read_json_body(request)
    try:
        command = CreateConversation.model_validate(body)
    except ValidationError as exc:
        raise ApiError(400, "invalid_request", "Name exactly one supported provider and nothing else.") from exc
    try:
        view = await conversations_of(request).create_conversation(subject.subject_id, command.provider)
    except ConversationIneligible as exc:
        _emit(request, "conversation.create_refused", {"provider": exc.provider, "reason": exc.reason})
        raise ApiError(
            503, "provider_not_eligible", "This provider cannot start a new conversation right now."
        ) from exc
    except psycopg.OperationalError as exc:
        raise _unavailable() from exc
    _emit(request, "conversation.created", {"provider": view.provider, "conversation_id": view.id})
    headers = dict(NO_STORE, location=f"/conversations/{view.id}")
    return JSONResponse(view.model_dump(mode="json"), status_code=201, headers=headers)


@router.get("/conversations")
async def list_conversations(request: Request) -> JSONResponse:
    subject = require_subject(request)
    try:
        views = await conversations_of(request).list_conversations(subject.subject_id)
    except psycopg.OperationalError as exc:
        raise _unavailable() from exc
    return JSONResponse(ConversationList(conversations=views).model_dump(mode="json"), headers=NO_STORE)


@router.get("/conversations/{conversation_id}")
async def get_conversation(request: Request, conversation_id: str) -> JSONResponse:
    subject = require_subject(request)
    try:
        view = await conversations_of(request).get_conversation(subject.subject_id, conversation_id)
    except ConversationNotFound as exc:
        raise ApiError(404, "not_found", "No such conversation.") from exc
    except psycopg.OperationalError as exc:
        raise _unavailable() from exc
    return JSONResponse(view.model_dump(mode="json"), headers=NO_STORE)


def _unavailable() -> ApiError:
    return ApiError(503, "service_unavailable", "Conversation metadata is temporarily unavailable.", retryable=True)
