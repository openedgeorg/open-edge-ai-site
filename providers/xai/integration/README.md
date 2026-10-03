# Grok Build ACP candidate integration (G0, pending)

This directory records the exact Grok Build the xAI Harness Instance Pool (HarInsPoo) candidate is integrated against, and how its Agent Client Protocol (ACP) operations map onto the supervised adapter contract. Nothing here is qualification evidence. The candidate manifest `docs/qualification/xai/candidate.json` stays `pending` until real shared-process evidence exists.

The initial candidate is one long-lived `grok agent --no-leader stdio` process per Shared Harness Instance (ShaHarIns), hosting many Harness Conversation Sessions (HarConSes) as ACP sessions. Persistence, resume, unload and history are taken from what this build declares over ACP and must be evidenced independently. They are not inferred from headless-mode documentation, and a standalone headless resume (`grok -p ... -r <id>`) is not proof of ACP recovery. The adapter has no headless or CLI path.

## Captured build

| Item | Value |
|---|---|
| Build (canonical identity) | `grok 1.0.46 (2765805b9442) sha256:41626a53292324140b92556b9d42ff5542e3dcd04aff85eafb8689dd4adb44fc` |
| Native binary | `grok-1.0.46-linux-x86_64` (the `grok` launcher is a symlink to it), sha256 `41626a53…44fc` |
| Protocol capture | `protocol-capabilities.json` |
| Runtime configuration | `infra/runtime/grok/config.toml` |

The canonical identity is the `grok --version` output of an isolated run (no channel suffix) plus the sha256 of the native binary (`grok_build_id`). The frozen capture's `harness_build`, the candidate manifest's `harness_build`, the `qualify inspect` result and `create_grok_adapter` all use exactly this value; the factory refuses any other label.

`protocol-capabilities.json` holds:

- `static`: the version line, binary label and digest, the `--help`, `agent --help` and `sessions --help` command lists, and a byte-substring scan of the binary for ACP method names, ACP request types (`struct PromptRequest`, `struct LoadSessionRequest`, ...), the `messageId`/`userMessageId` fields, session update kinds, and the model-request header names of the build's `xai-grok-sampler` client (`x-grok-session-id`, `x-grok-conv-id`, `x-grok-req-id`, `x-grok-turn-idx`). `qualify inspect` regenerates this section.
- `acp_initialize`: the ACP `initialize` result of one isolated, initialize-only G0 run: protocol version 1, `loadSession: true`, `sessionCapabilities` `list`/`resume`/`close`, MCP over HTTP and SSE, the `grok.com` sign-in method, the built-in model catalog and command list. The `hostname`, `currentWorkingDirectory`, `agentId` and `agentInstanceId` fields are withheld.
- `config_reflections`: settings of this profile that the build was observed to apply, because they changed the `initialize` result.
- `g0_observations`: other facts observed during G0 (see below).
- `acp_v1`: the ACP version 1 surface this build declares (methods whose name is in the binary and whose gating capability was declared) and the ACP v1 field names the contract tests check against. The build ships no machine-readable schema, so these shapes are the protocol's, corroborated by the binary's request types and fields.
- `esp_operation_mapping`: the adapter's mapping below.

Capture and recheck:

```bash
uv run --all-packages python scripts/qualify.py inspect --provider xai                             # compare with the frozen capture
uv run --all-packages python scripts/qualify.py inspect --provider xai --write-protocol-capture    # refreeze after review
uv run --all-packages python scripts/qualify.py inspect --provider xai --acp-handshake             # also re-observe initialize
uv run --all-packages python scripts/qualify.py inspect --provider xai --observation-file obs.json # recorded observation; runs no binary
```

Discovery refuses to execute the build unless it can run it in a new network namespace with no route out (`unshare -rn`). It uses `env -i`, a temporary `HOME` and `GROK_HOME` with this profile's configuration staged, `GROK_DISABLE_AUTOUPDATER=1`, and no credentials. By default it runs only `--version` and the three help commands, then scans the binary file. `--acp-handshake` additionally starts `grok agent --no-leader stdio` and sends `initialize` only. Discovery never creates a session, never sends a prompt and never makes a model request. The ordinary test suite uses `--observation-file`, so it never executes the installed build. A recorded observation is reported as such and can neither refreeze the capture nor run the handshake.

