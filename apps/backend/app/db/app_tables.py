"""App-metadata tables (``workspaces``, ``chats``, ``settings``) as a ``ChatStore`` mixin.

These methods back the workspace/chat REST routes and the grouped sidebar. Chat rows are
metadata only — a chat's ``id`` is its ``conversation_id`` in the conversation tables,
and its ``workspace_id`` is the conversation ``scope``. All timestamps are unix-ms ints.

The mixin relies on plumbing defined on ``ChatStore`` (``_conn``, ``_run``,
``_gc_entries``); it is not meant to be used standalone.
"""

from __future__ import annotations

import logging
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)


def _now_ms() -> int:
    """Current Unix time in milliseconds — the timestamp unit for all app-table columns."""
    return int(time.time() * 1000)


def _normalize_path(path: str | Path) -> str:
    """Canonical absolute form of a workspace path, so upserts are idempotent on equivalent spellings."""
    return str(Path(path).expanduser().resolve())


@dataclass(frozen=True, slots=True)
class Workspace:
    """A folder the user has opened chats against."""

    id: str
    path: str
    display_name: str
    last_chat_id: str | None
    created_at: int  # unix ms
    last_opened_at: int  # unix ms


@dataclass(frozen=True, slots=True)
class ChatSummary:
    """Chat-list metadata; the transcript lives in the conversation tables under ``id``."""

    id: str
    workspace_id: str
    title: str
    model: str | None
    created_at: int  # unix ms
    updated_at: int  # unix ms


@dataclass(frozen=True, slots=True)
class WorkspaceSummary:
    """A workspace plus its chats, for the grouped sidebar."""

    workspace: Workspace
    chats: list[ChatSummary] = field(default_factory=list)


