# User-defined tools — backend

## Goal

Let users write plain Python functions that become LLM tools (`user_<name>`),
discovered from `data_dir()/tools/*.py` (global) and
`<workspace>/.pydantic-chat/tools/*.py` (workspace-local, app-owned
namespace — no third-party convention exists for tool dirs — workspace
shadows global). In-process exec — user-authored code, no Monty (Monty is for
LLM-authored tools, see `pending-user_tools_monty-low-hard.md`).

Research: `docs/research/user-tools-harness-apis.md` (exact APIs),
`docs/research/user-tools-integration-map.md` (every seam + hidden complexities).
**Read both before implementing — they contain the verified API signatures.**

## Design

- **Tool source**: every top-level public `def`/`async def` (name not starting
  `_`) in a discovered `.py` file becomes a tool. Type hints → JSON schema,
  docstring → tool description (griffe handles it inside `FunctionToolset`).
  Module docstring → per-file catalog blurb.
- **Discovery must not exec user code**: catalog/listing parses files with
  `ast` for function names + docstrings. Exec only happens at run-build time
  inside `build_run_kwargs` (and in the tools test-invoke endpoint if one is
  added).
- **Loader**: compile+exec the module under a digest-keyed module name
  (harness `capability_creation/_validate.py` does exactly this — reuse
  `load_capability_instance`'s exec mechanics if it fits, else a small
  `importlib.util.spec_from_loader` loader). A file that raises at exec →
  skipped with a recorded error (never kills the run).
- **Naming**: `FunctionToolset(fns, id='user_tools').prefixed('user')` →
  `user_<func>` tool names. Prefix is load-bearing: avoids `UserError`
  collisions with Coder's `read_file`/`shell` and enables allowlist prefixes.
- **Approval**: `ApprovalRequiredToolset` wrap when
  `profile.approval_mode != "bypass"` — mirrors `build_mcp_capabilities`
  exactly (`app/mcp_servers.py:226-281`). Deferred requests flow through the
  existing approval cards free. Plain tools are INVISIBLE to `Permissions`
  — the wrap is mandatory.
- **Assembly seam**: `*build_user_tool_capabilities(...)` in
  `build_run_kwargs` right after the `build_mcp_capabilities` spread
  (`app/agent/factory.py:~449`). `ToolAllowlist` covers it automatically —
  `user_` prefix admitted via `tool_prefixes` or exact names via `tools`.
- **Resilience**: a failing file exec at run-build must degrade to a logged
  warning + skip, not a run crash (mirror `ResilientToolset`-style behavior
  or catch at loader level).

## Registry + API

- `user_tools` settings-KV row (mirror `mcp_servers`): list of specs
  `{key, name, origin, rel_path, enabled}` where `key` = `origin:rel_path`.
  `save_*/load_*/parse_*` triple; `_run_settings` flows it to
  `build_run_kwargs` with zero plumbing.
- `GET /api/user-tools` — discovered tools: `{key, name, origin, rel_path,
  enabled, functions: [{name, docstring}], error?, skipped_reason?}` —
  ast-parsed, no exec.
- `POST /api/user-tools` — `{origin, workspace_id?, filename, source?}`
  creates a file (template source if omitted). Global → `data_dir()/tools`;
  workspace → `<root>/.pydantic-chat/tools`.
- `PATCH /api/user-tools` — `{key, enabled}` toggle.
- `GET /api/user-tools/source?key=&workspace_id=` → `{source}`; 
  `PUT /api/user-tools/source` → `{key, workspace_id?, source}` — jailed
  writes: global under `data_dir()/tools`, workspace under the resolved
  tools dir (reuse `_resolve_workspace_file`-style lexical+resolved
  containment; add CREATE semantics — `PUT /api/files` can't create).
- `DELETE /api/user-tools?key=` removes the file + registry row.
- `GET /api/tool-catalog`: append `group="user"` entries — one per
  discovered ENABLED tool function, name `user_<func>`. Extend
  `ToolCatalogEntry.group` Literal in `schemas.py` with `"user"`.
- Name legality: `[a-z0-9_]` ≤64 chars (provider tool-name regexes — dots
  illegal). Skip+report functions violating it.

## Security notes

- `.pydantic-chat/tools` is writable by the
  agent's FileSystem tools — the model could rewrite its own tools (takes
  effect next run). Add `**/tools` to `PROTECTED_PATTERNS` in
  `app/api/files.py`? Consider — but note `.devin/skills` is unprotected
  today; either way, document the choice in the story.
  **Decision: NOT added.** `PROTECTED_PATTERNS` only governs the HTTP
  `/api/files` surface; the agent's `FileSystem` capability has its own
  pattern lists, so protecting the viewer wouldn't touch the actual threat
  (the model rewriting its tools mid-session). A bare `**/tools` glob would
  also blind the viewer to every ordinary `tools/` source dir in user
  projects — real collateral for no containment gain. The real control is
  `ApprovalRequiredToolset` gating under every non-bypass profile, which is
  implemented. Dedicated `/api/user-tools/source` routes handle tool-file
  edits with their own tighter jails (tool-dir-only shapes).
