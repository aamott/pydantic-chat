# pydantic-ai — the API surface app #2 uses

Verified against installed `pydantic-ai-slim==2.68.0`; target `==2.70.0`
(re-verify at implementation start — harness hard-pins slim, bump together).
Vendored upstream docs: `specs/vendor/pydantic-ai/`.

## Agent construction

```python
Agent(
    model: Model | str,
    deps_type=AgentDeps,          # app deps: workspace root, settings
    instructions=...,             # system prompt string or callable
    model_settings=ModelSettings(thinking=...),
)
```

- One **shared `Agent`** per backend process; everything per-run is passed to
  `dispatch_request` / `run_stream_events`, never into `Agent()` itself.
- `ModelSettings.thinking` drives provider reasoning levels (OpenAI effort,
  Ollama maps where supported).
- Model refs are provider-prefixed strings resolved via
  `infer_model('openai:gpt-5.2')` style, or explicit `Model` objects.

## Providers in scope (OpenAI / Ollama / openai-compatible only)

- `OpenAIResponsesModel` + `OpenAIProvider` — primary OpenAI path.
- `OpenAIChatModel` — chat-completions fallback (openai-compatible endpoints,
  and Ollama where `OllamaProvider` is not used).
- `OllamaProvider` — subclasses the OpenAI SDK provider; base URL from
  `OLLAMA_BASE_URL` env or arg (raises `UserError` if unset).
- `ModelSettings.thinking` — unified levels `'minimal'…'max'`/`True`/`False`.
- Model catalogs are fetched by the app over `httpx` (`/v1/models`,
  `/api/tags`) — not a pydantic-ai feature.

## Per-run composition — `VercelAIAdapter.dispatch_request`

`pydantic_ai.ui.vercel_ai.VercelAIAdapter.dispatch_request` (verified —
`agent` is **keyword-only**, and base-adapter kwargs pass through):

```python
await VercelAIAdapter.dispatch_request(
    request, *,
    agent,                                  # keyword-only — positional raises TypeError
    sdk_version=7,                          # matches ai@7 / @ai-sdk/react@4
    conversation_id=...,                    # = our chat id
    model=..., model_settings=...,
    capabilities=[...],                     # harness capabilities, per-run
    toolsets=[...],                         # MCP toolsets, per-run
    usage_limits=UsageLimits(...),
    conversation_store=store,               # our ConversationStore impl
    conversation_scope=workspace_id,        # isolates chats per workspace
    deferred_tool_results=...,              # resume w/ approved results
    cancellation_token=...,                 # stop endpoint cancels here
    workspace=...,                          # LocalWorkspaceBackend(root) — app pins it
    instructions=..., timeout=...,
    strip_workspace_refs=True,
    on_complete=..., on_cancel=...,
)
```

- `conversation_store` alone forces server-owned history —
  `manage_message_history` is *ignored* when a store is set, and
  `message_history` xor `conversation_store` is enforced. The request
  carries only the **new turn**; upstream treats client-returned history as
  untrusted, and `manage_system_prompt='client'` must never be used (lets
  client text reach the system voice).
- `run_id` is **single-shot** — passing one already in history raises
  `UserError`. Resume correlation is `conversation_id` +
  `deferred_tool_results`, not a reused run_id (an explicit run_id only
  gives a predictable StepPersistence snapshot key).
- `conversation_scope` mismatch → 404 on the store read.
- `sdk_version=7` required for `ai@7`/`@ai-sdk/react@4` — bump all together.
- Store saves emit a transient `data-conversation-saved` chunk.

## Server-side history — `ConversationStore`

`pydantic_ai.conversation_store.ConversationStore` (single module, ABC).
The app implements it over stdlib `sqlite3`.

Concrete ops (provided): `load`, `load_entries`, `save`, `branch`, `fork`,
`list_conversations`, **`delete`**, **`read_history`** (walks `parent_id`
via `read_entry` — overridable for one-query reads, not required).
**Abstract (5 — all must be implemented):** `read_record`, `write_record`,
`read_records`, `delete_record`, `read_entry`.

- Storage unit is the serialized `ModelMessage` list — per-message rows give
  lossless resume and branch/fork for edit-retry-regenerate.
- `branch`/`fork` back the version-tree UI (prompt edits create versions);
  CAS via `revision` → `ConversationConflict`.
