"""Owned, lazy, fixed-provider conversation creation over real PostgreSQL and a real Brain Registry.

Every eligibility double here is a recorded pending qualification row plus a test-only candidate
policy bound to the lab's isolated deployment. Nothing inserts or upgrades a validated record, so a
public (production) build can never find a matching validated deployment and must refuse creation.
"""

from __future__ import annotations

import dataclasses
import json
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import psycopg
import pytest
from psycopg import sql

from esp_api.config import ConfigurationError, load_candidate_policy
from esp_api.server import build_api
from esp_contracts.api import ConversationView, ErrorResponse, ProviderOption
from esp_espcon.conversation import ConversationIneligible
from esp_execution_bindings.dispatch_fence import disable_profile, withdraw_release
from scripts.migrate import migrate
from tests.support.api_lab import ApiLab, close_api_lab, open_api_lab
from tests.support.database import APP_DSN
from tests.support.policy_lab import policy_document


@pytest.fixture
async def api_lab(tmp_path: Path) -> AsyncIterator[ApiLab]:
    await migrate(APP_DSN)
    lab = await open_api_lab(tmp_path)
    try:
        yield lab
    finally:
        await close_api_lab(lab)


def _error_code(body: object) -> str:
    return ErrorResponse.model_validate(body).error.code


async def test_create_is_owned_lazy_and_publicly_gated(api_lab: ApiLab) -> None:
    assert (await api_lab.other_owner_get()).status_code == 404
    assert (await api_lab.public_create_pending()).status_code == 503
    assert (await api_lab.cross_origin_post()).status_code == 403
    created = await api_lab.create_with_eligible_test_dependencies()
    assert created.provider == "openai"
    assert api_lab.native_create_calls == 0


async def test_created_conversation_pins_provider_and_release_and_allocates_nothing(api_lab: ApiLab) -> None:
    created = await api_lab.create_with_eligible_test_dependencies()
    visitor = api_lab.last_visitor
    assert visitor is not None
    manifest = api_lab.release

    assert created.harness == "codex"
    assert created.brain_release_id == api_lab.release_id
    assert created.behavior_version == manifest.behavior_version
    assert created.corpus_release_id == manifest.corpus_release_id
    assert created.status == "active"
    assert created.model is None
    assert created.runtime_state is None
    assert created.active_agent_run_id is None

    row = await api_lab.conversation_row(created.id)
    assert row is not None
    assert row["owner_subject_id"] == visitor.subject_id
    assert row["provider"] == "openai"
    assert row["brain_release_id"] == api_lab.release_id
    assert row["behavior_version"] == manifest.behavior_version
    assert row["behavior_hash"] == manifest.behavior_sha256
    assert row["corpus_release_id"] == manifest.corpus_release_id
    assert row["active_provider_session_id"] is None
    assert await api_lab.mapping_count(created.id) == 0
    assert api_lab.native_create_calls == 0
    assert await api_lab.qualification_statuses() == {"pending"}


async def test_create_response_is_201_with_location_and_strict_view(api_lab: ApiLab) -> None:
    visitor = await api_lab.visitor()
    response = await visitor.create("openai")
    assert response.status_code == 201
    view = ConversationView.model_validate(response.json())
    assert response.headers["location"] == f"/conversations/{view.id}"
    fetched = await visitor.get(view.id)
    assert fetched.status_code == 200
    assert ConversationView.model_validate(fetched.json()) == view


async def test_owner_mismatch_and_unknown_ids_are_not_found(api_lab: ApiLab) -> None:
    response = await api_lab.other_owner_get()
    assert response.status_code == 404
    assert _error_code(response.json()) == "not_found"
    assert response.json()["submitted"] is False
    visitor = await api_lab.visitor()
    assert (await visitor.get(str(uuid.uuid4()))).status_code == 404
    assert (await visitor.get("not-a-uuid")).status_code == 404


async def test_list_returns_only_the_callers_conversations(api_lab: ApiLab) -> None:
    owner = await api_lab.visitor()
    first = (await owner.create("openai")).json()
    second = (await owner.create("openai")).json()
    other = await api_lab.visitor()
    other_created = (await other.create("openai")).json()

    listed = await owner.list()
    assert listed.status_code == 200
    ids = {item["id"] for item in listed.json()["conversations"]}
    assert ids == {first["id"], second["id"]}
    assert other_created["id"] not in ids
    other_ids = {item["id"] for item in (await other.list()).json()["conversations"]}
    assert other_ids == {other_created["id"]}


