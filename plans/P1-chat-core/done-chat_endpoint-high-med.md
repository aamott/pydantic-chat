# Chat streaming endpoint

## Goal

`POST /chat` streams agent runs in Vercel AI UI Message Stream format; runs are cancellable; history is server-managed.

## Verified API (slim 2.68.0)

```python
VercelAIAdapter.dispatch_request(
    request, *, agent, sdk_version=7,           # 7 == 6 wire + approval chunks
    conversation_store=store, conversation_scope=ws_id,   # server-side history
    message_history=None,                        # alt: manual history + manage_message_history='server'
    deferred_tool_results=None,                  # auto-extracted from approval-responded parts
    model=..., capabilities=[...], workspace=..., usage_limits=...,
    cancellation_token=token, on_complete=..., on_cancel=...,
)
```

- Server-side history via `conversation_store` ALSO dodges known-open bug #5154 (stale client `approval-responded` parts never round-trip)
- `CancellationToken` per run; `token.cancel()` → `RunCancelled` (partial history preserved); `on_cancel` fires for first-party cancels (client disconnect does NOT trigger it — hence explicit `/stop`)
- `VercelAIAdapter.dump_messages`/`load_messages` for the `GET /chats/{id}/messages` render endpoint

## Acceptance criteria

- `POST /chat` accepts AI SDK transport payload → SSE with `x-vercel-ai-ui-message-stream: v1`; conversation auto-saved via store
- `POST /chat/{id}/stop` cancels via registry `{chat_id: CancellationToken}` in app state
- `usage_limits=UsageLimits(request_limit=50, …)` backstop per run
- Integration test: prompt → SSE events → `done`; stop mid-run → cancelled + partial history saved

## Files
- `apps/backend/app/api/chat.py`, `app/agent/factory.py`

## Depends on
- pending-loopback_auth-high-easy.md, pending-sqlite_store-high-med.md, pending-capability_wiring-high-med.md

## Implementation notes (2026-11-12)

- **Route/ID contract:** `POST /api/chat` — single URL for `useChat` +
  `DefaultChatTransport` (`api: '/api/chat'`). The chat id arrives in the body's
  top-level `id` field (`SubmitMessage`/`RegenerateMessage`); that's the same
  field `VercelAIAdapter.conversation_id` reads, so no per-chat route and no
  `prepareSendMessagesRequest` needed. Endpoint reads `id` via
  `request.json()` (Starlette caches the body — `dispatch_request` re-reads it).
- **Chat must pre-exist:** `POST /api/workspaces/{id}/chats` first; unknown `id`
  → 404 (the run needs the chat row for workspace + settings anyway). The
  conversation *record* is created by the store on first save.
- **Errors:** `ProviderNotConfigured` → 402, `UnknownProviderError` → 400,
  unknown chat → 404, bad/missing body `id` → 422, non-JSON content type → 415
  (adapter), payload failing `RequestData` validation → 422 (adapter).
- **Stop:** `POST /api/chats/{chat_id}/stop` → `{"status":"cancel_requested"}`,
  404 when no run. Registry `app.state.cancellation_tokens` (dict, lifespan-
  owned). Token released by a `body_iterator` wrapper — covers complete, cancel,
  mid-stream error, and client disconnect (disconnect does NOT fire `on_cancel`).
- **on_cancel DOES need persistence:** `_saving_conversation` only saves on
  `AgentRunResultEvent`, which a cancelled run never emits. `_persist_partial`
  saves `cancelled.all_messages()` (CAS-checked against the stored record;
  equality-compared append of just the new tail).
- **factory.py fix applied:** `Coder()` → `Coder(sub_agents=False)`. The default
  `SubAgents(include_self=True)` delegates to a fresh run of the *bound* agent
  and fails every run when capabilities arrive per-run (`UserError` on stream).
  Revisit if self-delegation is wanted: it requires binding Coder on the Agent.
- **Titles:** run end/cancel auto-titles "New chat" from the first user prompt
  (~40 chars). Partially covers P1-workspaces-persistence/pending-chat_titles.
- **Tests:** `tests/test_chat.py` — TestModel/FunctionModel injected by patching
  `app.agent.factory.resolve_model`; real streamed run incl. stop-mid-run.
  56 tests pass; ruff clean.
