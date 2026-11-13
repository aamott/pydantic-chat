# Tool Profiles & Skills — implementation research

Verified against installed source: `pydantic-ai-slim==2.68.0` + `pydantic-ai-harness==0.68.0`
(`apps/backend/.venv/lib/python3.12/site-packages/pydantic_ai/`, `pydantic_ai_harness/`).

## TL;DR

- `pydantic_ai_harness.skills.Skills` already implements Agent-Skills progressive disclosure (SKILL.md libraries → deferred `load_capability` capabilities). No custom loader needed.
- `pydantic_ai.toolsets.FilteredToolset` exists. The cleanest profile-tool-subset mechanism is a tiny `AbstractCapability` subclass implementing `get_wrapper_toolset()` → `FilteredToolset(assembled, allowlist)` — one wrap point covers Coder, Planning, and MCP toolsets uniformly. Must exempt `load_capability`.
- `Permissions`/`ApprovalRequiredToolset`/`ApprovalReviewer` all key off `tool_def.tool_kind`/metadata, not tool name — filtering tools out does not break approvals for the remainder.
- `permission_profile` strings can migrate zero-cost if builtin profile ids equal the legacy values (`bypass`, `smart`, `manual`, `read-only`); custom profiles go in a `tool_profiles` settings-KV JSON list, mirroring `mcp_servers`.

## 1. Verified tool catalog

### `Coder` (`pydantic_ai_harness/coder/_capability.py`)
`Coder` is a `CombinedCapability` (line 133). Constructor `__init__(workspace=None, *, instructions, unrestricted_filesystem=False, repo_context=True, sub_agents=True, agent_folders=None, task_control=None, caching=True, strict=False)` (lines 172–184). Children (lines 207–262): `RequireWorkspace`, `Capability(id='coder_instructions')` (instructions), `FileSystem`, `Shell`, optional `RepoContext`, optional `SubAgents`, `ClearToolResults`, `ToolOutputLimits`, `RepairToolArguments`, `_ReportExhaustedRetries`, `_DefaultCaching`, `_SetToolStrict`.

| Tool | Source | Notes |
|---|---|---|
| `read_file` | `FileSystem(tools=FILE_TOOL_NAMES)` | read windowed file |
| `write_file` | FileSystem | create/overwrite |
| `edit_file` | FileSystem | replacement-based edit |
| `list_files` | FileSystem | ripgrep-backed listing (respects .gitignore) |
| `grep` | FileSystem | ripgrep-backed content search |
| `shell` | `Shell(tools=['shell'])` | persistent shell; commands return log/status file handles; `default_timeout=MAX_FOREGROUND_WAIT`, `allow_interactive=True`, `denied_commands=[]` |
| `delegate_task` | `SubAgents` | only with `sub_agents=True` — **app uses `sub_agents=False`** |

`FILE_TOOL_NAMES = ('read_file', 'write_file', 'edit_file', 'list_files', 'grep')` — `coder/_capability.py:28`.

### `FileSystem` (`pydantic_ai_harness/filesystem/_capability.py:34`, `filesystem/_toolset.py`)
Full surface `FILE_SYSTEM_TOOL_NAMES` (10): `read_file, write_file, edit_file, list_directory, search_files, find_files, create_directory, file_info` (`DEFAULT_TOOL_NAMES`, `_toolset.py:75`) + `list_files, grep` (`RIPGREP_TOOL_NAMES`, `_toolset.py:87`).
`READ_ONLY_TOOL_NAMES = {read_file, list_directory, search_files, find_files, file_info, list_files, grep}` (`_toolset.py:118`).
Constructor-gating fields already exist: `tools: Sequence[str] = DEFAULT_TOOL_NAMES` (`_capability.py:128`), `read_only: bool` (`_capability.py:114` — wraps toolset in `FilteredToolset(..., tool.name in READ_ONLY_TOOL_NAMES)` at `_capability.py:181-186`), plus `root_dir`, `allowed_patterns`, `denied_patterns`, `read_only_patterns`, `max_retries`.

