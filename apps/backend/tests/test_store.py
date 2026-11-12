"""Tests for app.db.store.ChatStore: schema, ConversationStore primitives, app CRUD."""

import sqlite3

import pytest
from pydantic_ai.conversation import Conversation
from pydantic_ai.conversation_store import (
    ConversationConflict,
    ConversationEntry,
    ConversationRecord,
)
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    UserPromptPart,
)
from pydantic_ai.tools import DeferredToolRequests
from pydantic_ai.usage import RunUsage

from app.db.store import ChatStore

TABLES = {
    "conversation_entries",
    "conversation_records",
    "workspaces",
    "chats",
    "settings",
}


def _request(text: str = "hi") -> ModelRequest:
    return ModelRequest(parts=[UserPromptPart(content=text)])


def _response(text: str = "hello") -> ModelResponse:
    return ModelResponse(parts=[TextPart(content=text)])


def _chain(n: int) -> list[ConversationEntry]:
    """A parent-linked entry chain of n entries, oldest first."""
    entries = []
    parent_id = None
    for i in range(n):
        entry = ConversationEntry(parent_id=parent_id, message=_request(f"m{i}"))
        entries.append(entry)
        parent_id = entry.id
    return entries


@pytest.fixture
def store(tmp_path):
    s = ChatStore(tmp_path / "app.db")
    yield s
    s.close()


def test_default_path_uses_app_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "data"))
    s = ChatStore()
    try:
        assert s.db_path == tmp_path / "data" / "app.db"
        assert s.db_path.exists()
    finally:
        s.close()


def test_schema_created(store):
    conn = sqlite3.connect(store.db_path)
    try:
        names = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        assert TABLES <= names
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 1
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    finally:
        conn.close()
    # foreign_keys is a per-connection pragma; check it on the store's own connection.
    assert store._conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1


async def test_record_write_read_roundtrip(store):
    entries = _chain(2)
    record = ConversationRecord(
        conversation_id="c1",
        head_id=entries[-1].id,
        usage=RunUsage(requests=2, input_tokens=42),
        scope="ws-1",
    )
    await store.write_record(record, new_entries=entries, expected_revision=None)

    loaded = await store.read_record("c1")
    assert loaded is not None
    assert loaded.conversation_id == "c1"
    assert loaded.head_id == entries[-1].id
    assert loaded.scope == "ws-1"
    assert loaded.revision == record.revision
    assert loaded.usage.requests == 2
    assert loaded.usage.input_tokens == 42

    entry = await store.read_entry(entries[0].id)
    assert entry.id == entries[0].id
    assert entry.parent_id is None
    assert entry.message == entries[0].message


async def test_write_record_cas_conflicts(store):
    record = ConversationRecord(conversation_id="c1", head_id=None)
    await store.write_record(record, expected_revision=None)

    # Already exists: `None` expected revision means "must not exist".
    with pytest.raises(ConversationConflict):
        await store.write_record(
            ConversationRecord(conversation_id="c1", head_id=None),
            expected_revision=None,
        )
    # Stale revision.
    with pytest.raises(ConversationConflict):
        await store.write_record(
            ConversationRecord(conversation_id="c1", head_id=None),
            expected_revision="stale-revision",
        )
    # Unknown conversation requires expected_revision=None.
    with pytest.raises(ConversationConflict):
        await store.write_record(
            ConversationRecord(conversation_id="nope", head_id=None),
            expected_revision="whatever",
        )
    # Missing head entry.
    with pytest.raises(ConversationConflict):
        await store.write_record(
            ConversationRecord(conversation_id="c1", head_id="missing"),
            expected_revision=record.revision,
        )
    # Correct revision succeeds.
    await store.write_record(
        ConversationRecord(conversation_id="c1", head_id=None),
        expected_revision=record.revision,
    )


async def test_read_history_ordered_with_limit(store):
    entries = _chain(4)
    record = ConversationRecord(conversation_id="c1", head_id=entries[-1].id)
    await store.write_record(record, new_entries=entries, expected_revision=None)

    history = await store.read_history(entries[-1].id)
    assert [e.id for e in history] == [e.id for e in entries]
    assert [e.message for e in history] == [e.message for e in entries]

    tail = await store.read_history(entries[-1].id, limit=2)
    assert [e.id for e in tail] == [entries[2].id, entries[3].id]

    assert await store.read_history(None) == []
    with pytest.raises(LookupError):
        await store.read_history("missing-head")
    with pytest.raises(LookupError):
        await store.read_entry("missing-entry")


async def test_save_load_and_stale_save_conflict(store):
    request, response = _request("ping"), _response("pong")
    conversation = Conversation(
        conversation_id="chat-1", messages=[request, response]
    )
    saved = await store.save(conversation, scope="ws-1")
    assert len(saved) == 2

    loaded = await store.load("chat-1", scope="ws-1")
    assert loaded is not None
    assert loaded.messages == [request, response]
    assert loaded.revision == conversation.revision

    # Scope guard: the same conversation is invisible under another scope.
    assert await store.load("chat-1", scope="ws-other") is None

    # A save from a stale snapshot conflicts.
    stale = Conversation(
        conversation_id="chat-1",
        messages=[request, response, _request("more")],
        revision=loaded.revision,
    )
    conversation.messages.append(_request("again"))
    await store.save(conversation)
    with pytest.raises(ConversationConflict):
        await store.save(stale)


