# Vercel AI SDK — the surface app #2 uses

`ai@7.0.176` + `@ai-sdk/react@4.0.180` (move together; wire is
`sdk_version=7` on the backend adapter). Working usage examples:
`references/transport.ts`, `chats-store.ts`, `messages.ts`, `data-parts.ts`
(see `references/README.md`).

## `Chat` + `useChat` — state ownership

- `Chat` is imported from **`@ai-sdk/react`**; `AbstractChat` (the headless
  base), `ChatTransport`, `DefaultChatTransport`, `UIMessage`, and helpers
  come from `ai`.
- Streaming state lives **inside `Chat` instances**, not Zustand. A
  non-reactive `Map<chatId, Chat<UIMessage>>` registry in the chats store
  owns them; `useChat({ chat })` binds the active one per component —
  multiple components (transcript, DiffPanel, tool cards) bind the same
  instance and all update per chunk.
- Constructed once per chat, hydrated from persisted messages on first open.
- `chat.messages` is the transcript; `chat.status` drives composer/streaming
  UI; `chat.stop()` aborts client-side (also call the backend stop endpoint
  to cancel the run). `chat.resumeStream()` calls transport `reconnectToStream`
  for persisted-response replay or explicitly armed snapshot continuation;
  app #2 does not implement live in-flight reattachment.
- `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`
  (a `Chat` init option; helper imported from `ai`) — auto-resubmits when
  the user has answered every approval, closing the deferred-approval loop
  without backend round-trips to decide. Without it, an answered approval
  would piggyback on the next message instead of sending immediately.

## `DefaultChatTransport` — the request contract

```ts
class BackendChatTransport extends DefaultChatTransport<UIMessage> {
  // constructor options:
  //   api, headers (bearer), prepareSendMessagesRequest({id,messages,body,trigger,messageId})
  // override the ChatTransport *method* (not a constructor option):
  override reconnectToStream(opts) {
    if (resumeRunArmed) return this.resumeRun(opts)      // one-shot POST resume
    return super.reconnectToStream(opts)                  // GET replay; 404 → null
  }
}
```

- `newTurnMessages(messages)` slices everything after the last assistant
  message — **only the new turn goes on the wire**. Server owns history
  (`manage_message_history='server'`); sending the full transcript would
  duplicate/corrupt it on cancel/approval continuations (this caused
  quadratic history growth in app #1 before the fix — keep the slice).
- `trigger` values: `submit-message`, `regenerate-message` (+
  `messageId` for edit/retry → backend resolves to version-branch ops),
  `resume-stream` (internal, fired by `resumeStream()`).
- `reconnectToStream` is a **`ChatTransport` method**, overridden on the
  subclass — the `DefaultChatTransport` *constructor* option for shaping its
  request is `prepareReconnectToStreamRequest`. GET replay; **404 = "nothing
  to resume"** → return `null` so the chat stays `ready`.
- Resume path (post-crash/interrupted run): `requestResumeRun()` arms a
  one-shot flag → next `chat.resumeStream()` issues `POST …/resume` instead
  of the replay GET — server continuation from the StepPersistence snapshot.
  `resume-stream` is the only transport seam that feeds a stream without
  fabricating a user turn.

## `UIMessage` parts used

| Part | Source | Rendered as |
|---|---|---|
| `text` (streaming) | model output | Streamdown markdown |
| `reasoning` | thinking models | collapsible block |
| `tool-*` (`tool-shell`, `tool-write_file`, …) | tool calls/returns | tool cards; **approvals are a state on tool parts** — `state: 'approval-requested' → 'approval-responded'/'output-denied'` + `part.approval.id`, answered via `addToolApprovalResponse({id, approved, reason})` |
| `data-plan` | Planning capability events | latest snapshot only — older ones in a message are dropped |
| `data-shell` | shell phases `started`/`output`/`finished` | live tail inside the shell tool card (stream-only) |
| `data-notice` / `data-resume` | app-emitted notices / resume warnings | inline notice banners |
| `data-conversation-saved` | adapter-emitted on store saves | transient, ignored |
| `data-run-meta` | `{run_id, model, permission_profile}`, final update adds `usage`/nullable `cost` | hidden from transcript; feeds run/usage UI |
| `data-*` generally | stream-only | **optional on reload** — parsers must not require them |

`lib/dataParts.ts` validates every `data-*` part at the boundary; unknown/
malformed parts are ignored, never thrown.

## Files/attachments

`FileUIPart`/`UIPart` support exists on both sides (adapter has file
upload/download controls) — app #1 doesn't send attachments; keep out of
scope for app #2 v1 unless the owner asks.

## Version-coupling notes

- `sdk_version=7` ↔ `ai@7` + `@ai-sdk/react@4`: bump all three together and
  smoke-test one streamed turn (text + tool + approval) before shipping.
- Upstream tests drive the real `AbstractChat` client from Node for
  round-trip tests — copy that pattern for app #2's wire contract test rather
  than mocking request JSON.
- `Chat` is the stable owner; hook APIs (`useChat`) are thin bindings —
  keep registry/hydration logic in the store, not in components.

## What not to use

- Client-managed history (`DefaultChatTransport` default full-transcript
  sends) — always wrap with `prepareSendMessagesRequest` slicing.
- `useChat`'s built-in `experimental_throttle`/persistence hooks for our
  transcript — server persistence owns durability; local writes would fork
  truth.
- `streamText`/server-side `ai` functions — backend is Python; `ai` package
  is client-side only here.

## Getting latest docs (https://ai-sdk.dev)

The site is agent-friendly — pages serve clean markdown directly, no
JS-rendered scraping needed. Discovery endpoints:

- `/sitemap.md` — semantic index of every doc page; fetch this first to
  find the right URL for a topic.
- `/llms.txt` — full docs concatenated inline (~144k lines). Good for bulk
  grepping or vendoring a snapshot; too big for casual lookups.
- `/agents.md` — agent-facing discovery incl. API/MCP surfaces.
- Individual pages under `/docs/**` (e.g.
  `/docs/reference/ai-sdk-ui/use-chat`) fetch as markdown via webfetch.

This spec is pinned to `ai@7`/`@ai-sdk/react@4` — on any version bump,
re-fetch the reference pages for `Chat`, `DefaultChatTransport`, and
`UIMessage` rather than trusting this doc or memory. Context7 also indexes
the AI SDK for targeted snippet lookups.

**Check the installed package first — it ships the docs.** `node_modules/ai`
includes `src/` (full TypeScript source) and `docs/` (~250 `.mdx` files —
an offline mirror of ai-sdk.dev, including the stream-protocol spec at
`ai/docs/04-ai-sdk-ui/50-stream-protocol.mdx` and the full API reference
under `ai/docs/07-reference/`). `@ai-sdk/react` ships `src/`. For
signature questions, the package's `src/` + `ui-message-chunks.ts` zod
schema is more authoritative than the website; reading it beats googling.
