"""Signed random-subject cookie, CSRF and same-origin rules, key rotation and configuration refusal.

The application runs over real PostgreSQL as the restricted `esp_app` role. Configuration tests are
pure: they show which production and qualification settings are refused before anything listens.
"""

from __future__ import annotations

import base64
import json
import secrets
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from esp_api.auth import SubjectIdentity
from esp_api.config import ConfigurationError, load_candidate_policy, load_settings
from esp_api.main import serve
from esp_contracts.api import ErrorResponse
from scripts.migrate import migrate
from tests.support.api_lab import (
    DEV_ORIGIN,
    FOREIGN_ORIGIN,
    ORIGIN,
    SESSION_MAX_AGE_SECONDS,
    ApiLab,
    close_api_lab,
    encode_key,
    open_api_lab,
)
from tests.support.database import APP_DSN
from tests.support.policy_lab import CLUSTER_UID, policy_document, synthetic_profile, synthetic_release

ROOT = Path(__file__).resolve().parents[2]
PRODUCTION_KEY = encode_key(secrets.token_bytes(32))
PRODUCTION = {
    "ESP_ENVIRONMENT": "production",
    "ESP_PUBLIC_ORIGIN": "https://esp.example",
    "ESP_DATABASE_URL": "postgresql://esp_app:not-a-real-password@db.internal/esp",
    "ESP_SESSION_KEYS": f"k1:{PRODUCTION_KEY}",
    "ESP_SESSION_MAX_AGE_SECONDS": "2592000",
    "ESP_BRAIN_RELEASE_ID": "release-selected-by-owner",
    "ESP_RUNTIME_PROFILES_PATH": "/etc/esp/runtime-profiles.json",
}


@pytest.fixture
async def api_lab(tmp_path: Path) -> AsyncIterator[ApiLab]:
    await migrate(APP_DSN)
    lab = await open_api_lab(tmp_path)
    try:
        yield lab
    finally:
        await close_api_lab(lab)


def _code(body: object) -> str:
    return ErrorResponse.model_validate(body).error.code


def _decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# Cookie issuance


async def test_visitor_session_issues_a_signed_random_host_cookie(api_lab: ApiLab) -> None:
    client = api_lab.client()
    response = await client.post("/visitor-session", headers={"origin": ORIGIN})
    assert response.status_code == 200
    header = response.headers["set-cookie"]
    name_value, *attributes = [part.strip() for part in header.split(";")]
    name, value = name_value.split("=", 1)
    assert name == "__Host-esp_session"
    assert set(attributes) == {"Path=/", f"Max-Age={SESSION_MAX_AGE_SECONDS}", "Secure", "HttpOnly", "SameSite=Lax"}
    assert not any(attribute.lower().startswith("domain") for attribute in attributes)

    version, kid, subject, issued_at, mac = value.split(".")
    assert (version, kid) == ("v1", "k1")
    assert len(_decode(subject)) == 32
    assert issued_at.isdigit()
    assert len(_decode(mac)) == 32
    assert set(response.json()) == {"csrf_token"}

    second = await api_lab.visitor()
    assert second.subject_id != subject


async def test_existing_session_keeps_its_subject_on_bootstrap(api_lab: ApiLab) -> None:
    visitor = await api_lab.visitor()
    before = visitor.cookie()
    refreshed = await visitor.refresh()
    assert refreshed.status_code == 200
    assert "set-cookie" not in refreshed.headers
    assert visitor.cookie() == before


async def test_subject_is_required_and_tampering_is_rejected(api_lab: ApiLab) -> None:
    anonymous = api_lab.client()
    response = await anonymous.get("/conversations")
    assert response.status_code == 401
    assert _code(response.json()) == "unauthenticated"
    assert response.json()["submitted"] is False

    visitor = await api_lab.visitor()
    version, kid, _subject, issued_at, mac = visitor.cookie().split(".")
    forged_subject = encode_key(secrets.token_bytes(32))
    for value in (
        f"{version}.{kid}.{forged_subject}.{issued_at}.{mac}",
        f"{version}.{kid}.{visitor.subject_id}.{int(issued_at) + 1}.{mac}",
        f"{version}.k9.{visitor.subject_id}.{issued_at}.{mac}",
        f"v2.{kid}.{visitor.subject_id}.{issued_at}.{mac}",
        "unsigned-subject",
        "",
    ):
        client = api_lab.client()
        client.cookies.set("__Host-esp_session", value, domain="esp.test")
        assert (await client.get("/conversations")).status_code == 401

    wrong_key = SubjectIdentity.from_settings(
        api_lab.settings(overrides={"ESP_SESSION_KEYS": f"k1:{encode_key(secrets.token_bytes(32))}"})
    )
    client = api_lab.client()
    client.cookies.set("__Host-esp_session", wrong_key.issue_cookie(visitor.subject_id), domain="esp.test")
    assert (await client.get("/conversations")).status_code == 401


