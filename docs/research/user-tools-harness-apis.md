# User-defined tools: pydantic-ai toolset APIs → app integration seam

Verified against `pydantic-ai-slim==2.68.0` + `pydantic-ai-harness==0.68.0`
(`apps/backend/.venv/lib/python3.12/site-packages/`). Context7 MCP was unavailable;
live pydantic.dev docs cross-checked — installed source governs.

All `pydantic_ai` paths below are relative to `site-packages/pydantic_ai/`;
`pydantic_ai_harness` paths to `site-packages/pydantic_ai_harness/`.

## 1. FunctionToolset — `toolsets/function.py`

Constructor (function.py:75-92):

    FunctionToolset(
        tools: Sequence[Tool[AgentDepsT] | ToolFuncEither[AgentDepsT, ...]] = [],
        *,
        max_retries: int | None = None,
        timeout: float | None = None,
        docstring_format: DocstringFormat = 'auto',   # 'auto'|'google'|'numpy'|'sphinx'
        require_parameter_descriptions: bool = False,
        schema_generator: type[GenerateJsonSchema] = GenerateToolJsonSchema,
        strict: bool | None = None,
        sequential: bool = False,
        requires_approval: bool = False,
        metadata: dict[str, Any] | None = None,
        defer_loading: bool = False,
        include_return_schema: bool | None = None,
        id: str | None = None,
        instructions: AgentInstructions[AgentDepsT] = None,
    )

Four ways to add functions:
- `tools=[fn, Tool(fn), ...]` constructor list — `Tool` instances go through `add_tool`, callables through `add_function` (function.py:159-164).
- `@toolset.tool` decorator — function takes `RunContext` first (function.py:219-342). Usable bare or with kwargs: `name`, `description`, `retries`, `prepare`, `args_validator`, `docstring_format`, `require_parameter_descriptions`, `schema_generator`, `strict`, `sequential`, `requires_approval`, `metadata`, `tool_kind`, `timeout`, `defer_loading`, `include_return_schema`.
- `@toolset.tool_plain` — same kwargs, no `RunContext` (function.py:393-518).
- `add_function(func, takes_ctx=None, name=None, ...same kwargs...) -> Tool` (function.py:614-728) and `add_tool(tool: Tool) -> None` (function.py:730-747).

`takes_ctx=None` infers RunContext from the first parameter's annotation (`_function_schema.py:172-174` via `is_call_ctx`).

Methods/classes: `add_function` accepts any callable. Bound methods work (`inspect.signature` binds `self` away). `functools.partial` is unwrapped for schema generation (`_function_schema.py:153`) BUT `Tool.__init__` does `self.name = name or function.__name__` (tools.py:483) — partials and callable objects lack `__name__`, so pass `name=` explicitly. Classes themselves can't be tools.

Schema derivation (`_function_schema.py:121-250`):
- `get_type_hints(..., include_extras=True)` — `Annotated[...]`/`Field(description=...)` honored.
- Docstring → description + per-parameter descriptions via griffe (`doc_descriptions`), formats google/numpy/sphinx/'auto'. Only leading description, param descriptions, and first `Returns` entry reach the model.
- Each parameter becomes a field in a TypedDict core schema → full pydantic validation. **A pydantic `BaseModel` (or dataclass/TypedDict) parameter works**: multi-arg → nested object property; a *single* model-like arg gets `single_arg_name` treatment where the model's own JSON schema becomes the tool's schema (`_function_schema.py:205-209`).
- Extra post-schema validation: `args_validator` hook receives `(ctx, **validated_kwargs)`, raise `ModelRetry`/`ToolFailed`.
- Sync functions run in a thread executor; async awaited directly (`_function_schema.py:92-100`). Both supported.

## 2. Mixed toolsets / custom toolset duck type

A `FunctionToolset` holds only functions/`Tool`s, but `CombinedToolset` (`toolsets/combined.py:25`) mixes any `AbstractToolset`s; `Capability(toolsets=[...], tools=[...])` builds one for you (`capabilities/capability.py:149-169`).

Minimal custom toolset — subclass `AbstractToolset[AgentDepsT]` (`toolsets/abstract.py:85`), implement:
- `id -> str | None` (abstract property, line 97-110)
- `async get_tools(ctx) -> dict[str, ToolsetTool[AgentDepsT]]` (line 258)
- `async call_tool(name, tool_args: dict, ctx, tool: ToolsetTool) -> Any` (line 263)

