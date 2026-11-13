# Persist failed runs to the conversation store

## Goal

A run that dies mid-turn (provider exception or client disconnect) currently
persists nothing — not even the user prompt — because the adapter only saves
on `AgentRunResultEvent` and `on_cancel` only fires for `RunCancelled`. The
stored history then diverges from the client's transcript: a resubmit can't
match a stored message, `regenerate()` 400s, and the failed turn vanishes on
reload. Subclass `VercelAIAdapter` so the at-failure history
(`capture_run_messages()`) is saved, mirroring the `_persist_partial` cancel
path. See `docs/research/conversation-durability.md` §B for the settled
design.

## Acceptance criteria

- A mid-stream provider error still ends the SSE response with an `error`
  chunk, and afterwards `store.load(chat_id, scope)` contains the user
  prompt plus whatever the failed turn produced (interrupted tail).
- A follow-up `POST /api/chat` resending the same user `UIMessage.id`
  (`sendMessage({text, messageId})` semantics) succeeds and stores exactly
  one user request for that turn — the failed tail is kept as a
  `record.branches` tip, not duplicated.
- Client disconnect mid-stream (`GeneratorExit`/`CancelledError`, which
  bypasses the adapter's `except Exception`) also persists the captured
  history via the same path.
- `RunCancelled` is untouched — `on_cancel`/`_persist_partial` still owns
  that path; successful runs save exactly once (no double persist after
  `AgentRunResultEvent`).
- `data-conversation-saved`, the replay route, `/stop`, and the `data-*`
  event bridge all keep working.
- `uv run pytest -q` green; `uv run ruff check app tests` clean;
  `bun run verify` unaffected.

## Files

- `apps/backend/app/api/chat.py` (thin `VercelAIAdapter` subclass + persist
  helper; `stream_chat` dispatches through it)
- `apps/backend/tests/test_chat.py`

## Depends on

- none

## Implementation notes (2026-03-29)

- `AppVercelAIAdapter` in `apps/backend/app/api/chat.py` subclasses
  `VercelAIAdapter` and overrides `transform_stream` to wrap the native
  `AsyncIterator[NativeEvent]` in `capture_run_messages()`. On any
  `BaseException` before `AgentRunResultEvent` (provider error,
  `UsageLimitExceeded`, disconnect `CancelledError`/`GeneratorExit`), the
  captured live history is saved through the same load/replace/save pattern
  as `_persist_partial`; `RunCancelled` is re-raised untouched so
  `on_cancel` keeps owning cancels. The save runs under a shielded anyio
  `CancelScope` because disconnect lands inside an already-cancelled scope
  where further awaits would re-raise. The still-suspended inner stream is
  `aclose()`d first so the run's teardown can record `state='interrupted'`
  parts before the capture is read.
- `stream_chat` now dispatches through `AppVercelAIAdapter`.
- Tests: `test_failed_run_persists_failed_turn` (error chunk + user prompt
  and interrupted response on the entry chain),
  `test_retry_after_failed_run_does_not_duplicate` (resend of the same
  `UIMessage.id` cuts rather than appends; failed tail kept as a
  `record.branches` tip), `test_disconnect_mid_stream_persists_partial`
  (TestClient stream closed after a `text-delta`; same `except
  BaseException` path covers both error and disconnect).
- Delta vs the research doc: failed-run *usage* is not accumulated into the
  stored record (`capture_run_messages` exposes messages only); a failed
  resubmit stores the retried turn via the store's content-comparison
  branching rather than the resubmitted-turn save path. Both harmless.
- `uv run pytest -q`: 102 passed. `ruff check app tests`: clean.
  `bun run verify`: clean.