### `Shell` (`pydantic_ai_harness/shell/_capability.py:55`, `shell/_toolset.py`)
`RUN_SCOPED_TOOL_NAMES = ('run_command','start_command','check_command','stop_command')`, `PERSISTENT_TOOL_NAME = 'shell'`, `SHELL_TOOL_NAMES` = both (`_toolset.py:38-44`). Constructor gating: `tools` (`_capability.py:132`), `allowed_commands`, `denied_commands` (default blocks rm/dd/shutdown/etc.), `denied_operators`, `persist_cwd`, `allow_interactive`, `env`, `denied_env_patterns`.

### `Planning` (`pydantic_ai_harness/planning/_capability.py:63`)
Tools: `write_plan, read_plan, add_task, update_task_status, update_task_statuses, remove_task`; plus `add_subtask, set_dependency, get_available_tasks` when `enable_subtasks=True` (app does not enable). Constructor gating: `tools: Sequence[str] | None` allowlist (`_capability.py:120`), `store`/`store_resolver`, `enable_subtasks`, `inject`, `guidance`. App binds `SqlitePlanStore(data_dir()/"plans.db", session=chat_id)` (`factory.py:376-383`).

### `RepoContext` (`pydantic_ai_harness/repo_context/_capability.py:77`)
Instructions-only by default; optional `inventory_agent_context` tool via `expose_inventory_tool=True` (`_capability.py:155`). App never enables it (uses `RepoContext(walk_up='repo_root')` in read-only profile; bundled inside Coder otherwise).

### `LocalWorkspace` (`pydantic_ai/capabilities/local_workspace.py:24`)
`LocalWorkspace(working_dir, *, read_only=False, authority='operator', path_authority=None, env=None, id='local_workspace')`. `read_only=True` wraps backend in `ReadOnlyWorkspace`. Supplies `get_workspace` only — no tools.

### Framework tools
`load_capability` (tool kind `capability-load`, `pydantic_ai/_deferred_capabilities.py:59-71`) is registered automatically when deferred capabilities exist. Skills are loaded through it — **the profile allowlist must always permit it** (or `prepare_tools`-style filtering would break skill loading).

### MCP tools (`app/mcp_servers.py`)
`MCPToolset(transport, id=spec.name).prefixed(spec.name)` → tool names are `{server_name}_{tool}` (`PrefixedToolset`, `pydantic_ai/toolsets/prefixed.py:32`). `FilteredToolset` sees the prefixed names in `tool_def.name` exactly like any other tool. Wrap order: `ResilientToolset(ApprovalRequiredToolset?(PrefixedToolset(MCPToolset)))` inside `pydantic_ai.capabilities.Toolset` (`mcp_servers.py:222-229`).

## 2. Filtering mechanism — verified

- `FilteredToolset(WrapperToolset)` — `pydantic_ai/toolsets/filtered.py:14`:
  `filter_func: Callable[[RunContext, ToolDefinition], bool | Awaitable[bool]]` applied in `get_tools`. Filtered-out names resolve as unknown → `ModelRetry` if the model guesses them.
- Wrap points (pick one):
  1. **`get_wrapper_toolset` on a capability** — `AbstractCapability.get_wrapper_toolset(toolset)` (`pydantic_ai/capabilities/abstract.py:762`): "called per-run with the combined non-output toolset (after `prepare_tools`)". One small capability filters the *entire* assembled toolset (Coder + Planning + MCP) — recommended.
  2. **`WrapperCapability(wrapped=cap)` subclass overriding `get_toolset`** → `FilteredToolset(inner)` (`capabilities/wrapper.py:305`); adopts wrapped id/defer_loading.
  3. **`visit_and_replace` + `dataclasses.replace(cap, tools=[...])`** — native `tools=` gating on `FileSystem`/`Shell`/`Planning`; already the app's pattern for allow/deny lists (`factory.py:141-165`). Doesn't cover MCP.

Recipe sketch (option 1):

```python
@dataclass
class ToolAllowlist(AbstractCapability[AgentDepsT]):
    allowed: frozenset[str]          # exact names; None means "all"
    prefixes: frozenset[str] = ()    # e.g. frozenset({'fs-tools_'}) to allow a whole MCP server

    def get_wrapper_toolset(self, toolset):
        allowed, prefixes = self.allowed, self.prefixes
        def keep(ctx, td):
            return (
                td.name == 'load_capability'
                or td.name in allowed
                or any(td.name.startswith(p) for p in prefixes)
            )
        return FilteredToolset(toolset, keep)
```

## 3. Approval interplay — verified