async def test_expired_session_is_rejected(api_lab: ApiLab) -> None:
    visitor = await api_lab.visitor()
    expired_subject = visitor.subject_id
    assert (await visitor.list()).status_code == 200
    api_lab.clock.advance(SESSION_MAX_AGE_SECONDS - 1)
    assert (await visitor.list()).status_code == 200
    api_lab.clock.advance(2)
    assert (await visitor.list()).status_code == 401
    refreshed = await visitor.refresh()
    assert refreshed.status_code == 200
    assert visitor.subject_id != expired_subject
    assert (await visitor.list()).json() == {"conversations": []}


# Writes: same origin and CSRF


async def test_writes_require_same_origin_and_a_subject_bound_csrf_token(api_lab: ApiLab) -> None:
    visitor = await api_lab.visitor()
    other = await api_lab.visitor()

    missing_origin = await visitor.create("openai", origin="")
    assert missing_origin.status_code == 403
    assert _code(missing_origin.json()) == "origin_rejected"
    assert (await visitor.create("openai", origin=FOREIGN_ORIGIN)).status_code == 403
    assert (await visitor.create("openai", origin=ORIGIN + ":8443")).status_code == 403
    cross_site = await visitor.create("openai", extra_headers={"sec-fetch-site": "cross-site"})
    assert cross_site.status_code == 403

    missing_csrf = await visitor.create("openai", csrf="")
    assert missing_csrf.status_code == 403
    assert _code(missing_csrf.json()) == "csrf_rejected"
    assert (await visitor.create("openai", csrf=other.csrf)).status_code == 403
    assert (await visitor.create("openai", csrf="v1.k1.not-a-mac")).status_code == 403
    assert await api_lab.owned_conversation_count(visitor.subject_id) == 0

    assert (await visitor.create("openai", extra_headers={"sec-fetch-site": "same-origin"})).status_code == 201

    cross_bootstrap = await api_lab.client().post("/visitor-session", headers={"origin": FOREIGN_ORIGIN})
    assert cross_bootstrap.status_code == 403
    assert "set-cookie" not in cross_bootstrap.headers


async def test_bootstrap_accepts_no_properties(api_lab: ApiLab) -> None:
    client = api_lab.client()
    response = await client.post(
        "/visitor-session",
        headers={"origin": ORIGIN, "content-type": "application/json"},
        content=json.dumps({"subject_id": "chosen-by-the-browser"}).encode(),
    )
    assert response.status_code == 400
    assert "set-cookie" not in response.headers
    empty = await client.post(
        "/visitor-session", headers={"origin": ORIGIN, "content-type": "application/json"}, content=b"{}"
    )
    assert empty.status_code == 200


# Key rotation


async def test_session_key_rotation_keeps_subjects_until_the_old_key_is_retired(api_lab: ApiLab) -> None:
    old_only = await api_lab.visitor()
    created = await old_only.create("openai")
    assert created.status_code == 201
    conversation_id = str(created.json()["id"])
    subject = old_only.subject_id

    rotating = api_lab.build(overrides={"ESP_SESSION_KEYS": f"k2:{encode_key(api_lab.k2)},k1:{encode_key(api_lab.k1)}"})
    browser = api_lab.same_browser(old_only, rotating)
    assert (await browser.get(conversation_id)).status_code == 200
    assert (await browser.create("openai")).status_code == 201

    reissued = await browser.refresh()
    assert reissued.status_code == 200
    assert reissued.headers["set-cookie"].startswith("__Host-esp_session=v1.k2.")
    assert browser.cookie().split(".")[1] == "k2"
    assert browser.subject_id == subject
    assert (await browser.get(conversation_id)).status_code == 200

    retired = api_lab.build(overrides={"ESP_SESSION_KEYS": f"k2:{encode_key(api_lab.k2)}"})
    stale = api_lab.same_browser(old_only, retired)
    assert stale.cookie().split(".")[1] == "k1"
    assert (await stale.get(conversation_id)).status_code == 401
    current = api_lab.same_browser(browser, retired)
    assert (await current.get(conversation_id)).status_code == 200
    assert current.csrf.split(".")[1] == "k2"
    assert (await current.create("openai")).status_code == 201
    retired_csrf = await current.create("openai", csrf=old_only.csrf)
    assert old_only.csrf.split(".")[1] == "k1"
    assert retired_csrf.status_code == 403
    assert _code(retired_csrf.json()) == "csrf_rejected"


# Development cookie separation


