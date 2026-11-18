# Summary

Local-first AI chat + coding-agent desktop app. Electron shell (Bun / React / Vite / Tailwind) over a Python FastAPI sidecar running `pydantic-ai` + `pydantic-ai-harness`. Chats persist in sqlite grouped by workspace folder. v1 spec + stories live in `plans/` — see `plans/app-vision.md` for locked architecture decisions.

## Repo layout (planned)

```
apps/desktop/    # Electron app (electron-vite): src/{main,preload,renderer}
apps/backend/    # FastAPI + pydantic-ai sidecar (uv project): app/{api,agent,db}
packages/shared/ # TS types mirroring API contracts
plans/           # epics + stories (see Planning System)
plans/blueprint/specs/libraries.md  # approved library versions
```

## Core architecture

- **Wire protocol:** Vercel AI UI Message Stream — `VercelAIAdapter.dispatch_request` (`sdk_version=6`) ↔ `useChat` + `DefaultChatTransport`. Pin `ai`/`@ai-sdk/react` to match.
- **Agent:** shared `Agent`; per-run capabilities `[LocalWorkspace(root), Coder(), Planning(), Permissions(mode)]` — do NOT hand-roll file tools.
- **Persistence:** single `app.db` in Electron `userData`, stdlib `sqlite3`, backend implements `ConversationStore` (per-message `ModelMessage` rows — lossless resume).
- **Sidecar:** Electron main spawns/supervises uvicorn (dev AND prod); ephemeral `127.0.0.1` port + per-launch bearer token on all routes except `/health`.
- **State:** Zustand for app/UI state + `Chat` instance registry; streaming state lives in AI SDK `Chat` objects, not Zustand.
- **Editor:** CodeMirror 6, read-only in v1; files always fetched through backend (sandboxed to workspace root) — renderer never touches fs directly.

## Planning System

`plans/` holds `app-vision.md` (roadmap), `P<n>-<epic>.md` files, and per-epic story folders. Story filenames encode state: `pending|wip|done|blocked-<desc>-<urgency>-<difficulty>.md` (desc in snake_case). Implementors: pick up `pending-*` stories honoring `Depends on`, rename to `wip-`/`done-` as you work.

## Quality & conventions

- Bun for JS package management; **Node must stay on PATH** (electron-vite/electron CLIs need it).
- `uv` for Python; pin `pydantic-ai`/`pydantic-ai-harness` versions (0.x, moving fast — re-verify APIs against installed release, don't trust memory).
- Small focused files; strict TypeScript, no `any`.
- Never log API keys or bearer tokens; never write into workspace folders.
- Cross-platform from day one (Linux/macOS/Windows): process-group kill, path handling, `taskkill` branches.
- Run `bun run verify` before completing major tasks. Runs all linting, formatting, and tests
- Python: `uv run ruff check app tests` AND `uv run ruff format --check app tests` — both are gates; format before committing
- Use context7 to check libraries
- Use latest versions of libraries whenever possible
- Take advantage of pydantic ai's built in features rather than rebuilding or writing unnecessary safety that it already provides
- Use subagents for all major implementation work and for docs/research lookups — offload to keep the main context lean. Research subagents should write findings where implementing subagents can consume them.

## Environment quirks (this dev box)

- Shells spawned inside Devin Desktop inherit `ELECTRON_RUN_AS_NODE=1` — the root `dev` script strips it via `env -u`. If Electron runs as plain Node, this is why.
- GPU may fail in sandboxed/VM contexts → launch flags `--disable-gpu --no-sandbox` if the app crashes on GPU init.
- Bun's isolated store can skip `electron`'s postinstall → `node_modules/.bun/electron@*/node_modules/electron/install.js` must be run manually if `dist/` is missing.
- Pinned: `pydantic-ai-slim==2.68.0` + `pydantic-ai-harness==0.68.0` (moves in lockstep — harness hard-pins slim), `ai@7.0.162` + `@ai-sdk/react@4.0.166` (sdk_version=7 wire).


## Reviews
Review findings are stored in `docs/reviews/` with filename format `YYYY-MM-DD/finding_name-urgency-difficulty.md`. Check validity before implementing and avoid duplication. Findings are deleted upon being addressed.