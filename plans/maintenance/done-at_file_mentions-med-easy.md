# @file mentions in composer

## Goal

Typing `@` in the chat composer opens a fuzzy workspace-file picker; selecting a file inserts a `file:path` link into the prompt that the model reads via its existing tools. Same semantics as the `+` attach button — this is the keyboard-first version.

## Acceptance criteria

- Typing `@` in the composer (at word boundary) opens an inline file list filtered as the user types, using the existing workspace files endpoint (`GET /api/workspaces/{id}/files` tree) — no new backend endpoint needed unless genuinely required.
- Arrow keys navigate, Enter/Tab inserts `file:relative/path` link syntax matching `lib/fileRefs.ts` / `MessagePart.tsx` conventions, Escape closes the list without inserting.
- Inserted mention is plain text `file:` link (same as `+` attach output) so the model treats it identically.
- The `@` token being typed is replaced by the inserted link; typing `@` inside an email/code context (already-non-word start handling) should not surprise — document the trigger rule chosen.
- Vitest coverage for trigger/filter/insert logic; `bun run verify` green.

## File references

- `apps/desktop/src/renderer/src/features/chat/ChatPanel.tsx` — composer textarea
- `apps/desktop/src/renderer/src/lib/fileRefs.ts` — `file:` link parsing conventions
- `apps/desktop/src/renderer/src/features/chat/MessagePart.tsx` — link interception
- `apps/backend/app/api/files.py` — workspace tree endpoint (`_build_tree`, `GET /{workspace_id}/files`)
- The existing `+` attach picker in `ChatPanel.tsx` — reuse its file-list fetching/filtering
