# ESP AI Site v1 C3 Consensus Technical Design and Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Planning-only handoff:** the preceding skill instruction and every task/commit command below apply only to a separately authorized implementation job. This job writes this plan and its worker report only; it does not implement, spawn, create a branch, commit, push, open a PR, qualify a runtime, or deploy.

**Goal:** Deliver the complete PRD v0.25 conversational ESP website, with §23 as the first shippable milestone inside v1, immutable provider binding, immediate admission, native-owned history, authoritative retrieval, and exact Brain evidence on every provider request.

**Architecture:** Keep vanilla `site/` and use Frank's Python service/package scaffold, incorporating Astra's full Chapters 1–26 contracts and G0–G4 with C3 corrections. The backend coordinates separate Codex and Grok Build shared-process pools; native harnesses own loops and history, the mandatory gateway owns provider connections and exact-request evidence, and the independently authorized Knowledge Service supplies read-only MCP retrieval. PostgreSQL holds current authority, Valkey holds rate counters, native volumes hold native state, and protected object stores hold immutable releases and evidence.

**Tech Stack:** Python 3.12+ / uv / FastAPI / Pydantic v2 / pytest for Application Backend, Inference Gateway and Knowledge Service; official MCP Python SDK mounted in the Knowledge Service's FastAPI application; vanilla HTML/CSS/JS. Selected engineering components: psycopg 3 async with explicit SQL, PostgreSQL 17, Valkey 8, S3-compatible encrypted storage, httpx/httpcore with a qualified transport boundary, pytest-asyncio/httpx ASGI tests, pytest-playwright, ruff, pyright, local embeddings/pgvector, OpenTelemetry, local Compose and proposed Kubernetes deployment.

**Spec:** [P — ESP architecture specification v0.25](../../prd/esp-ai-architecture-spec-v0.25.md), all Chapters 1–26. [F — Frank Python scaffold](frank/2026-10-02-esp-ai-site-v1-technical-design.md) and [A — Astra original](2026-10-02-esp-ai-site-v1-technical-design.md) are reference inputs, preserved unchanged. Eventual work targets `dev/v1-ai-site`; the planning baseline is commit `8a724a608b8ddca70d32ad87ae92d542e4bbcfac`.

## Global Constraints

- **C3 is normative:** Grok r2's consensus and signing criteria, corrected everywhere by Astra r2 D1–D5. Locked user decisions govern, followed by P, then explicitly identified engineering choices. No older plan/README wording overrides them.
- “The complete released ESP Core Brain must be present **word-for-word, without summarization, truncation, reordering, omission, or substitution, in every final inference request submitted to a model provider**.” (P §2.1)
- “Evidence persistence fails” → “no inference”. Verification, encrypted durable evidence acknowledgement and current dispatch authority precede provider dispatch.
- “Admission policy: execute on immediately available capacity, otherwise reject immediately.” (P §12.4) No pending-input queue, retained rejected input, automatic resubmission, provider fallback, or application transcript.
- “Each ESP Conversation (EspCon) is permanently bound to the harness/provider selected when it is created.” (P §14.1) All generations, model routes and pools agree; use a new identity/history for another provider.
- “Only one Active Agent Run (ActAgeRun) may be authorized for an ESP Conversation (EspCon) at a time, including while an interrupted operation's outcome is unresolved.” (P §3.7)
- Native history and execution belong to the selected harness. Recovery uses supported native operations on the same intact storage. “Recovery from lost, deleted, or corrupt native storage is outside this specification.” (P §12)
- Gateway-only provider access; provider keys only at the gateway. Knowledge MCP is read-only, has its own current-authority check, and never calls the gateway or receives calls from it.
- Enforceably disable arbitrary shell, repository edits, host filesystem, unapproved network tools, runtime subagents and unbound background model work in the initial profile. Required compaction must work through a qualified gateway adapter.
- Architectural terms in prose use the full term and parenthesized abbreviation on each occurrence; literal code/SQL/wire identifiers are exempt (P §3).
- P §12.2 initial operating values remain qualification inputs: idle **15 minutes**, heartbeat **5 seconds**, database-clock lease **30 seconds**, recovery restarts **2 for the current interrupted operation**, automatic recovery window **120 seconds**, work deadline **300 seconds**. Capacity limits come from measurements, not these defaults.
- Expected Brain size is approximately **5k–15k tokens** (P §8.4); evaluation determines production size. Never trim canonical bytes to fit.
- Keep the existing shell and seed sections as no-JavaScript fallback pending a content-owner decision. The enhanced primary interface follows P §1's conversational product. Clear Ledger craft/beauty and new infographics remain halted; do not invent authoritative ESP/Clear Ledger content or silently delete existing seed content.
- No stub Gate 1, no production-stub Brain, no skipped/empty/mock qualification success. A dedicated-process fallback requires a revised decision and separate qualification.
- A validated exact profile is required independently for each provider. At least **two concurrently active Harness Conversation Sessions (HarConSes) on one actual main process per provider**, distinct histories and mixed immutable releases, are the functional minimum.
- The current authorization is plan-only. Task commit checkpoints below are prospective local checkpoints. No public PR, push, release, or deployment authorization is granted by C3, this plan, or a readiness result.

## Review Focus

1. Marker-shaped data, split privileged blocks, Unicode/newline differences and interleaved behavior versions must not impersonate either pinned instruction artifact — Tasks 4, 6, 20.
2. Lost native acceptance acknowledgements, HTTP disconnects and backend restarts must preserve uncertainty and prevent duplicate submission — Tasks 16, 17, 24.
3. Lock contention or a partitioned old process must not become a false capacity/busy claim, stale dispatch or second native writer — Tasks 5, 7, 13, 15, 21–22.
4. Withdrawn/version-changed sources and citations restored from old native tool results must preserve provenance and truthful availability — Tasks 8, 25, 27.
5. Slow/interleaved streams, peer cancellation and recovery-budget resets must not leak content, grow memory without bounds, or restart cancelled work — Tasks 10, 17–18, 21–22, 24.

## C3 sources and normative deltas

The closed committee consisted of the two active ACCEPT votes, Astra and Grok. Opus's historical findings are evidence, not a third required vote. There is no unresolved architecture vote to reopen.

The source bundle for this plan is `/tmp/harness-subagent/open-edge-ai-site-c3-plan-write-astra-20261002-1844/inputs/`:

| Input | Role / SHA-256 |
|---|---|
| `consensus-r3/CONSENSUS.md` | Closed C3; `f2158727204c2a2744afb23435a64775107f672a6a8fb3f09eb2c04a0f6a9981` |
| `reports/r2-grok-report.md` | Consensus base, resolutions 1–21 and signing criteria; `2ccd5db071dd2ff1150bedbf44757b2b57a6a839c5bccdddc8d915161aa97a4f` |
| `reports/r2-astra-report.md` | Normative D1–D5 source; `828ceab86da82b9b1c4f346f379703dfb083adb56e6aaf1d9f8f8d16fd4b2236` |
| `consensus-r3/astra-r3-report.md` / `reports/r3-astra-report.md` | Identical acceptance/normalization records; `aaa5b6b46b7a7c79c014f184cbefdd6bedd7ed34b71077c96c025638c8908bc8` |
| `consensus-r3/grok-r3-report.md` / `reports/r3-grok-report.md` | Identical acceptance records; `6980863d93a55ef4f7aa2d8542031c7904eac9a2bba1708e59661047a2305a07` |
| `astra-d1-d5-excerpt.md`, `c3-position-excerpt.md` | Convenience excerpts, verified against the corresponding full reports; no separate authority. |

The following five replacement blocks are reproduced from Astra r2. They override conflicting base wording in tasks, gates, tables and acceptance criteria alike.

### D1 — Make gate dependencies, DA-01 timing, and candidate admission consistent

> G0 capability discovery starts before dependent product work. G1 may contain G1a (Brain/attribution/egress) and G1b (the complete real admission/submission/peer-safe lifecycle proof); only their combined completion counts as the full prototype proof. Move minimal ownership, admission, native acceptance/status/history, cancellation and unload ahead of the cases that need them. Move the runtime/storage/fencing prerequisites of A Task 24 ahead of G2; UI and release packaging are not prerequisites for proving recovery.
>
> After G1 and G2, complete the §12.14 capacity/cost evidence against budgets agreed before testing and record the per-provider DA-01 decision. A G2 functional pass alone cannot produce `validated`. Formal §23 post-gate product evaluation and G3 follow successful DA-01 qualification. Reuse matching measurements at G4; remeasure affected criteria when profile, limits, workload or release inputs change. Early fixture tests are not post-gate evaluation credit.
>
> Qualification/evaluation uses an isolated deployment with an explicit candidate allowlist, separate credentials/data and no public exposure. Its recorded test-only policy may admit pending runtime profiles and non-production knowledge candidates on the real application path. It must not falsify validated records or introduce a public eligibility-bypass flag. Public creation requires a released Brain and a matching validated deployment.

### D2 — Resolve behavior delivery without changing canonical Brain identity

> Retain the immutable canonical Brain and its separately pinned `behavior_version`/artifact. Select RO X44's separate-block alternative: the approved behavior artifact is delivered as a separate privileged instruction block resolved from the pinned release, with explicit presence/integrity checks in the qualified request adapter. Missing or conflicting behavior must not silently select process-global or latest behavior. This additional behavior check is an engineering contract; P's exact-Brain invariant continues to apply to the unchanged canonical Brain bytes.
>
> G1 must demonstrate correct Brain and behavior delivery for interleaved releases, continuations, retries, compaction and resume. Conceptual retrieval policy already contained in the approved Brain remains there. Retrieved documents and visitor text remain data; they cannot select either instruction artifact.

### D3 — Preserve immediate admission without false semantic claims from lock contention

> Admission atomically claims the current mapping/guard and compatible resident, active and provider capacity, using explicit SQL and a documented consistent concurrency protocol. Use non-waiting acquisition, bounded connection/statement execution, and no input-holding retry loop. Release all partial claims on failure. Avoid unnecessary serialization on one provider-wide try-lock; slot-based claims are an available implementation choice, subject to race and utilization tests.
>
> A contended row is not by itself proof that another Active Agent Run (ActAgeRun) owns the guard or that measured capacity is exhausted. Return `conversation_busy` for a confirmed conflicting/unresolved guard, `capacity_unavailable` for established exhaustion, and `service_unavailable` when current control authority/reservation cannot be established. A duplicate current request returns status without a new submission. Preserve the §12.4 input dispositions and manual retry.
>
> Release/terminal/recovery metadata updates must be idempotently reconciled after transient failure; they cannot silently abandon reservations. Until an authoritative conditional clear succeeds, retain conservative ownership/accounting. This does not promise successful database writes during an outage and does not retain rejected input for execution. Rate-counter update and expiry remain one atomic operation, independent of execution authority.

### D4 — Keep a proved dispatch/revocation boundary in the Python port

> After durable evidence acknowledgement, recheck authoritative current state and order actual transport initiation against every revocation path, including whole-process revocation. If revocation wins before dispatch, no provider request starts. A request whose dispatch wins may remain in flight; cancellation is best-effort and late output cannot update replacement work. Keep the critical section bounded and outside model-response waiting.
>
> The Python transport must provide a demonstrated handoff/completion boundary. Exhausting an async body generator or calling an HTTP API is not assumed to prove when bytes leave a buffer. Select and fault-test the mechanism against the actual transport and authoritative database; do not silently drop coordination if a library hook is awkward. An unproved mechanism leaves the gate pending. This does not claim recall of a provider request already admitted before revocation.

### D5 — Normalize extensions and distinguish required properties from optional mechanisms

> Preserve every §7.3 event and property name and adopt the explicit, versioned, additive `structured_data` extension. Record the extension/PRD clarification in the reconciled design; do not present it as existing PRD text or make an otherwise compatible extension a new blocking L0 question. Preserve decimal-string epochs on the JavaScript boundary.
>
> Adopt A's published-source/asset inspection routes with a separately permissioned, read-only backend credential, restricted to approved public artifacts and recorded versions. Document this added browser-support relationship. It must not manufacture active-run credentials, bypass protected MCP authorization, expose native/evidence stores, or fetch arbitrary model-selected URLs.
>
> A verified citation requires recorded source/version/locator provenance and exact quote validation where a quote is shown. Evidence may come from the current Native Turn / Work (NatTurWor) or retained authorized native history of the same ESP Conversation (EspCon); it need not be fetched again in the current turn. Do not add an application transcript to implement this. Unknown provenance remains unverified; withdrawn material is unavailable without substitution. Source/quote verification alone is not a guarantee that every associated claim is supported.
>
> Label library, driver, signature algorithm, infrastructure product, retention mechanism, numeric tuning and embedding/model pins as engineering choices. Require their properties and qualification evidence. No automatic adoption of every peer implementation recipe: a corpus-wide Brain-marker ban, mandatory crypto-shredding, or a particular HTTP trace callback is not a PRD requirement. Marker-shaped user/tool/source data never becomes privileged Brain content. Compose or Kubernetes labels alone prove neither egress denial nor storage fencing.

Additional C3 normalization: when the pinned behavior block is absent, inject only the approved pinned artifact; reject malformed/conflicting blocks or unavailable artifacts. Quoted framing markers in visitor/tool/source data are inert and are not prohibited merely for containing markers. A guard-row lock failure is not itself `409`. Retain current cancellation intent and the interrupted operation's recovery count/window across fresh authority IDs and coordinator restarts. Existing seed content is retained until the content owner decides.

## File Structure

All paths below are proposed future files relative to the repository root. Only this plan is created by this job. The seed currently contains static files and documentation, with no service workspace or approved domain release.

Each Python workspace member has `pyproject.toml` and `src/<import_name>/__init__.py`; the task first introducing that member owns those files and the corresponding root workspace/`uv.lock` update. The root tooling distribution installs the `scripts` and `knowledge` Python packages: Task 1 creates both root package initializers; Task 4 creates `knowledge/release/__init__.py`; Task 26 creates `knowledge/evals/__init__.py`. Declare workspace dependencies explicitly so running a script by path does not rely on ambient `PYTHONPATH`. Dependency direction is contracts → data/bindings/artifacts → services/adapters → application. Production modules never import test support.

| File home / import | Responsibility |
|---|---|
| `pyproject.toml`, `uv.lock`, `.python-version` | One uv workspace, Python floor, pinned dependencies, pytest/ruff/pyright configuration. |
| `packages/contracts/src/esp_contracts/{ids,api,runtime,release,knowledge,qualification}.py` | Strict shared models; no I/O. |
| `packages/event_protocol/src/esp_event_protocol/{chat_event,normalize,history}.py` | Exact public event union, authorized native event/history normalization. |
| `packages/db/src/esp_db/{client,records,authority}.py`; `infra/migrations/` | One psycopg driver, plain SQL, restricted current-authority views. |
| `packages/object_store/src/esp_object_store/{store,s3}.py` | Immutable checksummed object reads/writes. |
| `packages/espcon/src/esp_espcon/{brain_registry,conversation}.py` | Pin/resolve Brain, behavior and corpus; ownership domain services. |
| `packages/execution_bindings/src/esp_execution_bindings/{binding,authorize,dispatch_fence}.py` | Audience-separated tokens and current authority/revocation ordering. |
| `packages/request_admission/src/esp_request_admission/{admit,rate_limits}.py`; `packages/request_admission/lua/token_bucket.lua` | Immediate SQL reservation and atomic rate counters. |
| `packages/runtime_placement/src/esp_runtime_placement/{placement,capacity}.py` | Healthy compatible placement, resident/active/provider slot claims. |
| `packages/provider_router/src/esp_provider_router/router.py` | Fixed provider-to-native adapter routing. |
| `packages/runtime_harconses/src/esp_runtime_harconses/{manager,lifecycle,supervision}.py` | Setup, acceptance, status/history, terminal reconciliation, leases, cancellation, unload/drain. |
| `packages/recovery/src/esp_recovery/{reconcile,group_recovery}.py` | Pure §12.7 decision mapper plus real group orchestration. |
| `packages/esp_knowledge_client/src/esp_knowledge_client/client.py` | Typed read-only artifact inspection client with separate service permission. |
| `packages/observability/src/esp_observability/{traces,redaction,audit}.py` | §18 traces, secret-free logging and independent egress/evidence audit. |
| `apps/api/src/esp_api/{main,server,config,auth}.py` and `routes/{conversations,messages,status,history,events,cancel,sources}.py` | FastAPI HTTP boundary, ownership, CSRF, status, SSE and public-artifact routes. |
| `providers/shared/src/esp_provider_shared/{adapter,rpc,supervisor,transport_context,storage_fence,kubernetes_fence}.py` | Native protocols, authenticated control, per-operation context, positive storage fencing. |
| `providers/openai/src/esp_provider_openai/{codex_adapter,events}.py`; `providers/openai/integration/` | Exact-build Codex integration, captures and any reviewed hook patch. |
| `providers/xai/src/esp_provider_xai/{grok_build_adapter,events}.py`; `providers/xai/integration/` | Exact-build Grok Build integration and capabilities; no assumed ACP persistence parity. |
| `services/esp_inference_gateway/src/esp_inference_gateway/{main,server,brain_injector,brain_verifier,request_adapter,evidence_recorder,transport,response_relay}.py`; `adapters/{openai_responses,xai_responses,compaction}.py` | Qualified final-request enforcement, protected evidence and upstream exchange. |
| `services/esp_mcp/src/esp_mcp/{main,server,authz,tools,retrieve,resolve,assets,inspection}.py` | Six protected read-only MCP tools, versioned retrieval, separately permissioned artifact inspection. |
| `services/esp_embeddings/src/esp_embeddings/{main,embed}.py` | Local pinned embedding inference only, no generative ESP reasoning or hosted model egress. |
| `knowledge/release/{manifest,validate,prepare,publish}.py`; `knowledge/evals/{schema,run,grade}.py` | Offline owner-supplied content preparation, reviewed publication and evaluation. |
| `knowledge/{brain,behavior,corpus,ontology,assets}/README.md` | Source-owner import contracts; no invented production content. |
| `site/index.html`, `site/css/main.css`; `site/js/{app,api,state,sse,render,sources}.js` | Existing shell, conversation state, safe accessible rendering. |
| `scripts/{migrate,qualify,evaluate,dev,history_lifecycle}.py` | Python operator/developer entry points. |
| `infra/local/`, `infra/runtime/`, `infra/k8s/qualification/`, `infra/k8s/base/`, `infra/observability/` | Local dependencies, constrained real runtime, storage/network controls, final packaging and telemetry. |
| `tests/{unit,contract,integration,e2e,qualification,support,fixtures}/` | Ordinary tests separate from credentialed gates; synthetic fixtures cannot grant public eligibility. |
| `docs/qualification/`, `docs/runbooks/` | Sanitized exact-profile manifests, gate evidence references and operating procedures. |