`ToolsetTool` (abstract.py:51-82) needs: `toolset`, `tool_def: ToolDefinition`, `max_retries: int`, `args_validator: SchemaValidator | SchemaValidatorProt` (e.g. `TypeAdapter(...).validator`), optional `args_validator_func`.

Optional lifecycle/behavior: `__aenter__/__aexit__`, `for_run(ctx)`, `for_run_step(ctx)`, `get_instructions(ctx)`, `apply`, `visit_and_replace`, plus convenience wrappers `.filtered()`, `.prefixed()`, `.renamed()`, `.prepared()`, `.approval_required()`, `.defer_loading()`, `.include_return_schemas()`, `.with_metadata()` (abstract.py:308-397).

## 3. Approval flow

`ApprovalRequiredToolset` (`toolsets/approval_required.py:16-32`) is a `WrapperToolset` around ANY `AbstractToolset` — including `FunctionToolset`. `call_tool` raises `ApprovalRequired` (exceptions.py:195, `metadata` kwarg lands in `DeferredToolRequests.metadata[tool_call_id]`) unless `ctx.tool_call_approved` or `approval_required_func(ctx, tool_def, args)` returns False. Convenience: `toolset.approval_required(func)` (abstract.py:346-358).

Two deferral paths, identical resolution (tool_manager.py:1470-1502):
- Declarative: `requires_approval=True` on tool/toolset → `tool_def.kind='unapproved'` → deferred before execution.
- Imperative: `ApprovalRequired`/`CallDeferred` raised mid-call (what `ApprovalRequiredToolset` and harness `Permissions` do).

Unresolved approvals end the run as `DeferredToolRequests.approvals` (`_deferred.py:41-78`) — the app already declares `output_type=[str, DeferredToolRequests]` (factory.py:347-351) and the adapter emits `tool-approval-request` chunks; approvals answer via `DeferredToolResults.approvals` (`ToolApproved`/`ToolDenied`, `_deferred.py:143-224`). `ApprovalReviewer` judges ANY `requests.approvals` selected by its `tools` selector (default `'all'`) — approval_reviewer/_capability.py:203-228. **User tools flow through the existing approval-card path identically.**

Caveat: harness `Permissions` only gates file-write tool kinds + `code_arg_language='shell'` tools (permissions/_capability.py:242-264) — user tools are invisible to it. To gate them under non-bypass profiles, wrap in `ApprovalRequiredToolset` exactly as `build_mcp_capabilities` does (app/mcp_servers.py:276-280), or set `requires_approval=True` unconditionally.

## 4. How capabilities expose tools — and the simplest seam

`AbstractCapability.get_toolset() -> AgentToolset | None` (capabilities/abstract.py:730-732). `AgentToolset = AbstractToolset | ToolsetFunc` (toolsets/__init__.py:19). Harness examples: `Planning.get_toolset()` returns a `PlanningToolset` (planning/_capability.py:175-191); `Coder` is a `CombinedCapability` bundling `FileSystem`, `Shell`, `RepoContext`, etc., each with `get_toolset()` (coder/_capability.py:133-263). `Shell`/`FileSystem` are `AbstractCapability` dataclasses.

User-facing paths, simplest first:
- **`capabilities=[Capability(tools=[fn, ...], id='user_tools', instructions=...)]`** — convenience capability with its own `FunctionToolset`, plus `.tool`/`.tool_plain`/`.instructions` decorators (capabilities/capability.py:82-184, 235-376). Bundles tools + guidance under an `id`.
- **`capabilities=[ToolsetCapability(toolset)]`** — `pydantic_ai.capabilities.Toolset` (capabilities/toolset.py:9-20); exactly how MCP toolsets enter (app/mcp_servers.py:279).
- **`toolsets=[FunctionToolset(...)]` run kwarg** — `dispatch_request`/`run_stream_native`/`run_stream_events`/`agent.run` all accept `toolsets: Sequence[AbstractToolset]` (ui/_adapter.py:1459, 1690; agent/abstract.py:562). Equally supported; the app just hasn't used it.
- Custom `AbstractCapability` subclass overriding `get_toolset()` — only needed if you also want hooks/instructions/for_run state.

## 5. Tool naming & conflicts

