# User-Defined Tools — integration map

Verified against `pydantic-ai-slim==2.68.0` + `pydantic-ai-harness==0.68.0` (uv cache: `/media/adam/extex/cache/uv_cache/archive-v0/zjjBt4D0AP1Bq0xyUekvF/pydantic_ai_harness/`).

## TL;DR — the seams

- **Run-time seam:** `build_run_kwargs` (`app/agent/factory.py:431-482`) assembles the capability list. A user-tools capability drops in beside `build_mcp_capabilities(...)` — either as `Toolset(FunctionToolset)` or as loaded `AbstractCapability` instances. The harness already ships the entire dynamic-code pipeline: `pydantic_ai_harness.capability_creation` (`CapabilityStore`, `load_capability_instance`, `validate_capability_file`) loads `<name>.py` files into capability instances with a `manifest.json` index.
- **Approval seam:** `Permissions` will NOT gate plain user tools (it only checks `tool_kind in _WRITE_KINDS` and `code_arg_language='shell'`). Wrap in `ApprovalRequiredToolset` exactly like MCP (`app/mcp_servers.py:276-281`, `factory.py:441-449`). Deferred requests flow into the existing `ApprovalCard` UI for free.
- **Filter seam:** `ToolAllowlist` (`factory.py:285-314`) supports exact names + `startswith` prefixes. Use `user_<name>` or a `user_<module>_` prefix — **dots in `user_<module>.<func>` are illegal** under provider tool-name regexes.
- **Catalog seam:** `_CATALOG_GROUPS` (`app/api/profiles.py:55-72`) + `ToolCatalogEntry.group` Literal (`app/api/schemas.py:255`) + TS `ToolGroup` union (`packages/shared/src/index.ts:276`) + `TOOL_GROUP_ORDER`/`TOOL_GROUP_LABELS` (`ToolProfilesSection.tsx:61`, `lib/profiles.ts:53-58`) — a `"user"` group needs touching all four; the checkbox UI then renders it automatically.
- **Storage seam:** one JSON settings-KV row, mirroring `mcp_servers`/`tool_profiles` — `load_*/save_*/parse_*` triple in `app/mcp_servers.py:53-120` is the template. Reaches run time via `_run_settings` (`app/api/chat.py:520-536`) with **zero plumbing** — all settings keys flow into `chat_settings`, and `build_run_kwargs` reads them with `_setting(...)` (same as `mcp_servers` at `factory.py:443`).
- **CRUD seam:** `PUT /api/settings/{key}` rejects unknown keys (`app/api/settings.py:80-88`); registry mutations need a dedicated router modeled on `app/api/mcp.py` (GET/POST/PATCH/DELETE over a KV row).

## 1. Tool catalog — `app/api/profiles.py`

`GET /api/tool-catalog` (`profiles.py:171-210`) builds `ToolCatalogEntry` rows from:

- `_CATALOG_GROUPS` (`profiles.py:55-72`) — static `(group, names)` tuple: `filesystem` (5 FileSystem tools), `shell`, `planning` (6 Planning tools). `load_capability` is deliberately unlisted (docstring lines 9-13).
- `_TOOL_DESCRIPTIONS` (`profiles.py:74-87`) — every name must have an entry or `.description` KeyErrors.
- MCP rows (`profiles.py:191-209`): `load_mcp_servers` → optional `apply_mcp_mask` when `workspace_id` is passed → one `{name}_*` entry per *enabled* server, `group="mcp"`, `prefix=True`.

**Where "user" slots in:** either exact-name rows (`group="user"`, `prefix=False` → profile `tools`) or one `user_*` prefix row (`prefix=True` → `tool_prefixes`). Dynamic names mean the route must read the user-tools registry (and workspace dirs when `workspace_id` is passed — the mask/`workspace_id` contract already exists). **Do not import user code at catalog time** — read names from a manifest/registry instead (see hidden complexities).

Required type changes: `ToolCatalogEntry.group` Literal (`app/api/schemas.py:245-256`), TS `ToolGroup` (`packages/shared/src/index.ts:275-291`).

## 2. Tool filtering — `ToolAllowlist` (`app/agent/factory.py:285-314`)

```python
def keep(ctx, tool_def) -> bool:
    return (tool_def.name == "load_capability"
            or tool_def.name in allowed
            or any(tool_def.name.startswith(prefix) for prefix in prefixes))
```

