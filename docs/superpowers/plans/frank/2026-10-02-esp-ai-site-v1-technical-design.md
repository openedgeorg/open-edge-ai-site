# ESP AI Site v1 (PoC Slice) Implementation Plan

> **Revision note (2026-10-02):** Python supersedes TypeScript for the Application Backend, Inference Gateway, and Knowledge Service per Premysl 2026-10-02. The prior TypeScript/Fastify/Vitest/Zod/pnpm stack is replaced by Python 3.12+ / FastAPI / Pydantic v2 / pytest / uv. The existing vanilla HTML/CSS/JS `site/` presentation shell is retained (no React rewrite). Scope remains the §23 first shippable PoC only.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Chapter 23 proof-of-concept slice: a presentation-site AI explainer that creates fixed-provider ESP Conversations (EspCon), streams provider-neutral chat events, and proves exact ESP Core Brain presence on every Model Inference (ModInf) through the ESP Inference Gateway.

**Architecture:** Keep the existing static `site/` presentation shell; add a Python uv workspace monorepo (`apps/`, `packages/`, `services/`, `providers/`, `knowledge/`) per PRD §22. The Application Backend (FastAPI) owns EspCon creation, immediate admission/rejection, and SSE; Codex and Grok Build adapters submit to harnesses whose custom base URLs point only at the Inference Gateway; the gateway injects/verifies the pinned Brain byte-for-byte, persists evidence, then forwards; the Knowledge Service exposes read-only MCP tools on a separate path via the official MCP Python SDK. Native conversation content stays in harness stores; PostgreSQL holds ownership, placement, and Active Agent Run (ActAgeRun) authority only.

**Tech Stack:** Python 3.12+, uv workspace, FastAPI + Uvicorn (Application Backend + Inference Gateway HTTP/SSE), Pydantic v2 (ChatEvent / EspCon / binding schemas), pytest + pytest-asyncio + httpx `ASGITransport`, SQLAlchemy 2 + asyncpg (or psycopg async) for PostgreSQL 16, Redis for rate-limit counters, official MCP Python SDK for Knowledge Service tools, vanilla HTML/CSS/JS in `site/`, Docker Compose for local PoC. Harness adapters: Codex + Grok Build; custom base URLs point ONLY at the Inference Gateway.

**Spec:** `docs/prd/esp-ai-architecture-spec-v0.25.md` (local working copy: `/workspace/frank-plan/esp-ai-architecture-spec-v0.25.md`)

**Subsystem note:** The PRD spans independent subsystems (Inference Gateway, Knowledge Service + publishing worker, dual Harness Instance Pools (HarInsPoo), DA-01 recovery, evaluation suite, citation UX). Prefer separate follow-on plans for production multi-host recovery, Knowledge Publishing Worker + full eval matrix, and citation UX variants. **This single plan covers only the §23 first shippable PoC slice** (Brain invariant + per-Harness Conversation Session (HarConSes) attribution + creation-time harness binding + minimal retrieval + explainer UI).

**PRD language note:** PRD §§7.4 / 9 / 10 leave implementation language open; illustrative TypeScript in §7.3 ChatEvent is schema documentation only — Python + Pydantic models are the chosen equivalent. No PRD conflict with the locked Python stack.

## Global Constraints

- Exact Core Brain presence on every Model Inference (ModInf): UTF-8 bytes and SHA-256 of extracted Brain MUST equal the canonical release; fail closed if missing-and-uninjectable, modified, truncated, or evidence persistence fails (PRD §2.1, §9.10, §19.1).
- ESP Conversation (EspCon) provider is immutable after `POST /conversations`; `openai → Codex`, `xai → Grok Build`; conflicting override rejected before admission (PRD §14).
- Admission policy: execute on immediately available capacity, otherwise reject immediately — no durable input backlog, no auto-replay of rejected drafts (PRD §12.4).
- Harnesses MUST NOT reach provider model APIs directly; only the ESP Inference Gateway may (PRD §9.7).
- Knowledge tools are read-only: `esp.search`, `esp.get_source`, `esp.get_claim`, `esp.get_concept`, `esp.get_asset`, `esp.get_current_value` (PRD §10.1, §20.3).
- Application Database stores coordination metadata only; EspCon content and Native Turn / Work (NatTurWor) history remain in Codex/Grok native stores (PRD §17).
- Terminology rule in prose/docs: full term then abbreviation on every mention (PRD §3); code identifiers use PRD literal names (`conversation_id`, `provider_session`, `active_agent_run_id`, …).
- Branch target: `dev/v1-ai-site` on `openedgeorg/open-edge-ai-site`; keep commits focused; vanilla JS preferred for `site/` (CONTRIBUTING.md).
- DA-01 shared-process hosting is adopted but `pending` until §12.14 qualification; PoC may run single-session-per-process stubs only if multi-session qualification is not yet `validated`, without weakening Brain or EspCon-isolation requirements.
- Product framing: presentation-style ESP / Clear Ledger site with AI explainer grounded in curated SoT — not chat-as-product (README.md / architecture.md).

## Review Focus

- Gateway receives a Brain block with correct markers but wrong interior hash → request blocked, no upstream dispatch, evidence of rejection recorded.
- Duplicate `client_request_id` while an Active Agent Run (ActAgeRun) is current → return/reconnect status, no second native submission.
- Message body includes `"provider":"xai"` on an `openai`-bound EspCon → `4xx` before admission; mapping unchanged.
- Knowledge MCP call with stale `active_agent_run_id` / ownership epoch → rejected by Knowledge Service without touching the gateway.
- Browser loses connection after native acceptance → reconnect reloads native history / status; draft is NOT auto-resubmitted.

---

## File Structure