- `Permissions(mode)` (`pydantic_ai_harness/permissions/_capability.py:137`): modes `'full' | 'auto' | 'read-only'`. Decides via `before_tool_execute` → `_asks` (line 242): file writes detected by `tool_def.tool_kind in _WRITE_KINDS` (`write_file`/`edit_file`/`create_directory` kinds — line 52, imports at line 26); commands detected by `tool_def.metadata['code_arg_language']=='shell'` + `code_arg_name` (line 267-274). `'auto'` asks only for commands matching `ask_commands` regexes (`DEFAULT_ASK_COMMANDS`, line 39). **No tool-name dependence** — a filtered-out tool simply can't be called; remaining tools keep full approval behavior.
- MCP: `Permissions` never fires on MCP tools (no write kind/shell metadata) — the app wraps them in `ApprovalRequiredToolset` for every non-`bypass` profile (`mcp_servers.py:222-224`). Keep `gate = approval_mode != 'bypass'`.
- `ApprovalReviewer(model, *, question, tools='all', ...)` (`approval_reviewer/_capability.py:69`): a `HandleDeferredToolCalls` handler approving calls whose question answers `no`. `tools` is a `ToolSelector` (`'all'`/name list/metadata/predicate) — scoped per tool name if needed.
- The shared agent's `output_type=[str, DeferredToolRequests]` (`factory.py:260-274`) already supports the deferred flow regardless of which tools a profile exposes.

## 4. Skills — verdict: `pydantic_ai_harness.skills.Skills` exists

`pydantic_ai_harness/skills/_capability.py:67` — `Skills(directories, *, include=None, exclude=None, missing_directories='error'|'skip', duplicate_names='error'|'keep_first', unknown_names='error'|'skip', workspace: WorkspaceBackend|None=None, scanner: ArtifactScanner|None=None)`.

- **Discovery**: each immediate child of each library dir containing `SKILL.md` (`_loader.py:_discover_skills` line 282). Frontmatter parsed by `_SkillFrontmatter` (`_loader.py:51`): `description` required, `name` optional (defaults to dir name, must match it), `disable-model-invocation`, `user-invocable`. Names: ≤64 lowercase unicode/hyphens (`_validate_name`, line 363).
- **Injection**: one `_Skill` deferred capability per skill — `id=skill.name`, `defer_loading=True`, instructions = `skill.render()` (`_capability.py:49-63`). Model sees name+description in the deferred catalog, calls `load_capability` → gets `# Skill: {name}` + `Skill directory: …` (only when `in_run_workspace`) + body. Bundled `scripts/`/`references/` are *not* auto-loaded — model reaches them via file tools only when `in_run_workspace=True`.
- **Subset selection**: `include=frozenset(names)` — exact match to a profile's `skills` list. Use `unknown_names='skip'` (tolerates profiles naming removed skills) and `missing_directories='skip'`.
- **Out-of-workspace libraries**: `workspace=LocalWorkspaceBackend(path)` reads the library from anywhere (`_capability.py:107`, `secondary_workspace`); sets `in_run_workspace=False` → `render()` omits the directory line, so bundled files are effectively unreachable (limitation — fine for instruction-only "system skills").
- **Browser API support**: `await skills.load(workspace=None) -> SkillCatalog` (`_capability.py:322`) returns `.skills: tuple[SkillDefinition]` (name, description, body, path, `model_invocable`, `user_invocable`) and `.skipped: tuple[SkippedSkill]` — exactly what a `GET /api/skills` endpoint needs. `load()` needs no arg when all sources carry `workspace=`.
- **Combining**: two `Skills` instances merge (`combine`, `_capability.py:280`) — so one `Skills(workspace=app_dir)` for system skills + one `Skills(directories=['.claude/skills','.agents/skills'], missing_directories='skip')` for workspace-local skills works.
- **Dependency**: loader needs PyYAML (`_loader.py:21-26`, suggests `pydantic-ai-harness[skills]`). PyYAML 6.0.3 is in `uv.lock` via `uvicorn[standard]` — works today, but declare the extra explicitly in `apps/backend/pyproject.toml`.

## 5. Current app wiring (what changes)

