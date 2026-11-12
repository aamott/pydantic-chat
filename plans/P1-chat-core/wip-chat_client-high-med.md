# Chat client

## Goal

`useChat` client (AI SDK 7) wired to the backend; background chats keep streaming; reload reconnects in-flight runs.

## Verified APIs (ai@7.0.162 / @ai-sdk/react@4.0.166)

- `useChat({ chat })` accepts externally-owned `Chat` instances — the documented pattern is a `Map<chatId, Chat>` in a store; keep the Map in Zustand (non-reactive registry)
- `DefaultChatTransport` stable since AI SDK 5; `prepareSendMessagesRequest` sends only the new turn + ids (server holds history via `conversation_store`)
- `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses` for approval resubmits; `addToolApprovalResponse`
- `resume`/`reconnectToStream` for in-flight stream reattach
- Protocol `x-vercel-ai-ui-message-stream: v1` identical across ai@5/6/7; `sdk_version=7` server-side emits approval chunks

## Acceptance criteria

- Zustand `chats` store: `Map<chatId, Chat>` + `activeChatId`; chats keep streaming while inactive
- Composer owns textarea state; stop → `stop()` + `POST /chat/{id}/stop`
- History hydration on open: `GET /chats/{id}/messages` → `UIMessage[]` into `Chat.messages`
- Reload during run reconnects to stream
- Pinned versions match server `sdk_version=7` — e2e verified before merge

## Files
- `apps/desktop/src/renderer/src/stores/chats.ts`, `lib/transport.ts`, `features/chat/{ChatPanel,Composer}.tsx`

## Depends on
- wip-repo_scaffold-high-easy.md, pending-chat_endpoint-high-med.md

## Implementation notes (2026-11-12)

- `stores/chats.ts` — non-reactive `Map<chatId, Chat>` registry (exported
  `getChat`), `workspaces`, `activeWorkspaceId`, `activeChatId`, plus
  `backendError`/`notice` banners; `loadWorkspaces` picks first
  workspace + `last_chat_id`/first chat (auto-creates a chat when the
  workspace has none); `selectChat` hydrates `GET /chats/{id}/messages`
  via the **`chat.messages =` setter** (same path `setMessages` calls);
  `stopActive` = `chat.stop()` + `POST /api/chats/{id}/stop`;
  `refreshWorkspaces` re-pulls titles after run end (auto-title hook).
  404 on hydrate prunes the deleted chat and falls back.
- `lib/transport.ts` — `BackendChatTransport extends DefaultChatTransport`
  (`api: backendUrl + '/api/chat'`, bearer in `headers`); `makeChat(id,
  messages?)` builds `Chat` from `@ai-sdk/react` (concrete subclass of
  `ai`'s `AbstractChat`; `new Chat({id, transport, messages})`).
- `features/chat/ChatPanel.tsx` — `useChat({chat, resume: true})` on the
  registry instance (externally-managed chats keep streaming while
  inactive / unmounted); 402 → "configure API key in Settings" →
  `window.api.openSettings()`; other errors → `{"detail"}`-unwrapped
  message + retry/dismiss. Composer owns textarea state
  (`Composer.tsx`), Enter=send / Shift+Enter=newline, stop button →
  `stopActive()`. Minimal `WorkspaceChatPicker.tsx` fills the sidebar
  slot until the sidebar story lands; App wires `activeWorkspaceId`
  into `RightPanel` and `window.api.onOpenWorkspace` → `createWorkspace`.
- **Reconnect — PARTIAL, backend gap:** client side is wired
  (`useChat({resume:true})` → `chat.resumeStream()` → transport
  `reconnectToStream` → `GET {api}/{chatId}/stream`), but the backend
  has **no `GET /api/chat/{chat_id}/stream` route** — probe confirmed
  404. `BackendChatTransport` swallows that 404 → `null` ("nothing to
  resume"), so mounts stay clean, but an actual in-flight stream will
  NOT reattach until the endpoint lands (server replays the SSE stream;
  `resumeStreamIsReplay` default `true` already matches replay
  semantics). Reload-reconnect AC stays open — needs a backend story.
- Verified e2e (Electron dev + live sidecar): `GET /api/workspaces`
  from renderer → 200 (CORS + bearer OK); REST contract exercised via
  curl — workspace create, chat create (nested + `last_chat_id`),
  `GET messages` → `[]`, `POST /api/chat` → 402 without provider key,
  `POST /chats/{id}/stop` → 404 when idle. Live streaming untested — no
  model key; `bun run verify` + `electron-vite build` clean.
