# Customizable tool profiles + skill store

## Goal

Profiles become data: each profile = {id, name, approval_mode, tool allowlist, skill allowlist}. Users create/edit custom profiles in Settings; the composer ProfilePicker lists builtin + custom. Builtin ids keep the legacy values (`bypass`/`smart`/`manual`/`read-only`) so `chats.permission_profile` needs no migration. Default for any profile: all tools + all skills.

## Acceptance criteria

Backend (per `docs/research/tool-profiles-and-skills.md` — read it first):

- `ToolProfile` pydantic model (§6) — `id, name, description, approval_mode('bypass'|'smart'|'manual'), workspace_read_only, tools(list|None), tool_prefixes(list), skills(list|None), builtin`.
- Custom profiles persisted as JSON list under `settings['tool_profiles']` (mirror `app/mcp_servers.py` load/save). Builtins are constants merged at read time; non-editable.
- Endpoints: `GET /api/tool-profiles` (builtin+custom), `POST`, `PUT /{id}`, `DELETE /{id}` (custom only, 403 on builtin); `GET /api/tool-catalog` (static tool list + enabled MCP `{name}_*` prefixes); `GET /api/skills` (SkillCatalog via `Skills(...).load()`).
- `build_run_kwargs`: `resolve_tool_profile(chat_settings)` → approval mode → `Permissions` map (`bypass→full, smart→auto+ApprovalReviewer, manual→read-only`); `workspace_read_only` → `LocalWorkspace(read_only=)`; `tools`/`tool_prefixes` → `ToolAllowlist` capability (`FilteredToolset` via `get_wrapper_toolset`, ALWAYS exempt `load_capability`); `skills` → `Skills` capability with `include=frozenset(skills)`, `missing_directories='skip'`, `unknown_names='skip'` (omit entirely when `skills == []` is false... i.e. `skills=None`→include all, `[]`→omit capability).
- Unknown profile id → warn + builtin `manual` (existing fallback).
- `ChatPatch`/`WorkspacePatch`/`SettingsPatch` `permission_profile` → plain `str` (id), keep null-inherit semantics.
- `pyproject.toml`: `pydantic-ai-harness[skills]` extra.
- Keep the `read-only` builtin building FileSystem standalone (option (a), §7) — lower-risk parity.

Skills store (v1):

- System-skill library at `data_dir()/skills/` — seeded from a bundled `apps/backend/skills/` template on first boot if missing; users drop `SKILL.md` dirs there.
- Workspace-local discovery: `.claude/skills`, `.agents/skills`, `.devin/skills` under workspace root (`missing_directories='skip'`).
- `GET /api/skills` returns both sources; UI shows origin (system vs workspace).

Frontend:

- `ProfilePicker` lists dynamic profiles (fetch `GET /api/tool-profiles`; builtin flag → lock icon etc.).
- `PermissionsSection` → fetch same endpoint for the global default picker.
- New `ToolProfilesSection` in settings: list profiles; editor = name, description, approval-mode select, tool checkboxes (from `GET /api/tool-catalog`, "All" default), MCP prefix checkboxes, skill checkboxes (from `GET /api/skills`, "All" default), duplicate/delete for custom; builtin rows read-only + "duplicate" affordance.
- `RunMetaBadge` maps profile id → display name.

## Tests

- Backend TDD: profile CRUD + builtin immutability, `resolve_tool_profile` unknown→manual, `ToolAllowlist` filters assembled toolset + always keeps `load_capability`, `skills=[]` omits Skills capability, `skills=[name]` includes subset, mid-chat profile PATCH changes next run's capabilities.
- Frontend: `bun run verify` green.

## File references

- `docs/research/tool-profiles-and-skills.md` — verified API details, tool catalog, pseudocode
- `apps/backend/app/agent/factory.py` — `build_run_kwargs`, `resolve_permission_capabilities`
- `apps/backend/app/mcp_servers.py` — load/save pattern + `build_mcp_capabilities(specs, gate=...)`
- `apps/backend/app/api/{settings,schemas}.py`, `db/schema.py`
- `apps/desktop/src/renderer/src/features/chat/ProfilePicker.tsx`, `features/settings/sections/`
