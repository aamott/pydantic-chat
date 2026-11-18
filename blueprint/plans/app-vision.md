# App #2 — vision

A local-first AI coding-agent desktop app — the deliberate re-spec of
`pydantic-chat`. Same architecture and similar scope (~13k LOC), with the
deliberate cuts below. The plans are the spec; dependency approval status
lives in `specs/libraries.md`.

**Ship unit:** the entire `blueprint/` contents, including its `AGENTS.md`,
copied into the new repo root. Paths below are relative to that root.
`references/` holds app-#1 examples (not contracts), `specs/` holds library
API surfaces, and `inventory/` is the behavior checklist.
Unresolved decisions: `open-questions.md`.

## Locked decisions

- **Architecture:** Electron → React/Vite renderer → FastAPI sidecar →
  `pydantic-ai` + `pydantic-ai-harness`. Chats grouped by workspace folder;
  backend owns history; renderer sends only the new turn.
- **Wire:** UI Message Stream — `VercelAIAdapter.dispatch_request
  (sdk_version=7)` ↔ `Chat` + `DefaultChatTransport`; `conversation_store`
  forces server-owned history.
- **Agent:** one shared `Agent`; per-run capabilities
  `[LocalWorkspace, Coder, Planning, Skills, Permissions(+Reviewer),
  StepPersistence, ProfileFilter]` + prefixed MCP toolsets. No hand-rolled
  file/shell/planning tools.
- **Profile filter:** `AbstractCapability.get_wrapper_toolset()` →
  `FilteredToolset`; always permits `load_capability`.
- **Persistence:** one `app.db` (userData), stdlib `sqlite3`; hand-rolled
  `ConversationStore` over per-`ModelMessage` rows; `SqliteStepStore` +
  `SqlitePlanStore`. Settings split: `secrets.json` (provider/MCP credentials, restricted permissions) + sqlite KV.
- **Sidecar:** Electron main supervises uvicorn dev+prod; ephemeral
  `127.0.0.1` port + per-launch bearer; `/health` exempt.
- **State:** Zustand app/UI state + `Chat` registry; streaming state never
  leaves `Chat` objects.
- **Providers:** OpenAI, Ollama, openai-compatible, MCP only.
- **Editor:** Monaco via `@monaco-editor/react` (bundled locally); its
  `DiffEditor` replaces hand-rolled diff.
- **Tooling:** Bun + uv, TS 7, ruff, vitest, pyrefly (hard gate).
- **Security:** renderer never touches fs; loopback+bearer; no secret
  logging; `.env` write-protect + `denied_patterns` read-denial;
  gitignore-aware access; `LocalWorkspace` confines file tools — shell
  safety comes from `Permissions` + command lists, not the workspace.

## Deliberate cuts (vs app #1 — where "same scope" is narrower)

Anthropic/Google/openai-chat/google-cloud providers · TerminalView
(`data-shell` renders in chat tool cards) · CodeMirror + `diff.ts` ·
focus-refetch drift detection (save-time conflict checks remain) · signed
installers/frozen sidecar (v1 is unpacked developer distribution).

## Epics (implementation order)

| # | Epic | Depends on |
|---|---|---|
| 1 | `P1-foundation` — scaffold, sidecar, verify gate | — |
| 2 | `P1-persistence` — app.db, workspaces, chats, store, settings | 1 |
| 3 | `P1-agent-backend` — providers, capabilities, profiles, MCP runtime | 2 |
| 4 | `P1-chat-core` — transport, streaming, approvals, resume, `data-*` | 3 |
| 5 | `P1-settings-registry` — settings window, catalogs, profiles, MCP UI | 2 (∥ 4) |
| 6 | `P2-file-viewer` — Monaco editor, tabs, drawer, explorer | 4 |

Dev-velocity rules: land `packages/shared` contracts first in each epic so
frontend/backend stories parallelize; cite `references/` examples per
story; `specs/` is read-only API truth — epics point at it, never restate.

## Definition of done

- `bun run verify` green: tsc strict, eslint, vitest, ruff check + format,
  pyrefly, pytest.
- One streamed turn end-to-end: text + tool + approval + resume after a
  sidecar kill.
- Cross-platform spawn/kill verified (Linux/macOS/Windows).
