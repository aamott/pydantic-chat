"""Tests for the agent streaming endpoint: POST /api/chat + POST /api/chats/{id}/stop.

Runs use pydantic-ai's ``TestModel``/``FunctionModel`` injected by monkeypatching
``app.agent.factory.resolve_model`` — no provider keys or network involved.
"""

import json
import threading
import time

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel

from app.agent.models import ProviderNotConfigured, UnknownProviderError
from app.api.chat import _run_settings
from app.main import create_app

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A TestClient over a fresh app, with the model resolver stubbed to TestModel."""
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


def _create_chat(client, workspace_id: str, body: dict | None = None) -> dict:
    response = client.post(
        f"/api/workspaces/{workspace_id}/chats", json=body or {}, headers=AUTH
    )
    assert response.status_code == 201
    return response.json()


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


def test_chat_requires_auth(client):
    test_client, _ = client
    assert test_client.post("/api/chat", json={}).status_code == 401
    assert test_client.post("/api/chats/x/stop").status_code == 401
    assert test_client.get("/api/chat/x/stream").status_code == 401


def test_chat_streams_sse_and_persists(client):
    """A submit run streams the UI message stream, saves history, and titles the chat."""
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    response = test_client.post(
        "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
    )
    assert response.status_code == 200
    assert response.headers["x-vercel-ai-ui-message-stream"] == "v1"
    assert response.headers["content-type"].startswith("text/event-stream")

    events = _sse_events(response.text)
    types = {event["type"] for event in events}
    assert "start" in types
    assert "text-delta" in types
    assert "finish" in types
    text = "".join(
        event.get("delta", "") for event in events if event["type"] == "text-delta"
    )
    assert "hi there" in text

    # Server-side history: the conversation store saved user + assistant messages.
    messages = test_client.get(
        f"/api/chats/{chat['id']}/messages", headers=AUTH
    ).json()
    assert [m["role"] for m in messages] == ["user", "assistant"]
    assert messages[0]["parts"][0]["text"] == "hello agent"

    # First-run auto-title from the user prompt; the run also bumped updated_at.
    updated = test_client.get("/api/workspaces", headers=AUTH).json()[0]["chats"][0]
    assert updated["title"] == "hello agent"

    # The run's cancellation token was released when the stream ended.
    assert test_client.app.state.cancellation_tokens == {}


def test_chat_title_truncates_and_keeps_custom_titles(client):
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])
    long_prompt = "word " * 30  # 150 chars -> truncated
    response = test_client.post(
        "/api/chat", json=_chat_payload(chat["id"], long_prompt), headers=AUTH
    )
    assert response.status_code == 200
    stored = test_client.get("/api/workspaces", headers=AUTH).json()[0]["chats"][0]
    assert len(stored["title"]) <= 41  # ~40 chars + ellipsis
    assert stored["title"].endswith("…")

    # A user-named chat is never overwritten by a run.
    named = _create_chat(test_client, workspace["id"], {"title": "Named"})
    response = test_client.post(
        "/api/chat", json=_chat_payload(named["id"]), headers=AUTH
    )
    assert response.status_code == 200
    stored = test_client.get("/api/workspaces", headers=AUTH).json()[0]["chats"]
    assert next(c for c in stored if c["id"] == named["id"])["title"] == "Named"


def test_chat_unknown_chat_404(client):
    test_client, _ = client
    response = test_client.post(
        "/api/chat", json=_chat_payload("no-such-chat"), headers=AUTH
    )
    assert response.status_code == 404


def test_stream_replay_after_completed_run(client):
    """After a run completes, GET stream replays the stored response as SSE."""
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    response = test_client.post(
        "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
    )
    assert response.status_code == 200

    replay = test_client.get(f"/api/chat/{chat['id']}/stream", headers=AUTH)
    assert replay.status_code == 200
    assert replay.headers["x-vercel-ai-ui-message-stream"] == "v1"
    assert replay.headers["content-type"].startswith("text/event-stream")

    events = _sse_events(replay.text)
    types = [event["type"] for event in events]
    assert types[0] == "start"
    assert "text-delta" in types
    assert types[-1] == "finish"

    text = "".join(
        event.get("delta", "") for event in events if event["type"] == "text-delta"
    )
    assert "hi there" in text

    # The replayed message id is the one the transcript dump assigns, so a
    # client replaces its seeded message instead of appending a duplicate.
    stored = test_client.get(
        f"/api/chats/{chat['id']}/messages", headers=AUTH
    ).json()
    assistant_id = next(m["id"] for m in stored if m["role"] == "assistant")
    assert events[0]["messageId"] == assistant_id


def test_stream_replay_404s(client):
    """Unknown chats, and known chats with nothing stored, return 404."""
    test_client, tmp_path = client
    assert (
        test_client.get("/api/chat/no-such-chat/stream", headers=AUTH).status_code
        == 404
    )

    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])
    # Chat exists but no run has persisted a conversation yet.
    assert (
        test_client.get(f"/api/chat/{chat['id']}/stream", headers=AUTH).status_code
        == 404
    )


def test_chat_bad_body_422(client):
    test_client, _ = client
    # Valid JSON but no `id` field.
    assert (
        test_client.post(
            "/api/chat",
            json={"trigger": "submit-message", "messages": []},
            headers=AUTH,
        ).status_code
        == 422
    )
    # Not JSON at all.
    assert (
        test_client.post(
            "/api/chat",
            content=b"not-json",
            headers={**AUTH, "Content-Type": "application/json"},
        ).status_code
        == 422
    )


def test_chat_provider_errors_map(client, monkeypatch):
    """ProviderNotConfigured -> 402, UnknownProviderError -> 400."""
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    def unconfigured(spec):
        raise ProviderNotConfigured("anthropic", "'anthropic' is not configured: key missing")

    monkeypatch.setattr("app.agent.factory.resolve_model", unconfigured)
    response = test_client.post(
        "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
    )
    assert response.status_code == 402

    def unknown(spec):
        raise UnknownProviderError("bogus")

    monkeypatch.setattr("app.agent.factory.resolve_model", unknown)
    response = test_client.post(
        "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
    )
    assert response.status_code == 400


def test_stop_without_run_404(client):
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])
    response = test_client.post(f"/api/chats/{chat['id']}/stop", headers=AUTH)
    assert response.status_code == 404


async def test_run_settings_workspace_profile_override(tmp_path, monkeypatch):
    """A workspace's permission_profile beats the global; NULL inherits it."""
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "data"))
    from app.db.store import ChatStore

    store = ChatStore(tmp_path / "app.db")
    try:
        workspace = await store.get_or_create_workspace(tmp_path / "ws")
        chat = await store.create_chat(workspace.id)
        await store.set_setting("permission_profile", "manual")

        settings = await _run_settings(store, chat, workspace)
        assert settings["permission_profile"] == "manual"

        await store.set_workspace_permission_profile(workspace.id, "bypass")
        workspace = await store.get_workspace(workspace.id)
        settings = await _run_settings(store, chat, workspace)
        assert settings["permission_profile"] == "bypass"
    finally:
        store.close()