class AppTablesMixin:
    """CRUD for the ``workspaces`` / ``chats`` / ``settings`` tables.

    Mixed into ``ChatStore``; requires ``self._conn`` (sqlite3 connection),
    ``self._run`` (locked offload to a worker thread) and ``self._gc_entries``.
    """

    _conn: sqlite3.Connection

    # ------------------------------------------------------------------
    # Workspaces
    # ------------------------------------------------------------------

    async def get_or_create_workspace(
        self, path: str | Path, *, display_name: str | None = None
    ) -> Workspace:
        """Upsert a workspace by normalized absolute path, bumping ``last_opened_at``.

        Idempotent: equivalent spellings of the same folder resolve to the same row.
        ``display_name`` is only used on first insert (defaults to the folder name).
        """
        return await self._run(self._get_or_create_workspace, path, display_name)

    def _get_or_create_workspace(self, path: str | Path, display_name: str | None) -> Workspace:
        normalized = _normalize_path(path)
        now = _now_ms()
        with self._conn:
            self._conn.execute(
                "INSERT INTO workspaces (id, path, display_name, last_chat_id, created_at, last_opened_at) "
                "VALUES (?, ?, ?, NULL, ?, ?) "
                "ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at",
                (
                    uuid.uuid4().hex,
                    normalized,
                    display_name or Path(normalized).name or normalized,
                    now,
                    now,
                ),
            )
            row = self._conn.execute(
                "SELECT id, path, display_name, last_chat_id, created_at, last_opened_at "
                "FROM workspaces WHERE path = ?",
                (normalized,),
            ).fetchone()
        return self._workspace_from_row(row)

    async def get_workspace(self, workspace_id: str) -> Workspace | None:
        """A workspace by id, or ``None``."""
        return await self._run(self._get_workspace, workspace_id)

    def _get_workspace(self, workspace_id: str) -> Workspace | None:
        row = self._conn.execute(
            "SELECT id, path, display_name, last_chat_id, created_at, last_opened_at "
            "FROM workspaces WHERE id = ?",
            (workspace_id,),
        ).fetchone()
        return None if row is None else self._workspace_from_row(row)

    async def list_workspaces(self) -> list[WorkspaceSummary]:
        """All workspaces, most recently opened first, each with its chats (newest first)."""
        return await self._run(self._list_workspaces)

    def _list_workspaces(self) -> list[WorkspaceSummary]:
        workspaces = self._conn.execute(
            "SELECT id, path, display_name, last_chat_id, created_at, last_opened_at "
            "FROM workspaces ORDER BY last_opened_at DESC, id"
        ).fetchall()
        chats = self._conn.execute(
            "SELECT id, workspace_id, title, model, created_at, updated_at "
            "FROM chats ORDER BY updated_at DESC, id"
        ).fetchall()
        by_workspace: dict[str, list[ChatSummary]] = {}
        for row in chats:
            by_workspace.setdefault(row[1], []).append(self._chat_from_row(row))
        return [
            WorkspaceSummary(
                workspace=self._workspace_from_row(row),
                chats=by_workspace.get(row[0], []),
            )
            for row in workspaces
        ]

    async def delete_workspace(self, workspace_id: str) -> bool:
        """Delete a workspace, its chats (FK cascade) and its conversation state.

        Returns:
            Whether the workspace existed.
        """
        return await self._run(self._delete_workspace, workspace_id)

    def _delete_workspace(self, workspace_id: str) -> bool:
        with self._conn:
            self._conn.execute("BEGIN IMMEDIATE")
            cursor = self._conn.execute(
                "DELETE FROM workspaces WHERE id = ?", (workspace_id,)
            )
            if cursor.rowcount:
                # Conversation records scoped to the workspace go with it.
                self._conn.execute(
                    "DELETE FROM conversation_records WHERE scope = ?", (workspace_id,)
                )
                self._gc_entries()
        if cursor.rowcount:
            logger.info("Deleted workspace %s", workspace_id)
        return bool(cursor.rowcount)

    async def set_last_chat(self, workspace_id: str, chat_id: str | None) -> None:
        """Record the chat a workspace was last left on, for session restore."""
        await self._run(self._set_last_chat, workspace_id, chat_id)

    def _set_last_chat(self, workspace_id: str, chat_id: str | None) -> None:
        with self._conn:
            self._conn.execute(
                "UPDATE workspaces SET last_chat_id = ? WHERE id = ?",
                (chat_id, workspace_id),
            )

    # ------------------------------------------------------------------
    # Chats (metadata only — transcripts live in the conversation tables)
    # ------------------------------------------------------------------

    async def create_chat(
        self,
        workspace_id: str,
        *,
        title: str = "New chat",
        model: str | None = None,
        chat_id: str | None = None,
    ) -> ChatSummary:
        """Create a chat in a workspace; its ``id`` doubles as the ``conversation_id``.

        Raises:
            ValueError: If the workspace doesn't exist (FK violation).
        """
        return await self._run(self._create_chat, workspace_id, title, model, chat_id)

    def _create_chat(
        self,
        workspace_id: str,
        title: str,
        model: str | None,
        chat_id: str | None,
    ) -> ChatSummary:
        now = _now_ms()
        summary = ChatSummary(
            id=chat_id or uuid.uuid4().hex,
            workspace_id=workspace_id,
            title=title,
            model=model,
            created_at=now,
            updated_at=now,
        )
        try:
            with self._conn:
                self._conn.execute(
                    "INSERT INTO chats (id, workspace_id, title, model, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (summary.id, workspace_id, title, model, now, now),
                )
        except sqlite3.IntegrityError as exc:
            raise ValueError(
                f"Cannot create chat in unknown workspace {workspace_id!r}"
            ) from exc
        return summary

    async def get_chat(self, chat_id: str) -> ChatSummary | None:
        """A chat's metadata by id, or ``None``."""
        return await self._run(self._get_chat, chat_id)

    def _get_chat(self, chat_id: str) -> ChatSummary | None:
        row = self._conn.execute(
            "SELECT id, workspace_id, title, model, created_at, updated_at "
            "FROM chats WHERE id = ?",
            (chat_id,),
        ).fetchone()
        return None if row is None else self._chat_from_row(row)

    async def list_chats(self, workspace_id: str) -> list[ChatSummary]:
        """A workspace's chats, most recently updated first."""
        return await self._run(self._list_chats, workspace_id)

    def _list_chats(self, workspace_id: str) -> list[ChatSummary]:
        rows = self._conn.execute(
            "SELECT id, workspace_id, title, model, created_at, updated_at "
            "FROM chats WHERE workspace_id = ? ORDER BY updated_at DESC, id",
            (workspace_id,),
        ).fetchall()
        return [self._chat_from_row(row) for row in rows]

    async def rename_chat(self, chat_id: str, title: str) -> ChatSummary | None:
        """Rename a chat and bump ``updated_at``; ``None`` if the chat doesn't exist."""
        return await self._run(self._rename_chat, chat_id, title)

    def _rename_chat(self, chat_id: str, title: str) -> ChatSummary | None:
        with self._conn:
            cursor = self._conn.execute(
                "UPDATE chats SET title = ?, updated_at = ? WHERE id = ?",
                (title, _now_ms(), chat_id),
            )
        return self._get_chat(chat_id) if cursor.rowcount else None

    async def touch_chat(self, chat_id: str) -> None:
        """Bump a chat's ``updated_at`` — call after each run so lists sort by activity."""
        await self._run(self._touch_chat, chat_id)

    def _touch_chat(self, chat_id: str) -> None:
        with self._conn:
            self._conn.execute(
                "UPDATE chats SET updated_at = ? WHERE id = ?", (_now_ms(), chat_id)
            )

    async def delete_chat(self, chat_id: str) -> bool:
        """Delete a chat's metadata and its conversation record, if any.

        Returns:
            Whether the chat row existed.
        """
        return await self._run(self._delete_chat, chat_id)

    def _delete_chat(self, chat_id: str) -> bool:
        with self._conn:
            self._conn.execute("BEGIN IMMEDIATE")
            cursor = self._conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
            if cursor.rowcount:
                self._conn.execute(
                    "UPDATE workspaces SET last_chat_id = NULL WHERE last_chat_id = ?",
                    (chat_id,),
                )
                # The chat id is the conversation id; drop its record and GC its chain.
                self._conn.execute(
                    "DELETE FROM conversation_records WHERE conversation_id = ?",
                    (chat_id,),
                )
                self._gc_entries()
        return bool(cursor.rowcount)

    # ------------------------------------------------------------------
    # Settings KV
    # ------------------------------------------------------------------

    async def get_setting(self, key: str) -> str | None:
        """A setting's value, or ``None`` if unset."""
        return await self._run(self._get_setting, key)

    def _get_setting(self, key: str) -> str | None:
        row = self._conn.execute(
            "SELECT value FROM settings WHERE key = ?", (key,)
        ).fetchone()
        return None if row is None else str(row[0])

    async def get_settings(self) -> dict[str, str]:
        """All settings as a plain dict."""
        return await self._run(self._get_settings)

    def _get_settings(self) -> dict[str, str]:
        rows = self._conn.execute("SELECT key, value FROM settings").fetchall()
        return {str(key): str(value) for key, value in rows}

    async def set_setting(self, key: str, value: str) -> None:
        """Upsert a setting. Values are stored verbatim — serialize to JSON for structure."""
        await self._run(self._set_setting, key, value)

    def _set_setting(self, key: str, value: str) -> None:
        with self._conn:
            self._conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    async def delete_setting(self, key: str) -> bool:
        """Remove a setting; whether it existed."""
        return await self._run(self._delete_setting, key)

    def _delete_setting(self, key: str) -> bool:
        with self._conn:
            cursor = self._conn.execute("DELETE FROM settings WHERE key = ?", (key,))
        return bool(cursor.rowcount)

    # ------------------------------------------------------------------
    # Row mappers
    # ------------------------------------------------------------------

    @staticmethod
    def _workspace_from_row(row: sqlite3.Row | tuple) -> Workspace:
        return Workspace(
            id=row[0],
            path=row[1],
            display_name=row[2],
            last_chat_id=row[3],
            created_at=row[4],
            last_opened_at=row[5],
        )

    @staticmethod
    def _chat_from_row(row: sqlite3.Row | tuple) -> ChatSummary:
        return ChatSummary(
            id=row[0],
            workspace_id=row[1],
            title=row[2],
            model=row[3],
            created_at=row[4],
            updated_at=row[5],
        )