async def test_delete_record_garbage_collects_unreached_entries(store):
    entries = _chain(3)
    a = ConversationRecord(conversation_id="a", head_id=entries[-1].id, scope="ws")
    await store.write_record(a, new_entries=entries, expected_revision=None)
    # B is a fork sharing A's whole chain.
    b = ConversationRecord(conversation_id="b", head_id=entries[-1].id, scope="ws")
    await store.write_record(b, expected_revision=None)

    await store.delete_record("a", expected_revision=a.revision)
    assert await store.read_record("a") is None
    # Shared entries survive while B reaches them.
    assert await store.read_entry(entries[0].id) == entries[0]
    assert len(await store.read_history(b.head_id)) == 3

    await store.delete_record("b", expected_revision=b.revision)
    with pytest.raises(LookupError):
        await store.read_entry(entries[0].id)

    # Delete with a stale revision conflicts; deleting a missing record does too.
    with pytest.raises(ConversationConflict):
        await store.delete_record("b", expected_revision=b.revision)


async def test_record_and_history_survive_reopen(tmp_path):
    """Backend-restart resume: a fresh ChatStore on the same file sees records,
    entry chains and pending DeferredToolRequests."""
    path = tmp_path / "app.db"
    first = ChatStore(path)
    entries = _chain(2)
    deferred = DeferredToolRequests(
        approvals=[ToolCallPart(tool_name="shell", args={"cmd": "rm -rf /"}, tool_call_id="tc1")]
    )
    record = ConversationRecord(
        conversation_id="c1",
        head_id=entries[-1].id,
        deferred_tool_requests=deferred,
        scope="ws-1",
    )
    await first.write_record(record, new_entries=entries, expected_revision=None)
    first.close()

    second = ChatStore(path)
    try:
        loaded = await second.read_record("c1")
        assert loaded is not None
        assert loaded.deferred_tool_requests is not None
        assert loaded.deferred_tool_requests.approvals[0].tool_call_id == "tc1"
        assert loaded.deferred_tool_requests.kind("tc1") == "approval"
        history = await second.read_history(loaded.head_id)
        assert [e.message for e in history] == [e.message for e in entries]
    finally:
        second.close()


async def test_workspace_upsert_idempotent_on_normalized_path(store, tmp_path):
    project = tmp_path / "proj"
    ws1 = await store.get_or_create_workspace(project)
    ws2 = await store.get_or_create_workspace(str(project) + "/")
    ws3 = await store.get_or_create_workspace(project / ".." / "proj")

    assert ws1.id == ws2.id == ws3.id
    assert ws1.path == str(project.resolve())
    assert ws1.display_name == "proj"
    assert ws2.last_opened_at >= ws1.created_at

    summaries = await store.list_workspaces()
    assert [s.workspace.id for s in summaries] == [ws1.id]


async def test_chat_crud_and_cascade_delete(store, tmp_path):
    ws = await store.get_or_create_workspace(tmp_path / "proj")
    other = await store.get_or_create_workspace(tmp_path / "other")

    chat = await store.create_chat(ws.id, title="First", model="anthropic:x")
    assert chat.title == "First" and chat.model == "anthropic:x"
    assert (await store.get_chat(chat.id)).workspace_id == ws.id

    renamed = await store.rename_chat(chat.id, "Renamed")
    assert renamed.title == "Renamed"
    assert renamed.updated_at >= chat.updated_at
    assert await store.rename_chat("missing", "x") is None

    await store.create_chat(other.id, title="Other")
    await store.set_last_chat(ws.id, chat.id)
    assert (await store.get_workspace(ws.id)).last_chat_id == chat.id
    assert [c.id for c in await store.list_chats(ws.id)] == [chat.id]

    # Unknown workspace rejected by the FK.
    with pytest.raises(ValueError, match="unknown workspace"):
        await store.create_chat("not-a-workspace")

    # Deleting the workspace cascades to its chats only.
    assert await store.delete_workspace(ws.id) is True
    assert await store.list_chats(ws.id) == []
    assert await store.get_chat(chat.id) is None
    assert len(await store.list_chats(other.id)) == 1
    assert await store.delete_workspace(ws.id) is False

    # delete_chat clears last_chat_id on the workspace.
    ws2 = await store.get_or_create_workspace(tmp_path / "proj2")
    c2 = await store.create_chat(ws2.id)
    await store.set_last_chat(ws2.id, c2.id)
    assert await store.delete_chat(c2.id) is True
    assert (await store.get_workspace(ws2.id)).last_chat_id is None


async def test_settings_kv_roundtrip(store):
    assert await store.get_setting("theme") is None
    await store.set_setting("theme", "dark")
    await store.set_setting("model", '{"provider": "anthropic"}')
    assert await store.get_setting("theme") == "dark"
    await store.set_setting("theme", "light")
    assert await store.get_settings() == {
        "theme": "light",
        "model": '{"provider": "anthropic"}',
    }
    assert await store.delete_setting("theme") is True
    assert await store.delete_setting("theme") is False
    assert await store.get_setting("theme") is None