`factory.py`:
- `PermissionProfile = Literal["bypass","smart","manual","read-only"]` (line 59) → becomes profile-id `str`.
- `resolve_permission_capabilities` (line 173): bypass→`[Coder, Permissions('full')]`; smart→`[Coder, Permissions('auto'), ApprovalReviewer]`; manual→`[Coder, Permissions('read-only')]`; read-only→`[FileSystem(read_only,tools=FILE_TOOL_NAMES), RepoContext, Permissions('read-only')]` (no Coder, no shell).
- `build_run_kwargs` (line 285): capabilities = `LocalWorkspace(root, read_only=profile=='read-only')` + permission caps + MCP caps (`gate=profile!='bypass'`) + `Planning(SqlitePlanStore)` + `run_meta_hooks(profile, model)`; kwargs add `instructions=FILE_LINK_INSTRUCTIONS`, `workspace=LocalWorkspaceBackend(root)`, `usage_limits`, `model_settings`.
- `build_run_kwargs` is sync — profiles must be resolvable from the `chat_settings` mapping, which already contains all decoded settings rows. `_run_settings` (`api/chat.py:500-526`) merges settings KV (JSON-decoded) + chat/workspace overrides — a `tool_profiles` JSON row lands in `settings` automatically.

Storage today: `settings` KV table; `chats.permission_profile`/`workspaces.permission_profile` TEXT columns (migrations 2,3 in `db/schema.py:62-72`); validation points: `schemas.py` `ChatPatch.permission_profile: PermissionProfile|None` (line 121), `WorkspacePatch` (line 96), `settings.py:274` (`_apply_setting` vs `PERMISSION_PROFILES = get_args(PermissionProfile)`, line 57).

Frontend: `ProfilePicker.tsx` hardcodes `PROFILES` (lines 19-40) + inherit chain global→workspace→chat; `PermissionsSection.tsx` hardcodes radio list (lines 18-43); `stores/models.ts` `globalProfile` from `GET /api/settings`; `RunMetaBadge` shows raw string from `data-run-meta`.

## 6. Proposed profile schema + storage

```python
class ToolProfile(BaseModel):
    id: str                     # 'bypass'|'smart'|'manual'|'read-only' for builtins; slug/uuid for custom
    name: str
    description: str = ''
    approval_mode: Literal['bypass','smart','manual']   # -> Permissions('full'|'auto'|'read-only'); 'smart' adds ApprovalReviewer
    workspace_read_only: bool = False                  # -> LocalWorkspace(read_only=True)
    tools: list[str] | None = None                     # None = all; else allowlist of exact tool names
    tool_prefixes: list[str] = []                      # e.g. ['github_'] to allow a whole MCP server
    skills: list[str] | None = None                    # None = all discovered; [] = none
    builtin: bool = False
```

**Storage**: `settings['tool_profiles']` = JSON `list[ToolProfile]` (custom only), mirroring `mcp_servers` (`app/mcp_servers.py:52-117` — `load_mcp_servers`/`save_mcp_servers` is the exact template). Builtins are code constants merged at read time, `builtin=True`, non-editable; editing a builtin = duplicate-as-custom.
**No DB migration needed**: builtin ids equal the legacy values, so existing `chats.permission_profile`/`workspaces.permission_profile`/`settings.permission_profile` values resolve to builtin rows. Unknown ids → warn + `manual` (existing fallback behavior).

## 7. build_run_kwargs pseudocode

```python
profile = resolve_tool_profile(chat_settings)   # ToolProfile; unknown -> 'manual' builtin
lists   = PermissionLists(...)
model   = resolve_model(model_spec)

coder = _coder_with_lists(lists) if profile.tools is None or tool_subset_intersects_coder(profile) else minimal_fs
caps  = [
    LocalWorkspace(root, read_only=profile.workspace_read_only),
    coder,                                          # or standalone FileSystem for 'read-only' builtin parity
    Permissions({'bypass':'full','smart':'auto','manual':'read-only'}[profile.approval_mode]),
    *( [reviewer] if profile.approval_mode=='smart' else [] ),
    *build_mcp_capabilities(specs, gate=profile.approval_mode != 'bypass'),
    _planning_capability(chat_id),
    *( [Skills(SYSTEM_SKILLS_DIR, include=profile.skills, workspace=LocalWorkspaceBackend(SYSTEM_SKILLS_DIR),
               missing_directories='skip', unknown_names='skip')] if profile.skills != [] else [] ),
    *( [ToolAllowlist(frozenset(profile.tools), frozenset(profile.tool_prefixes))]
       if profile.tools is not None or profile.tool_prefixes else [] ),
    run_meta_hooks(profile.id, model_spec),
]
```