- Default name: `function.__name__` (tools.py:483); override via `name=` at registration.
- `.prefixed('user')` → `user_<name>` exposed to the model AND to `call_tool`; stripped before dispatch (toolsets/prefixed.py:24-41). `.renamed({new: old})` for arbitrary maps.
- Conflicts: within a `FunctionToolset`, `add_tool` raises `UserError` at registration (function.py:739-740); across toolsets, `CombinedToolset.get_tools` raises `UserError` at run setup (combined.py:72-76) — a user tool named `read_file`/`shell`/`write_file`/`edit_file`/`list_files`/`grep` colliding with Coder's would kill the run at start. **Prefixing (`user_`) is the collision-avoidance mechanism the framework itself recommends** (`tool_name_conflict_hint`, abstract.py:130-133).

## 6. FilteredToolset & ToolAllowlist

`FilteredToolset(toolset, filter_func)` where `filter_func(ctx, tool_def) -> bool | Awaitable[bool]` — filters on `tool_def.name` (final exposed name, post-prefix) (filtered.py:13-33).

`ToolAllowlist` (app/agent/factory.py:285-314) wraps the **entire assembled combined toolset** via `get_wrapper_toolset` — user tools are covered automatically. `allowed` = exact names, `prefixes` = `startswith` matches; `load_capability` always kept. A `user_` prefix slots in as `prefixes={'user_'}` or exact names in `allowed`, matching the profile catalog's `tool_prefixes` mechanism (factory.py:462-478).

## 7. Current assembly — `build_run_kwargs` (app/agent/factory.py:431-498)

    capabilities = [
        LocalWorkspace(root, read_only=profile.workspace_read_only),      # L432
        *_profile_capabilities(...)  # Coder+lists + Permissions (+ ApprovalReviewer under 'smart');
                                     # read-only builtin: FileSystem+RepoContext+Permissions   # L433
        *build_mcp_capabilities(..., gate=profile.approval_mode != "bypass"),  # per-server
            # ToolsetCapability(ResilientToolset(ApprovalRequiredToolset?(PrefixedToolset(MCPToolset))))  # L441
        _planning_capability(chat_id),   # Planning(SqlitePlanStore)      # L450
        _step_persistence_capability(),  # StepPersistence → steps.db     # L456
        *_skills_capabilities(profile),  # workspace + system Skills      # L458
        *([ToolAllowlist(allowed, prefixes)] if profile.tools is not None or profile.tool_prefixes else []),  # L462-478
        run_meta_hooks(profile.id, model_spec),                          # L481
    ]
    return {"model", "capabilities", "instructions", "workspace": LocalWorkspaceBackend(root),
            "usage_limits": UsageLimits(request_limit=50), "model_settings"}

**Recommended slot:** immediately after the MCP block (~L450), mirror its shape:

    *build_user_tool_capabilities(user_tools, gate=profile.approval_mode != "bypass")

i.e. `ToolsetCapability(FunctionToolset(fns, id='user_tools').prefixed('user'))`,
optionally `ApprovalRequiredToolset`-wrapped for non-bypass profiles. Because it's inside
`capabilities`, it flows to both `dispatch_request(**run_kwargs)` (api/chat.py:250-261)
and `agent.run_stream_events(**run_kwargs)` (api/resume.py:347-351) unchanged, and
`ToolAllowlist`'s single wrap point covers it.

## 8. Docs cross-check gotchas (pydantic.dev; matches installed source)

- `ctx: RunContext[...]` must be the FIRST parameter; inferred from annotation — a `RunContext` annotation elsewhere is a `UserError` (`_function_schema.py:291-296`).
- Sync tools run in a threadpool — fine, but don't share unsynchronized state; `sequential=True` serializes a tool relative to parallel calls.
- Output: anything pydantic serializes to JSON; JSON-strings pass through unquoted; `ToolReturn` adds metadata/multi-modal content.
- `prepare` funcs can rename/omit tools per step; renamed names interact subtly with retry bookkeeping (function.py:776-791).
- `defer_loading=True` needs the capability/toolset to have a stable `id` (`load_capability` tool; `ToolAllowlist` always permits it).
- `requires_approval=True` requires `DeferredToolRequests` in `output_type` — already set app-wide (factory.py:350).
- Griffe docstrings: only description + params + first `Returns` entry reach the model; `Raises:`/`Examples:` are dropped.
- `Capability`/`Toolset` capability aren't spec-serializable (no `get_serialization_name`) — fine for code-built runs; not for `Agent.from_spec`.
