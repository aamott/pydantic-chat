"""Resume an interrupted run mid-turn from its StepPersistence snapshot.

``POST /api/chats/{chat_id}/resume`` finds the chat's newest recorded run in
``steps.db``, takes its latest continuable snapshot (including
``interrupted`` ones), and continues the run as a normal Vercel AI UI Message
Stream — without re-executing tool work the snapshot proves settled.

Design (verified against installed sources):

- ``SqliteStepStore.list_runs(conversation_id=chat_id)`` is newest-last; the
  last run's ``latest_snapshot(run_id, include_interrupted=True)`` is the
  resume point (``pydantic_ai_harness.step_persistence._helpers.continue_run``
  semantics, inlined so the interrupted/complete adjudication stays visible).
- ``list_unresolved_tool_effects`` returns ``ToolEffectRecord``s whose latest
  status is ``started`` — the ``unknown_after_crash`` signal. Resuming an
  ``interrupted`` snapshot re-executes the pending calls, so the stream opens
  with a transient ``data-resume`` chunk naming them rather than silently
  trusting them.
- ``message_history`` cannot go through ``dispatch_request`` (a
  ``conversation_store`` run rejects it outright), so the route drives
  ``agent.run_stream_events(conversation=...)`` itself and saves via
  ``store.save(result.conversation)`` — the same content-comparison path that
  turns a divergent stored tail into ``record.branches``.
- A conversation parked on tool approval (``deferred_tool_requests`` on the
  stored record) is NOT resumable: the right continuation is answering the
  approvals, not a snapshot replay.
"""

import asyncio
import json
import threading

import pytest
from fastapi.testclient import TestClient
from pydantic_ai import CancellationToken
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence import (
    ContinuableSnapshot,
    RunRecord,
    SqliteStepStore,
    StepEvent,
    ToolEffectRecord,
)

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


