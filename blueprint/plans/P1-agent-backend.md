# P1 — Agent backend

**Status:** todo · **Order:** 3rd · **Depends on:** P1-persistence

## Goal

Per-run agent assembly: providers, model resolution, harness capabilities,
permission profiles, judge, skills, MCP toolsets — all harness-native.

## Architecture decisions

- **One shared `Agent`** at startup; per-run values go through
  `dispatch_request`/`run_stream_events` args (`model`, `model_settings`,
  `capabilities`, `toolsets`, `usage_limits`, `deferred_tool_results`,
  `cancellation_token`, `workspace`). Working example:
  `references/agent-factory.py`.
- **Providers:** `OpenAIResponsesModel` (primary), `OpenAIChatModel`
  (compatible endpoints), `OllamaProvider` (`OLLAMA_BASE_URL` or arg). Keys
  from `secrets.json`. Catalogs fetched via `httpx` (`/v1/models`,
  `/api/tags`) with short timeouts + static fallback list.
- **Capability list per run** (fixed order):
  `[LocalWorkspace(root, read_only=?), Coder(sub_agents=False),
  Planning(SqlitePlanStore(session=chat_id)), Skills(...), Permissions(mode),
  ApprovalReviewer(?), StepPersistence(SqliteStepStore), ProfileFilter]`
  + `toolsets=[prefixed MCP toolsets]` honoring the workspace mask.
- **Profile → capability assembly** (mode names mislead — semantics in
  `specs/pydantic-ai-harness.md` §Permissions):
  `bypass`→Coder+`Permissions('full')`;
  `smart`→Coder+`Permissions('auto')`+`ApprovalReviewer`;
  `manual`→Coder+`Permissions('read-only')`;
  `read-only`→**no Coder** — `FileSystem(read_only=True)` + `RepoContext` +
  `Permissions('read-only')`.
  Allow/deny lists inject via `visit_and_replace`, not tool wrapping.
- **Judge resolution:** explicit `judge_model` → run's own model → degrade
  to `manual` with warning; unresolvable *explicit* judge fails loudly.
  `ApprovalReviewer(question=)` is required; approve-or-ask, never denies.
- **`ProfileFilter`** — `get_wrapper_toolset()` → `FilteredToolset`
  (exact names + `{server}_` prefixes); **always permits `load_capability`**.
- **Containment ≠ sandbox:** `LocalWorkspace` guards file tools; `shell` is
  bounded by `Permissions` + command lists only. `.env` = write-protect via
  `read_only_patterns` defaults + **read-denial via `denied_patterns`**.
- **Per-chat cwd continuity** (not a persistent shell process): ⚠ upstream
  `shell` runs detached jobs; `persist_cwd` is per-`run_id` and Coder doesn't
  enable it. App #2 carries a **per-chat cwd** in deps:
  each chat holds its working directory, the `shell` tool resolves it per
  call. Concurrent chats already get fresh toolsets per run — the missing
  piece is cwd continuity within a chat.
- **Skills:** `Skills` over system dir + workspace `.devin/skills` etc.;
  `missing_directories='skip'`, `duplicate_names='keep_first'`,
  `unknown_names='skip'`; bundled skills seeded on first run; host render
  via `SkillDefinition.render`.
- **Usage/cost:** `UsageLimits` per run; `genai-prices` for nullable cost.
  `data-run-meta` announces `{run_id, model, permission_profile}` at start,
  then adds final `usage`/`cost`; persist the summary separately for reload.
- **Events bridge:** `agent.on_event` → `CustomEvent`s → `data-plan`/
  `data-shell`/`data-run-meta`/`data-notice`/`data-resume`. One module;
  stream-only, never persisted. Working example: `references/events-bridge.py`.

## Stories (in order)

1. **Provider + model resolution** — OpenAI/Ollama/compatible resolve from
   settings; catalogs work offline-tolerant; `thinking` → `ModelSettings`;
   default `openai:gpt-5.6-luna`.
2. **Agent factory** — per-run capability list assembled from
   chat+workspace+profile; unit test asserts exact tool surface per profile.
3. **ProfileFilter** — filter applied; `load_capability` always reachable;
   MCP prefix matching; profile changes take effect on the next run, including
   approval continuation (capabilities are assembled per run).
4. **Permissions wiring** — all four profiles verified against `shell` +
   `write_file`; `read-only` ships no shell/write tools; approvals surface
   as `DeferredToolRequests`.
5. **Judge** — resolution order per above; degrade warns; bad explicit
   judge errors clearly.
6. **Skills** — both dirs load + dedupe; bundled seed (`ensure_…`) on first
   run; catalog API; `disable-model-invocation` respected.
7. **MCP runtime** — registry specs → prefixed toolsets; workspace mask
   disables servers; secrets never logged; failing server degrades to
   disabled + notice.
8. **Events bridge** — plan/shell/run-meta/notice/resume → `data-*` parts;
   transcript persists none of them.
9. **Step persistence** — `SqliteStepStore` in `app.db`; resume uses
   `list_runs`/`latest_snapshot`/`list_unresolved_tool_effects`;
   `SqlitePlanStore(session=chat_id)`.
10. **Per-chat shell** — deps-carried cwd per chat; `cd` persists across
    runs of the same chat; concurrent chats never share a session.
