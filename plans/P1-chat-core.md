# P1-chat-core

## Goal

A user can send a message and watch a streamed agent reply render live, including tool calls.

## Scope

- `POST /chat` → `VercelAIAdapter.dispatch_request(request, agent=…, sdk_version=7, conversation_store=…, cancellation_token=…)`; `POST /chat/{id}/stop` → per-run `CancellationToken`
- Frontend: Zustand registry `Map<chatId, Chat>`; `useChat({ chat })` binds active chat; `DefaultChatTransport` with `prepareSendMessagesRequest` sending only the new message + ids (server holds history)
- Composer (own textarea state — `useChat` doesn't manage input), `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`
- Rendering: Streamdown for text parts; card renderers for `tool-*`, `reasoning`, `data-*` parts
- Reconnect to in-flight stream on reload (`resume` / `prepareReconnectToStreamRequest`)

## Architecture decisions

- Pin `ai`/`@ai-sdk/react` to whatever `sdk_version=6` emits — verify e2e before building rendering on top
- Custom `data-*` parts carry agent-specific events (plan progress, shell output tails)
- Server holds message history (ConversationStore); client is a view — no full-history resend

Depends on: P1-app-scaffold (endpoint + auth exist)

## Status

- ⬜ `/chat` streaming endpoint + `/stop`
- ⬜ Chat client (registry, transport, composer)
- ⬜ Message + part rendering
