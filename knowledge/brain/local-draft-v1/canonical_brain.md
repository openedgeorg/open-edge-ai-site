FIRST LOCAL DRAFT. NOT A COMPANY-APPROVED CANONICAL BRAIN.

Release id: local-draft-brain-v1
Label: first local draft
Status of this text: draft, for the local compose listener only

This file is a first local draft assembled only from documents already in the open-edge-ai-site repository. No external approved Brain artifact was supplied. No content owner has reviewed it. `knowledge/brain/README.md` states that this directory does not contain an approved domain artifact, and that the architecture PRD, the marketing seed, and synthetic evaluation cases are not a Brain release. This draft does not change that. It is not production, not reviewed, and not an Approved Brain and Corpus Release.

The filename `canonical_brain.md` is the publisher's required artifact name (`knowledge/release/publish.py`). The name does not mean a company-approved canonical brain exists.

# What is ESP?

The repository uses the name ESP in two ways. They are not one approved definition.

Marketing seed and README. `README.md` calls this project a marketing website for ESP (Edge Settlement Protocol) and the Clear Ledger settlement story. `docs/architecture.md` uses the same expansion. The seed page `site/index.html` says:

- The title is "Open Edge AI — ESP / Clear Ledger".
- The hero heading is "Edge Settlement Protocol".
- The tagline is "Transparent settlement at the edge, powered by Clear Ledger".
- The about line is "Building the future of edge computing with transparent, verifiable settlement."
- The ESP section says "ESP enables secure, efficient settlement at the network edge."
- The Clear Ledger section says "Transparent, auditable records for every settlement transaction."
- The footer names "Open Edge AI" and the year 2024.

`docs/runbooks/prototype.md` says that marketing seed is not domain content. `knowledge/brain/README.md` says the marketing seed is not a Brain release. `CONTRIBUTING.md` says AI explainer content must be grounded in approved source-of-truth. No approved source-of-truth pack is in this repository. Those seed sentences are what the page currently shows. They are not a specification of settlement mechanics, participants, incentives, parameters, or a protocol version. The repository does not supply those details. Do not invent them.

Architecture specification. `docs/prd/esp-ai-architecture-spec-v0.25.md` is titled "ESP Conversational Website — Architecture Specification". Its own status line says Status: Draft, Version: 0.25, Date: 2026-09-29. Section 1 says: "The ESP website provides an AI-first interface for exploring ESP." A visitor interacts primarily through an ESP Conversation (EspCon) rather than a conventional hierarchy of content pages. The specification says the AI has a permanent conceptual understanding of ESP and can retrieve authoritative ESP source material for detailed, exact, or citation-backed answers. That retrieval corpus is not in this repository. The specification does not expand the acronym ESP, and it does not mention Clear Ledger. It specifies the conversational application. It does not fill in a business or protocol definition of ESP.

A short answer that stays inside those sources: ESP, in this repository's marketing seed, is the Edge Settlement Protocol, presented with Clear Ledger as transparent settlement at the edge. The same repository's draft architecture specification uses ESP as the subject of an AI-first conversational website, without defining the protocol. Neither source is an approved domain artifact. v1 release readiness is blocked (`README.md`, `docs/qualification/v1-readiness.md`).

# What this draft is for

`docs/prd/esp-ai-architecture-spec-v0.25.md` section 8.1 says an ESP Core Brain gives each model the conceptual knowledge required to reason about ESP before any retrieval, and that detailed source material stays in the ESP Knowledge Platform. Section 9.1 says `canonical_brain.md` is the exact text that must be present in every outbound inference request. This draft is the text the local listener publishes for that slot. It is a stand-in so the local site stops injecting the 56-byte synthetic fixture `tests/fixtures/brain/release_a/canonical_brain.md`. That fixture remains a test fixture. It is not ESP knowledge.

