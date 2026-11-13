# Transport sends only the new turn (server-managed history)

## Goal

Stop the quadratic history growth when a run is cancelled before the
client receives an assistant response. The backend runs with
`manage_message_history='server'`: `_take_new_turn`
(`pydantic_ai/ui/_adapter.py:564-652`) derives the new turn as the client's
messages after its last `ModelResponse`, and when that turn's first UI id
matches a stored user-prompt request it resubmit-cuts stored history and
replays the whole new turn merged into one `ModelRequest`. POSTing the
full transcript means a client holding `[user1, user2, …]` with no
assistant reply re-triggers that cut every turn, storing a merged request
containing every prior user prompt.

Fix: `prepareSendMessagesRequest` on `BackendChatTransport` POSTs only the
new turn — the client's messages after its last `role === 'assistant'`
message — instead of `options.messages`. Body shape otherwise identical to
the transport default (`{...body, id, messages, trigger, messageId}`;
`node_modules/ai/src/ui/http-chat-transport.ts:191-198`).

## Acceptance criteria

- New exported pure helper `newTurnMessages(messages: UIMessage[])` in
  `lib/messages.ts`: slice after the last `assistant` message; when the
  slice is empty (transcript ends on an assistant message — approval /
  tool-output auto-resubmits) fall back to `[last message]` so `messageId`
  still has a message to ride on; `[]` in → `[]` out.
- `BackendChatTransport` (via `makeTransport`) sets
  `prepareSendMessagesRequest` mirroring the default body with
  `messages: newTurnMessages(messages)`; `api`/`headers`/`credentials`
  omitted so resolved transport values apply. `reconnectToStream`
  untouched.
- Unit tests in `lib/messages.test.ts` cover: single user; user after
  assistant (the bug case); consecutive unanswered user messages;
  resubmit-truncated lone user; assistant tail fallback (approval
  resubmit shape); empty; slices after the LAST assistant.
- `bun run verify` clean; strict TS, no `any`, no new deps.

## Files

- `apps/desktop/src/renderer/src/lib/messages.ts`
- `apps/desktop/src/renderer/src/lib/messages.test.ts`
- `apps/desktop/src/renderer/src/lib/transport.ts`

## Depends on

- none

## Implementation notes (2026-03-29)

- `lib/messages.ts`: added `newTurnMessages(messages: UIMessage[]): UIMessage[]`
  — scans backward for the last `assistant`, returns
  `messages.slice(lastAssistant + 1)`; empty slice falls back to
  `[last message]` (keeps the approval/tool-output auto-resubmit tail,
  which ends on the assistant message carrying the answered part), and an
  empty transcript returns `[]`.
- `lib/transport.ts`: `makeTransport` passes `prepareSendMessagesRequest`
  to the `DefaultChatTransport` constructor — body mirrors the default
  (`{...body, id, messages: newTurnMessages(messages), trigger,
  messageId}`); `api`/`headers`/`credentials` omitted so resolved values
  apply. `reconnectToStream` untouched. Signature verified at
  `node_modules/ai/src/ui/http-chat-transport.ts:24-49,191-198`.
- Test-first: 7 new cases in `messages.test.ts` failed before the helper
  existed, all green after. Note: v7 `UIMessage.role` is
  `'system' | 'user' | 'assistant'` — there is no tool role; tool
  results/approvals are parts on the assistant message (`chat.ts:589-760`),
  so the "tool-result request" case is covered by the assistant-tail
  fallback test.
- `bun run verify` clean (tsc node + web configs, 21 vitest tests).
