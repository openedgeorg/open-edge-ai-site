"""`GET /conversations/{id}/history`: authorized native history from the owning harness only.

Owner-checked (another subject's conversation is `404`). History is read through the conversation's own
native session (`SessionManager.read_authorized_history`) and is never stored by the application. It is
empty only before a native session exists. History that exists but cannot be read now, because its
residency cannot be reserved without waiting, its instance is not ready or the native read fails, is
`503 history_unavailable` (retryable), never an empty transcript. Errors carry `submitted:null`.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from esp_api.boundary import NO_STORE, ApiError
from esp_api.routes.messages import sessions_of
from esp_api.routes.status import require_unknown_submission_subject
from esp_espcon.conversation import ConversationNotFound
from esp_runtime_harconses.manager import NativeReadUnavailable

router = APIRouter()


@router.get("/conversations/{conversation_id}/history")
async def get_history(request: Request, conversation_id: str) -> JSONResponse:
    subject = require_unknown_submission_subject(request)
    try:
        snapshot = await sessions_of(request).read_authorized_history(subject, conversation_id)
    except ConversationNotFound as exc:
        raise ApiError(404, "not_found", "No such conversation.", submitted=None) from exc
    except NativeReadUnavailable as exc:
        request.app.state.telemetry.emit("history.unavailable", {"reason": exc.reason})
        raise ApiError(
            503,
            "history_unavailable",
            "This conversation's history cannot be read right now.",
            retryable=True,
            submitted=None,
        ) from exc
    return JSONResponse(snapshot.model_dump(mode="json"), headers=NO_STORE)
