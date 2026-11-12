/**
 * AI SDK Chat construction for the FastAPI sidecar.
 *
 * The backend speaks the Vercel AI UI Message Stream (sdk_version=7) on a
 * single `POST /api/chat`; the chat id travels in the body's top-level `id`
 * field, which `VercelAIAdapter` reads as the conversation id — so a plain
 * `DefaultChatTransport` pointed at the URL works as-is, with only the
 * per-launch bearer token added.
 *
 * Stream resume: the SDK reconnects via `GET {api}/{chat_id}/stream`. The
 * backend does not serve that route yet (tracked as a gap), so 404s on
 * reconnect are treated as "nothing to resume" instead of surfacing a
 * spurious error on every chat mount.
 */
import { Chat } from '@ai-sdk/react'
import {
  APICallError,
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type ChatTransport,
  type UIMessage,
} from 'ai'

/** Concrete `Chat` + message type used app-wide (untyped `UIMessage`). */
export type AppChat = Chat<UIMessage>
export type AppUIMessage = UIMessage

/**
 * `DefaultChatTransport` that treats a 404 on reconnect as "no live stream".
 *
 * `HttpChatTransport.reconnectToStream` issues `GET {api}/{chatId}/stream`;
 * until the backend lands that route every mount would otherwise flip the
 * chat into `error` status. `null` means "nothing to resume" per the
 * `ChatTransport` contract, so the chat stays `ready`.
 */
class BackendChatTransport extends DefaultChatTransport<UIMessage> {
  override reconnectToStream(
    options: Parameters<ChatTransport<UIMessage>['reconnectToStream']>[0],
  ): ReturnType<ChatTransport<UIMessage>['reconnectToStream']> {
    return super.reconnectToStream(options).catch((error: unknown) => {
      if (error instanceof APICallError && error.statusCode === 404) {
        return null
      }
      throw error
    })
  }
}

/**
 * Transport bound to the sidecar: `POST {backendUrl}/api/chat` with the
 * per-launch bearer token on every request (send AND reconnect).
 */
export function makeTransport(): BackendChatTransport {
  return new BackendChatTransport({
    api: `${window.api.backendUrl}/api/chat`,
    headers: { Authorization: `Bearer ${window.api.token}` },
  })
}

/**
 * Create a `Chat` for one conversation. `messages` seeds the transcript from
 * `GET /api/chats/{id}/messages` (UIMessage dicts straight off the wire).
 */
export function makeChat(chatId: string, messages?: UIMessage[]): AppChat {
  return new Chat<UIMessage>({
    id: chatId,
    transport: makeTransport(),
    messages,
    // Inert until the approval UI lands (it only fires once the user
    // submits `addToolApprovalResponse`s), then resubmits answered runs.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  })
}