async def test_get_reports_the_model_pinned_at_first_admission(api_lab: ApiLab) -> None:
    created = await api_lab.create_with_eligible_test_dependencies()
    visitor = api_lab.last_visitor
    assert visitor is not None
    pins = await api_lab.record_initial_mapping(created.id)
    assert pins.deployment_ref == api_lab.deployment_refs["openai"]
    assert pins.model == api_lab.profiles["openai"].model
    assert pins.brain_hash == api_lab.release.canonical_brain_sha256
    assert pins.behavior_hash == api_lab.release.behavior_sha256

    view = ConversationView.model_validate((await visitor.get(created.id)).json())
    assert view.model == api_lab.profiles["openai"].model
    assert view.runtime_state == "warm_idle"
    assert view.brain_release_id == created.brain_release_id
    assert api_lab.native_create_calls == 0


async def test_first_admission_pins_follow_current_eligibility_not_creation(api_lab: ApiLab) -> None:
    created = await api_lab.create_with_eligible_test_dependencies()
    assert (await api_lab.admission_pins(created.id)).provider == "openai"
    assert await disable_profile(api_lab.admin, api_lab.qualification_ids["openai"])
    with pytest.raises(ConversationIneligible) as refused:
        await api_lab.admission_pins(created.id)
    assert refused.value.reason == "qualification_invalidated"


@pytest.mark.parametrize(
    "body",
    [
        {"provider": "openai", "model": "another-model"},
        {"provider": "openai", "harness": "grok-build"},
        {"provider": "openai", "brain_release_id": "another-release"},
        {"provider": "openai", "deployment_ref": "another-deployment"},
        {},
        {"provider": "anthropic"},
        {"provider": ["openai"]},
        ["openai"],
    ],
)
async def test_unknown_or_overriding_properties_are_rejected(api_lab: ApiLab, body: object) -> None:
    visitor = await api_lab.visitor()
    response = await visitor.create(body=body)
    assert response.status_code == 400
    assert _error_code(response.json()) == "invalid_request"
    assert "another" not in response.text
    assert await api_lab.owned_conversation_count(visitor.subject_id) == 0


async def test_malformed_and_oversized_bodies_are_rejected(api_lab: ApiLab) -> None:
    visitor = await api_lab.visitor()
    duplicate = await visitor.create(raw=b'{"provider":"xai","provider":"openai"}')
    assert duplicate.status_code == 400
    assert (await visitor.create(raw=b"{not json")).status_code == 400
    assert (await visitor.create(raw=b'{"provider":"openai"}\xff')).status_code == 400
    assert (await visitor.create(raw=b'{"provider":NaN}')).status_code == 400
    oversized = await visitor.create(raw=json.dumps({"provider": "openai", "pad": "x" * 70000}).encode())
    assert oversized.status_code == 413
    assert _error_code(oversized.json()) == "payload_too_large"
    wrong_type = await visitor.create(extra_headers={"content-type": "text/plain"})
    assert wrong_type.status_code == 400
    assert await api_lab.owned_conversation_count(visitor.subject_id) == 0


async def test_registry_brain_withdrawal_refuses_new_pins_without_substitution(api_lab: ApiLab) -> None:
    created = await api_lab.create_with_eligible_test_dependencies()
    owner = api_lab.last_visitor
    assert owner is not None
    await api_lab.registry.withdraw(api_lab.release_id)

    eligibility = await api_lab.eligibility("openai")
    assert not eligibility.eligible
    assert eligibility.reason == "release_withdrawn"
    visitor = await api_lab.visitor()
    refused = await visitor.create("openai")
    assert refused.status_code == 503
    assert _error_code(refused.json()) == "provider_not_eligible"
    assert refused.json()["submitted"] is False
    assert await api_lab.owned_conversation_count(visitor.subject_id) == 0

    kept = ConversationView.model_validate((await owner.get(created.id)).json())
    assert kept.brain_release_id == api_lab.release_id
    with pytest.raises(ConversationIneligible) as admission:
        await api_lab.admission_pins(created.id)
    assert admission.value.reason == "release_withdrawn"


async def test_database_release_withdrawal_refuses_creation(api_lab: ApiLab) -> None:
    assert await withdraw_release(api_lab.admin, api_lab.release_id)
    assert (await api_lab.eligibility("openai")).reason == "release_withdrawn"
    visitor = await api_lab.visitor()
    assert (await visitor.create("openai")).status_code == 503
    assert await api_lab.owned_conversation_count(visitor.subject_id) == 0


