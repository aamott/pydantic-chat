"""Schema migrations for ``app.db``, applied in order and tracked by ``PRAGMA user_version``.

Each entry is one migration script. Never edit a released entry — append a new one.
"""

# Conversation tables implement the `pydantic_ai.conversation_store` model: entries are a
# parent_id-linked chain holding one serialized ModelMessage each; records point at the
# chain head and carry everything messages can't (usage, deferred tool requests, branches,
# fork links) as one serialized ConversationRecord blob in `data_json`, with the fields
# queries need — scope, head_id, revision, updated_at — duplicated as columns.
#
# App tables hold metadata only: a chat's `id` doubles as its conversation_id in the
# store tables, and its workspace_id is used as the conversation `scope`.
MIGRATIONS: tuple[str, ...] = (
    """
    CREATE TABLE conversation_entries (
        entry_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        parent_id TEXT,
        data_json TEXT NOT NULL
    );
    CREATE INDEX conversation_entries_conversation_idx
        ON conversation_entries (conversation_id);

    CREATE TABLE conversation_records (
        conversation_id TEXT PRIMARY KEY,
        scope TEXT,
        head_id TEXT,
        revision TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX conversation_records_scope_idx
        ON conversation_records (scope, updated_at DESC);

    CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        last_chat_id TEXT,
        created_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL
    );

    CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL
            REFERENCES workspaces (id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        model TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX chats_workspace_idx ON chats (workspace_id, updated_at DESC);

    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    """,
    # Per-workspace permission-profile override; NULL inherits the global setting.
    """
    ALTER TABLE workspaces ADD COLUMN permission_profile TEXT;
    """,
    # Per-chat overrides feeding the model picker: `thinking` is the normalized
    # level ('off'|'low'|'medium'|'high', free-form tolerated for uncatalogued
    # models) and `permission_profile` one of the four profiles. Both NULL =
    # inherit (thinking -> provider default; profile -> workspace -> global).
    """
    ALTER TABLE chats ADD COLUMN thinking TEXT;
    ALTER TABLE chats ADD COLUMN permission_profile TEXT;
    """,
)
