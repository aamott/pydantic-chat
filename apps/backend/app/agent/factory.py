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
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from pydantic_ai import Agent, UsageLimits
from pydantic_ai.capabilities import LocalWorkspace
from pydantic_ai.workspaces import LocalWorkspaceBackend
from pydantic_ai_harness import ApprovalReviewer, Coder, Permissions, Planning
from pydantic_ai_harness.coder import FILE_TOOL_NAMES
from pydantic_ai_harness.filesystem import FileSystem
from pydantic_ai_harness.repo_context import RepoContext
from pydantic_ai_harness.shell import Shell

from app.agent.events import install_ui_event_bridge, run_meta_hooks
from app.agent.models import ProviderNotConfigured, resolve_model
from app.config import DEFAULT_MODEL, DEFAULT_PERMISSION_PROFILE, data_dir

if TYPE_CHECKING:
    from pydantic_ai.capabilities import AbstractCapability
    from pydantic_ai.models import Model

    from app.db.app_tables import Workspace

logger = logging.getLogger(__name__)

PermissionProfile = Literal["bypass", "smart", "manual", "read-only"]

REQUEST_LIMIT = 50
"""Max model turns per agent run — bounds runaway loops."""

SMART_DEFAULT_JUDGE = "anthropic:claude-haiku-4-5"
"""Default reviewer model spec for the ``smart`` profile (cheapest tier)."""

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


def resolve_permission_capabilities(
    profile: str = DEFAULT_PERMISSION_PROFILE,
    lists: PermissionLists | None = None,
    *,
    judge_model: str | Model | None = None,
) -> list[AbstractCapability]:
    """The capabilities a run needs for one permission profile.

    Args:
        profile: ``bypass`` (nothing asks), ``smart`` (an LLM reviewer
            auto-approves low-risk calls), ``manual`` (the human approves every
            write and command — ``Permissions('read-only')`` asks on both), or
            ``read-only`` (read tools only, no shell). Unknown values fall back
            to ``manual`` — the safest default.
        lists: User allow/deny lists passed through to ``Shell``/``FileSystem``.
        judge_model: Reviewer for ``smart`` — a ``Model`` or a
            ``provider:model`` spec resolved through the registry. Defaults to
            :data:`SMART_DEFAULT_JUDGE`; when it can't be configured (no key),
            ``smart`` falls back to ``manual``.

    Returns:
        The capability list to merge into ``build_run_kwargs``'s.
    """
    lists = lists or PermissionLists()

    if profile == "bypass":
        return [_coder_with_lists(lists), Permissions("full")]

    if profile == "smart":
        reviewer = _approval_reviewer(judge_model)
        if reviewer is not None:
            return [_coder_with_lists(lists), Permissions("auto"), reviewer]
        logger.warning("Smart profile has no usable judge model; falling back to manual")
        return _manual_capabilities(lists)

    if profile == "read-only":
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

    if profile != "manual":
        logger.warning("Unknown permission profile %r; using 'manual'", profile)
    return _manual_capabilities(lists)


def _approval_reviewer(judge_model: str | Model | None) -> ApprovalReviewer | None:
    """An ``ApprovalReviewer`` for the judge spec, or ``None`` when unconfigurable."""
    spec: str | Model = judge_model or SMART_DEFAULT_JUDGE
    try:
        model = spec if not isinstance(spec, str) else resolve_model(spec)
    except ProviderNotConfigured as error:
        logger.warning("Judge model unavailable for smart profile: %s", error)
        return None
    return ApprovalReviewer(model, question=APPROVAL_RISK_QUESTION)


_AGENT: Agent[None, str] = Agent(
    None,
    instructions="You are a helpful coding assistant working inside the user's workspace.",
)
"""One shared ``Agent``; model and capabilities arrive per run."""

install_ui_event_bridge(_AGENT)
"""Bridge capability events (plan changes, shell progress) into `data-*` chunks."""


def get_agent() -> Agent[None, str]:
    """The shared agent — minimal instructions; ``Coder`` brings its own per run."""
    return _AGENT


def build_run_kwargs(
    chat_settings: Mapping[str, Any] | Any,
    workspace: Workspace | str | Path,
) -> dict[str, Any]:
    """The per-run keyword args for ``VercelAIAdapter.dispatch_request``.

    Args:
        chat_settings: A mapping (or object with attributes) carrying the run's
            settings — ``model`` (a ``provider:model`` spec), ``permission_profile``,
            ``judge_model``, the four allow/deny lists, and ``chat_id`` (scopes
            the persistent plan). Missing keys fall back to safe defaults.
        workspace: The app ``Workspace`` row, or a bare path.

    Returns:
        ``dict`` with ``model``, ``capabilities``, ``workspace``, and
        ``usage_limits`` ready to splat into ``dispatch_request``.

    Raises:
        ProviderNotConfigured: If the model's provider has no credentials.
    """
    root = Path(getattr(workspace, "path", workspace))
    profile = _setting(chat_settings, "permission_profile") or DEFAULT_PERMISSION_PROFILE
    lists = PermissionLists(
        allowed_commands=tuple(_setting(chat_settings, "allowed_commands") or ()),
        denied_commands=tuple(_setting(chat_settings, "denied_commands") or ()),
        allowed_patterns=tuple(_setting(chat_settings, "allowed_patterns") or ()),
        denied_patterns=tuple(_setting(chat_settings, "denied_patterns") or ()),
    )
    model_spec = _setting(chat_settings, "model") or DEFAULT_MODEL
    judge_model = _setting(chat_settings, "judge_model")

    read_only = profile == "read-only"
    capabilities: list[AbstractCapability] = [
        LocalWorkspace(root, read_only=read_only),
        *resolve_permission_capabilities(profile, lists, judge_model=judge_model),
        _planning_capability(_setting(chat_settings, "chat_id")),
        # Emits the `data-run-meta` chunk so the UI can badge the effective
        # (post-workspace-override) profile from the stream's first events.
        run_meta_hooks(profile, model_spec),
    ]

    return {
        "model": resolve_model(model_spec),
        "capabilities": capabilities,
        # Run-level instructions append to the agent's own and every
        # capability's, so the `file:`-link guidance reaches the model under
        # every profile — including `read-only`, which builds no `Coder`.
        "instructions": FILE_LINK_INSTRUCTIONS,
        # Explicit backend pins the run's workspace so a stale WorkspaceRef in
        # history can't redirect file access elsewhere on the host.
        "workspace": LocalWorkspaceBackend(root),
        "usage_limits": UsageLimits(request_limit=REQUEST_LIMIT),
    }


def _planning_capability(chat_id: str | None) -> Planning:
    """``Planning`` with a per-chat persisted plan when the chat id is known."""
    if not chat_id:
        return Planning()
    from pydantic_ai_harness.planning import SqlitePlanStore

    store = SqlitePlanStore(str(data_dir() / "plans.db"), session=str(chat_id))
    return Planning(store=store)