A changed binary makes `inspect` report that the frozen mapping does not apply. A missing declaration is then reported for recapture and review, not as absence. Only the exact frozen build with a re-observed handshake can show a primitive absent, and status and compaction are never decided from declarations.

## Using the adapter

```python
rpc = NativeRpcClient(AcpClientGuard(GrokStdioTransport(process.stdout, process.stdin)))
adapter = create_grok_adapter(rpc, profile)   # inside a running event loop; returns GrokBuildHarnessAdapter
await adapter.initialize()                    # required once, before any other call
```

`initialize` refuses a build that does not declare ACP protocol version 1, `loadSession`, and the `resume` and `close` session capabilities (`GrokCapabilityMissing`). It returns a summary without host-identifying fields. The factory returns the typed `GrokBuildHarnessAdapter` because four required entry points are Grok-specific: `initialize()`, `compact(handle, authority)` and the relay hooks `attribute_model_request(headers, body)` and `attribute_mcp_request(headers)`.

`AcpClientGuard` must sit between the agent's stdout and the RPC client. It is the client half of the tool policy. The supervisor advertises no file-system and no terminal capability. Any agent-to-client request is answered there and never reaches ESP code: a permission request gets the build's own reject option (or an error when none is offered), and `fs/*`, `terminal/*` and any other request get method-not-found. The guard records every refusal.

## Operation mapping

| Adapter operation | ACP method | Notes |
|---|---|---|
| handshake | `initialize` | `clientCapabilities`: `fs.readTextFile = false`, `fs.writeTextFile = false`, `terminal = false`. |
| `create_session` | `session/new` | `cwd = /srv/esp/grok-work`, `mcpServers = []` (the Knowledge Service server comes from the configuration). The session's `model` config option must be `esp-grok`; another value is `model_drift`, a missing one `model_unverified`. No token or identity is ever sent in ACP params. |
| `resume_session` | `session/resume` | Declared by `sessionCapabilities.resume`. Same working directory and model check. No replay. |
| `submit` | `session/prompt` with `messageId = uuid5(session, client_request_id)` | See acceptance below. A second prompt while one of ours is in flight on the session is refused locally (`not_submitted/prompt_in_flight`, nothing sent), because ACP runs one prompt turn per session and the build would queue or steer it. |
| `continue_work` | none | ACP declares no saved-state continuation; `not_submitted/continue_unsupported`, nothing sent. |
| `inspect` | `session/load` replay | See status below. |
| `read_history` | `session/load` replay | Declared by `loadSession`. Only `user_message_chunk` and `agent_message_chunk` text becomes history, grouped per `messageId`; each item's work reference is the user message that started its turn. Reasoning, plans, tool calls and command updates are filtered. Assistant text of our in-flight prompt is `provisional`. |
| `cancel` | `session/cancel` notification | Sent only when the work reference is the prompt we have in flight on that session. ACP cancellation is session-wide, so a stale reference returns `unknown` and sends nothing; it could otherwise interrupt replacement work. |
| `unload` | `session/close` | Declared by `sessionCapabilities.close`. Refused while a prompt of ours is in flight (`GrokSessionBusy`, nothing sent). A successful close drops every attribution, status and binding record of the session; its event queue is kept, so an `events(handle)` stream opened earlier keeps receiving after `resume_session`. |
| `compact` | `session/prompt` with `/compact` | The build lists `compact` in its `availableCommands`. Bound to the supplied scope before the frame is sent, refused while a prompt is in flight, and returns when the build ends that prompt turn. |
| `export_history`, `delete_history` | none | ACP declares neither. The build's `grok export` and `grok sessions delete` CLI commands run outside the ACP process; peer-safe deletion and export are left to the privacy task. |

### Acceptance

ACP answers `session/prompt` only when the prompt turn ends. Neither that answer nor its absence proves durable acceptance. A submission is `accepted` only when the build's persisted session, replayed through `session/load`, holds a `user_message_chunk` whose `messageId` is this request's. The adapter waits briefly for the prompt answer, then reads the replay, and repeats a bounded number of times.

