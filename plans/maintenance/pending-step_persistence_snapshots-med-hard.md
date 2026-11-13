# StepPersistence mid-turn snapshots

## Goal

Adopt `pydantic-ai-harness`' `StepPersistence` so interrupted runs snapshot at tool boundaries — the foundation for resuming a failed turn without re-running completed side-effecting tools. `docs/research/conversation-durability.md` has the design + footguns.

## Acceptance criteria

- `SqliteStepStore` in `data_dir()` (`steps.db` or `app.db` — pick consistent with existing persistence); `StepPersistence` capability added in `build_run_kwargs`.
- Snapshots recorded at settled tool boundaries + `on_run_error` (verify in tests).
- Resume path designed + documented: `continue_run` output lacks UI message ids — feeding it back as `message_history` breaks edit/regenerate (doc §footguns). If feasible, add `POST /api/chats/{id}/resume` continuing the last interrupted run; if the UI-message-id coupling makes it unsafe for this slice, land snapshots + tests only and document the resume design in the story.
- TDD: snapshot recorded on a FunctionModel run with a tool call; snapshot on injected error; no behavior change to the normal chat path (all 183 existing tests still green).

## File references

- `docs/research/conversation-durability.md` — StepPersistence/continue_run/fork_run analysis
- `apps/backend/app/agent/factory.py` — capability assembly
- `apps/backend/app/api/chat.py` — adapter + persistence points
