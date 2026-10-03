# Codex App Server candidate integration (G0, pending)

This directory records the exact Codex build the OpenAI Harness Instance Pool (HarInsPoo) candidate is integrated against, and how its native operations map onto the supervised adapter contract. Nothing here is qualification evidence. The candidate manifest `docs/qualification/openai/candidate.json` stays `pending` until real shared-process evidence exists.

## Captured build

| Item | Value |
|---|---|
| Build (canonical identity) | `codex-cli 0.159.3 sha256:8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479` |
| Native binary | `@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`, sha256 `8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479` |
| Protocol capture | `protocol-schema.json` (sanitized extract of `codex app-server generate-json-schema`, stable and `--experimental`) |
| Runtime configuration | `infra/runtime/codex/config.toml` |

The canonical identity is the version string plus the sha256 of the vendored native binary (`codex_build_id`). The frozen capture's `harness_build`, the candidate manifest's `harness_build`, the `qualify inspect` result and `create_codex_adapter` all use exactly this value; the factory refuses any other label, including the bare version string.

`protocol-schema.json` holds the build's full client request, client notification, server notification and server request name lists; the parameter/result field names of every method ESP uses; the notification and item shapes ESP reads; three verbatim field declarations; and digests of both generated schema bundles. It holds no host paths, credentials or user state.

Capture and recheck:

```bash
uv run --all-packages python scripts/qualify.py inspect --provider openai                            # compare with the frozen capture
uv run --all-packages python scripts/qualify.py inspect --provider openai --write-protocol-capture   # refreeze after review
uv run --all-packages python scripts/qualify.py inspect --provider openai --observation-file obs.json # recorded observation; runs no binary
```

The ordinary test suite uses `--observation-file` so it never executes the installed build. Real discovery runs only through `scripts/qualify.py` and `tests/qualification`. A recorded observation is reported as such and can never refreeze the capture.

Discovery runs the installed binary with `env -i`, a temporary `HOME` and `CODEX_HOME`, and no credentials. It runs `--version`, schema generation, and one `app-server --strict-config` handshake that only calls `initialize`, `config/read`, `experimentalFeature/list`, `modelProvider/capabilities/read` and `thread/loaded/list`. It never starts a thread or a turn and never makes a model request. A changed binary or schema makes `inspect` report that the frozen mapping does not apply; mapped methods the other build lacks are reported for recapture and review, not as absence. Only the exact frozen build (live schema equal to the frozen capture) can show a primitive absent, and compaction is never decided from declarations because automatic compaction needs no manual method.

## Using the adapter

```python
adapter = create_codex_adapter(rpc, profile)   # inside a running event loop; returns CodexHarnessAdapter
await adapter.initialize()                     # required once, before any other call
```

The build accepts no other request before the `initialize` request and the `initialized` notification, so the supervisor must run the handshake before the first create or resume. The factory returns the typed `CodexHarnessAdapter` because three required entry points are Codex-specific: `initialize()`, `compact(handle, authority)` and the relay hook `attribute_model_request(body)`.

## Operation mapping

| Adapter operation | Captured app-server method | Notes |
|---|---|---|
| handshake | `initialize`, then `initialized` notification | Stable API only; reasoning deltas, account and host-status notifications are opted out. |
| `create_session` | `thread/start` | Pinned `model`, `modelProvider = esp_gateway`, `approvalPolicy = never`, `sandbox = read-only`, `ephemeral = false`. A response with another model, provider, policy, sandbox or an ephemeral thread is rejected. |
| `resume_session` | `thread/resume` | Same pins; `excludeTurns = true`. |
| `submit` | `turn/start` with `clientUserMessageId = client_request_id` | Accepted only after `thread/items/list` for the returned turn shows the `userMessage` item whose `clientId` equals the request id. Acknowledgement without that correlation is `unconfirmed`. A turn id that already existed (the build steered input into running work) is `unconfirmed`. `not_submitted` has two causes only: the transport refused before writing (`not_sent`), or the build itself answered with a JSON-RPC refusal code (parse error, invalid request, method not found, invalid params) and persisted history lacks the input (`native_rejected`). A lost, garbled or oversize acknowledgement, a locally raised protocol error, a read failure after the send and an internal or server-defined error code all stay `unconfirmed`. |
| `continue_work` | none | The build declares no saved-state continuation method; the adapter returns `not_submitted` and sends nothing. |
| `inspect` | `thread/read`, `thread/turns/list`, `thread/items/list` | A persisted in-progress turn on a thread that is not active is `unknown`, not running. |
| `read_history` | `thread/turns/list` (`itemsView = full`, paged) | Only user and assistant messages become history items. Reasoning, plans, tool calls and compaction markers are filtered. |
| `cancel` | `turn/interrupt` (`threadId`, `turnId`) | Work from another thread is refused before any call. |
| `unload` | `thread/unsubscribe`, then `thread/loaded/list` | `unloaded` only when the thread is no longer listed as loaded; otherwise `UnloadUnconfirmed`. A confirmed unload drops the thread's transport binding and every per-thread record. |
| `compact` | `thread/compact/start` | The thread is bound to the supplied scope before the call. |
| `export_history` | none | Unsupported; no method is guessed. |
| `delete_history` | `thread/delete` | Operator-only through the supervisor; peer-safe deletion semantics are unproven. A confirmed delete drops the thread's binding and state like an unload. |