- A terminal answer whose input is not in the replay is `unconfirmed`. The reference is the build's echoed `userMessageId` when it matches ours, otherwise none.
- `not_submitted` has two causes only:
  - `not_sent`: the transport refused before writing.
  - `native_rejected`: the build answered with a JSON-RPC refusal code (parse error, invalid request, method not found, invalid params) and the replay lacks the input.
- Everything else stays `unconfirmed`: a refusal whose input was recorded, a lost answer, a garbled stream, a read failure after the send, an internal or server-defined error, and running out of confirmation attempts.

Because the message id is derived from the session and client request id, status reconciliation can find the input again without any application-side record.

### Status

ACP declares no per-turn status read. With a request id, `inspect` reports:

- `running` for the prompt in flight;
- the observed end (`completed`, `interrupted` or `failed`, from the stop reason) when this connection received that prompt's answer;
- `unknown` when the replay holds the input but no answer was observed, for example after a process replacement;
- not found when the replay lacks the input.

`saved_input_available` always comes from the replay.

### History replay and the live stream

ACP replay notifications are ordinary `session/update` notifications for the same session. While a `session/load` is outstanding, the adapter treats that session's updates as replay and never publishes them as live events. Reads of one session are serialized. The adapter yields briefly before opening a replay so already-received live updates are published first. A live chunk that the build emits during a replay still lands in the snapshot rather than the live stream, and the client rebuilds from history on reconnect. Whether this build replays on `session/load` while a prompt turn is in flight, and whether it echoes the user message live, is not yet observed (Gate 1).

## Per-operation attribution

ACP updates name the session (`sessionId`) but no turn. The work reference is therefore the prompt this adapter sent on that session, and only while that prompt is in flight. The session is bound to the operation's scope before the prompt frame is sent, and released when the build answers the prompt.

The configuration points the `esp-grok` model at a supervisor-local relay on loopback. For each model request, the relay calls `GrokBuildHarnessAdapter.attribute_model_request(headers, body)`, which:

- refuses an oversize body;
- parses the body strictly (duplicate keys, non-finite numbers and a byte-order mark are rejected);
- refuses any model other than the profile's pinned model. Every auxiliary model slot in the configuration (session summary and titles, prompt suggestions, image description, web search) names `esp-auxiliary-disabled`, so such calls are refused;
- reads the native session id only from the `x-grok-session-id` header, which the build's model-request client names, never from prompt text or arrival order;
- refuses unknown and closed sessions;
- refuses a session with no prompt of ours in flight (`unbound_session`). This covers background or auto-wake work on an idle session;
- returns the in-flight operation's inference scope, including any refreshed token.

`attribute_mcp_request(headers)` does the same for Model Context Protocol (MCP) calls with the `x-mcp-session-id` header. The configuration sets that header to the build-documented `{{session_id}}` template on the `esp_knowledge` server. It returns the knowledge scope.

Every refusal raises `UnattributedCall`, increments the transport's unattributed counter and is never forwarded. The configuration sets no `api_key`, `env_key`, `extra_headers`, `env_http_headers`, `auth_provider` or `query_params`, so no process-wide credential identifies a Harness Conversation Session (HarConSes). The relay processes are runtime packaging work; this task supplies and tests the hooks they call.

Both headers are static evidence only: the session header is a string in the binary's model-request module, and the MCP template is documentation. Whether the build sends `x-grok-session-id` on requests to a custom `base_url`, and whether it equals the ACP `sessionId`, is unobserved. If it does not, attribution fails closed: every request is refused.

## Events

`events.normalize_grok_update` turns `session/update` notifications into native events only when the notification names its session and a prompt of ours is in flight there; the event carries that operation's context (including ownership epoch), so late output of an earlier run is never relabelled. An update for a session with no operation in flight is rejected and counted (`unbound_updates`). The mapping is:

- `agent_message_chunk` text becomes `text_delta`.
- Reasoning (`agent_thought_chunk`), plans, replayed user input, command lists, mode, session-info and context-gauge updates never become events.
- A tool call whose name is a qualified Knowledge Service tool (`esp_knowledge__esp.search`, ...) and whose kind does not change state becomes `tool_started` and later `tool_finished`. Every other tool call, including `use_tool`, shell, file, fetch and unknown tools, becomes `disallowed_item` and is counted, so supervision can stop the work and record the violation.
- A `config_option_update` that moves the model option away from `esp-grok` becomes `model_rerouted` and is counted.
- The prompt answer becomes `turn_completed` (or `compaction` for the `compact` command) with the stop reason (`end_turn` completed, `cancelled` interrupted, anything else failed), followed by `usage` when the answer carries it.

