# P1 — Foundation

**Status:** spec'd · **Depends on:** —

## Goal

A runnable skeleton: Electron window ↔ FastAPI sidecar over loopback+bearer,
monorepo toolchain, and the verify gate — with every dependency already
resolved and documented.

## Architecture decisions

- **Monorepo layout** (same as app #1 — proven, don't innovate here):
  `apps/desktop` (electron-vite: `src/{main,preload,renderer}`),
  `apps/backend` (uv project: `app/{api,agent,db}`), `packages/shared`
  (TS contracts), `plans/`, `docs/research/`.
- **Sidecar lifecycle lives in Electron main, not a shell script:**
  spawn `uv run uvicorn` on an ephemeral `127.0.0.1` port; per-launch bearer
  token generated in main, passed to renderer through preload (`contextBridge`),
  and to uvicorn via env. All routes except `/health` require it.
- **Supervision:** `/health` poll until ready; capped exponential restart
  backoff; process-group kill on exit (`taskkill /T` on Windows); an
  external-backend env override for backend dev.
- **Token hygiene:** bearer + API keys never logged, never persisted, never
  in a URL query string (headers only).
- **Node stays on PATH** — electron-vite/electron CLIs require it even
  under Bun.
- **Library manifest:** `docs/libraries.md` in the new repo seeds from
  `specs/libraries.md` here — every dep has a one-line justification.

## Stories

| Story | Acceptance criteria |
|---|---|
| Scaffold monorepo + toolchain | `bun install` + `uv sync` clean; Bun workspaces resolve `packages/shared`; strict `tsconfig` (`noUncheckedIndexedAccess`, no `any`); pyproject pins `pydantic-ai-slim==2.70.0`/`pydantic-ai-harness==0.70.0` |
| Verify pipeline | `bun run verify` runs tsc, eslint, vitest, ruff check + `format --check`, pyrefly (**hard gate** — fails on errors, owner-confirmed), pytest; fails loudly, quiet flags on |
| Backend skeleton | FastAPI app with `/health` + `/api/ping` (health unauthenticated, ping authenticated — renderer liveness check); bearer middleware on everything else; `TrustedHost` loopback-only; app entry wires api/agent/db packages |
| Sidecar supervisor | Main spawns uvicorn on ephemeral port; `/health` wait with timeout; renderer learns `baseUrl`+token via preload only; clean kill on quit (incl. Windows `taskkill`); restart backoff capped; env scrubbed |
| Window + renderer shell | electron-vite dev HMR works; window state persists (built-in `windowStatePersistence`); `ELECTRON_RUN_AS_NODE` stripped in dev script; single-instance lock + `second-instance` focus; `before-quit` graceful sidecar stop; macOS `activate` re-open; loading + error placeholder pages |
| App menu + IPC | File ▸ Open Workspace (`CmdOrCtrl+O`) + Open Settings (`CmdOrCtrl+,`); dev-only reload/devtools submenu; `menu:open-workspace` reaches renderer via preload subscription; settings opens a second `BrowserWindow` (singleton) with theme-relay IPC |
| Sidecar status surface | `backend:status` broadcast from main → renderer consumer shows sidecar state (starting/ready/restarting/dead) — app #1 broadcast had *no* consumer; this fixes the silent-death gap alongside the `backendError` banner |
| Library manifest | `docs/libraries.md` written; no dependency in any manifest that isn't in the doc |

## Non-goals

Any agent, chat, workspace, or UI feature — this epic is plumbing only.
