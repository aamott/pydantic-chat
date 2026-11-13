"""Shared ``Agent`` plus per-run capability composition for ``dispatch_request``.

One ``Agent`` instance serves every chat; everything chat-specific is a per-run
argument resolved by :func:`build_run_kwargs` — model, workspace, permission
profile, and usage limits — so switching chats/models/permissions needs no
agent rebuild.

Verified against ``pydantic-ai-slim==2.68.0`` / ``pydantic-ai-harness==0.68.0``:

- ``LocalWorkspace(root)`` supplies the run workspace (cwd + env); it is *not* a
  sandbox — file containment lives in ``FileSystem``.
- ``Coder(sub_agents=False)`` composes instructions + ``FileSystem`` + ``Shell``
  (persistent ``shell`` tool) + ``RepoContext`` + compaction/output limits.
  ``Coder(workspace=...)`` warns and is ignored — pass ``LocalWorkspace``.
  ``sub_agents`` stays off: its ``SubAgents(include_self=True)`` delegates to a
  fresh run of the *bound* agent, which per-run ``capabilities=[...]`` can't
  supply — the run would fail at start with a ``UserError``.
- ``Permissions(mode)`` asks before writes/commands; ``ApprovalReviewer(model)``
  auto-approves the low-risk ones (the "smart" profile).
- User allow/deny lists reach ``Coder``'s internal ``Shell``/``FileSystem`` via
  the supported ``visit_and_replace`` tree rewrite — ``Coder`` takes no list
  args of its own.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from pydantic_ai import Agent, DeferredToolRequests, RunContext, UsageLimits
from pydantic_ai.capabilities import AbstractCapability, LocalWorkspace
from pydantic_ai.tools import ToolDefinition
from pydantic_ai.toolsets import AbstractToolset, FilteredToolset
from pydantic_ai.workspaces import LocalWorkspaceBackend
from pydantic_ai_harness import ApprovalReviewer, Coder, Permissions, Planning
from pydantic_ai_harness.coder import FILE_TOOL_NAMES
from pydantic_ai_harness.filesystem import FileSystem
from pydantic_ai_harness.repo_context import RepoContext
from pydantic_ai_harness.shell import Shell

from app.agent.events import install_ui_event_bridge, run_meta_hooks
from app.agent.models import (
    ProviderNotConfigured,
    UnknownProviderError,
    resolve_model,
    thinking_model_settings,
)
from app.config import DEFAULT_MODEL, DEFAULT_PERMISSION_PROFILE, data_dir
from app.profiles import (
    BUILTIN_PROFILES,
    ToolProfile,
    resolve_tool_profile,
    system_skills,
    workspace_skills,
)

if TYPE_CHECKING:
    from pydantic_ai.models import Model

    from app.db.app_tables import Workspace

logger = logging.getLogger(__name__)

PermissionProfile = Literal["bypass", "smart", "manual", "read-only"]

REQUEST_LIMIT = 50
"""Max model turns per agent run — bounds runaway loops."""

SMART_DEFAULT_JUDGE = "anthropic:claude-haiku-4-5"
"""Last-resort reviewer spec for ``smart`` when nothing better is available.

The judge the ``smart`` profile actually uses resolves in priority order: the
explicit ``judge_model`` setting, then the run's own model (configured by
definition — ``build_run_kwargs`` supplies it), then this spec. It exists for
direct ``resolve_permission_capabilities`` callers that have no run model;
when even it can't resolve (no provider key), ``smart`` falls back to
``manual`` with a warning. An explicit ``judge_model`` that fails to resolve
(e.g. a stale settings row naming an unconfigured provider) likewise degrades
to the run model rather than to ``manual``.
"""

APPROVAL_RISK_QUESTION = "Could this call destroy data, spend money, or leak secrets?"
"""Yes/no question ``ApprovalReviewer`` asks; ``no`` auto-approves the call."""

FILE_LINK_INSTRUCTIONS = (
    "When you mention a file in the workspace, link it as [name](file:relative/path) "
    "— append :LINE for a specific line, e.g. [src/app.py](file:src/app.py:12). "
    "Always use workspace-relative POSIX paths, never absolute or file:/// URLs."
)
"""System-prompt guidance for `file:` links — matches the renderer's interceptor.

