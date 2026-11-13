# Conversation durability: edit, retry, regenerate

Research for the "provider error mid-run → no way to edit the message and retry" bug.
Verified against the installed sources:

- `pydantic-ai-slim 2.68.0` at `apps/backend/.venv/lib/python3.12/site-packages/pydantic_ai/` (below: `$PAI/…`)
- `pydantic-ai-harness 0.68.0` at `apps/backend/.venv/lib/python3.12/site-packages/pydantic_ai_harness/` (below: `$PAH/…`)
- `ai 7.0.162` at `apps/desktop/node_modules/ai/` and `@ai-sdk/react 4.0.166` at `apps/desktop/node_modules/@ai-sdk/react/`

**TL;DR.** The Vercel AI adapter already implements edit + retry + regenerate against a
`ConversationStore`: a resubmitted user message is matched to a stored request by the
client's `UIMessage.id` (kept in message metadata), and the stored history is *cut* just
before it — the replaced tail is kept as a `record.branches` tip. **What is missing in this
app**: (1) a failed run saves *nothing* — not even the user's prompt — so `regenerate()` on
a failed turn is rejected server-side (`UserError`: "The message to regenerate … is not in
the stored conversation") — this is exactly the bug the user hit, since `ChatPanel.tsx`
wires the error-banner Retry button to `regenerate()`; (2) the retry affordance should be
`sendMessage({text, messageId})` (the SDK's native edit/resubmit), which works whether or
not the turn was stored; (3) optionally, persist failed turns via
`capture_run_messages()` in a small `VercelAIAdapter` subclass.

---

## 1. Failed-run durability: what the store contains after a mid-run error

**Nothing from the failed turn is persisted — including the user prompt.**

- `UIAdapter._saving_conversation` wraps the event stream and calls `_save_conversation`
  **only when an `AgentRunResultEvent` passes through** — `$PAI/ui/_adapter.py:1246-1251`.
- `transform_stream` catches any `Exception` from the run (including provider errors),
  closes open parts and pending tool calls with synthetic `ToolReturnPart`s
  (`outcome='failed'`), and emits an error chunk via `on_error` —
  `$PAI/ui/_event_stream.py:343-419`. For Vercel AI this is
  `ErrorChunk(error_text=str(error))` — `$PAI/ui/vercel_ai/_event_stream.py:205-218`.
  The error does **not** propagate out of the SSE body iterator — the stream just ends
  after the error chunk.
- `on_complete` fires only on `AgentRunResultEvent` (`_event_stream.py:309-318`);
  `on_cancel` fires only for first-party `RunCancelled` (`_event_stream.py:390-416`).
  A provider exception fires **neither**.
- Adapter docstring, explicit: *"A run that fails or is stopped isn't saved."* —
  `$PAI/ui/_adapter.py:886`. ("stopped" is inaccurate for this app — our `on_cancel`
  handler `_persist_partial` *does* save cancels; fails are the gap.)

So after a mid-run error, `conversation_records.head_id` still points at the last
*completed* turn. The user message exists only in the client's `Chat.state.messages`.

**Cancel is different.** `CancellationToken` → `RunCancelled` → `transform_stream` emits
synthetic `outcome='interrupted'` tool returns, calls `on_cancel(RunCancelled)`
(`_event_stream.py:380-416`), and our `chat.py:443-481` `_persist_partial` saves
`cancelled_run.all_messages()` — the stored prefix *plus* the partial turn, including the
user prompt and completed tool work (`RunCancelled.all_messages()` —
`$PAI/exceptions.py:443-452`). `RunTimedOut` (`timeout=`) is a `RunCancelled` subclass and
takes the same path (`_adapter.py:1629-1630`, `_event_stream.py` docstring 279-280).

**Client disconnect is a third case.** It produces `CancelledError`/`GeneratorExit`
(`BaseException`), which *bypasses* `except Exception` entirely — no error chunk, no
`on_cancel`, nothing saved; only our `_release_token` `finally` runs
(`app/api/chat.py:514-530`, and the route docstring at `chat.py:23-24`).

**Pre-run save?** No. The adapter appends the client's new turn to the *in-memory*
`Conversation` (`_load_conversation`, `_adapter.py:1295`) and only writes on run result.
The user prompt is committed at the same moment the whole turn is — at run end.

## 2. Retrying the same message — dedup or duplicate?

**Deduplicated by `UIMessage.id`, via history cutting — not appended.** The mechanism:

- `load_messages` stamps each client `UIMessage.id` onto the built `ModelRequest`/
  `ModelResponse` under `metadata['__pydantic_ai__']['ui_message_id']`
  (`set_ui_message_id` — `$PAI/ui/_utils.py:26-37`; called at
  `$PAI/ui/vercel_ai/_adapter.py:863`). It survives `sanitize_messages`
  (`_adapter.py:1154-1179`), sqlite serialization (it's a normal `metadata` field in
  `data_json`), and `dump_messages` restores it (`_adapter.py:186-188`). So every stored
  request produced through this adapter knows its client-side id.
- Under a `conversation_store`, `_take_new_turn` (`$PAI/ui/_adapter.py:564-652`) takes the
  client's messages **after its last `ModelResponse`** as `new_turn`. If `new_turn[0]`'s
  `ui_message_id` matches a stored `ModelRequest` containing a `UserPromptPart`
  (`_adapter.py:604-615`), `cut_at` is set: the stored history is truncated *just before*
  that request, and the resubmitted message + whatever the run produces replace it.
- If the id matches nothing (the message was never stored — e.g. the run failed), the new
  turn is simply appended (`_adapter.py:616-621` skips the cut; `cut_at is None`).

**Correct client flow for "retry the failed turn":**
`sendMessage({text: <prompt text>, messageId: <the user UIMessage.id>})`. The SDK
truncates `state.messages` at that message, replaces its content, and POSTs
`trigger: 'submit-message'` (`node_modules/ai/src/ui/chat.ts:459-503`, body shape at
`http-chat-transport.ts:191-198`). Server-side: stored → cut+replace; not stored →
append. **One code path covers retry-after-error, retry-after-cancel, and edit.**
`messageId` in the submit body is ignored server-side (`SubmitMessage` has
`extra='allow'` — `request_types.py:449-455`); it only matters client-side for where the
streamed response lands (`chat.ts:991-1000`).

**Do not use `regenerate()` for retrying a failed turn** — see §3.

## 3. `trigger: 'regenerate-message'` semantics

- `Chat.regenerate({messageId})` truncates client state to *before* the target assistant
  message (or through the target if it's a user message) and POSTs
  `trigger: 'regenerate-message'` with the sliced `messages` — last element is the user
  message to re-answer (`node_modules/ai/src/ui/chat.ts:510-543`).
- Server-side, `_regenerates()` is just `isinstance(run_input, RegenerateMessage)`
  (`$PAI/ui/vercel_ai/_adapter.py:390-391`). **The body's `messageId` is never read**
  (`RegenerateMessage.message_id` — `request_types.py:457-463`). Targeting is entirely
  the `_take_new_turn` cut described in §2: the last sent user message's id must match a
  stored user-prompt request, then history is cut there and re-run.
- **Critical difference from submit**: when no stored request matches, `regenerate=True`
  raises `UserError("The message to regenerate … is not in the stored conversation…")`
  (`_adapter.py:621-627`), delivered as a stream error chunk. A submit with the same
  unmatched id just appends.
- Consequence: **`regenerate()` can only ever succeed on a turn the store already holds.**
  After a mid-run provider error (nothing saved), `regenerate()` always fails — the app's
  current `onRetry={() => void regenerate()}` (`ChatPanel.tsx:140`) is guaranteed to
  produce a second error. It works after a *cancel* only because `_persist_partial`
  happens to have stored the prompt.
- On save, a resubmit goes through `_save_resubmitted_turn`
  (`_adapter.py:1367-1383`): it saves `turn.history + run output` (not the raw result
  messages, in case a capability rewrote history), and `ConversationStore.save`'s
  content-comparison path (`_unsaved_after_history`, `conversation_store.py:326-348`)
  records the replaced tail in `record.branches`. *"A regenerate or edit keeps the turn it
  replaces as a branch of the stored conversation"* — `_adapter.py:879`.

## 4. Editing a past user message

**Natively supported — the same resubmit cut as §2.** There is no separate edit protocol;
"edit" = resubmit a user message with the same `UIMessage.id` and new content.

- `sendMessage({text: newText, messageId: oldUserMessage.id})` truncates client state at
  that message and replaces its text (`chat.ts:480-489`). Since the edited message is now
  last, it becomes `new_turn[0]`, its id matches the stored request, `cut_at` truncates
  the stored history there, and the run re-answers with the edited text. The old tail
  lands in `record.branches` on the post-run save.
- Constraint: only `new_turn[0]` is matched, and only against a stored `ModelRequest`
  **with a `UserPromptPart`** (`_adapter.py:604-615`). You cannot cut at an assistant
  message or a tool-result request. Edits are always "branch from this user prompt".
- `store.branch()` / `store.fork()` are **not needed** for edit-in-place — the save's
  rewrite detection branches automatically. `branch()` (`conversation_store.py:350-407`)
  is the manual "move head to an earlier entry / a left branch tip" primitive — relevant
  only for a "view/restore previous version" UI. `fork()` (`:442-495`) creates a **new
  conversation_id** sharing entries — relevant only for "continue in a new chat".
- Editing a message that was never stored (client/server divergence) → `cut_at is None`
  → the edited message is appended at the end of history (silent, no error).

## 5. Frontend mechanics (ai@7 / @ai-sdk/react@4)

`useChat` returns `{messages, setMessages, sendMessage, regenerate, clearError, stop,
error, resumeStream, status, addToolOutput, addToolApprovalResponse}`
(`@ai-sdk/react/src/use-chat.ts:349-368`). App binds via externally-owned `Chat`
(`useChat({chat, resume: true})` — `ChatPanel.tsx:96-104`).

- **Edit / resubmit**: `sendMessage({text, messageId})` — the target must be a `user`
  message (`InvalidArgumentError` otherwise, `chat.ts:472-478`). Truncates + replaces +
  POSTs `submit-message`.
- **Regenerate**: `regenerate({messageId})`, defaults to last message. Slices client
  state and POSTs `regenerate-message` (`chat.ts:529-542`).
- **Manual edit**: `setMessages` / `chat.messages =` exists (`use-chat.ts:328-338`) —
  needed only for local transcript surgery, not for server edits.
- **Error state**: `makeRequest` sets `status:'submitted', error: undefined` at send time
  (`chat.ts:989`), so `sendMessage` self-clears the error; `clearError()` also exists.
  The app currently disables the `Composer` while `status === 'error'`
  (`ChatPanel.tsx:149`) — this plus the broken `regenerate()` retry is the reported dead
  end.
- **Transport**: `DefaultChatTransport` POSTs `{id, messages, trigger, messageId}` to
  `api` (`http-chat-transport.ts:191-198`); `reconnectToStream` GETs
  `{api}/{chatId}/stream` (`:266-270`). Our `BackendChatTransport` already maps 404 →
  null (`lib/transport.ts`). `prepareSendMessagesRequest` is the escape hatch if custom
  body fields are ever needed (`:119,171-181`).
- **Hydration**: `GET /api/chats/{id}/messages` dumps the head chain with stable ids
  (`chats.py:116-140`); `hydrateChat` seeds `chat.messages` when status is `ready` or
  `error` (`stores/chats.ts:119-138`) — so a non-persisted failed turn **vanishes on
  reselect**.
- **`data-conversation-saved`**: after each save the stream emits a transient
  `data-conversation-saved` part `{conversation_id, entry_ids}`
  (`$PAI/ui/vercel_ai/_adapter.py:393-401`), readable via `useChat({onData})`. Not
  consumed today; useful for branch/version UI later.

## 6. Harness alternatives for crash resume

- **`capture_run_messages()`** (`$PAI/_agent_graph.py:4845-4888`) is the simplest recovery
  primitive: a context manager whose list *becomes* the run's live `message_history`
  (`UserPromptNode.run` rebinds, `:1109-1124`), capturing partial `state='interrupted'`
  responses/requests on any exception (`:4873-4878`) and on `UsageLimitExceeded`
  (`exceptions.py:550-556`). It works for `run_stream_events` — the run executes lazily
  inside the stream iteration, so wrapping the *native event* stream inside our own
  `with capture_run_messages()` sees everything.
- **`RunCancelled.from_cancellation(exc)`** (`exceptions.py:401-441`) recovers run state
  from `CancelledError`/timeouts; the doc points at `capture_run_messages` as the
  general-exception fallback.
- **`StepPersistence` + `SqliteStepStore`** (`$PAH/step_persistence/_capability.py:58-95`,
  `_store.py`): append-only step-event log + `ContinuableSnapshot`s at every settled
  tool boundary + a tool-effect ledger (`started`/`unknown_after_crash`). Its
  `on_run_error` (`_capability.py:541-574`) saves the at-failure history classified
  `complete`/`interrupted`; `continue_run`/`fork_run` (`_helpers.py:66-98`) hand the
  snapshot back as `message_history` — i.e. **resume mid-turn instead of re-running the
  whole turn**. It is orthogonal to `ConversationStore` (keyed by `run_id`, not
  integrated with the UI adapter's save path), so it solves a *finer-grained* problem:
  avoiding re-execution of completed side-effecting tool calls after a crash. That's
  real value for a coding agent but a bigger integration; the cheap fix below covers the
  reported UX gap.
- `pydantic_ai.durable_exec` (Temporal/DBOS/Prefect) is for engine-managed durable
  execution — overkill here.

## 7. Footguns

- **`regenerate()` on an unstored message → `UserError` → error chunk**
  (`_adapter.py:621-627`). Never wire retry to `regenerate()`.
- **Pending approvals/regenerate interplay**: a resubmit-cut rebuilds the
  `Conversation` *without* `deferred_tool_requests` (`_adapter.py:1287-1294`), so a
  successful edit/regenerate save clears pending approvals server-side while the client
  may still render stale approval cards. Conversely, a client answering an approval for a
  call no longer pending post-cut gets the whole request rejected with `UserError`
  (`_adapter.py:663-693`, `_reject_answers_for_calls_not_pending`).
- **Retry after error re-executes the whole turn** (cut removes the user prompt *and* its
  tool work) — completed side-effecting tools run again. The replaced turn is recoverable
  in `record.branches` but not shown to the model. (StepPersistence is the only remedy.)
- **Usage accumulation**: `record.usage` is monotonic — branched-off turns' usage is
  never subtracted; `fork()` copies usage only on a whole-history fork, else resets to
  zero (`conversation_store.py:480`).
- **Plan state**: `SqlitePlanStore(session=chat_id)` (`factory.py:304-311`) lives outside
  the conversation — plans persist across edits/regenerates and may describe the
  abandoned branch.
- **Concurrent requests**: a second writer's save CAS-fails → `_CONVERSATION_CHANGED`
  `UserError` → error chunk telling the client to reload (`_adapter.py:696-705,1358-1359`).
  The frontend doesn't currently re-hydrate on that error.
- **Assistant message ids are re-minted per dump** when no `provider_response_id`/
  `run_id` is present (`_adapter.py:191-200`) — user-side ids are stable (they
  round-trip), assistant ids are deterministic per content+position but not guaranteed
  equal to the streamed `start.messageId`. Don't key anything to assistant ids across
  reloads.
- **A stored history not produced by this adapter carries no `ui_message_id`s** → every
  resubmit appends (`_adapter.py:857-858`). All our history is adapter-produced, so fine.
- `capture_run_messages` captures the first run in the context only; nested runs need
  their own context.

---

## RECOMMENDED DESIGN

### A. Frontend — the actual bug fix (no backend change required)

1. **Error retry = resubmit, not regenerate.** In `ChatPanel.tsx`, change the error
   banner retry to find the last user message and call
   `sendMessage({text: <its text>, messageId: <its id>})`. Works whether the failed turn
   was persisted or not (append vs cut both correct). Optionally let the user edit the
   text first: keep `Composer` enabled in `error` status (drop
   `disabled={status === 'error'}` at `ChatPanel.tsx:149`), or add an inline "edit &
   retry" affordance on the failed user message.
2. **Edit affordance on any user message** → `sendMessage({text: edited, messageId: msg.id})`.
   Same mechanism; server auto-branches.
3. **"Regenerate response" on completed assistant messages** → `regenerate({messageId:
   assistantMsg.id})`. Only expose it when the preceding turn is known-complete (i.e. not
   on a failed/interrupted tail), or fall back to the §A.1 resubmit.
4. Optionally consume `onData` `data-conversation-saved` → keep `entry_ids` per turn for a
   future version-switcher.

### B. Backend — persist failed turns (recommended; ~60 lines)

Subclass `VercelAIAdapter` so a run exception (and client disconnect) saves the
at-failure history, mirroring `_persist_partial`:

```python
class AppVercelAIAdapter(VercelAIAdapter):
    def transform_stream(self, stream, on_complete=None, on_cancel=None):
        return super().transform_stream(
            _persist_unsaved_run(stream, self), on_complete=on_complete,
            on_cancel=on_cancel,
        )
```

`_persist_unsaved_run` wraps the **native** event stream: enter
`capture_run_messages()`, track whether an `AgentRunResultEvent` passed (then the adapter
already saved — skip), and on `BaseException`/early-close with a non-empty capture and
`saved is False`, do `store.load(chat_id, scope=workspace_id)` → `loaded.messages =
captured` → `store.save(loaded)`, swallowing `ConversationConflict` (same pattern as
`app/api/chat.py:451-481`). Run exceptions propagate through this seam *before*
`transform_stream` swallows them into an error chunk, so a plain
`except BaseException: persist; raise` covers provider errors, `UsageLimitExceeded`, and
disconnect (`GeneratorExit`). Skip `RunCancelled` — `on_cancel`/`_persist_partial` owns it.

Then in `stream_chat` call `AppVercelAIAdapter.dispatch_request(...)` instead.

Why bother: after error-persistence, the failed user prompt (and completed tool work,
`state='interrupted'`) is in the store → transcript survives reload/hydration, `resume`
replay can render it, and even `regenerate()` starts working. The store's
`_repair_interrupted_tail` (`$PAI/_agent_graph.py:1129`) closes dangling tool calls on
the next run, so a non-resubmit continuation is also well-formed.

### C. Optional follow-ups (not needed for the fix)

- **Branch/version UI**: `record.branches` holds replaced tips; `store.branch(chat_id,
  from_entry=..., expected_revision=...)` moves head back (`conversation_store.py:350-407`).
  Needs REST endpoints (`GET …/versions`, `POST …/checkout`) and entry ids surfaced to the
  client.
- **Fork to new chat**: `store.fork(chat_id, from_entry=…, new_conversation_id=new_id)`
  + `store.create_chat(workspace_id)` row with matching id — "continue in new chat".
- **StepPersistence** (`SqliteStepStore`): adopt later if we want mid-turn resume that
  avoids re-running completed side-effecting tools after crashes; wire
  `continue_run(run_id=..., include_interrupted=True)` output as `message_history`.

### Edge cases to test

1. Provider error on turn 1 of a new chat → `sendMessage(messageId)` retry → exactly one
   stored user request; no duplicate.
2. Provider error mid-tool-loop → error-persist saves interrupted tail → reload hydrates
   the failed turn → resubmit cuts at the user request; old failed tail appears in
   `record.branches`.
3. `regenerate()` on the failed turn *before* error-persistence → error chunk
   (`UserError` text); after persistence → succeeds (documents why retry uses
   `sendMessage`).
4. Edit a mid-history user message → `sendMessage({text, messageId})` → stored history
   branches; `GET /messages` shows the new line; `record.branches` grows.
5. `regenerate({messageId})` on a completed assistant message → replaces that response,
   prior turn branched.
6. Edit/resubmit while a tool approval is pending → pending `deferred_tool_requests`
   cleared on save; a stale approval answer → `UserError` error chunk.
7. Cancel (`/stop`) → `_persist_partial` saves partial turn → resubmit replaces it
   cleanly.
8. `UsageLimitExceeded` (`REQUEST_LIMIT=50`) → same error-persist + resubmit path.
9. Client disconnect mid-run → token released; with fix, partial turn persisted.
10. Two rapid submits → second gets `_CONVERSATION_CHANGED` error chunk → client
    re-hydrates (`hydrateChat`) instead of retry-looping.
11. Resubmit a message whose id was never stored (stale client tab) → appended, not cut —
    verify transcript stays sane.
12. `GET /chat/{id}/stream` after a persisted failed turn → replay renders the
    interrupted response or 404s gracefully.

## Evidence index

| Claim | Where |
|---|---|
| Save only on `AgentRunResultEvent` | `$PAI/ui/_adapter.py:1246-1251` |
| "A run that fails or is stopped isn't saved" | `$PAI/ui/_adapter.py:886` |
| Error path → synthetic tool returns + error chunk | `$PAI/ui/_event_stream.py:343-419` |
| `on_cancel` only for `RunCancelled` | `$PAI/ui/_event_stream.py:390-416` |
| Resubmit cut by `ui_message_id` | `$PAI/ui/_adapter.py:604-621` |
| Regenerate of unstored message → `UserError` | `$PAI/ui/_adapter.py:621-627` |
| Edit = resubmit (same cut path) | `$PAI/ui/_adapter.py:851-858`, `:1283-1296` |
| Replaced turn kept as branch | `$PAI/ui/_adapter.py:879`, `conversation_store.py:326-348` |
| `ui_message_id` in message metadata | `$PAI/ui/_utils.py:14-60`, `vercel_ai/_adapter.py:863` |
| `sendMessage({text,messageId})` edit flow | `ai/src/ui/chat.ts:459-503` |
| `regenerate` slices + POSTs trigger | `ai/src/ui/chat.ts:510-543` |
| Wire body `{id,messages,trigger,messageId}` | `ai/src/ui/http-chat-transport.ts:191-198` |
| `store.branch`/`fork` semantics | `conversation_store.py:350-407`, `:442-495` |
| `capture_run_messages` | `$PAI/_agent_graph.py:4845-4888`, `:1109-1124` |
| `RunCancelled.all_messages` | `$PAI/exceptions.py:349-452` |
| StepPersistence error snapshots | `$PAH/step_persistence/_capability.py:58-95,541-574` |
| App: cancel-persist, no error-persist | `app/api/chat.py:436-481`, `:130-152` |
| App: retry wired to `regenerate()` | `apps/desktop/.../ChatPanel.tsx:140` |