P §22 is a concrete tree. Record these explicit adaptations in future `docs/architecture.md`: `apps/web/` → existing `site/`; hyphenated packages/services → Python underscore directories and `esp_*` imports; `EspCon` → `packages/espcon`; `runtime-HarConSess` → `packages/runtime_harconses`. Added shared contracts, database/object-store/observability modules, embeddings, behavior/assets and qualification directories serve the existing responsibilities. They do not introduce a second web app, an application history store, or a new agent runtime.

## Shared contracts and implementation decisions

### 1. Identity, release and authorization models

Application IDs are UUID strings, native IDs/work references opaque strings, UTC timestamps backed by `TIMESTAMPTZ`. Epochs are PostgreSQL `BIGINT` and Python integers internally; every JavaScript/public JSON int64 is a validated decimal string, including values above `2**53`. `Provider = Literal["openai", "xai"]`.

Task 1 owns the following strict Pydantic models (unknown fields forbidden, no lossy coercion); later tasks add behavior through the named interfaces, not alternate DTOs.

| Model | Required contract |
|---|---|
| `RunBinding` | `conversation_id, provider_session_id, session_generation, native_session_id, active_agent_run_id, harness_instance_id, runtime_incarnation_id, ownership_epoch, provider, model, brain_release_id, brain_hash, behavior_version, behavior_hash, corpus_release_id, deployment_ref, issued_at, expires_at, audience`. Audience is `inference` or `knowledge`. Optional `native_work_ref` is attached after qualified native acceptance. |
| `AdmissionAuthority` | Current reservation identity/pins with nullable native ID and a separate setup scope. It never authorizes inference or MCP. |
| `OperationAuthority` | Two signed scope tokens, `inference_token` and `knowledge_token`, for the same current run/native identity. |
| `SessionReservation / SessionHandle` | Mapping/generation, placement/incarnation, native storage/location and all pins; nullable native ID only on the reservation. A handle has a non-null native ID. |
| `WorkRef` | `native_session_id, native_work_ref`. |
| `SubmissionResult` | `Accepted(kind="accepted", work: WorkRef)`, `NotSubmitted(kind="not_submitted", code: str)`, `Unconfirmed(kind="unconfirmed", native_work_ref: str | None)`. Only proved native acceptance yields `Accepted`. |
| `SubmissionView` | `outcome` = accepted/running/completed/not_started/submission_unconfirmed/cancelled/failed; current run/ref or null, `resubmission_allowed`, runtime state. Unknown old IDs stay unresolved unless native correlation proves their result. |
| `NativeStatus` | idle/running/completed/interrupted/failed/unknown, optional work/request reference, `saved_input_available`. |
| `NativeEvent` | Explicit native ID/work ref, mapping/run/epoch/incarnation plus typed payload. Missing identity is rejected; no last-request heuristic. |
| `NativeHistorySnapshot` | Ordered public `HistoryItem` values, native cursor when supported, `NativeStatus`, and authorized source/tool provenance needed for citation verification. Hidden reasoning, secrets and unrelated payloads are filtered. No persistence in an application transcript. |
| `HistoryItem` | Native item/work IDs, user/assistant role, text, citations/assets/structured data and `provisional` flag. |
| `ReleaseManifest` | `brain_version, canonical_brain_sha256, canonical_brain_bytes, behavior_version, behavior_sha256, behavior_bytes, source_revision, created_at, status, brain_artifact_ref, behavior_artifact_ref, corpus_release_id, evaluation_ref, qualification_refs`. Status: draft/reviewed/production/withdrawn. Withdrawal is external controlled registry metadata; immutable manifests are not rewritten. |
| `RuntimeProfile / CapabilityReport` | Exact provider/model snapshot and context limits, harness/image/configuration/transport/storage/tool-policy digests; each native primitive proven/absent/unproven with protected evidence reference. |
| `QualificationResult` | §12.14 fields plus gate/scenario coverage, positive observation counts, overlapping native identities, environment/allowlist digest, model/gateway/adapter digests, failures and reviewer. Pending/validated/invalidated are deployment decisions; a functional subgate pass is separate. |
| `ProviderResponse / DispatchTicket` | Task 1 declares Python protocols in `esp_contracts.runtime`: provider status/allowed headers/async raw byte stream; ticket with inference ID, observed initiation/write-completion metadata and separate `response: Awaitable[ProviderResponse]`. Task 7 supplies the real implementation. These I/O protocols are not Pydantic JSON payloads. |

`AuthorityRecord` joins current `conversation`, `provider_session`, `harness_instance`, release/deployment and exact qualification metadata plus database time. Gateway and Knowledge Service use independent restricted read-only primary-database roles. They cannot update execution rows. Pins are resolved from these current records, not trusted merely because they occur in a signed token.

Supporting types have explicit owners. Task 3 defines `Db` (bounded psycopg pool) and `Transaction` (parameterized connection/transaction protocol) in `esp_db.client`. Task 7 defines `ApprovedRoute` (allowlisted method/URL/model/credential reference, never caller-selected) and `GatewayDependencies` (authority reader, release resolver, evidence/object/key services, route map, transport and telemetry). Task 9 defines `KnowledgeDependencies` (authority reader, immutable corpus repository, embedding client, inspection identity and telemetry). Task 14 defines `Subject(subject_id)`, `ProviderOption(provider,harness,display_model,eligible,available)` and `ApiDependencies` (DB, counters, release resolver, runtime adapters, candidate policy, signing service and telemetry). Define these dependency containers beside the service factory; no hidden global dependencies.

Task 8 owns `SearchFilters` (optional source IDs/version/as-of), `SearchResults` (hits and hybrid/lexical mode), and `FactRecord` (claim/concept/current-value discriminated union); source/asset records follow §5 below. Task 15 owns `Admitted` and other admission variants, `PlacementRequest` (mapping/pins/current incarnation/required storage and slots), `SlotClaimResult` (acquired slot IDs, exhausted budget or inconclusive reason), `RatePolicy` (policy/window/capacity/refill/expiry), and `RateDecision` (allowed/retry-after). Task 19 owns `EvidenceInventory`, `FlowInventory` and `ProviderUsage` as independently captured inference/connection/request-ID inventories with coverage intervals, plus `AuditResult` (matched/unmatched/missing-source counts and evidence references). Task 23 owns `Reviewer` (authenticated identity, role and review timestamp) and capacity/decision records. Task 26 owns `Grade` (scores, pass/fail, missing evidence, reviewer/rubric reference) and shared `ReadinessResult` (ready boolean, missing/invalid/stale criteria and evidence references); Tasks 28–29 reuse it. Task 28 owns `NativeDeletionResult` (deleted/evidence reference or unsupported/reason).

Use audience-split Ed25519/JWT EdDSA as the selected engineering envelope, with explicit algorithm/key-ID allowlists. Only the backend signing authority or KMS holds the private key. Push minted scopes over mTLS authenticated backend-to-supervisor control; the harness workload holds no signing key. Each native operation attaches the proper audience on every continuation/retry/compaction/tool call. Token expiry is no later than the lease/run deadline; refresh both scopes as policy requires without extending the original work deadline.

### 2. HTTP, events and browser behavior

Same-origin HTTPS; no extra `/api` prefix. Signed 256-bit random-subject `__Host-esp_session` cookie uses `Secure; HttpOnly; SameSite=Lax; Path=/`. Validate Origin and CSRF on writes; owner mismatch returns `404`. Local HTTP uses an explicitly separate development cookie. Production expiry is a release input.

| Route | Contract |
|---|---|
| `POST /visitor-session` | Bootstrap subject cookie and CSRF token. |
| `GET /providers` | Eligible/available options, harness and display model; no internal credentials. |
| `POST /conversations` | `{provider}` → `201 ConversationView`; released Brain plus matching validated deployment publicly; no native allocation yet. |
| `GET /conversations`, `GET /conversations/{id}` | Owner-filtered metadata/list; `ConversationView` includes fixed provider/harness, pinned Brain, actual model or null before setup, runtime/work state. |
| `POST /conversations/{id}/messages` | `{conversation_id, client_request_id, message}`; path/body IDs agree; any provider override rejected before admission. Native acceptance precedes `200 text/event-stream` and `X-ESP-Acceptance: accepted`. |
| `GET /conversations/{id}/status?client_request_id=...` | Reconciled `SubmissionView`, no model work or input replay. |
| `GET /conversations/{id}/history` | Authorized native history; empty only before allocation, unavailable if existing native storage/history cannot be read. |
| `GET /conversations/{id}/events` | Authorized attachment; reconnect checks status/history and never submits input. |
| `POST /conversations/{id}/cancel` | `{active_agent_run_id}`; current cancellation/terminal view, no stale-ID effect. |
| `GET /sources/{id}?version=...`, `GET /assets/{id}?version=...` | Approved public versioned artifacts through a separately permissioned read-only backend credential, distinct from MCP/run authority. |

Clean rejection is `{error:{code,message,retryable},submitted:false}`: `409 conversation_busy` only on confirmed conflicting/unresolved ownership; `503 capacity_unavailable` only on established exhaustion; `503 service_unavailable` if authority, reservation or bound service cannot be established; `429 rate_limited` with manual-retry guidance. Ambiguity is `409 submission_unconfirmed`, `submitted:null`, status link and `resubmission_allowed:false`. Validation/override errors are `400`, unauthenticated `401`, CSRF `403`, oversized body `413`. Redact rejected bodies from validation logs.

Engineering limits to measure: 8,192 UTF-8 bytes per nonblank message; 64 KiB public JSON; at most 10 seconds bounded healthy-capacity setup/acceptance confirmation; 256 KiB per SSE subscriber; structured tables at most 20 columns/100 rows. These are not PRD-mandated timings. A setup timeout after possible submission means uncertainty, not non-acceptance.

Preserve the exact §7.3 union:

```text
text_delta      {text}
citation        {citation: Citation}
tool_started    {tool}
tool_finished   {tool}
asset           {asset: AssetRef}
usage           {usage: Usage}
session_status  {status: starting|restoring|running|recovering|warm_idle}
output_reset    {activeAgentRunId}
error           {code, message, retryable}
done            {nativeWorkRef}
structured_data {data: StructuredData}   # explicit additive protocol-v1 extension
```

`EventEnvelope = {protocol_version:1, conversation_id, provider_session_id, active_agent_run_id, native_work_ref:null|string, connection_id, sequence:int, event:ChatEvent}`. Sequence begins at 1 for each connection; it is not a durable cursor. Python aliases preserve `activeAgentRunId` and `nativeWorkRef` verbatim. Usage input/output/cached counts are each nullable when unknown.

`Citation` carries source ID, version, title, named locator, optional quote and server-derived verification state; `AssetRef` carries asset ID/version/kind/alt/source ID. `StructuredData` is a bounded table with caption, columns, string/number/null cells and a citation. Untrusted model values cannot mark a citation verified. Reconnect rebuilds saved content and references from authorized native history, resetting abandoned provisional output when necessary.

### 3. Immediate SQL admission and dispatch fencing

Implement all P §§17.1–17.5 fields/states. Enforce immutable providers across retained generations, one current mapping per `conversation_id`, own-current-mapping guard linkage, monotonic epochs and fixed execution pins. Deferred constraint checks preserve guard/mapping consistency at transaction commit. Operational extensions are explicitly current-state data: behavior/corpus pins; `recovery_started_at`, `recovery_deadline_at` and durable cancellation intent; `provider_capacity` policy/health; preallocated `capacity_slot(scope, scope_id, slot_number, holder_provider_session_id, reservation_epoch)` rows for resident/active/provider capacity. They store no message, historical turn or future work.

Selected admission protocol: bounded connection acquisition; one explicit SQL transaction; non-waiting guard acquisition and `SKIP LOCKED` slot claims; stable scope/ID order for compatible resident → active → provider slots; recheck current mapping/incarnation/qualification/pins and atomically claim guard, mapping and all needed slots. Create a nullable-native-ID mapping inside this transaction. No remote I/O, wait for future capacity, automatic transaction retry or provider-wide hot-row try-lock. Rollback releases partial claims.

A failed try-lock or empty `SKIP LOCKED` result alone is inconclusive. After rollback, a bounded authoritative status read may establish a current duplicate (return status), a conflicting/unresolved guard (busy) or fully occupied eligible budgets (capacity unavailable). Otherwise return service unavailable. This read does not retry acquisition or hold input for later execution. Unresolved/cancelling work remains conservatively counted. A metadata-only supervisor reconciles failed releases/terminal clears with conditional run/epoch/incarnation updates; it cannot replay input. Rate-counter update plus expiry is one Lua operation, independent of capacity/authority; outage rejects new submissions.

D4 implementation candidate: transaction-scoped shared dispatch fences for **both** incarnation and mapping, with an invariant lock order, followed by a current-authority read and a bounded `FencedTransport.start`. Every mutation that revokes or replaces authority obtains the matching exclusive fence; whole-process revocation obtains the incarnation fence and inventories all mappings. Include cancellation, terminal clearing, reassignment, drain/recovery, profile/release disablement and expiry handling in the proof.

The transport adapter must establish an observed provider-facing write/handoff completion boundary using the pinned httpx/httpcore network backend, with a ticket separating write completion from response waiting. Do not release the fence on request-object construction, async generator exhaustion or an assumed trace callback. Task 7 documents the chosen hook, socket/TLS buffering behavior and fault evidence; if it cannot prove the boundary, the affected gate remains pending. A lost database/fence connection, timeout, process revocation or lease/deadline crossing before initiation must block new initiation. Any possibly initiated request becomes an uncertain in-flight result, never a gateway retry. No database transaction waits for provider response headers or model output. Profile/release withdrawal takes the affected incarnation fences in stable ID order before changing authoritative eligibility metadata, so it cannot create an unfenced revocation path through registry updates.

### 4. Final-request artifacts, evidence and transport

Resolve canonical Brain and behavior by current pinned release IDs. Read bytes without newline/BOM/Unicode repair; validate encoding at publication. Missing privileged blocks can be injected from pinned artifacts; malformed, split, duplicate, truncated, wrong-version or altered privileged blocks are rejected. Behavior is a separate framed privileged block with its own version/hash/length proof; it does not alter or satisfy the Brain's identity. Conceptual retrieval policy already in the canonical Brain stays there.

Parse bounded request bytes strictly: reject duplicate JSON keys, invalid UTF-8/BOM, invalid instruction shapes and non-finite numbers. Search only qualified instruction fields; marker-shaped user/tool/assistant/source data remains ordinary data. Preserve unrelated context, serialize once, re-extract both blocks from that final immutable buffer, compare bytes/length/SHA-256, and record half-open UTF-8 byte offsets within the decoded instruction field at the adapter's content path.

