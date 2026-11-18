# Inventory — what app #1 actually does

The baseline app #2 re-specifies. ~13k LOC; the goal is same scope, tighter
organization — **not** new features. Source: `apps/backend/app`,
`apps/desktop/src`, `packages/shared`, `plans/app-vision.md`,
`docs/research/*`. File paths are app-#1 provenance — the load-bearing
implementations are vendored under `../references/` so this doc stands
alone without the app-#1 repo.

## Backend (`apps/backend/app`)

| Area | Files | Behavior |
|---|---|---|
| Chat streaming | `api/chat.py` | `POST /api/chat` → `VercelAIAdapter.dispatch_request` (sdk 7, server-managed history); `POST /api/chats/{id}/stop` cancels via `CancellationToken`; `GET` + `POST /api/chats/{id}/resume` handle interrupted runs; `GET /api/chat/{id}/stream` replays |
| Conversation persistence | `db/store.py`, `db/app_tables.py` | Stdlib `sqlite3`, `app.db` in Electron userData for `ConversationStore` — per-`ModelMessage` rows, version tree, failed/interrupted turns. Predecessor plans/snapshots use separate `plans.db`/`steps.db`; app #2 consolidates them |
| Agent assembly | `agent/factory.py` | Per-run capabilities `[LocalWorkspace, Coder, Planning, Permissions(+ApprovalReviewer), Skills, MCP toolsets]`; profile → `Permissions` mode mapping; judge-model resolution (explicit → run model → degrade to manual); provider/model resolution |
| Events bridge | `agent/events.py` | `agent.on_event` → `CustomEvent` → `data-plan`/`data-shell`/`data-run-meta` parts |
| Files API | `api/files.py` | `GET/PUT /api/files` confined to registered workspace roots; `if_match` version check → 409 on drift; `GET …/raw` for images/binaries; tree listing via `rg` (gitignore-aware, `os.walk` fallback); `.env`/secret denial |
| Chats API | `api/chats.py` | CRUD, titles, per-chat model/thinking/profile overrides, versions, conversation data |
| MCP API | `api/mcp.py` | Server registry CRUD (transport/command/env/headers); secrets round-trip, never logged; per-workspace enable masks |
| Profiles API | `api/profiles.py` | Built-in profiles immutable (`bypass`/`smart`/`manual`/`read-only`); custom profiles = JSON in sqlite settings KV; tool catalog + skill catalog endpoints |
| Settings + secrets | `settings.py`, `api/settings.py` | **Split storage:** `secrets.json` `chmod 600` (provider keys; app #2 also moves MCP credentials here) + sqlite `settings` KV (defaults, custom profiles, theme); masked key reads; never logged. Default model today is `anthropic:claude-sonnet-4-6` — app #2 needs a new default (Anthropic cut) |
| Misc | `main.py` | `/health` unauthenticated + `/api/ping` authenticated liveness; `TrustedHost` loopback; save notification is adapter-emitted transient `data-conversation-saved`, not an `X-Entry-Id` header |
| App entry | `main.py`, `api/deps.py` | FastAPI app; bearer auth on all routes except `/health` |

## Desktop (`apps/desktop/src`)

| Area | Files | Behavior |
|---|---|---|
| Sidecar lifecycle | `main/sidecar.ts` | Spawns `uv run uvicorn` (dev AND prod); ephemeral `127.0.0.1` port + per-launch bearer; scrubs env; `/health` poll; capped exponential restart backoff; process-group kill cross-platform (`taskkill` on Windows); `AGENT_BACKEND_EXTERNAL` dev mode |
| Shell/lifecycle | `main/index.ts`, `main/menu.ts`, `windows.ts`, `ipc.ts` | Single-instance lock + second-instance focus; `before-quit` graceful stop; macOS `activate` re-open; app menu (Open Workspace ⌘O, Settings ⌘,) + `menu:open-workspace` IPC; **settings = second BrowserWindow** + theme relay (dark/light/system, `data-theme`); loading/error pages; `backend:status` broadcast (⚠ no renderer consumer today — gap) |
| Window | `main/` | Electron window with built-in `windowStatePersistence`; `shell:open-path` IPC (confined) |
| Chat state | `stores/chats.ts` | Non-reactive `Map<chatId, Chat>` registry; hydration once per chat; workspace/chat switching; dirty-buffer guard; stop/resume; notices |
| Transport | `lib/transport.ts` | `DefaultChatTransport` + bearer, base `/api/chat` deriving replay at `GET /api/chat/{id}/stream`; `newTurnMessages` slicing; replay 404 = nothing; one-shot resume; approval auto-resubmit |
| Data parts | `lib/dataParts.ts` | Validates `data-plan`/`data-shell`/`data-run-meta`/`data-notice`/`data-resume`; keeps latest plan snapshot; drops shell/run-meta from transcript; `collectShellBlocks` shared by tool cards |
| File refs | `lib/fileRefs.ts`, `MessagePart.tsx`, composer | `file:` link grammar (`path`/`path:LINE`/`path#Ln`/`file:///abs`) + sanitize-protocol interception → `uiStore.openFile`; backend injects `FILE_LINK_INSTRUCTIONS` so the agent emits them; composer @-mention + attach pickers |
| Misc UX | various | Auto-title from first prompt (~40 chars); "Working… Ns" dead-air indicator; approval-group "Approve all" + deny-with-reason→`ToolDenied` + arg previews (mini diffs); workspace missing-folder badge; `VersionChip` popover |
| Messages | `lib/messages.ts` | `newTurnMessages`, edit/retry/regenerate helpers; failed-run comments predate backend durability fixes (app #2 retry semantics are in P1-chat-core) |
| Other stores | `stores/{models,profiles,workspaces,ui}.ts` | Zustand: model catalog, profiles, workspaces, UI state (panel/tab/drafts/open-file refs). Streaming state never in Zustand |
| Shared contracts | `packages/shared` | TS types mirroring API + IPC channel constants |

## Right panel (post-prototype working-tree state)

The P2 layout prototype landed uncommitted in this tree: file-tab strip +
left-edge drawer (Explorer/Diff selector, overlay↔pinned at ~560px) have
replaced the old 4-tab strip; `TerminalView.tsx` is **dormant on disk**
(file kept, unmounted); `data-shell` phases now stream live into the chat's
shell `ToolCard` via shared `collectShellBlocks`.

- **Layout:** `react-resizable-panels` chat|tools split, persisted via
  `useDefaultLayout`; inside the panel: tab strip + drawer.
- **FileViewer** (~1,100 lines, CodeMirror 6): already a **full editor** —
  editable auto-enabled unless effective profile is `read-only` (pencil is
  a manual lock on top); `.md` preview on by default; image blob view via
  `/raw`; binary → external-open IPC; oversize mode; `#L<n>` anchor;
  Mod-S save → `if_match`; 409 → conflict banner (reload/overwrite +
  disk↔buffer diff); drift flag on focus-refetch (no fs watch).
  App #2's delta is the CM→Monaco swap + multi-buffer, *not* building
  editing.
- **ui store (rewritten):** `openTabs[workspaceId]` (`{path, pinned, line}`),
  drawer state (`drawerOpen` session, `drawerPinned` persisted), `fileDirty`
  guards on every buffer-dropping path; persist v2 migrates `openFiles`.
- **Prototype simplifications not to carry forward:** single buffer remounted
  per tab (only active tab dirty-able; pinned tabs don't preserve edits);
  Explorer expansion resets on drawer close.

## Non-obvious coupling to preserve

- Approval round-trip lives in tool parts' `approval-requested` state +
  `deferred_tool_results`; `sendAutomaticallyWhen` auto-resubmits.
- `data-*` parts are stream-only — every consumer treats them as optional.
- File writes from the agent and the editor share the version counter —
  `if_match` is the only concurrency story (no fs watching).
- Effective profile resolution (chat override → workspace → global →
  built-in default) gates both backend `Permissions` mode and renderer
  editability — one resolver, two consumers.
- `rg` presence drives the gitignore-aware tree; `[coder]` extra supplies it.
- Sidecar token/port are per-launch — renderer and main share them via
  preload, never persisted or logged.
