# pydantic-ai-harness — the API surface app #2 uses

Verified against installed `pydantic-ai-harness==0.68.0`; target `==0.70.0`
(hard-pins `pydantic-ai-slim` — bump together, re-verify at impl start).
Vendored upstream docs: `specs/vendor/pydantic-ai-harness/`.

Extras used: `[coder]` (bundles the `rg` binary the file API relies on),
`[skills]`.

## Capability model

`AbstractCapability[AgentDepsT]` — capabilities compose per run and may
contribute instructions, tools, toolset wrappers, hooks and lifecycle events.
Per-run list is assembled in the agent factory and passed to
`dispatch_request(capabilities=[...])`.

**Cross-cutting wrapper rule:** implement cross-cutting tool gating as
`get_wrapper_toolset()` returning a `FilteredToolset` over the assembled
toolset — never modify tool definitions or toolsets. The filter **must always
permit `load_capability`** or Harness-native skills break.

## Capabilities used

| Capability | What app #2 uses | Key API |
|---|---|---|
| `Coder` | Whole `CombinedCapability` — the file+shell tool surface | `read_file`, `write_file`, `edit_file`, `list_files`, `grep`, `shell`; `delegate_task` only when `sub_agents=True` (ours: `False`) |
| `FileSystem` | Inside Coder; containment + allow/deny patterns | `LocalWorkspace`-backed; Coder narrows its surface to the 5 file tools |
| `Shell` | Inside Coder; allow/deny lists, denied operators, env filtering (`denied_env_patterns`/`LLM_API_KEY_ENV_PATTERNS`), `allow_interactive`, `persist_cwd`, `tools=[...]` selection (`run_command`/`start_command`/`check_command`/`stop_command` vs `shell`) | tool name `shell`; `data-shell` events stream phases. ⚠ **No per-chat session exists**: `shell` = detached jobs in the workspace; cwd persistence (`persist_cwd`, which Coder doesn't enable) is keyed by `sha256(run_id)` — **per-run**, not per-chat. App #2's "one shell per chat" (owner decision) needs its own mechanism — e.g. cwd/working-dir keyed by chat id in deps — spec'd in P1-agent-backend, verify at impl |
| `Planning` | Plan/task tools + persistence | `SqlitePlanStore` for durable plans; plan snapshots ride `data-plan` events |
| `LocalWorkspace` | Root confinement for file ops — **core `pydantic_ai`**, not harness | `LocalWorkspace(working_dir, read_only=, authority=, path_authority=, env=)`; `read_only=True` wraps in `ReadOnlyWorkspace`. Docstring: "isolates nothing" — the shell tool is not confined to it. Passed via `dispatch_request(workspace=)` |
| `Skills` | Progressive-disclosure skills (system + workspace dirs) | `Skills(directories, include= xor exclude=, missing_directories=MissingDirectories, duplicate_names=DuplicateNames, unknown_names=UnknownNames)` — literals are `'error'/'skip'`, `'error'/'keep_first'`, `'error'/'skip'` (all default `'error'`); app uses `'skip'`/`'keep_first'`; dedupes symlinked/identical `SKILL.md`; `disable-model-invocation` respected; `SkillDefinition.render` for host-invoked use |
| `Permissions` | Approval gating for writes + commands | below |
| `ApprovalReviewer` | LLM-as-judge for the `smart` profile | below |
| `StepPersistence` | Resumable runs | below |

## `Permissions` (verified against source — mode names are misleading)

```python
PermissionMode = Literal['full', 'auto', 'read-only']
Permissions(mode=..., ask_commands=DEFAULT_ASK_COMMANDS, remembered=set())
```

- ⚠ Semantics are **not** what the names suggest:
  - `'full'` = full permissions — **nothing asks** (the bypass mode).
  - `'auto'` = writes and commands run free; **only commands matching
    `ask_commands` regexes ask** (file writes never ask in this mode).
  - `'read-only'` = **asks the human before every write and every command** —
    approval still allows the call; it does not deny outright. (The app's
    `manual` profile maps here.)
- `mode` may be a `RunContext -> PermissionMode` callable — read on every
  call, so a profile changed mid-run applies from the next call.
- Detection is by tool **kind/metadata**, not name: writes are tools whose
  `tool_kind` is write/edit/create-directory; commands are tools whose
  metadata declares `code_arg_language='shell'` + `code_arg_name`.
- Asking works by raising `ApprovalRequired` → deferred-approval flow → ends
  the run inside `DeferredToolRequests` output. Answers ride back via
  `deferred_tool_results` (`DeferredToolResults`).
- `remembered` is caller-owned `MutableSet[RememberedApproval]`
  (conversation_id, tool_name, subject) — in-process only; durable
  remember-state lives in `ToolReturnPart` metadata — our app.db is the
  right home.
- Helpers: `permission_requests`, `ask_permissions`, `denial_message`,
  `ToolApproved`/`ToolDenied`/`DeferredToolApprovalResult`.
- Does **not** reach sub-agents unless passed via
  `SubAgents(shared_capabilities=[...])` — irrelevant while
  `sub_agents=False`.

### Profile → capability assembly (working example: `references/agent-factory.py`)

| Profile | Assembly |
|---|---|
| `bypass` | `Coder` + `Permissions('full')` |
| `smart` | `Coder` + `Permissions('auto')` + `ApprovalReviewer` (degrades to manual with warning if no judge resolves; unresolvable *explicit* judge fails loudly) |
| `manual` | `Coder` + `Permissions('read-only')` |
| `read-only` | **No Coder** — standalone `FileSystem(read_only=True, tools=FILE_TOOL_NAMES, allowed/denied_patterns, content_hashes=False)` + `RepoContext(walk_up='repo_root')` + `Permissions('read-only')`. No shell tool, no coder instructions. |

Allow/deny lists are injected into Coder's internals via
`CombinedCapability.visit_and_replace` (rewrites inner FileSystem/Shell
configs) — not by wrapping tools.

## `ApprovalReviewer`

`ApprovalReviewer(model, *, question, tools='all', include_conversation=False,
conversation_window=4000, on_review=None)` — `question` is **required**.
A `HandleDeferredToolCalls` handler that can only **approve** or escalate to
`ask` — never denies. `ApprovalReview`: tool_name, tool_call_id, decision
`Literal['approve','ask']`, answer, confidence.

App #2 wiring (from the current factory): `smart` profile adds the reviewer;
judge resolves explicit `judge_model` → run's own model → degrade to
`manual` with warning. An unresolvable explicit judge **fails loudly**.

## `StepPersistence` + stores

```python
StepPersistence(store=SqliteStepStore(database=path | connection=conn))
```

- `SqliteStepStore`: `database=` xor `connection=`; `media_store='auto'`
  resolves to `SqliteMediaStore` in the same db; `media_threshold_bytes`
  (default ~64k) externalizes large payloads; `max_snapshots_per_run`.
- `StepStore` protocol: `list_runs`, `list_events(run_id=)`,
  `save_snapshot`, `latest_snapshot`, `list_unresolved_tool_effects`.
- `continue_run(store, run_id=..., include_interrupted=)` — rebuilds
  `ModelMessage`s for resume (raises `LookupError` when no snapshot). The
  app's `/resume` uses `list_runs`/`latest_snapshot`/
  `list_unresolved_tool_effects` directly instead — same store API.
- Emits `SnapshotSavedEvent` (capability event → `data-*` part if bridged).
- `RunRecord` / `StepEvent` / `ToolEffectRecord` / `ContinuableSnapshot` in
  `_types`; store protocol also has `register_run`/`get_run`/`append_event`/
  `record_tool_effect`/`get_tool_effect`.
- ⚠ `SqliteConversationStore` (`step_persistence/conversations.py`) —
  **evaluated and rejected** as a `ConversationStore` replacement: it is a
  *session-browser* store (`save(summary, messages)`/`get`/`listing`/
  `name`/`set_archived`/`delete`) — none of the ABC's record/entry methods,
  so it cannot feed `dispatch_request(conversation_store=)`. Could only
  serve as a parallel browser/index layer. App #2 keeps the hand-rolled
  `ConversationStore` over per-`ModelMessage` rows. (Its bundled pieces —
  CAS revision, media externalization, search index — are still worth
  copying.)

## Events bridge (how `data-*` parts happen)

Capabilities emit `CapabilityEvent`s via `ctx.emit`; `agent.on_event(*types)`
receives them. Our events bridge (`agent/events.py`) maps:
`Plan*Event` subclasses → `data-plan`; `CommandStartedEvent` /
`CommandOutputEvent` / `CommandFinishedEvent` (`shell/_events`) → `data-shell`;
plus `data-run-meta` (usage/cost/model/run_id) emitted from `Hooks`. The
adapter itself emits a transient `data-conversation-saved` chunk on store
saves. All `data-*` parts are stream-only — not persisted — so consumers
treat them as optional on reload.

## Also used (smaller surface)

- `pydantic_ai.capabilities.Toolset` — wraps a toolset as a capability;
  `WrapperCapability` — the events bridge unwraps these.
- `RunContext.load_capability` — programmatic loader; the reason the profile
  filter must always permit `load_capability`.
- `Hooks` full kwargs (`before_run`, `on_run_error`,
  `wrap_run_event_stream`, …) — StepPersistence save-on-error and run-meta
  emission ride these.
- `data-notice` (user notices) and `data-resume` (resume side-effect
  warnings) — app-emitted `CustomEvent`s alongside the harness events.

## What is NOT used

`CodeMode`, `SubAgents` (off), `Memory`, web research/browser, hosted
integrations, context compaction, `ToolGuardrail`, sandboxed workspace
backends (Modal/E2B/…), Render Workflows. Don't add them to app #2's spec —
the tool surface stays exactly the 6 Coder tools + plan tools + MCP.

## Security model to carry over

- `LocalWorkspace` = path containment for file tools only; the `shell` tool
  inherits the backend process's permissions — command allow/deny lists +
  permissions modes are the real boundary, not the workspace.
- `.env`/secret handling is **two distinct layers**: `FileSystem.
  read_only_patterns` *write-protects* `.env`/`.git`/keys by default (reads
  still allowed); actual **read denial** needs `denied_patterns` — plus the
  route-level checks in the files API. Keep both layers; the profile's
  denied_patterns list is where app policy lives.
- Gitignore-awareness comes from the file API's `rg` tree + FileSystem
  pattern plumbing, not a dedicated flag.
- MCP tool names are `{server}_`-prefixed — profile filters match exact
  names or prefixes.
- Never log: bearer token, API keys, MCP env/header values (round-trip
  them, don't print).

## Getting latest docs (https://pydantic.dev/docs/ai/harness/)

Same agent-friendly setup as pydantic-ai (see that spec for full details —
`llms.txt` index, `.../index.md` markdown pages, `goal`/`organization`
query params). Harness pages live under `/docs/ai/harness/`:

- `/docs/ai/harness/index.md` — overview
- `/docs/ai/harness/coder/index.md`, `filesystem/`, `shell/` — the
  capability docs for the tools app #2 actually uses
- No published harness API reference (`/docs/ai/api/pydantic-ai-harness/`
  does not exist — verified 404) — signatures come from the guide pages,
  the vendored docs, or the installed package source.
- Vendored upstream docs already at `specs/vendor/pydantic-ai-harness/`;
  refresh them on version bumps.

Pinned to `pydantic-ai-harness==0.70.0` (hard-pins slim). On bumps,
re-fetch the `Coder`, `FileSystem`, `Shell`, `Planning`, `Permissions`,
`LocalWorkspace`, and `StepPersistence` capability pages.