- ⚠ `SqliteConversationStore` (harness, `step_persistence/conversations.py`)
  was evaluated and **rejected** — it is a session-browser store with a
  different API (`save(summary, messages)`/`get`/`listing`/…), none of the
  abstract record/entry methods, so it cannot be used as
  `conversation_store=`. Keep the hand-rolled impl; borrow its CAS + media
  externalization + search-index ideas.

## Streaming + durability primitives used directly

- `agent.run_stream_events(...)` — typed `AgentStreamEvent`s for custom
  consumers (the events bridge).
- `capture_run_messages()` — collects `ModelMessage`s emitted during a run
  (used to persist the transcript on completion).
- `agent.on_event(handler)` / `ctx.emit(CustomEvent(...))` — capability → UI
  event channel; our `data-*` parts ride it.
- `Hooks(before_run=...)` — run-level hooks (run_meta emission).
- `CancellationToken` — cooperative stop; stop endpoint cancels the run's
  token, adapter drains the stream.
- `DeferredToolRequests` / **`DeferredToolResults`** (`pydantic_ai.tools`) —
  the approval round-trip: unapproved calls end the run inside the output;
  the client re-submits decisions fed back via `deferred_tool_results`.
- `UsageLimits(request_limit=, total_tokens_limit=, tool_calls_limit=)` —
  cost/usage guardrails.
- `ModelMessage`/`ModelResponse`/`ToolReturnPart` — history units;
  `ToolReturnPart` metadata is where durable-approval "remembered" flags live.

## Internal helpers the app borrows (pin-watch: private-ish)

- `pydantic_ai.ui._utils.get_ui_message_id` — maps `ModelMessage` →
  UIMessage id (used when serializing stored history).
- `dump_message_metadata`, `VercelAIAdapter.dump_messages`,
  `VercelAIEventStream`, `NativeEvent`, `DataChunk`, `response_types` —
  used by replay/resume routes.

## Message-history rules (from package CLAUDE.md, apply to app #2)

- `RetryFeedbackPart` is reconstructed only from adapter metadata claims —
  never from client text.
- Frame tags via `pydantic_ai.framing.wrap()` + `register_tag()`, never
  hand-built literals; `'system'` voice is core-only.
- `ToolAvailabilityDeltaPart` → system voice is developer-only content by
  design (trust model pinned upstream).
- For wire-level regression tests, upstream drives the real `AbstractChat`
  client from Node (`tests/ui_roundtrip`) — worth copying for app #2 instead
  of hand-rolling a request-JSON harness.

## Toolsets used

- `MCPToolset` (`pydantic_ai.mcp`) + `.prefixed(server_name)` — every MCP
  tool name is `{server}_{tool}` for profile filtering. ⚠ `MCPServer*` and
  `load_mcp_servers` were **removed in V2** — `MCPToolset` is the only MCP
  surface; `load_mcp_toolsets(config_path)` exists for config files.
- `FilteredToolset(toolset, filter_fn)` — our cross-cutting profile filter
  (see harness spec — implemented as `AbstractCapability.get_wrapper_toolset`).
- `ApprovalRequiredToolset` — marks approval-needed tools by kind/metadata.
- `WrapperToolset` — upstream rule: extend this for cross-cutting behavior,
  never modify base toolsets.

## Getting latest docs (https://pydantic.dev/docs/ai/)

Canonical domain is `pydantic.dev` — the old `ai.pydantic.dev` redirects.
The site is agent-friendly; every page serves raw markdown:

- `https://pydantic.dev/llms.txt` — real linked index of every doc page
  (covers `pydantic-ai`, `pydantic-ai-harness` under `/docs/ai/harness/`,
  and pydantic core). Fetch this first to find the right URL.
- Any page is fetchable as markdown at `.../index.md` — guides, AND the
  full API reference under `/docs/ai/api/` (e.g.
  `/docs/ai/api/pydantic-ai/agent/index.md` for `Agent`).
- The site asks agents to append `?goal=<short-task>&organization=<org>`
  query params — maintainers use them to fix pages where agents get
  stuck. Keep goal to a few non-confidential words.
- Official coding-agent skill ships with the package — already vendored
  at `specs/vendor/pydantic-ai/SKILL.md`; refresh on version bumps.

This spec is pinned to `pydantic-ai-slim==2.70.0` — 0.x moves fast. On any
version bump, re-fetch the API pages for `Agent`, `RunContext`,
`ConversationStore`, and `VercelAIAdapter` rather than trusting this doc
or memory.