async def test_development_uses_a_separate_cookie_that_production_never_accepts(api_lab: ApiLab) -> None:
    development = api_lab.build("development")
    dev_client = api_lab.client(development, origin=DEV_ORIGIN)
    response = await dev_client.post("/visitor-session", headers={"origin": DEV_ORIGIN})
    assert response.status_code == 200
    header = response.headers["set-cookie"]
    assert header.startswith("esp_dev_session=")
    assert "Secure" not in header
    assert "__Host-" not in header

    dev_value = dev_client.cookies.get("esp_dev_session")
    assert dev_value is not None
    production = api_lab.client(api_lab.build("production"))
    production.cookies.set("esp_dev_session", dev_value, domain="esp.test")
    assert (await production.get("/conversations")).status_code == 401
    production.cookies.set("__Host-esp_session", dev_value, domain="esp.test")
    assert (await production.get("/conversations")).status_code == 401


# Configuration refusal


def test_production_configuration_loads_secure_identity_settings() -> None:
    settings = load_settings(PRODUCTION)
    assert settings.environment == "production"
    assert settings.cookie_name == "__Host-esp_session"
    assert settings.secure_cookie
    assert settings.candidate_policy_path is None
    text = repr(settings) + str(settings)
    assert PRODUCTION_KEY not in text
    assert "not-a-real-password" not in text


@pytest.mark.parametrize(
    ("change", "finding"),
    [
        ({"ESP_SESSION_KEYS": None}, "ESP_SESSION_KEYS"),
        ({"ESP_SESSION_KEYS": f"k1:{encode_key(secrets.token_bytes(16))}"}, "ESP_SESSION_KEYS"),
        ({"ESP_SESSION_KEYS": f"k1:{encode_key(bytes(32))}"}, "ESP_SESSION_KEYS"),
        ({"ESP_SESSION_KEYS": f"example:{PRODUCTION_KEY}"}, "ESP_SESSION_KEYS"),
        ({"ESP_SESSION_KEYS": f"k1:{PRODUCTION_KEY},k1:{encode_key(secrets.token_bytes(32))}"}, "ESP_SESSION_KEYS"),
        ({"ESP_SESSION_KEYS": f"k1:{PRODUCTION_KEY},k2:{PRODUCTION_KEY}"}, "ESP_SESSION_KEYS"),
        ({"ESP_SESSION_KEYS": f"K 1:{PRODUCTION_KEY}"}, "ESP_SESSION_KEYS"),
        ({"ESP_PUBLIC_ORIGIN": "http://esp.example"}, "ESP_PUBLIC_ORIGIN"),
        ({"ESP_PUBLIC_ORIGIN": "https://esp.example/app"}, "ESP_PUBLIC_ORIGIN"),
        ({"ESP_PUBLIC_ORIGIN": None}, "ESP_PUBLIC_ORIGIN"),
        ({"ESP_SESSION_MAX_AGE_SECONDS": None}, "ESP_SESSION_MAX_AGE_SECONDS"),
        ({"ESP_SESSION_MAX_AGE_SECONDS": "0"}, "ESP_SESSION_MAX_AGE_SECONDS"),
        ({"ESP_SESSION_MAX_AGE_SECONDS": "forever"}, "ESP_SESSION_MAX_AGE_SECONDS"),
        ({"ESP_CANDIDATE_POLICY_PATH": "/etc/esp/policy.json"}, "ESP_CANDIDATE_POLICY_PATH"),
        ({"ESP_QUALIFICATION_CLUSTER_UID": CLUSTER_UID}, "ESP_QUALIFICATION_CLUSTER_UID"),
        ({"ESP_QUALIFICATION_DEPLOYMENT_REF": "qual-deployment-test-api"}, "ESP_QUALIFICATION_DEPLOYMENT_REF"),
        ({"ESP_PUBLIC_ELIGIBILITY_BYPASS": "1"}, "ESP_PUBLIC_ELIGIBILITY_BYPASS"),
        ({"ESP_ADMISSION_BYPASS": "true"}, "ESP_ADMISSION_BYPASS"),
        ({"ESP_ALLOW_INSECURE_COOKIE": "1"}, "ESP_ALLOW_INSECURE_COOKIE"),
        ({"ESP_DATABASE_URL": None}, "ESP_DATABASE_URL"),
        ({"ESP_BRAIN_RELEASE_ID": None}, "ESP_BRAIN_RELEASE_ID"),
        ({"ESP_RUNTIME_PROFILES_PATH": None}, "ESP_RUNTIME_PROFILES_PATH"),
        ({"ESP_ENVIRONMENT": "staging"}, "ESP_ENVIRONMENT"),
    ],
)
def test_production_refuses_insecure_identity_defaults_and_candidate_bypass(
    change: dict[str, str | None], finding: str
) -> None:
    environ = dict(PRODUCTION)
    for name, value in change.items():
        if value is None:
            environ.pop(name, None)
        else:
            environ[name] = value
    with pytest.raises(ConfigurationError) as refused:
        load_settings(environ)
    assert any(finding in item for item in refused.value.findings)
    assert PRODUCTION_KEY not in str(refused.value)


