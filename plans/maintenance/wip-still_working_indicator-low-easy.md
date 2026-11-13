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