The frontend (``MessagePart.tsx``) intercepts ``file:`` hrefs and parses
``file:path`` or ``file:path:line``; paths resolve against the chat's workspace
root, so absolute paths and ``#L`` fragments are not understood.
"""


@dataclass(frozen=True, slots=True)
class PermissionLists:
    """User allow/deny lists applied to the run's shell and filesystem tools.

    ``allowed_commands`` and ``denied_commands`` are mutually exclusive in
    ``Shell``: when an allowlist is set it wins, with the deny list filtered out
    of it so deny still wins per command. ``FileSystem`` accepts both pattern
    lists natively (deny wins).
    """

    allowed_commands: Sequence[str] = ()
    denied_commands: Sequence[str] = ()
    allowed_patterns: Sequence[str] = ()
    denied_patterns: Sequence[str] = ()

    @property
    def empty(self) -> bool:
        """Whether no list carries any entry."""
        return not (
            self.allowed_commands
            or self.denied_commands
            or self.allowed_patterns
            or self.denied_patterns
        )


def _setting(source: Mapping[str, Any] | Any, key: str, default: Any = None) -> Any:
    """Read ``key`` off a settings mapping or an attribute object (ChatSummary & co.)."""
    if isinstance(source, Mapping):
        return source.get(key, default)
    return getattr(source, key, default)


def _coder_with_lists(lists: PermissionLists) -> Coder:
    """``Coder()`` with the user's allow/deny lists applied to its tools.

    ``Coder`` builds its ``Shell``/``FileSystem`` internally and takes no list
    args, so the lists are injected through ``visit_and_replace`` — the
    supported tree rewrite that rebuilds the container properly. Coder's shell
    denylist defaults to empty; the user's deny list goes *on top* of it, it is
    never widened to anything weaker.
    """
    # `sub_agents=False`: `SubAgents(include_self=True)` needs capabilities bound
    # on the Agent itself, which per-run `capabilities=[...]` can't supply.
    coder: Coder = Coder(sub_agents=False)
    if lists.empty:
        return coder

    def visit(capability: AbstractCapability) -> AbstractCapability | None:
        if isinstance(capability, Shell):
            if lists.allowed_commands:
                # Allowlist mode: everything else is denied anyway, and the
                # deny list still wins per command by subtracting it.
                allowed = [
                    command
                    for command in lists.allowed_commands
                    if command not in lists.denied_commands
                ]
                return replace(capability, allowed_commands=allowed, denied_commands=[])
            return replace(
                capability, allowed_commands=[], denied_commands=list(lists.denied_commands)
            )
        if isinstance(capability, FileSystem):
            return replace(
                capability,
                allowed_patterns=list(lists.allowed_patterns),
                denied_patterns=list(lists.denied_patterns),
            )
        return capability

    rewritten = coder.visit_and_replace(visit)
    assert isinstance(rewritten, Coder)  # the container always survives here
    return rewritten


def _manual_capabilities(lists: PermissionLists) -> list[AbstractCapability]:
    """Coder's full tool surface, asking the human before every write/command."""
    return [_coder_with_lists(lists), Permissions("read-only")]


# approval_mode -> Permissions mode; 'smart' additionally adds an
# ApprovalReviewer when a judge model resolves.
_APPROVAL_MODES = {"bypass": "full", "smart": "auto", "manual": "read-only"}


