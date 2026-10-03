"""`GET /conversations/{id}/status?client_request_id=...`: the reconciled view of one request.

Owner-checked (another subject's conversation is `404`). The view comes from current metadata plus the
owning harness's native correlation (`SessionManager.inspect_submission`). Nothing is submitted, replayed
or retried, and no model work starts. When native status exists but cannot be read now, the answer is
`503 service_unavailable` (retryable). Every error here carries `submitted:null`: a status answer that
failed says nothing about whether the request was submitted.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from esp_api.auth import require_subject
from esp_api.boundary import NO_STORE, ApiError
from esp_api.routes.messages import sessions_of
from esp_espcon.conversation import ConversationNotFound
from esp_runtime_harconses.manager import REQUEST_ID_MAX_LENGTH, NativeReadUnavailable

router = APIRouter()


@router.get("/conversations/{conversation_id}/status")
async def get_status(request: Request, conversation_id: str) -> JSONResponse:
    subject = require_unknown_submission_subject(request)
    request_ids = request.query_params.getlist("client_request_id")
    if len(request_ids) != 1 or not request_ids[0] or len(request_ids[0]) > REQUEST_ID_MAX_LENGTH:
        raise ApiError(400, "invalid_request", "Name exactly one client request ID.", submitted=None)
    try:
        view = await sessions_of(request).inspect_submission(subject, conversation_id, request_ids[0])
    except ConversationNotFound as exc:
        raise ApiError(404, "not_found", "No such conversation.", submitted=None) from exc
    except NativeReadUnavailable as exc:
        request.app.state.telemetry.emit("status.unavailable", {"reason": exc.reason})
        raise ApiError(
            503, "service_unavailable", "Status cannot be checked right now.", retryable=True, submitted=None
        ) from exc
    return JSONResponse(view.model_dump(mode="json"), headers=NO_STORE)


def require_unknown_submission_subject(request: Request) -> str:
    """The authenticated subject; an authentication failure says nothing about submission either."""
    try:
        return require_subject(request).subject_id
    except ApiError as exc:
        raise ApiError(exc.status_code, exc.code, exc.message, retryable=exc.retryable, submitted=None) from exc
