"""UI-facing custom events bridged from capability events.

Pydantic AI deliberately keeps ``CapabilityEvent`` subclasses off the frontend:
``VercelAIEventStream.handle_capability_event`` is a no-op, so the UI message
stream never sees them. The supported bridge is an
``Agent.on_event`` listener that republishes the public part as a
``CustomEvent``, which ``handle_custom_event`` serializes into a
``data-{name}`` chunk automatically — no event-stream wrapping needed.

Wire contract (Vercel AI UI Message Stream ``data-*`` chunks):

- ``data-plan`` — emitted once per plan-mutation event. ``data`` is::

    {"change": "created"|"updated"|"status_changed"|"completed"|"deleted",
     "tasks": [{"id": str, "content": str, "status": str, "active_form": str}]}

  ``tasks`` is the *full* current plan read back from the run's plan store, so
  a card can render the latest chunk alone — repeated snapshots between two
  mutations are possible (the read happens at stream-dispatch time), and the
  last one is always current.
- ``data-shell`` — live shell progress a ``tool-output`` part can't carry:
  that part only arrives when the call returns, while these stream during it.
  ``data`` is::

    {"phase": "started"|"output"|"finished",
     "tool_call_id": str | None, "tool_name": str | None,
     "command": str | None, "pid": int | None, "text": str | None,
     "exit_code": int | None, "truncated": bool | None,
     "line_count": int | None, "output_path": str | None,
     "status_path": str | None}

  ``started`` carries ``command``/``pid``; ``output`` carries bounded
  ``text`` chunks (the harness caps them); ``finished`` fires when the tool
  stops waiting — ``exit_code`` stays ``None`` while the command still runs
  detached.
- ``data-run-meta`` — emitted once at run start by the ``Hooks`` capability
  :func:`run_meta_hooks` builds into every run: ``{"permission_profile": str,
  "model": str}`` — the *effective* values after any workspace override, for
  the UI's badge.

None of these persist into stored history (custom events are stream-only), so
a reloaded transcript has no ``data-plan``/``data-shell`` parts; the plan
itself survives in ``plans.db`` and inside the plan tools' ``<plan_reminder>``
returns.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from pydantic_ai import CustomEvent
from pydantic_ai.capabilities import Hooks, WrapperCapability
from pydantic_ai_harness.planning import (
    PLANNING_EVENTS,
    PlanCompletedEvent,
    PlanCreatedEvent,
    PlanDeletedEvent,
    Planning,
    PlanStatusChangedEvent,
    PlanUpdatedEvent,
)
from pydantic_ai_harness.shell import (
    CommandFinishedEvent,
    CommandOutputEvent,
    CommandStartedEvent,
)

if TYPE_CHECKING:
    from pydantic_ai.agent import AbstractAgent
    from pydantic_ai.tools import RunContext
    from pydantic_ai_harness.planning import PlanItem

logger = logging.getLogger(__name__)

PLAN_CHANGE_EVENTS = (
    PlanCreatedEvent,
    PlanUpdatedEvent,
    PlanStatusChangedEvent,
    PlanCompletedEvent,
    PlanDeletedEvent,
)
"""Every ``CapabilityEvent`` subclass the ``Planning`` tools can emit."""

SHELL_PROGRESS_EVENTS = (
    CommandStartedEvent,
    CommandOutputEvent,
    CommandFinishedEvent,
)
"""Every ``CapabilityEvent`` subclass the persistent ``shell`` tool emits."""


@dataclass(kw_only=True)
class PlanSnapshotEvent(CustomEvent, name="plan"):
    """Full task list after a plan change — wire name ``data-plan``."""

    change: str
    """The ``planning.*`` event kind without its namespace, e.g. ``'created'``."""
    tasks: list[dict[str, Any]]
    """Every plan step, in order: ``{id, content, status, active_form}``."""


@dataclass(kw_only=True)
class ShellActivityEvent(CustomEvent, name="shell"):
    """One shell progress update — wire name ``data-shell``.

    Nullable fields keep the payload's key set stable across phases, so the
    frontend can destructure without probing for key presence.
    """

    phase: str
    """``'started'`` | ``'output'`` | ``'finished'``."""
    command: str | None = None
    pid: int | None = None
    text: str | None = None
    exit_code: int | None = None
    truncated: bool | None = None
    line_count: int | None = None
    output_path: str | None = None
    status_path: str | None = None

    def to_payload(self) -> dict[str, Any]:
        """Payload plus tool attribution — envelope fields are excluded by default."""
        return {
            **super().to_payload(),
            "tool_call_id": self.tool_call_id,
            "tool_name": self.tool_name,
        }


@dataclass(kw_only=True)
class RunMetaEvent(CustomEvent, name="run-meta"):
    """Effective run settings announced at stream start — wire name ``data-run-meta``."""

    permission_profile: str
    model: str


def run_meta_hooks(permission_profile: str, model: str) -> Hooks[Any]:
    """A ``Hooks`` capability emitting ``data-run-meta`` once, at run start.

    ``Hooks`` is the in-tree opt-out for app-facing ``CustomEvent`` emission
    (``_emits_app_events``), so its ``before_run`` hook may ``ctx.emit`` where
    a tool-facing capability's could not.
    """

    async def emit_meta(ctx: RunContext[Any]) -> None:
        await ctx.emit(RunMetaEvent(permission_profile=permission_profile, model=model))

    return Hooks(before_run=emit_meta)


def install_ui_event_bridge(agent: AbstractAgent[Any, Any]) -> None:
    """Subscribe the agent-level listeners that republish capability events as ``data-*`` chunks.

    Registered once on the shared ``Agent``; the listeners see per-run
    capability events for every run the agent serves.
    """

    @agent.on_event(*PLAN_CHANGE_EVENTS)
    async def _publish_plan(ctx: RunContext[Any], event: Any) -> None:
        await publish_plan_snapshot(ctx, event)

    @agent.on_event(*SHELL_PROGRESS_EVENTS)
    async def _publish_shell(ctx: RunContext[Any], event: Any) -> None:
        await ctx.emit(_shell_activity(event))


async def publish_plan_snapshot(ctx: RunContext[Any], event: Any) -> None:
    """Re-emit one ``planning.*`` event as a ``data-plan`` snapshot chunk.

    The snapshot is re-read from the run's plan store at dispatch time rather
    than reconstructed event-by-event, so consecutive events can carry the
    same (always-current) state. A missing store — a run without ``Planning``
    — or a read failure degrades to no chunk, never a broken stream.
    """
    planning = _run_planning(ctx)
    if planning is None:
        return
    try:
        items = await planning.resolve_store(ctx).get_items()
    except Exception:
        # A cosmetic feature must not take the stream down with it.
        logger.exception("Could not read plan store for data-plan snapshot")
        return
    await ctx.emit(
        PlanSnapshotEvent(
            change=event.kind.removeprefix(f"{PLANNING_EVENTS}."),
            tasks=[_task_payload(item) for item in items],
        )
    )


def _run_planning(ctx: RunContext[Any]) -> Planning[Any] | None:
    """The run's ``Planning`` capability instance, unwrapping any wrappers."""
    for capability in ctx.capabilities.values():
        while isinstance(capability, WrapperCapability):
            capability = capability.wrapped
        if isinstance(capability, Planning):
            return capability
    return None


def _task_payload(item: PlanItem) -> dict[str, Any]:
    """One plan step inside a ``data-plan`` chunk's ``tasks`` list."""
    return {
        "id": item.id,
        "content": item.content,
        "status": item.status.value,
        "active_form": item.active_form,
    }


def _shell_activity(event: Any) -> ShellActivityEvent:
    """Map a ``shell.*`` capability event onto its ``data-shell`` payload."""
    attribution = {
        "tool_call_id": event.tool_call_id,
        "tool_name": event.tool_name,
    }
    if isinstance(event, CommandStartedEvent):
        return ShellActivityEvent(
            phase="started", command=event.command, pid=event.pid, **attribution
        )
    if isinstance(event, CommandOutputEvent):
        return ShellActivityEvent(phase="output", text=event.text, **attribution)
    return ShellActivityEvent(
        phase="finished",
        pid=event.pid,
        output_path=event.output_path,
        status_path=event.status_path,
        exit_code=event.exit_code,
        truncated=event.truncated,
        line_count=event.line_count,
        **attribution,
    )