def test_plan_shell_and_run_meta_data_chunks(client, monkeypatch):
    """Tool calls surface `data-plan`/`data-shell` chunks; `data-run-meta` opens the run."""
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    # `bypass` lets the tools execute without approval — and exercises the
    # workspace override end to end (run-meta must report it, not the default).
    patched = test_client.patch(
        f"/api/workspaces/{workspace['id']}",
        json={"permission_profile": "bypass"},
        headers=AUTH,
    )
    assert patched.status_code == 200
    chat = _create_chat(test_client, workspace["id"])

    from pydantic_ai.models.function import DeltaToolCall

    calls = {"count": 0}

    async def stream_fn(messages, info):
        calls["count"] += 1
        if calls["count"] == 1:
            yield {
                0: DeltaToolCall(
                    name="write_plan",
                    json_args='{"items": [{"content": "ship the feature"}]}',
                )
            }
        elif calls["count"] == 2:
            yield {
                0: DeltaToolCall(
                    name="shell",
                    json_args='{"command": "echo hello-shell"}',
                )
            }
        else:
            yield "all done"

    monkeypatch.setattr(
        "app.agent.factory.resolve_model",
        lambda spec: FunctionModel(stream_function=stream_fn),
    )
    response = test_client.post(
        "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
    )
    assert response.status_code == 200

    events = _sse_events(response.text)
    meta = [e for e in events if e["type"] == "data-run-meta"]
    assert meta, "data-run-meta chunk missing from stream"
    assert meta[0]["data"]["permission_profile"] == "bypass"

    plans = [e for e in events if e["type"] == "data-plan"]
    assert plans, "write_plan produced no data-plan chunk"
    snapshot = plans[-1]["data"]
    assert snapshot["tasks"][0]["content"] == "ship the feature"
    assert snapshot["tasks"][0]["status"] == "pending"

    shells = [e["data"] for e in events if e["type"] == "data-shell"]
    phases = [data["phase"] for data in shells]
    assert phases == ["started", *["output"] * (len(phases) - 2), "finished"]
    started = shells[0]
    assert started["command"] == "echo hello-shell"
    assert started["tool_call_id"]
    output_text = "".join(data["text"] or "" for data in shells)
    assert "hello-shell" in output_text