def test_example_environment_is_refused_in_production() -> None:
    environ: dict[str, str] = {}
    for line in (ROOT / ".env.example").read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        name, _, value = stripped.partition("=")
        environ[name] = value
    assert "ESP_SESSION_KEYS" in environ
    environ["ESP_ENVIRONMENT"] = "production"
    with pytest.raises(ConfigurationError) as refused:
        load_settings(environ)
    assert any("ESP_SESSION_KEYS" in item for item in refused.value.findings)


@pytest.mark.parametrize(
    ("change", "finding"),
    [
        ({"ESP_CANDIDATE_POLICY_PATH": None}, "ESP_CANDIDATE_POLICY_PATH"),
        ({"ESP_QUALIFICATION_CLUSTER_UID": None}, "ESP_QUALIFICATION_CLUSTER_UID"),
        ({"ESP_QUALIFICATION_CLUSTER_UID": "not-a-uuid"}, "ESP_QUALIFICATION_CLUSTER_UID"),
        ({"ESP_QUALIFICATION_DEPLOYMENT_REF": "public-deployment"}, "ESP_QUALIFICATION_DEPLOYMENT_REF"),
        ({"ESP_PUBLIC_ORIGIN": "http://esp.example"}, "ESP_PUBLIC_ORIGIN"),
        ({"ESP_ELIGIBILITY_BYPASS": "1"}, "ESP_ELIGIBILITY_BYPASS"),
    ],
)
def test_qualification_requires_a_bound_candidate_policy(change: dict[str, str | None], finding: str) -> None:
    environ = dict(PRODUCTION)
    environ.update(
        {
            "ESP_ENVIRONMENT": "qualification",
            "ESP_CANDIDATE_POLICY_PATH": "/etc/esp/policy.json",
            "ESP_QUALIFICATION_CLUSTER_UID": CLUSTER_UID,
            "ESP_QUALIFICATION_DEPLOYMENT_REF": "qual-deployment-test-api",
        }
    )
    assert load_settings(environ).environment == "qualification"
    for name, value in change.items():
        if value is None:
            environ.pop(name, None)
        else:
            environ[name] = value
    with pytest.raises(ConfigurationError) as refused:
        load_settings(environ)
    assert any(finding in item for item in refused.value.findings)


def test_development_is_loopback_only_and_takes_no_candidate_policy() -> None:
    environ = dict(PRODUCTION)
    environ.update({"ESP_ENVIRONMENT": "development", "ESP_PUBLIC_ORIGIN": DEV_ORIGIN})
    settings = load_settings(environ)
    assert settings.cookie_name == "esp_dev_session"
    assert not settings.secure_cookie
    for name, value in (
        ("ESP_PUBLIC_ORIGIN", "http://esp.example"),
        ("ESP_CANDIDATE_POLICY_PATH", "/tmp/policy.json"),
    ):
        with pytest.raises(ConfigurationError) as refused:
            load_settings(dict(environ, **{name: value}))
        assert any(name in item for item in refused.value.findings)


def test_policy_loader_rejects_duplicate_keys(tmp_path: Path) -> None:
    profile = synthetic_profile()
    document = policy_document(profile, synthetic_release())
    raw = json.dumps(document)
    duplicated = raw[:-1] + ', "policy_id": "qual-policy-other"}'
    path = tmp_path / "policy.json"
    path.write_text(duplicated, encoding="utf-8")
    environ = dict(PRODUCTION)
    environ.update(
        {
            "ESP_ENVIRONMENT": "qualification",
            "ESP_CANDIDATE_POLICY_PATH": str(path),
            "ESP_QUALIFICATION_CLUSTER_UID": CLUSTER_UID,
            "ESP_QUALIFICATION_DEPLOYMENT_REF": str(document["deployment"]["deployment_ref"]),
        }
    )
    with pytest.raises(ConfigurationError, match="strict JSON"):
        load_candidate_policy(load_settings(environ))
    path.write_text(raw, encoding="utf-8")
    assert load_candidate_policy(load_settings(environ)) is not None


def test_serve_refuses_insecure_production_configuration_before_listening() -> None:
    insecure = dict(PRODUCTION, ESP_PUBLIC_ORIGIN="http://esp.example")
    with pytest.raises(SystemExit) as refused:
        serve(insecure)
    assert "refused" in str(refused.value.code)
    assert PRODUCTION_KEY not in str(refused.value.code)
    with pytest.raises(SystemExit) as pending:
        serve(PRODUCTION)
    assert "pending" in str(pending.value.code)
