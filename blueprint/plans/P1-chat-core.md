# P1 — Chat core

**Status:** todo · **Order:** 4th · **Depends on:** P1-agent-backend

## Goal

The end-to-end conversation loop: new-turn-only transport, streaming
transcript, approval round-trip, stop/resume, edit/retry/regenerate, and
the `data-*` event surfaces.

## Architecture decisions

- **Endpoint contract** (examples: `references/chat-api.py`,
  `references/resume-api.py`, `references/transport.ts`,
  `references/chats-store.ts`):
  - `POST /api/chat` → `dispatch_request(sdk_version=7,
    conversation_store, conversation_scope, deferred_tool_results,
    cancellation_token, workspace, on_complete, on_cancel)`; the adapter
    emits transient `data-conversation-saved` after persistence.
  - `POST /api/chats/{id}/stop` → `CancellationToken`; client disconnect
    ≠ cancel.
  - `GET /api/chats/{id}/resume` → `{resumable, reason}` status probe;
    `POST` → StepPersistence continuation, not a replay. No snapshot → 404;
    active/completed run or pending approval → 409 (answer approvals instead).
  - `GET /api/chat/{id}/stream` replay for `reconnectToStream` (derived by
    `DefaultChatTransport` from base `/api/chat`); **404 = nothing to
    resume** → `null`, chat stays `ready`. Replay returns the last persisted
    assistant response with its stable message ID, not an in-flight reattach.
- **New-turn-only transport** — `prepareSendMessagesRequest` slices
  `newTurnMessages(messages)`; the server owns the transcript. Trust
  boundary, not optimization — full-transcript sends caused quadratic
  history growth in app #1.
- **Approvals are tool-part state** — asked calls arrive as
  `state:'approval-requested'`; answered via
  `addToolApprovalResponse({id, approved, reason})` →
  `deferred_tool_results` on resubmit;
  `sendAutomaticallyWhen:lastAssistantMessageIsCompleteWithApprovalResponses`
  closes the loop.
- **`Chat` registry:** non-reactive `Map<chatId, Chat<UIMessage>>` in the
  chats store; hydrated once per chat; `useChat({chat})` binds it in every
  consumer. `Chat` from `@ai-sdk/react`; `AbstractChat`/transport/`UIMessage`
  from `ai`.
- **`data-*` parts are stream-only** — validated at the boundary, unknown
  parts ignored, never thrown; latest `data-plan` only. Set:
  `data-plan`, `data-shell`, `data-run-meta`, `data-notice`, `data-resume`,
  `data-conversation-saved`.
- **Durability:** persist partial history on stop, provider failure, and
  disconnect; disconnect is not an explicit user stop. Resume skips settled
  tool work and warns about unknown side effects; it must not claim exactly-once
  execution. Test this separately from retry, which starts a new attempt.
- **Edit/retry/regenerate** (example: `references/messages.ts`):
  edit → `sendMessage` on a user msg truncates + server cuts history before
  the stored prompt, tail kept as a branch; failed/interrupted turns are
  persisted when possible, so retry resubmits the last user prompt by ID,
  branching/replacing its failed tail (append only if it was never stored).
  Regenerate → `regenerate-message` on a *completed* assistant tail → sibling version;
  never wire regenerate to the error-retry path.
- **Composer:** per-chat drafts; send disabled while not `ready`.
- **`file:` link + @-mention cluster:**
  - Backend injects `FILE_LINK_INSTRUCTIONS` so the agent emits
    `[x.ts](file:src/x.ts#L12)` links.
  - Renderer grammar parses `file:path` / `path:LINE` / `path#Ln` /
    `file:///abs`; the markdown pipeline adds `file` to sanitize protocols
    and intercepts clicks → open file at line (never navigates as URL).
  - Tool args + grep/list output render as clickable file links; composer
    has @-mention + attach pickers feeding `file:` refs into the turn.

## Stories (in order)

1. **Chat endpoints** — stream/stop/resume/replay per contract above;
   failed/interrupted turns persist; save notification is transient
   `data-conversation-saved`.
2. **Transport + registry** — `BackendChatTransport` (bearer, base
   `/api/chat`, `newTurnMessages`, replay-404→null, armed one-shot resume
   POST via `resumeStream`); `Map<chatId,Chat>`; hydrate once.
3. **Transcript UI** — text (Streamdown), reasoning, tool cards, approval
   cards; `file:` links everywhere resolve to open-at-line; "Working… Ns"
   indicator only while a live run has no visible parts.
4. **Approval cards + round-trip** — pending approvals group with
   "Approve all"; Deny opens optional reason → `ToolDenied` steering; arg
   previews render `$ command`, clickable paths, mini diffs for
   edit/write; remember-me honored.
5. **Composer + file refs** — per-chat drafts; @-mention + attach pickers;
   `FILE_LINK_INSTRUCTIONS` in every run.
6. **Edit/retry/regenerate + versions** — semantics per above;
   `VersionChip` popover ("edited — N versions"); picking a saved version
   selects its head and hydrates its transcript without a model call or
   history rewrite. Edit/retry/regenerate create sibling versions.
7. **`data-*` consumers** — plan view (latest snapshot); `data-shell` live
   in the shell tool card (64k cap); notices/resume warnings inline;
   reload → graceful absence.
8. **Run meta + usage** — `data-run-meta` starts with `{run_id, model,
   permission_profile}`; a final update adds `usage` and nullable `cost`
   (unknown pricing ≠ zero). Persist the usage summary separately for reload;
   `UsageLimits` breach = clean error.
9. **Wire contract test** — Node test drives real `AbstractChat`/`Chat`
   against the backend (upstream `ui_roundtrip` pattern): full turn +
   approval + resume.


