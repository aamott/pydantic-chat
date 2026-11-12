# Capability wiring

## Goal

Shared `Agent` + per-run capabilities composed from `pydantic-ai-harness`, scoped to the chat's workspace.

## Verified APIs (harness 0.68.0 / slim 2.68.0)

- `Coder(workspace=root, instructions=?, unrestricted_filesystem=False, repo_context=True, sub_agents=True)` — composes instructions + `FileSystem` (root_dir jail w/ symlink-aware containment, protected `.git/.env/*.pem/secrets` globs) + `Shell` (persistent `shell` tool, `denied_env_patterns=LLM_API_KEY_ENV_PATTERNS`) + `RepoContext` (auto-injects AGENTS.md/CLAUDE.md) + `SubAgents` + compaction (`ClearToolResults`/`WarnNearLimits`) + `ToolOutputLimits` (64k) + `RepairToolArguments`
- ⚠️ `LocalWorkspace(root)` is NOT a sandbox — only sets cwd/context; containment lives in `FileSystem`. Pass both; `dispatch_request` also accepts `workspace=`.
- `[coder]` extra bundles `ripgrep` binary wheel — `grep`/`list_files` need no system rg
- `dispatch_request(..., capabilities=[...])` — everything is per-run; no agent rebuild for workspace/model/permission switches

## Acceptance criteria

- One `Agent` instance; per-run args resolved from chat/workspace settings: `model`, `capabilities=[LocalWorkspace(root), Coder(root), Planning(store=…), <permission caps>]`, `usage_limits=UsageLimits(request_limit=50, …)`
- Tools available: `read_file`, `write_file`, `edit_file`, `list_files`, `grep`, `shell` (fg/bg, outlives run), `delegate_task`, plan tools
- Verified: agent lists/reads/greps inside workspace; path escape (`../..`, symlink) refused by FileSystem; `.env` read refused (protected pattern)
- To restrict tools (read-only profile, shell off): compose `FileSystem`/`Shell` directly instead of `Coder()` — same composition, different args

## Files
- `apps/backend/app/agent/factory.py`

## Depends on
- pending-sqlite_store-high-med.md (workspace root); feeds pending-chat_endpoint-high-med.md

## Implementation notes (2026-11-12 subagent)

- Implemented in `app/agent/factory.py`. One shared `_AGENT` (`get_agent()`); `build_run_kwargs(chat_settings, workspace)` → `{model, capabilities, workspace, usage_limits}`.
- **API deltas vs story:** `Coder(workspace=...)` warns the arg is IGNORED (workspace comes from `LocalWorkspace`) — so `Coder()` takes no root; `LocalWorkspace(root)` supplies it and `dispatch_request`'s `workspace=` is pinned with `LocalWorkspaceBackend(root)` so a stale `WorkspaceRef` in server-side history can't redirect file access.
- User allow/deny lists reach Coder's *internal* `Shell`/`FileSystem` via the supported `visit_and_replace` tree rewrite (`_coder_with_lists`) — Coder takes no list args. Shell allow/deny are mutually exclusive: allowlist mode wins, deny list subtracted from it (deny still wins per command); Coder's empty denylist is never widened.
- `resolve_permission_capabilities(profile, lists, judge_model=...)`: `bypass`→`Permissions('full')`; `smart`→`Permissions('auto')`+`ApprovalReviewer` (default judge `anthropic:claude-haiku-4-5`, falls back to `manual` when the judge model can't be configured); `manual`→`Permissions('read-only')` — asks on every write AND command (the story's "read-only-style asks" option; true human-in-the-loop default); `read-only`→`FileSystem(read_only=True, tools=FILE_TOOL_NAMES)` + `RepoContext` + `Permissions('read-only')`, no `Shell`/`Coder`. Unknown profile → `manual`.
- `Planning(store=SqlitePlanStore(data_dir()/'plans.db', session=chat_id))` when `chat_id` is in chat_settings, else in-memory. `UsageLimits(request_limit=50)`.
- AC pending e2e: live run verification (read/grep/path-escape/.env refusal) needs a real API key; composition + list pass-through + read-only tool surface covered by `tests/test_agent.py`.

- Marked done: unit-tested (test_agent.py) + exercised e2e via /api/chat with FunctionModel; live tool behavior vs real provider verified on first keyed run.
