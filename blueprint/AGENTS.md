# Summary

Local-first AI coding-agent desktop app: Electron (Bun, React, Vite, Tailwind) over a Python FastAPI sidecar running `pydantic-ai` + `pydantic-ai-harness`. Chats are grouped by workspace folder and persisted locally.

This file ships inside the predecessor's `blueprint/` package. After that package is copied into app #2, this file is the repository-root `AGENTS.md`; every path below is relative to the new repository root (`plans/`, not `blueprint/plans/`). Start with `plans/app-vision.md`. Treat `specs/` as verified API truth, `inventory/` as the behavior checklist, and `references/` as working examples—not contracts to port verbatim.

## Repo layout (planned)

```
apps/desktop/    # Electron app: src/{main,preload,renderer}
apps/backend/    # FastAPI sidecar (uv): app/{api,agent,db}
packages/shared/ # TypeScript API and stream contracts
plans/           # vision, epics, stories, open questions
specs/           # verified library/API surfaces
inventory/       # required behavior checklist
references/      # app #1 examples; not app #2 contracts
```

## Core architecture

- **Wire:** Vercel AI UI Message Stream: `VercelAIAdapter.dispatch_request(sdk_version=7)` ↔ AI SDK `Chat` + `DefaultChatTransport`. The renderer sends only the new turn; `conversation_store` owns history. `data-*` parts are stream-only.
- **Agent:** one shared `Agent`; per-run native capabilities `[LocalWorkspace, Coder, Planning, Skills, Permissions(+Reviewer), StepPersistence, ProfileFilter]`, plus prefixed MCP toolsets. `ProfileFilter` uses `AbstractCapability.get_wrapper_toolset()` + `FilteredToolset` and always permits `load_capability`. Do not hand-roll file, shell, planning, approval, skill, or persistence tools already supplied by the harness.
- **Persistence:** one `app.db` under Electron `userData`, using stdlib `sqlite3`. Implement `ConversationStore` with one row per `ModelMessage`, plus `SqliteStepStore` and `SqlitePlanStore`. Store provider keys and MCP credentials in permission-restricted `secrets.json`; keep non-secret settings in sqlite KV.
- **Sidecar:** Electron main spawns and supervises uvicorn in development and production on an ephemeral `127.0.0.1` port. Require a per-launch bearer token on every route except `/health`.
- **State:** Zustand holds app/UI state and a registry of AI SDK `Chat` instances. Streaming state remains inside each `Chat`, never Zustand.
- **Editor:** Monaco via `@monaco-editor/react`, bundled locally. The editor is editable; use Monaco `DiffEditor` for diffs. All reads and writes go through the sandboxed backend—renderer code never accesses the filesystem directly.
- **Providers:** OpenAI, Ollama, openai-compatible endpoints, and MCP only.

## Planning system

`plans/app-vision.md` contains locked decisions and implementation order. `plans/P<n>-<epic>.md` files define epics and ordered stories; honor dependencies and land `packages/shared` contracts first so frontend and backend work can parallelize. Fan out stories as work starts; track state with `pending|wip|done|blocked-<desc>-<urgency>-<difficulty>.md`. Record acceptance checks and test evidence before marking done; keep unresolved decisions in `plans/open-questions.md`. Cite `references/` only as working examples; do not let them override `plans/` or `specs/`.

## Quality and verification

- Use Bun workspaces for JavaScript/TypeScript and `uv` for Python; keep Node on `PATH` for Electron tooling.
- Keep files focused; use strict TypeScript with no `any` and Google-style Python docstrings.
- Prefer native `pydantic-ai`/harness features over custom equivalents.
- Use subagents for major implementation work and research, with disjoint edit scopes. Write reusable findings under `docs/research/`.
- Decide ordinary implementation details autonomously. Escalate unresolved product behavior, new dependencies, security weakening, or conflicts in target contracts; do not silently change scope.
- Pin JavaScript dependencies exactly. Pin `pydantic-ai-slim` and `pydantic-ai-harness` exactly and in lockstep; deliberately bump version-coupled sets together.
- Run `bun run verify` before completing major work. It must gate strict TypeScript, ESLint, Vitest, `ruff check`, `ruff format --check`, pyrefly, and pytest.
- Definition of done includes an end-to-end streamed text/tool/approval turn that resumes after sidecar restart, plus verified Linux, macOS, and Windows spawn/kill behavior.

## Security and cross-platform rules

- Never log API keys, bearer tokens, or MCP secrets; never store app state in a workspace.
- Protect `secrets.json` with owner-only permissions (`0600` on POSIX; equivalent restrictions on Windows). Write-protect `.env` files, enforce `denied_patterns` for read denial, and make file discovery gitignore-aware.
- `LocalWorkspace` confines file tools. Shell safety comes from `Permissions` and explicit command lists—not from assuming workspace confinement covers shell execution.
- Keep loopback binding and bearer authentication mandatory. Preserve Electron context isolation and a narrow preload/API surface.
- Handle Windows, macOS, and Linux paths, quoting, process groups, graceful shutdown, and Windows `taskkill` branches from the start.

## Library and spec lookup

- Read `specs/libraries.md` before adding or upgrading dependencies. Use its approved versions, exclusions, coupling rules, and pending-approval list; do not add pending libraries to manifests before approval.
- Check the relevant file in `specs/` before implementing library-specific behavior, especially harness capabilities and AI SDK streaming.
- Use Context7 for library/API documentation lookups. Because `pydantic-ai` and the harness move quickly, verify APIs against the installed pinned source at implementation start and on version changes; the manifest flags older spec surfaces. Resolve discrepancies deliberately rather than trusting memory or silently rewriting specs.
- Prefer approved existing dependencies and built-in framework features. If a required API is absent or ambiguous, record research under `docs/research/` and resolve it in the relevant plan or `plans/open-questions.md` before inventing a replacement.
