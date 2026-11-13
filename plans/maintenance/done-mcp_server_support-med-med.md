# MCP server support

## Goal

Users can register MCP servers (stdio command+args+env, or streamable-HTTP/SSE URL+headers) in Settings. pydantic-ai's native `MCPServer*` toolsets are constructed per run and merged into the agent's capability list, so MCP tools flow through the existing `Permissions` approval pipeline (manual/smart/bypass/read-only).

## Acceptance criteria

- Settings store a global list of MCP servers: `{name, transport: stdio|http, command?, args?, env?, url?, headers?, enabled}` — persisted server-side via the existing settings table (or a sibling mechanism consistent with `config.py`). Do NOT log headers/env values (may hold secrets).
- `GET/PUT/PATCH` endpoint(s) to list and mutate the server list; validate specs (stdio needs command; http needs url).
- `build_run_kwargs` in `agent/factory.py` constructs `MCPServerStdio` / `MCPServerStreamableHTTP` (verify exact class names against installed pydantic-ai 2.68.0 — do not trust memory; check `.venv` source) for each enabled server and appends them to the capability list.
- A failing/unreachable server must not break the run — log a warning and skip it (or follow pydantic-ai's own error semantics; document choice).
- MCP tool calls render in the existing tool card UI and are gated by permission profiles like any other tool — verify `Permissions` sees them (check how capabilities wrap toolsets).
- Settings window gets an "MCP Servers" section: list, add/edit/remove, enable toggle. Keep the form minimal (name + transport + fields).
- Backend pytest coverage (spec validation, enabled/disabled filtering, run-kwargs inclusion, failure isolation); `uv run pytest -q` + `ruff check` green; `bun run verify` green.

## File references

- `apps/backend/app/agent/factory.py` — `build_run_kwargs` capability assembly
- `apps/backend/app/config.py` — settings persistence
- `apps/backend/app/api/settings.py`, `schemas.py` — settings API pattern
- `apps/desktop/src/renderer/src/features/settings/` — section pattern (see `ModelSection.tsx`, `PermissionsSection.tsx`)
- `packages/shared/src/index.ts` — shared TS types
- Installed source: `apps/backend/.venv/lib/python3.12/site-packages/pydantic_ai/mcp.py` (or `toolsets/`)
