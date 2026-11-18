# P1 — Foundation

**Status:** todo · **Order:** 1st — everything depends on it

## Goal

A runnable skeleton: Electron window ↔ FastAPI sidecar over loopback+bearer,
monorepo toolchain, verify gate — every dependency documented.

## Architecture decisions

- **Layout:** `apps/desktop` (electron-vite `src/{main,preload,renderer}`),
  `apps/backend` (uv `app/{api,agent,db}`), `packages/shared`, `plans/`,
  `docs/research/`.
- **Sidecar in Electron main:** spawn `uv run uvicorn` on an ephemeral
  `127.0.0.1` port; per-launch bearer (main → env → uvicorn, main →
  preload → renderer); all routes except `/health` require it. Working
  example: `references/sidecar.ts`.
- **Supervision:** `/health` poll; capped exponential restart backoff;
  process-group kill (`taskkill /T` on Windows); external-backend env
  override for backend dev; `--reload` in dev.
- **Token hygiene:** bearer + keys never logged, never persisted, headers
  only — never in URLs.
- **CORS:** allow the dev renderer's exact origin or packaged `Origin: null`
  for the current launch; no wildcard origins. Bearer auth remains mandatory.
- **Packaging:** v1 ships unpacked via `electron-builder --dir` and requires
  Python + uv on PATH; signed/installable builds with a frozen sidecar come later.
- **Node stays on PATH** — electron/electron-vite CLIs need it under Bun.
- **Two windows:** main app + singleton settings `BrowserWindow` with a
  theme-relay IPC (`data-theme` tokens; dark/light/system).

## Stories (in order)

1. **Scaffold + toolchain** — `bun install`/`uv sync` clean; workspaces
   resolve `packages/shared`; strict tsconfig (no `any`); harness pair
   pinned (`pydantic-ai-slim==2.70.0`/`pydantic-ai-harness==0.70.0`).
2. **Verify pipeline** — `bun run verify`: tsc, eslint, vitest, ruff check +
   `format --check`, pyrefly (hard gate), pytest; fails loudly.
3. **Backend skeleton** — `/health` (unauthenticated) + `/api/ping`
   (authenticated liveness); bearer middleware on everything else;
   `TrustedHost` loopback-only; renderer CORS; wires api/agent/db packages.
   Test missing/wrong bearer rejection, including `/openapi.json`.
4. **Sidecar supervisor** — spawn → `/health` wait → restart backoff →
   clean kill on quit incl. Windows `taskkill`; env scrubbed.
5. **Windows + menu + IPC** — main window (built-in
   `windowStatePersistence`, unique window names), context isolation, no
   renderer Node integration, validated preload IPC; settings window + theme relay, app menu
   (Open Workspace ⌘O / Settings ⌘,), `menu:open-workspace` → renderer via
   preload; single-instance lock + second-instance focus; `before-quit`
   graceful stop; macOS `activate` re-open; loading/error placeholder
   pages; `ELECTRON_RUN_AS_NODE` stripped in dev script.
6. **Sidecar status surface** — `backend:status` broadcast from main →
   renderer consumer (starting/ready/restarting/dead). App #1 broadcast had
   *no* consumer — this fixes the silent-death gap.
7. **Library manifest** — keep `specs/libraries.md` synchronized with
   manifests; nothing enters a manifest that isn't approved there.
8. **Unpacked build smoke** — `bun run dist` produces a writable `--dir`
   layout with backend source bundled; sidecar starts and authenticated ping
   works outside dev. Document Python/uv prerequisites and first-run downloads.
