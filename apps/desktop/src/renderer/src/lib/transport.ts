/**
 * AI SDK Chat construction for the FastAPI sidecar.
 *
 * The backend speaks the Vercel AI UI Message Stream (sdk_version=7) on a
 * single `POST /api/chat`; the chat id travels in the body's top-level `id`
 * field, which `VercelAIAdapter` reads as the conversation id — so a plain
 * `DefaultChatTransport` pointed at the URL works as-is, with only the
 * per-launch bearer token added.
 *
 * Stream resume: the SDK reconnects via `GET {api}/{chat_id}/stream`, which
 * the backend serves as a replay of the last persisted assistant response
 * (a completed UI message stream). 404s on reconnect — unknown chat or
 * nothing persisted yet — are treated as "nothing to resume" instead of
 * surfacing a spurious error on every chat mount.
 *
 * Server-managed history: `prepareSendMessagesRequest` POSTs only the new
 * turn (`newTurnMessages`) rather than the full transcript. Sending
 * everything let a transcript with no assistant reply (run cancelled
 * before the response arrived) resubmit-cut stored history at the first
 * user prompt and merge every earlier prompt into one stored request —
 * quadratic history growth.
 */
import { Chat } from '@ai-sdk/react'
import {
  APICallError,
  DefaultChatTransport,
  EmptyResponseBodyError,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type ChatOnDataCallback,
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { newTurnMessages } from './messages'

/** Concrete `Chat` + message type used app-wide (untyped `UIMessage`). */
export type AppChat = Chat<UIMessage>

/**
 * `DefaultChatTransport` with two resume semantics:
 *
 * - **Replay** (default): `GET {api}/{chatId}/stream` re-attaches to a live
 *   or completed stream. A 404 means "nothing to resume" — `null` per the
 *   `ChatTransport` contract, so the chat stays `ready` rather than
 *   erroring on every mount.
 * - **Continuation** (one-shot): `requestResumeRun()` arms the next
 *   `chat.resumeStream()` call to issue `POST /api/chats/{id}/resume`
 *   instead — the server-initiated continuation that continues a failed or
 *   interrupted run from its StepPersistence snapshot. `resume-stream` is
 *   the only `ChatTransport` seam that feeds a stream into the chat without
 *   fabricating a user turn, so the dedicated endpoint rides it; the flag
 *   makes the intent explicit and auto-disarms after one request.
 */
export class BackendChatTransport extends DefaultChatTransport<UIMessage> {
  /** One-shot: the next `reconnectToStream` is a resume POST, not a replay. */
  private resumeRunArmed = false

  /** Arm the next `resumeStream()` to POST the dedicated resume endpoint. */
  requestResumeRun(): void {
    this.resumeRunArmed = true
  }

  override async reconnectToStream(
    options: Parameters<ChatTransport<UIMessage>['reconnectToStream']>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    if (this.resumeRunArmed) {
      this.resumeRunArmed = false
      return this.resumeRun(options)
    }
    return super.reconnectToStream(options).catch((error: unknown) => {
      if (error instanceof APICallError && error.statusCode === 404) {
        return null
      }
      throw error
    })
  }

  /**
   * `POST /api/chats/{chatId}/resume` — the same fetch+decode shape
   * `HttpChatTransport.reconnectToStream` performs for the replay GET,
   * pointed at the dedicated continuation endpoint.
   */
  private async resumeRun(options: {
    chatId: string
    abortSignal?: AbortSignal
  }): Promise<ReadableStream<UIMessageChunk>> {
    const url = `${window.api.backendUrl}/api/chats/${encodeURIComponent(options.chatId)}/resume`
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${window.api.token}` },
      signal: options.abortSignal,
    })
    if (!response.ok) {
      const responseBody = await response.text()
      throw new APICallError({
        message: responseBody || 'Failed to resume the interrupted run.',
        url,
        requestBodyValues: undefined,
        statusCode: response.status,
        responseBody,
      })
    }
    if (!response.body) {
      throw new EmptyResponseBodyError({
        message: 'The resume response body is empty.',
      })
    }
    return this.processResponseStream(response.body)
  }
}

/**
 * Live transports keyed by chat id — the only way to reach the transport a
 * `Chat` owns, since `AbstractChat.transport` is private. Entries are added
 * by `makeChat` and pruned alongside the chat registry.
 */
const transportRegistry = new Map<string, BackendChatTransport>()

/** The transport backing `chatId`'s Chat instance, when one exists. */
export function getTransport(chatId: string): BackendChatTransport | undefined {
  return transportRegistry.get(chatId)
}

/** Drop `chatId`'s transport — called when the chat itself is deleted. */
export function dropTransport(chatId: string): void {
  transportRegistry.delete(chatId)
}

/**
 * Transport bound to the sidecar: `POST {backendUrl}/api/chat` with the
 * per-launch bearer token on every request (send AND reconnect).
 */
export function makeTransport(): BackendChatTransport {
  return new BackendChatTransport({
    api: `${window.api.backendUrl}/api/chat`,
    headers: { Authorization: `Bearer ${window.api.token}` },
    // Same body shape as the default (`http-chat-transport.ts`), with
    // `messages` narrowed to the new turn. `api`/`headers`/`credentials`
    // are omitted so the resolved transport values still apply.
    prepareSendMessagesRequest: ({ id, messages, body, trigger, messageId }) => ({
      body: {
        ...body,
        id,
        messages: newTurnMessages(messages),
        trigger,
        messageId,
      },
    }),
  })
}

/**
 * Create a `Chat` for one conversation. `messages` seeds the transcript from
 * `GET /api/chats/{id}/messages` (UIMessage dicts straight off the wire);
 * `onData` receives every `data-*` part (including transient ones like the
 * `data-resume` notice, which never lands on a message).
 */
export function makeChat(
  chatId: string,
  messages?: UIMessage[],
  onData?: ChatOnDataCallback<UIMessage>,
): AppChat {
  const transport = makeTransport()
  transportRegistry.set(chatId, transport)
  return new Chat<UIMessage>({
    id: chatId,
    transport,
    messages,
    onData,
    // Resubmit once the approval cards (features/chat/ApprovalCard.tsx) have
    // answered every pending request on the last assistant step.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  })
}