Store encrypted exact request bytes and proof, durably acknowledged before opening the provider connection; then reauthorize/order dispatch as above and forward that same buffer. Evidence includes every §9.6/§18.2 field, behavior proof, exact request length, verifier/profile digests, immutable refs and append-only dispatch/outcome objects. Independent audit decrypts and re-extracts the stored body and compares it with the actual forwarded buffer. Evidence proves submitted context, not native completion.

Only configured models and exact approved method/path routes are reachable. Initial candidates are OpenAI Responses and the observed xAI API shape; OpenAI `gpt-6-astra` is a candidate identifier requiring account/build verification, xAI ID is supplied configuration. Reject unknown endpoints, opaque `previous_response_id`/server conversations, background/store/truncation modes, remote built-in tools and caller-selected URLs unless a named adapter is separately qualified. Compaction adapters are contingent on G0 discovery, but successful real compaction is mandatory for G1. Required unsupported shapes cannot be hidden by disabling the test.

Use `trust_env=False`, rebuilt header allowlists, no redirects, no provider SDK on the forwarding path and no gateway retries. Preserve raw stream/tool/error semantics and origin; split UTF-8/SSE frames are relayed safely with backpressure. A native retry receives a new inference ID and fresh verification/evidence. Lost outcome-store acknowledgement does not replay the request.

### 5. Knowledge, provenance and publication

The six model-visible contracts are exactly `esp.search(query, filters?)`, `esp.get_source(source_id, version?)`, `esp.get_claim(claim_id)`, `esp.get_concept(concept_id)`, `esp.get_asset(asset_id)`, `esp.get_current_value(key)`. Trusted transport supplies identity, never a tool argument. Authenticate every protected operation independently against current knowledge-audience authority; no sampling/prompts/write/arbitrary-fetch tool capability. The runtime-facing service has read-only snapshot access.

`KnowledgeScope` pins corpus ID, public visibility and as-of time. Successful `KnowledgeResult[T]` returns `{ok:true, corpus_release_id, data:T, sources:SourceMetadata[]}`; failure returns `{ok:false, code:not_found|conflict|unavailable|forbidden}`. Source metadata includes ID/version/title/hash, authority, effective date, supersedes, status, source owner, visibility and exact locator ranges. Record types cover original source bytes/text, snippet/locator/rank search hits, claim text/citations, concept definitions/relationships, current values/unit/effective date and manifest-listed asset MIME/hash/object references.

Filter status/access/version **before** ranking. Explicit version wins; default retrieval uses the pinned corpus; explicit current-value lookup uses approved effective-date/authority precedence and returns source/version/as-of. Equal-precedence disagreement is `conflict`, absent facts `not_found`, dependency failure `unavailable`. Conceptual answers can use the Brain with disclosed retrieval outage; exact/cited answers cannot fabricate unavailable evidence.

Selected engineering retrieval is local PostgreSQL full-text plus pgvector, exact vector search for the small corpus, reciprocal-rank fusion `k=60`, top 20 candidate lists and at most 8 returned hits, no learned reranker. Pin a locally licensed/evaluated embedding model/revision/tokenizer/dimension before indexing; proposed candidate is `sentence-transformers/all-MiniLM-L6-v2` with 384 dimensions, subject to model-card/runtime verification. Proposed chunk cap 256 tokens with 32-token overlap and embedding batches of 32 are tuning, not PRD requirements. Preserve original byte locators separately; model/tokenizer changes rebuild the index. No hosted embedding API. Lexical degradation is explicit in results.

D5 adds browser → backend → published-artifact inspection to the architecture. A distinct read-only credential permits only approved public source/asset IDs at recorded versions; it cannot mint active authority, call protected MCP as a fake run, fetch a URL supplied by a model, or expose native/evidence stores. Citation verification matches recorded source/version/locator provenance from current work **or authorized retained native history of the same ESP Conversation (EspCon)** and checks any displayed quote exactly against that locator. Unknown provenance stays unverified. Withdrawal returns unavailable, never a replacement version. “Source verified” does not certify every associated claim or turn an old value into the current value.

Preparation is authoritative-source extraction → canonicalization → immutable candidate → evaluation → owner review → publication. Fixtures use distinct draft IDs/hashes in test namespaces; they never become public production releases. Production publication requires both-provider §16 reports and matching qualification references. Artifact/index writes precede manifest/selection visibility; rollback changes only future selection, existing pins remain unchanged, and withdrawn releases block affected work without silent substitution.

### 6. Native lifecycle, privacy and measured gates

One main harness process per runtime container hosts multiple independently identified native histories. Native IDs are logical boundaries within a common trust/failure boundary, not OS tenant sandboxes. The constrained informational workload uses ESP-owned service credentials, no visitor secrets, and enforceable tool restrictions.

The independent supervisor/control-event consumer outlives HTTP/SSE handlers, consumes terminal events and polls/reconciles current unresolved metadata after coordinator restart. It renews leases every 5 seconds up to the original 300-second deadline and refreshes both scope tokens. Terminal confirmation clears current run fields, guard and active/provider reservations atomically; resident state becomes `warm_idle`. Proven pre-submit failure clears unused reservations. Uncertainty does neither.

Cancellation persists intent, revokes execution/bumps epoch, requests a native operation-specific interrupt, inspects until stopped/completed and only then conditionally clears. Old-epoch events may trigger trusted inspection but cannot publish output or clear replacement work. Timeout starts cancellation/reconciliation, never an unconditional unlock. Idle unload after 900 seconds uses supported native persistence/unload confirmation and leaves active peers alive; browser keepalives do not reset that timer. Draining stops new placement before safe unload/stop.

On process failure: revoke the incarnation, inventory all affected mappings, positively fence the previous storage writer, attach the same intact storage to a compatible replacement, preserve native IDs/provider/model/Brain/behavior pins and reconcile each mapping independently. Completed work is read, conclusive non-acceptance is cleared for manual resubmit, unknown remains guarded, idle is lazily restored, and only qualified saved-state continuation receives fresh authority after normal capacity admission. Preserve the interrupted operation's two-restart/120-second recovery budget and cancellation intent across restarts; expired automatic recovery leaves actionable unavailable status without clearing uncertainty. No native file surgery or recovery from evidence.

Privacy requires encryption/access controls for metadata, volumes, evidence and backups; payload-free operational logs; explicit region/key ownership, cookie/native/evidence/metadata/log retention and peer-safe supported export/deletion. Per-conversation envelope keys/crypto-shredding are optional mechanisms, not mandatory PRD language. Unsupported required retention behavior blocks release.

| Gate / milestone | Dependencies and required exit |
|---|---|
| **G0 — Tasks 2, 11–12** | Start discovery with contracts, before dependent product work. Inventory exact native create/resume/unload, acceptance/status/history, cancel, model/MCP context hooks, compaction, auxiliary calls, storage/tool policy. Proven/absent/unproven per primitive; no advancement of a live path with unproven essentials. |
| **G1a + G1b = complete G1 — Task 20** | Tasks 3–19 supply actual authority, ownership, admission, submission/status/history, cancel/unload, evidence, tools, observability and enforced runtime boundary first. G1a proves mixed Brain/behavior attribution, tools/compaction/retry/resume and egress. G1b proves every §23 admission/uncertainty/peer-safety scenario. Neither alone is Gate 1. |
| **G2 — Task 22** | G1 plus Tasks 13/21's runtime/storage/fencing/reconciliation. Real process death and host replacement with surviving storage, active/idle peers, bounded residency/memory reclamation, acceptance faults and isolation. UI, production web packaging and G3 are not prerequisites. |
| **§12.14 capacity/cost + DA-01 — Task 23** | After G1/G2, test proposed limits/workload against budgets approved **before testing**, then record separate exact-profile decisions. G2 functional success alone cannot write `validated`. |
| **M1 — first shippable §23 milestone — Task 26** | Both providers' DA-01 decisions successful; Tasks 24–25 provide browser/citations; owner-supplied small authoritative content. Formal post-gate evaluation covers quality, creation-time choice, fixed binding, retrieval/citations, streaming, latency, tokens and measured concurrency. Deliver a reproducible isolated prototype package for review. Early fixture results are not this evidence. This is a milestone inside v1, not full-v1 or public production readiness. |
| **G3 — Task 27** | Successful DA-01 first; reviewed owner-supplied Brain/behavior/corpus, full seven-category §16 matrix on both providers, tool parity, adversarial/outage cases, Brain size/context headroom. Production knowledge selection follows evaluation/review. |
| **G4 — Tasks 28–29** | Current matching G0–G3/DA-01, measured limits/budgets, privacy/retention, region/keys, reproducible release packaging and operations. Reuse still-matching measurements; changed profile, limits, workload or release inputs trigger affected requalification. Readiness is not publication authorization. |

Qualification and evaluation use isolated deployment identity, explicit candidate allowlist, separate credentials/data and no public ingress. A signed/recorded test-only policy can admit pending runtime profiles and non-production content on the real application path without altering their actual statuses. Public routes require released Brain and matching validated deployment; there is no public bypass flag.

Each gate requires a nonempty complete scenario inventory, positive inference observations when expected, actual shared-process overlap where required, exact digests, protected independent evidence and reviewer. Missing binaries/access, skipped/error/uncollected tests or unproved mechanisms mean **pending and nonzero exit**. Demonstrated safety/essential-capability/agreed-capacity failure means **invalidated and nonzero exit**. For `inspect`/G0, G1 or G2 commands, exit zero means the requested functional gate is complete; the separate overall DA-01 status remains pending until Task 23. For the `da01` command, exit zero requires reviewed validation. Never equate an ordinary pytest zero exit with either result. Only a restricted `qualification_admin` workflow can record reviewed validation; ordinary CI/mock fixtures cannot. No two-session result implies 1,000-user capacity.

## Numbered TDD tasks

All commands below are future instructions from repository root. `uv run --all-packages pytest` uses workspace imports and dev dependencies. Task 1 configures ordinary discovery for unit/contract/integration only; browser tests are explicit, live `tests/qualification` runs only through `scripts/qualify.py`. Each task owns its named test fixtures/captures under `tests/support`; scenario helpers in snippets are test-only fixtures, not unspecified production APIs. Each named test asserts observations, not simply a helper's “passed” flag.

An implementation task first establishes a runnable failing test for missing behavior, implements the specified interface, then passes the same test and relevant static checks. Initial packaging/import failures are resolved only far enough to reach the named behavior assertion. Live gates additionally require the nonempty evidence contract above. No commands in this section are executed during this planning job.

### Task 1: Establish Python contracts and the runnable workspace

**Depends on:** none. **Owner:** platform/backend. **PRD:** §§3, 7.3, 17, 22.

**Files:** Create `pyproject.toml`, `uv.lock`, `.python-version`, `scripts/__init__.py`, `knowledge/__init__.py`, `packages/contracts/src/esp_contracts/ids.py`, `api.py`, `runtime.py`, `release.py`, `knowledge.py`, `qualification.py` in that same package; `packages/event_protocol/src/esp_event_protocol/chat_event.py`; `tests/support/contracts.py`; `tests/unit/test_contracts.py`. Modify `.gitignore`. Add package manifests/initializers by the File Structure rule.

**Interfaces:** Produces all Shared Contracts models, `parse_chat_event(value: object) -> ChatEvent` and `parse_submit(value: object) -> SubmitMessage`. `SubmitMessage` contains exactly the three message-body fields in the HTTP table; API validation maps Pydantic errors to documented HTTP codes.

- [ ] **Step 1: Write the failing tests.** Add just enough uv/dev configuration to run `test_wire_aliases_epochs_and_strict_input` and a parameterized roundtrip over all eleven event variants, using synthetic fixture IDs:
  ```python
  def test_wire_aliases_epochs_and_strict_input(valid_binding, valid_message):
      assert valid_binding.model_dump(mode="json")["ownership_epoch"] == "9007199254740993"
      assert parse_chat_event({"type": "output_reset", "activeAgentRunId": "run"}).model_dump(by_alias=True)["activeAgentRunId"] == "run"
      with pytest.raises(ValidationError):
          parse_submit({**valid_message, "provider": "xai"})
      with pytest.raises(ValidationError):
          parse_submit({**valid_message, "message": "😀" * 2049})
  ```
  Also assert unknown event/state rejection, null unknown usage and 20-column/100-row bounds.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/unit/test_contracts.py -q`; expect missing schemas/failed assertions after the runner works.
- [ ] **Step 3: Implement the contracts.** Use strict Pydantic v2 discriminated unions/aliases, byte-based message validation, canonical int64 serialization and exact §12.11 runtime/instance states. Configure ruff, strict pyright and markers/discovery excluding credentialed qualification. Pin dependencies with one lockfile.
- [ ] **Step 4: Run green.** Repeat the test command; run `uv run ruff check .` and `uv run pyright`. Expect eleven-variant roundtrip, precision preservation and static-check success.
- [ ] **Step 5: Commit later.** Stage task-owned workspace/contracts/tests; `git commit -m "feat: establish Python ESP contracts and test workspace"`.

### Task 2: Start G0 discovery and build a truthful qualification recorder

**Depends on:** Task 1; starts before gateway/search/UI development. **Owner:** native integration. **Gate:** G0 discovery.

**Files:** Create `scripts/qualify.py`, `tests/support/candidate_probe.py`, `tests/unit/test_qualification_results.py`, `tests/qualification/test_capabilities.py`, `docs/qualification/manifest.schema.json`, `docs/qualification/README.md`, `docs/qualification/openai/candidate.json`, `docs/qualification/xai/candidate.json`.

**Interfaces:** `inspect_candidate(provider: Provider, profile: RuntimeProfile) -> CapabilityReport`; `classify_qualification(report: QualificationResult) -> Literal["pending","validated","invalidated"]`. CLI subcommands are `inspect`, `network`, `storage`, `g1`, `g2`, `capacity`, `da01`, `privacy`, `release`. Future tasks supply their scenario runners; unimplemented gates report pending.

- [ ] **Step 1: Write the failing tests.**
  ```python
  def test_missing_or_empty_evidence_cannot_qualify(qualification_cases):
      for case in qualification_cases.missing_binary_skipped_empty_or_unproven:
          assert classify_qualification(case) == "pending"
      assert classify_qualification(qualification_cases.essential_absent) == "invalidated"
      assert classify_qualification(qualification_cases.g2_only) == "pending"
  ```
  Assert nonzero CLI exit for pending/invalidated, exact required-scenario sets and positive observation counts; a synthetic complete recorder fixture never writes a production row.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/unit/test_qualification_results.py -q`. `uv run --all-packages python scripts/qualify.py inspect --provider openai` and the xAI equivalent must report incomplete inventory until real evidence exists.
- [ ] **Step 3: Implement discovery/recording.** Inspect exact installed candidate versions/config schemas without upgrading them. Inventory native create/resume/unload, acceptance/correlation/status/history, cancel, model/MCP context hooks, compaction and title/summary/memory/warmup/model-list/subagent paths. Record model account/context/snapshot and every build/profile digest. Discovery may use isolated probes; it is not the G1 application proof. Tasks 11–12 finish candidate-specific evidence.
- [ ] **Step 4: Run green for recorder tests and rerun discovery.** Unit results pass; live results remain honestly pending where evidence is missing. Essential demonstrated absence invalidates only that candidate and stops its dependent live branch; independent contract work can continue.
- [ ] **Step 5: Commit later.** Stage recorder/tests/sanitized candidate reports; `git commit -m "test: record early native capability evidence without false qualification"`. Never commit credentials, raw private evidence or a fabricated validated record.

### Task 3: Implement current-state SQL schema and restricted authority roles

**Depends on:** Task 1. **Owner:** backend/data. **PRD:** §§11, 17, 20.5.

**Files:** Create `infra/migrations/001_coordination.sql`, `packages/db/src/esp_db/client.py`, `records.py` and `authority.py`; `scripts/migrate.py`; `infra/local/compose.yaml`; `tests/support/database.py`; `tests/integration/test_schema.py`.

**Interfaces:** `open_db(dsn: str) -> Db`; `transaction(db: Db) -> AsyncContextManager[Transaction]`; `read_current_authority(db: Db, provider_session_id: str) -> AuthorityRecord | None`. Record models include every P §17 column plus the explicitly documented current-state extensions.

- [ ] **Step 1: Write real-database failing tests.**
  ```python
  async def test_schema_enforces_current_identity(sql_lab):
      assert await sql_lab.change_provider_sqlstate() == "23514"
      assert await sql_lab.second_current_mapping_sqlstate() == "23505"
      assert await sql_lab.foreign_guard_sqlstate() == "23514"
      assert await sql_lab.gateway_write_sqlstate() == "42501"
      assert not {"message", "turn", "job"} & await sql_lab.application_tables()
  ```
  Add invalid pin mutation, decreasing epoch, mismatched retained generation and incomplete validated-record rejection.