def test_stop_cancels_run_and_saves_partial(client, monkeypatch):
    """A hanging model run is cancelled via /stop; partial history is persisted."""
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    import asyncio

    async def hang_stream(messages, info):
        yield "partial"
        await asyncio.Event().wait()  # hangs until the run is cancelled
        yield "unreachable"  # pragma: no cover

    monkeypatch.setattr(
        "app.agent.factory.resolve_model",
        lambda spec: FunctionModel(stream_function=hang_stream),
    )

    # The streaming POST runs in a thread so the test can hit /stop mid-run.
    result: dict = {}

    def do_stream() -> None:
        result["response"] = test_client.post(
            "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
        )

    thread = threading.Thread(target=do_stream)
    thread.start()
    try:
        # Wait for the run to register its token (i.e. actually be in flight).
        tokens = test_client.app.state.cancellation_tokens
        deadline = time.monotonic() + 10
        while chat["id"] not in tokens:
            assert time.monotonic() < deadline, "run never registered a token"
            time.sleep(0.01)

        response = test_client.post(
            f"/api/chats/{chat['id']}/stop", headers=AUTH
        )
        assert response.status_code == 200
        assert response.json()["status"] == "cancel_requested"
    finally:
        thread.join(timeout=15)
    assert not thread.is_alive(), "stream did not finish after /stop"

    stream_response = result["response"]
    assert stream_response.status_code == 200
    assert stream_response.headers["x-vercel-ai-ui-message-stream"] == "v1"

    # The token is released once the stream ends, so a second /stop is a 404.
    assert tokens == {}
    assert (
        test_client.post(f"/api/chats/{chat['id']}/stop", headers=AUTH).status_code
        == 404
    )

    # on_cancel persisted the partial turn: at least the user prompt is stored.
    messages = test_client.get(
        f"/api/chats/{chat['id']}/messages", headers=AUTH
    ).json()
    assert messages, "partial history was not saved on cancel"
    assert messages[0]["role"] == "user"
    assert messages[0]["parts"][0]["text"] == "hello agent"


def _failing_model():
    """A model that streams a partial answer, then dies like a provider error."""

    async def fail_stream(messages, info):
        yield "partial answer"
        raise RuntimeError("provider blew up mid-stream")

    return FunctionModel(stream_function=fail_stream)


async def test_failed_run_persists_failed_turn(client, monkeypatch):
    """A mid-stream provider error still saves the user prompt + partial turn.

    The stock adapter only saves on ``AgentRunResultEvent``; without failure
    persistence the failed turn — prompt included — never reaches the store.
    """
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    monkeypatch.setattr(
        "app.agent.factory.resolve_model", lambda spec: _failing_model()
    )
    response = test_client.post(
        "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
    )
    # The error travels as a stream chunk, not an HTTP error status.
    assert response.status_code == 200
    types = {event["type"] for event in _sse_events(response.text)}
    assert "error" in types

    # The failed turn is on the stored entry chain: user prompt, then whatever
    # the run produced before dying (the interrupted response).
    store = test_client.app.state.store
    record = await store.read_record(chat["id"])
    assert record is not None, "failed run saved nothing — not even the prompt"
    entries = await store.read_history(record.head_id)
    assert len(entries) >= 2, "expected the user prompt plus the partial turn"
    request = entries[0].message
    assert any(
        getattr(part, "part_kind", None) == "user-prompt"
        and part.content == "hello agent"
        for part in request.parts
    )
    assert getattr(entries[1].message, "state", None) == "interrupted"

    # The transcript endpoint shows the failed turn too, so it survives reload.
    messages = test_client.get(
        f"/api/chats/{chat['id']}/messages", headers=AUTH
    ).json()
    assert messages[0]["role"] == "user"
    assert messages[0]["parts"][0]["text"] == "hello agent"


