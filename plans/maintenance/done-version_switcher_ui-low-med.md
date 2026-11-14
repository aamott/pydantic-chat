# Version switcher UI (conversation branches)

## Goal

Edit/retry already preserves replaced tails via `ConversationStore` branches (`record.branches`) — expose them: let a user see prior versions of an edited prompt and switch back.

## Acceptance criteria

- Messages that were replaced by an edit get a subtle "edited — N previous version(s)" affordance; clicking lists the replaced prompts (text preview + timestamp).
- Choosing a version resubmits it via the native cut semantics (`sendMessage({text, messageId})`) or `store.fork()`/`branch()` per `docs/research/conversation-durability.md` — whichever preserves current tail behavior; document choice.
- Backend: expose branch info in `GET /api/chats/{id}/messages` (or a sibling endpoint) — `ConversationStore.record.branches` shape per installed source.
- TDD both sides where testable; `bun run verify` + pytest green.

## File references

- `docs/research/conversation-durability.md` — branch semantics + fork()/branch() guidance
- `apps/backend/app/api/chat.py`, `app/db/` — ConversationStore impl
- `apps/desktop/src/renderer/src/features/chat/MessagePart.tsx`

## Implementation notes (2026-11-13)

- **Branch-storage shape (verified, `pydantic-ai-slim 2.68.0`
  `conversation_store.py`):** `ConversationRecord.branches: list[str]` is a
  list of *entry ids* — the tips of tails the conversation left, oldest
  first. A tip resolves with `store.read_history(tip)`, which returns the
  branch's whole chain *including the prefix it shares with head* (same
  entry ids). Version attribution = first entry of the branch chain whose
  id isn't in the head chain at the same index (`_first_diverging_entry`);
  when that entry is a `ModelRequest` with a `UserPromptPart`, its
  `get_ui_message_id` (the `metadata['__pydantic_ai__']['ui_message_id']`
  the adapter stamps on load) equals the transcript `UIMessage.id` of the
  prompt it replaced.
- **Data flow chosen: sibling endpoint, not the messages payload.**
  `GET /api/chats/{id}/versions` → `{versions: [{id, message_id, tip,
  text, timestamp}]}`, oldest-left first (`ChatVersionsOut` /
  `PromptVersionOut`; `PromptVersion` in `packages/shared`). `id` is the
  diverging entry id (stable key); `tip` is the branch tip — the
  `from_entry` a future `store.branch()` checkout would pass.
  `GET .../messages` keeps returning bare `UIMessage[]` so the hydration
  contract is untouched.
- **Reactivation via `sendMessage({text, messageId})`, not
  `store.branch()`/`fork()`** (choice documented per AC): picking a
  version resubmits its prompt text through the same edit path
  (`resubmitUserMessage` → `MessageList.onEditMessage`). The SDK truncates
  client state at the target message; the server cuts stored history at
  the matching `ui_message_id` and the *current* tail becomes a new branch
  on the next save — so switching back and forth preserves everything.
  A `store.branch(from_entry=tip)` checkout would restore the abandoned
  tail *including its old responses* without re-running, but needs a new
  endpoint + revision plumbing + client `setMessages` surgery; the
  resubmit path needs none and matches the story's "resubmits that
  version" wording.
- **Frontend:** `VersionChip` under edited user bubbles ("edited — N
  previous version(s)" → `Popover` of `optionRowStartClass` rows: text
  preview + `formatRelativeTime`); `versions` lives in `useChatsStore`
  keyed by chat id, fetched in `hydrateChat` and re-fetched on
  busy→ready/error transitions (branches only change on save); pruned on
  chat/workspace delete. `versionsForMessage` (lib/versions.ts) filters +
  newest-first.
- **Edge cases:** chip disabled while `status !== 'ready'` (busy =
  mid-run); versions are server truth so stream reconnect can't desync the
  list; pending approvals on the abandoned tail are truncated client-side
  by the resubmit and cleared server-side by the cut's rebuild without
  `deferred_tool_requests` (same semantics as edit).
- **Tests:** backend `test_api.py` — endpoint 404/empty, single-branch
  attribution, multi-branch ordering + non-prompt-tail skip. Frontend —
  `lib/versions.test.ts` (4), `VersionChip.test.tsx` (4),
  `MessageList.test.tsx` (2).