- [ ] **Step 2: Run red.** Start only disposable PostgreSQL/Valkey via `docker compose -f infra/local/compose.yaml up -d postgres valkey`, then `uv run --all-packages pytest tests/integration/test_schema.py -q`; expect missing constraints.
- [ ] **Step 3: Implement plain-SQL migrations and psycopg access.** Add guard/mapping deferred consistency, indexes, capacity slot/current-policy tables and exact-profile eligibility joins. Give gateway/MCP separate SELECT-only authority views, publisher a distinct knowledge role, and `qualification_admin` exclusive reviewed-validation writes. Bounded pools/statements, no ORM retries, no native/evidence contents in SQL.
- [ ] **Step 4: Run green.** `uv run --all-packages python scripts/migrate.py` against the disposable DB; rerun the tests and migration. Expect all invariants, role denial and idempotent migration application.
- [ ] **Step 5: Commit later.** Stage migration/data/local-test files; `git commit -m "feat: persist constrained current authority and capacity metadata"`.

### Task 4: Publish immutable candidate artifacts and resolve separate behavior pins

**Depends on:** Tasks 1, 3. **Owner:** knowledge/gateway. **PRD:** §§8, 9.1, 15, 19.1; **D2**.

**Files:** Create `packages/object_store/src/esp_object_store/store.py` and `s3.py`; `packages/espcon/src/esp_espcon/brain_registry.py`; `knowledge/release/manifest.py`, `validate.py`, `publish.py`; `tests/fixtures/brain/release_a/canonical_brain.md` and `behavior.md`, equivalent `release_b/` files; `tests/integration/test_release_artifacts.py`. Modify `infra/local/compose.yaml` for local object storage.

**Interfaces:** `ObjectStore.put_immutable(key: str, body: bytes, metadata: dict[str,str]) -> ObjectReceipt`; `ObjectStore.get(key: str, version_id: str | None = None) -> bytes`; `resolve_release(release_id: str) -> ResolvedRelease`; `publish_candidate(directory: Path, manifest: ReleaseManifest) -> ReleaseManifest`. `ResolvedRelease` contains manifest, Brain bytes and behavior bytes; `ObjectReceipt` contains immutable version/hash/reference.

- [ ] **Step 1: Write failing byte/pin tests.**
  ```python
  async def test_separate_pinned_artifacts_never_fall_back(release_lab):
      a = await release_lab.resolve("fixture-a")
      assert a.brain_bytes == release_lab.raw_a
      assert a.behavior_bytes == release_lab.behavior_a
      assert not await release_lab.publicly_eligible("fixture-a")
      with pytest.raises(ReleaseError, match="pinned_behavior_unavailable"):
          await release_lab.resolve_with_missing_behavior("fixture-a")
  ```
  Test multibyte/CRLF/trailing-newline bytes, distinct version/hash identities, overwrite refusal, conflicting legacy hash fields, withdrawn cached artifacts and unchanged old pins after new publication.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/integration/test_release_artifacts.py -q`; expect missing resolution/immutability behavior.
- [ ] **Step 3: Implement binary reads, hash/length checks and immutable publication.** Artifacts → manifest → metadata pointer; partial upload cannot enable selection. Translate §8.3 legacy hash naming once, rejecting conflict. Fixtures are synthetic canaries under test/draft namespaces; no domain stub or `status: production`. Task 27 controls production publication.
- [ ] **Step 4: Run green.** Repeat the test; verify both byte arrays and pinned behavior identity survive publication without merging or normalization.
- [ ] **Step 5: Commit later.** Stage artifact/registry/fixture files; `git commit -m "feat: resolve immutable Brain and separately pinned behavior artifacts"`.

### Task 5: Authorize every protected operation and coordinate all revocations

**Depends on:** Tasks 3–4. **Owner:** backend/security. **PRD:** §§9.4, 12.5, 17.4; **D4**.

**Files:** Create `packages/execution_bindings/src/esp_execution_bindings/binding.py`, `authorize.py`, `dispatch_fence.py`; `infra/migrations/002_authority_fences.sql`; `tests/integration/test_authority.py`; `tests/support/authority.py`.

**Interfaces:** `mint_operation_authority(record: AuthorityRecord) -> OperationAuthority`; `verify_binding(token: str, audience: Literal["inference","knowledge"]) -> RunBinding`; `authorize_binding(binding: RunBinding) -> AuthorityRecord`; `with_dispatch_authority(binding: RunBinding, start: Callable[[], Awaitable[DispatchTicket]]) -> DispatchTicket`; `revoke_mapping(mapping_id: str, expected_epoch: int) -> bool`; `revoke_incarnation(instance_id: str, incarnation_id: str) -> list[str]`. Consume Task 1's `DispatchTicket` protocol; this task uses a typed test transport, and Task 7 provides its actual write-boundary implementation.

- [ ] **Step 1: Write failing authority and two-connection tests.**
  ```python
  async def test_scopes_and_revocations_fail_closed(authority_lab):
      assert await authority_lab.setup_token_inference_starts() == 0
      assert await authority_lab.swapped_audience_tool_calls() == 0
      assert await authority_lab.revoked_mapping_dispatch_starts() == 0
      assert await authority_lab.revoked_incarnation_dispatch_starts() == 0
      assert not await authority_lab.old_completion_clears_replacement()
  ```
  Parameterize every pin, guard, native ID, epoch, lease, incarnation and provider mismatch; include primary outage and release/profile disablement.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/integration/test_authority.py -q`; expect unauthorized paths still accepted or missing fences.
- [ ] **Step 3: Implement signatures/current joins and shared/exclusive fence protocol.** Resolve release identity from current metadata; fail closed on unavailable authority. All authority-changing paths use the same documented fence order, including whole-process revocation. Execution tokens require conditional real-native-ID registration. No positive authorization cache and no signing secret in runtime/gateway/MCP.
- [ ] **Step 4: Run green.** Repeat tests against the primary DB. Prove conditional updates and revocation ordering with the test transport, while explicitly leaving the actual Python handoff proof to Task 7/G1.
- [ ] **Step 5: Commit later.** Stage authority/migration/tests; `git commit -m "feat: enforce operation scopes and incarnation-wide revocation ordering"`.

### Task 6: Verify exact final Brain and separate behavior blocks

**Depends on:** Tasks 1, 4. **Owner:** gateway. **PRD:** §§2.1, 9.4–9.5, 9.9; **D2/D5**.

**Files:** Create `services/esp_inference_gateway/src/esp_inference_gateway/request_adapter.py`, `brain_injector.py`, `brain_verifier.py`, `adapters/openai_responses.py`, `adapters/xai_responses.py`; `tests/fixtures/inference/openai.json` and `xai.json`; `tests/unit/test_instruction_verifier.py`.

**Interfaces:** `RequestAdapter.parse_and_locate(raw: bytes) -> ParsedRequest`; `RequestAdapter.inject_absent(parsed: ParsedRequest, release: ResolvedRelease) -> ParsedRequest`; `verify_and_serialize(raw: bytes, release: ResolvedRelease, adapter: RequestAdapter) -> VerifiedRequest`. `VerifiedRequest` contains immutable body, body hash/length, both blocks' content paths/offsets/hash/length and injection actions; it conveys no execution authority.

- [ ] **Step 1: Write failing verifier tests for both shapes.**
  ```python
  def test_privileged_blocks_only_and_separate_behavior(verifier_cases):
      result = verifier_cases.verify_user_pasted_markers()
      assert result.brain_action == "injected"
      assert verifier_cases.extract_brain(result) == verifier_cases.canonical
      assert verifier_cases.extract_behavior(result) == verifier_cases.pinned_behavior
      with pytest.raises(VerificationError, match="behavior_mismatch"):
          verifier_cases.verify_conflicting_behavior()
  ```
  Parameterize missing/exact/modified/duplicate/split/wrong-version blocks, Unicode composition, newline/BOM, JSON escaping/duplicate keys/non-finite numbers, context overflow, malicious tool/source markers and missing artifact.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/unit/test_instruction_verifier.py -q`.
- [ ] **Step 3: Implement the final-buffer algorithm in Shared Contracts §4.** Recognize only qualified privileged fields; absent injection preserves unrelated instructions; a present wrong block is never repaired. Re-extract after one serialization. Deny unsupported routes/opaque state. A marker in ordinary data is not a corpus-wide rejection rule.
- [ ] **Step 4: Run green.** Repeat tests; require independent extraction equal to each exact byte array and zero successful corrupt-block cases.
- [ ] **Step 5: Commit later.** Stage gateway verifier/adapters/tests; `git commit -m "feat: prove exact Brain and behavior in final request bytes"`.

### Task 7: Implement evidence-first proxy and prove the Python transport boundary

**Depends on:** Tasks 3–6. **Owner:** gateway/security. **PRD:** §§9.4–9.14, 18.2; **D4**.

**Files:** Create `services/esp_inference_gateway/src/esp_inference_gateway/main.py`, `server.py`, `evidence_recorder.py`, `transport.py`, `response_relay.py`; `tests/support/wire_server.py`; `tests/integration/test_gateway_pipeline.py`, `test_dispatch_boundary.py`, `test_evidence_audit.py`; `docs/qualification/python-transport-boundary.md`.

**Interfaces:** `build_gateway(deps: GatewayDependencies) -> FastAPI`; `persist_verified_request(binding: RunBinding, request: VerifiedRequest) -> EvidenceReceipt`; `FencedTransport.start(route: ApprovedRoute, body: bytes, receipt: EvidenceReceipt) -> DispatchTicket`. `EvidenceReceipt` identifies immutable request/proof objects and request hash. `DispatchTicket` exposes proved initiation/write completion metadata and a separate `response: Awaitable[ProviderResponse]`; `ProviderResponse` contains status/allowed headers and `AsyncIterator[bytes]`. `relay_response(response: ProviderResponse) -> StreamingResponse` waits outside the DB fence.

- [ ] **Step 1: Write failing ordering/fault tests.**
  ```python
  async def test_evidence_and_real_write_are_ordered(wire_lab):
      trace = await wire_lab.forward_one()
      assert trace.steps == ["authorize", "verify", "evidence_ack", "reauthorize", "dispatch"]
      assert trace.provider_body == trace.decrypted_evidence_body
      assert await wire_lab.starts_after_evidence_failure() == 0
      assert await wire_lab.starts_when_process_revocation_wins() == 0
      assert await wire_lab.stale_mutations_when_dispatch_wins() == 0
  ```
  Pause actual transport before connect, before first write, during buffered/TLS writes and before completion; race mapping/process revocation, deadline/lease expiry and DB session loss. Also test split frames, two origins, 429/5xx, redirects, midstream disconnect and lost outcome ack.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/integration/test_gateway_pipeline.py tests/integration/test_dispatch_boundary.py tests/integration/test_evidence_audit.py -q`; controlled upstream uses real sockets and real PostgreSQL.
- [ ] **Step 3: Implement proxy/evidence and the instrumented transport candidate.** Encrypt/checksum/ack exact bytes and proof before connect. Rebuild headers, strip internal credentials, disable retries/redirects/env proxies. Select the real write/handoff hook in the pinned httpcore network backend and document the observed buffering boundary with captures; hold the shared fence only across recheck and bounded initiation/write completion. Never substitute a final uncoordinated read or assume generator exhaustion proves dispatch. If the mechanism cannot be proved under faults, keep this deliverable/gate pending.
- [ ] **Step 4: Run green and audit.** Repeat the exact suites; independently extract stored versus received bytes and verify origin-specific streaming. Confirm transactions end before delayed response headers. If bytes may have left but outcome acknowledgement is lost, record uncertainty without replay; later G1 repeats proof in the real runtime profile.
- [ ] **Step 5: Commit later.** Stage proxy/transport/tests and sanitized proof note; `git commit -m "feat: gate provider transport on durable evidence and proved authority handoff"`.

### Task 8: Implement versioned hybrid retrieval and exact fact resolution

**Depends on:** Tasks 3–4. **Owner:** knowledge. **PRD:** §§10, 20.2, 25.7.

**Files:** Create `infra/migrations/003_knowledge.sql`; `services/esp_mcp/src/esp_mcp/retrieve.py`, `resolve.py`, `assets.py`; `services/esp_embeddings/src/esp_embeddings/main.py` and `embed.py`; `services/esp_embeddings/Dockerfile`; `tests/fixtures/corpus/manifest.json` and `sources.json`; `tests/integration/test_retrieval.py`.

**Interfaces:** `embed(texts: list[str]) -> EmbeddingBatch` (revision/dimension/vectors); `search_sources(query: str, scope: KnowledgeScope, filters: SearchFilters | None = None) -> KnowledgeResult[SearchResults]`; `resolve_source(source_id: str, version: str | None, scope: KnowledgeScope) -> KnowledgeResult[SourceRecord]`; `resolve_fact(kind: Literal["claim","concept","current_value"], key: str, scope: KnowledgeScope) -> KnowledgeResult[FactRecord]`; `resolve_asset(asset_id: str, scope: KnowledgeScope, version: str | None = None) -> KnowledgeResult[AssetRecord]`. Record shapes are in Shared Contracts §5.

- [ ] **Step 1: Write failing provenance/precedence tests.**
  ```python
  async def test_versions_conflicts_and_withdrawal(corpus_lab):
      assert (await corpus_lab.explicit_old_source()).data.version == "1"
      assert (await corpus_lab.equal_precedence_current_value()).code == "conflict"
      assert (await corpus_lab.search_private_canary()).data.hits == []
      assert (await corpus_lab.withdrawn_recorded_version()).code == "unavailable"
      assert await corpus_lab.quoted_locator_bytes() == corpus_lab.original_quote
  ```
  Include malicious marker text as data, store outage, pinned snapshot after promotion, current-value as-of, unavailable embeddings and rebuilt-index revision mismatch.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/integration/test_retrieval.py -q`.
- [ ] **Step 3: Implement separate knowledge schema/roles and local retrieval.** Preserve immutable original source/asset objects and metadata before derived chunk/vector indexes. Apply access/precedence before ranking; return explicit conflict/not-found/unavailable. Verify/license/pin the embedding candidate and tokenizer; local image cannot call hosted model APIs. Freeze exact offsets and mark lexical degradation.
- [ ] **Step 4: Run green.** Repeat tests against PostgreSQL/pgvector plus controlled embedding failures; confirm no invented facts, wrong-version substitution or private hits.
- [ ] **Step 5: Commit later.** Stage knowledge/embedding/schema/fixtures; `git commit -m "feat: retrieve authoritative versioned sources and exact facts"`.

### Task 9: Expose only the six independently authorized read-only MCP tools

**Depends on:** Tasks 5, 8. **Owner:** knowledge/security. **PRD:** §§5.3, 10, 20.3–20.4.

**Files:** Create `services/esp_mcp/src/esp_mcp/main.py`, `server.py`, `authz.py`, `tools.py`; `tests/contract/test_mcp_tools.py`; `tests/integration/test_mcp_authority.py`.

**Interfaces:** `build_knowledge_server(deps: KnowledgeDependencies) -> FastAPI` mounts the official SDK Streamable HTTP application; `authorize_tool_call(transport_token: str) -> KnowledgeScope`; internal `call_esp_tool(name: EspToolName, arguments: dict, scope: KnowledgeScope) -> KnowledgeResult`. Public tool schemas expose only §10.1 arguments, never `binding` or owner/run IDs.

- [ ] **Step 1: Write failing schema and scope tests.**
  ```python
  async def test_mcp_scope_is_transport_only(mcp_lab):
      assert set(await mcp_lab.tool_names()) == {"esp.search", "esp.get_source", "esp.get_claim", "esp.get_concept", "esp.get_asset", "esp.get_current_value"}
      assert await mcp_lab.stale_call_status() == 403
      assert await mcp_lab.model_supplied_binding_status() == 400
      assert mcp_lab.gateway_calls == 0
  ```
  Cover wrong audience, revoked incarnation, authority outage, forged MCP-session identity, write/sampling/prompt requests and exact-value retrieval outage.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/contract/test_mcp_tools.py tests/integration/test_mcp_authority.py -q`.
- [ ] **Step 3: Implement authenticated middleware, read-only allowlists and bounded structured results.** Validate transport authority on every protected request, including a previously established MCP connection; no gateway call. Mount only the appropriate immutable snapshot/read-only role. Returned instructions remain source data.
- [ ] **Step 4: Run green.** Repeat tests; verify both future native adapters consume the same schema/result contract.
- [ ] **Step 5: Commit later.** Stage MCP service/tests; `git commit -m "feat: authorize six read-only knowledge tools from current transport scope"`.

