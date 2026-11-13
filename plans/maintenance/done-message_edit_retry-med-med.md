# Message edit / retry / regenerate UX

## Goal

Fix the dead-end after a failed run (error banner Retry → `regenerate()` is
guaranteed to fail when nothing was stored) and expose the SDK's native
resubmit path: `sendMessage({text, messageId})` covers retry-after-error,
retry-after-cancel, and editing any past user message in one mechanism —
the server cuts history at the matched user prompt and keeps the replaced
tail as a branch. `regenerate({messageId})` remains only for re-answering a
completed assistant response.

See `docs/research/conversation-durability.md` for the settled design.

## Acceptance criteria

- Error banner "Retry" resubmits the last user message via
  `sendMessage({text, messageId})` — never `regenerate()`. Hidden/disabled
  when no user message exists.
- Composer stays enabled while `status === 'error'` so the user can also
  retype.
- User bubbles get a hover edit affordance → inline textarea pre-filled
  with the message text → Save resubmits via `sendMessage({text, messageId})`;
  Escape cancels. Affordances hidden while a run is live
  (`submitted`/`streaming`).
- "Regenerate" affordance on the LAST assistant message only, calling
  `regenerate({messageId})`; hidden on failed/error states and while a run
  is live.
- New pure helpers (`messageText`, `lastUserMessage`, `lastAssistantMessage`)
  in `lib/messages.ts` with unit tests; vitest wired into
  `bun run verify` so tests gate.
- `bun run verify` clean; strict TS; no new runtime deps (vitest dev-dep
  only); tailwind only.

## Files

- `apps/desktop/src/renderer/src/features/chat/ChatPanel.tsx`
- `apps/desktop/src/renderer/src/features/chat/MessageList.tsx`
- `apps/desktop/src/renderer/src/lib/messages.ts` (new)
- `apps/desktop/src/renderer/src/lib/messages.test.ts` (new)
- `apps/desktop/package.json`, `apps/desktop/vitest.config.ts` (new)

## Depends on

- none

## Implementation notes (2026-03-28)

- `lib/messages.ts` (new): `messageText` (joins `text` parts),
  `lastUserMessage` (latest `role==='user'`), `lastAssistantMessage`
  (trailing assistant only — regenerate guard). 14 unit tests in
  `lib/messages.test.ts`; written test-first.
- `ChatPanel.tsx`: error-banner Retry now resubmits the last user message
  via `sendMessage({text, messageId})` (`resubmitUserMessage`); Retry is
  hidden when no user message exists. `disabled={status === 'error'}`
  removed from `Composer` — `sendMessage` self-clears `error` via
  `makeRequest`. `onEditMessage`/`onRegenerate` threaded to `MessageList`;
  `regenerate({messageId})` signature verified in
  `node_modules/ai/src/ui/chat.ts:510-543`.
- `MessageList.tsx`: hover pencil on user bubbles swaps the bubble for an
  inline `UserEditRow` textarea (Enter = save, Shift+Enter = newline,
  Escape = cancel, auto-grow, autofocus); Save calls
  `onEditMessage(id, trimmed)`. Editor reverts to a bubble if a run starts.
  Regenerate button (`RotateCcw`, hover-revealed) renders only on the
  trailing assistant message while `status === 'ready'`. User bubble text
  now uses `messageText()` instead of inline filtering.
- No manual `setMessages` truncation needed: `sendMessage` with
  `messageId` slices `state.messages` at that id and replaces the text
  client-side (`chat.ts:459-503`); the server cuts or appends per whether
  the id was stored.
- Tooling: `vitest@5.1.0` dev-dep, `vitest.config.mts` (node env, pure
  helpers only — no DOM needed), `test` script added and `vitest run`
  appended to `verify` so tests gate. `bun run verify` clean.
- Untested live paths (need a real provider key): end-to-end retry after
  provider error, server-side branch preservation after edit, and the
  `sendMessage`-during-`error` status transition.
