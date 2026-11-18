# P1 — Agent backend

**Status:** spec'd · **Depends on:** P1-persistence

## Goal

The per-run agent assembly: providers, model resolution, harness
capabilities, permission profiles, judge, skills, and MCP toolsets — all
harness-native, no hand-rolled tools.

## Architecture decisions

- **One shared `Agent`** built at startup; everything per-run goes through
  `dispatch_request`/`run_stream_events` args (`model`,
  `model_settings`, `capabilities`, `toolsets`, `usage_limits`,
  `deferred_tool_results`).
- **Providers in scope:** `OpenAIResponsesModel` (primary),
  `OpenAIChatModel` (compatible endpoints), `OllamaProvider`. API keys from
  `secrets.json`; base URLs configurable. Model catalogs fetched via
  `httpx` (`/v1/models`, `/api/tags`) with short timeouts and cached.
- **Capability list per run** (order fixed):
  `[LocalWorkspace(root, read_only=?), Coder(sub_agents=False), Planning(SqlitePlanStore), Skills(...), Permissions(mode), ApprovalReviewer(?), StepPersistence(SqliteStepStore), ProfileFilter]`
  plus `toolsets=[prefixed MCP toolsets]` honoring the workspace enable mask.
  Working example: `references/agent-factory.py`.
- **`ProfileFilter`** — `AbstractCapability` whose `get_wrapper_toolset`
  returns `FilteredToolset` over the assembled toolset matching profile
  allow/deny (exact names + `{server}_` MCP prefixes); **always permits
  `load_capability`**.
- **Profile → capability assembly** (verified mapping — mode names mislead,
  see `specs/pydantic-ai-harness.md`):
  `bypass`→`Coder`+`Permissions('full')` (nothing asks);
  `smart`→`Coder`+`Permissions('auto')`+`ApprovalReviewer`;
  `manual`→`Coder`+`Permissions('read-only')` (asks human on every
  write/command);
  `read-only`→**no Coder** — `FileSystem(read_only=True)` + `RepoContext`
  + `Permissions('read-only')` (no shell, no coder instructions).
  Allow/deny lists inject via `CombinedCapability.visit_and_replace`.
  Judge resolution: explicit `judge_model` → run model → degrade to `manual`
  with warning; unresolvable explicit judge fails loudly.
- **Containment is not a sandbox:** `LocalWorkspace` guards file tools; the
  `shell` tool is bounded by `Permissions` + allow/deny lists only. Both
  layers plus `.env`/secret patterns are enforced — and documented as such.
- **One persistent shell per chat** (owner decision — concurrent chats are
  essential). ⚠ No such session exists upstream: `shell` runs detached jobs
  in the workspace and cwd persistence (`persist_cwd`, which Coder doesn't
  enable) is keyed by `sha256(run_id)` — per-run, not per-chat. App #2 needs
  its own mechanism: persistent per-chat cwd + env carried in deps (each
  chat holds its working directory; the `shell` tool resolves it per call).
  Concurrent chats already get fresh toolset copies per run, so commands
  never collide — the missing piece is cwd continuity within a chat.
- **Skills:** `Skills` capability over system dir + workspace `.devin/skills`
  (and equivalents); `missing_directories='skip'`, `duplicate_names=
  'keep_first'`, `unknown_names='skip'`. Host-invoked rendering via
  `SkillDefinition.render`.
- **Usage/cost:** `UsageLimits` per run from settings; `genai-prices` does
  cost math — surfaced through `data-run-meta`.
- **Events bridge:** `agent.on_event` → `CustomEvent`s → `data-plan`/
  `data-shell`/`data-run-meta`. One bridge module; `data-*` parts are
  stream-only (never persisted). Working example:
  `references/events-bridge.py`.

## Stories

| Story | Acceptance criteria |
|---|---|
| Provider + model resolution | OpenAI/Ollama/openai-compatible resolve from settings; catalog fetchers work offline-tolerant; `thinking` maps to `ModelSettings` |
| Agent factory | Per-run capability list assembled from chat+workspace+profile; unit test asserts exact tool surface per profile |
| ProfileFilter | Filtered toolset applied; `load_capability` always reachable; MCP prefix matching works; profile switch mid-run takes effect next call |
| Permissions wiring | All four modes verified against `shell`+`write_file`; `read-only` denies both; approvals surface as `DeferredToolRequests` |
| Judge | `smart` resolves judge in documented order; degrade-to-manual warns; bad explicit judge errors clearly |
| Skills | System+workspace dirs loaded, dedup'd; bundled skills seeded into the skills dir on first run (`ensure_system_skills` — see `references/profiles.py`); catalog API returns both; `disable-model-invocation` respected |
| MCP runtime | Registry specs → prefixed toolsets; workspace mask disables servers; env/header secrets never logged; failing server degrades gracefully |
| Events bridge | Plan/shell/run-meta events emit `data-*` parts; persisted transcript contains none of them |
| Step persistence | `SqliteStepStore` in `app.db`; resume uses `list_runs`/`latest_snapshot`/`list_unresolved_tool_effects` (or `continue_run`); `SqlitePlanStore(path, session=chat_id)` scopes plans per chat |

## Non-goals

The HTTP layer wiring to these pieces (chat-core epic); any UI.
