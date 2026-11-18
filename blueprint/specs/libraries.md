# Libraries — approved manifest for app #2

Every third-party dependency, the version to spec, and why it earns a place.
Decisions recorded 2026-11-18 with the owner. **⚠ = latest differs from the
version the owner stated, or was never explicitly approved — confirm before
locking.**

Use the target versions below and commit lockfiles; upgrades are deliberate.
JS pins are exact; Python uses the lockfile plus exact pins for the harness
pair (see Pinning policy). Record Bun/uv versions used by CI.

## Core (pre-approved by the owner)

| Package | Spec | Role |
|---|---|---|
| `ai` | `7.0.176` | Vercel AI SDK — `Chat`, transports, UIMessage/stream types. Wire: `sdk_version=7`. |
| `@ai-sdk/react` | `4.0.180` | React bindings (`useChat`). Must move with `ai`. |
| `pydantic-ai-slim` | `==2.70.0` extras `[openai,mcp]` | Agent runtime + VercelAIAdapter + providers. Lockstep with harness. ⚠ spec written against 0.68.0 — re-verify API at impl start. |
| `pydantic-ai-harness` | `==0.70.0` extras `[coder,skills]` | Coder/FileSystem/Shell/Planning/Permissions/Skills/StepPersistence. Hard-pins slim. ⚠ same re-verify note. **0.70.0 is also a security fix** — patches two HIGH ReDoS advisories in <0.70.0. |
| `electron` | `45.3.4` | Shell. `windowStatePersistence` built in (44+). |

`[anthropic]`/`[google]` extras are **excluded** — providers are OpenAI,
Ollama, openai-compatible, plus MCP. `[coder]` bundles the `rg` binary;
`[mcp]` pulls `fastmcp-slim`/`mcp`.

## Desktop runtime (approved)

| Package | Spec | Used for |
|---|---|---|
| `react` + `react-dom` | `19.3.1` | UI framework (required by `@ai-sdk/react`). |
| `zustand` | `5.1.0` | App/UI state stores. Streaming state stays inside AI SDK `Chat` objects — never in Zustand. |
| `streamdown` | `2.8.0` | Streaming-safe markdown (chat text parts + markdown preview). |
| `lucide-react` | `1.75.0` | Icons. |
| `react-resizable-panels` | `4.24.1` | Chat ↔ right-panel split; `useDefaultLayout` persists sizes. |
| `monaco-editor` | `0.57.0` | Text editor stack (owner's call — replaces app #1's CodeMirror). Includes `DiffEditor`. |
| `@monaco-editor/react` | `4.7.0` | React wrapper for Monaco. Must bundle monaco locally (`loader.config({ monaco })`) — CDN default breaks local-first. Quiet upstream (no stable since Feb 2025, only 4.8.0-rc pre-releases) — pin is fine, don't expect fixes. |

## Desktop toolchain (approved)

