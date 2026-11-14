"""Tests for the capability-event -> ``data-*`` chunk bridge in ``app.agent.events``.

The bridge republishes ``CapabilityEvent`` subclasses (which the Vercel AI
adapter deliberately drops) as ``CustomEvent`` subclasses, which serialize to
``data-{name}``
chunks automatically. These tests pin the mapping and the wire shape.
"""

from pydantic_ai.capabilities import WrapperCapability
from pydantic_ai.ui.vercel_ai import VercelAIEventStream
from pydantic_ai.ui.vercel_ai.response_types import DataChunk
from pydantic_ai_harness.planning import (
    InMemoryPlanStore,
    PlanCreatedEvent,
    PlanItem,
    Planning,
    TaskStatus,
)
from pydantic_ai_harness.shell import (
    CommandFinishedEvent,
    CommandOutputEvent,
    CommandStartedEvent,
)

from app.agent import events


class _StubCtx:
    """The two ``RunContext`` facets the bridge listeners touch."""

    def __init__(self, capabilities: dict | None = None) -> None:
        self.capabilities = capabilities or {}
        self.emitted = []

    async def emit(self, event):
        self.emitted.append(event)
        return event


async def test_plan_event_republished_as_snapshot():
    """A planning mutation emits a `data-plan` snapshot of the whole store."""
    store = InMemoryPlanStore()
    await store.set_items(
        [
            PlanItem(content="write tests", status=TaskStatus.in_progress),
            PlanItem(content="ship it"),
        ]
    )
    ctx = _StubCtx({"planning": Planning(store=store)})

    await events.publish_plan_snapshot(
        ctx, PlanCreatedEvent(item=PlanItem(content="write tests"))
    )

    (event,) = ctx.emitted
    assert isinstance(event, events.PlanSnapshotEvent)
    assert event.change == "created"
    assert [task["content"] for task in event.tasks] == [
        "write tests",
        "ship it",
    ]
    assert event.tasks[0]["status"] == "in_progress"
    assert set(event.tasks[0]) == {"id", "content", "status", "active_form"}


async def test_plan_snapshot_emitted_through_wrapped_capability():
    """A `WrapperCapability`-wrapped `Planning` still resolves its store."""
    store = InMemoryPlanStore()
    await store.set_items([PlanItem(content="x")])
    wrapped = WrapperCapability(wrapped=Planning(store=store))
    ctx = _StubCtx({"coder": wrapped})

    await events.publish_plan_snapshot(
        ctx, PlanCreatedEvent(item=PlanItem(content="x"))
    )

    (event,) = ctx.emitted
    assert event.tasks[0]["content"] == "x"


async def test_plan_event_without_planning_emits_nothing():
    ctx = _StubCtx({})
    await events.publish_plan_snapshot(
        ctx, PlanCreatedEvent(item=PlanItem(content="x"))
    )
    assert ctx.emitted == []


async def test_plan_snapshot_serializes_to_data_plan_chunk():
    """`handle_custom_event` renders the event as a `data-plan` wire chunk."""
    stream = VercelAIEventStream(sdk_version=7)
    chunks = [
        chunk
        async for chunk in stream.handle_custom_event(
            events.PlanSnapshotEvent(
                change="created",
                tasks=[
                    {
                        "id": "ab12",
                        "content": "do x",
                        "status": "pending",
                        "active_form": "",
                    }
                ],
            )
        )
    ]
    (chunk,) = chunks
    assert isinstance(chunk, DataChunk)
    assert chunk.type == "data-plan"
    assert chunk.data["change"] == "created"
    assert chunk.data["tasks"][0]["content"] == "do x"


def test_shell_event_phases_map_to_activity():
    """Each `shell.*` event maps onto one `data-shell` phase, with attribution."""
    started = events._shell_activity(
        CommandStartedEvent(
            command="ls -la", pid=1234, tool_call_id="tc-1", tool_name="shell"
        )
    )
    assert started.phase == "started"
    assert started.command == "ls -la"
    assert started.pid == 1234
    payload = started.to_payload()
    assert payload["tool_call_id"] == "tc-1"
    assert payload["tool_name"] == "shell"

    output = events._shell_activity(CommandOutputEvent(text="chunk of stdout"))
    assert output.phase == "output"
    assert output.text == "chunk of stdout"

    finished = events._shell_activity(
        CommandFinishedEvent(
            pid=1234,
            output_path="out.log",
            status_path="status.json",
            exit_code=0,
            truncated=False,
            line_count=7,
        )
    )
    assert finished.phase == "finished"
    assert finished.exit_code == 0
    assert finished.line_count == 7


async def test_shell_activity_serializes_to_data_shell_chunk():
    stream = VercelAIEventStream(sdk_version=7)
    activity = events._shell_activity(
        CommandStartedEvent(command="pytest", pid=9, tool_call_id="tc-2")
    )
    chunks = [chunk async for chunk in stream.handle_custom_event(activity)]
    (chunk,) = chunks
    assert chunk.type == "data-shell"
    assert chunk.data["phase"] == "started"
    assert chunk.data["command"] == "pytest"
    assert chunk.data["tool_call_id"] == "tc-2"


async def test_run_meta_hooks_emit_run_meta_event():
    """The `Hooks(before_run)` capability emits `data-run-meta` at run start."""
    hooks = events.run_meta_hooks("bypass", "anthropic:claude-sonnet-4-6")
    ctx = _StubCtx()
    await hooks.before_run(ctx)
    (event,) = ctx.emitted
    assert isinstance(event, events.RunMetaEvent)
    assert event.permission_profile == "bypass"
    assert event.model == "anthropic:claude-sonnet-4-6"


async def test_run_meta_serializes_to_data_run_meta_chunk():
    stream = VercelAIEventStream(sdk_version=7)
    chunks = [
        chunk
        async for chunk in stream.handle_custom_event(
            events.RunMetaEvent(permission_profile="smart", model="openai:gpt-5")
        )
    ]
    (chunk,) = chunks
    assert chunk.type == "data-run-meta"
    assert chunk.data == {
        "permission_profile": "smart",
        "model": "openai:gpt-5",
    }
