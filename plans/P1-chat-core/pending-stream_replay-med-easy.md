# Stream replay route

## Goal

`GET /api/chat/{chat_id}/stream` replays/resumes an in-flight or finished SSE stream so `useChat({resume:true})` / `reconnectToStream` actually reconnects after reload.

## Context

Frontend transport (`lib/transport.ts`) already calls it and degrades on 404. Check `VercelAIAdapter`/UI adapter source for replay support (`resumeStreamIsReplay` default on the client; the wire expects the same UI-message-stream chunk sequence — replaying stored serialized events or re-emitting stored messages). Simplest viable: re-emit the stored conversation's messages as a completed stream; in-flight run replay is harder — if the adapter doesn't expose the in-flight event buffer, returning the last persisted state + letting the client reattach may be acceptable for v1 (document choice).

## Acceptance criteria

- Route exists behind `_check_auth`; 404 for unknown chat
- After reload during/after a run, `reconnectToStream` returns a valid stream (not error) and the client shows consistent state
- Test: run completes → GET stream → SSE replays stored messages without error

## Files
- `apps/backend/app/api/chat.py`

## Depends on
- done-chat_endpoint-high-med.md; unblocks wip-chat_client-high-med.md reconnect AC
