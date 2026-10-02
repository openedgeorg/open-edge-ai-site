"""Authenticated read-only MCP surface. Every protected request rechecks transport scope."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

import mcp.types as types
from fastapi import FastAPI
from mcp.server.lowlevel.server import Server
from mcp.server.transport_security import TransportSecuritySettings
from starlette.datastructures import Headers
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from esp_contracts.api import PUBLIC_JSON_MAX_BYTES
from esp_contracts.knowledge import KnowledgeScope
from esp_execution_bindings.binding import AuthorizationError
from esp_mcp.authz import AuthorityOutage, KnowledgeDependencies, authorize_tool_call
from esp_mcp.tools import TOOL_DESCRIPTIONS, TOOL_SCHEMAS, ToolArgumentError, call_esp_tool, validate_tool_call

TOKEN_HEADER = "esp-knowledge-token"
_DENIED_PREFIXES = ("prompts/", "sampling/", "resources/", "roots/", "logging/", "completion/")


def build_knowledge_server(deps: KnowledgeDependencies) -> FastAPI:
    """Mount the official Streamable HTTP app behind current-token authorization."""
    server = Server("esp-knowledge", on_list_tools=_list_tools, on_call_tool=_call_tools(deps))
    mcp_app = server.streamable_http_app(
        streamable_http_path="/mcp",
        json_response=True,
        stateless_http=False,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
        host="esp-knowledge",
        max_request_body_size=PUBLIC_JSON_MAX_BYTES,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        async with mcp_app.router.lifespan_context(mcp_app):
            yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(AuthorityGate, deps=deps)
    app.mount("/", mcp_app)
    return app


def _public_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name=name,
            description=TOOL_DESCRIPTIONS[name],
            input_schema=dict(schema),
            annotations=types.ToolAnnotations(
                read_only_hint=True,
                destructive_hint=False,
                idempotent_hint=True,
                open_world_hint=False,
            ),
        )
        for name, schema in TOOL_SCHEMAS.items()
    ]


async def _list_tools(_ctx: object, _params: object) -> types.ListToolsResult:
    return types.ListToolsResult(tools=_public_tools())


def _call_tools(
    deps: KnowledgeDependencies,
) -> Callable[[object, types.CallToolRequestParams], Awaitable[types.CallToolResult]]:
    async def call_tool(ctx: object, params: types.CallToolRequestParams) -> types.CallToolResult:
        scope = _scope_from_request(getattr(ctx, "request", None))
        arguments = params.arguments if isinstance(params.arguments, dict) else {}
        tool = validate_tool_call(params.name, arguments)
        result = await call_esp_tool(tool, arguments, scope, corpus=deps.corpus)
        payload = result.model_dump(mode="json")
        deps.telemetry.append({"tool": tool, "code": "ok" if result.ok else result.code})
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=json.dumps(payload, sort_keys=True, separators=(",", ":")))],
            structured_content=payload,
            is_error=False,
        )

    return call_tool


def _scope_from_request(request: object) -> KnowledgeScope:
    state = getattr(request, "state", None)
    scope = getattr(state, "knowledge_scope", None)
    if not isinstance(scope, KnowledgeScope):
        raise AuthorizationError("unauthenticated")
    return scope


class _HttpError(Exception):
    def __init__(self, response: Response) -> None:
        super().__init__(response.status_code)
        self.response = response


class AuthorityGate:
    """Recheck the transport token on every HTTP request, including an existing MCP session."""

    def __init__(self, app: ASGIApp, deps: KnowledgeDependencies) -> None:
        self.app = app
        self.deps = deps

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        body = await _read_body(receive)
        if len(body) > PUBLIC_JSON_MAX_BYTES:
            await _error(413, "payload_too_large")(scope, receive, send)
            return
        try:
            knowledge_scope = await self._authorize(scope, body)
        except _HttpError as exc:
            await exc.response(scope, receive, send)
            return
        state = scope.setdefault("state", {})
        if isinstance(state, dict):
            state["knowledge_scope"] = knowledge_scope
        await self.app(scope, _replay(body), send)

    async def _authorize(self, scope: Scope, body: bytes) -> KnowledgeScope:
        method = scope.get("method")
        if method == "POST":
            document = _document(body)
            if document.get("method") == "tools/call":
                _validate_call(document)
        elif method not in {"GET", "DELETE"}:
            raise _HttpError(_error(405, "method_not_allowed"))
        else:
            document = None
        token = Headers(scope=scope).get(TOKEN_HEADER, "")
        try:
            knowledge_scope = await authorize_tool_call(token, deps=self.deps)
        except AuthorityOutage as exc:
            raise _HttpError(_error(503, exc.code)) from exc
        except AuthorizationError as exc:
            status = 401 if str(exc) == "unauthenticated" else 403
            raise _HttpError(_error(status, str(exc))) from exc
        if document is not None and _denied(str(document.get("method", ""))):
            raise _HttpError(_error(403, "method_denied"))
        return knowledge_scope


def _validate_call(document: dict[str, Any]) -> None:
    params = document.get("params", {})
    if not isinstance(params, dict):
        raise _HttpError(_error(400, "invalid_arguments"))
    try:
        validate_tool_call(params.get("name"), params.get("arguments", {}))
    except ToolArgumentError as exc:
        raise _HttpError(_error(400, exc.code)) from exc


def _document(body: bytes) -> dict[str, Any]:
    if not body:
        raise _HttpError(_error(400, "invalid_request"))
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise _HttpError(_error(400, "invalid_request")) from exc
    if not isinstance(parsed, dict):
        raise _HttpError(_error(400, "invalid_request"))
    method = parsed.get("method")
    if not isinstance(method, str) or not method:
        raise _HttpError(_error(400, "invalid_request"))
    return parsed


def _denied(method: str) -> bool:
    return method.startswith(_DENIED_PREFIXES)


def _error(status: int, code: str) -> Response:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": code}})


async def _read_body(receive: Receive) -> bytes:
    chunks = bytearray()
    while True:
        message = await receive()
        if message["type"] != "http.request":
            break
        chunk = message.get("body", b"")
        if isinstance(chunk, bytes):
            chunks.extend(chunk)
        if not message.get("more_body", False):
            break
    return bytes(chunks)


def _replay(body: bytes) -> Receive:
    sent = False

    async def receive() -> Message:
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return receive
