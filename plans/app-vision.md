# App Vision — pydantic-chat (working name)

Local-first AI chat + coding-agent desktop app. An Electron shell (React / Vite / Tailwind) talks over loopback HTTP+SSE to a Python FastAPI sidecar running `pydantic-ai` + `pydantic-ai-harness`. Chats persist in a central sqlite DB, grouped by workspace folder. Right split panel previews files/tools the agent references.

## Locked decisions (verified against installed versions)

- **Wire protocol:** Vercel AI UI Message Stream (SSE). `VercelAIAdapter.dispatch_request(..., sdk_version=7)` ↔ `useChat` + `DefaultChatTransport`. Pinned `ai@7.0.162` + `@ai-sdk/react@4.0.166`; `pydantic-ai-slim==2.68.0` + `pydantic-ai-harness==0.68.0` (lockstep pair).
- **Agent:** shared `Agent` + per-run `capabilities=[LocalWorkspace(root), Coder(root), Planning(...)]`. `Coder` composes FileSystem + Shell + RepoContext + SubAgents + compaction/output-limits. `[coder]` extra bundles the `rg` binary.
- **Permissions:** `Permissions('full'|'auto'|'read-only')` (auto has a built-in risky-command analyzer via `ask_commands`) + `ApprovalReviewer(model)` for LLM-judged approval ("smart" profile) + `ToolCallJudge` for model-blocks; `Shell(allowed/denied_commands)` and `FileSystem(allowed/denied/protected_patterns)` handle lists natively. Profiles: bypass / smart / manual / read-only, per-workspace + global default.
- **Persistence:** `pydantic_ai.conversation_store.ConversationStore` (ABC, entry-chain: `read_record`/`write_record`/`read_entry`/`read_records`/`delete_record`; `load`/`save`/`fork`/`list_conversations` provided) implemented over sqlite `app.db` in Electron `userData`. Passed to `dispatch_request(conversation_store=, conversation_scope=)` — server-side history also dodges stale-approval bug #5154.
- **Providers:** Anthropic / OpenAI (`OpenAIResponsesModel`) / Google / Ollama (`OllamaProvider` — needs `[openai]` extra). Keys in backend secrets file (chmod 600), env fallback.
- **UI:** Zustand; CodeMirror 6 read-only viewer; Streamdown + shadcn AI Elements (via shadcn CLI registry, NOT deprecated ai-elements pkg); react-resizable-panels v4 (`Group`/`Separator`/`useDefaultLayout`).
- **Shell:** electron-vite 6; Electron main supervises uvicorn in dev AND prod; ephemeral `127.0.0.1` port + per-launch bearer token; `settings.html` second window; `windowStatePersistence` built into Electron 44+.
- **OS:** Linux/macOS/Windows — cross-platform code day one; packaging dev-mode this week.

## Roadmap

### Phase 1 — v1

- ✅ ~~P1-app-scaffold~~ — repo, electron-vite, sidecar lifecycle, loopback auth, shell chrome, dev builds
- ✅ ~~P1-workspaces-persistence~~ — sqlite ConversationStore, REST CRUD, grouped sidebar, titles
- ✅ ~~P1-settings~~ — settings window, settings API, API keys
- [P1-chat-core](P1-chat-core.md) — `/chat` endpoint + useChat client + message rendering (endpoint + rendering done; client wip, replay pending)
- [P1-agent-harness](P1-agent-harness.md) — Coder/Planning/Permissions wiring, providers, permission profiles, approval UI
- [P1-right-panel](P1-right-panel.md) — split view, read-only file viewer, file links, explorer, diffs, terminal (layout/viewer/explorer done)

### Later

- tree-sitter `code_outline` tool (v1.1)
- editable right-panel files + diff apply
- PyInstaller-frozen sidecar + signed installers + auto-update
- `AskUser`/`RequestInput` mid-run questions, chat export, message pagination
- AG-UI protocol as alternative front-end adapter if a non-AI-SDK UI ever lands

## Research notes (from subagent audits, 2026-11-12)

- `dispatch_request` also accepts: `cancellation_token`, `on_cancel`, `manage_message_history='server'`, `workspace=`, `run_id`, `allowed_file_url_schemes`, `deferred_tool_results` (auto-extracted from `approval-responded` parts).
- Harness `pydantic_ai_harness.step_persistence.conversations.SqliteConversationStore` exists but is a DIFFERENT class (pre-dates core ABC) — don't confuse; also `SqlitePlanStore` ships for `Planning`.
- `Planning` progress: deprecated `PlanEventEmitter` → typed `CapabilityEvent` subclasses.
- Chat titles: possible "background names" in harness step_persistence `ConversationSummary` — verify before hand-rolling.
- Known-open bug: pydantic-ai #5154 (stale `approval-responded` parts) — server-side history via `conversation_store` avoids it entirely.
- `packages/shared` covers IPC types only; for the HTTP boundary, OpenAPI codegen (`openapi-typescript`/`@hey-api/openapi-ts` against FastAPI's `/openapi.json`) is available if hand-mirrored types get annoying.