def _profile_capabilities(
    profile: ToolProfile,
    lists: PermissionLists,
    *,
    judge_model: str | Model | None = None,
    fallback_model: Model | None = None,
) -> list[AbstractCapability]:
    """The Coder/permissions capabilities one resolved ``ToolProfile`` needs.

    The builtin ``read-only`` keeps the legacy assembly — a standalone
    ``FileSystem(read_only=True)`` plus ``RepoContext``, no ``Coder`` (no
    coder instructions, no shell) — rather than Coder-plus-allowlist. Every
    other profile builds ``Coder`` and ``Permissions`` from ``approval_mode``;
    ``smart`` adds the reviewer, degrading to ``manual`` when no judge model
    resolves.
    """
    if profile.builtin and profile.id == "read-only":
        return [
            FileSystem(
                read_only=True,
                tools=FILE_TOOL_NAMES,
                allowed_patterns=list(lists.allowed_patterns),
                denied_patterns=list(lists.denied_patterns),
                content_hashes=False,
            ),
            RepoContext(walk_up="repo_root"),
            Permissions("read-only"),
        ]

    if profile.approval_mode == "smart":
        reviewer = _approval_reviewer(judge_model, fallback_model)
        if reviewer is not None:
            return [_coder_with_lists(lists), Permissions("auto"), reviewer]
        logger.warning(
            "Smart approval mode has no usable judge model; falling back to manual"
        )
        return _manual_capabilities(lists)

    return [_coder_with_lists(lists), Permissions(_APPROVAL_MODES[profile.approval_mode])]


def _skills_capabilities(profile: ToolProfile) -> list[AbstractCapability]:
    """The ``Skills`` capabilities for the profile's skill allowlist.

    ``skills=[]`` omits the capability entirely; ``None`` includes every
    discovered skill; a name list becomes ``include=``. Workspace-local
    libraries come first so a project skill shadows a system one of the same
    name (``keep_first`` claims the earlier source).
    """
    if profile.skills == []:
        return []
    include = frozenset(profile.skills) if profile.skills is not None else None
    return [workspace_skills(include), system_skills(include)]


def resolve_permission_capabilities(
    profile: str = DEFAULT_PERMISSION_PROFILE,
    lists: PermissionLists | None = None,
    *,
    judge_model: str | Model | None = None,
    fallback_model: Model | None = None,
) -> list[AbstractCapability]:
    """The capabilities a run needs for one permission profile id.

    Args:
        profile: ``bypass`` (nothing asks), ``smart`` (an LLM reviewer
            auto-approves low-risk calls), ``manual`` (the human approves every
            write and command — ``Permissions('read-only')`` asks on both), or
            ``read-only`` (read tools only, no shell). Unknown values fall back
            to ``manual`` — the safest default.
        lists: User allow/deny lists passed through to ``Shell``/``FileSystem``.
        judge_model: Reviewer for ``smart`` — a ``Model`` or a
            ``provider:model`` spec resolved through the registry.
        fallback_model: Judge tried when ``judge_model`` is absent or fails
            to resolve — ``build_run_kwargs`` passes the run's own resolved
            model, which is configured by definition. After it comes
            :data:`SMART_DEFAULT_JUDGE`; when no candidate resolves, ``smart``
            falls back to ``manual``.

    Returns:
        The capability list to merge into ``build_run_kwargs``'s.
    """
    lists = lists or PermissionLists()
    builtin = next((p for p in BUILTIN_PROFILES if p.id == profile), None)
    if builtin is None:
        if profile != "manual":
            logger.warning("Unknown permission profile %r; using 'manual'", profile)
        builtin = next(p for p in BUILTIN_PROFILES if p.id == "manual")
    return _profile_capabilities(
        builtin, lists, judge_model=judge_model, fallback_model=fallback_model
    )


@dataclass
class ToolAllowlist(AbstractCapability[None]):
    """Restricts the assembled toolset to the profile's allowed tools.

    ``get_wrapper_toolset`` wraps the combined non-output toolset once per
    run — a single wrap point that covers Coder, Planning, and MCP toolsets
    uniformly. ``load_capability`` is always permitted: filtered out, the
    deferred-capability loader would break skill loading entirely.
    """

    allowed: frozenset[str] = field(default_factory=frozenset)
    """Exact tool names to keep (``frozenset()`` keeps nothing but the exemptions)."""

    prefixes: frozenset[str] = field(default_factory=frozenset)
    """Name prefixes to keep — e.g. ``fs-tools_`` admits a whole MCP server."""

    def get_wrapper_toolset(
        self, toolset: AbstractToolset[None]
    ) -> AbstractToolset[None]:
        """Wrap the assembled toolset in a ``FilteredToolset`` honoring the allowlist."""
        allowed, prefixes = self.allowed, self.prefixes

        def keep(ctx: RunContext[Any], tool_def: ToolDefinition) -> bool:
            return (
                tool_def.name == "load_capability"
                or tool_def.name in allowed
                or any(tool_def.name.startswith(prefix) for prefix in prefixes)
            )

        return FilteredToolset(toolset, keep)