Section 8.1 lists topics a Brain should eventually contain: purpose, mental model, architecture, actors and roles, components, relationships, mechanisms, invariants, economics and incentives, design rationale, terminology, caveats, misconceptions, and retrieval policy. This draft covers only the topics the in-repo documents actually discuss. Economics, incentives, settlement mechanisms, and protocol parameters are absent. Say that they are absent. Do not fill them in.

# Mental model

Four concerns, from specification section 1:

1. The website experience.
2. Provider-specific agent execution.
3. Permanent ESP knowledge (this Brain slot).
4. Detailed ESP source retrieval (not supplied here).

The visitor asks questions about ESP, explores concepts, chooses a harness when starting a conversation, and can follow citations when a real source exists. Specification section 4.1 describes that visitor. The seed page's conversation block says the conversation is a development client and is not a Gate 1 claim.

An ESP Conversation (EspCon) is the website-level discussion owned by one authorized visitor or account (section 3.1). The visitor selects the harness and provider when creating it. That choice stays fixed for the conversation's lifetime (section 1):

- Codex with the configured OpenAI model. The specification names GPT-6 Astra as the candidate OpenAI model. The local listener's configured model string is whatever that process was started with. Do not treat the specification's candidate name as proof that a production model is qualified.
- Grok Build with the configured xAI model.

A different provider means a new ESP Conversation (EspCon) with a new id and its own native history. The specification says there is no cross-harness history transfer.

The running tree, as `docs/architecture.md` describes implemented services, is a Python uv workspace. `apps/api` is the browser boundary. `packages/runtime_harconses` supervises native sessions. `packages/recovery` reconciles a failed incarnation only after a positive storage fence. `services/esp_mcp` and `packages/esp_knowledge_client` are the knowledge-tool code. `site/js` is the vanilla client. `docs/architecture.md` also says qualification commands in `scripts/qualify.py` fail closed when evidence is missing. Native history stays on the runtime volume. The knowledge deployment does not mount it. Deletion is unsupported until a peer-safe mechanism is selected (`docs/architecture.md`, `docs/runbooks/operations.md`).

# Actors and components

Names below are the specification's names. They describe the draft design, not a claimed production deployment.

- Website visitor: the person asking about ESP.
- ESP Web Client: chat interface, initial harness and model selection, fixed conversation identity, citations, diagrams, and rich content (section 2).
- ESP Application Backend: conversation management, provider routing, session mapping, streaming, authentication, and observability.
- OpenAI harness runtime: Codex. Model traffic is supposed to go through the ESP Inference Gateway.
- xAI harness runtime: Grok Build. Model traffic is supposed to go through the ESP Inference Gateway.
- ESP Inference Gateway: the mandatory inference proxy. It observes each outbound model request, injects or verifies the exact Core Brain, records evidence, and forwards only a verified request. Codex and Grok Build do not themselves prove the Brain invariant (sections 4.3 and 4.4).
- ESP Core Brain: versioned conceptual text. This file is the local draft of that text.
- ESP Knowledge Service: the specified retrieval interface for whitepapers, technical documents, exact facts, historical material, diagrams, and other assets. Example tool names in section 10.1 are `esp.search`, `esp.get_source`, `esp.get_claim`, `esp.get_concept`, `esp.get_asset`, and `esp.get_current_value`. The gateway does not call this service. The local compose listener strips the Grok `[mcp_servers.esp_knowledge]` block because that service is not part of the listener (`scripts/local_listen.py`). Do not pretend a retrieval call succeeded.
- Application Database: ownership, provider and session mappings, placement, and run authority. Conversation content and native execution history are persisted by the harnesses.
- Knowledge directories in this repo (`knowledge/brain`, `knowledge/behavior`, `knowledge/corpus`, `knowledge/ontology`, `knowledge/assets`): each README says the content owner supplies that artifact and that this tree does not contain the approved bytes.

`docs/runbooks/deployment-and-rollback.md` says `infra/k8s/base` is a packaging skeleton and that images are tagged unqualified. Package validation is not deployment. Do not describe this tree as a live cluster deployment.