### Task 10: Implement the supervised native adapter/control contract

**Depends on:** Tasks 1, 5; integrates Tasks 7/9 when available. **Owner:** native integration. **PRD:** §§9.4, 12.13, 20.5.

**Files:** Create `providers/shared/src/esp_provider_shared/adapter.py`, `rpc.py`, `supervisor.py`, `transport_context.py`, `storage_fence.py`; `tests/support/fake_harness.py`; `tests/contract/test_native_adapter.py`; `tests/unit/test_rpc_routing.py`.

**Interfaces:** `HarnessAdapter` exposes async `create_session(reservation: SessionReservation) -> SessionHandle`, `resume_session(handle: SessionHandle) -> SessionHandle`, `submit(handle: SessionHandle, input: SubmitMessage, authority: OperationAuthority) -> SubmissionResult`, `inspect(handle: SessionHandle, request_id: str | None = None) -> NativeStatus`, `read_history(handle: SessionHandle) -> NativeHistorySnapshot`, `cancel(handle: SessionHandle, work: WorkRef) -> Literal["requested","stopped","unknown"]`, `unload(handle: SessionHandle) -> Literal["unloaded","unsupported"]`, `continue_work(handle: SessionHandle, work: WorkRef, authority: OperationAuthority) -> SubmissionResult` and async-iterable `events(handle: SessionHandle) -> AsyncIterator[NativeEvent]`. `NativeRpcClient.request(method: str, params: object) -> object` is async and pairs unique request IDs with responses; `notifications() -> AsyncIterator[object]` carries native notifications. Operator-only export/delete explicitly return unsupported when absent. `StorageFence.fence_previous_writer(unit_id: str, incarnation_id: str) -> FenceReceipt` returns storage unit, obsolete incarnation, infrastructure mechanism, verified timestamp and protected positive fence-evidence reference.

- [ ] **Step 1: Write failing interleaving/control tests.**
  ```python
  async def test_interleaved_native_operations_remain_isolated(runtime_lab):
      a, b = await runtime_lab.interleave_with_reversed_rpc_responses()
      assert a.text == "private-canary-A"
      assert b.text == "private-canary-B"
      assert await runtime_lab.peer_after_cancel_a() == "running"
      assert await runtime_lab.unattributed_model_or_tool_starts() == 0
      assert (await runtime_lab.lose_submit_ack()).kind == "unconfirmed"
  ```
  Include frame limits, unknown native IDs, supervisor restart, unauthorized control caller and no signing key in workload.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/contract/test_native_adapter.py tests/unit/test_rpc_routing.py -q`.
- [ ] **Step 3: Implement bounded ID-routed RPC and mTLS control.** The control allowlist is create/resume/submit/inspect/history/cancel/unload/continue/token-refresh; operator export/delete has separate permission. Demultiplex from native IDs, never last-selected state. Attach audience scopes from trusted native operation context to each model/MCP call. An external stdio wrapper alone cannot invent internal context; reviewed hook patches are build/profile inputs.
- [ ] **Step 4: Run green.** Repeat tests; unit fake demonstrates the contract only. Explicitly unsupported primitives remain candidates for invalidation, not synthetic success.
- [ ] **Step 5: Commit later.** Stage shared-native/test files; `git commit -m "feat: define supervised native lifecycle and per-operation transport"`.

### Task 11: Complete the exact Codex candidate integration and G0 evidence

**Depends on:** Tasks 2, 7, 9–10. **Owner:** OpenAI integration. **Gate:** G0/OpenAI; supports G1.

**Files:** Create `providers/openai/src/esp_provider_openai/codex_adapter.py` and `events.py`; `providers/openai/integration/README.md` and `protocol-schema.json`; `infra/runtime/codex/config.toml`; `tests/contract/test_codex_adapter.py`; `tests/support/codex_capture.py`. Modify `docs/qualification/openai/candidate.json`, `scripts/qualify.py` and, only if the discovered protocol requires it, create `services/esp_inference_gateway/src/esp_inference_gateway/adapters/compaction.py` plus `tests/contract/test_compaction_adapter.py`.

**Interfaces:** `create_codex_adapter(rpc: NativeRpcClient, profile: RuntimeProfile) -> HarnessAdapter`. Native operation names/configuration are captured from the installed build, mapped to Task 10's interface and frozen in the candidate profile.

- [ ] **Step 1: Write failing captured-protocol tests.**
  ```python
  async def test_codex_identity_acceptance_and_compaction(codex_lab):
      assert (await codex_lab.submit_a()).kind == "accepted"
      assert codex_lab.submitted_native_id == codex_lab.handle_a.native_session_id
      assert await codex_lab.peer_canary_in_history_a() is False
      assert await codex_lab.compaction_requests_without_scope() == 0
  ```
  Acknowledgement without demonstrated durable input correlation yields unconfirmed. Required compaction has a positive captured-inference assertion.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/contract/test_codex_adapter.py -q`, then `uv run --all-packages python scripts/qualify.py inspect --provider openai`.
- [ ] **Step 3: Implement the observed Codex App Server candidate.** Configure the gateway custom provider/base URL and observed Responses profile; no guessed lifecycle method or static global header as attribution. Prove native history, acceptance, per-operation hooks and unload semantics on this build. If compaction has a separate endpoint, implement/reuse the qualified final-request adapter and evidence path before G1; a rejection-only adapter cannot pass.
- [ ] **Step 4: Run green and finish G0 inventory.** Repeat contract tests and actual inspection. Record exact binary/config/hook digests, observed model access and positive primitive evidence. Missing essential capability is pending when unproved, invalidated when demonstrably absent. Do not switch to per-message processes.
- [ ] **Step 5: Commit later.** Stage adapter/capture/profile/config and applicable compaction files; `git commit -m "feat: integrate the exact Codex candidate and record capabilities"`.

### Task 12: Complete the exact Grok Build candidate integration and G0 evidence

**Depends on:** Tasks 2, 7, 9–10. **Owner:** xAI integration. **Gate:** G0/xAI; supports G1.

**Files:** Create `providers/xai/src/esp_provider_xai/grok_build_adapter.py` and `events.py`; `providers/xai/integration/README.md` and `protocol-capabilities.json`; `infra/runtime/grok/config.toml`; `tests/contract/test_grok_adapter.py`; `tests/support/grok_capture.py`. Modify `docs/qualification/xai/candidate.json`, `scripts/qualify.py` and the xAI/compaction request adapters if actual captures require a separately qualified shape.

**Interfaces:** `create_grok_adapter(rpc: NativeRpcClient, profile: RuntimeProfile) -> HarnessAdapter`. The initial candidate is one long-lived ACP process; its persistence, resume, unload and history are independently evidenced, not inferred from headless-mode documentation.

- [ ] **Step 1: Write failing ACP/correlation tests.**
  ```python
  async def test_grok_explicit_session_and_durable_acceptance(grok_lab):
      await grok_lab.submit_a()
      assert grok_lab.prompt_session_id == grok_lab.handle_a.native_session_id
      assert grok_lab.peer_canary not in await grok_lab.read_a_text()
      assert (await grok_lab.terminal_ack_without_durability()).kind == "unconfirmed"
      assert await grok_lab.unbound_auxiliary_requests() == 0
  ```
  Include independent native resume/history, scoped cancellation, actual compaction and server/client tool disablement.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/contract/test_grok_adapter.py -q` and `uv run --all-packages python scripts/qualify.py inspect --provider xai`.
- [ ] **Step 3: Implement observed native/configuration mappings.** Capture ACP handshake, explicit session operations, model ID/API shape and request-scoped hooks. A standalone headless resume is not proof of ACP recovery. Enforce tool restrictions on both sides. If required shapes differ, add their named adapter tests; do not silently translate into guessed compatibility.
- [ ] **Step 4: Run green and finish G0 inventory.** Record independent xAI evidence or honest pending/invalidation. Required but absent primitives stop this candidate's live path; no stub acceptance.
- [ ] **Step 5: Commit later.** Stage xAI integration/profile/captures; `git commit -m "feat: integrate the exact Grok Build candidate and record capabilities"`.

### Task 13: Package isolated qualification, enforce egress and implement real storage fencing

**Depends on:** Tasks 5, 7, 9–12, with usable candidates for each tested provider. **Owner:** platform/storage. **Gates:** G1 prerequisites and G2 prerequisites.

**Files:** Create `infra/runtime/codex/Dockerfile`, `infra/runtime/grok/Dockerfile`, `infra/runtime/tool-policy.json`; `infra/k8s/qualification/namespace.yaml`, `services.yaml`, `runtimes.yaml`, `network-policy.yaml`, `storage.yaml`, `candidate-policy.schema.json`, `kustomization.yaml` in that directory; `providers/shared/src/esp_provider_shared/kubernetes_fence.py`; `tests/integration/test_candidate_policy.py`; `tests/qualification/test_egress.py`, `test_tool_policy.py`, `test_storage_fence.py`. Modify `scripts/qualify.py`.

**Interfaces:** `CandidateAdmissionPolicy` selects deployment identity, allowlisted runtime/content digests and data/credential namespace; `eligible(profile: RuntimeProfile, release: ReleaseManifest, policy: CandidateAdmissionPolicy) -> bool`. `KubernetesStorageFence` implements Task 10's fence interface using the selected infrastructure driver's positive writer-revocation evidence. Deployment commands refuse any context except the explicitly configured disposable qualification environment.

- [ ] **Step 1: Write failing isolation/policy probes.**
  ```python
  def test_candidate_policy_does_not_change_public_eligibility(policy_lab):
      assert policy_lab.isolated_candidate_allowed()
      assert not policy_lab.same_candidate_publicly_allowed()
      assert policy_lab.qualification_status == "pending"
  ```
  Live scenarios assert direct hostname/IP/IPv6/alternate-model/redirect attempts denied, gateway path positively observed, shell/edit/filesystem/unapproved-network tools denied, no provider/signing keys in runtimes, and replacement writer blocked until a real fence receipt.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/integration/test_candidate_policy.py -q`; `uv run --all-packages python scripts/qualify.py network --provider openai` and `storage --provider openai`, then xAI equivalents. Missing environment is pending/nonzero.
- [ ] **Step 3: Implement pinned non-root images, mTLS identities, read-only roots and native-volume-only writes.** Enforce default-deny runtime egress allowing gateway/MCP/internal DNS/telemetry and authenticated control only. Provider credentials stay in the gateway, whose upstream destinations are allowlisted. Isolated candidates have no public ingress or public eligibility flag. Implement stop/access-revoke/fence-ack before replacement attach; force-delete, lease expiry and volume labels are insufficient.
- [ ] **Step 4: Run green for policy tests; collect real network/storage evidence.** Require actual denied connections, not provider `401`. A local Compose environment may satisfy a property only with measured enforced denial/fencing. Record exact infrastructure/storage/CNI/driver identities and persist pending if positive fencing cannot be demonstrated. UI and release web packaging are not dependencies.
- [ ] **Step 5: Commit later.** Stage runtime/infrastructure/tests/sanitized profile records; `git commit -m "feat: isolate candidates and enforce model egress and native writer fencing"`.

### Task 14: Implement owned creation and lazy fixed-provider metadata APIs

**Depends on:** Tasks 3–5; uses Task 13 policy before live qualification. **Owner:** backend. **PRD:** §§6.2, 7.1, 14.

**Files:** Create `apps/api/src/esp_api/main.py`, `server.py`, `config.py`, `auth.py`, `routes/conversations.py`; `packages/espcon/src/esp_espcon/conversation.py`; `.env.example`; `tests/integration/test_conversations_api.py` and `test_browser_identity.py`.

**Interfaces:** `build_api(deps: ApiDependencies) -> FastAPI`; `require_subject(request: Request) -> Subject`; `create_conversation(subject_id: str, provider: Provider) -> ConversationView`; `list_eligible_providers() -> list[ProviderOption]`; `get_conversation(subject_id: str, conversation_id: str) -> ConversationView`.

- [ ] **Step 1: Write failing ownership/pinning tests.**
  ```python
  async def test_create_is_owned_lazy_and_publicly_gated(api_lab):
      assert (await api_lab.other_owner_get()).status_code == 404
      assert (await api_lab.public_create_pending()).status_code == 503
      assert (await api_lab.cross_origin_post()).status_code == 403
      created = await api_lab.create_with_eligible_test_dependencies()
      assert created.provider == "openai"
      assert api_lab.native_create_calls == 0
  ```
  Eligibility test doubles never insert fabricated live validation. Include Brain withdrawal, changed profile digest, secure cookie/key rotation and unknown properties.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/integration/test_conversations_api.py tests/integration/test_browser_identity.py -q`.
- [ ] **Step 3: Implement HTTP ownership and eligibility.** Enforce signed cookie/CSRF/same-origin rules; create immutable provider/Brain/behavior/corpus pins. First admission selects the matching eligible deployment/model and pins both on the initial mapping inside its reservation transaction; subsequent native setup consumes those pins unchanged. Validate actual qualification references, not a nonexistent `provider_deployment.status` field. Provide internal `/livez`/`/readyz` without making a provider outage disable status/history.
- [ ] **Step 4: Run green.** Repeat tests and verify production configuration refuses insecure identity defaults or candidate-bypass settings.
- [ ] **Step 5: Commit later.** Stage API/domain/identity tests/config names only; `git commit -m "feat: create owned conversations with immutable provider and release pins"`.

### Task 15: Implement immediate admission with truthful contention semantics

**Depends on:** Tasks 3, 5, 14. **Owner:** backend/data. **PRD:** §§7.5, 12.4, 12.10, 17.4; **D3**.

**Files:** Create `packages/request_admission/src/esp_request_admission/admit.py` and `rate_limits.py`; `packages/request_admission/lua/token_bucket.lua`; `packages/runtime_placement/src/esp_runtime_placement/placement.py` and `capacity.py`; `tests/support/admission.py`; `tests/integration/test_admission_races.py` and `test_rate_counters.py`.

**Interfaces:** `try_admit(subject_id: str, conversation_id: str, client_request_id: str) -> AdmissionResult` deliberately accepts no message. Result variants: admitted(reservation, setup authority), duplicate_active(status only), rejected(http_status, code, retry_after). `release_unsubmitted(authority: AdmissionAuthority) -> bool` requires proven non-submission. `check_rate(subject_id: str, policy: RatePolicy) -> RateDecision` atomically updates expiry/count. `choose_compatible_slots(tx: Transaction, request: PlacementRequest) -> SlotClaimResult` is internal, with acquired/exhausted/inconclusive outcomes.

- [ ] **Step 1: Write failing multi-connection races.**
  ```python
  async def test_contention_is_not_semantic_exhaustion(admission_lab):
      assert (await admission_lab.contended_guard_without_owner()).code == "service_unavailable"
      assert (await admission_lab.confirmed_conflicting_guard()).code == "conversation_busy"
      assert (await admission_lab.all_compatible_slots_committed_full()).code == "capacity_unavailable"
      assert (await admission_lab.locked_slots_with_free_capacity()).code == "service_unavailable"
      assert await admission_lab.native_submissions_after_reject_then_free() == 0
  ```
  Also race first mapping creation, duplicate current IDs, active/resident/provider caps independently, partial rollback, fair use of free slots across instances, outages and atomic counter expiry.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/integration/test_admission_races.py tests/integration/test_rate_counters.py -q` against real PostgreSQL/Valkey, not sequential mocks.
- [ ] **Step 3: Implement the Shared Contracts §3 SQL protocol.** Current duplicate lookup returns status without a new submission or fresh executable binding; recheck it transactionally. Reserve compatible storage/resident capacity for new/unloaded native state plus active/provider slots, mapping and guard atomically. No input-holding retry loop, fixed 50 ms recipe, provider hot lock or waiting ORM acquisition. Classify inconclusive contention as service unavailable. Rate counters contain opaque HMAC scope keys and numeric policy/expiry only.
- [ ] **Step 4: Run green and measure.** Repeat tests with independent backend connections and predeclared test latency budget. Assert no oversubscription/partial reservations/backlog, no execution after capacity frees, and bounded rejection. Metadata cleanup after transient failure remains conservative until conditional clear succeeds.
- [ ] **Step 5: Commit later.** Stage admission/placement/counter/tests; `git commit -m "feat: reserve capacity immediately with truthful contention outcomes"`.

### Task 16: Submit once and reconcile native acceptance, status and history

**Depends on:** Tasks 10–12, 14–15. **Owner:** backend/native integration. **PRD:** §§7.1, 11–13.

