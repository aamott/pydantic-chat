"""App-metadata tables (``workspaces``, ``chats``, ``settings``) as a ``ChatStore`` mixin.

These methods back the workspace/chat REST routes and the grouped sidebar. Chat rows are
metadata only — a chat's ``id`` is its ``conversation_id`` in the conversation tables,
and its ``workspace_id`` is the conversation ``scope``. All timestamps are unix-ms ints.

The mixin relies on plumbing defined on ``ChatStore`` (``_conn``, ``_run``,
``_gc_entries``); it is not meant to be used standalone.
"""

from __future__ import annotations

import json
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
    permission_profile: str | None
    """Per-workspace permission override; ``None`` inherits the global setting."""
    mcp_overrides: dict[str, bool] | None
    """Per-workspace MCP mask — server name -> enabled; ``None`` inherits the global registry."""


@dataclass(frozen=True, slots=True)
class ChatSummary:
    """Chat-list metadata; the transcript lives in the conversation tables under ``id``.

    ``model``/``thinking``/``permission_profile`` are per-chat overrides —
    ``None`` inherits (model/thinking -> app defaults; profile -> workspace ->
    global).
    """

    id: str
    workspace_id: str
    title: str
    model: str | None
    created_at: int  # unix ms
    updated_at: int  # unix ms
    thinking: str | None
    permission_profile: str | None


CHAT_SELECT = (
    "SELECT id, workspace_id, title, model, created_at, updated_at, "
    "thinking, permission_profile FROM chats"
)
"""Full ``ChatSummary`` column list, shared by every chat read."""

WORKSPACE_SELECT = (
    "SELECT id, path, display_name, last_chat_id, created_at, last_opened_at, "
    "permission_profile, mcp_overrides FROM workspaces"
)
"""Full ``Workspace`` column list, shared by every workspace read."""


def _decode_mcp_overrides(raw: object) -> dict[str, bool] | None:
    """JSON-decode a ``workspaces.mcp_overrides`` column value.

    ``NULL`` reads as ``None`` (inherit the global registry). Malformed rows —
    a schema the row predates or a hand-edited db — degrade to ``None`` with a
    warning rather than breaking every workspace read.
    """
    if raw is None:
        return None
    try:
        decoded = json.loads(str(raw))
    except (json.JSONDecodeError, TypeError):
        logger.warning("Ignoring malformed mcp_overrides value %r", raw)
        return None
    if not isinstance(decoded, dict):
        logger.warning("Ignoring non-object mcp_overrides value %r", raw)
        return None
    return {
        str(name): enabled
        for name, enabled in decoded.items()
        if isinstance(enabled, bool)
    }

