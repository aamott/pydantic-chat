"""StepPersistence mid-turn snapshots: settled tool boundaries and run errors land in ``steps.db``.

Verified against ``pydantic-ai-harness==0.68.0``:

- ``StepPersistence`` is an ``AbstractCapability`` — it rides in
  ``build_run_kwargs``'s per-run ``capabilities`` list, not on the ``Agent``.
- ``SqliteStepStore(database=path)`` owns its own schema (runs, events,
  snapshots, tool effects + media) and opens short-lived WAL connections
  per call — a sibling file to ``plans.db``, which ``_planning_capability``
  already places in ``data_dir()``.
- ``RunRecord.conversation_id`` / ``ContinuableSnapshot.conversation_id``
  carry ``ctx.conversation_id``, which the adapter populates with the chat
  id, so ``list_runs(conversation_id=chat_id)`` finds a chat's runs
  newest-last — the lookup a future ``continue_run`` resume needs.
- Snapshots land at every settled ``CallToolsNode`` boundary — the pending
  tool-return request folded in, ``state='complete'`` — and ``on_run_error``
  rescues the at-failure history plus a ``run_failed`` event.
"""

import json

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelRequest, ModelResponse, ToolReturnPart
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence import SqliteStepStore, StepPersistence

from app.agent.factory import build_run_kwargs
from app.config import data_dir
from app.main import create_app

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A TestClient over a fresh app, with the model resolver stubbed."""
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("APP_TOKEN", TOKEN)
    monkeypatch.setattr(
        "app.agent.factory.resolve_model",
        lambda spec: TestModel(call_tools=[], custom_output_text="hi there"),
    )
    # TrustedHostMiddleware only allows loopback hosts.
    with TestClient(create_app(), base_url="http://127.0.0.1") as test_client:
        yield test_client, tmp_path


def _create_workspace(client, path) -> dict:
    response = client.post("/api/workspaces", json={"path": str(path)}, headers=AUTH)
    assert response.status_code == 200
    return response.json()


def _create_chat(client, workspace_id: str) -> dict:
    response = client.post(
        f"/api/workspaces/{workspace_id}/chats", json={}, headers=AUTH
    )
    assert response.status_code == 201
    return response.json()


def _bypass_workspace(client, workspace_id: str) -> None:
    """Switch the workspace to ``bypass`` so tool calls execute, no approval."""
    response = client.patch(
        f"/api/workspaces/{workspace_id}",
        json={"permission_profile": "bypass"},
        headers=AUTH,
    )
    assert response.status_code == 200


def _chat_payload(chat_id: str, text: str = "hello agent") -> dict:
    """The AI SDK transport body: the chat id rides in the top-level ``id``."""
    return {
        "id": chat_id,
        "trigger": "submit-message",
        "messages": [
            {
                "id": "m1",
                "role": "user",
                "parts": [{"type": "text", "text": text}],
            }
        ],
    }


def _sse_events(body: str) -> list[dict]:
    """Parse ``data: {...}`` lines of a Vercel AI UI Message Stream body."""
    events = []
    for line in body.splitlines():
        if line.startswith("data: ") and line != "data: [DONE]":
            events.append(json.loads(line[6:]))
    return events


def _tool_returns(messages) -> list[ToolReturnPart]:
    """Every tool return part in a message history, in order."""
    return [
        part
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    ]


def test_build_run_kwargs_adds_step_persistence(tmp_path, monkeypatch):
    """The per-run capability list carries ``StepPersistence`` on ``data_dir()/steps.db``.

    ``run_id``/``agent_name`` stay unset: the run id derives from
    ``ctx.run_id`` (unique per run, no ``register_run`` collision) and the
    recorded agent name falls back to ``ctx.agent.name``.
    """
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr("app.agent.factory.resolve_model", lambda spec: TestModel())

    kwargs = build_run_kwargs({"model": "test"}, tmp_path)
    persistence = [c for c in kwargs["capabilities"] if isinstance(c, StepPersistence)]
    assert len(persistence) == 1, "expected exactly one StepPersistence capability"
    capability = persistence[0]
    assert isinstance(capability.store, SqliteStepStore)
    # No public accessor for the path — the wiring is what matters here.
    assert capability.store._database == data_dir() / "steps.db"
    assert capability.run_id is None
    assert capability.agent_name is None


def _shell_then_text_model(command: str = "echo step-check") -> FunctionModel:
    """First request calls ``shell``; every later one answers with text."""
    calls = {"count": 0}

    async def stream_fn(messages, info):
        calls["count"] += 1
        if calls["count"] == 1:
            yield {
                0: DeltaToolCall(
                    name="shell", json_args=json.dumps({"command": command})
                )
            }
        else:
            yield "finished the turn"

    return FunctionModel(stream_function=stream_fn)


async def test_settled_tool_boundary_writes_snapshot(client, monkeypatch):
    """A completed tool call lands a ``complete`` snapshot in ``steps.db`` mid-run.

    The boundary snapshot's tail is the settled tool-return request — the
    pending ``ModelRequestNode`` folded in — so the point is durable the
    moment the tool completes. The finished run's ``after_run`` then saves
    the closing response as a later snapshot.
    """
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    _bypass_workspace(test_client, workspace["id"])
    chat = _create_chat(test_client, workspace["id"])

    monkeypatch.setattr(
        "app.agent.factory.resolve_model",
        lambda spec: _shell_then_text_model(),
    )
    response = test_client.post(
        "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
    )
    assert response.status_code == 200
    assert "finish" in {event["type"] for event in _sse_events(response.text)}

    steps_db = tmp_path / "data" / "steps.db"
    assert steps_db.exists(), "StepPersistence wrote no steps.db"
    store = SqliteStepStore(database=steps_db)
    runs = await store.list_runs(conversation_id=chat["id"])
    assert runs, "no RunRecord carries the chat's conversation id"
    run = runs[-1]

    events = await store.list_events(run_id=run.run_id)
    kinds = {event.kind for event in events}
    assert {
        "run_started",
        "tool_call_started",
        "tool_call_completed",
        "run_completed",
    } <= kinds

    snapshots = await store.list_snapshots(run_id=run.run_id)
    assert snapshots, "no snapshots recorded for the run"
    assert all(snapshot.state == "complete" for snapshot in snapshots)
    assert snapshots[-1].conversation_id == chat["id"]
    # At least one snapshot captured the settled boundary itself: a trailing
    # tool-return request answering the shell call.
    boundary = [
        snapshot for snapshot in snapshots if _tool_returns([snapshot.messages[-1]])
    ]
    assert boundary, "no snapshot captured the settled tool boundary"
    assert _tool_returns(boundary[-1].messages)[-1].tool_name == "shell"

    # Completed call -> nothing left in the unresolved-effects ledger.
    assert await store.list_unresolved_tool_effects(run_id=run.run_id) == []


async def test_run_error_saves_at_failure_snapshot(client, monkeypatch):
    """``on_run_error`` persists the at-failure history and a ``run_failed`` event.

    The model completes one ``shell`` call (a settled boundary), then dies
    mid-response on the next request. The rescued snapshot extends past the
    boundary snapshot — the in-flight response sits at its tail — and still
    carries the completed tool work a resume would not re-run.
    """
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    _bypass_workspace(test_client, workspace["id"])
    chat = _create_chat(test_client, workspace["id"])

    calls = {"count": 0}

    async def fail_stream(messages, info):
        calls["count"] += 1
        if calls["count"] == 1:
            yield {
                0: DeltaToolCall(
                    name="shell", json_args='{"command": "echo pre-failure"}'
                )
            }
        else:
            yield "partial"
            raise RuntimeError("provider blew up mid-run")

    monkeypatch.setattr(
        "app.agent.factory.resolve_model",
        lambda spec: FunctionModel(stream_function=fail_stream),
    )
    response = test_client.post(
        "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
    )
    # The error travels as a stream chunk, not an HTTP error status.
    assert response.status_code == 200
    assert "error" in {event["type"] for event in _sse_events(response.text)}

    steps_db = tmp_path / "data" / "steps.db"
    assert steps_db.exists(), "StepPersistence wrote no steps.db"
    store = SqliteStepStore(database=steps_db)
    runs = await store.list_runs(conversation_id=chat["id"])
    assert runs, "no RunRecord carries the chat's conversation id"
    run = runs[-1]

    events = await store.list_events(run_id=run.run_id)
    kinds = {event.kind for event in events}
    assert "run_failed" in kinds, "on_run_error never recorded the failure"
    assert "run_completed" not in kinds

    snapshot = await store.latest_snapshot(run_id=run.run_id, include_interrupted=True)
    assert snapshot is not None, "on_run_error saved no at-failure snapshot"
    # Completed tool work survives in the resume point.
    assert _tool_returns(snapshot.messages), (
        "at-failure snapshot lost the completed tool return"
    )
    # And it reaches past the settled boundary: the response the run died on
    # is at the tail, which a boundary snapshot (trailing tool-return
    # request) could not produce.
    assert isinstance(snapshot.messages[-1], ModelResponse)