**Files:** Create `packages/provider_router/src/esp_provider_router/router.py`; `packages/runtime_harconses/src/esp_runtime_harconses/manager.py`; `apps/api/src/esp_api/routes/messages.py`, `status.py`, `history.py`; `packages/event_protocol/src/esp_event_protocol/history.py`; `tests/integration/test_submission.py` and `test_native_history.py`. Modify `apps/api/src/esp_api/server.py`.

**Interfaces:** `resolve_pool(provider: Provider) -> Literal["codex","grok_build"]`; `ensure_session(admission: Admitted) -> tuple[SessionHandle, OperationAuthority]`; `submit_message(admission: Admitted, input: SubmitMessage) -> SubmissionResult`; `inspect_submission(subject_id: str, conversation_id: str, request_id: str) -> SubmissionView`; `read_authorized_history(subject_id: str, conversation_id: str) -> NativeHistorySnapshot`.

- [ ] **Step 1: Write failing acceptance fault tests.**
  ```python
  async def test_lost_acceptance_is_not_a_clean_rejection(submission_lab):
      assert (await submission_lab.fail_before_send()).kind == "not_submitted"
      assert (await submission_lab.lose_ack_after_native_save()).kind == "unconfirmed"
      assert await submission_lab.guard_held_after_unknown()
      assert await submission_lab.duplicate_active_submit_count() == 1
      assert await submission_lab.completed_after_backend_restart() == submission_lab.native_answer
      assert not (await submission_lab.uncorrelated_old_request()).resubmission_allowed
  ```
  Include owner mismatch, provider override before admission, status/history without model work and history resume with unavailable residency.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/integration/test_submission.py tests/integration/test_native_history.py -q`.
- [ ] **Step 3: Implement bounded setup and explicit acceptance.** Use only already reserved healthy compatible capacity; register native ID conditionally before minting execution scopes. Hold input only in the live request; submit once to its native ID. Construct accepted SSE only after qualified acceptance. Unknown submission retains guard/references; conclusive non-acceptance releases and permits manual resubmit. History uses nonresident inspection or a non-waiting bounded residency reservation; never starts inference or reads private native files.
- [ ] **Step 4: Run green.** Repeat tests, including native completion before metadata clear and another backend serving status/history. Existing inaccessible history is unavailable, not a fabricated empty transcript.
- [ ] **Step 5: Commit later.** Stage routing/setup/HTTP/history/tests; `git commit -m "feat: distinguish native acceptance uncertainty and owned history"`.

### Task 17: Implement HTTP-independent supervision, terminal release, leases and cancellation

**Depends on:** Tasks 5, 10, 15–16. **Owner:** backend/native operations. **PRD:** §§12.2, 12.4–12.8, 21.2.

**Files:** Create `packages/runtime_harconses/src/esp_runtime_harconses/lifecycle.py` and `supervision.py`; `apps/api/src/esp_api/routes/cancel.py`; `tests/integration/test_lifecycle.py` and `test_cancellation.py`. Modify `providers/shared/src/esp_provider_shared/supervisor.py` and API route registration.

**Interfaces:** `finish_run(binding: RunBinding, work: WorkRef) -> bool`; `renew_ownership(binding: RunBinding) -> OperationAuthority`; `cancel_run(subject_id: str, conversation_id: str, run_id: str) -> SubmissionView`; `evict_idle(now_from_db: datetime) -> list[str]`; `drain_instance(instance_id: str) -> Literal["draining","stopped"]`; `consume_control_events() -> None` runs independently of request/stream handlers and reconciles current unresolved records.

- [ ] **Step 1: Write failing lifecycle tests.**
  ```python
  async def test_terminal_release_allows_two_messages(lifecycle_lab):
      assert await lifecycle_lab.two_sequential_messages_native_count() == 2
      assert await lifecycle_lab.resident_at_idle_seconds(899)
      assert not await lifecycle_lab.resident_at_idle_seconds(900)
      assert await lifecycle_lab.peer_runs_after_unload()
      assert await lifecycle_lab.guard_until_cancel_confirmed()
      assert not await lifecycle_lab.old_epoch_event_clears_replacement()
  ```
  Include browser disconnect, no token output, backend restart, failed terminal DB write, two-token renewal and deadline immutability.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/integration/test_lifecycle.py tests/integration/test_cancellation.py -q`.
- [ ] **Step 3: Implement state transitions and independent control consumption.** Conditional terminal clear atomically releases guard/active/provider capacity; resident capacity survives until confirmed unload. Retry metadata reconciliation after DB recovery without retaining input. Cancellation intent survives the epoch change and restart; stale events only trigger inspect. Renew at 5 seconds against database time within 30-second lease/300-second original deadline. Failed scoped interruption requires recorded group recovery, never silent peer kill.
- [ ] **Step 4: Run green.** Repeat tests with controlled test clocks plus real DB writes; prove HTTP lifetime and browser keepalives cannot govern execution/idle expiry.
- [ ] **Step 5: Commit later.** Stage lifecycle/supervision/cancel/tests; `git commit -m "feat: reconcile terminal work leases cancellation and peer-safe residency"`.

### Task 18: Normalize all §7.3 events and provide bounded SSE reconnect

**Depends on:** Tasks 1, 5, 10, 16–17. **Owner:** backend/web contract. **PRD:** §§7.3, 12.8; **D5**.

**Files:** Create `packages/event_protocol/src/esp_event_protocol/normalize.py`; `apps/api/src/esp_api/routes/events.py`; `tests/contract/test_event_normalizer.py`; `tests/integration/test_sse.py`. Modify message route/server registration.

**Interfaces:** `normalize_event(event: NativeEvent, authority: AuthorityRecord) -> list[ChatEvent]`; `attach_events(subject_id: str, conversation_id: str) -> AsyncIterator[EventEnvelope]`; `encode_sse(envelope: EventEnvelope) -> bytes`. Native lifecycle events are consumed regardless of subscriptions; accepted terminal delivery refers to confirmed native work and never mutates replacement authority.

- [ ] **Step 1: Write failing full-union/reconnect tests.**
  ```python
  async def test_stream_aliases_bounds_and_no_resubmit(sse_lab):
      assert sse_lab.normalize_stale_event() == []
      assert sse_lab.done_json()["nativeWorkRef"] == sse_lab.native_work_ref
      assert sse_lab.reset_json()["activeAgentRunId"] == sse_lab.run_id
      assert await sse_lab.maximum_subscriber_bytes() <= 262144
      assert await sse_lab.new_connection_first_sequence() == 1
      assert await sse_lab.native_submits_after_reconnect() == 1
  ```
  Cover all ten base variants plus additive structured data, terminal clearing concurrent with a next run, no subscribers, interleaved origins and unknown usage.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/contract/test_event_normalizer.py tests/integration/test_sse.py -q`.
- [ ] **Step 3: Implement current-authority filtering, aliases and bounded delivery.** Validate before normalization/publishing; isolate native work references so late terminal output cannot replace a newer run. Slow consumers detach and reload status/native history. Send output reset before qualified regeneration replaces provisional text. No Valkey event buffers, durable token log, raw tool secrets or hidden reasoning.
- [ ] **Step 4: Run green.** Repeat tests; disconnect affects delivery only, and reconnect from a different backend instance has no model-submission side effect.
- [ ] **Step 5: Commit later.** Stage event/SSE/tests; `git commit -m "feat: preserve event wire contracts and bounded native-history reconnect"`.

### Task 19: Instrument observable correctness without payload leakage

**Depends on:** Tasks 7, 9, 14–18. **Owner:** platform/observability. **PRD:** §§5.5, 18.

**Files:** Create `packages/observability/src/esp_observability/traces.py`, `redaction.py`, `audit.py`; `infra/observability/collector.yaml`, `dashboards.json`, `alerts.yaml`; `tests/integration/test_observability.py`. Modify API/gateway/knowledge factories and supervisor to call these interfaces.

**Interfaces:** `record_chat_trace(trace: ChatTrace) -> None`; `record_inference_trace(trace: InferenceTrace) -> None`; `record_recovery_trace(trace: RecoveryTrace) -> None`; `redact_log(value: object) -> object`; `reconcile_egress(evidence: EvidenceInventory, flows: FlowInventory, usage: ProviderUsage) -> AuditResult`. Trace models implement every §18.1–§18.3 field.

- [ ] **Step 1: Write failing correlation/privacy tests.**
  ```python
  async def test_correctness_store_and_telemetry_are_distinct(trace_lab):
      assert await trace_lab.dispatch_with_telemetry_down() == "verified_dispatch"
      assert await trace_lab.dispatch_with_evidence_down() == "blocked"
      assert trace_lab.private_message not in await trace_lab.all_logs_including_validation_errors()
      assert trace_lab.cookie_secret not in await trace_lab.all_logs_including_validation_errors()
      assert trace_lab.audit_injected_unmatched_dispatch().unobservable_count == 1
  ```
  Assert consistent IDs/epochs/pins and that corrupt blocked requests are separate from the forwarded-verification denominator.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/integration/test_observability.py -q`.
- [ ] **Step 3: Implement traces, dashboards and independent audit.** Target verified forwarded rate 100% and unobservable dispatched count zero, based on actual egress/deny observations plus separate read-only provider-usage reconciliation credentials not held by the gateway. Never initialize a production bypass source to constant zero. Measure memory/residency/reclamation, throughput, costs, admission/recovery and citation quality; keep high-cardinality IDs in protected traces, not metric labels.
- [ ] **Step 4: Run green.** Repeat tests including dropped telemetry and evidence failures. Missing external audit evidence makes gate coverage pending, not assumed complete.
- [ ] **Step 5: Commit later.** Stage observability/instrumentation/tests; `git commit -m "feat: audit inference coverage and operational traces without payload logs"`.

### Task 20: Prove complete real G1a and G1b independently for both providers

**Depends on:** Tasks 2–19; all minimal live path dependencies now exist. **Owner:** qualification/security. **Gate:** complete G1, not merely G1a.

**Files:** Create `tests/qualification/test_gate1_brain_attribution.py`, `test_gate1_admission_lifecycle.py`, `test_gate1_context.py`; `tests/support/live_application.py`; `tests/unit/test_gate1_coverage.py`. Modify `scripts/qualify.py` and both candidate manifests.

**Interfaces:** `run_gate1(provider: Provider, profile: RuntimeProfile) -> QualificationResult` exercises the real application path in the recorded isolated candidate deployment; report contains separate G1a/G1b coverage and one complete gate decision.

- [ ] **Step 1: Write failing coverage and live assertions.**
  ```python
  async def test_real_gate1_has_positive_mixed_release_overlap(live_application):
      r = await live_application.gate1()
      assert r.actual_main_process_count == 1
      assert r.max_overlapping_native_sessions >= 2
      assert len(r.brain_versions) >= 2 and len(r.brain_hashes) >= 2
      assert len(r.behavior_versions) >= 2
      assert r.captured_inference_count > 0
      assert r.compaction_inference_count > 0
      assert r.wrong_attributions == r.bypass_count == 0
      assert r.g1a_complete and r.g1b_complete
  ```
  The coverage unit test removes one required scenario or uses a stub/same-Brain pair and asserts pending/nonzero.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/unit/test_gate1_coverage.py -q`; `uv run --all-packages python scripts/qualify.py g1 --provider openai` and xAI equivalent. Pending/failed evidence cannot be replaced by pytest skip.
- [ ] **Step 3: Implement every §23 first-gate scenario.** G1a: actual shared main process, distinct private canaries, mixed Brain/behavior releases, interleaved requests/responses/MCP, first/repeated turns, multiple tools, native retries, automatic/manual compaction, resume, long/context-near-limit inputs, deterministic absent injection, corrupt/duplicate privileged block rejection, inert pasted markers, stale scopes, disabled auxiliary work, evidence equality and live egress denial. G1b: same real binaries through owned create/admission/submit/status/history/cancel/unload; conversation/resident/active/provider saturation, no later execution of rejected input, pre-submit release, ambiguous acceptance guard/no replay, two successive messages and peer-safe create/cancel/unload.
- [ ] **Step 4: Run green only with complete live evidence.** Independently audit every forwarded request and each positive path; repeat faulted dispatch/revocation proof in the exact profile. Record both-provider subgate results, actual overlap and reviewer. Overall DA-01 remains pending until G2 and capacity/cost pass; known essential/safety failure invalidates the affected candidate.
- [ ] **Step 5: Commit later.** Stage scenario code and sanitized manifests/evidence references; `git commit -m "test: prove complete shared-process Brain attribution and admission gate"`.

### Task 21: Reconcile group failures with preserved cancellation and recovery budgets

**Depends on:** Tasks 5, 10, 13, 15–17. **Owner:** runtime operations. **PRD:** §§12.5–12.7, 19.6.

**Files:** Create `packages/recovery/src/esp_recovery/reconcile.py` and `group_recovery.py`; `tests/unit/test_reconcile.py`; `tests/integration/test_group_recovery.py`. Modify current-state migration through new `infra/migrations/004_recovery_metadata.sql` if recovery fields were not added by Task 3, and wire the supervisor/manager to recovery.

**Interfaces:** `reconcile_after_interrupt(observed: NativeObservedState) -> ReconciliationAction`; `recover_instance(instance_id: str, failed_incarnation_id: str) -> RecoveryGroupResult`. `NativeObservedState` includes native status/acceptance, saved-input availability, qualified continuation support and persisted cancellation. Actions are lazy_reload/clear_not_started/keep_unresolved/read_completed/continue_saved/unavailable, with native work ref/reason and `resubmit=False`. Group result inventories every mapping with fence receipt, decisions and timings. Persist `cancel_requested_at`, `recovery_started_at`, `recovery_deadline_at` and P's `recovery_count` as current unresolved-operation metadata.

- [ ] **Step 1: Write failing pure-mapper and integration tests.**
  ```python
  async def test_recovery_never_replays_or_resets_budget(recovery_lab):
      assert await recovery_lab.replace_without_positive_fence() == "blocked"
      assert await recovery_lab.resumed_native_ids() == recovery_lab.original_native_ids
      assert await recovery_lab.completed_regenerations() == 0
      assert await recovery_lab.cancelled_continuations() == 0
      assert await recovery_lab.restarts_across_coordinator_restarts() <= 2
      assert await recovery_lab.guard_after_recovery_window_expiry()
  ```
  Cover all eight §12.7 rows, including read-only-profile refusal to replay a hypothetical write-capable tool without separate idempotency qualification.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/unit/test_reconcile.py tests/integration/test_group_recovery.py -q`.
- [ ] **Step 3: Implement revoke/inventory → positive fence → same-volume compatible restart → per-mapping native inspection.** Keep completed/idle/uncertain/cancelled peers distinct. Only qualified continuation uses native saved input, fresh authority and normal capacity/recovery headroom. Preserve the original interrupted-operation counters/deadline across fresh run IDs. At 120 seconds or two restarts, retain actionable unavailable state/guard until authoritative reconciliation. Pure mapping success cannot qualify recovery.
- [ ] **Step 4: Run green.** Repeat tests with partition/control loss and DB-write failures; confirm every mapping is accounted for, original pins persist, cleanup is idempotent and native references remain readable.
- [ ] **Step 5: Commit later.** Stage recovery/metadata/supervisor integration/tests; `git commit -m "feat: reconcile all native mappings behind positive writer fencing"`.

### Task 22: Prove real G2 process/host recovery and adversarial isolation

**Depends on:** Tasks 13, 18–21. **Owner:** qualification/platform. **Gate:** G2 per provider. **No dependency on Tasks 24–29.**

**Files:** Create `tests/qualification/test_gate2_shared_process.py`, `test_acceptance_faults.py`, `test_native_isolation.py`, `test_residency.py`; `tests/unit/test_gate2_coverage.py`. Modify `scripts/qualify.py` and both candidate manifests.

**Interfaces:** `run_gate2(provider: Provider, profile: RuntimeProfile) -> QualificationResult`. Reuse Task 20's real-application fixture and Task 13's actual storage fence; no synthetic process mapper supplies gate credit.