CHAT_EDITABLE_FIELDS: frozenset[str] = frozenset(
    {"title", "model", "thinking", "permission_profile"}
)
"""Chats columns :meth:`AppTablesMixin.update_chat` may write."""


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
                f"{WORKSPACE_SELECT} WHERE path = ?",
                (normalized,),
            ).fetchone()
        return self._workspace_from_row(row)

    async def get_workspace(self, workspace_id: str) -> Workspace | None:
        """A workspace by id, or ``None``."""
        return await self._run(self._get_workspace, workspace_id)

    def _get_workspace(self, workspace_id: str) -> Workspace | None:
        row = self._conn.execute(
            f"{WORKSPACE_SELECT} WHERE id = ?",
            (workspace_id,),
        ).fetchone()
        return None if row is None else self._workspace_from_row(row)

    async def list_workspaces(self) -> list[WorkspaceSummary]:
        """All workspaces, most recently opened first, each with its chats (newest first)."""
        return await self._run(self._list_workspaces)

    def _list_workspaces(self) -> list[WorkspaceSummary]:
        workspaces = self._conn.execute(
            f"{WORKSPACE_SELECT} ORDER BY last_opened_at DESC, id"
        ).fetchall()
        chats = self._conn.execute(
            f"{CHAT_SELECT} ORDER BY updated_at DESC, id"
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

    async def set_workspace_permission_profile(
        self, workspace_id: str, profile: str | None
    ) -> None:
        """Set (or clear, with ``None``) a workspace's permission-profile override.

        ``None`` writes ``NULL``, so runs on the workspace inherit the global
        ``permission_profile`` setting again.
        """
        await self._run(self._set_workspace_permission_profile, workspace_id, profile)

    def _set_workspace_permission_profile(
        self, workspace_id: str, profile: str | None
    ) -> None:
        with self._conn:
            self._conn.execute(
                "UPDATE workspaces SET permission_profile = ? WHERE id = ?",
                (profile, workspace_id),
            )

    async def set_workspace_mcp_overrides(
        self, workspace_id: str, overrides: dict[str, bool] | None
    ) -> None:
        """Set (or clear, with ``None``) a workspace's MCP enable/disable mask.

        ``overrides`` is a server-name -> enabled map stored as JSON; each
        entry replaces the global spec's ``enabled`` flag for this workspace's
        runs. ``None`` writes ``NULL``, restoring global inheritance.
        """
        payload = None if overrides is None else json.dumps(overrides)
        await self._run(self._set_workspace_mcp_overrides, workspace_id, payload)

    def _set_workspace_mcp_overrides(
        self, workspace_id: str, payload: str | None
    ) -> None:
        with self._conn:
            self._conn.execute(
                "UPDATE workspaces SET mcp_overrides = ? WHERE id = ?",
                (payload, workspace_id),
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
        thinking: str | None = None,
        permission_profile: str | None = None,
        chat_id: str | None = None,
    ) -> ChatSummary:
        """Create a chat in a workspace; its ``id`` doubles as the ``conversation_id``.

        Raises:
            ValueError: If the workspace doesn't exist (FK violation).
        """
        return await self._run(
            self._create_chat,
            workspace_id,
            title,
            model,
            thinking,
            permission_profile,
            chat_id,
        )

    def _create_chat(
        self,
        workspace_id: str,
        title: str,
        model: str | None,
        thinking: str | None,
        permission_profile: str | None,
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
            thinking=thinking,
            permission_profile=permission_profile,
        )
        try:
            with self._conn:
                self._conn.execute(
                    "INSERT INTO chats (id, workspace_id, title, model, created_at, updated_at, "
                    "thinking, permission_profile) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        summary.id,
                        workspace_id,
                        title,
                        model,
                        now,
                        now,
                        thinking,
                        permission_profile,
                    ),
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
            f"{CHAT_SELECT} WHERE id = ?", (chat_id,)
        ).fetchone()
        return None if row is None else self._chat_from_row(row)

    async def list_chats(self, workspace_id: str) -> list[ChatSummary]:
        """A workspace's chats, most recently updated first."""
        return await self._run(self._list_chats, workspace_id)

    def _list_chats(self, workspace_id: str) -> list[ChatSummary]:
        rows = self._conn.execute(
            f"{CHAT_SELECT} WHERE workspace_id = ? ORDER BY updated_at DESC, id",
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

    async def update_chat(
        self, chat_id: str, **fields: str | None
    ) -> ChatSummary | None:
        """Set per-chat fields; ``None`` clears an override back to inherited.

        Args:
            chat_id: The chat to update.
            **fields: Columns to write — keys restricted to
                :data:`CHAT_EDITABLE_FIELDS` (``title``/``model``/``thinking``/
                ``permission_profile``). Unmentioned fields keep their values.

        Returns:
            The updated summary, or ``None`` if the chat doesn't exist.

        Raises:
            ValueError: If a field name isn't editable or nothing was passed.
        """
        if not fields:
            raise ValueError("update_chat requires at least one field")
        unknown = set(fields) - CHAT_EDITABLE_FIELDS
        if unknown:
            raise ValueError(f"Unknown chat fields: {sorted(unknown)}")
        return await self._run(self._update_chat, chat_id, fields)

    def _update_chat(
        self, chat_id: str, fields: dict[str, str | None]
    ) -> ChatSummary | None:
        assignments = ", ".join(f"{name} = ?" for name in fields)
        with self._conn:
            cursor = self._conn.execute(
                f"UPDATE chats SET {assignments}, updated_at = ? WHERE id = ?",
                (*fields.values(), _now_ms(), chat_id),
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
            permission_profile=row[6],
            mcp_overrides=_decode_mcp_overrides(row[7]),
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
            thinking=row[6],
            permission_profile=row[7],
        )
