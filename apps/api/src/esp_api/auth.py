"""Browser identity: a signed random-subject cookie, same-origin writes and a subject-bound CSRF token.

The subject is 256 random bits chosen by the backend. The cookie carries
`v1.<kid>.<subject>.<issued-at>.<hmac>` and production names it `__Host-esp_session` with
`Secure; HttpOnly; SameSite=Lax; Path=/` and no Domain. Local HTTP uses the separate
`esp_dev_session` cookie; the cookie name is inside every MAC, so a value issued under one name never
verifies under the other. Key IDs allow rotation: the first configured key signs, every configured key
verifies, and a retired key's cookies and tokens stop verifying.

Writes need the configured origin and an `X-ESP-CSRF` token bound to the cookie's subject.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from esp_api.boundary import NO_STORE, ApiError, read_json_body
from esp_api.config import ApiSettings, SessionKeyRing
from esp_contracts.api import Subject

CSRF_HEADER = "x-esp-csrf"
SUBJECT_BYTES = 32
_VERSION = "v1"
_DOMAIN = "esp-browser-identity/1"
_SUBJECT = re.compile(r"[A-Za-z0-9_-]{43}")
_MAC = re.compile(r"[A-Za-z0-9_-]{43}")
_ISSUED_AT = re.compile(r"0|[1-9][0-9]{0,11}")
_FUTURE_SKEW_SECONDS = 300


@dataclass(frozen=True)
class SessionClaims:
    subject_id: str
    kid: str
    issued_at: int


class SubjectIdentity:
    """Issue and verify the subject cookie and its CSRF token with a rotating HMAC key ring."""

    def __init__(
        self,
        keys: SessionKeyRing,
        *,
        cookie_name: str,
        secure: bool,
        max_age_seconds: int | None,
        public_origin: str,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._keys = keys
        self.cookie_name = cookie_name
        self.secure = secure
        self.max_age_seconds = max_age_seconds
        self.public_origin = public_origin
        self._clock = clock

    @classmethod
    def from_settings(cls, settings: ApiSettings, *, clock: Callable[[], float] = time.time) -> SubjectIdentity:
        return cls(
            settings.session_keys,
            cookie_name=settings.cookie_name,
            secure=settings.secure_cookie,
            max_age_seconds=settings.session_max_age_seconds,
            public_origin=settings.public_origin,
            clock=clock,
        )

    @property
    def current_kid(self) -> str:
        return self._keys.current_kid

    def now(self) -> int:
        return int(self._clock())

    def new_subject(self) -> str:
        return _encode(secrets.token_bytes(SUBJECT_BYTES))

    def issue_cookie(self, subject_id: str, issued_at: int | None = None) -> str:
        if _SUBJECT.fullmatch(subject_id) is None:
            raise ValueError("subject must be 256 random bits in base64url")
        stamp = self.now() if issued_at is None else issued_at
        kid = self._keys.current_kid
        return f"{_VERSION}.{kid}.{subject_id}.{stamp}.{self._sign(kid, 'session', subject_id, str(stamp))}"

    def read_cookie(self, value: str | None) -> SessionClaims | None:
        """Claims from a cookie this deployment signed and has not expired; otherwise None."""
        if not value:
            return None
        parts = value.split(".")
        if len(parts) != 5 or parts[0] != _VERSION:
            return None
        _, kid, subject_id, stamp, mac = parts
        if _SUBJECT.fullmatch(subject_id) is None or _ISSUED_AT.fullmatch(stamp) is None or _MAC.fullmatch(mac) is None:
            return None
        expected = self._mac(kid, "session", subject_id, stamp)
        if expected is None or not hmac.compare_digest(expected, mac):
            return None
        issued_at = int(stamp)
        now = self._clock()
        if issued_at > now + _FUTURE_SKEW_SECONDS:
            return None
        if self.max_age_seconds is not None and now - issued_at > self.max_age_seconds:
            return None
        return SessionClaims(subject_id=subject_id, kid=kid, issued_at=issued_at)

    def set_cookie_header(self, value: str, issued_at: int) -> str:
        attributes = [f"{self.cookie_name}={value}", "Path=/"]
        if self.max_age_seconds is not None:
            remaining = self.max_age_seconds - max(0, self.now() - issued_at)
            attributes.append(f"Max-Age={max(0, remaining)}")
        if self.secure:
            attributes.append("Secure")
        attributes.extend(("HttpOnly", "SameSite=Lax"))
        return "; ".join(attributes)

    def csrf_token(self, subject_id: str) -> str:
        kid = self._keys.current_kid
        return f"{_VERSION}.{kid}.{self._sign(kid, 'csrf', subject_id)}"

    def csrf_valid(self, token: str, subject_id: str) -> bool:
        parts = token.split(".")
        if len(parts) != 3 or parts[0] != _VERSION or _MAC.fullmatch(parts[2]) is None:
            return False
        expected = self._mac(parts[1], "csrf", subject_id)
        return expected is not None and hmac.compare_digest(expected, parts[2])

    def _sign(self, kid: str, purpose: str, *fields: str) -> str:
        mac = self._mac(kid, purpose, *fields)
        if mac is None:
            raise RuntimeError("signing key id is not in the key ring")
        return mac

    def _mac(self, kid: str, purpose: str, *fields: str) -> str | None:
        key = self._keys.key(kid)
        if key is None:
            return None
        message = "\x1f".join((_DOMAIN, purpose, self.cookie_name, kid, *fields)).encode()
        return _encode(hmac.new(key, message, hashlib.sha256).digest())


def identity_of(request: Request) -> SubjectIdentity:
    identity = request.app.state.identity
    if not isinstance(identity, SubjectIdentity):
        raise RuntimeError("application has no subject identity")
    return identity


def require_subject(request: Request) -> Subject:
    """The signed, unexpired subject of this browser. Missing or invalid is 401."""
    identity = identity_of(request)
    claims = identity.read_cookie(request.cookies.get(identity.cookie_name))
    if claims is None:
        raise ApiError(401, "unauthenticated", "A visitor session is required.")
    return Subject(subject_id=claims.subject_id)


def require_same_origin(request: Request) -> None:
    """Writes come from exactly the configured origin; a cross-site fetch is refused."""
    identity = identity_of(request)
    origins = request.headers.getlist("origin")
    if len(origins) != 1 or origins[0] != identity.public_origin:
        raise ApiError(403, "origin_rejected", "The request did not come from this site.")
    sites = request.headers.getlist("sec-fetch-site")
    if sites and sites != ["same-origin"]:
        raise ApiError(403, "origin_rejected", "The request did not come from this site.")


def require_csrf(request: Request, subject: Subject) -> None:
    identity = identity_of(request)
    tokens = request.headers.getlist(CSRF_HEADER)
    if len(tokens) != 1 or not identity.csrf_valid(tokens[0], subject.subject_id):
        raise ApiError(403, "csrf_rejected", "The request is missing a valid CSRF token.")


identity_router = APIRouter()


@identity_router.post("/visitor-session")
async def visitor_session(request: Request) -> JSONResponse:
    """Bootstrap or keep the subject cookie and return its CSRF token. The browser chooses nothing."""
    require_same_origin(request)
    body = await read_json_body(request, allow_empty=True)
    if body is not None and body != {}:
        raise ApiError(400, "invalid_request", "The visitor session request accepts no properties.")
    identity = identity_of(request)
    claims = identity.read_cookie(request.cookies.get(identity.cookie_name))
    issued: tuple[str, int] | None = None
    if claims is None:
        subject_id = identity.new_subject()
        stamp = identity.now()
        issued = (identity.issue_cookie(subject_id, stamp), stamp)
    else:
        subject_id = claims.subject_id
        if claims.kid != identity.current_kid:
            issued = (identity.issue_cookie(subject_id, claims.issued_at), claims.issued_at)
    response = JSONResponse({"csrf_token": identity.csrf_token(subject_id)}, headers=NO_STORE)
    if issued is not None:
        response.headers.append("set-cookie", identity.set_cookie_header(*issued))
    return response


def _encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")