Caveat: the builtin `read-only` today runs *without* Coder (no coder instructions/compaction/output-limits). Two options: (a) keep building `FileSystem` standalone for that builtin; (b) unify — always Coder + allowlist `{read_file, list_files, grep, *PLANNING_TOOLS}` + `workspace_read_only`. (b) is cleaner but Coder's instructions still mention `shell`/`write_file` — a tolerable mismatch; (a) is lower-risk parity.

## 8. API endpoints needed

- `GET /api/tool-profiles` → builtin + custom (with effective tool/skill catalog info).
- `POST /api/tool-profiles`, `PUT /api/tool-profiles/{id}`, `DELETE /api/tool-profiles/{id}` — custom only; 403 on builtin ids.
- `GET /api/tool-catalog` → static tool list for the editor (table in §1 + enabled MCP servers as `{name}_*` prefix entries).
- `GET /api/skills` → `SkillCatalog` from `await Skills(SYSTEM_SKILLS_DIR, workspace=backend).load()` + optionally workspace library; return `skills` (name/description/path) + `skipped`.
- Schema loosening: `ChatPatch`/`WorkspacePatch`/`SettingsPatch` `permission_profile` → `str` validated against profile ids (or tolerant, preserving null-inherit semantics).

Frontend: replace hardcoded `PROFILES` in `ProfilePicker.tsx`/`PermissionsSection.tsx` with fetched list; new "Tool profiles" settings section (checkbox matrix: tools, MCP server prefixes, skills; approval-mode select); `RunMetaBadge` maps id→name; `models.ts`/`settings.ts` stores gain `profiles`.

## 9. Open risks

1. **`load_capability` must be exempted** from any tool allowlist or skills can't load (and `tool_search` if ever used).
2. **Skills outside workspace** (`workspace=` backend) render without the directory line → bundled `scripts/` unreachable by file tools. Instruction-only system skills unaffected. If bundled files matter later, investigate whether `LocalWorkspaceBackend` resolves absolute `directories` (unverified).
3. **Renamed/deleted custom profiles** leave dangling `permission_profile` references — the unknown→manual fallback covers it; surface a warning in `run_meta_hooks`.
4. **Profile name vs id**: store `id` in the three `permission_profile` columns so renames are free; builtin ids fixed at legacy strings.
5. `pydantic-ai-harness[skills]` extra should be added to `pyproject.toml` (PyYAML currently only transitive via `uvicorn[standard]`).
6. `visit_and_replace` on Coder is an alternative but fragile across harness upgrades; `get_wrapper_toolset` is the stable seam (documented public hook).
7. `_SetToolStrict`/`RepairToolArguments` inside Coder are unaffected by filtering; `Planning` events/`data-plan` bridge unaffected since capability remains bound (its tools may be filtered, but `_run_planning` still finds it — `events.py:195-202`).

### Key file references

| What | Path |
|---|---|
| Factory / profiles | `apps/backend/app/agent/factory.py:59,168-257,285-383` |
| Run-settings merge | `apps/backend/app/api/chat.py:500-526` |
| MCP toolsets | `apps/backend/app/mcp_servers.py:170-230` |
| Schema/migrations | `apps/backend/app/db/schema.py:61-72` |
| Settings API | `apps/backend/app/api/settings.py:57,264-278` |
| Validation schemas | `apps/backend/app/api/schemas.py:96,121,197` |
| Profile picker | `apps/desktop/src/renderer/src/features/chat/ProfilePicker.tsx:19-40` |
| Permissions settings | `apps/desktop/src/renderer/src/features/settings/sections/PermissionsSection.tsx:18-43` |
| Skills capability | `.venv/.../pydantic_ai_harness/skills/_capability.py:67`, `skills/_loader.py` |
| FilteredToolset | `.venv/.../pydantic_ai/toolsets/filtered.py:14` |
| get_wrapper_toolset | `.venv/.../pydantic_ai/capabilities/abstract.py:762` |
| Permissions | `.venv/.../pydantic_ai_harness/permissions/_capability.py:28,137-274` |
| Coder | `.venv/.../pydantic_ai_harness/coder/_capability.py:28,133-263` |