| Package | Spec | Used for |
|---|---|---|
| `electron-vite` | `6.0.0` | Build/dev for main+preload+renderer. Approved at 6.x (owner confirmed over original 5.x ask). |
| `vite` | `8.3.8` | Bundler (via electron-vite). Owner said 7–8 → fine. |
| `@vitejs/plugin-react` | `6.3.0` | React transform. Owner said ≥5 → fine. |
| `@vitejs/plugin-rsc` | `0.5.39` | Owner-specified (≥0.5.6 → fine). RSC in Electron is unusual — confirm it's actually needed during scaffold; drop if not. Just might be a subrequirement. |
| `typescript` | `7.0.2` | Strict TS, no `any`. |
| `tailwindcss` + `@tailwindcss/vite` | `4.3.5` | Styling; semantic theme tokens live in `styles/index.css`. |
| `electron-builder` | `26.18.1` | Packaging (dev-mode `--dir` in v1). Under `v26` dist-tag; `latest` tag lags at 26.18.0. |
| `vitest` | `5.1.1` | Unit + component tests; part of `bun run verify`. Pin exactly (app #1 floated `^`). |
| `jsdom` | `31.0.1` | DOM for component tests. |
| `@testing-library/react` + `@testing-library/dom` | `16.3.3` / `10.4.2` | Component tests. |
| Bun | latest | JS package manager + workspaces. Node stays on PATH for electron CLIs. |

## Backend (approved)

| Package | Spec | Used for |
|---|---|---|
| `fastapi` | `0.164.0` | HTTP API, request validation, free `/openapi.json`. |
| `uvicorn[standard]` | `0.54.0` | ASGI server spawned by Electron main (dev AND prod). |
| `httpx` | `0.28.1` | Async HTTP — provider model-catalog fetches (OpenAI `/v1/models`, Ollama `/api/tags`). |
| `pytest` + `pytest-asyncio` | `9.2.0` / `1.5.0` | Backend tests (`asyncio_mode=auto`). |
| `ruff` | `0.17.5` | Lint + format gate (`check` and `format --check` both run). |
| `pyrefly` | `1.4.1` | Type checker — **hard gate** in `bun run verify` (owner confirmed). |
| `uv` | latest | Python env/package manager. |
| `hatchling` | latest | Build backend for the uv project. |

## Pending external approval (tracked here for submission)

This table is the single tracking location for libraries that need
company-level approval before they can be used. Owner has approved writing
them into plans; manifests must not include them until approval lands.

| Package | Version | Proposed for | Status |
|---|---|---|---|
| `@base-ui/react` | `1.9.0` | Unstyled primitives (popover/menu/dialog/combobox) replacing ~1,300 lines of hand-rolled pickers + their a11y bugs. **Renamed org** — was `@base-ui-components/react` pre-1.0; imports use the new name. | ⏳ pending company approval |

## Deliberately excluded

- **shadcn AI Elements** — in app #1's vision doc but never implemented; owner rejected.
- **CodeMirror 6 stack** (7 packages) — replaced by Monaco decision.
- **Diff library** — Monaco's built-in `DiffEditor` replaces `diff.ts` (~324 lines) and `@codemirror/merge`.
- **ORM (SQLAlchemy/SQLModel)** — stdlib `sqlite3` stays; the store is ~900 lines total.
- **`sse-starlette`** — the adapter owns SSE framing; never imported directly in app #1.

## Rides along (no decision needed)

`starlette`/`anyio`/`pydantic` (FastAPI + pydantic-ai), provider SDKs
`openai` (OpenAI + Ollama + openai-compatible all ride it), `fastmcp-slim`/`mcp`
(`[mcp]` extra), `genai-prices` (usage→cost inside pydantic-ai), `ripgrep`
(`[coder]` extra binary).

## Hand-rolled, kept deliberately

- `lib/api.ts` fetch wrapper (~40 lines) — bearer + error mapping.
- `app/db/` sqlite layer (~900 lines) — implements `ConversationStore` + app tables.
- Permission-restricted `secrets.json` for provider/MCP credentials; non-secret config/defaults/profiles live in sqlite KV.
- Popovers/pickers — **only if base-ui is rejected**; otherwise migrate.
- Monaco ↔ app glue (editor wrapper, language map) — thin by design.

## Pinning policy

- JS: exact versions in `package.json` (no `^`), lockfile is `bun.lock`.
- Python: pin `pydantic-ai-slim`/`pydantic-ai-harness` exactly (lockstep);
  the rest float within `uv.lock` and are bumped deliberately.
- Version-coupled sets — bump together and smoke-test the wire:
  `ai` + `@ai-sdk/react` + backend `SDK_VERSION`; `pydantic-ai-slim` +
  `pydantic-ai-harness`; `monaco-editor` + `@monaco-editor/react`;
  `vite` + `electron-vite` + `@vitejs/plugin-react`.
- `rg` is a runtime dep of the file API (gitignore-aware tree) — supplied by
  `[coder]`. Any traversal fallback must preserve P2-file-viewer's filtering
  and confinement rules; never return an unfiltered tree.
