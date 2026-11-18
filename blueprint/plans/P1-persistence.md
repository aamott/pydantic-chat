# P1 — Persistence, workspaces & chats

**Status:** spec'd · **Depends on:** P1-foundation

## Goal

Durable app state: one `app.db`, workspace registration, chat records with
version trees, and the server-side conversation history the wire protocol
depends on.

## Architecture decisions

- **One database** at Electron `userData/app.db`, opened only by the backend
  (renderer never gets a path). Stdlib `sqlite3`, WAL mode, short-lived
  connections or a single guarded connection — copy whichever the harness's
  `SqliteStepStore` pattern supports best.
- **`ConversationStore` implementation:** hand-rolled over our own
  per-`ModelMessage` rows — that schema is what makes lossless resume and
  branch/fork cheap. **Evaluated and rejected** the bundled
  `pydantic_ai_harness.step_persistence.conversations.SqliteConversationStore`:
  it's a session-browser store (`save(summary, messages)`/`get`/`listing`),
  not the ABC — it has no `read_record`/`read_entry` methods and cannot be
  passed as `conversation_store=`. (Borrow its CAS/media-externalization/
  search-index ideas where useful.)
- **Version tree:** prompt edit/retry/regenerate create sibling versions via
  `ConversationStore.branch`/`fork`; the chat record points at a head
  version. Version switching never rewrites history rows.
- **`conversation_scope = workspace_id`** — history is isolated per
  workspace folder; a chat cannot leak context across workspaces.
- **Workspaces** are registered folder paths (add/remove/rename), each with
  its own settings overrides and MCP enable mask.
- **Settings storage is a split** (verified): `secrets.json` (`chmod 600`,
  userData) holds **API keys only** — separate from `app.db` so the db can
  be deleted without losing keys; global defaults + custom profiles live in
  the sqlite `settings` KV table. Secrets never logged, never returned
  unmasked.
- **Nothing writes into workspace folders** — db, settings, logs, plans all
  live under userData.

## Stories

| Story | Acceptance criteria |
|---|---|
| Store decision + schema | ✅ decision made — hand-rolled `ConversationStore` over per-`ModelMessage` rows (bundled `SqliteConversationStore` is a session-browser, not the ABC — see decision above); story is now: schema + migrations path (schema version table) |
| `app.db` + app tables | Workspaces, chats, versions, settings-KV tables; WAL; created lazily on first boot; all access behind a typed `db/` module (no SQL outside it) |
| Workspaces API + UI | Register/remove/rename folders; chat list grouped per workspace; workspace switch preserves per-chat drafts + open-file refs; per-workspace settings overrides stored |
| Chats API | CRUD, titles, per-chat overrides (model/thinking/profile/judge), version list + head pointer; delete cascades to conversation rows; auto-title from first user prompt while title is "New chat" (~40 chars) |
| ConversationStore impl | `load`/`save`/`branch`/`fork`/`list_conversations` + entry ops pass a round-trip test; `conversation_scope` isolates workspaces; concurrent saves serialize correctly |
| Settings storage | `secrets.json` chmod 600 for keys + sqlite KV for defaults/profiles; masked read API; validated writes; secrets never in logs or `/api` responses unmasked; workspace rows flag `missing` when the folder is gone (UI badge downstream) |

## Non-goals

Streaming, agent behavior, file APIs, MCP runtime — later epics.
