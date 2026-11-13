# "Still working" elapsed indicator during slow first tokens

## Goal

Free-tier Gemini can take 1–4 min to first token — the stream emits `start` then silence, and the chat looks dead. Show an elapsed indicator during `submitted`/`streaming` status so long thinking reads as working.

## Acceptance criteria

- While `status === 'submitted'` or `'streaming'` and no assistant text has arrived for the current run, the message area shows a subtle "Working… (Xs)" indicator with a ticking elapsed counter.
- Once the first assistant token/part arrives, the indicator is replaced by normal streamed content (or keeps ticking subtly alongside tool calls — designer's call; document choice).
- Resets per run; disappears on error/stop/ready.
- Pure-helper logic (elapsed formatting, when-to-show rules) gets vitest coverage; `bun run verify` green.

## File references

- `apps/desktop/src/renderer/src/features/chat/{ChatPanel,MessageList}.tsx` — status plumbing
- `apps/desktop/src/renderer/src/features/chat/Composer.tsx` — status→busy mapping for reference

## Resolution

Implemented as `WorkingIndicator` in `MessageList.tsx` backed by pure helpers in `lib/workingIndicator.ts` (`formatElapsed`, `runHasVisibleOutput`, `showWorkingIndicator`; 21 vitest cases).

**Design choice — replaced by content, not kept during tool calls:** the indicator shows only while a live run's tail assistant message renders nothing yet (`step-start` <hr>s, empty text placeholders, and hidden `data-run-meta`/`data-shell` parts don't count). First rendered part — text token, reasoning "Thinking…" collapsible, tool card, plan card — replaces it, because tool phases already carry their own liveness badges ("calling…") and a second timer would be redundant noise. Per-run reset falls out of mount/unmount: `showWorkingIndicator` flips false at ready/error/stop, unmounting the component and its 1s `setInterval`, so the next run starts a fresh clock.
