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

## Resolution

Shipped: a dedicated resume route + stream contract, a Resume affordance in the
error banner, and shared failed-run persistence between the adapter and the
resume path.

### Design decisions

1. **Dedicated endpoint, not a misused existing trigger.** `POST
   /api/chats/{id}/resume` (`app/api/resume.py`) drives the run itself —
   `dispatch_request` can't take `message_history` alongside a
   `conversation_store` (`_check_conversation_store_run` raises), and a
   server-initiated continuation has no client `UIMessage` to submit.
   `GET /api/chats/{id}/resume` is the probe for the affordance:
   `{"resumable": bool, "reason": str | None}` with the same guard
   evaluation the POST enforces (404 no run/snapshot, 409 live run /
   completed run / approval-pending). The frontend triggers the POST
   through `chat.resumeStream()` — the only `ChatTransport` seam that feeds
   a stream into the chat without fabricating a user turn — arming it first
   via a one-shot `requestResumeRun()` flag on `BackendChatTransport` so the
   next `reconnectToStream` POSTs the resume endpoint instead of the usual
   replay GET. The replay path (`GET /api/chat/{id}/stream`) is untouched.

2. **`ui_message_id` needs no synthetic stamping.** The snapshot's
   deep-copied messages carry the original user prompt's `ui_message_id`
   forward; a resumed run only appends assistant/tool messages, which the
   resubmit-cut matcher never matches. `test_resubmit_after_resume_cuts_at_user_prompt`
   verifies the whole failed+resumed tail branches correctly on resubmit.

3. **`started` tool effects are unknown side effects — always surfaced,
   never silently trusted.** `list_unresolved_tool_effects(run_id)` feeds a
   transient `data-resume` chunk emitted first on the stream:
   `{continued_run_id, snapshot_state, unknown_effects: [{tool_call_id,
   tool_name}]}`. The frontend maps it to a dismissable notice naming the
   calls. What the run does with them follows pydantic-ai's own tail rules,
   both covered by the warning: a snapshot ending in a `ModelResponse` with
   pending calls resumes at `CallToolsNode` and **re-executes** them
   (`test_resume_replays_unknown_tool_effect_with_notice` — the file side
   effect fires once, visibly warned); a snapshot ending in an `interrupted`
   `ModelRequest` marker (a mid-execution cancel) is closed by
   `_repair_interrupted_tail` with synthesized `interrupted` returns — the
   model is told the call did not finish rather than re-firing an
   unknowable effect
   (`test_resume_after_cancel_closes_unfinished_tool`).

4. **Approval-pending runs are retry/answer-only, not resumable.** A run
   parked on tool approval leaves `deferred_tool_requests` on the stored
   record — resume returns 409 with a directive to answer the approval via
   `POST /api/chat` (test `test_resume_rejects_pending_approvals`).

### Stream contract

`POST /api/chats/{id}/resume` emits a standard Vercel AI UI Message Stream
(sdk_version=7): the transient `data-resume` notice, `data-run-meta`, the
usual text/tool parts, `finish` — or an `error` chunk (CAS conflict lands
as a stream error, same as the adapter path). Consumed through
`chat.resumeStream()` after arming `BackendChatTransport.requestResumeRun()`.

### Reconciliation (verified by tests)

- **Snapshot-is-prefix** (`test_resume_continues_failed_run_without_rerunning_settled_tool`):
  the resumed history appends — the settled `shell` call ran exactly once
  (file-side-effect counter), and `latest_snapshot`'s messages plus the
  continuation save as the new head without branching.
- **Stored failed tail** (`test_resume_branches_when_stored_tail_diverges`):
  when the persisted failed turn diverges from the snapshot prefix, the
  content-comparison save keeps the old tip in `record.branches` and the
  resumed output becomes the head.
- **`ui_message_id` durability** (`test_resubmit_after_resume_cuts_at_user_prompt`):
  resubmitting the original prompt id cuts at the stored request and keeps
  the failed+resumed tail as a branch — versions attribution intact.

### Resume lookup

`list_runs(conversation_id=chat_id)[-1]` → `list_events` for a
`run_completed` guard → `latest_snapshot(run_id, include_interrupted=True)`
→ `list_unresolved_tool_effects(run_id)` for the `data-resume` warning —
then `agent.run_stream_events(conversation=Conversation(messages=
snapshot.messages, conversation_id, usage, revision))` with the same
per-run `build_run_kwargs` capabilities (so the resumed run gets its own
StepPersistence snapshots and is itself resumable if it fails again).

### Shortcomings / deferred

- **Two persistence paths** now exist in lockstep: the adapter's
  `_saving_conversation` + `save_failed_run_messages`, and resume's
  `_save_resumed_run` + the same failed-run helper. They share the save
  primitive but not the event plumbing — a third caller would warrant
  extracting a small persistence module.
- **Resume triggers on `resumeStream()`**, which the SDK also uses for
  disconnect-reattach. The one-shot flag keeps replay and continuation
  disjoint, but an SDK change to `resumeStream`'s internals is a coupling
  to watch on upgrades.
- **`run_stream_events` is driven with a `Conversation`**, bypassing
  `UserPromptNode` history cleanup — the snapshot is trusted server-side
  state, which is the intent, but it means resume accepts whatever the
  snapshot store contains.
- **A second resume while the first is in flight** is blocked by the
  cancellation-token registry (409), same as `/api/chat`.
- **No affordance for cancelled-but-not-errored runs.** The Resume button
  lives in the error banner, which only renders on `error` status; a
  `/stop`ped run returns to `ready`, so resuming a cancelled run is
  API-reachable (probe + POST work) but has no UI entry point yet.

### Tests

`apps/backend/tests/test_resume.py` — 8 tests: happy path (settled tool
not re-run, `data-resume` emitted), synthetic-replay append, interrupted
snapshot + unknown-effect warning + no re-execution, completed-run 409,
no-run 404, in-flight 409, approval-pending 409, resubmit-cut durability.
Full suite: 236 backend + 205 frontend passing.
