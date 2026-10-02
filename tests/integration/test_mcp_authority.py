"""Knowledge MCP authorization is transport-only and current."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from tests.support.mcp_lab import McpLab, build_mcp_lab

TOOLS = {
    "esp.search",
    "esp.get_source",
    "esp.get_claim",
    "esp.get_concept",
    "esp.get_asset",
    "esp.get_current_value",
}


@pytest.fixture
async def mcp_lab(tmp_path: Path) -> AsyncIterator[McpLab]:
    lab = await build_mcp_lab(tmp_path)
    try:
        yield lab
    finally:
        await lab.close()


async def test_mcp_scope_is_transport_only(mcp_lab: McpLab) -> None:
    assert set(await mcp_lab.tool_names()) == TOOLS
    assert await mcp_lab.stale_call_status() == 403
    assert await mcp_lab.model_supplied_binding_status() == 400
    assert mcp_lab.gateway_calls == 0


async def test_rejected_authority_never_reaches_retrieval(mcp_lab: McpLab) -> None:
    assert await mcp_lab.wrong_audience_status() == 403
    assert await mcp_lab.setup_token_status() == 403
    assert await mcp_lab.authority_outage_status() == 503
    assert mcp_lab.gateway_calls == 0
    assert mcp_lab.deps.telemetry == []


async def test_established_session_loses_revoked_incarnation(mcp_lab: McpLab) -> None:
    assert set(await mcp_lab.tool_names()) == TOOLS
    assert await mcp_lab.revoked_incarnation_status() == 403
    assert mcp_lab.gateway_calls == 0


async def test_forged_session_is_not_authority(mcp_lab: McpLab) -> None:
    assert await mcp_lab.missing_token_status() == 401
    assert await mcp_lab.forged_session_with_token_status() == 404
    rendered = json.dumps(mcp_lab.deps.telemetry)
    assert "privatecanarytoken" not in rendered
    assert mcp_lab.gateway_calls == 0


async def test_prompt_sampling_and_write_requests_are_rejected(mcp_lab: McpLab) -> None:
    assert await mcp_lab.method_status("prompts/list") == 403
    assert await mcp_lab.method_status("prompts/get", {"name": "ignored"}) == 403
    assert await mcp_lab.method_status("sampling/createMessage", {"messages": []}) == 403
    assert await mcp_lab.method_status("resources/read", {"uri": "https://example.invalid/secret"}) == 403
    assert await mcp_lab.write_tool_status() == 400
    assert mcp_lab.deps.telemetry == []
    assert mcp_lab.gateway_calls == 0


async def test_exact_value_outage_returns_unavailable(mcp_lab: McpLab) -> None:
    outage = await mcp_lab.current_value_outage()
    assert outage == {"ok": False, "code": "unavailable"}
    assert "late" not in json.dumps(outage)
    assert "early" not in json.dumps(outage)


async def test_server_uses_the_read_only_knowledge_role(mcp_lab: McpLab) -> None:
    assert await mcp_lab.knowledge_view_visible()
    assert await mcp_lab.write_sqlstate() == "42501"
    assert await mcp_lab.gateway_view_sqlstate() == "42501"


async def test_tools_return_recorded_public_results(mcp_lab: McpLab) -> None:
    source = await mcp_lab.call_json("esp.get_source", {"source_id": "src-versioned", "version": "1"})
    assert source["ok"] is True
    assert source["corpus_release_id"] == mcp_lab.corpus_lab.corpus_id
    assert source["data"]["metadata"]["version"] == "1"
    claim = await mcp_lab.call_json("esp.get_claim", {"claim_id": "fixture-claim"})
    assert claim["data"]["claim"]["text"] == "synthetic fixture claim tied to the recorded quote"
    concept = await mcp_lab.call_json("esp.get_concept", {"concept_id": "fixture-concept"})
    assert concept["data"]["concept"]["definition"].startswith("A synthetic fixture concept")
    asset = await mcp_lab.call_json("esp.get_asset", {"asset_id": "asset-fixture"})
    assert asset["data"]["asset_id"] == "asset-fixture"
    assert asset["data"]["version"] == "1"
    current = await mcp_lab.call_json("esp.get_current_value", {"key": "fixture.asof"})
    assert current["data"]["current_value"]["value"] == "late"
    conflict = await mcp_lab.call_json("esp.get_current_value", {"key": "fixture.parameter"})
    assert conflict == {"ok": False, "code": "conflict"}
    hidden = await mcp_lab.call_json("esp.search", {"query": "privatecanarytoken"})
    assert hidden["data"]["hits"] == []
    forbidden = await mcp_lab.call_json("esp.get_source", {"source_id": "src-private", "version": "1"})
    assert forbidden == {"ok": False, "code": "forbidden"}
    withdrawn = await mcp_lab.call_json("esp.get_source", {"source_id": "src-withdrawn", "version": "1"})
    assert withdrawn == {"ok": False, "code": "unavailable"}
    for payload in (source, claim, concept, asset, current):
        assert "binding" not in payload
        assert "active_agent_run_id" not in payload
        assert "owner_subject_id" not in payload