| Path | Responsibility |
|---|---|
| `pyproject.toml`, `uv.lock` | uv workspace root; Python 3.12+; pytest workspaces |
| `apps/api/` | ESP Application Backend: Chat API, admission, SSE, adapters orchestration (FastAPI) |
| `apps/web/` | Optional thin wrapper; **v1 serves UI from existing `site/`** talking to `apps/api` |
| `site/index.html`, `site/css/main.css`, `site/js/*` | Presentation shell + AI explainer client (vanilla JS) |
| `packages/event_protocol/` | Provider-neutral `ChatEvent` Pydantic models + parse helpers |
| `packages/espcon/` | EspCon domain types + create/pin helpers + Brain registry reader |
| `packages/request_admission/` | Immediate admit/reject reservation logic |
| `packages/provider_router/` | `openai→Codex`, `xai→Grok` resolution |
| `packages/execution_bindings/` | Active Agent Run (ActAgeRun) binding envelope for gateway/MCP |
| `packages/runtime_harconses/` | Harness Conversation Session (HarConSes) mapping types |
| `packages/runtime_placement/` | Shared Harness Instance (ShaHarIns) placement interfaces |
| `packages/recovery/` | Reconciliation helpers (PoC stubs + §12.7 tables as tests) |
| `packages/esp_knowledge_client/` | Typed MCP client for harness adapters |
| `providers/openai/` | Codex adapter: create/resume/submit/cancel/events |
| `providers/xai/` | Grok Build adapter: same interface |
| `services/esp_inference_gateway/` | Brain resolve/inject/verify/evidence/forward/relay (FastAPI) |
| `services/esp_mcp/` | ESP Knowledge Service MCP server (official MCP Python SDK) |
| `knowledge/brain/`, `knowledge/corpus/`, `knowledge/evals/` | Canonical Brain + small PoC corpus + smoke evals |
| `infra/docker-compose.poc.yml` | Postgres, Redis, gateway, api, mcp, harness stubs |
| `infra/migrations/` | SQL for `conversation`, `provider_session`, `harness_instance`, release refs |
| `tests/qualification/` | §23 Gate 1 (Brain) and Gate 2 scaffolding (DA-01) |

---

### Task 1: uv workspace scaffold and ChatEvent protocol

**Files:**
- Create: `pyproject.toml` (workspace root; members for packages/apps/services/providers)
- Create: `packages/event_protocol/pyproject.toml`
- Create: `packages/event_protocol/src/esp_event_protocol/__init__.py`
- Create: `packages/event_protocol/src/esp_event_protocol/chat_event.py`
- Test: `packages/event_protocol/tests/test_chat_event.py`

**Interfaces:**
- Consumes: nothing (foundation)
- Produces: Pydantic v2 discriminated union `ChatEvent` matching PRD §7.3 exactly:

```python
# Discriminated on `type`:
# text_delta | citation | tool_started | tool_finished | asset | usage
# | session_status | output_reset | error | done
#
# Envelope fields on streamed messages:
# conversation_id: str, provider_session_id: str, active_agent_run_id: str,
# native_work_ref: str | None, sequence: int
#
# parse_chat_event(input: object) -> ChatEvent  # raises ValidationError on unknown type
```

Supporting models: `Citation`, `AssetRef`, `Usage`. `session_status.status` ∈ `starting | restoring | running | recovering | warm_idle`.

- [ ] **Step 1: Write the failing test**

```python
from esp_event_protocol.chat_event import parse_chat_event
import pytest
from pydantic import ValidationError

def test_parses_text_delta_per_prd_7_3():
    ev = parse_chat_event({"type": "text_delta", "text": "Hello"})
    assert ev.type == "text_delta"
    assert ev.text == "Hello"

def test_rejects_unknown_event_type():
    with pytest.raises(ValidationError):
        parse_chat_event({"type": "not_real"})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --package esp-event-protocol pytest packages/event_protocol/tests/test_chat_event.py::test_parses_text_delta_per_prd_7_3 -v`
Expected: FAIL with module or `parse_chat_event` not defined

- [ ] **Step 3: Implement `parse_chat_event` and `ChatEvent` in `packages/event_protocol/src/esp_event_protocol/chat_event.py`**

Lock the union exactly to PRD §7.3; use Pydantic v2 `Annotated` + `Field(discriminator="type")`; export from `__init__.py`. Wire uv workspace package `esp-event-protocol`.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --package esp-event-protocol pytest packages/event_protocol/tests/test_chat_event.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml packages/event_protocol
git commit -m "feat: scaffold uv workspace and ChatEvent protocol"
```

---

### Task 2: Canonical Brain release artifacts and registry reader

**Files:**
- Create: `knowledge/brain/esp_brain_core_v1.md`
- Create: `knowledge/brain/manifest_v1.json`
- Create: `knowledge/release/dist/brain_v1/canonical_brain.md` (copy of core; immutable release layout per §9.1)
- Create: `knowledge/release/dist/brain_v1/manifest.json`
- Create: `packages/espcon/pyproject.toml`
- Create: `packages/espcon/src/esp_espcon/__init__.py`
- Create: `packages/espcon/src/esp_espcon/brain_registry.py`
- Test: `packages/espcon/tests/test_brain_registry.py`

**Interfaces:**
- Consumes: none
- Produces:

```python
class BrainManifest(BaseModel):
    brain_version: int
    canonical_brain_sha256: str
    canonical_brain_bytes: int
    behavior_version: int
    source_revision: str
    status: Literal["production", "draft", "retired"]

async def load_brain_release(root_dir: str | Path, version: int) -> tuple[BrainManifest, str]:
    # reads dist/brain_v{N}/; verifies SHA256(canonical_text) == manifest.canonical_brain_sha256
    # and len(canonical_text.encode("utf-8")) == manifest.canonical_brain_bytes
    # raises on mismatch (fail closed)
```

- [ ] **Step 1: Write the failing test**

```python
import pytest
from esp_espcon.brain_registry import load_brain_release

@pytest.mark.asyncio
async def test_load_brain_release_verifies_sha256_and_byte_length():
    manifest, canonical_text = await load_brain_release("knowledge/release", 1)
    assert manifest.brain_version == 1
    assert manifest.status == "production"
    assert len(canonical_text) > 0
    assert len(manifest.canonical_brain_sha256) == 64

