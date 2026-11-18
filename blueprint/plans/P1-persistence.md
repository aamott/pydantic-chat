# P1 — Persistence, workspaces & chats

**Status:** todo · **Order:** 2nd · **Depends on:** P1-foundation

## Goal

Durable app state: one `app.db`, workspace registration, chat records with
version trees, and the server-side conversation history the wire depends on.

## Architecture decisions

- **One database** at `userData/app.db`, backend-only access (renderer never
  gets a path). Stdlib `sqlite3`, WAL. Conversation, step, and plan stores
  share this file, not table ownership: app migrations own app tables;
  harness stores own theirs. Test initialization and writes together.
- **Hand-rolled `ConversationStore`** over per-`ModelMessage` rows — that
  schema makes lossless resume and branch/fork cheap. (Bundled
  `SqliteConversationStore` evaluated → session-browser API, can't feed
  `conversation_store=`; rejected.) Working example:
  `references/conversation-store.py`. ABC contract:
  `specs/pydantic-ai.md` §ConversationStore.
- **Version tree:** edit/retry/regenerate → `branch`/`fork` siblings; the
  chat row points at a head version; switching never rewrites rows.
- **`conversation_scope = workspace_id`** — history isolates per workspace;
  mismatch → 404.
- **Workspaces:** registered folder paths; each carries `permission_profile`
  + `mcp_overrides` (no model defaults — see P1-settings-registry).
- **Settings split:** permission-restricted `secrets.json` (provider keys
  and MCP env/header credentials) + sqlite `settings` KV (non-secret config,
  defaults, custom profiles). Secrets never logged or returned unmasked.
- **No app state in workspace folders** — db, secrets, logs all live under
  userData. User-requested editor/agent file changes are separate.

## Stories (in order)

1. **Schema + migrations** — workspaces/chats/versions/settings-KV tables;
   WAL; `schema_version` table; lazy create on first boot; all SQL behind a
   typed `db/` module.
2. **`ConversationStore` impl** — the 5 abstract methods (`read_record`,
   `write_record`, `read_records`, `delete_record`, `read_entry`) pass a
   round-trip test; `branch`/`fork`/`list_conversations`/`delete` work;
   `conversation_scope` isolates; CAS (`revision`) serializes concurrent
   saves → `ConversationConflict`.
3. **Workspaces API + UI** — register/remove/rename folders; chat list
   grouped per workspace; switch preserves per-chat drafts + open tabs;
   `missing` flag when the folder is gone (UI badge).
4. **Chats API** — CRUD, titles, per-chat overrides (model/thinking/
   profile/judge), version list + head pointer; auto-title from first user
   prompt while `"New chat"` (~40 chars); delete cascades.
5. **Settings storage** — restricted `secrets.json` + sqlite KV; validated
   storage and masking helpers for the settings epic's API. POSIX `0600`,
   equivalent owner-only restrictions on Windows; no unmasked reads/logs.