- [ ] **Step 1: Write failing gate coverage/live assertions.**
  ```python
  async def test_host_loss_reconciles_every_native_mapping(live_application):
      r = await live_application.kill_process_then_replace_host()
      assert r.active_peers_before_fault >= 2 and r.idle_peers_before_fault >= 1
      assert r.all_affected_mappings_inventoried
      assert r.native_ids_after == r.native_ids_before
      assert r.positive_fence_receipt and r.maximum_volume_writers <= 1
      assert r.completed_regenerations == r.cancelled_restarts == 0
      assert r.stale_mutations == r.cross_visitor_leaks == 0
  ```
  Unit coverage rejects a single-session resume, skipped host fault or missing reclaimed-memory measurement.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/unit/test_gate2_coverage.py -q`; `uv run --all-packages python scripts/qualify.py g2 --provider openai` and xAI equivalent.
- [ ] **Step 3: Implement/inject the full §12.12 fault matrix.** Kill the actual busy process and separately its host with surviving accessible storage; also test control partition, before submit, after native save/lost ack, after native completion/before SQL clear, tools/compaction, browser reconnect, authority/evidence outages, idle unload/reload and compatible drain/rollback. Race backends/capacity, free rejected capacity and observe beyond the old request deadline: no rejected input appears later. Probe history/tool/stream canaries and stale writers after lease expiry.
- [ ] **Step 4: Run green only with real evidence.** Record bounded residency/reclaimed memory, IDs/pins, fair bounded recovery and per-mapping outcomes. G2 functional pass leaves DA-01 pending until Task 23's budgets/cost evidence. An untestable fault stays pending; a demonstrated isolation/safety failure invalidates the candidate.
- [ ] **Step 5: Commit later.** Stage gate code and sanitized results; `git commit -m "test: qualify real shared-process and surviving-storage recovery"`.

### Task 23: Measure §12.14 capacity/cost and record each DA-01 decision

**Depends on:** successful G1/G2 for the tested provider, Task 19 audit and approved measurement inputs. **Owner:** qualification with Premysl/platform budget owner. **Gate:** DA-01 before formal §23/G3 evaluation; **D1**.

**Files:** Create `docs/qualification/acceptance-budgets.schema.json`, `tests/qualification/test_capacity.py`, `tests/integration/test_da01_decision.py`; create `docs/qualification/acceptance-budgets.json` only with actual approved values. Modify `scripts/qualify.py` and candidate manifests.

**Interfaces:** `AcceptanceBudgets` requires owner/review timestamp, workload, saved/resident/active targets, provider RPM/TPM, memory baseline/increment/peak/reclamation, p95 admission/warm/restore/TTFT, rejection/recovery objectives, run/test spend ceiling, cost per completed answer, prices/date and recovery headroom. `measure_capacity(profile: RuntimeProfile, budgets: AcceptanceBudgets) -> CapacityReport`; `decide_da01(g1: QualificationResult, g2: QualificationResult, capacity: CapacityReport, reviewer: Reviewer) -> QualificationDecision`. No budget field is silently defaulted to an approved value.

- [ ] **Step 1: Write failing decision-gate tests.**
  ```python
  def test_functional_recovery_is_insufficient(da01_cases):
      assert da01_cases.g2_without_capacity().status == "pending"
      assert da01_cases.capacity_without_preapproved_budget().status == "pending"
      assert da01_cases.changed_transport_digest().status == "pending"
      assert da01_cases.demonstrated_capacity_failure().status == "invalidated"
      assert not da01_cases.openai_pass().qualifies_xai
  ```
  Synthetic decision tests run in an isolated test database and never publish real validation.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/integration/test_da01_decision.py -q`; `uv run --all-packages python scripts/qualify.py da01 --provider openai` must return pending/nonzero without approved complete evidence.
- [ ] **Step 3: Implement measurement and reviewed decision recording.** Record agreed budgets before load; sweep resident and active limits separately, then containers/hosts. Measure baseline/incremental/active memory, reclaim, warm/restore/admission/TTFT, rejection, provider/token throughput, recovery cost and spend. Include prompt-cache measurement only as an optimization with unchanged exact Brain delivery. Use the declared workload and a bounded tuning cycle. Only authorized reviewer/admin records validated limits with complete evidence.
- [ ] **Step 4: Run green.** Run unit/integration decision tests; then `uv run --all-packages python scripts/qualify.py capacity --provider openai` followed by `da01 --provider openai`, and both xAI commands. Successful decisions require matching G0/G1/G2, all §12.14 criteria, approved budgets and independent evidence. Missing evidence stays pending. A failed agreed criterion invalidates; do not advertise 1,000-user support from functional overlap.
- [ ] **Step 5: Commit later.** Stage measurement/schema/decision code plus real sanitized manifests; `git commit -m "test: record capacity-qualified per-provider DA-01 decisions"`.

### Task 24: Build the accessible vanilla conversational client

**Depends on:** Tasks 14–18. May be implemented earlier alongside gate work; its tests are not post-gate evaluation. **Owner:** frontend. **PRD:** §§1, 6, 12.8, 14.

**Files:** Modify `site/index.html` and `site/css/main.css`; create `site/js/app.js`, `api.js`, `state.js`, `sse.js`; `scripts/dev.py`; `tests/e2e/test_conversation_client.py`; `tests/e2e/test_sse_parser.py`.

**Interfaces:** JS `createClient({fetchImpl, baseUrl}) -> EspClient` implements the HTTP table; `reduceClientState(state, action) -> ClientState`; `parseSse(chunks) -> AsyncIterable<EventEnvelope>`. Client state includes fixed identity, draft/request ID, provisional run/history and ready/submitting/running/reconciling/rejected/recovering/unavailable phases. JSDoc defines browser types; no framework or Node service.

- [ ] **Step 1: Write failing browser tests with network observations.**
  ```python
  def test_uncertain_submit_checks_status_before_retry(page, browser_lab):
      browser_lab.lose_acceptance_response()
      browser_lab.send_once(page, "draft canary")
      assert browser_lab.post_count == 1
      page.reload()
      browser_lab.wait_for_status_check()
      assert browser_lab.post_count == 1
      expect(page.get_by_role("button", name="Send", exact=True)).to_be_disabled()
  ```
  Test 409/429/503 draft retention/manual retry, no automatic send on focus/timer/capacity return, new-provider separate history, second tab, disabled sessionStorage, split UTF-8/SSE frames, keyboard/mobile and output reset.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/e2e/test_conversation_client.py tests/e2e/test_sse_parser.py -q` via pytest-playwright.
- [ ] **Step 3: Implement semantic conversation-first enhancement within the retained shell.** Keep seed/no-JS sections pending content-owner action. Add provider choice only for new identity, fixed label, history, composer, cancel/status controls, focus/labels/reduced-motion support. Retain a per-tab draft/request ID in sessionStorage with memory fallback, clear only after accepted reconciliation or explicit discard, and never store provider secrets/transcripts in localStorage. Use same-origin dev serving from `scripts/dev.py`.
- [ ] **Step 4: Run green.** Repeat browser/parser tests, inspect narrow-screen/focus behavior and verify old connection/run events cannot concatenate abandoned provisional content. Mocks are visibly development-only and cannot claim G1.
- [ ] **Step 5: Commit later.** Stage only client/dev/browser-test files; `git commit -m "feat: add accessible conversations with fixed identity and manual retry"`.

### Task 25: Implement safe source inspection and native-provenance citation rendering

**Depends on:** Tasks 8–9, 16, 18, 24. **Owner:** knowledge/frontend/security. **PRD:** §§6.3, 10.3, 20.2–20.4, 25.8; **D5**.

**Files:** Create `services/esp_mcp/src/esp_mcp/inspection.py`; `packages/esp_knowledge_client/src/esp_knowledge_client/client.py`; `apps/api/src/esp_api/routes/sources.py`; `site/js/render.js` and `sources.js`; `tests/integration/test_source_access.py` and `test_citation_provenance.py`; `tests/e2e/test_source_rendering.py`. Modify native history normalization, API routes and client integration.

**Interfaces:** `get_published_source(source_id: str, version: str) -> KnowledgeResult[SourceRecord]`; `get_published_asset(asset_id: str, version: str) -> KnowledgeResult[AssetRecord]`; `verify_citation(citation: Citation, provenance: AuthorizedNativeProvenance, source: SourceRecord | None) -> CitationVerification`. Provenance is derived from owner-authorized native history/current tool observations for that same identity, never model-supplied claims or an application transcript. States: verified/unverified/unavailable. Browser `renderHistoryItem(item, container)` and `openSourcePanel(citation)` use DOM text nodes.

- [ ] **Step 1: Write failing provenance/access/render tests.**
  ```python
  async def test_citation_can_use_same_conversation_native_history(citation_lab):
      assert (await citation_lab.old_authorized_tool_provenance()).state == "verified"
      assert (await citation_lab.other_conversation_provenance()).state == "unverified"
      assert (await citation_lab.inexact_displayed_quote()).state == "unverified"
      assert (await citation_lab.withdraw_recorded_version()).state == "unavailable"
      assert citation_lab.manufactured_run_tokens == 0
  ```
  Include XSS/script URLs, arbitrary asset URLs, backend credential unable to access protected MCP/native/evidence stores, no-current-turn-refetch requirement, preserved old version and unknown provenance.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/integration/test_source_access.py tests/integration/test_citation_provenance.py tests/e2e/test_source_rendering.py -q`.
- [ ] **Step 3: Implement separately permissioned public-artifact routes and safe rendering.** Serve manifest-listed public IDs at exact versions only. Verify locators/quoted bytes against native provenance; display source verification, not blanket claim certification. Withdrawn evidence is explanatory unavailable text, not substituted content or a broken-looking link. Source panel exposes version/authority/effective date/locator, traps/restores focus and supports Escape. Enforce CSP/no-sniff, trusted MIME/alt text, bounded structured tables; no model HTML/SVG/Mermaid execution or arbitrary URL fetch. Render approved existing assets only.
- [ ] **Step 4: Run green.** Repeat all named tests; reload history on another backend and ensure verification uses retained authorized provenance without creating a transcript store.
- [ ] **Step 5: Commit later.** Stage inspection/provenance/renderer/tests; `git commit -m "feat: verify source provenance and expose safe versioned inspection"`.

### Task 26: Evaluate §23 after DA-01 and deliver the first shippable milestone

**Depends on:** successful Task 23 decisions for both providers, Tasks 24–25 and owner-supplied reviewed prototype Brain/behavior/small authoritative corpus. **Owner:** product/knowledge/qualification. **Milestone:** M1, explicitly inside v1.

**Files:** Create `knowledge/evals/schema.py`, `run.py`, `grade.py`; `scripts/evaluate.py`; `tests/unit/test_evaluation_order.py`; `tests/qualification/test_section23.py`; `docs/qualification/section23-milestone.md`; `docs/runbooks/prototype.md`. Extend `knowledge/release/validate.py` to verify candidate import provenance; no invented corpus file is created.

**Interfaces:** `EvaluationCase` records ID/category/question, required concepts/sources, retrieval expectation, prohibited claims and owner rubric; `EvaluationReport` records exact content/runtime/qualification identities, per-case quality/concept/source/retrieval/citation scores, latency/token/usage observations and missing evidence. `run_evaluation(provider: Provider, deployment_ref: str, release_id: str, cases: list[EvaluationCase]) -> EvaluationReport` generates answers through the real isolated application path. `grade_answer(item: HistoryItem, case: EvaluationCase) -> Grade` combines deterministic evidence checks with recorded human quality review. `section23_readiness(reports: list[EvaluationReport], qualifications: list[QualificationResult]) -> ReadinessResult`.

- [ ] **Step 1: Write failing order and real product-evaluation tests.**
  ```python
  def test_post_gate_evaluation_requires_actual_da01(eval_cases):
      assert not eval_cases.functional_g2_only().allowed_to_evaluate
      assert not eval_cases.fixture_smoke_only().section23_ready
      assert not eval_cases.one_provider_pending().section23_ready
      assert not eval_cases.unreviewed_domain_content().section23_ready
  ```
  Live assertions cover creation-time choice, immutable provider, new-provider separate history, retrieval/citations, stream/reconnect, response quality, latency/token measurement and the declared concurrent workload with positive native inference counts.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/unit/test_evaluation_order.py -q`; `uv run --all-packages python scripts/evaluate.py section23 --provider openai --release "$ESP_CANDIDATE_RELEASE"` and xAI equivalent. Missing approved content/DA-01 yields pending/nonzero, never placeholder answers.
- [ ] **Step 3: Implement evaluation and assemble the isolated prototype package.** Read candidate ID from an explicit supplied immutable release setting; no latest/process-global fallback. Refuse formal evaluation on a pending runtime even if the qualification allowlist could admit it for earlier probes. If workload, release size, limits or profile differ from measured DA-01 assumptions, remeasure affected capacity/functional criteria before claiming post-gate credit. Evaluation has no direct model egress or external judge bypass; grade native-saved results against owner cases and evidence. Provide reproducible private-environment startup/config and sanitized manifest references.
- [ ] **Step 4: Run green with real post-gate observations.** Repeat the two provider commands and `uv run --all-packages python scripts/qualify.py release --milestone section23`. M1 is complete only when both G1/G2/DA-01 results match and all §23 product observations exist. Record it as a shippable isolated prototype for review, without claiming G3/G4 or public production readiness.
- [ ] **Step 5: Commit later.** Stage evaluator/scenarios/prototype documentation and actual sanitized reports; `git commit -m "feat: evaluate and package the post-DA-01 section23 milestone"`.

### Task 27: Complete reviewed knowledge publication and full G3 evaluation

**Depends on:** Tasks 4, 8–9, 23, 25–26 and owner-supplied full content/evaluation inputs. **Owner:** knowledge/content owner. **Gate:** G3, full v1 scope.

**Files:** Create `knowledge/release/prepare.py`; `knowledge/brain/README.md`, `knowledge/behavior/README.md`, `knowledge/corpus/README.md`, `knowledge/ontology/README.md`, `knowledge/assets/README.md`; `knowledge/evals/cases.schema.json`; `tests/fixtures/evals/cases.json`; `tests/unit/test_evaluation_grading.py`; `tests/integration/test_publication.py`; `tests/qualification/test_full_evaluation.py`. Modify release publisher/validator, evaluation schema/runner/grader and `scripts/evaluate.py`.

**Interfaces:** `prepare_candidate(source_directory: Path, source_revision: str, owner_review_ref: str) -> ReleaseManifest`; `publish_release(candidate_id: str, review_ref: str, evaluations: list[EvaluationReport], qualification_refs: list[str]) -> ReleaseManifest`. Reuse Task 26's evaluator/grader; `promote_release(release_id: str) -> None` and `withdraw_release(release_id: str, reason: str) -> None` mutate controlled selection metadata, never artifact bytes.

- [ ] **Step 1: Write failing full-matrix/publication tests.**
  ```python
  async def test_publication_requires_review_and_both_provider_matrix(publication_lab):
      assert not await publication_lab.publish_without_review()
      assert not await publication_lab.publish_with_one_provider_report()
      assert not publication_lab.grade_invented_unavailable_value().passed
      assert not publication_lab.grade_factual_without_source().passed
      assert await publication_lab.old_pin_after_promotion() == publication_lab.original_pin
  ```
  Require nonempty cases for conceptual, counterfactual, misconception correction, edge cases, version-specific, exact factual and retrieval behavior on both providers; add tool parity, prompt injection, outage, exact quote/current-value, Brain size and near-context-limit cases.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/unit/test_evaluation_grading.py tests/integration/test_publication.py -q`; formal `scripts/evaluate.py g3` exits nonzero until supplied cases and matching qualified profiles exist.
- [ ] **Step 3: Implement controlled source extraction/canonicalization and reviewed publication.** Content owner supplies conceptual Brain, behavior/retrieval rules, source authority order, ontology/terminology, facts, historical/current corpus, existing assets and rubrics. Evaluate candidate artifacts before production publication. Publish all objects/indexes then immutable manifest/selection metadata; test interrupted publication and rollback. Preserve pinned old Brain/behavior/corpus. Retraction makes affected material unavailable. Never treat architecture PRD, seed marketing or synthetic canaries as approved domain content.
- [ ] **Step 4: Run green and G3.** Repeat ordinary suites; run `uv run --all-packages python scripts/evaluate.py g3 --provider openai --release "$ESP_REVIEWED_RELEASE"` and xAI equivalent. Require reviewed results across all seven categories, measured context headroom/size without trimming, actual tool parity and complete qualification references. Changed measured assumptions trigger affected requalification. Only then permit production artifact selection.
- [ ] **Step 5: Commit later.** Stage pipeline/evaluation/import-contract files and approved metadata; `git commit -m "feat: gate production knowledge on full reviewed provider evaluations"`. Raw private evaluation evidence stays protected.

### Task 28: Implement release privacy, retention and production packaging

**Depends on:** Tasks 13, 17, 21–23, 25, 27. **Owner:** platform/security with policy owner. **Gate:** G4 prerequisites; runtime/storage fencing itself was already required before G2.