@pytest.mark.asyncio
async def test_load_brain_release_fails_closed_when_bytes_disagree():
    with pytest.raises(Exception, match=r"(?i)sha256"):
        await load_brain_release("testdata/brain_tampered", 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --package esp-espcon pytest packages/espcon/tests/test_brain_registry.py -v`
Expected: FAIL (`load_brain_release` not defined)

- [ ] **Step 3: Implement `load_brain_release` and write v1 Brain stub + matching manifest**

PoC Brain content: short conceptual ESP / Clear Ledger stub (≥1 KB UTF-8) covering purpose, mental model, terminology, retrieval policy placeholders from §8.1. Compute real SHA-256 into `manifest.json`. Framing markers for gateway use: `----- BEGIN ESP CORE BRAIN v1 -----` / `----- END ESP CORE BRAIN v1 -----` (PRD §9.4).

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --package esp-espcon pytest packages/espcon/tests/test_brain_registry.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add knowledge packages/espcon
git commit -m "feat: add Brain v1 release artifacts and registry reader"
```

---

### Task 3: Inference Gateway — inject, verify, evidence, fail-closed

**Files:**
- Create: `packages/execution_bindings/pyproject.toml`
- Create: `packages/execution_bindings/src/esp_execution_bindings/binding.py`
- Create: `services/esp_inference_gateway/pyproject.toml`
- Create: `services/esp_inference_gateway/src/esp_inference_gateway/brain_injector.py`
- Create: `services/esp_inference_gateway/src/esp_inference_gateway/brain_verifier.py`
- Create: `services/esp_inference_gateway/src/esp_inference_gateway/evidence_recorder.py`
- Create: `services/esp_inference_gateway/src/esp_inference_gateway/request_adapter.py`
- Create: `services/esp_inference_gateway/src/esp_inference_gateway/server.py`
- Test: `services/esp_inference_gateway/tests/test_brain_verifier.py`
- Test: `services/esp_inference_gateway/tests/test_gateway_pipeline.py`

**Interfaces:**
- Consumes: `load_brain_release` from `esp_espcon`
- Produces: also create `packages/execution_bindings/src/esp_execution_bindings/binding.py` with `ActAgeRunBinding` (fields locked in Task 5 Produces — same type, introduced here so the gateway can validate headers). Pipeline symbols:

```python
def inject_brain_if_absent(
    request_body: ProviderRequest, canonical_brain: str, brain_version: int
) -> InjectResult:  # injection_action: "injected" | "already_present"

def verify_brain(
    request_body: ProviderRequest, canonical_brain: str
) -> VerifyOk | VerifyFail:
    # VerifyFail.reason: "missing" | "modified" | "truncated" | "duplicate" | "wrong_version"

async def persist_evidence(record: ContextEvidence) -> None:
    # ContextEvidence matches PRD §9.6 YAML fields

async def handle_inference_request(request: Request) -> Response:
    # steps §9.4 order; forward only after durable evidence ack
```

- [ ] **Step 1: Write the failing tests**

```python
def test_injects_exact_brain_when_absent():
    out = inject_brain_if_absent({"instructions": "agent stuff"}, CANONICAL, 1)
    assert out.injection_action == "injected"
    assert "----- BEGIN ESP CORE BRAIN v1 -----" in out.body["instructions"]
    assert CANONICAL in out.body["instructions"]

def test_blocks_when_brain_present_but_modified():
    body = {"instructions": "----- BEGIN ESP CORE BRAIN v1 -----\nTAMPERED\n----- END ESP CORE BRAIN v1 -----"}
    result = verify_brain(body, CANONICAL)
    assert result.ok is False
    assert result.reason == "modified"

@pytest.mark.asyncio
async def test_pipeline_does_not_forward_when_evidence_persist_throws():
    res = await handle_inference_request(make_req(evidence_store=failing_store))
    assert res.status_code == 502
    assert upstream.calls == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --package esp-inference-gateway pytest services/esp_inference_gateway/tests -v`
Expected: FAIL (symbols not defined)

- [ ] **Step 3: Implement injector, verifier, evidence recorder (filesystem PoC store under `var/evidence/`), and ordered pipeline**

Approach: treat OpenAI Responses-shaped JSON with an `instructions` (or system) string field for PoC; extract contiguous Brain between versioned markers; compare UTF-8 bytes + SHA-256; on `ok: False` or evidence failure return error to harness without calling upstream. Stub upstream forwarder behind protocol `ProviderForwarder.forward(verified_body) -> AsyncIterator[Chunk]`. FastAPI app in `server.py` for HTTP entry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --package esp-inference-gateway pytest services/esp_inference_gateway/tests -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/execution_bindings services/esp_inference_gateway
git commit -m "feat: inference gateway Brain inject/verify/evidence fail-closed"
```

---

### Task 4: Application Database schema and migrations

**Files:**
- Create: `infra/migrations/001_conversation.sql`
- Create: `infra/migrations/002_provider_session.sql`
- Create: `infra/migrations/003_harness_instance.sql`
- Create: `infra/migrations/004_release_refs.sql`
- Create: `apps/api/pyproject.toml`
- Create: `apps/api/src/esp_api/db/client.py`
- Create: `apps/api/src/esp_api/db/models.py` (SQLAlchemy 2 mapped classes)
- Test: `apps/api/tests/test_schema.py`
- Modify: `infra/docker-compose.poc.yml` (Postgres service)

**Interfaces:**
- Consumes: none
- Produces: tables exactly per PRD §17.1–§17.3 and §17.5 (`conversation`, `provider_session`, `harness_instance`, `brain_release`, `provider_deployment`, `runtime_qualification`); unique partial index: at most one `provider_session` with `is_current = true` per `conversation_id`; `conversation.provider` CHECK IN (`openai`,`xai`); `provider_session.provider` must match parent conversation (enforce in app txn + DB check constraint or trigger). Async SQLAlchemy engine via asyncpg (or psycopg async).

- [ ] **Step 1: Write the failing test**

```python
@pytest.mark.asyncio
async def test_conversation_provider_immutable():
    id_ = await insert_conversation(provider="openai", brain_release_id="v1")
    with pytest.raises(Exception, match=r"(?i)immutable"):
        await update_conversation_provider(id_, "xai")

@pytest.mark.asyncio
async def test_only_one_current_provider_session_per_conversation():
    conv = await insert_conversation(provider="openai", brain_release_id="v1")
    await insert_provider_session(conversation_id=conv, is_current=True, provider="openai")
    with pytest.raises(Exception):
        await insert_provider_session(conversation_id=conv, is_current=True, provider="openai")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --package esp-api pytest apps/api/tests/test_schema.py -v`
Expected: FAIL (no DB / helpers)

- [ ] **Step 3: Write SQL migrations and SQLAlchemy 2 accessors; add Compose Postgres**

Lock column names/types from §17; `active_provider_session_id` nullable FK; `runtime_state` enum values from §17.2.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --package esp-api pytest apps/api/tests/test_schema.py -v`
Expected: PASS (against Compose Postgres)

- [ ] **Step 5: Commit**

```bash
git add infra apps/api
git commit -m "feat: add Application Database schema for EspCon coordination"
```

---

### Task 5: Execution bindings and EspCon create API

**Files:**
- Modify: `packages/execution_bindings/src/esp_execution_bindings/binding.py` (complete exports/tests if Task 3 left stubs)
- Create: `packages/espcon/src/esp_espcon/create_conversation.py`
- Create: `apps/api/src/esp_api/routes/conversations.py`
- Create: `apps/api/src/esp_api/services/conversation_service.py`
- Create: `apps/api/src/esp_api/main.py` (FastAPI app factory)
- Test: `packages/execution_bindings/tests/test_binding.py`
- Test: `apps/api/tests/test_conversations.py`

**Interfaces:**
- Consumes: `load_brain_release`; DB `conversation` insert; `ActAgeRunBinding` from `esp_execution_bindings` (Task 3)
- Produces:
  - `ActAgeRunBinding` field set locked as: `conversation_id`, `provider_session_id`, `session_generation`, `native_session_id`, `active_agent_run_id`, `harness_instance_id`, `runtime_incarnation_id`, `ownership_epoch`, `provider`, `model`, `brain_release_id`, `brain_hash` (finalize in `binding.py` if Task 3 stubbed)
  - `async def create_conversation(input: CreateConversationInput) -> CreateConversationResult` where provider ∈ `openai | xai`
  - HTTP `POST /conversations` body `{"provider": "openai" | "xai"}` → `201` with EspCon id + fixed harness identity (PRD §7.1, §14.2). Reject ineligible provider with `422`.

- [ ] **Step 1: Write the failing tests**

```python
@pytest.mark.asyncio
async def test_post_conversations_pins_provider_and_production_brain(client: AsyncClient):
    res = await client.post("/conversations", json={"provider": "openai"})
    assert res.status_code == 201
    body = res.json()
    assert body["provider"] == "openai"
    assert body["brain_release_id"] == "v1"
    assert body["harness"] == "codex"

@pytest.mark.asyncio
async def test_post_conversations_unknown_provider_returns_422(client: AsyncClient):
    res = await client.post("/conversations", json={"provider": "anthropic"})
    assert res.status_code == 422
```

Use `httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --package esp-api pytest apps/api/tests/test_conversations.py -v`
Expected: FAIL

- [ ] **Step 3: Implement create path — validate eligibility via `provider_deployment` row status, pin Brain from registry, insert `conversation` with `active_provider_session_id = null` (lazy HarConSes)**

Map `openai → harness: "codex"`, `xai → harness: "grok_build"` in response label only; DB stores `provider`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --package esp-api pytest apps/api/tests/test_conversations.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/execution_bindings packages/espcon apps/api
git commit -m "feat: EspCon create API with immutable provider and Brain pin"
```

---

### Task 6: Admission Controller — immediate reserve or reject

**Files:**
- Create: `packages/request_admission/pyproject.toml`
- Create: `packages/request_admission/src/esp_request_admission/admit.py`
- Create: `apps/api/src/esp_api/services/admission_controller.py`
- Create: `apps/api/src/esp_api/services/rate_limits.py`
- Test: `packages/request_admission/tests/test_admit.py`
- Test: `apps/api/tests/test_admission_controller.py`

**Interfaces:**
- Consumes: DB txn helpers; Redis rate-limit counters (PRD §7.5)
- Produces: `async def admit(input: AdmitInput) -> AdmitResult` where

```python
# AdmitResult (Pydantic discriminated union):
# { outcome: "admitted"; binding: ActAgeRunBinding }
# | { outcome: "duplicate_active"; binding: ActAgeRunBinding }
# | { outcome: "rejected"; http_status: 409|429|503;
#     code: "conversation_busy"|"capacity_unavailable"|"service_unavailable"|"rate_limited" }
```

Codes/status locked to PRD §12.4 table. On failure release partial claims; never enqueue message body.

- [ ] **Step 1: Write the failing tests**

```python
@pytest.mark.asyncio
async def test_rejects_second_distinct_request_while_guard_held():
    await admit(AdmitInput(conversation_id="c1", client_request_id="r1", owner_subject_id="v1"))
    second = await admit(AdmitInput(conversation_id="c1", client_request_id="r2", owner_subject_id="v1"))
    assert second.outcome == "rejected"
    assert second.http_status == 409
    assert second.code == "conversation_busy"

@pytest.mark.asyncio
async def test_duplicate_client_request_id_returns_duplicate_active():
    first = await admit(AdmitInput(conversation_id="c1", client_request_id="r1", owner_subject_id="v1"))
    again = await admit(AdmitInput(conversation_id="c1", client_request_id="r1", owner_subject_id="v1"))
    assert again.outcome == "duplicate_active"
    assert again.binding.active_agent_run_id == first.binding.active_agent_run_id

@pytest.mark.asyncio
async def test_rate_limit_exceeded_returns_429():
    res = await admit(AdmitInput(conversation_id="c1", client_request_id="r9", owner_subject_id="limited"))
    assert res.outcome == "rejected"
    assert res.http_status == 429
    assert res.code == "rate_limited"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --package esp-request-admission pytest packages/request_admission/tests -v && uv run --package esp-api pytest apps/api/tests/test_admission_controller.py -v`
Expected: FAIL

- [ ] **Step 3: Implement atomic claim of `conversation.active_provider_session_id` + `provider_session.active_agent_run_id` / `current_request_id` / expiry; Redis INCR+EXPIRE for rate policy; capacity check against `harness_instance.active_turn_limit`**

PoC defaults from §12.2: Active Agent Run (ActAgeRun) deadline 300s; ownership lease 30s.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --package esp-request-admission pytest packages/request_admission/tests -v && uv run --package esp-api pytest apps/api/tests/test_admission_controller.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/request_admission apps/api/src/esp_api/services
git commit -m "feat: immediate admission controller with busy/rate-limit rejects"
```

---

### Task 7: Provider router, session registry, and message submission path

**Files:**
- Create: `packages/provider_router/pyproject.toml`
- Create: `packages/provider_router/src/esp_provider_router/router.py`
- Create: `apps/api/src/esp_api/services/provider_session_registry.py`
- Create: `apps/api/src/esp_api/services/runtime_session_manager.py`
- Create: `apps/api/src/esp_api/routes/messages.py`
- Test: `packages/provider_router/tests/test_router.py`
- Test: `apps/api/tests/test_messages.py`

**Interfaces:**
- Consumes: `admit`, adapters (Task 8/9 interfaces — use fakes in tests)
- Produces:
  - `def resolve_pool(provider: Literal["openai","xai"]) -> Literal["codex","grok_build"]`
  - `POST /conversations/{id}/messages` body `{ client_request_id: str; message: str; provider?: never }` — if `provider` present and ≠ EspCon.provider → `400` before admit
  - On admit success: ensure HarConSes (create/resume), submit, set `current_native_work_ref`, SSE stream of `ChatEvent` (`text/event-stream`)
  - Rejection: JSON `{ code, message }` with §12.4 statuses; no harness submit

- [ ] **Step 1: Write the failing tests**

```python
@pytest.mark.asyncio
async def test_conflicting_provider_override_rejected_before_admission(client, harness_fake):
    conv = await create_conversation(provider="openai")
    res = await client.post(
        f"/conversations/{conv.conversation_id}/messages",
        json={"client_request_id": "r1", "message": "Why ESP?", "provider": "xai"},
    )
    assert res.status_code == 400
    assert harness_fake.submits == []

@pytest.mark.asyncio
async def test_admitted_message_opens_sse_and_emits_running_then_done(client, harness_fake):
    # fake adapter emits text_delta + done; assert SSE event types
    ...
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --package esp-api pytest apps/api/tests/test_messages.py -v`
Expected: FAIL

- [ ] **Step 3: Implement route + registry lazy mapping + router; wire SSE via FastAPI `StreamingResponse` / `EventSourceResponse`**

Lazy HarConSes: first admitted message creates `provider_session` row (`runtime_state: starting→running`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --package esp-api pytest apps/api/tests/test_messages.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/provider_router apps/api
git commit -m "feat: message API with fixed-provider routing and SSE"
```

---

### Task 8: Codex adapter (OpenAI harness)

**Files:**
- Create: `providers/openai/pyproject.toml`
- Create: `providers/openai/src/esp_provider_openai/codex_adapter.py`
- Create: `providers/openai/src/esp_provider_openai/types.py`
- Create: `providers/openai/src/esp_provider_openai/codex_adapter_fake.py`
- Test: `providers/openai/tests/test_codex_adapter.py`

**Interfaces:**
- Consumes: `ActAgeRunBinding`; gateway base URL config
- Produces: Protocol `HarnessAdapter`:

```python
class HarnessAdapter(Protocol):
    async def create_session(self, binding: ActAgeRunBinding) -> CreateSessionResult: ...
    async def resume_session(self, native_session_id: str, binding: ActAgeRunBinding) -> None: ...
    async def submit_turn(self, input: SubmitTurnInput) -> SubmitTurnResult: ...
    async def cancel(self, native_session_id: str, binding: ActAgeRunBinding) -> None: ...
    async def read_history(self, native_session_id: str) -> NativeHistorySnapshot: ...
```

Implemented as `CodexAdapter`. Configure Codex custom provider/base URL → `https://esp-inference-gateway.internal/openai/v1` (PRD §9.2). PoC may ship a **process stub** that speaks the adapter interface and calls the gateway with the binding headers if real Codex binary is unavailable — mark stub clearly; real-binary swap is Task 15 qualification.

- [ ] **Step 1: Write the failing test**

```python
@pytest.mark.asyncio
async def test_submit_turn_attaches_actagerun_binding_headers():
    adapter = CodexAdapter(gateway_base_url=gateway_base_url, transport=spy_transport)
    await adapter.submit_turn(SubmitTurnInput(native_session_id="thr_1", message="Q", binding=sample_binding))
    assert spy_transport.last_request.headers["x-esp-active-agent-run-id"] == sample_binding.active_agent_run_id
    assert spy_transport.last_request.headers["x-esp-conversation-id"] == sample_binding.conversation_id
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --package esp-provider-openai pytest providers/openai/tests -v`
Expected: FAIL

- [ ] **Step 3: Implement CodexAdapter + stub runtime that posts to gateway with binding envelope**

Identity must not be inferred from prompt text (PRD §9.4).

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --package esp-provider-openai pytest providers/openai/tests -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add providers/openai
git commit -m "feat: Codex adapter with request-scoped ActAgeRun binding"
```

---

### Task 9: Grok Build adapter (xAI harness)

**Files:**
- Create: `providers/xai/pyproject.toml`
- Create: `providers/xai/src/esp_provider_xai/grok_build_adapter.py`
- Create: `providers/xai/src/esp_provider_xai/types.py`
- Create: `providers/xai/src/esp_provider_xai/grok_build_adapter_fake.py`
- Test: `providers/xai/tests/test_grok_build_adapter.py`

**Interfaces:**
- Consumes: same `HarnessAdapter` protocol as Task 8
- Produces: `GrokBuildAdapter` implementing `HarnessAdapter`; custom base URL → `https://esp-inference-gateway.internal/xai/v1` (PRD §9.3)

- [ ] **Step 1: Write the failing test**

```python
@pytest.mark.asyncio
async def test_grok_build_adapter_targets_xai_gateway_path():
    adapter = GrokBuildAdapter(gateway_base_url=gateway_base_url)
    result = await adapter.create_session(xai_binding)
    assert result.native_session_id
    assert "/xai/v1" in adapter.model_base_url
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --package esp-provider-xai pytest providers/xai/tests -v`
Expected: FAIL

- [ ] **Step 3: Implement GrokBuildAdapter + stub symmetric to Codex**

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --package esp-provider-xai pytest providers/xai/tests -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add providers/xai
git commit -m "feat: Grok Build adapter with request-scoped ActAgeRun binding"
```

---

### Task 10: Event Normalizer

**Files:**
- Create: `apps/api/src/esp_api/services/event_normalizer.py`
- Test: `apps/api/tests/test_event_normalizer.py`

**Interfaces:**
- Consumes: raw harness events; current ownership check via Conversation Service
- Produces: `def normalize(event: object, ctx: OwnershipContext) -> ChatEvent | None` — drops/stale-rejects events whose `active_agent_run_id` / `ownership_epoch` ≠ current `provider_session`; maps to §7.3 `ChatEvent`.

- [ ] **Step 1: Write the failing test**

```python
def test_stale_ownership_epoch_events_are_dropped():
    out = normalize(harness_text_event, OwnershipContext(active_agent_run_id="a1", ownership_epoch=2))
    # event carries ownership_epoch: 1
    assert out is None

def test_maps_harness_text_chunk_to_text_delta():
    assert normalize({"kind": "text", "delta": "Hi"}, current_ctx) == ChatEventTextDelta(type="text_delta", text="Hi")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --package esp-api pytest apps/api/tests/test_event_normalizer.py -v`
Expected: FAIL

- [ ] **Step 3: Implement normalizer with Codex and Grok Build mapping tables**

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --package esp-api pytest apps/api/tests/test_event_normalizer.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/esp_api/services/event_normalizer.py apps/api/tests/test_event_normalizer.py
git commit -m "feat: normalize harness events to ChatEvent with ownership checks"
```

---

### Task 11: ESP Knowledge Service (MCP) — minimal corpus

**Files:**
- Create: `services/esp_mcp/pyproject.toml`
- Create: `services/esp_mcp/src/esp_mcp/server.py`
- Create: `services/esp_mcp/src/esp_mcp/authz.py`
- Create: `services/esp_mcp/src/esp_mcp/tools.py`
- Create: `knowledge/corpus/website/esp-clear-ledger-overview.md`
- Create: `knowledge/ontology/concepts.json` (minimal)
- Create: `packages/esp_knowledge_client/pyproject.toml`
- Create: `packages/esp_knowledge_client/src/esp_knowledge_client/client.py`
- Test: `services/esp_mcp/tests/test_tools.py`
- Test: `services/esp_mcp/tests/test_authz.py`

**Interfaces:**
- Consumes: restricted read of current `provider_session` authority from App DB
- Produces: MCP tools via official MCP Python SDK — `esp.search(query, filters?)`, `esp.get_source(source_id, version?)`, `esp.get_claim(claim_id)`, `esp.get_concept(concept_id)`, `esp.get_asset(asset_id)`, `esp.get_current_value(key)` — all read-only. `async def authorize_tool_call(binding: ActAgeRunBinding) -> None` raises if binding ≠ current authority.

- [ ] **Step 1: Write the failing tests**

```python
@pytest.mark.asyncio
async def test_esp_search_returns_overview_doc():
    hits = await tools.search(query="Clear Ledger", filters=None, binding=valid_binding)
    assert hits[0].source_id == "corpus/website/esp-clear-ledger-overview"

@pytest.mark.asyncio
async def test_stale_active_agent_run_id_is_rejected():
    with pytest.raises(Exception, match=r"(?i)authority"):
        await tools.search(query="ESP", filters=None, binding=stale_binding)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run --package esp-mcp pytest services/esp_mcp/tests -v`
Expected: FAIL

- [ ] **Step 3: Implement MCP server with filesystem corpus search (keyword PoC; vector index deferred to follow-on plan) and authority check**

No call path from Knowledge Service to Inference Gateway (PRD §5.3, §10). Use official MCP Python SDK tool registration.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run --package esp-mcp pytest services/esp_mcp/tests -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/esp_mcp packages/esp_knowledge_client knowledge/corpus knowledge/ontology
git commit -m "feat: Knowledge Service MCP with read-only tools and authority checks"
```

---

### Task 12: Site AI explainer UI (harness selection + streaming)

**Files:**
- Modify: `site/index.html`
- Modify: `site/css/main.css`
- Create: `site/js/explainer.js`
- Create: `site/js/api-client.js`
- Create: `site/js/event-renderer.js`
- Test: `site/js/event-renderer.test.js` (Node built-in `node:test` + happy-dom or jsdom; no React)

**Interfaces:**
- Consumes: `POST /conversations`, `POST /conversations/:id/messages` (SSE `text/event-stream` of `ChatEvent`)
- Produces: UI flows — New EspCon screen with `Codex / OpenAI` and `Grok Build / xAI` (PRD §6.2); identity label showing fixed harness/model; draft retained on `409/429/503` with manual retry only; renderer for `text_delta`, `citation`, `error`, `done`, `session_status`, `output_reset`.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("event-renderer", () => {
  it("appends text_delta and replaces on output_reset", () => {
    const root = document.createElement("div");
    const r = createRenderer(root);
    r.handle({ type: "text_delta", text: "Hello" });
    r.handle({ type: "output_reset", activeAgentRunId: "a1" });
    r.handle({ type: "text_delta", text: "Reset" });
    assert.equal(root.textContent, "Reset");
  });

  it("busy rejection keeps draft and does not auto-retry", () => {
    const ui = createExplainer({ api: fakeApi });
    ui.setDraft("Why ESP?");
    ui.handleReject({ code: "conversation_busy" });
    assert.equal(ui.getDraft(), "Why ESP?");
    assert.equal(fakeApi.autoRetries, 0);
  });

  it("reconnect after native acceptance reloads history and does not resubmit draft", async () => {
    const ui = createExplainer({ api: fakeApi });
    fakeApi.markAccepted({ conversationId: "c1", clientRequestId: "r1", nativeWorkRef: "nw_1" });
    await ui.simulateDisconnect();
    await ui.reconnect("c1");
    assert.ok(fakeApi.statusChecks.includes("c1"));
    assert.equal(fakeApi.submitsAfterReconnect, 0);
    assert.equal(ui.historyLoaded, true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test site/js/event-renderer.test.js`
Expected: FAIL

- [ ] **Step 3: Implement explainer panel in `site/index.html` (progressive enhancement: presentation readable without JS); wire CSS; implement client + renderer**

Copy/messaging: ESP / Clear Ledger educational companion — not a general chatbot (README). Keep vanilla JS (CONTRIBUTING.md).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test site/js/event-renderer.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add site
git commit -m "feat: in-page AI explainer with harness selection and SSE render"
```

---

### Task 13: Gateway provider forwarders + Compose network policy

**Files:**
- Create: `services/esp_inference_gateway/src/esp_inference_gateway/forwarders/openai_responses.py`
- Create: `services/esp_inference_gateway/src/esp_inference_gateway/forwarders/xai_responses.py`
- Create: `infra/docker-compose.poc.yml` (extend)
- Create: `infra/network-policy.md` (documents ALLOW/DENY from §9.7 for operators)
- Test: `services/esp_inference_gateway/tests/test_openai_responses.py`

**Interfaces:**
- Consumes: verified request body from Task 3 pipeline
- Produces: `OpenAIResponsesForwarder.forward(body, auth) -> AsyncIterator[ProviderChunk]`; `XaiResponsesForwarder` analog; Compose networks: `harness_net` (harness→gateway only), `egress_net` (gateway→external); harness services have no route to `api.openai.com` / `api.x.ai`.

- [ ] **Step 1: Write the failing test**

```python
@pytest.mark.asyncio
async def test_openai_forwarder_streams_chunks_with_correlation_id():
    chunks = [c async for c in forwarder.forward(verified_body, auth={"correlation_id": "inf_1"})]
    assert chunks[-1].type == "done"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --package esp-inference-gateway pytest services/esp_inference_gateway/tests/test_openai_responses.py -v`
Expected: FAIL

- [ ] **Step 3: Implement forwarders (recording upstream fake for unit tests; live keys via env for manual PoC); lock Compose topology**

Provider credentials live only in gateway env (`OPENAI_API_KEY`, `XAI_API_KEY`), not harness containers (PRD §9.7, §21.3).

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --package esp-inference-gateway pytest services/esp_inference_gateway/tests/test_openai_responses.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/esp_inference_gateway/src/esp_inference_gateway/forwarders infra
git commit -m "feat: provider forwarders and PoC network isolation topology"
```

---

### Task 14: Observability smoke traces

**Files:**
- Create: `apps/api/src/esp_api/observability/chat_request_trace.py`
- Create: `services/esp_inference_gateway/src/esp_inference_gateway/observability/inference_trace.py`
- Test: `apps/api/tests/test_chat_request_trace.py`

**Interfaces:**
- Consumes: admit outcomes; gateway verification results
- Produces: structured logs matching PRD §18.1 (`admission_outcome`, `rejection_reason`, `http_status`, …) and §18.2 (`brain_presence_verified`, `canonical_brain_sha256`, `context_evidence_ref`, …). Metric gauges: `brain_verification_success_rate` target 100%; `unobservable_dispatched_inference_count` target 0.

- [ ] **Step 1: Write the failing test**

```python
def test_rejected_admission_records_outcome_and_code():
    trace = record_chat_trace(admit={"outcome": "rejected", "code": "capacity_unavailable", "http_status": 503})
    assert trace["admission_outcome"] == "rejected"
    assert trace["rejection_reason"] == "capacity_unavailable"
    assert trace["http_status"] == 503
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --package esp-api pytest apps/api/tests/test_chat_request_trace.py -v`
Expected: FAIL

- [ ] **Step 3: Implement trace helpers; call from Chat API and gateway pipeline**

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --package esp-api pytest apps/api/tests/test_chat_request_trace.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/esp_api/observability services/esp_inference_gateway/src/esp_inference_gateway/observability
git commit -m "feat: chat and inference observability traces for PoC"
```

---

### Task 15: §23 Gate 1 qualification suite (Brain invariant + attribution)

**Files:**
- Create: `tests/qualification/test_gate1_brain_invariant.py`
- Create: `tests/qualification/test_gate1_attribution.py`
- Create: `tests/qualification/helpers/poc_stack.py`
- Create: `knowledge/evals/conceptual.json` (smoke subset)
- Create: `docs/qualification/da01-manifest.template.yaml` (from §12.14)

**Interfaces:**
- Consumes: running PoC stack (Compose) or in-process harness stubs
- Produces: automated proof of §23 Gate 1 bullets — both providers through gateway; inject when absent; block when corrupted; evidence on every forward; zero bypass; interleaved HarConSes retain correct binding; immediate reject under capacity; no auto-exec of rejected input.

- [ ] **Step 1: Write the failing tests (lock assertions to §23 list)**

```python
@pytest.mark.asyncio
async def test_every_forwarded_openai_request_has_brain_presence_verified():
    evidence = await run_turn(provider="openai", message="What is ESP?")
    assert all(e.brain_presence_verified is True for e in evidence)

@pytest.mark.asyncio
async def test_corrupted_brain_blocked_upstream_call_count_zero():
    result = await send_with_corrupted_brain("openai")
    assert "reject" in result.gateway_status.lower()
    assert result.upstream_calls == 0

@pytest.mark.asyncio
async def test_interleaved_sessions_never_cross_bindings():
    a, b = await run_interleaved(brain_a=1, brain_b=1)  # distinct hashes via fixtures
    assert all(e.conversation_id == a.conversation_id for e in a.evidence)
    assert all(e.conversation_id == b.conversation_id for e in b.evidence)

@pytest.mark.asyncio
async def test_capacity_exhaustion_returns_503_without_later_auto_submit():
    await saturate_active_turns()
    rejected = await post_message(message="later?")
    assert rejected.status_code == 503
    await free_capacity()
    assert "later?" not in harness.received_messages
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/qualification/test_gate1_brain_invariant.py tests/qualification/test_gate1_attribution.py -v`
Expected: FAIL or incomplete stack

- [ ] **Step 3: Wire helpers + fix any product gaps revealed; keep DA-01 manifest status `pending`**

Do not claim Gate 2 / §12.14 `validated` in this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/qualification/test_gate1_*.py -v`
Expected: PASS against stub or live harness as available

- [ ] **Step 5: Commit**

```bash
git add tests/qualification knowledge/evals docs/qualification
git commit -m "test: add §23 Gate 1 Brain invariant and attribution qualification"
```

---

### Task 16: DA-01 / Gate 2 scaffolding (pending validation)

**Files:**
- Create: `tests/qualification/test_gate2_shared_process.py` (skipped/`pending` until real binaries)
- Create: `packages/recovery/pyproject.toml`
- Create: `packages/recovery/src/esp_recovery/reconcile.py`
- Test: `packages/recovery/tests/test_reconcile.py`
- Create: `docs/qualification/README.md` (how to mark `validated` | `invalidated`)

**Interfaces:**
- Consumes: §12.7 reconciliation table
- Produces: `def reconcile_after_interrupt(observed: NativeObservedState) -> ReconciliationAction` covering idle reopen, never-submitted release, ambiguous retain-guard, complete clear, safe continuation, partial reset display, native resume failure → unavailable. Gate 2 tests encoded but `pytest.mark.skip` until harness builds recorded in `runtime_qualification`.

- [ ] **Step 1: Write the failing test**

```python
def test_ambiguous_submission_retains_actagerun_guard_and_does_not_resubmit():
    action = reconcile_after_interrupt(NativeObservedState(kind="submission_unconfirmed"))
    assert action == ReconciliationAction(type="retain_guard", resubmit=False)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run --package esp-recovery pytest packages/recovery/tests -v`
Expected: FAIL

- [ ] **Step 3: Implement reconcile mapper from §12.7; document pending Gate 2**

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run --package esp-recovery pytest packages/recovery/tests -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/recovery tests/qualification/test_gate2_shared_process.py docs/qualification
git commit -m "feat: recovery reconcile helpers and DA-01 Gate 2 scaffolding"
```

---

### Task 17: PoC README + local run path

**Files:**
- Modify: `README.md` (Quick Start for Compose PoC + static site)
- Create: `docs/poc-runbook.md`
- Modify: `docs/architecture.md` (point to gateway + EspCon binding invariants)
- Create: `scripts/check_poc_docs.sh`
- Test: `tests/qualification/test_docs_smoke.py`

**Interfaces:**
- Consumes: all prior tasks
- Produces: documented `uv sync`, `docker compose -f infra/docker-compose.poc.yml up`, `cd site && python3 -m http.server 8080`, env vars list, Gate 1 command (`uv run pytest tests/qualification/test_gate1_*.py`).

- [ ] **Step 1: Write the failing check**

```python
def test_runbook_contains_required_headings():
    text = Path("docs/poc-runbook.md").read_text()
    assert "Gate 1" in text
    assert "Brain" in text
    assert "POST /conversations" in text
```

Also: `scripts/check_poc_docs.sh` fails if runbook missing required headings.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/qualification/test_docs_smoke.py -v`
Expected: FAIL

- [ ] **Step 3: Write runbook + update README/architecture; keep product framing (explainer, not chat-as-product)**

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/qualification/test_docs_smoke.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add README.md docs/architecture.md docs/poc-runbook.md scripts/check_poc_docs.sh tests/qualification/test_docs_smoke.py
git commit -m "docs: PoC runbook and architecture pointers for v1 slice"
```

---

## Deferred to separate plans (not in this PoC)

1. Knowledge Publishing Worker + full Brain release lifecycle automation (§15)
2. Full evaluation suite matrix Astra/Grok × Brain vN (§16) beyond smoke
3. Production multi-Worker Host (WorHos) group crash recovery + measured capacity (§12.10–§12.12 Gate 2 `validated`)
4. Citation UX variants (side panel vs cards) (§25.8)
5. Hybrid vector retrieval / reranking (§25.7)
6. Pending Request Queue (explicitly out of current design, §25 Future option)

---

## Self-Review Notes (author checklist)

1. **Spec coverage (PoC slice):** §6 Web Client, §7 Backend (API/admission/normalizer/router), §8–9 Brain + Gateway, §10 Knowledge MCP (minimal), §11–14 EspCon binding + admission codes, §17 schema, §18 traces (smoke), §21 Compose topology, §22/§23 structure and Gate 1 — mapped to Tasks 1–17. Deferred items listed explicitly. Language choice Python is within PRD open-language clauses.
2. **Step scan:** Steps are test → fail → implement signature → pass → commit; bodies only where algorithm not determined by signature (gateway pipeline order). Python examples use pytest / httpx ASGITransport / Pydantic.
3. **Type consistency:** `ChatEvent`, `ActAgeRunBinding`, `HarnessAdapter`, `AdmitResult` codes reused across tasks without rename; snake_case Python identifiers map to PRD literal JSON/DB names (`conversation_id`, `active_agent_run_id`, …).
4. **Review Focus:** Each of the five failure modes has a dedicated test in Tasks 3, 6, 7, 11, or 12/15.
5. **Proportion:** Plan locks decisions/interfaces/tests from the ~2846-line PRD without transcribing gateway/harness internals. Stack: Python 3.12+ / uv / FastAPI / Pydantic v2 / SQLAlchemy 2 / Redis / MCP Python SDK / Compose — no TypeScript backend remaining.
