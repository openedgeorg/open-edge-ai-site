"""Public MCP schemas. Both native adapters consume this one contract."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from esp_mcp.main import serve
from tests.support.mcp_lab import McpLab, build_mcp_lab

SECTION_10 = {
    "esp.search": {"query", "filters"},
    "esp.get_source": {"source_id", "version"},
    "esp.get_claim": {"claim_id"},
    "esp.get_concept": {"concept_id"},
    "esp.get_asset": {"asset_id"},
    "esp.get_current_value": {"key"},
}
HIDDEN = {
    "binding",
    "owner_id",
    "owner_subject_id",
    "run_id",
    "active_agent_run_id",
    "conversation_id",
    "provider_session_id",
    "native_session_id",
}


@pytest.fixture
async def mcp_lab(tmp_path: Path) -> AsyncIterator[McpLab]:
    lab = await build_mcp_lab(tmp_path)
    try:
        yield lab
    finally:
        await lab.close()


async def test_public_schemas_expose_only_section_10_arguments(mcp_lab: McpLab) -> None:
    contracts = await mcp_lab.tool_contracts()
    assert {item["name"] for item in contracts} == set(SECTION_10)
    for item in contracts:
        schema = item["inputSchema"]
        assert schema["type"] == "object"
        assert schema["additionalProperties"] is False
        properties = set(schema["properties"])
        assert properties == SECTION_10[str(item["name"])]
        assert properties.isdisjoint(HIDDEN)
        annotations = item["annotations"]
        assert annotations["readOnlyHint"] is True
        assert annotations["destructiveHint"] is False
        assert annotations["openWorldHint"] is False
    filters = next(item for item in contracts if item["name"] == "esp.search")
    filter_schema = filters["inputSchema"]["properties"]["filters"]
    assert set(filter_schema["properties"]) == {"source_ids", "version", "as_of"}
    assert filter_schema["additionalProperties"] is False
    asset = next(item for item in contracts if item["name"] == "esp.get_asset")
    assert "version" not in asset["inputSchema"]["properties"]


async def test_openai_and_xai_tokens_share_one_schema(mcp_lab: McpLab) -> None:
    assert await mcp_lab.tool_contracts("openai") == await mcp_lab.tool_contracts("xai")
    openai = await mcp_lab.call_json("esp.get_source", {"source_id": "src-versioned", "version": "1"}, "openai")
    xai = await mcp_lab.call_json("esp.get_source", {"source_id": "src-versioned", "version": "1"}, "xai")
    assert openai == xai
    assert openai["ok"] is True
    assert openai["data"]["metadata"]["version"] == "1"
    assert "version one" in openai["data"]["text"]
    assert "binding" not in openai


async def test_initialize_advertises_tools_only(mcp_lab: McpLab) -> None:
    await mcp_lab.tool_names()
    assert mcp_lab.instructions in {None, ""}
    assert "BEGIN ESP CORE BRAIN" not in (mcp_lab.instructions or "")


async def test_retrieved_marker_stays_source_data(mcp_lab: McpLab) -> None:
    found = await mcp_lab.call_json("esp.search", {"query": "markerbrainfixture"})
    assert found["ok"] is True
    snippet = found["data"]["hits"][0]["snippet"]
    assert "BEGIN ESP CORE BRAIN" in snippet
    assert set(await mcp_lab.tool_names()) == set(SECTION_10)
    assert mcp_lab.instructions in {None, ""}
    rendered = str(mcp_lab.deps.telemetry)
    assert "BEGIN ESP CORE BRAIN" not in rendered
    assert "markerbrainfixture" not in rendered
    assert mcp_lab.gateway_calls == 0


def test_process_refuses_a_signing_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ESP_MCP_SIGNING_KEY", "secret")
    monkeypatch.setenv("ESP_MCP_DATABASE_URL", "postgresql://esp_mcp:esp_mcp@127.0.0.1:54329/esp")
    monkeypatch.setenv("ESP_KNOWLEDGE_PUBLIC_KEY", "public")
    monkeypatch.setenv("ESP_INSPECTION_IDENTITY", "inspection-fixture")
    with pytest.raises(SystemExit, match="signing key"):
        serve()


def test_knowledge_package_does_not_reference_the_gateway() -> None:
    root = Path("services/esp_mcp/src/esp_mcp")
    text = "\n".join(path.read_text(encoding="utf-8") for path in root.glob("*.py"))
    assert "esp_inference_gateway" not in text
    assert "ESP_OPENAI_UPSTREAM" not in text
    assert "ESP_XAI_UPSTREAM" not in text
