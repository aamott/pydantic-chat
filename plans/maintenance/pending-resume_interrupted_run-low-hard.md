# Resume an interrupted run mid-turn (continue_run)

## Goal

`StepPersistence` snapshots are landing (done story). Now let a failed/interrupted run *continue* from its last snapshot instead of re-running completed side-effecting tools. Blockers + follow-up design are documented in `done-step_persistence_snapshots-med-hard.md` — read it first; this story exists to resolve them, not rediscover them.

## Acceptance criteria

- `POST /api/chats/{id}/resume`: `list_runs(conversation_id=chat_id)[-1]` → `latest_snapshot(run_id, include_interrupted=True)` → `list_unresolved_tool_effects` adjudication → continue via `agent.run_stream_events` (or the harness `continue_run` — verify which composes with our adapter path) with `message_history=snapshot.messages`.
- `interrupted` snapshots: a `started` tool effect is an *unknown side effect* — surface it (warn the user, or re-run with visible notice); do NOT silently trust it.
- Reconciliation: snapshot-is-prefix → append result; stored failed tail → new head + branch (preserving the `record.branches` contract the version switcher consumes).
- `ui_message_id` durability preserved: resumed output must not break subsequent resubmit-cut matching or `GET /api/chats/{id}/versions` attribution. Synthetic stamping is acceptable if documented.
- Client affordance: a "Resume" affordance on a failed/interrupted run (alongside or replacing Retry) — needs an SSE contract decision since `submit-message`/`regenerate-message` both require a client `UIMessage` and `reconnectToStream` expects in-flight replay, not a new run.
- TDD: FunctionModel fails after a settled shell call → resume → model continues from the snapshot, the settled tool does NOT re-execute, history stays coherent.

## Known shortcomings / risks (state these in the resolution)

- **Bypasses `dispatch_request`'s conversation layer.** `manage_message_history='server'` builds history from the store; resume needs `message_history=snapshot.messages` directly, which the adapter *prepends* to stored history (duplication). Implementation must bypass/reimplement `_saving_conversation`, `_persist_failed_run`, and `ui_message_id` stamping — a second persistence path to keep in lockstep.
- **SSE contract is new.** No existing wire message fits server-initiated continuation; whatever is chosen (custom `resume` trigger, synthetic client message, dedicated endpoint + `reconnectToStream`) is a contract the frontend must learn — design it deliberately, don't shoehorn into submit-message.
- **Unknown-effect ledger is untested territory.** `list_unresolved_tool_effects`/`repair_messages` are harness APIs nothing in the app consumes; semantics must be verified against installed source, not assumed.
- **Approvals interact.** A run interrupted *while awaiting approval* has pending deferred calls in the store, not a snapshot — resume semantics for that case need a decision (probably: not resumable, retry instead).

## File references

- `plans/maintenance/done-step_persistence_snapshots-med-hard.md` — blocker analysis + design sketch
- `docs/research/conversation-durability.md` — `continue_run`/`fork_run`/`repair` analysis
- `apps/backend/app/agent/factory.py` — `_step_persistence_capability`
- `apps/backend/app/api/chat.py` — `AppVercelAIAdapter`, `_saving_conversation`, `_persist_failed_run`
- `apps/backend/tests/test_step_persistence.py` — snapshot fixtures to extend