- Workspace tool files live under the workspace root so they inherit
  `_resolve_workspace_file` confinement for the API read/write path; global
  tools need their own lexical+resolved jail under `data_dir()/tools`.
- In-process exec runs with backend privileges outside the FileSystem jail —
  approval gating is the control; document in `UserToolSpec` docs.

## Tests (TDD)

- Discovery: global + workspace dirs, workspace-shadows-global precedence,
  skipped files (syntax error, non-public only, illegal names) reported.
- Loader: exec a temp file → `user_<fn>` tools callable through the
  toolset's `call_tool`, sync + async fns, docstring→description.
- `build_run_kwargs`: `user_` tools present in assembled toolset under
  bypass; `ApprovalRequiredToolset` wrap under manual (approval request
  emitted via existing deferred path — e2e through `POST /api/chat` if the
  harness's TestModel can drive a `user_` call); absent under `tools: []`.
- `ToolAllowlist`: profile `tool_prefixes=['user_']` admits; `tools: null`
  admits; explicit `tools` list without `user_*` excludes.
- API: registry CRUD round-trip, jailed-source write rejects `../` +
  symlink escapes, workspace_id required for workspace-origin ops, catalog
  shows `group="user"` entries only for enabled tools.
- `ruff check`/`format` clean; full `pytest -q` green.

## File references

- `docs/research/user-tools-harness-apis.md` — FunctionToolset/prefixed/
  ApprovalRequiredToolset exact signatures
- `docs/research/user-tools-integration-map.md` — every seam, catalog
  touchpoints, hidden complexities
- `app/agent/factory.py` — build_run_kwargs assembly point
- `app/mcp_servers.py` — registry + capabilities template
- `app/api/profiles.py` — `_CATALOG_GROUPS`, skills-dir precedent
- `app/api/files.py` — confinement + `PROTECTED_PATTERNS`

## What landed

- `app/user_tools.py` — `UserToolSpec` registry triple
  (`load_/save_/parse_user_tools`, `USER_TOOLS_KEY`), `WORKSPACE_TOOL_DIRS`
  = `('.pydantic-chat/tools',)`, discovery with
  workspace-shadows-global basename precedence, `ast`-only
  `parse_user_tool_file`, digest-keyed `sys.modules` exec loader
  (`load_user_tool_module` — own implementation; harness
  `load_capability_instance` requires an `AbstractCapability` subclass so it
  did not fit plain functions), and `build_user_tool_capabilities(specs,
  workspace_root, gate)` → one `Toolset(FunctionToolset(id='user_tools')
  .prefixed('user'))`, `ApprovalRequiredToolset`-wrapped when gating.
  Duplicate function names: first file in discovery precedence wins.
- `app/api/user_tools.py` — `GET/POST/PATCH /api/user-tools`,
  `GET/PUT /api/user-tools/source`, `DELETE /api/user-tools`.
- `app/api/schemas.py` — `UserToolSpec`/`UserToolPatch`/`UserToolCreate`/
  `UserToolOut` (+ `UserToolFunctionOut`, `SkippedUserToolFunctionOut`)/
  `UserToolSourceIn`/`UserToolSourceOut`; `ToolCatalogEntry.group` gained
  `"user"`.
- `app/agent/factory.py` — `*build_user_tool_capabilities(...)` spread right
  after the MCP spread (lazy import, `gate=approval_mode != "bypass"`).
- `app/api/profiles.py` — `GET /api/tool-catalog` appends `group="user"`
  entries (`user_<func>`, `prefix=False`) for enabled, non-shadowed,
  legally-named functions; workspace dirs scanned when `workspace_id` given.
- `app/main.py` — router registered behind the bearer auth.
- `packages/shared/src/index.ts` — `ToolGroup` union gained `'user'`.
- `tests/test_user_tools.py` — 37 tests; full suite 287 passed, ruff clean.

### Contract notes for the frontend agent

- `GET /api/user-tools` rows: `{key, name, origin, rel_path, enabled,
  docstring, functions[], skipped_functions[], error, skipped_reason}`.
  `skipped_functions` (additive vs. story spec) reports public defs with
  illegal tool names; `skipped_reason` covers shadowed / no-public-functions.
- `PATCH /api/user-tools` takes `{key, enabled}` on the collection route
  (keys contain `/` so no `{key}` path param) and returns
  `list[UserToolSpec]` (the registry, not the listing). Unknown-but-well-
  formed keys upsert a dormant flag row rather than 404ing.
- `POST /api/user-tools` returns the refreshed `list[UserToolOut]`; filename
  must match `^[a-z0-9_][a-z0-9_-]*\.py$`.
- `GET/PUT /api/user-tools/source` and `DELETE /api/user-tools` take `key`
  (+ `workspace_id` for `origin="workspace"` — 400 without it). Source
  writes are create-capable but jailed to `*.py` files directly inside a
  recognized tool dir (`global:x.py` or `workspace:<tooldir>/x.py`).
- `DELETE` is 204 when the file is gone but a registry row exists (prunes
  it); 404 only when neither exists.
- Workspace tool keys are workspace-agnostic: `workspace:.pydantic-chat/tools/x.py`
  is one flag applied in whichever workspace that rel-path exists (no
  per-workspace mask in v1).