def _approval_reviewer(
    judge_model: str | Model | None,
    fallback_model: Model | None = None,
) -> ApprovalReviewer | None:
    """An ``ApprovalReviewer`` for the best available judge, or ``None``.

    Candidates in priority order: the explicit ``judge_model`` (a ``Model``
    or a ``provider:model`` spec), then ``fallback_model`` (the run's own
    resolved model — an explicit setting that fails to resolve, e.g. a stale
    row naming an unconfigured provider, degrades here rather than to
    ``manual``), then :data:`SMART_DEFAULT_JUDGE` for direct callers with no
    run model. ``None`` is returned only when no candidate resolves, letting
    ``smart`` degrade to ``manual`` instead of crashing the run setup.
    """
    candidates: list[str | Model] = [judge_model] if judge_model else []
    if fallback_model is not None:
        candidates.append(fallback_model)
    candidates.append(SMART_DEFAULT_JUDGE)
    for spec in candidates:
        try:
            model = spec if not isinstance(spec, str) else resolve_model(spec)
        except (ProviderNotConfigured, UnknownProviderError) as error:
            logger.warning(
                "Judge model %r unavailable for smart profile: %s", spec, error
            )
            continue
        return ApprovalReviewer(model, question=APPROVAL_RISK_QUESTION)
    return None


_AGENT: Agent[None, str | DeferredToolRequests] = Agent(
    None,
    instructions="You are a helpful coding assistant working inside the user's workspace.",
    output_type=[str, DeferredToolRequests],
)
"""One shared ``Agent``; model and capabilities arrive per run.

``DeferredToolRequests`` in ``output_type`` lets a run *end* on calls deferred
by the permission capabilities (``Permissions`` holds approval-required calls):
without it the run dies with ``UserError`` instead of emitting
``tool-approval-request`` chunks and storing what it's waiting on. The adapter
only adds it automatically for client-supplied toolsets, which this app never
sends, so it is declared here — never per run (``dispatch_request`` only
permits ``output_type`` when the agent has none).
"""

install_ui_event_bridge(_AGENT)
"""Bridge capability events (plan changes, shell progress) into `data-*` chunks."""


def get_agent() -> Agent[None, str | DeferredToolRequests]:
    """The shared agent — minimal instructions; ``Coder`` brings its own per run."""
    return _AGENT


