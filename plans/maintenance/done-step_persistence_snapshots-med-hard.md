# StepPersistence mid-turn snapshots

## Goal

Adopt `pydantic-ai-harness`' `StepPersistence` so interrupted runs snapshot at tool boundaries — the foundation for resuming a failed turn without re-running completed side-effecting tools. `docs/research/conversation-durability.md` has the design + footguns.

## What landed

- `build_run_kwargs` (factory.py) adds `_step_persistence_capability()` to the per-run `capabilities` list: `StepPersistence(store=SqliteStepStore(database=data_dir() / "steps.db"))`. `run_id`/`agent_name` unset → each run keys on `ctx.run_id` (unique per `Agent.run`, satisfying `register_run`'s single-shot contract); the chat id lands on `RunRecord.conversation_id`/`ContinuableSnapshot.conversation_id` because the adapter passes the `Conversation` through, so `list_runs(conversation_id=chat_id)` finds a chat's runs newest-last.
- Store location: `data_dir()/steps.db` — a sibling to `plans.db`, NOT `app.db`. `SqliteStepStore` owns its schema outright (runs, events, snapshots, tool effects, snapshot-message refs, media); `app.db` stays `ChatStore`-owned.
- Snapshot timing proven by `tests/test_step_persistence.py` (3 tests, e2e through `POST /api/chat`):
  - a completed `shell` call (bypass profile) lands a `complete` `ContinuableSnapshot` whose tail is the settled tool-return request — the pending `ModelRequestNode` folded in at the `CallToolsNode` boundary;
  - a model dying mid-response after a settled tool call records a `run_failed` event + at-failure snapshot that still carries the completed tool return and ends on the in-flight `ModelResponse` — past the boundary snapshot;
  - `build_run_kwargs` wiring: exactly one `StepPersistence` on `SqliteStepStore` at `data_dir()/steps.db`.
- No behavior change to the normal chat path: `SnapshotSavedEvent` is a `CapabilityEvent` the Vercel stream ignores (`handle_capability_event` is a no-op); 197 tests green (183 baseline + in-flight tests + 3 new).

## Resume path: DEFERRED — blockers

`POST /api/chats/{id}/resume` via `continue_run` was not landed; the UI-message-id durability contract makes it unsafe in this slice:

1. **No wire trigger.** `POST /api/chat` speaks `submit-message`/`regenerate-message`; both require the last client `UIMessage` to drive `_take_new_turn`. A server-initiated continuation has no client `UIMessage`. The only reattach mechanism the SDK has is `reconnectToStream` (`GET .../stream`), which expects a replay of the in-flight run, not a new run.
2. **`message_history` injection collides with `manage_message_history='server'`.** `dispatch_request` builds run history from the `conversation_store` (stored head + client's new turn); a `continue_run` history passed as `message_history` is *prepended* to that, duplicating the conversation (`ui/_adapter.py:1561-1567`). Resuming mid-turn means bypassing the adapter's conversation load — which also means reimplementing `_saving_conversation`, `AppVercelAIAdapter._persist_failed_run`, and `ui_message_id` stamping.
3. **UI-message-id durability.** Resubmit-cut matches `new_turn[0]`'s `ui_message_id` to a stored `ModelRequest` with a `UserPromptPart` (doc §2). A resumed run produces output with no corresponding client request; saving it would diverge the stored head from the client transcript and poison later resubmit cuts / `record.branches`.
4. **`interrupted` snapshots need adjudication** — `list_unresolved_tool_effects` (a `started` effect = `unknown_after_crash` side effect) and possibly `repair_messages` before any resumed history is safe to send. Nothing in the app consumes the ledger yet.

Follow-up design: `POST /api/chats/{id}/resume` → `list_runs(conversation_id=chat_id)[-1]` → `latest_snapshot(run_id, include_interrupted=True)` + `list_unresolved_tool_effects` → `agent.run_stream_events(message_history=snapshot.messages)` through a manually built `VercelAIEventStream`, reconciling the result into the store (snapshot-is-prefix → append; stored failed tail → new head with branch). Needs its own SSE contract decision and client affordance first.

## Acceptance criteria

- `SqliteStepStore` in `data_dir()` (`steps.db` or `app.db` — pick consistent with existing persistence); `StepPersistence` capability added in `build_run_kwargs`.
- Snapshots recorded at settled tool boundaries + `on_run_error` (verify in tests).
- Resume path designed + documented: `continue_run` output lacks UI message ids — feeding it back as `message_history` breaks edit/regenerate (doc §footguns). If feasible, add `POST /api/chats/{id}/resume` continuing the last interrupted run; if the UI-message-id coupling makes it unsafe for this slice, land snapshots + tests only and document the resume design in the story.
- TDD: snapshot recorded on a FunctionModel run with a tool call; snapshot on injected error; no behavior change to the normal chat path (all 183 existing tests still green).

## File references

- `docs/research/conversation-durability.md` — StepPersistence/continue_run/fork_run analysis
- `apps/backend/app/agent/factory.py` — capability assembly
- `apps/backend/app/api/chat.py` — adapter + persistence points
