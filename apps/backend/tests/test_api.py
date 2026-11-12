"""Tests for the workspaces/chats REST API (auth, CRUD, cascade, messages dump)."""

import asyncio

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.conversation_store import ConversationEntry, ConversationRecord
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)

from app.main import create_app

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A TestClient over a fresh app backed by a tmp APP_DATA_DIR + APP_TOKEN."""
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("APP_TOKEN", TOKEN)
    # TrustedHostMiddleware only allows loopback hosts, so the test client must
    # present one too (its default Host header is "testserver").
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


def test_health_is_open(client):
    test_client, _ = client
    assert test_client.get("/health").status_code == 200


def test_routes_require_bearer_token(client):
    test_client, _ = client
    assert test_client.get("/api/workspaces").status_code == 401
    assert (
        test_client.get(
            "/api/workspaces", headers={"Authorization": "Bearer wrong"}
        ).status_code
        == 401
    )
    assert test_client.get("/api/workspaces", headers=AUTH).status_code == 200
    assert test_client.get("/api/ping", headers=AUTH).status_code == 200


def test_workspace_upsert_idempotent_and_missing_flag(client):
    test_client, tmp_path = client
    project = tmp_path / "proj"
    project.mkdir()

    workspace = _create_workspace(test_client, project)
    assert workspace["display_name"] == "proj"
    assert workspace["path"] == str(project.resolve())
    assert workspace["missing"] is False
    assert workspace["chats"] == []
    assert workspace["last_chat_id"] is None

    # Equivalent spellings of the same folder upsert to the same row.
    again = _create_workspace(test_client, project / ".." / "proj")
    assert again["id"] == workspace["id"]
    assert len(test_client.get("/api/workspaces", headers=AUTH).json()) == 1

    # A folder that doesn't exist on disk is flagged missing, not rejected.
    gone = _create_workspace(test_client, tmp_path / "gone")
    assert gone["missing"] is True


def test_chat_crud_and_nested_sidebar_listing(client):
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)

    chat1 = _create_chat(test_client, workspace["id"], {"title": "First"})
    assert chat1["title"] == "First"
    assert chat1["workspace_id"] == workspace["id"]

    chat2 = _create_chat(test_client, workspace["id"])
    assert chat2["title"] == "New chat"

    listing = test_client.get("/api/workspaces", headers=AUTH).json()
    assert len(listing) == 1
    chats = listing[0]["chats"]
    assert {chat["id"] for chat in chats} == {chat1["id"], chat2["id"]}
    assert {chat["title"] for chat in chats} == {"First", "New chat"}
    assert chats[0]["updated_at"] >= chats[1]["updated_at"]
    # Creating a chat marks it the workspace's last-open chat.
    assert listing[0]["last_chat_id"] == chat2["id"]

    renamed = test_client.patch(
        f"/api/chats/{chat1['id']}", json={"title": "Renamed"}, headers=AUTH
    )
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "Renamed"

    # Unknown workspace/chat ids are 404s.
    assert (
        test_client.post(
            "/api/workspaces/nope/chats", json={}, headers=AUTH
        ).status_code
        == 404
    )
    assert (
        test_client.patch(
            "/api/chats/nope", json={"title": "x"}, headers=AUTH
        ).status_code
        == 404
    )


def test_workspace_patch_and_cascade_delete(client):
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    patched = test_client.patch(
        f"/api/workspaces/{workspace['id']}",
        json={"display_name": "Work", "last_chat_id": chat["id"]},
        headers=AUTH,
    )
    assert patched.status_code == 200
    assert patched.json()["display_name"] == "Work"
    assert patched.json()["last_chat_id"] == chat["id"]

    # last_chat_id must name a chat in this workspace.
    assert (
        test_client.patch(
            f"/api/workspaces/{workspace['id']}",
            json={"last_chat_id": "nope"},
            headers=AUTH,
        ).status_code
        == 400
    )
    # An explicit null clears last_chat_id.
    cleared = test_client.patch(
        f"/api/workspaces/{workspace['id']}",
        json={"last_chat_id": None},
        headers=AUTH,
    )
    assert cleared.status_code == 200
    assert cleared.json()["last_chat_id"] is None

    # Deleting the workspace cascades to its chats.
    assert (
        test_client.delete(
            f"/api/workspaces/{workspace['id']}", headers=AUTH
        ).status_code
        == 204
    )
    assert test_client.get("/api/workspaces", headers=AUTH).json() == []
    assert (
        test_client.get(f"/api/chats/{chat['id']}/messages", headers=AUTH).status_code
        == 404
    )
    assert (
        test_client.delete(
            f"/api/workspaces/{workspace['id']}", headers=AUTH
        ).status_code
        == 404
    )


def test_workspace_permission_profile_patch(client):
    """PATCH accepts the four profiles, rejects others, and null clears the override."""
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    assert workspace["permission_profile"] is None  # inherits the global setting

    patched = test_client.patch(
        f"/api/workspaces/{workspace['id']}",
        json={"permission_profile": "bypass"},
        headers=AUTH,
    )
    assert patched.status_code == 200
    assert patched.json()["permission_profile"] == "bypass"

    # An unknown profile is a validation error, not a silent write.
    assert (
        test_client.patch(
            f"/api/workspaces/{workspace['id']}",
            json={"permission_profile": "everything"},
            headers=AUTH,
        ).status_code
        == 422
    )
    assert (
        test_client.get("/api/workspaces", headers=AUTH).json()[0][
            "permission_profile"
        ]
        == "bypass"
    )

    # An explicit null clears the override (back to inheriting the global).
    cleared = test_client.patch(
        f"/api/workspaces/{workspace['id']}",
        json={"permission_profile": None},
        headers=AUTH,
    )
    assert cleared.status_code == 200
    assert cleared.json()["permission_profile"] is None


def test_chat_delete(client):
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    assert (
        test_client.delete(f"/api/chats/{chat['id']}", headers=AUTH).status_code
        == 204
    )
    assert (
        test_client.delete(f"/api/chats/{chat['id']}", headers=AUTH).status_code
        == 404
    )
    listing = test_client.get("/api/workspaces", headers=AUTH).json()
    assert listing[0]["chats"] == []
    # The workspace's last_chat_id pointer is cleared by the delete.
    assert listing[0]["last_chat_id"] is None


def test_messages_endpoint_empty_then_dumped(client):
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    # No stored conversation yet -> empty list, not an error.
    response = test_client.get(f"/api/chats/{chat['id']}/messages", headers=AUTH)
    assert response.status_code == 200
    assert response.json() == []

    # Seed a stored conversation under the chat id (what the /chat endpoint will
    # write once it lands) and confirm dump_messages renders it as UIMessages.
    entries = []
    parent_id = None
    for message in (
        ModelRequest(parts=[UserPromptPart(content="hi")]),
        ModelResponse(parts=[TextPart(content="hello")]),
    ):
        entry = ConversationEntry(parent_id=parent_id, message=message)
        entries.append(entry)
        parent_id = entry.id
    record = ConversationRecord(
        conversation_id=chat["id"],
        head_id=entries[-1].id,
        scope=workspace["id"],
    )

    async def seed() -> None:
        await test_client.app.state.store.write_record(
            record, new_entries=entries, expected_revision=None
        )

    asyncio.run(seed())

    messages = test_client.get(
        f"/api/chats/{chat['id']}/messages", headers=AUTH
    ).json()
    assert [m["role"] for m in messages] == ["user", "assistant"]
    assert messages[0]["parts"][0]["type"] == "text"
    assert messages[0]["parts"][0]["text"] == "hi"
    assert messages[1]["parts"][0]["text"] == "hello"
