"""`POST /conversations/{id}/messages`: admit immediately, submit once, report only what is proved.

Order, before anything is admitted: same origin, subject, CSRF, a bounded strict body of exactly
`{conversation_id, client_request_id, message}` whose conversation ID equals the path. A provider,
harness or model property is `400 provider_override_rejected`; any other property or invalid value is
`400 invalid_request`; message text over 8,192 UTF-8 bytes is `413`. Rejected bodies are never echoed or
logged: messages are fixed text and telemetry carries codes and identifiers only.

Then immediate admission (`AdmissionController.try_admit`, no input) and, only when admitted, one
submission through the Runtime Session Manager. The live request holds the input; nothing stores it.

- Admission rejected (`not_found`, `conversation_busy`, `capacity_unavailable`, `service_unavailable`,
  `rate_limited`): clean rejection with `submitted:false`; `429` carries `Retry-After`.
- Same request is already current: `200` JSON `SubmissionView` with `X-ESP-Acceptance: duplicate`;
  nothing is submitted.
- Qualified native acceptance: `200 text/event-stream` with `X-ESP-Acceptance: accepted`, constructed
  only now.
- Conclusive non-acceptance: `503 service_unavailable` with `submitted:false`; the reservation was
  released, so the draft may be sent again manually.
- Acceptance unproven: `409 submission_unconfirmed` with `submitted:null`, a status link and
  `resubmission_allowed:false`.

The accepted stream starts with one `session_status: running` envelope for the accepted native work
reference. Live native events are normalized and relayed by the event route (Task 18), which also
serves reconnects; this route never resubmits.

The submission runs in its own task: an HTTP disconnect or handler cancellation abandons only the
response, so a reservation is still released or kept exactly as the outcome requires.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Mapping
from typing import Literal, cast
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ValidationError

from esp_api.auth import require_csrf, require_same_origin, require_subject
from esp_api.boundary import NO_STORE, ApiError, error_response, read_json_body
from esp_contracts.api import STRICT, ErrorBody, SubmitMessage, http_status_for_validation
from esp_contracts.ids import new_id
from esp_contracts.runtime import Accepted, NotSubmitted, SubmissionResult
from esp_espcon.conversation import ConversationNotFound
from esp_event_protocol.chat_event import EventEnvelope, SessionStatus
from esp_request_admission.admit import AdmissionController, Admitted, DuplicateActive, Rejected
from esp_runtime_harconses.manager import NativeReadUnavailable, SessionManager

router = APIRouter()

ACCEPTANCE_HEADER = "x-esp-acceptance"
_OVERRIDE_KEYS = frozenset({"provider", "harness", "model"})
_REJECTION_MESSAGES: Mapping[str, str] = {
    "invalid_request": "The request is invalid. Your message was not sent.",
    "not_found": "No such conversation.",
    "conversation_busy": "This conversation is still working on another message. Your message was not sent.",
    "capacity_unavailable": "No capacity is available right now. Your message was not sent.",
    "service_unavailable": "The conversation service is unavailable right now. Your message was not sent.",
    "rate_limited": "Too many messages right now. Your message was not sent.",
}


class UnconfirmedBody(BaseModel):
    """Ambiguity is not a clean rejection: whether the harness saved the input is unknown."""

    model_config = STRICT
    error: ErrorBody
    submitted: None
    status_url: str
    resubmission_allowed: Literal[False]


def admission_of(request: Request) -> AdmissionController:
    controller = request.app.state.admission
    if not isinstance(controller, AdmissionController):
        raise RuntimeError("application has no admission controller")
    return controller


def sessions_of(request: Request) -> SessionManager:
    manager = request.app.state.sessions
    if not isinstance(manager, SessionManager):
        raise RuntimeError("application has no session manager")
    return manager


def status_url(conversation_id: str, request_id: str) -> str:
    return f"/conversations/{conversation_id}/status?client_request_id={quote(request_id, safe='')}"


def _emit(request: Request, name: str, attributes: Mapping[str, str]) -> None:
    request.app.state.telemetry.emit(name, attributes)


@router.post("/conversations/{conversation_id}/messages")
async def post_message(request: Request, conversation_id: str) -> Response:
    require_same_origin(request)
    subject = require_subject(request)
    require_csrf(request, subject)
    path_id = _uuid_or_none(conversation_id)
    if path_id is None:
        raise ApiError(404, "not_found", "No such conversation.")
    command = _parse(await read_json_body(request))
    if command.conversation_id != path_id:
        raise ApiError(400, "conversation_mismatch", "The conversation in the body does not match the address.")

    admitted = await admission_of(request).try_admit(subject.subject_id, path_id, command.client_request_id)
    if isinstance(admitted, Rejected):
        _emit(request, "message.rejected", {"conversation_id": path_id, "code": admitted.code})
        return _rejection(admitted)
    if isinstance(admitted, DuplicateActive):
        _emit(request, "message.duplicate", {"conversation_id": path_id})
        return await _duplicate(request, subject.subject_id, path_id, command.client_request_id)

    try:
        result = await _submit_detached(request, admitted, command)
    except Exception:
        # Admitted, and the outcome is unknown: never a clean rejection, never `submitted:false`.
        _emit(request, "message.unconfirmed", {"conversation_id": path_id, "code": "submission_error"})
        return _unconfirmed(path_id, command.client_request_id)
    if isinstance(result, Accepted):
        _emit(request, "message.accepted", {"conversation_id": path_id, "native_work_ref": result.work.native_work_ref})
        return _accepted_stream(admitted, result)
    if isinstance(result, NotSubmitted):
        _emit(request, "message.not_submitted", {"conversation_id": path_id, "code": result.code})
        raise ApiError(503, "service_unavailable", _REJECTION_MESSAGES["service_unavailable"], retryable=True)
    _emit(request, "message.unconfirmed", {"conversation_id": path_id})
    return _unconfirmed(path_id, command.client_request_id)


def _parse(body: object) -> SubmitMessage:
    if isinstance(body, dict) and _OVERRIDE_KEYS.intersection(str(key) for key in cast(dict[object, object], body)):
        raise ApiError(
            400, "provider_override_rejected", "A conversation's provider, harness and model are fixed at creation."
        )
    try:
        return SubmitMessage.model_validate(body)
    except ValidationError as exc:
        if http_status_for_validation(exc) == 413:
            raise ApiError(413, "message_too_large", "The message is longer than the allowed size.") from exc
        raise ApiError(400, "invalid_request", "Send exactly a conversation, a request ID and a message.") from exc


async def _submit_detached(request: Request, admitted: Admitted, command: SubmitMessage) -> SubmissionResult:
    """Run the submission to completion even if this handler is cancelled; await it shielded."""
    tasks: set[asyncio.Task[SubmissionResult]] = request.app.state.submissions
    task = asyncio.get_running_loop().create_task(sessions_of(request).submit_message(admitted, command))
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return await asyncio.shield(task)


def _rejection(rejected: Rejected) -> Response:
    error = ApiError(
        rejected.http_status,
        rejected.code,
        _REJECTION_MESSAGES.get(rejected.code, _REJECTION_MESSAGES["service_unavailable"]),
        retryable=rejected.retryable,
    )
    response = error_response(error)
    if rejected.retry_after is not None:
        response.headers["retry-after"] = str(rejected.retry_after)
    return response


async def _duplicate(request: Request, subject_id: str, conversation_id: str, request_id: str) -> Response:
    try:
        view = await sessions_of(request).inspect_submission(subject_id, conversation_id, request_id)
    except ConversationNotFound as exc:
        raise ApiError(404, "not_found", "No such conversation.") from exc
    except NativeReadUnavailable:
        return _unconfirmed(conversation_id, request_id)
    headers = dict(NO_STORE)
    headers[ACCEPTANCE_HEADER] = "duplicate"
    return JSONResponse(view.model_dump(mode="json"), headers=headers)


def _accepted_stream(admitted: Admitted, accepted: Accepted) -> StreamingResponse:
    envelope = EventEnvelope.model_validate(
        {
            "protocol_version": 1,
            "conversation_id": admitted.reservation.conversation_id,
            "provider_session_id": admitted.reservation.provider_session_id,
            "activeAgentRunId": admitted.authority.active_agent_run_id,
            "nativeWorkRef": accepted.work.native_work_ref,
            "connection_id": new_id(),
            "sequence": 1,
            "event": SessionStatus(type="session_status", status="running").model_dump(),
        }
    )
    frame = f"event: session_status\ndata: {envelope.model_dump_json(by_alias=True)}\n\n".encode()

    async def body() -> AsyncIterator[bytes]:
        yield frame

    headers = dict(NO_STORE)
    headers[ACCEPTANCE_HEADER] = "accepted"
    return StreamingResponse(body(), media_type="text/event-stream", headers=headers)


def _unconfirmed(conversation_id: str, request_id: str) -> JSONResponse:
    body = UnconfirmedBody(
        error=ErrorBody(
            code="submission_unconfirmed",
            message="Your message may have been received. Check its status before sending it again.",
            retryable=False,
        ),
        submitted=None,
        status_url=status_url(conversation_id, request_id),
        resubmission_allowed=False,
    )
    headers = dict(NO_STORE)
    headers[ACCEPTANCE_HEADER] = "unconfirmed"
    return JSONResponse(body.model_dump(mode="json"), status_code=409, headers=headers)


def _uuid_or_none(value: str) -> str | None:
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        return None
