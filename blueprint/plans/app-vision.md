# App #2 — vision

A local-first AI coding-agent desktop app. Same architecture and capability
set as `pydantic-chat` (~13k LOC), rebuilt deliberately: every library is
approved and documented, every boundary is a named contract, and the plan is
the spec — not a sketch the code later diverges from.

**This is a blueprint for a second repository.** These epics describe the
target app; they are not stories for this repo. When implementation starts,
fan each story table out into the second repo's `plans/` story files.

## Locked decisions

- **Architecture:** Electron shell → React/Vite renderer → Python FastAPI
  sidecar → `pydantic-ai` + `pydantic-ai-harness`. Chats grouped by
  workspace folder; backend owns conversation history; renderer sends only
  the new turn.
- **Wire:** Vercel AI UI Message Stream —
  `VercelAIAdapter.dispatch_request(sdk_version=7)` ↔ `Chat` +
  `DefaultChatTransport`. `conversation_store` forces server-owned history.
- **Agent:** one shared `Agent`; per-run capabilities
  `[LocalWorkspace, Coder, Planning, Permissions(+ApprovalReviewer), Skills,
  MCP toolsets]`. No hand-rolled file/shell/planning tools.
- **Profile filtering:** `AbstractCapability.get_wrapper_toolset()` →
  `FilteredToolset`; always permits `load_capability`.
- **Persistence:** single `app.db` (Electron userData), stdlib `sqlite3`;
  hand-rolled `ConversationStore` over per-`ModelMessage` rows (bundled
  `SqliteConversationStore` evaluated → wrong API, rejected).
  `SqliteStepStore`/`SqlitePlanStore` for runs and plans.
- **Sidecar:** Electron main supervises uvicorn dev+prod; ephemeral
  `127.0.0.1` port + per-launch bearer token; `/health` exempt.
- **State:** Zustand for app/UI state + `Chat` registry; streaming state
  never leaves AI SDK `Chat` objects.
- **Providers:** OpenAI, Ollama, openai-compatible, MCP. **Deliberate cut:**
  Anthropic/Google/openai-chat/google-cloud support exists in app #1 and is
  dropped — the default model must move to an OpenAI model (see
  P1-settings-registry). This is an owner-approved scope reduction, not an
  oversight.
- **Editor stack:** Monaco via `@monaco-editor/react` (bundled locally, no
  CDN); `DiffEditor` replaces hand-rolled diff code.
- **Tooling:** Bun + uv, TypeScript 7, ruff, vitest, pyrefly.
- **Security:** renderer never touches fs; loopback+bearer auth; no secret
  logging; `.env`/secret denial; gitignore-aware file access; `LocalWorkspace`
  is containment for file tools — shell safety comes from permissions
  modes + command lists, not the workspace.

## Epics (dependency order)

| Epic | Covers | Depends on |
|---|---|---|
| `P1-foundation` | Scaffold, electron-vite 3-target build, sidecar spawn/auth, shared pkg, verify pipeline, library manifest | — |
| `P1-persistence` | `app.db`, workspaces, chats + versions, `ConversationStore`, secrets + settings KV | foundation |
| `P1-agent-backend` | Agent factory: providers, models, capabilities, profiles/permissions/judge, skills, MCP runtime | persistence |
| `P1-chat-core` | Transport, streaming transcript, approval round-trip, stop/resume, `data-*` events, plan/terminal views | agent-backend |
| `P1-settings-registry` | Settings UI, model catalogs, profiles CRUD, MCP registry + workspace masks | persistence (parallel to chat-core) |
| `P2-file-viewer` | **Design pending owner review** — Monaco editor, explorer, preview modes | chat-core |

## Deliberate cuts (vs app #1)

- Anthropic/Google/openai-chat/google-cloud providers (+ their SDK extras)
- TerminalView — `data-shell` lives in chat tool cards instead
- CodeMirror stack + `diff.ts` — Monaco replaces both
- `sse-starlette`, `shadcn` — never load-bearing

## Definition of done (project-wide)

- `bun run verify` green: tsc strict (no `any`), eslint, vitest, ruff
  check + format, pyrefly, pytest.
- One streamed turn end-to-end: text + tool call + approval + resume after
  sidecar kill.
- Cross-platform lifecycle verified (Linux/macOS/Windows spawn + kill).