- `FilteredToolset` wraps the *combined* toolset once per run via `get_wrapper_toolset` — covers Coder, Planning, MCP, and any new user toolset uniformly.
- Added in `build_run_kwargs` at `factory.py:462-478`, only when `profile.tools is not None or profile.tool_prefixes`. Prefixes strip a trailing `*`; a bare `*` strips to `''` and is dropped (never admits everything).
- `user_<name>` exact names filter via `tools`. `user_<module>.<func>` does **not** work: provider tool-name regexes (Anthropic `^[a-zA-Z0-9_-]{1,64}$`) reject dots. Use `user_<module>_<func>` or flat `user_<func>`; alternatively admit the whole group with a `user_` prefix.
- `tools: null` + `tool_prefixes: []` is the unfiltered state → user tools are auto-admitted there; profiles saved with explicit lists exclude unknown names silently (frontend `encodeToolSelection`/`checkedFromProfile`, `lib/profiles.ts:93-171`, drops names absent from the catalog on the next save — a deleted user tool disappears from saved profiles the same way a deleted MCP server does).
- `load_capability` exemption (`factory.py:309`) is already in place — relevant if user tools are exposed as *deferred* capabilities (see §8).

## 3. Approval flow

- `Permissions._asks` (harness `permissions/_capability.py:242-264`) only checks `tool_def.tool_kind in _WRITE_KINDS` (write_file/edit_file/create_directory, name-independent) and `metadata['code_arg_language'] == 'shell'`. A plain `FunctionToolset` tool is invisible to it — **unwrapped user tools run unapproved under every profile**.
- Established wrap: `build_mcp_capabilities` (`app/mcp_servers.py:226-281`) → `ApprovalRequiredToolset(toolset)` when `gate = profile.approval_mode != "bypass"` (built in `factory.py:441-449`). Reuse verbatim: `wrapped = ApprovalRequiredToolset(user_toolset) if gate else user_toolset`.
- Approval joins `DeferredToolRequests` (already in the shared agent's `output_type`, `factory.py:347-361`) → `tool-approval-request` SSE chunks → generic `ApprovalGroup`/`ApprovalRow` (`ApprovalCard.tsx:93-255` renders any tool name + JSON arg dump; `ApprovalRow` shows `requestReason`). Under `smart`, `ApprovalReviewer` (`tools='all'` by default, `factory.py:343`) judges user calls too. `output-denied`/`approval-responded`/`output-error` states render via generic `ToolCard` (`ToolCard.tsx:36-114` — unknown tools get a wrench icon + JSON). Resume of parked approvals works via `deferred_tool_requests` on the `ConversationRecord` (`app/api/resume.py:53-160`) — free.
- One gap worth noting: if user tools take a `code` arg, marking it `code_arg_language='python'` does NOT trigger `Permissions` (only `'shell'` does) — `ApprovalRequiredToolset` remains required regardless.

## 4. Skills — the discovery precedent (`app/profiles.py`)

- System library: `system_skills_dir()` = `data_dir()/skills` (`profiles.py:241-243`), seeded once from bundled `apps/backend/skills/` by `ensure_system_skills()` (`246-266`) — called at app lifespan (`app/main.py:44`) and lazily at resolve.
- Workspace dirs: `WORKSPACE_SKILL_DIRS = ('.claude/skills', '.agents/skills', '.devin/skills')` (`profiles.py:233-238`), read from the run workspace.
- Capability builders: `system_skills(include)` (`269-285`) reads via its own `LocalWorkspaceBackend` (library is outside the run workspace); `workspace_skills(include)` (`288-301`) reads relative dirs in the run workspace. Both use `missing_directories='skip'`, `duplicate_names='keep_first'`, `unknown_names='skip'`.
- Composition: `_skills_capabilities` (`factory.py:233-244`) puts workspace **first** so project shadows system; `skills=[]` omits the capability; `None` = all; names → `include=frozenset`.
- Editor catalog: `GET /api/skills` (`api/profiles.py:213-253`) calls `.load()` outside a run, tags `origin="system"|"workspace"`, reports `skipped`.

**User-tools mirror:** `data_dir()/tools` (global, seeded or empty) + `WORKSPACE_TOOL_DIRS` (e.g. `('.devin/tools', '.agents/tools', '.claude/tools')`), workspace-first precedence, `GET /api/user-tools`-style catalog endpoint reporting `origin` + skipped entries with reasons.

## 5. Storage (`app/db/`)

- `settings` KV table (`app/db/schema.py:56-59`); registries persist as **one JSON row**, rewritten atomically: `tool_profiles` (`app/profiles.py:133-156`) and `mcp_servers` (`app/mcp_servers.py:53-85`) are the two templates — `TypeAdapter(list[Spec])`, `parse_*` skips malformed entries with warnings, `save_*` deletes the row when empty.
- A `user_tools` row needs a `UserToolSpec` BaseModel: `name`, `enabled: bool`, `source` (file path vs inline `code`), mirroring `MCPServerSpec` (`app/api/schemas.py:306-335`, `extra="forbid"`, name pattern `^[^/]+$`).
- Migrations: `MIGRATIONS` tuple appended only, tracked by `PRAGMA user_version` (`app/db/schema.py:14-80`). A settings-KV row needs **no migration**; a per-workspace enable mask would (new `workspaces.user_tool_overrides` column + `Workspace.mcp_overrides`-style decode + `WorkspacePatch` field + `_run_settings` merge at `chat.py:531-532` — all four spots shown by the `mcp_overrides` precedent).
- Zero-plumbing run-time delivery: `_run_settings` (`chat.py:520-536`) dumps *all* settings keys into `chat_settings`; `build_run_kwargs` reads `_setting(chat_settings, "user_tools")` exactly as it does `mcp_servers` (`factory.py:443`).

## 6. Frontend surfaces

- `ToolProfilesSection.tsx`: catalog+skills fetched at `111-128`; group render order `TOOL_GROUP_ORDER` (`:61`, `['filesystem','shell','planning']` — note `mcp` is deliberately absent, rendered as its own prefix section at `545-574`); groups loop `399-402`; checkbox grid `513-543`; `TOOL_GROUP_LABELS` in `lib/profiles.ts:53-58`. A `"user"` group renders automatically once added to the order + labels + backend `group` Literal.
- New registry section: `McpServersSection.tsx` is the CRUD template (immediate writes, not AppSettings draft); register in `features/settings/registry.ts:28-75` (id, title, `keywords` for search, component). Store pattern: `stores/profiles.ts` (refetch-after-write, `ensureLoaded` dedupe).
- Per-workspace enable UI: `WorkspaceMcpPicker.tsx` — mask semantics (entry replaces global flag; equal-to-global drops the entry; emptied mask → `null`) is directly reusable.
- Editor: `FileViewer.tsx` is already fully writable CodeMirror 6 (PUT `/api/files` with `if_match` sha256 conflict guard, 409 conflict banner + diff); `.py` gets Python highlighting (`files.py:77` suffix map; `FileExplorer.tsx:80` icon). Two catches:
  - `/api/files` is workspace-confined — **global tools in `data_dir()/tools` are unreachable** by it (see §7).
  - `/api/files/tree` hides dotdirs: `rg --files` skips hidden files and `_walk_files` skips `name.startswith('.')` (`files.py:455-471`) — `.devin/tools/*.py` won't appear in FileExplorer. They ARE readable/writable by explicit path (`_resolve_workspace_file` doesn't block dotfiles), so a tools UI can `GET`/`PUT` them by path, but needs its own list (or a show-hidden toggle).