**Files:** Create `infra/runtime/service.Dockerfile`, `web.Dockerfile`, `web.conf`, `retention-policy.schema.json`; `infra/k8s/base/kustomization.yaml`, `web.yaml`, `ingress.yaml`, `api.yaml`, `gateway.yaml`, `knowledge.yaml`, `embeddings.yaml`, `runtimes.yaml`, `storage.yaml`, `network-policy.yaml`, `service-accounts.yaml`; `scripts/history_lifecycle.py`; `docs/runbooks/storage-and-retention.md` and `deployment-and-rollback.md`; `tests/integration/test_release_readiness.py`; `tests/qualification/test_privacy_lifecycle.py`. Modify service startup configuration/health checks and shared adapter operator lifecycle methods as required.

**Interfaces:** `ProductionConfig` requires explicit region, encryption/key ownership, identities, native/evidence/metadata/telemetry/backup retention, cookie lifetime, qualified profile references and limits. `validate_release_readiness(config: ProductionConfig) -> ReadinessResult`; `export_native_history(handle: SessionHandle) -> NativeHistorySnapshot`; `delete_native_history(handle: SessionHandle) -> NativeDeletionResult`, where deleted requires peer-safe native evidence and unsupported is an explicit failure.

- [ ] **Step 1: Write failing policy/privacy tests.**
  ```python
  async def test_privacy_policy_is_supported_and_peer_safe(privacy_lab):
      assert not privacy_lab.config_without_retention().ready
      assert await privacy_lab.browser_evidence_access() == "denied"
      assert await privacy_lab.knowledge_native_volume_access() == "denied"
      assert await privacy_lab.peer_history_after_target_deletion() == privacy_lab.original_peer_history
      assert not privacy_lab.required_but_unsupported_deletion().ready
  ```
  Include immutable evidence versus approved deletion policy, backups, least-privilege key access, native format compatibility and matching rollback pins.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/integration/test_release_readiness.py -q`; `uv run --all-packages python scripts/qualify.py privacy --provider openai` and xAI equivalent report pending until real policy/mechanism evidence exists.
- [ ] **Step 3: Implement reproducible Python/service/static images and approved data lifecycle.** Same-origin reverse proxy, CSP/TLS, protected identities, encrypted stores/backups and operator-only native export/delete. Reuse already qualified storage fencing. Select policy-compatible deletion/retention mechanism; crypto-shredding is optional, not a default claim of compliance. Do not edit native files or promise unsupported selective deletion. Stage drain/upgrade/rollback with compatible native formats and preserved existing pins.
- [ ] **Step 4: Run green.** Repeat readiness tests, render `kubectl kustomize infra/k8s/base` and run both real privacy suites. Verify exact images/network/storage/keys/regions and peer preservation. Changes to a previously qualified profile require affected gates to rerun, not just manifest editing.
- [ ] **Step 5: Commit later.** Stage packaging/privacy/ops/tests; `git commit -m "feat: package qualified services with supported privacy and retention"`. Do not deploy merely because the package validates.

### Task 29: Close G4 with matching evidence, CI and the v1 operating handoff

**Depends on:** Tasks 1–28. **Owner:** platform/release owner. **Gate:** G4/full v1 readiness.

**Files:** Create `tests/integration/test_release_gate.py`; `tests/qualification/test_release_gate.py`; `.github/workflows/ci.yml`; `docs/runbooks/operations.md`; `docs/qualification/v1-readiness.md`. Modify `README.md`, `CONTRIBUTING.md`, `docs/architecture.md`, `scripts/qualify.py` and reviewed candidate/budget records when evidence changes.

**Interfaces:** `evaluate_release_gate(qualifications: list[QualificationResult], evaluations: list[EvaluationReport], budgets: AcceptanceBudgets, config: ProductionConfig) -> ReadinessResult`. Output includes ready/blocked plus explicit missing/invalid/stale criteria and evidence references; it does not publish or deploy.

- [ ] **Step 1: Write failing release decision tests.**
  ```python
  def test_readiness_needs_matching_complete_evidence(release_cases):
      assert not release_cases.one_pending_provider().ready
      assert not release_cases.changed_workload_without_remeasure().ready
      assert not release_cases.changed_transport_or_storage().ready
      assert not release_cases.missing_policy_approval().ready
      assert not release_cases.nonzero_unobserved_dispatch().ready
      assert release_cases.synthetic_complete_fixture().ready
  ```
  The last assertion tests the evaluator only and is prohibited from writing qualification records.
- [ ] **Step 2: Run red.** `uv run --all-packages pytest tests/integration/test_release_gate.py -q`; `uv run --all-packages python scripts/qualify.py release --milestone v1` must reject incomplete/stale evidence.
- [ ] **Step 3: Implement final evidence matching, CI and operating documentation.** Reuse Task 23 measurements only while profile/limits/workload/content assumptions match; rerun affected capacity/cost/functional/evaluation criteria otherwise. CI installs locked workspace dependencies, runs ruff/pyright, disposable migrations, ordinary tests, browser tests and package builds. Credentialed gates remain protected explicit jobs, excluded from default/untrusted CI. Document actual Python layout and §22 adaptations, model/tool paths, test versus live status, content import, native uncertainty/manual retry, outages, withdrawal, fencing, safe drain/rollback, independent audit and approved budgets. No tests that merely match prose headings.
- [ ] **Step 4: Run green and record readiness honestly.** `uv sync --locked --all-packages --group dev`; `uv run ruff check .`; `uv run pyright`; `uv run --all-packages pytest`; `uv run --all-packages pytest tests/e2e -q`; `uv build --all-packages`; `uv run --all-packages python scripts/qualify.py release --milestone v1`. Expected full-v1 success requires both providers' current G0–G3/DA-01 evidence, G4 policies/budgets, approved content and no pending criteria. Otherwise record blocked readiness and the actual limitations.
- [ ] **Step 5: Commit later.** Stage CI/release-gate/docs and actual sanitized evidence references; `git commit -m "docs: record complete ESP v1 qualification and operating readiness"`. Stop with the reviewable result; public PR/push/deployment still require separate authorization.

## Coverage, ownership and acceptance crosswalk

### PRD Chapters 1–26

| P chapter | Owner / implementation files | Tasks | Acceptance gate |
|---|---|---|---|
| 1 — Purpose | Product/frontend, `site/js/app.js` and retained shell | 14, 24, 26 | M1; G3 |
| 2 — Architecture, exact Brain, DA-01 | Gateway/platform, verifier/transport and qualification runner | 5–7, 13, 20, 22–23 | G1/G2/DA-01 |
| 3 — Identities/hosting | Backend/native, shared contracts/schema/adapters | 1, 3, 10–12 | G0/G1/G2 |
| 4 — System context | Platform/native/frontend, services and provider adapters | 9–14, 24 | G1/M1 |
| 5 — Container/storage/return paths/publication/telemetry | Platform, gateway/MCP, native volumes, publisher/traces | 3–4, 7–10, 13, 19, 27–28 | G1/G2/G3/G4 |
| 6 — Web client and rich responses | Frontend, client and source panel | 14, 18, 24–26 | M1/G3 |
| 7 — API/router/event protocol/counters | Backend, API, router, admission, event protocol | 1, 14–19 | G1b/M1 |
| 8 — Canonical Brain/behavior/size | Content/knowledge, registry/release/evaluation | 4, 6, 26–27 | G1/G3 |
| 9 — All gateway enforcement/protocol/evidence requirements | Gateway/native/security, gateway adapters/transport, runtime hooks/network | 2, 4–7, 10–13, 19–20 | G0/G1 |
| 10 — Six tools/retrieval | Knowledge, `esp_mcp` and inspection client | 8–9, 25, 27 | G1/G3 |
| 11 — Metadata versus native history | Backend/native, schema/manager/history | 3, 16–17, 21 | G1b/G2 |
| 12 — Lifecycle/recovery/capacity/DA-01, all §§12.1–12.14 | Backend/native/platform, admission/lifecycle/recovery/storage | 2–3, 5, 10–13, 15–23 | G0/G1/G2/DA-01 |
| 13 — End-to-end direct submission | Backend, messages/manager/native adapter | 14–18, 20 | G1b |
| 14 — Lifetime provider binding | Backend/native, SQL/router/gateway/API/client | 3, 5–7, 14–16, 22, 24 | G1/G2/M1 |
| 15 — Reviewed release lifecycle | Knowledge/content owner, prepare/publish/evaluate | 4, 26–27 | G3 |
| 16 — Seven evaluation categories/two-provider matrix | Knowledge/product, eval schema/runner/grader | 26–27 | G3 |
| 17 — Complete current-state schema | Backend/data, SQL migrations/authority | 1, 3, 5, 15–17, 21, 23 | G1/G2/DA-01 |
| 18 — Chat/inference/recovery trace and metrics | Observability, traces/audit/dashboards | 7, 19, 23, 29 | G1/DA-01/G4 |
| 19 — Reliability and availability boundaries | Gateway/knowledge/native, verifier/lifecycle/recovery/eval | 4–9, 16–23, 27 | G1/G2/G3 |
| 20 — Release/source/tool/isolation/privacy security | Security/content/platform, roles/MCP/network/provenance/privacy | 3–7, 9–13, 22, 25, 27–28 | G1/G2/G3/G4 |
| 21 — Shared topology/placement/drain/qualification | Platform/native, runtime images/placement/fence/qualification | 10–13, 15, 17, 21–23, 28 | G2/DA-01/G4 |
| 22 — Repository structure | Platform, uv/file map and documented adaptations | 1–29 | Ordinary checks/G4 |
| 23 — Initial prototype, complete gates and later product evaluation | Qualification/product, live suites/client/evaluator | 20, 22–26 | Complete G1, G2, DA-01, M1 |
| 24 — Ownership | ESP platform owns orchestration/enforcement/knowledge; native harnesses own loops/history; providers own API-internal inference | 7, 9–13, 19, 27–29 | G0/G1/G4 |
| 25 — Open design items | Named owners/deadlines in the next table | 2–29 | Consuming gate |
| 26 — Architecture summary | Platform, cross-service contracts/operating docs | 7, 9–10, 13, 16, 21, 29 | G1/G2/G4 |

### Preservation of Astra's 26 workstreams on Frank's Python scaffold

| A task/workstream | Reconciled task(s) / change |
|---|---|
| 1 — Contracts | 1, Python/Pydantic and exact aliases |
| 2 — Coordination SQL | 3, explicit psycopg SQL/roles |
| 3 — Immutable artifacts | 4, separately pinned behavior included |
| 4 — Authority/fence | 5 and 7, actual Python D4 proof |
| 5 — Exact verifier | 6, dual artifact checks with unchanged Brain identity |
| 6 — Evidence proxy | 7, encrypted final bytes and response relay |
| 7 — Retrieval/index | 8, local hybrid retrieval and provenance |
| 8 — MCP | 9, transport-only independent authorization |
| 9 — Shared native contract | 10, HTTP-independent trusted control |
| 10 — Codex | 2/11, early G0 then exact integration |
| 11 — Grok Build | 2/12, independent early G0/evidence |
| 12 — Constrained environment | 13, isolated allowlist and measured boundaries |
| 13 — Brain/attribution gate | 20, complete G1a **and G1b**, after live dependencies |
| 14 — Ownership/create | 14, before G1b |
| 15 — Admission/counters | 15, D3 non-waiting truthful semantics |
| 16 — Submission/history | 16, native acceptance/uncertainty before G1b |
| 17 — Lifecycle | 17, terminal release/renewal/cancel before G1b |
| 18 — Group recovery | 21, preserve budgets/cancellation and positive fencing |
| 19 — Normalization/SSE | 18, exact §7.3 plus declared extension |
| 20 — Web client | 24, shell retained and conversation-first enhancement |
| 21 — Citations/rich content | 25, D5 inspection and current-or-native-history provenance |
| 22 — Publishing/evaluation | 26/27, full pipeline and all seven categories retained |
| 23 — Observability | 19, moved before proof gates and independent audit |
| 24 — Storage/privacy/package | 13 **before G2** for storage/runtime; 28 for final privacy/web packaging |
| 25 — Real recovery qualification | 22, independent of UI/G3 |
| 26 — Capacity/release handoff | 23 **before formal evaluation** for DA-01; 26/27 for M1/G3; 29 for G4 |

Frank's module homes, uv foundation and pure §12.7 mapper are retained. Its stub/same-Brain Gate 1 allowance, production placeholder, waiting admission, unscoped tool argument, missing guard release and deferred-v1 exclusions are superseded by the tasks above. Astra's TypeScript backend and late dependency ordering are superseded. Neither reference file is modified.

### Every §25 item and unresolved release input

These are future evidence/content/policy obligations, not a request to reopen C3 or block this plan deliverable.

| P item / input | Decision or required evidence | Accountable owner / task | Deadline |
|---|---|---|---|
| §25.1 DA-01 | Exact real shared-process integration, all §12.14 criteria, no synthetic validation | Native integration + qualification, 2/11–13/20/22–23 | G0 essentials, complete G1/G2, capacity before DA-01 |
| §25.2 Gateway wire | Actual model/MCP hooks, API shapes, streaming/tools and compaction adapters | Gateway/native, 2/6–7/11–12 | Before G1 |
| §25.3 Recovery | Native acceptance/history/unload/resume and exclusive surviving-storage recovery, independently for ACP | Native/platform, 11–13/16–17/21–22 | Before G2 |
| §25.4 Native history/fixed binding | Supported owner-scoped history and same-provider/native-ID recovery; no fallback | Backend/native, 3/14/16/22/24 | G1b/G2/M1 |
| §25.5 Direct admission | Explicit SQL, bounded non-waiting setup, truthful status, uncertainty and cleanup | Backend/data, 15–17/20 | Before complete G1 |
| §25.6 Brain size | Owner-supplied actual Brain, no truncation, evaluated reasoning/context/cost | Content/knowledge, 26–27 with 23 remeasurement if affected | Content before M1 evaluation; full results G3 |
| §25.7 Retrieval | Selected local hybrid/pgvector/RRF; model/revision/license/language/quality and exact locators | Knowledge, 8/27 | Functional G1 tools; semantic G3 |
| §25.8 Citation UX | Inline references plus accessible source panel, approved assets and D5 verification | Frontend/knowledge, 25 | M1/G3 |
| §25.9 Storage/capacity | Actual region/storage driver/fence proof, privacy settings and measured limits | Platform/security + policy owner, 13/22–23/28 | Fence before G2; budgets before DA-01 load; policies before G4 |
| §25.10 Tool parity | Same six schemas and observed behavior under both native runtimes | Native/knowledge, 9/11–12/20/27 | G1 then full G3 |
| §25.11 Rates/prompt caching | Atomic Valkey policy/expiry, reviewed production rate numbers; caching changes no instruction bytes | Backend + budget owner, 15/23/29 | Rate policy before measured tests; economics before DA-01 |
| Authoritative content/copy | Approved Brain, behavior, corpus precedence, evaluation cases and any existing assets; seed copy decision remains owner-held | Premysl/content owner, 4/26–27 | Prototype inputs before M1; full release before G3 |
| Real models/access | Account eligibility, exact model/context/snapshot/build/config and credentials | Platform/native, 2/11–13 | G0/live gates; prices before capacity tests |
| Workload/spend/SLO | Agreed saved/resident/active workload, memory/latency/rejection/cost/recovery ceilings, dated prices | Premysl/platform budget owner, 23 | **Before** §12.14 load testing, not first at G4 |
| Region/retention/visitor expiry | Explicit approved periods/key ownership and supported native export/delete behavior | Premysl/security/platform, 28 | Before G4; necessary infrastructure selection before G2 |
| Stronger tenancy or fallback topology | Visitor secrets/OS tenant isolation or dedicated-process fallback require revised decision and qualification | Architecture owner | Before changing scope/topology; never silently inferred |

P §25's future Pending Request Queue remains outside v1. No other v1 obligation is parked in an unspecified follow-on plan.

## Plan self-review and handoff

The writing-plans review checks for this deliverable are:

- All Chapters 1–26, Astra workstreams and eleven §25 items have owners, tasks and gates.
- D1–D5 are reproduced from the normative source and applied consistently to actual interfaces, tests and gate ordering.
- Tasks use Python services/tooling and vanilla browser JavaScript, exact paths, producer/consumer interfaces and red → implementation → green → future commit checkpoints.
- Each Review Focus failure has concrete assertions in its owning tasks.
- Required properties are distinguished from selected mechanisms: libraries, drivers, algorithms, numeric tuning, models, Kubernetes and retention choices need evidence; labels and policy files alone are insufficient.
- M1 is the evaluated §23 prototype inside the full plan. Missing future content/native/budget/policy inputs block their consuming gates, not this planning deliverable.
- All task checkboxes are intentionally unchecked. This document claims no implementation, test execution, native qualification, production readiness or content approval.

**Handoff:** one reconciled plan for review. The original Frank and Astra plans remain intact. Future implementation may proceed only under its own execution authorization on `dev/v1-ai-site`; this planning job ends after saving and verifying this plan and the worker report.
