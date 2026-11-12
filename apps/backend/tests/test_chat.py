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
