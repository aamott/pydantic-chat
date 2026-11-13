# Declare DeferredToolRequests in the shared agent's output_type

## Goal

A run that ends on an approval-required tool call (the `manual` profile's
`Permissions("read-only")`, `smart` when the judge can't decide, or any
`requires_approval` tool) currently dies with
`UserError: A deferred tool call was present, but DeferredToolRequests is not
among output types`. `_AGENT` declares `output_type=str` only, and
`VercelAIAdapter` auto-adds `DeferredToolRequests` to the run output type only
when the request carries a client `toolset` (`ui/_adapter.py`), which ours
never does — approvals come from run capabilities. Declare
`output_type=[str, DeferredToolRequests]` on `_AGENT` (canonical per
pydantic-ai's TOOLS-ADVANCED skill doc) so a paused run ends cleanly, emits
`tool-approval-request` chunks, and stores `deferred_tool_requests` on the
conversation record for the client approval resubmit to answer.

## Acceptance criteria

- A `manual`-profile run whose model calls an approval-required tool (`shell`)
  ends the SSE stream with a `tool-approval-request` chunk
  (`{type, approvalId, toolCallId}` — `approvalId` is the tool call id on this
  backend) and no `error` chunk.
- The saved `ConversationRecord` carries `deferred_tool_requests` with the
  pending call in `approvals`, so `store.load(...)` hands it to the next run.
- Resubmitting the transcript with the tool part in `approval-responded`
  state (`approval: {id, approved: true}`) resolves the call — the tool
  executes, the run completes, and the record's `deferred_tool_requests`
  clears.
- `get_agent()`/`_AGENT` type annotations reflect
  `str | DeferredToolRequests`; no `output_type=` is passed per run (the
  adapter only permits it when the agent has none).
- `uv run pytest -q` green; `uv run ruff check app tests` clean;
  `bun run verify` unaffected.

## Files

- `apps/backend/app/agent/factory.py` (`_AGENT` declaration + annotations)
- `apps/backend/tests/test_chat.py` (stream + record + round-trip tests)
- `apps/backend/tests/test_agent.py` (output_type pin)

## Depends on

- none

## Implementation notes (2026-07-01)

- `_AGENT` now declares `output_type=[str, DeferredToolRequests]` and is typed
  `Agent[None, str | DeferredToolRequests]`; `get_agent()` matches. No per-run
  `output_type=` was added — `UIAdapter.run_stream_native` only permits a run
  `output_type` override when the agent has none (default `str` counts as
  having one), and the adapter's own auto-add path (`output_type = [output_type
  or self.agent.output_type, DeferredToolRequests]` at `ui/_adapter.py:1531`)
  only fires when the request carries a client `toolset`, which this app never
  sends.
- SSE chunk asserted: `{"type": "tool-approval-request", "approvalId": <id>,
  "toolCallId": <id>}` (camelCase via `CamelBaseModel`), emitted by
  `VercelAIEventStream.handle_run_result` for each `output.approvals` entry at
  `sdk_version >= 6`; `approvalId` == `toolCallId` on this backend. Asserted
  alongside no `error` chunk and a `finish` chunk.
- Round-trip test is feasible and implemented
  (`test_approval_resubmit_executes_deferred_call`): the resubmit body is the
  transcript with the tool part as
  `{type: "tool-shell", toolCallId, state: "approval-responded", input,
  approval: {id, approved: true}}`. The adapter's `deferred_tool_results`
  property picks it up from `approval-responded` parts in assistant messages;
  `_take_new_turn` yields an empty new turn so the run just resolves the
  approval, executes `shell`, and completes. Record's
  `deferred_tool_requests` reads `None` afterwards.
- Tests: `test_deferred_tool_call_streams_approval_request` (stream +
  `record.deferred_tool_requests.approvals`),
  `test_approval_resubmit_executes_deferred_call` (full round-trip),
  `test_agent_output_type_includes_deferred_requests` (output_type pin in
  `test_agent.py` — there is no `test_factory.py`; factory tests live there).
- `uv run pytest -q`: 114 passed. `ruff check app tests`: clean.