async def test_changed_profile_digest_is_not_eligible(api_lab: ApiLab) -> None:
    image_changed = {
        "ESP_RUNTIME_PROFILES_PATH": str(api_lab.changed_profiles("openai", image_digest="sha256:" + "2" * 64))
    }
    assert (await api_lab.eligibility("openai", overrides=image_changed)).reason == "profile_mismatch"
    visitor = await api_lab.visitor(api_lab.build(overrides=image_changed))
    assert (await visitor.create("openai")).status_code == 503

    config_changed = {
        "ESP_RUNTIME_PROFILES_PATH": str(api_lab.changed_profiles("openai", configuration_digest="sha256:" + "3" * 64))
    }
    assert (await api_lab.eligibility("openai", overrides=config_changed)).reason == "deployment_mismatch"
    visitor = await api_lab.visitor(api_lab.build(overrides=config_changed))
    assert (await visitor.create("openai")).status_code == 503
    options = (await visitor.client.get("/providers")).json()["providers"]
    assert {item["provider"]: item["eligible"] for item in options}["openai"] is False
    assert await api_lab.owned_conversation_count(visitor.subject_id) == 0


async def test_invalidated_qualification_refuses_creation(api_lab: ApiLab) -> None:
    assert await disable_profile(api_lab.admin, api_lab.qualification_ids["openai"])
    assert (await api_lab.eligibility("openai")).reason == "qualification_invalidated"
    visitor = await api_lab.visitor()
    assert (await visitor.create("openai")).status_code == 503


async def test_provider_outside_the_candidate_allowlist_is_not_eligible(api_lab: ApiLab) -> None:
    assert (await api_lab.eligibility("xai")).reason == "not_allowlisted"
    visitor = await api_lab.visitor()
    response = await visitor.create("xai")
    assert response.status_code == 503
    assert _error_code(response.json()) == "provider_not_eligible"


async def test_public_build_requires_a_validated_deployment_and_released_brain(api_lab: ApiLab) -> None:
    public = await api_lab.eligibility("openai", environment="production")
    assert not public.eligible
    assert public.reason == "not_publicly_eligible"
    response = await api_lab.public_create_pending()
    assert response.status_code == 503
    assert _error_code(response.json()) == "provider_not_eligible"
    assert await api_lab.qualification_statuses() == {"pending"}
    assert api_lab.native_create_calls == 0


async def test_candidate_policy_must_be_bound_to_this_isolated_deployment(api_lab: ApiLab, tmp_path: Path) -> None:
    other_cluster = tmp_path / "other-cluster-policy.json"
    document = policy_document(api_lab.profiles["openai"], api_lab.release)
    document["deployment"] = dict(
        document["deployment"], cluster_uid=str(uuid.uuid4()), deployment_ref="qual-deployment-test-api"
    )
    other_cluster.write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(ConfigurationError, match="bound to another deployment"):
        load_candidate_policy(api_lab.settings(overrides={"ESP_CANDIDATE_POLICY_PATH": str(other_cluster)}))

    other_ref = tmp_path / "other-ref-policy.json"
    document["deployment"] = dict(document["deployment"], cluster_uid=api_lab.settings().qualification_cluster_uid)
    document["deployment"]["deployment_ref"] = "qual-deployment-elsewhere"
    other_ref.write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(ConfigurationError, match="bound to another deployment"):
        load_candidate_policy(api_lab.settings(overrides={"ESP_CANDIDATE_POLICY_PATH": str(other_ref)}))

    unknown = tmp_path / "unknown-property-policy.json"
    unknown.write_text(
        json.dumps(dict(policy_document(api_lab.profiles["openai"], api_lab.release), public_eligible=True))
    )
    with pytest.raises(ConfigurationError):
        load_candidate_policy(api_lab.settings(overrides={"ESP_CANDIDATE_POLICY_PATH": str(unknown)}))


async def test_public_build_refuses_any_candidate_policy(api_lab: ApiLab) -> None:
    deps = api_lab.dependencies("production")
    isolated = api_lab.dependencies()
    assert deps.candidate_policy is None
    assert isolated.candidate_policy is not None
    with pytest.raises(ConfigurationError, match="candidate policy"):
        build_api(dataclasses.replace(deps, candidate_policy=isolated.candidate_policy))


