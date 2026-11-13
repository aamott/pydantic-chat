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