def _chat_payload(
    chat_id: str, text: str = "hello agent", message_id: str = "m1"
) -> dict:
    """The AI SDK transport body: the chat id rides in the top-level ``id``."""
    return {
        "id": chat_id,
        "trigger": "submit-message",
        "messages": [
            {
                "id": message_id,
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


def _step_store(tmp_path) -> SqliteStepStore:
    return SqliteStepStore(database=tmp_path / "data" / "steps.db")


def _tool_returns(messages) -> list[ToolReturnPart]:
    """Every tool return part in a message history, in order."""
    return [
        part
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    ]


def _fail_after_shell_model(count_file, marker: str = "x") -> FunctionModel:
    """Call 1 shells ``echo {marker} >> count``; call 2 dies mid-response; later calls answer text.

    One model instance serves both the failing run and the resume run: its
    call counter is the phase, so ``resolve_model`` can return it any number
    of times without losing track.
    """
    calls = {"n": 0}

    async def stream_fn(messages, info):
        calls["n"] += 1
        if calls["n"] == 1:
            yield {
                0: DeltaToolCall(
                    name="shell",
                    json_args=json.dumps(
                        {"command": f"echo {marker} >> {count_file.name}"}
                    ),
                )
            }
        elif calls["n"] == 2:
            yield "partial"
            raise RuntimeError("provider blew up mid-run")
        else:
            yield "resumed continuation"

    return FunctionModel(stream_function=stream_fn)


async def test_resume_continues_failed_run_without_rerunning_settled_tool(
    client, monkeypatch
):
    """The acceptance path: fail after a settled shell call, resume, continue.

    The settled ``shell`` call does NOT re-execute (the snapshot's tool-return
    request is the resume point), the stream carries a ``data-resume`` notice,
    and the continued output lands on the stored conversation by append —
    the failed tail was the snapshot's prefix, so no branch is taken.
    """
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    _bypass_workspace(test_client, workspace["id"])
    chat = _create_chat(test_client, workspace["id"])

    # One shared model: its call counter is the run phase across both POSTs.
    model = _fail_after_shell_model(tmp_path / "count.txt")
    monkeypatch.setattr("app.agent.factory.resolve_model", lambda spec: model)
    response = test_client.post(
        "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
    )
    assert response.status_code == 200
    assert "error" in {event["type"] for event in _sse_events(response.text)}

    # Sanity: the settled shell call ran exactly once before the failure.
    count_file = tmp_path / "count.txt"
    assert count_file.read_text().count("\n") == 1

    # The probe advertises the resume point.
    probe = test_client.get(f"/api/chats/{chat['id']}/resume", headers=AUTH)
    assert probe.status_code == 200
    assert probe.json() == {"resumable": True, "reason": None}

    response = test_client.post(f"/api/chats/{chat['id']}/resume", headers=AUTH)
    assert response.status_code == 200
    events = _sse_events(response.text)
    types = {event["type"] for event in events}
    assert "finish" in types
    # Transient notice chunk: snapshot provenance + unknown-effect warning.
    resume_chunks = [e for e in events if e["type"] == "data-resume"]
    assert resume_chunks, "no data-resume notice in the resume stream"
    assert resume_chunks[0]["data"]["snapshot_state"] in {
        "complete",
        "interrupted",
    }

    # The settled shell call did NOT re-execute.
    assert count_file.read_text().count("\n") == 1

    # The continued output was appended to the stored conversation: the
    # persisted failed tail is the snapshot's prefix, so no branch is cut.
    store = test_client.app.state.store
    conversation = await store.load(chat["id"], scope=workspace["id"])
    assert conversation is not None
    texts = [
        part.content
        for message in conversation.messages
        if isinstance(message, ModelResponse)
        for part in message.parts
        if hasattr(part, "content") and isinstance(part.content, str)
    ]
    assert any("resumed continuation" in text for text in texts)


async def test_resume_replays_unknown_tool_effect_with_notice(client, monkeypatch):
    """An ``interrupted`` snapshot's pending call re-executes — visibly.

    A ``started`` tool-effect record is ``unknown_after_crash``: the resume
    stream's ``data-resume`` chunk names the call so the user sees that a
    side effect may be firing twice, and the call itself re-runs through the
    normal tool pipeline (here: ``bypass``, so it just executes).
    """
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    _bypass_workspace(test_client, workspace["id"])
    chat = _create_chat(test_client, workspace["id"])

    # Seed a dead run directly: interrupted snapshot with a pending shell
    # call + a `started` effect — the unknown_after_crash ledger entry.
    steps = _step_store(tmp_path)
    await steps.register_run(RunRecord(run_id="dead-run", conversation_id=chat["id"]))
    await steps.append_event(
        StepEvent(run_id="dead-run", kind="run_started", step_index=0)
    )
    await steps.append_event(
        StepEvent(run_id="dead-run", kind="run_failed", step_index=1)
    )
    count_file = tmp_path / "count.txt"
    await steps.save_snapshot(
        ContinuableSnapshot(
            run_id="dead-run",
            step_index=1,
            state="interrupted",
            conversation_id=chat["id"],
            messages=[
                ModelRequest(parts=[UserPromptPart("run the command")]),
                ModelResponse(
                    parts=[
                        ToolCallPart(
                            tool_name="shell",
                            args={"command": f"echo x >> {count_file.name}"},
                            tool_call_id="call-1",
                        )
                    ]
                ),
            ],
        )
    )
    await steps.record_tool_effect(
        ToolEffectRecord(
            tool_call_id="call-1",
            tool_name="shell",
            run_id="dead-run",
            status="started",
        )
    )

    calls = {"n": 0}

    async def stream_fn(messages, info):
        calls["n"] += 1
        yield "finished after replay"

    model = FunctionModel(stream_function=stream_fn)
    monkeypatch.setattr("app.agent.factory.resolve_model", lambda spec: model)

    response = test_client.post(f"/api/chats/{chat['id']}/resume", headers=AUTH)
    assert response.status_code == 200
    events = _sse_events(response.text)
    assert "finish" in {event["type"] for event in events}

    resume_chunks = [e for e in events if e["type"] == "data-resume"]
    assert resume_chunks
    data = resume_chunks[0]["data"]
    assert data["snapshot_state"] == "interrupted"
    unknown = {effect["tool_name"] for effect in data["unknown_effects"]}
    assert "shell" in unknown

    # The pending call re-executed through the normal pipeline.
    assert count_file.read_text().count("\n") == 1
    # And the run continued to the model afterwards.
    assert calls["n"] == 1


async def test_resume_after_cancel_closes_unfinished_tool(client, monkeypatch):
    """A run cancelled mid-tool-execute resumes without re-running the call.

    ``/stop`` interrupts the ``shell`` call while it runs: the effect ledger
    keeps the call ``started`` (unknown_after_crash), the run history gains an
    ``interrupted`` request marker, and ``on_run_error`` leaves an interrupted
    snapshot. Resume does NOT re-execute the unknown-side-effect call — the
    repair pipeline closes it with a synthesized ``interrupted`` return — and
    the ``data-resume`` notice names the unresolved effect so the user sees it.
    """
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    _bypass_workspace(test_client, workspace["id"])
    chat = _create_chat(test_client, workspace["id"])

    count_file = tmp_path / "count.txt"
    calls = {"n": 0}

    async def stream_fn(messages, info):
        calls["n"] += 1
        if calls["n"] == 1:
            yield {
                0: DeltaToolCall(
                    name="shell",
                    json_args=json.dumps(
                        {"command": (f"sleep 1 && echo x >> {count_file.name}")}
                    ),
                )
            }
        else:
            yield "finished after resume"

    model = FunctionModel(stream_function=stream_fn)
    monkeypatch.setattr("app.agent.factory.resolve_model", lambda spec: model)

    result: dict = {}

    def run_chat() -> None:
        result["response"] = test_client.post(
            "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
        )

    thread = threading.Thread(target=run_chat)
    thread.start()
    await asyncio.sleep(0.4)  # inside the shell call's 1s execution window
    test_client.post(f"/api/chats/{chat['id']}/stop", headers=AUTH)
    thread.join(timeout=30)
    assert not count_file.exists(), "cancel landed too late: tool finished"

    response = test_client.post(f"/api/chats/{chat['id']}/resume", headers=AUTH)
    assert response.status_code == 200
    events = _sse_events(response.text)
    assert "finish" in {event["type"] for event in events}
    # The interrupted call is NOT re-executed: an in-flight side effect is
    # unknowable, so the repair pipeline closes it with a synthesized
    # 'interrupted' return and the model is told the call did not finish.
    # (The orphaned subprocess from the cancelled attempt may itself complete
    # and append once — the invariant is the call never ran a SECOND time.)
    await asyncio.sleep(1.2)  # outlast the orphaned 'sleep 1', if any
    runs = count_file.read_text().count("\n") if count_file.exists() else 0
    assert runs <= 1
    # ...and the stream says so: the unknown-effect warning names the call.
    resume_chunks = [e for e in events if e["type"] == "data-resume"]
    assert resume_chunks
    names = [e["tool_name"] for e in resume_chunks[0]["data"]["unknown_effects"]]
    assert "shell" in names


async def test_resume_rejects_completed_run(client, monkeypatch):
    """A chat whose last run finished has nothing to resume: 409 + probe false."""
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    response = test_client.post(
        "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
    )
    assert response.status_code == 200
    assert "finish" in {event["type"] for event in _sse_events(response.text)}

    probe = test_client.get(f"/api/chats/{chat['id']}/resume", headers=AUTH)
    assert probe.status_code == 200
    body = probe.json()
    assert body["resumable"] is False

    response = test_client.post(f"/api/chats/{chat['id']}/resume", headers=AUTH)
    assert response.status_code == 409


async def test_resume_rejects_chat_with_no_runs(client):
    """A chat that never ran has no snapshot: 404 on both probe and POST."""
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    probe = test_client.get(f"/api/chats/{chat['id']}/resume", headers=AUTH)
    assert probe.status_code == 200
    assert probe.json()["resumable"] is False

    response = test_client.post(f"/api/chats/{chat['id']}/resume", headers=AUTH)
    assert response.status_code == 404


async def test_resume_rejects_while_run_in_progress(client):
    """A chat with a live run is not resumable: the stream itself owns it."""
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    test_client.app.state.cancellation_tokens[chat["id"]] = CancellationToken()
    try:
        response = test_client.post(f"/api/chats/{chat['id']}/resume", headers=AUTH)
        assert response.status_code == 409
    finally:
        test_client.app.state.cancellation_tokens.pop(chat["id"], None)


async def test_resume_rejects_pending_approvals(client, monkeypatch):
    """A run parked on tool approval is answered, not resumed.

    The default profile defers approval-required calls: the run completes
    with ``deferred_tool_requests`` on the stored record. Resume must refuse
    — the continuation is the approval answer itself.
    """
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    async def stream_fn(messages, info):
        yield {0: DeltaToolCall(name="shell", json_args='{"command": "echo hi"}')}

    monkeypatch.setattr(
        "app.agent.factory.resolve_model",
        lambda spec: FunctionModel(stream_function=stream_fn),
    )
    response = test_client.post(
        "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
    )
    assert response.status_code == 200

    # The run parked on approval.
    store = test_client.app.state.store
    record = await store.read_record(chat["id"])
    assert record is not None and record.deferred_tool_requests is not None

    response = test_client.post(f"/api/chats/{chat['id']}/resume", headers=AUTH)
    assert response.status_code == 409
    assert "approv" in response.json()["detail"].lower()


async def test_resubmit_after_resume_cuts_at_user_prompt(client, monkeypatch):
    """``ui_message_id`` durability: a resubmit after resume cuts, not appends.

    The resumed output carries no new ``UserPromptPart`` stamp — the original
    prompt's ``ui_message_id`` rides through the snapshot's deep-copied
    metadata — so resubmitting the same message matches the stored request,
    cuts there, and keeps the whole failed+resumed tail as a branch.
    """
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    _bypass_workspace(test_client, workspace["id"])
    chat = _create_chat(test_client, workspace["id"])

    model = _fail_after_shell_model(tmp_path / "count.txt")
    monkeypatch.setattr("app.agent.factory.resolve_model", lambda spec: model)
    test_client.post("/api/chat", json=_chat_payload(chat["id"]), headers=AUTH)
    resumed = test_client.post(f"/api/chats/{chat['id']}/resume", headers=AUTH)
    assert resumed.status_code == 200

    # Resubmit the same user message (id 'm1') with edited text.
    payload = _chat_payload(chat["id"], text="edited prompt", message_id="m1")
    response = test_client.post("/api/chat", json=payload, headers=AUTH)
    assert response.status_code == 200
    assert "finish" in {event["type"] for event in _sse_events(response.text)}

    store = test_client.app.state.store
    conversation = await store.load(chat["id"], scope=workspace["id"])
    assert conversation is not None
    prompts = [
        part.content
        for message in conversation.messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, UserPromptPart)
    ]
    # The resubmit replaced the prompt — not appended a duplicate.
    assert prompts.count("hello agent") == 0
    assert "edited prompt" in prompts

    record = await store.read_record(chat["id"])
    assert record is not None
    assert record.branches, "the replaced failed+resumed tail left no branch"
