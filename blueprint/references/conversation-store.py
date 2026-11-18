"""SQLite persistence layer: a ``ConversationStore`` backend plus app metadata tables.

``ChatStore`` implements the five ``pydantic_ai.conversation_store.ConversationStore``
primitives over stdlib ``sqlite3``, so ``dispatch_request(conversation_store=store)``
gets lossless resume — including pending ``DeferredToolRequests`` — for free. The same
database holds the app's own metadata (``workspaces``, ``chats``, ``settings``), exposed
through :class:`~app.db.app_tables.AppTablesMixin`.

Design notes:

- One connection (``check_same_thread=False``) guarded by a ``threading.Lock``; every
  public async method funnels through a worker thread via ``anyio.to_thread.run_sync``
  so the event loop never blocks on sqlite.
- Entries are a ``parent_id``-linked chain; each row's ``data_json`` is the message
  serialized with ``ModelMessagesTypeAdapter`` (base64 binary parts). Records keep the
  queryable fields (scope, head_id, revision, updated_at) as columns and serialize the
  whole ``ConversationRecord`` — usage, deferred tool requests, branches, fork links —
  into ``data_json`` for forward-compatible hydration.
- Writes use ``BEGIN IMMEDIATE`` so the revision compare-and-swap and the head-entry
  existence check race nothing outside this process either.
- Deleting a record garbage-collects entries no remaining record's head or branch tips
  reach, mirroring ``InMemoryConversationStore`` semantics.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import ParamSpec, TypeVar

from anyio.to_thread import run_sync
from pydantic import TypeAdapter
from pydantic_ai.conversation_store import (
    ConversationConflict,
    ConversationEntry,
    ConversationRecord,
    ConversationStore,
)
from pydantic_ai.messages import ModelMessagesTypeAdapter

from app.config import data_dir
from app.db.app_tables import AppTablesMixin
from app.db.schema import MIGRATIONS

logger = logging.getLogger(__name__)

_P = ParamSpec("_P")
_T = TypeVar("_T")

_RECORD_ADAPTER = TypeAdapter(ConversationRecord)
"""Whole-record (de)serializer: usage, deferred requests, branches and fork links in one column."""

_DEPTH_LIMIT = 2**62
"""Effectively-unbounded entry-chain depth for ``read_history`` calls without a limit."""


def _epoch_ms(value) -> int:
    """Unix-ms integer for a tz-aware ``datetime`` from a stored record."""
    return int(value.timestamp() * 1000)


class ChatStore(AppTablesMixin, ConversationStore):
    """SQLite-backed conversation store and app-metadata store in one ``app.db``.

    Implements ``pydantic_ai.conversation_store.ConversationStore`` so it can be passed
    straight to ``dispatch_request(conversation_store=...)``, and additionally exposes
    thin CRUD for the app's ``workspaces`` / ``chats`` / ``settings`` tables via
    ``AppTablesMixin``.

    Args:
        db_path: Database file location. Defaults to ``data_dir() / "app.db"``
            (``APP_DATA_DIR`` env or ``./.data``). Pass an explicit path (e.g. under
            ``tmp_path``) in tests.

    Attributes:
        db_path: Resolved path of the database file.
    """

    def __init__(self, db_path: str | Path | None = None) -> None:
        self.db_path = Path(db_path) if db_path is not None else data_dir() / "app.db"
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._lock = threading.Lock()
        self._migrate()
        logger.info("ChatStore opened at %s", self.db_path)

    def close(self) -> None:
        """Close the connection; the store is unusable afterwards."""
        with self._lock:
            self._conn.close()

    async def _run(
        self, fn: Callable[_P, _T], /, *args: _P.args, **kwargs: _P.kwargs
    ) -> _T:
        """Run a blocking sqlite call under the lock on a worker thread."""

        def call() -> _T:
            with self._lock:
                return fn(*args, **kwargs)

        return await run_sync(call)

    def _migrate(self) -> None:
        """Apply pending migrations in order, tracked by ``PRAGMA user_version``."""
        version = self._conn.execute("PRAGMA user_version").fetchone()[0]
        for index in range(version, len(MIGRATIONS)):
            logger.info("Applying DB migration %d -> %d", index, index + 1)
            self._conn.executescript(
                f"BEGIN;\n{MIGRATIONS[index]}\nPRAGMA user_version={index + 1};\nCOMMIT;"
            )

    # ------------------------------------------------------------------
    # ConversationStore primitives
    # ------------------------------------------------------------------

    async def read_record(self, conversation_id: str) -> ConversationRecord | None:
        """The record for a conversation, or ``None`` if the store doesn't have it."""
        return await self._run(self._read_record_row, conversation_id)

    def _read_record_row(self, conversation_id: str) -> ConversationRecord | None:
        row = self._conn.execute(
            "SELECT data_json FROM conversation_records WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchone()
        return None if row is None else _RECORD_ADAPTER.validate_json(row[0])

    async def read_records(
        self, *, scope: str | None = None, limit: int | None = None
    ) -> Sequence[ConversationRecord]:
        """Stored records, optionally scoped, newest ``updated_at`` first, at most ``limit``."""
        return await self._run(self._read_records, scope, limit)

    def _read_records(
        self, scope: str | None, limit: int | None
    ) -> list[ConversationRecord]:
        rows = self._conn.execute(
            "SELECT data_json FROM conversation_records "
            "WHERE (? IS NULL OR scope = ?) "
            "ORDER BY updated_at DESC, conversation_id LIMIT ?",
            (scope, scope, limit if limit is not None else -1),
        ).fetchall()
        return [_RECORD_ADAPTER.validate_json(row[0]) for row in rows]

    async def write_record(
        self,
        record: ConversationRecord,
        *,
        new_entries: Sequence[ConversationEntry] = (),
        expected_revision: str | None,
    ) -> None:
        """Store a record and its new entries atomically, CAS-checked on ``expected_revision``.

        Raises:
            ConversationConflict: If the stored revision isn't ``expected_revision``, a
                record exists when ``expected_revision`` is ``None``, or ``record.head_id``
                names an entry neither the store nor ``new_entries`` has.
        """
        await self._run(self._write_record, record, new_entries, expected_revision)

    def _write_record(
        self,
        record: ConversationRecord,
        new_entries: Sequence[ConversationEntry],
        expected_revision: str | None,
    ) -> None:
        new_ids = {entry.id for entry in new_entries}
        with self._conn:
            self._conn.execute("BEGIN IMMEDIATE")
            row = self._conn.execute(
                "SELECT revision FROM conversation_records WHERE conversation_id = ?",
                (record.conversation_id,),
            ).fetchone()
            if (row[0] if row is not None else None) != expected_revision:
                raise ConversationConflict(record.conversation_id)
            if record.head_id is not None and record.head_id not in new_ids:
                head = self._conn.execute(
                    "SELECT 1 FROM conversation_entries WHERE entry_id = ?",
                    (record.head_id,),
                ).fetchone()
                if head is None:
                    raise ConversationConflict(record.conversation_id)
            self._conn.executemany(
                "INSERT OR IGNORE INTO conversation_entries "
                "(entry_id, conversation_id, parent_id, data_json) VALUES (?, ?, ?, ?)",
                [
                    (
                        entry.id,
                        record.conversation_id,
                        entry.parent_id,
                        ModelMessagesTypeAdapter.dump_json([entry.message]).decode(),
                    )
                    for entry in new_entries
                ],
            )
            self._conn.execute(
                "INSERT OR REPLACE INTO conversation_records "
                "(conversation_id, scope, head_id, revision, data_json, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    record.conversation_id,
                    record.scope,
                    record.head_id,
                    record.revision,
                    _RECORD_ADAPTER.dump_json(record).decode(),
                    _epoch_ms(record.updated_at),
                ),
            )
        logger.debug(
            "Wrote record %s (revision %s, %d new entries)",
            record.conversation_id,
            record.revision,
            len(new_entries),
        )

    async def delete_record(
        self, conversation_id: str, *, expected_revision: str
    ) -> None:
        """Delete a record, CAS-checked, then GC entries no remaining record reaches.

        Entries still referenced by another conversation (e.g. a fork sharing the
        history) are kept; everything unreachable is removed.

        Raises:
            ConversationConflict: If no record with ``expected_revision`` is stored.
        """
        await self._run(self._delete_record, conversation_id, expected_revision)

    def _delete_record(self, conversation_id: str, expected_revision: str) -> None:
        with self._conn:
            self._conn.execute("BEGIN IMMEDIATE")
            row = self._conn.execute(
                "SELECT revision FROM conversation_records WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
            if row is None or row[0] != expected_revision:
                raise ConversationConflict(conversation_id)
            self._conn.execute(
                "DELETE FROM conversation_records WHERE conversation_id = ?",
                (conversation_id,),
            )
            collected = self._gc_entries()
        logger.debug(
            "Deleted record %s; GC removed %d entries", conversation_id, collected
        )

    def _gc_entries(self) -> int:
        """Delete entries unreachable from any record's ``head_id`` or ``branches`` tips."""
        cursor = self._conn.execute(
            """
            WITH RECURSIVE reachable(entry_id) AS (
                SELECT head_id FROM conversation_records WHERE head_id IS NOT NULL
                UNION
                SELECT tip.value
                FROM conversation_records r, json_each(r.data_json, '$.branches') tip
                UNION
                SELECT e.parent_id
                FROM conversation_entries e
                JOIN reachable ON e.entry_id = reachable.entry_id
                WHERE e.parent_id IS NOT NULL
            )
            DELETE FROM conversation_entries
            WHERE entry_id NOT IN (SELECT entry_id FROM reachable)
            """
        )
        return cursor.rowcount

    async def read_entry(self, entry_id: str) -> ConversationEntry:
        """The entry with this identifier.

        Raises:
            LookupError: If the store has no such entry.
        """
        return await self._run(self._read_entry, entry_id)

    def _read_entry(self, entry_id: str) -> ConversationEntry:
        row = self._conn.execute(
            "SELECT entry_id, parent_id, data_json FROM conversation_entries "
            "WHERE entry_id = ?",
            (entry_id,),
        ).fetchone()
        if row is None:
            raise LookupError(f"No conversation entry {entry_id!r}")
        return self._entry_from_row(row)

    async def read_history(
        self, head_id: str | None, *, limit: int | None = None
    ) -> list[ConversationEntry]:
        """Entries from the first one up to ``head_id``, in order — one recursive query.

        Raises:
            LookupError: If ``head_id`` is stored nowhere, or the chain to the first
                entry is broken.
        """
        return await self._run(self._read_history, head_id, limit)

    def _read_history(
        self, head_id: str | None, limit: int | None
    ) -> list[ConversationEntry]:
        if head_id is None:
            return []
        rows = self._conn.execute(
            """
            WITH RECURSIVE chain(entry_id, parent_id, data_json, depth) AS (
                SELECT entry_id, parent_id, data_json, 0
                FROM conversation_entries WHERE entry_id = ?
                UNION ALL
                SELECT e.entry_id, e.parent_id, e.data_json, c.depth + 1
                FROM conversation_entries e
                JOIN chain c ON e.entry_id = c.parent_id
                WHERE c.depth + 1 < ?
            )
            SELECT entry_id, parent_id, data_json FROM chain ORDER BY depth DESC
            """,
            (head_id, limit if limit is not None else _DEPTH_LIMIT),
        ).fetchall()
        if not rows:
            raise LookupError(f"No conversation entry {head_id!r}")
        entries = [self._entry_from_row(row) for row in rows]
        if entries[0].parent_id is not None and (limit is None or len(entries) < limit):
            # Walked to the start without reaching a root: a parent is missing.
            raise LookupError(f"History of entry {head_id!r} is missing entries")
        return entries

    @staticmethod
    def _entry_from_row(row: sqlite3.Row | tuple) -> ConversationEntry:
        (message,) = ModelMessagesTypeAdapter.validate_json(row[2])
        return ConversationEntry(id=row[0], parent_id=row[1], message=message)
