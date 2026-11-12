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
