# Drop trailing empty ModelResponse on interrupted-run saves

## Goal

A run stopped mid-model-request — cancelled via `/stop` or killed by a
provider error/disconnect before the first part — commits an in-flight
`ModelResponse(parts=[], state='interrupted'|'suspended')` as the graph's
teardown records the half-open step. Both of our persistence paths
(`_persist_partial` on `RunCancelled`, `AppVercelAIAdapter._save_captured`
on run failure) then save that ghost entry: `GET /messages` projects an
empty assistant `UIMessage`, and the ghost contributes to resubmit-merge
confusion. Strip a *trailing* empty `ModelResponse` from the captured
history in one shared helper before `store.save`, in both paths.

## Acceptance criteria

- Cancelling a run whose model request never produced a part persists the
  user prompt but no `ModelResponse(parts=[])` on the stored entry chain;
  `GET /messages` returns only the user message (no empty assistant turn).
- A model failing mid-request before any part likewise persists no
  trailing `ModelResponse(parts=[])`.
- A trailing response with real (interrupted) parts is still persisted —
  `test_stop_cancels_run_and_saves_partial` and
  `test_failed_run_persists_failed_turn` keep passing.
- Only the trailing entry is stripped: an empty `ModelResponse` earlier in
  history (if one ever occurs) is left untouched.
- `uv run pytest -q` green; `uv run ruff check app tests` clean.

## Files

- `apps/backend/app/api/chat.py` (shared strip helper; applied in
  `_persist_partial` and `AppVercelAIAdapter._save_captured`)
- `apps/backend/tests/test_chat.py`

## Depends on

- none

## Implementation notes (2026-03-30)

- `_drop_trailing_empty_response` in `apps/backend/app/api/chat.py` returns a
  copy of the history with a trailing `ModelResponse(parts=[])` popped
  (`while` loop — only the tail). Applied in both save paths we own:
  `_persist_partial` (cancel/`on_cancel`) on `cancelled_run.all_messages()`,
  and `AppVercelAIAdapter._save_captured` (failure/disconnect) on the
  `capture_run_messages()` list, each before `store.save`.
- Criterion is `parts == []` alone, not `state`: the ghost arrives as
  `'interrupted'` on cancel/failure but `'suspended'` on a walk-away
  disconnect (`_interrupted_stream_response` keeps `'suspended'` for
  `GeneratorExit`). An empty response is never renderable — pydantic-ai's own
  sanitizer drops `ModelResponse` with no parts outright.
- Verified empirically via probe tests: a `FunctionModel` that hangs (or
  raises) before its first yield persists `[ModelRequest, ModelResponse(
  parts=[], state='interrupted')]` on both paths; the graph commits the
  half-open step during teardown before `RunCancelled` snapshots history.
- Tests: `test_stop_before_first_token_saves_no_empty_response` (deterministic
  via a `threading.Event` set inside `stream_function`), and
  `test_failed_run_before_first_token_saves_no_empty_response`, plus a unit
  test pinning tail-only stripping. No existing assertions changed —
  `test_stop_cancels_run_and_saves_partial` /
  `test_failed_run_persists_failed_turn` produce interrupted responses *with*
  parts, which are still persisted.
- `uv run pytest -q`: 111 passed. `uv run ruff check app tests`: clean.