The Knowledge Service tool names are mirrored from `services/esp_mcp` and a contract test keeps them equal.

## Tool policy on both sides

Server side (the build), in `infra/runtime/grok/config.toml`:

- permission mode `dontAsk`;
- `deny` rules for every built-in tool under both Claude-style and native names, and `allow` only for `MCPTool(esp_knowledge__*)`;
- web search, web fetch, file writes, image and video generation, LSP and backend tools disabled;
- subagents, memory, goals, workflows, auto-wake, recap, turn summaries, title refresh and prompt suggestions disabled;
- the `strict` sandbox;
- compatibility scanning of Claude, Cursor and Codex hooks, rules, skills and MCP configs disabled;
- one MCP server, `esp_knowledge`;
- session cleanup disabled, because session folders are native history.

Client side (ESP): no file-system or terminal capability is offered, and the guard refuses every agent request. Configured is not enforced: the build silently ignores unknown keys and does not validate rule tool names, so G1 request capture must show the offered tool list.

## G0 inventory

All eighteen required primitives are `unproven`. Declarations show that a primitive is not demonstrably absent; they are not runtime proof. Observed during G0, every run network-isolated and initialize-only:

- ACP protocol version 1 with `loadSession`, and `sessionCapabilities` `list`, `resume` and `close`. MCP over HTTP and SSE; prompt capabilities without images or audio.
- The binary carries `PromptRequest` with a `messageId` field and `PromptResponse` with `userMessageId`, `stopReason` and `usage`.
- The model-request client module names `x-grok-session-id`, `x-grok-conv-id`, `x-grok-req-id` and `x-grok-turn-idx` headers.
- The build documents the `{{session_id}}` MCP header template.
- These settings were observed to apply, because they changed the `initialize` result:
  - `models.default` and `models.disabled_models` (catalog reduced to `esp-grok`);
  - recap, voice and cancel-rewind off;
  - goal and workflow commands removed;
  - the `esp_knowledge` HTTP MCP server listed.
- Unknown configuration keys and sections are silently ignored, and a TOML syntax error stops the build. `grok inspect --json` loads permission rules without validating tool names.
- `initialize` advertises X search tool overrides (`x_keyword_search`, `x_semantic_search`). Whether `features.backend_tools = false` removes them was not observed.
- The build advertises only the `grok.com` sign-in method. The runtime holds no provider credential, and session creation against a custom `base_url` without signing in is unobserved.
- No session was created, no prompt was sent and no model request was made. Model access and the xAI model identifier are unobserved; the configuration carries a placeholder the deployment replaces.

## Open items for Gate 1

- Show that `session/new`, `session/load`, `session/resume` and `session/close` work without a `grok.com` sign-in and with no provider key in the runtime.
- Capture real chat-completions request bodies through the relay:
  - show `x-grok-session-id` on every request and that it equals the ACP `sessionId`;
  - check the body against the gateway's xAI adapter (system-message shape, tool list, any extra fields). A different required shape needs its own named adapter test, not silent translation.
- Show `session/load` replay of a session whose prompt turn is in flight, that `user_message_chunk` carries the client `messageId`, and that the user message is not echoed live before it is persisted. Otherwise mid-turn acceptance cannot be confirmed within the setup budget.
- Show the offered tool list contains no shell, file, web, subagent or X search tool, and that `dontAsk` is honoured or the guard rejects every prompt.
- Show automatic and manual compaction requests pass through the relay with the operation's scope, and that two-pass compaction uses the pinned model.
- Show `session/close` releases residency and that a closed session reloads intact after process replacement on the same storage.
- Set `context_window` and the auto-compaction threshold from verified model metadata. Without them the build assumes 200,000 tokens.
- A garbled stdout line fails every in-flight request in the shared `NativeRpcClient`, so the in-flight prompts of other sessions on the process become `unconfirmed` and their scopes are released. This fails closed, but it is a shared-process blast radius to measure.