# Invariants the specification states

These are requirements in the draft specification, not test results. Section 2.2 says no test results are claimed by that revision.

- Exact Core Brain presence (section 2.1). The complete released brain text must be present word for word, without summarization, truncation, reordering, omission, or substitution, in every final inference request submitted to a model provider. UTF-8 equality with the released bytes is the check, and therefore SHA-256 equality. A saved instructions field or a version label proves configuration only. It does not prove the bytes of a particular request.
- Fail closed. If the gateway did not observe the request, if the brain is missing and cannot be injected safely, if the brain is present but modified or truncated, or if evidence persistence fails, there is no inference.
- The provider trust boundary in section 2.1 is that the exact brain is proven present in the final request submitted to the provider API. The application cannot see later unobservable changes inside the provider.
- One conversation is bound to the harness and provider selected at creation (section 1 and section 3.1).
- Admission, section 12.4: execute on immediately available capacity, otherwise reject immediately. The design does not promise exactly-once execution. A rejected draft is not kept for later execution.
- Existing ESP Conversations keep their pinned Brain and behavior when a newer release is published (`docs/runbooks/operations.md`). A new conversation can select the release the listener is currently publishing. This local draft does not rewrite the synthetic fixture already stored as `local-compose-brain`.
- `knowledge/release/prepare.py` does not invent Brain bytes. A candidate import that lacks an owner review raises `approved_content_absent`. `publish_candidate` refuses `status == "production"`. This draft is published, when the local listener publishes it, with status draft.
- v1 is blocked. `README.md` says there is no approved acceptance budget, reviewed corpus, or complete G0–G4 evidence bundle. `docs/qualification/v1-readiness.md` says status blocked, both provider manifests remain pending, and that document is not a production approval. `docs/qualification/section23-milestone.md` says a shippable isolated prototype still needs matching G1, G2, and DA-01 results for both providers and a reviewed prototype Brain, behavior, and small authoritative corpus. This tree has no approved corpus and no validated DA-01 record. The milestone is not a G3, G4, or public production claim. `docs/qualification/README.md` says DA-01 is an adopted design assumption, not a passed gate. `CONTRIBUTING.md` says do not invent qualification evidence.

# Design assumption DA-01

Section 2.2 assumes long-lived shared harness processes: one Codex process can host multiple independent Harness Conversation Sessions (HarConSes), and one Grok Build process can do the same. The proposed deployment packages each shared harness instance in its own container. The specification calls this an assumed deployment model, not a demonstrated property of either integration. It must be validated or invalidated per harness and build. Multiple native ids do not by themselves establish concurrency, isolation, attribution, recoverability, or acceptable cost. An affected shared-process deployment stays ineligible for production until it passes qualification. No live user-per-process capacity is claimed (section 26, as summarized by the qualification docs). Do not cite a capacity number.

# Terminology

Use the specification's full term with its abbreviation when speaking about the architecture. The document-wide rule in chapter 3 is to write the full term and the abbreviation together on every occurrence. Literal code identifiers stay as they are in code.

- ESP Conversation (EspCon): the website conversation. Identity field `conversation.id`.
- Harness Conversation Session (HarConSes): the native session in the selected harness.
- Harness Instance Pool (HarInsPoo): the pool of shared harness instances for one provider.
- Shared Harness Instance (ShaHarIns): one long-lived harness process, proposed as one container.
- Worker Host (WorHos): the machine that runs those containers. It does not run the remote model weights.
- Active Agent Run (ActAgeRun): the admitted run the backend authorizes.
- Model Inference (ModInf): one outbound model request. Each one must carry the exact brain bytes.
- Native Turn / Work (NatTurWor): harness-owned turn state.

The marketing-seed terms are separate and unapproved as domain content:

- Edge Settlement Protocol: the README and seed expansion of ESP.
- Clear Ledger: the seed's name for transparent, auditable settlement records. No further definition is in the docs.
- Open Edge AI: the site and repository name.

# Retrieval policy

Detailed facts, exact quotations, numbers, current parameters, version-specific text, historical material, and diagrams are specified to live outside the Core Brain (section 10.3). This repository's corpus directory does not contain approved source bytes (`knowledge/corpus/README.md`). There are no whitepaper PDFs in the approved-content sense (`CONTRIBUTING.md` says no whitepaper PDFs or outdated calls to action). Synthetic cases in `tests/fixtures/evals/cases.json` are not an approved corpus (`docs/runbooks/prototype.md`).

When a knowledge tool is not actually available, say that retrieval is unavailable. Do not invent a citation, a source id, a quotation, or a tool result. The local listener does not start the knowledge MCP server.

`docs/prd` section 20, as a constraint on a future public runtime, describes a constrained informational workload: approved read-only knowledge tools, with arbitrary shell, repository edit, host filesystem, and unapproved network tools enforceably disabled. Model instructions alone are not that enforcement. A correct brain hash does not make a mis-attributed answer acceptable. This draft does not claim those controls are qualified here.

# Caveats

- This text is a first local draft. It is not the company-approved canonical brain.
- The specification's example release (brain version 17, behavior version 6, a SHA-256 prefix shown as 58e23, 48291 bytes, status production) is an example inside the draft spec. It is not a release that exists in this tree. Section 8.4's "approximately 5k–15k tokens" is an expected future size, not a measurement of this file.
- The synthetic canary strings in `tests/fixtures/brain/` are test fixtures, including the 56-byte `release_a` brain. They are not ESP knowledge.
- `scripts/dev.py` serves the static site on `127.0.0.1:8765` and does not call a model (`docs/runbooks/prototype.md`). It does not claim Gate 1. The local compose listener is a different process. A page that answers on that listener is still not Gate 1 evidence.
- Local cleartext gateway tests do not prove production TLS, a production provider connection, or a qualified runtime (`docs/qualification/python-transport-boundary.md`). A green pytest run is not a qualification pass.
- Telemetry must not record visitor text (`docs/runbooks/operations.md`).
- No value in `docs/runbooks/storage-and-retention.md` is an approved retention policy.

# Common misconceptions

- "ESP" has one approved corporate definition in this repo. It does not. The seed says Edge Settlement Protocol. The draft specification does not expand the acronym.
- The marketing sentences are approved source-of-truth. `docs/runbooks/prototype.md` says the seed is not domain content.
- This file was supplied by an external content owner as the canonical brain. It was not. It was drafted from the documents named above.
- A conversation on the local site proves Gate 1, DA-01, or production readiness. The qualification documents say those gates are not passed in this tree.
- The example figures in the specification (v17, 48291 bytes, production status) are this release. They are examples. This release id is `local-draft-brain-v1`, and its status when the local listener publishes it is draft.
- Missing economics, token models, customers, regions, latency numbers, or settlement rules can be inferred from the name "settlement". They cannot. They are not in the repository documents.

# Relationships

The visitor talks to the web client. The client talks to the application backend. The backend admits work onto the conversation's already chosen harness. The harness's model traffic goes to the inference gateway. The gateway injects this draft's exact bytes when the privileged block is absent, or rejects the request when a different block is present. The harness may call a knowledge service for material outside this text. In this repository that service has no approved corpus, and the local listener does not attach it. Provider APIs sit on the far side of the gateway. The specification's candidate providers are OpenAI and xAI. Qualification of those providers is pending.

# Design rationale recorded in the spec

The gateway exists because a harness can compact, resume, or rebuild context, and a configured brain version is not proof that a particular request still contains the exact bytes (section 2.1). Checking the outbound body at the only network path to the provider is the specification's enforcement point. This draft exists so that local check has real repository-grounded text to inject, instead of the synthetic canary, without pretending the content owner has approved a brain.
