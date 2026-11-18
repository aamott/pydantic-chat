# P1 — Chat core

**Status:** spec'd · **Depends on:** P1-agent-backend

## Goal

The end-to-end conversation loop: new-turn-only transport, streaming
transcript, approval round-trip, stop/resume, edit/retry/regenerate, and the
`data-*` event surfaces (plan view, terminal view).

## Architecture decisions

- **Endpoint contract:**
  - `POST /api/chat` → `dispatch_request(sdk_version=7, conversation_store
    (forces server history), conversation_scope, deferred_tool_results,
    cancellation_token, workspace, on_complete, on_cancel)`.
  - `POST /api/chat/{chat}/stop` → `CancellationToken` on the run registry.
  - `POST /api/chat/{chat}/resume` → `continue_run` + replay stream.
  - `GET` replay endpoint for `reconnectToStream`; **404 = nothing to
    resume** (not an error).
- **New-turn-only transport** — `prepareSendMessagesRequest` slices
  `newTurnMessages(messages)`; the server owns the transcript. This is a
  trust boundary, not an optimization.
- **Approvals are tool-part state:** asked calls surface as tool parts in
  `approval-requested` state inside `DeferredToolRequests`; answers ride back
  via `deferred_tool_results`; `sendAutomaticallyWhen:
  lastAssistantMessageIsCompleteWithApprovalResponses` auto-resubmits.
- **`Chat` registry pattern:** non-reactive `Map<chatId, Chat<UIMessage>>`
  in the chats store; hydrated once per chat from persisted messages;
  `useChat({chat})` binds it in transcript, terminal, and plan consumers.
- **`data-*` parts are stream-only** — validated at the boundary
  (`dataParts.ts`-equivalent), unknown parts ignored, never thrown; plan
  snapshots keep only the latest per message; nothing `data-*` persists.
  Full set: `data-plan`, `data-shell`, `data-run-meta`, `data-notice`
  (user notices), `data-resume` (resume side-effect warnings),
  `data-conversation-saved` (adapter-emitted).
- **`X-Entry-Id` response header** on each streamed response identifies the
  persisted conversation entry — used for save bookkeeping; part of the
  endpoint contract.
- **`file:` link + @-mention cluster** (cross-cutting):
  - Backend injects a `FILE_LINK_INSTRUCTIONS` capability so the agent
    emits `[x.ts](file:src/x.ts#L12)` links.
  - Renderer grammar (`fileRefs.ts`-equivalent) parses `file:path`,
    `file:path:LINE`, `file:path#Ln`, `file:///abs`; the markdown pipeline
    adds `file` to sanitize protocols and intercepts clicks → open in the
    right panel at the line (do NOT let them navigate as URLs).
  - Tool cards render `path` args + grep/list output paths as clickable
    links.
  - Composer pickers: @-mention file search + attachment button feeding
    `file:` refs into the outgoing turn.
- **Edit/retry/regenerate** use `trigger` + `messageId` → backend version
  operations (branch from the version's parent, retry in place, or sibling
  regenerate) — semantics copied 1:1 from app #1's `messages.ts`/chat.py.
- **Composer state** (drafts only — there is no send queue) lives in
  Zustand keyed by chat; stream state never does.
- **Usage/cost display** reads `data-run-meta` + stored usage — no separate
  polling endpoint.

## Stories

| Story | Acceptance criteria |
|---|---|
| Chat endpoints | `/api/chat` streams UI Message Stream; stop cancels mid-run cleanly (partial transcript persisted); resume continues an interrupted run; replay 404 handled |
| Transport + registry | `DefaultChatTransport` + bearer + `newTurnMessages`; `Map<chatId,Chat>` registry; hydration once per chat; replay reconnect works after reload |
| Transcript UI | text (Streamdown), reasoning, tool cards, approval parts; `file:` links in all rendered markdown + tool args open files at line; streaming smooth; working indicator ("Working… Ns") shown only while a live run has produced no visible parts; no virtualization needed at this scale |
| Approval round-trip + cards | ask → `approval-requested` → `addToolApprovalResponse` → auto-resubmit → run completes; consecutive pending approvals group with "Approve all"; Deny expands an optional reason field whose text reaches the model as `ToolDenied` steering; arg previews render `$ command`, clickable paths, mini diff for edit/write; remember-me honored by `Permissions.remembered` |
| Edit/retry/regenerate + versions | all three triggers produce the right version tree entries; `VersionChip` popover ("edited — N previous versions", pick → resubmit-as-edit); switching versions swaps transcript without rewrites |
| `data-*` consumers | plan view shows latest snapshot; `data-shell` streams live into the shell tool card (per-call, 64k cap); `data-notice`/`data-resume` surface as inline notices; reload → graceful absence |
| Composer + file refs | per-chat drafts; send disabled while running; @-mention picker + attach button insert `file:` refs; `FILE_LINK_INSTRUCTIONS` capability present in every run |
| Run meta | per-run usage/cost/model visible; `UsageLimits` breach surfaces a clean error |
| Wire contract test | Node test drives a real `Chat`/`AbstractChat` against the backend (upstream `tests/ui_roundtrip` pattern): full turn + approval + resume |

## Non-goals

File viewer/editor (P2, design pending); settings/profiles/MCP UIs
(P1-settings-registry).