async def test_conversation_pins_are_immutable_in_the_database(api_lab: ApiLab) -> None:
    created = await api_lab.create_with_eligible_test_dependencies()
    for column, value in (
        ("brain_release_id", "another-release"),
        ("behavior_version", "another-behavior"),
        ("behavior_hash", "b" * 64),
        ("corpus_release_id", "another-corpus"),
        ("owner_subject_id", "another-owner"),
        ("provider", "xai"),
    ):
        with pytest.raises(psycopg.errors.CheckViolation):
            async with api_lab.app_db.pool.connection() as connection:
                await connection.execute(
                    sql.SQL("UPDATE conversation SET {} = %s WHERE id = %s").format(sql.Identifier(column)),
                    (value, created.id),
                )
    row = await api_lab.conversation_row(created.id)
    assert row is not None
    assert row["brain_release_id"] == api_lab.release_id
    assert row["owner_subject_id"] == (api_lab.last_visitor.subject_id if api_lab.last_visitor else None)


async def test_providers_report_eligibility_and_availability_without_internals(api_lab: ApiLab) -> None:
    client = api_lab.client()
    response = await client.get("/providers")
    assert response.status_code == 200
    options = [ProviderOption.model_validate(item) for item in response.json()["providers"]]
    by_provider = {option.provider: option for option in options}
    assert by_provider["openai"].eligible and by_provider["openai"].available
    assert by_provider["openai"].harness == "codex"
    assert by_provider["openai"].display_model == api_lab.profiles["openai"].model
    assert not by_provider["xai"].eligible and not by_provider["xai"].available
    assert by_provider["xai"].harness == "grok-build"
    for item in response.json()["providers"]:
        assert set(item) == {"provider", "harness", "display_model", "eligible", "available"}
    text = response.text
    for internal in (api_lab.deployment_refs["openai"], api_lab.profiles["openai"].image_digest, "credential"):
        assert internal not in text

    await api_lab.set_provider_health("openai", False)
    outage = {item["provider"]: item for item in (await client.get("/providers")).json()["providers"]}
    assert outage["openai"]["eligible"] is True
    assert outage["openai"]["available"] is False
    assert api_lab.native_create_calls == 0


async def test_provider_outage_does_not_disable_status_or_readiness(api_lab: ApiLab) -> None:
    created = await api_lab.create_with_eligible_test_dependencies()
    owner = api_lab.last_visitor
    assert owner is not None
    await api_lab.set_provider_health("openai", False)
    await api_lab.set_provider_health("xai", False)

    assert (await owner.client.get("/livez")).status_code == 200
    ready = await owner.client.get("/readyz")
    assert ready.status_code == 200
    assert ready.json()["status"] == "ready"
    assert (await owner.get(created.id)).status_code == 200
    assert (await owner.list()).status_code == 200


async def test_readiness_reports_an_unreachable_database_and_liveness_does_not(api_lab: ApiLab) -> None:
    app = api_lab.build(db=await api_lab.unreachable_db())
    client = api_lab.client(app)
    assert (await client.get("/livez")).status_code == 200
    ready = await client.get("/readyz")
    assert ready.status_code == 503
    assert ready.json()["status"] == "unavailable"
    assert "esp_app" not in ready.text


async def test_metadata_outage_is_a_retryable_service_unavailable(api_lab: ApiLab) -> None:
    visitor = await api_lab.visitor(api_lab.build(db=await api_lab.unreachable_db()))
    for response in (
        await visitor.create("openai"),
        await visitor.list(),
        await visitor.get(str(uuid.uuid4())),
        await visitor.client.get("/providers"),
    ):
        assert response.status_code == 503
        body = ErrorResponse.model_validate(response.json())
        assert body.error.code == "service_unavailable"
        assert body.error.retryable is True
        assert body.submitted is False
        assert "esp_app" not in response.text
    assert api_lab.native_create_calls == 0


async def test_create_telemetry_is_payload_free(api_lab: ApiLab) -> None:
    created = await api_lab.create_with_eligible_test_dependencies()
    visitor = api_lab.last_visitor
    assert visitor is not None
    await visitor.create("xai")
    names = [name for name, _ in api_lab.telemetry.events]
    assert "conversation.created" in names
    assert "conversation.create_refused" in names
    for _, attributes in api_lab.telemetry.events:
        assert visitor.subject_id not in attributes.values()
        assert visitor.cookie() not in attributes.values()
    created_events = [attrs for name, attrs in api_lab.telemetry.events if name == "conversation.created"]
    assert created_events[-1] == {"provider": "openai", "conversation_id": created.id}
    refused = [attrs for name, attrs in api_lab.telemetry.events if name == "conversation.create_refused"]
    assert refused[-1] == {"provider": "xai", "reason": "not_allowlisted"}
