"""`POST /conversations/{id}/runs/{run_id}/cancel`: confirm a stop before releasing the guard.

Order, before any runtime change: same origin, subject, CSRF, then a conversation id and a run id
that are both uuids. Another subject's conversation is `404`. A run that is not the current one is
answered with the current view and does not ask the harness to stop. Visitor text is never read.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from esp_api.auth import require_csrf, require_same_origin, require_subject
from esp_api.boundary import NO_STORE, ApiError
from esp_espcon.conversation import ConversationNotFound
from esp_runtime_harconses.lifecycle import SessionLifecycle

router = APIRouter()


@router.post("/conversations/{conversation_id}/runs/{run_id}/cancel")
async def cancel_run(request: Request, conversation_id: str, run_id: str) -> JSONResponse:
    require_same_origin(request)
    subject = require_subject(request)
    require_csrf(request, subject)
    if _uuid_or_none(conversation_id) is None or _uuid_or_none(run_id) is None:
        raise ApiError(400, "invalid_request", "The request is invalid.")
    lifecycle = request.app.state.lifecycle
    if not isinstance(lifecycle, SessionLifecycle):
        raise RuntimeError("application has no session lifecycle")
    try:
        view = await lifecycle.cancel_run(subject.subject_id, conversation_id, run_id)
    except ConversationNotFound as exc:
        raise ApiError(404, "not_found", "No such conversation.") from exc
    return JSONResponse(view.model_dump(mode="json"), headers=NO_STORE)


def _uuid_or_none(value: str) -> str | None:
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        return None