- A dedicated "Tools" settings section is the cleaner call: the profiles UI is a *picker over a catalog*, while tool CRUD (name/enabled/source editing) is a registry like MCP servers — reusing `McpServersSection`'s form pattern, with `.py` source edits routed to `FileViewer` (workspace-local) or a textarea/`PUT` endpoint (global).

## 7. Workspace confinement — `_resolve_workspace_file` (`app/api/files.py:257-288`)

```python
lexical = Path(os.path.normpath(root / raw))
resolved = lexical.resolve()
for candidate in (lexical, resolved):
    if not candidate.is_relative_to(root): 403
    if first_matching_pattern(rel, PROTECTED_PATTERNS): 403
```

- Guards: `_require_workspace` 404 (`514-521`), `_existing_root` resolves + `is_dir` 404 (`524-532`), `PROTECTED_PATTERNS` (`56-64`: `.git`, `.env*`, `*.pem`, `*.key`, `secrets*`, `.pydantic-ai-harness/**`) checked on both lexical and resolved spellings.
- Write (`_write_file_bytes`, `361-425`): existing regular file only (**404 on missing — PUT cannot create files**), NUL rejected, 2 MB cap, `if_match` sha256 → 409, temp-file + `os.replace` atomic write preserving mode.
- A workspace-local tools API (`<root>/.devin/tools/*.py`) must replicate this confinement and add create semantics; also decide whether `**/tools` belongs in `PROTECTED_PATTERNS` — today there's a precedent for hiding agent-internal dirs (`.pydantic-ai-harness`), and **the agent's own FileSystem tools can read/write `.devin/tools` unprotected**, meaning the model could rewrite its own tool code.
- Global tool sources (`data_dir()/tools`) sit outside every workspace → never route through `_resolve_workspace_file`; use a dedicated endpoint jailed to that dir (same lexical+resolved double check), or store source inline in the `user_tools` registry and sidestep the file API entirely.