async def test_retry_after_failed_run_does_not_duplicate(client, monkeypatch):
    """Resubmitting the same UIMessage.id after a failure cuts, not appends.

    This is the client's ``sendMessage({text, messageId})`` retry: the message
    is resent as the last (only) message. Its id matches the stored request
    from the failed turn, so history is truncated just before it and the
    replaced tail is kept as a branch — one stored user request, no duplicate.
    """
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    monkeypatch.setattr(
        "app.agent.factory.resolve_model", lambda spec: _failing_model()
    )
    failed = test_client.post(
        "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
    )
    assert failed.status_code == 200

    # The retry: same chat, same user message id — a working model this time.
    monkeypatch.setattr(
        "app.agent.factory.resolve_model",
        lambda spec: TestModel(call_tools=[], custom_output_text="second try"),
    )
    retried = test_client.post(
        "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
    )
    assert retried.status_code == 200
    types = {event["type"] for event in _sse_events(retried.text)}
    assert "finish" in types

    # Exactly one user request + the new response; the failed tail branched off.
    messages = test_client.get(
        f"/api/chats/{chat['id']}/messages", headers=AUTH
    ).json()
    assert [m["role"] for m in messages] == ["user", "assistant"]
    assert messages[0]["parts"][0]["text"] == "hello agent"

    store = test_client.app.state.store
    record = await store.read_record(chat["id"])
    entries = await store.read_history(record.head_id)
    user_prompts = [
        entry
        for entry in entries
        if any(getattr(p, "part_kind", None) == "user-prompt" for p in entry.message.parts)
    ]
    assert len(user_prompts) == 1, "retry duplicated the user prompt"
    assert record.branches, "the failed turn should be kept as a stored branch"


async def test_disconnect_mid_stream_persists_partial(client, monkeypatch):
    """Client disconnect saves the captured history via the same failure path.

    Disconnect produces ``CancelledError``/``GeneratorExit`` — BaseExceptions
    that bypass the event stream's ``except Exception`` and ``on_cancel``
    alike. The adapter subclass catches them before re-raising.
    """
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    import asyncio

    async def hang_stream(messages, info):
        yield "partial"
        await asyncio.Event().wait()  # hangs until the run is torn down
        yield "unreachable"  # pragma: no cover

    monkeypatch.setattr(
        "app.agent.factory.resolve_model",
        lambda spec: FunctionModel(stream_function=hang_stream),
    )

    # Stream until the model is mid-response (the opening `start` chunk is a
    # `before_stream` event that precedes the run), then drop the connection.
    with test_client.stream(
        "POST", "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
    ) as response:
        assert response.status_code == 200
        for line in response.iter_lines():
            if '"text-delta"' in line:
                break

    store = test_client.app.state.store
    record = await store.read_record(chat["id"])
    assert record is not None, "disconnect saved nothing — not even the prompt"
    entries = await store.read_history(record.head_id)
    assert any(
        getattr(part, "part_kind", None) == "user-prompt"
        and part.content == "hello agent"
        for entry in entries
        for part in entry.message.parts
    )