## Per-operation attribution

The build's schema declares that every Responses request carries `client_metadata["x-codex-turn-metadata"]`, a JSON string whose reserved keys include `thread_id` and `turn_id`. The model provider entry in the runtime configuration points at a supervisor-local relay on loopback. For each request the relay calls `CodexHarnessAdapter.attribute_model_request(body)`, which:

- parses the body strictly (duplicate keys, non-finite numbers and a byte-order mark are rejected);
- reads `thread_id` and `turn_id` from the turn metadata only, never from prompt text or arrival order;
- refuses a turn the build already reported completed (late output from finished work);
- returns the scope of the operation that owns that turn. A submit owns the turn the build names in its acknowledgement; a submit or manual compaction also owns the turn the build announces with `turn/started` while that operation is waiting for its turn id. A superseded turn keeps its own operation's scope, so a late request from it is never relabelled with the replacement run's token;
- accepts a turn id no operation owns only while a submit or manual compaction on that thread is still waiting for the build to name its turn (the build may sample before its acknowledgement arrives). Otherwise the request is refused as `unbound_turn`, including background work on an idle thread and unannounced turns on a busy one.

The thread binding follows the work: it is pending while an operation waits for its turn id, moves to the owned turn, returns to the newest still-running owned turn when an operation ends without a turn of its own, and is dropped when the owned turn completes, when the build closes the thread, and on confirmed unload or delete.

Every refusal raises `UnattributedCall`, increments the transport's unattributed counter and is never forwarded. The configuration sets no `http_headers`, `env_http_headers`, `env_key`, bearer token or `auth` entry, so no process-wide credential identifies a Harness Conversation Session (HarConSes). The relay process itself is runtime packaging work; this task supplies and tests the hook it calls.

No per-call MCP identity is declared by the captured schema, so the configuration defines no MCP server yet and the MCP context hook remains unproven.

## Events

`events.normalize_codex_notification` turns work notifications (`turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, `error`, `thread/tokenUsage/updated`, `model/rerouted`, `thread/compacted`) into native events only when the notification carries its own `threadId` and turn id and an operation owns that turn, under the same ownership rule as model requests. Missing identity or an unbound thread is rejected and counted. Reasoning and plan notifications never become events. Shell, file-change, web-search, image, subagent and unknown items become `disallowed_item` events, and `model/rerouted` becomes a `model_rerouted` event, so supervision can stop the work and record the violation. Each accepted turn keeps the operation context (including ownership epoch) of the run that submitted it, so late output from an earlier turn is never relabelled as the replacement run's output.

## G0 inventory

All eighteen required primitives are `unproven`. Declared methods show that a primitive is not demonstrably absent; they are not runtime proof. Observations from the isolated handshake:

- The configuration was accepted under `--strict-config`, which rejects unknown keys on this build.
- The build reports `unified_exec` enabled even though the configuration disables it. Arbitrary-shell disablement is therefore not demonstrated. Gate 1 request capture must show that no exec tool is offered to the model, or the profile needs a reviewed change.
- `modelProvider/capabilities/read` lists `webSearch`, `imageGeneration` and `namespaceTools` as provider capabilities. They are capabilities, not enabled tools.
- No separate compaction endpoint was found in the build, so no compaction request adapter was added. Gate 1 must still show real compaction requests passing through the gateway with the correct scope and Brain.
- No model request was made. Model access and the `gpt-6-astra` candidate identifier are unobserved.
- `create_session` and `resume_session` reject a response whose sandbox grants network access; only the read-only policy with `networkAccess` absent or false is the pinned policy.

## Open items for Gate 1

- Capture the actual Responses request body. The gateway's OpenAI Responses adapter rejects any `store` field; if this build sends `store: false`, that shape needs a separately qualified adapter change. The `client_metadata` field also reaches the gateway.
- Decide whether Codex's default base instructions stay in the instructions field next to the injected Brain and behavior blocks.
- Set `model_context_window` and the automatic compaction limit from verified model metadata; they are left unset rather than guessed.
- The shared `NativeRpcClient` ignores server-initiated requests. With `approval_policy = never` and no dynamic tools or MCP servers none are expected, but an unexpected one would leave its turn waiting until the work deadline.
- History items larger than the 64 KiB frame limit end the RPC connection; measure real item sizes.