## 8. How the model sees tools

- Always-visible tools are advertised **by schema only**. Capability `get_instructions` add prompt text; `Coder`'s static guidance names `read_file`/`write_file` (harness `coder/_instructions.py:10-56`) and is NOT pruned by `ToolAllowlist` — the model can be told about tools it can't call (a filtered name resolves as unknown → `ModelRetry`). A user-tools capability can add one instruction line itself via `get_instructions`.
- On-demand discovery exists via deferred capabilities: `defer_loading=True` + `id`/`description` surfaces the capability in the `load_capability` tool's catalog (harness `skills/_capability.py:49-63` for `_Skill`; core `toolsets/_deferred_capability_loader.py`, `_capability_owned.py`). User tools could defer-load (cheaper prompt, model must call `load_capability` first) — `ToolAllowlist` already always keeps `load_capability`.
- `run_meta_hooks` (`factory.py:481` → `events.py:140-151`) emits `data-run-meta` for the UI badge only — not model-facing.

## Hidden complexities found

1. **`capability_creation` already solves the hard part.** Harness `capability_creation/_store.py` (`CapabilityStore`: `<name>.py` files + `manifest.json` index, atomic writes, `load_active()` for per-run injection) + `_validate.py` (`load_capability_instance`/`validate_capability_source`: compile/exec with digest-keyed `sys.modules` names, `BaseException`→`CapabilityValidationError`, static-getter type checks). If a user "tool" is packaged as an `AbstractCapability` whose `get_toolset()` returns a `FunctionToolset`, this entire pipeline is reusable — including `CapabilityCreation` itself, which would let the *agent* author tools (`author_capability`) — note its `_check_workspace` operator-authority requirement (`_capability.py:124-143`), the existing threat model for executing model/user code in-process.
2. **Import side effects are unavoidable at run build.** Loading a `.py` tool file executes module-level code with backend-process privileges, outside the FileSystem jail — importing at *catalog* time (for the picker) would run user code on every settings-page load; keep a manifest/registry of names instead (the harness store does exactly this).
3. **`PUT /api/files` cannot create files** (404 on missing, `files.py:379-384`) — a tools editor needs a create-capable write path or a dedicated route.
4. **The file tree hides `.devin/`** — tools UI must list tool files itself.
5. **Fail-open vs fail-closed profiles:** `tools: null` profiles auto-admit newly added user tools; explicit-list profiles exclude them and drop unknown names on next save — same semantics as MCP, but worth surfacing in the UI since user tools churn more than MCP servers.
6. **Tool-name legality:** stick to `[a-z0-9_]` and ≤64 chars (harness `_NAME_RE` in `_store.py:39` enforces exactly this for capability names).
7. **`sys.modules` accumulation:** every re-load of edited source creates a new module (digest-keyed, `_validate.py:97-141`) — harmless but permanent per process; fine for an app's run cadence.
8. No `apps/backend/.venv` is present in-tree; harness source inspected at the uv-cache copy of the pinned `0.68.0`.

## Suggested assembly (summary of seams)

- New `app/user_tools.py`: `UserToolSpec` model + `USER_TOOLS_KEY` KV persistence + `WORKSPACE_TOOL_DIRS` + a loader producing `AbstractCapability`s/`FunctionToolset` (reuse `load_capability_instance` where possible).
- `build_run_kwargs` (`factory.py`): append `*build_user_tool_capabilities(specs, workspace_root=root, gate=profile.approval_mode != "bypass")` next to `build_mcp_capabilities` — `ApprovalRequiredToolset` wrap, optional `ResilientToolset`-style warn-and-skip on import failure.
- `GET /api/tool-catalog`: append `group="user"` entries from the registry (+ workspace tool names when `workspace_id` passed); extend the group Literals on both sides + `TOOL_GROUP_ORDER`/`TOOL_GROUP_LABELS`.
- New `/api/user-tools` router (mirror `app/api/mcp.py`) + `UserToolsSection` in `registry.ts` + shared `UserTool` type in `packages/shared`.