def build_run_kwargs(
    chat_settings: Mapping[str, Any] | Any,
    workspace: Workspace | str | Path,
) -> dict[str, Any]:
    """The per-run keyword args for ``VercelAIAdapter.dispatch_request``.

    Args:
        chat_settings: A mapping (or object with attributes) carrying the run's
            settings — ``model`` (a ``provider:model`` spec), ``thinking``
            (a normalized ``off``/``low``/``medium``/``high`` level, mapped to
            the unified ``ModelSettings.thinking`` field),
            ``permission_profile``, ``judge_model``, the four allow/deny lists,
            and ``chat_id`` (scopes the persistent plan). Missing keys fall
            back to safe defaults; a missing or unresolvable ``judge_model``
            makes the ``smart`` profile's reviewer judge with the run's own
            model.
        workspace: The app ``Workspace`` row, or a bare path.

    Returns:
        ``dict`` with ``model``, ``capabilities``, ``workspace``, and
        ``usage_limits`` ready to splat into ``dispatch_request``.

    Raises:
        ProviderNotConfigured: If the model's provider has no credentials.
    """
    root = Path(getattr(workspace, "path", workspace))
    # The effective permission_profile id resolves to a ToolProfile — builtin
    # or one of the custom profiles in settings['tool_profiles'] (decoded by
    # _run_settings). An unknown id warns and resolves to builtin 'manual'.
    profile = resolve_tool_profile(chat_settings)
    lists = PermissionLists(
        allowed_commands=tuple(_setting(chat_settings, "allowed_commands") or ()),
        denied_commands=tuple(_setting(chat_settings, "denied_commands") or ()),
        allowed_patterns=tuple(_setting(chat_settings, "allowed_patterns") or ()),
        denied_patterns=tuple(_setting(chat_settings, "denied_patterns") or ()),
    )
    model_spec = _setting(chat_settings, "model") or DEFAULT_MODEL
    # Resolve once and share the instance: a ``smart`` run judges with the
    # explicit ``judge_model`` setting, else this same model — it's configured
    # by definition, which keeps ``smart`` working for users whose only key
    # belongs to the chat model's provider. It is also the fallback when an
    # explicit ``judge_model`` can't resolve (a stale settings row, e.g. the
    # anthropic default a form save once persisted, with no anthropic key) —
    # an unresolvable judge degrades to the run model, never silently to
    # ``manual``. Raises ProviderNotConfigured for an unconfigured run model
    # before anything else is built — the route maps that to 402 either way.
    model = resolve_model(model_spec)
    judge_model = _setting(chat_settings, "judge_model")

    # Lazy: app.mcp_servers -> app.api.schemas -> this module would be a cycle.
    # The MCP layer itself imports fastmcp lazily too, so a build with no
    # servers configured pays nothing.
    from app.mcp_servers import build_mcp_capabilities, parse_mcp_servers

    capabilities: list[AbstractCapability] = [
        LocalWorkspace(root, read_only=profile.workspace_read_only),
        *_profile_capabilities(
            profile, lists, judge_model=judge_model, fallback_model=model
        ),
        # MCP toolsets land in the capability list like everything else.
        # `Permissions` never sees MCP tools (it gates only file-write kinds
        # and shell-command tools), so every non-bypass approval mode wraps
        # them in `ApprovalRequiredToolset` — their calls join the same
        # deferred approval flow (`smart`'s ApprovalReviewer judges them too).
        *build_mcp_capabilities(
            parse_mcp_servers(_setting(chat_settings, "mcp_servers")),
            gate=profile.approval_mode != "bypass",
        ),
        _planning_capability(_setting(chat_settings, "chat_id")),
        # skills=None -> all discovered; [] -> none; names -> include=frozenset.
        *_skills_capabilities(profile),
        # A profile tool allowlist (exact names and/or {server}_ prefixes)
        # wraps the whole assembled toolset — one wrap point covers Coder,
        # Planning, and MCP uniformly; `load_capability` is always kept.
        *(
            [
                ToolAllowlist(
                    allowed=frozenset(profile.tools or ()),
                    # Tolerate the catalog's glob form ('github_*') as well
                    # as the canonical prefix ('github_'); a bare '*' strips
                    # to '' and is dropped rather than admitting everything.
                    prefixes=frozenset(
                        p
                        for raw in profile.tool_prefixes
                        if (p := raw.removesuffix("*"))
                    ),
                )
            ]
            if profile.tools is not None or profile.tool_prefixes
            else []
        ),
        # Emits the `data-run-meta` chunk so the UI can badge the effective
        # (post-workspace-override) profile from the stream's first events.
        run_meta_hooks(profile.id, model_spec),
    ]

    return {
        "model": model,
        "capabilities": capabilities,
        # Run-level instructions append to the agent's own and every
        # capability's, so the `file:`-link guidance reaches the model under
        # every profile — including `read-only`, which builds no `Coder`.
        "instructions": FILE_LINK_INSTRUCTIONS,
        # Explicit backend pins the run's workspace so a stale WorkspaceRef in
        # history can't redirect file access elsewhere on the host.
        "workspace": LocalWorkspaceBackend(root),
        "usage_limits": UsageLimits(request_limit=REQUEST_LIMIT),
        # Chat's thinking level -> the unified ModelSettings.thinking field;
        # None when unset (the model keeps its default behavior).
        "model_settings": thinking_model_settings(
            _setting(chat_settings, "thinking")
        ),
    }


def _planning_capability(chat_id: str | None) -> Planning:
    """``Planning`` with a per-chat persisted plan when the chat id is known."""
    if not chat_id:
        return Planning()
    from pydantic_ai_harness.planning import SqlitePlanStore

    store = SqlitePlanStore(str(data_dir() / "plans.db"), session=str(chat_id))
    return Planning(store=store)