async def test_stop_before_first_token_saves_no_empty_response(client, monkeypatch):
    """Cancelling mid-model-request persists the prompt, not a ghost response.

    The graph records the half-open model-request step as an in-flight
    ``ModelResponse(parts=[], state='interrupted')`` — persisted, it projects
    an empty assistant UIMessage and confuses resubmit merges. The save path
    drops a *trailing* empty response before storing.
    """
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    import asyncio

    reached = threading.Event()

    async def hang_stream(messages, info):
        reached.set()  # the model request is in flight, before any output
        await asyncio.Event().wait()  # hangs until the run is cancelled
        yield "unreachable"  # pragma: no cover

    monkeypatch.setattr(
        "app.agent.factory.resolve_model",
        lambda spec: FunctionModel(stream_function=hang_stream),
    )

    result: dict = {}

    def do_stream() -> None:
        result["response"] = test_client.post(
            "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
        )

    thread = threading.Thread(target=do_stream)
    thread.start()
    try:
        tokens = test_client.app.state.cancellation_tokens
        deadline = time.monotonic() + 10
        while chat["id"] not in tokens:
            assert time.monotonic() < deadline, "run never registered a token"
            await asyncio.sleep(0.01)
        assert reached.wait(timeout=10), "model request never started"
        response = test_client.post(
            f"/api/chats/{chat['id']}/stop", headers=AUTH
        )
        assert response.status_code == 200
    finally:
        thread.join(timeout=15)
    assert not thread.is_alive(), "stream did not finish after /stop"
    assert result["response"].status_code == 200

    # The persisted chain is just the user request — no trailing ghost.
    store = test_client.app.state.store
    record = await store.read_record(chat["id"])
    assert record is not None, "cancelled run saved nothing — not even the prompt"
    entries = await store.read_history(record.head_id)
    assert entries, "expected at least the user prompt"
    assert not any(
        type(entry.message).__name__ == "ModelResponse" and not entry.message.parts
        for entry in entries
    ), "stored an empty ModelResponse — a ghost turn with no model output"
    last = entries[-1].message
    assert any(
        getattr(part, "part_kind", None) == "user-prompt"
        and part.content == "hello agent"
        for part in last.parts
    )

    # The transcript shows no empty assistant message either.
    messages = test_client.get(
        f"/api/chats/{chat['id']}/messages", headers=AUTH
    ).json()
    assert [m["role"] for m in messages] == ["user"]


async def test_failed_run_before_first_token_saves_no_empty_response(
    client, monkeypatch
):
    """A model dying mid-request before any part saves no ghost response.

    Same ``ModelResponse(parts=[])`` shape as the cancel path, reached through
    ``AppVercelAIAdapter._save_captured`` instead of ``_persist_partial``.
    """
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    async def fail_stream(messages, info):
        raise RuntimeError("provider blew up before first token")
        yield  # pragma: no cover — keeps this an async generator

    monkeypatch.setattr(
        "app.agent.factory.resolve_model",
        lambda spec: FunctionModel(stream_function=fail_stream),
    )
    response = test_client.post(
        "/api/chat", json=_chat_payload(chat["id"]), headers=AUTH
    )
    assert response.status_code == 200
    types = {event["type"] for event in _sse_events(response.text)}
    assert "error" in types

    store = test_client.app.state.store
    record = await store.read_record(chat["id"])
    assert record is not None, "failed run saved nothing — not even the prompt"
    entries = await store.read_history(record.head_id)
    assert entries, "expected at least the user prompt"
    assert not any(
        type(entry.message).__name__ == "ModelResponse" and not entry.message.parts
        for entry in entries
    ), "stored an empty ModelResponse — a ghost turn with no model output"
    last = entries[-1].message
    assert any(
        getattr(part, "part_kind", None) == "user-prompt"
        and part.content == "hello agent"
        for part in last.parts
    )

    messages = test_client.get(
        f"/api/chats/{chat['id']}/messages", headers=AUTH
    ).json()
    assert [m["role"] for m in messages] == ["user"]


def test_drop_trailing_empty_response_only_strips_the_tail():
    """The shared helper removes a trailing empty response, nothing else."""
    from pydantic_ai.messages import (
        ModelRequest,
        ModelResponse,
        TextPart,
        UserPromptPart,
    )

    from app.api.chat import _drop_trailing_empty_response

    request = ModelRequest(parts=[UserPromptPart(content="hi")])
    empty = ModelResponse(parts=[])
    full = ModelResponse(parts=[TextPart(content="ok")])

    assert _drop_trailing_empty_response([request, full, empty]) == [request, full]
    # An empty response mid-history is not the ghost this targets — kept.
    assert _drop_trailing_empty_response([request, empty, full]) == [
        request,
        empty,
        full,
    ]
    # A non-empty interrupted-style tail is real content — kept.
    assert _drop_trailing_empty_response([request, full]) == [request, full]
    assert _drop_trailing_empty_response([request]) == [request]
    assert _drop_trailing_empty_response([]) == []
