/**
 * Chat pane: error banners, transcript (`MessageList`), and `Composer`.
 *
 * `useChat` binds to the externally-owned `Chat` instance pulled from the
 * store's registry, so the run keeps streaming when the user switches chats
 * or the panel unmounts. `resume: true` re-attaches to an in-flight stream
 * after a reload — the transport's `reconnectToStream` currently gets a 404
 * (backend `GET /api/chat/{id}/stream` isn't implemented yet) and the
 * transport degrades that to "nothing to resume" rather than an error.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useChat } from '@ai-sdk/react'
import { APICallError } from 'ai'
import { AlertCircle, FolderOpen, Settings, X } from 'lucide-react'
import { findChatSummary, getChat, useChatsStore } from '../../stores/chats'
import type { AppChat } from '../../lib/transport'
import { asRunMeta, latestDataPart } from '../../lib/dataParts'
import { lastUserMessage, messageText } from '../../lib/messages'
import { MessageList } from './MessageList'
import { Composer } from './Composer'
import { RunMetaBadge } from './RunMetaBadge'

export function ChatPanel(): React.JSX.Element {
  const activeChatId = useChatsStore((s) => s.activeChatId)
  const loaded = useChatsStore((s) => s.loaded)
  const backendError = useChatsStore((s) => s.backendError)
  const notice = useChatsStore((s) => s.notice)
  const dismissNotice = useChatsStore((s) => s.dismissNotice)
  const loadWorkspaces = useChatsStore((s) => s.loadWorkspaces)
  const createWorkspace = useChatsStore((s) => s.createWorkspace)

  const chat = activeChatId ? getChat(activeChatId) : undefined

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {backendError && (
        <Banner tone="error">
          <span className="truncate">{backendError}</span>
          <button
            type="button"
            onClick={() => void loadWorkspaces()}
            className="shrink-0 rounded bg-red-600 px-2 py-0.5 text-white hover:bg-red-700"
          >
            Retry
          </button>
        </Banner>
      )}
      {notice && (
        <Banner tone="info">
          <span className="truncate">{notice}</span>
          <button
            type="button"
            onClick={dismissNotice}
            aria-label="Dismiss"
            className="shrink-0 text-faint hover-text-default"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Banner>
      )}

      {chat ? (
        // Remount per chat: fresh composer text and a clean useChat binding.
        <ChatView key={chat.id} chat={chat} />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          {loaded ? (
            <>
              <p className="text-sm text-muted">
                Open a workspace to start chatting.
              </p>
              <button
                type="button"
                onClick={() => void createWorkspace()}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
              >
                <FolderOpen className="h-4 w-4" />
                Open workspace…
              </button>
            </>
          ) : (
            <p className="text-sm text-faint">Loading…</p>
          )}
        </div>
      )}
    </div>
  )
}

function ChatView({ chat }: Readonly<{ chat: AppChat }>): React.JSX.Element {
  const stopActive = useChatsStore((s) => s.stopActive)
  const refreshWorkspaces = useChatsStore((s) => s.refreshWorkspaces)
  /* The chat's own workspace — attach picker lists its files. */
  const workspaceId = useChatsStore(
    (s) => findChatSummary(s.workspaces, chat.id)?.workspace_id ?? null,
  )
  const {
    messages,
    status,
    error,
    sendMessage,
    regenerate,
    clearError,
    addToolApprovalResponse,
  } = useChat({ chat, resume: true })

  /* Run end (streaming → ready) is when the server auto-title lands —
   * refresh the workspace list so renamed chats show up. */
  const prevStatus = useRef(status)
  useEffect(() => {
    const was = prevStatus.current
    prevStatus.current = status
    if ((was === 'streaming' || was === 'submitted') && status === 'ready') {
      void refreshWorkspaces()
    }
  }, [status, refreshWorkspaces])

  /* Effective profile + model for the run, announced as the stream's first
   * `data-run-meta` chunk (stream-only → absent on reloaded transcripts). */
  const runMeta = useMemo(
    () => latestDataPart(messages, 'run-meta', asRunMeta),
    [messages],
  )

  /**
   * One path covers retry-after-error, retry-after-cancel, and edit:
   * `sendMessage({text, messageId})` truncates client state at the named
   * user message, replaces its text, and POSTs `submit-message`. The server
   * cuts stored history just before the matching user prompt (keeping the
   * replaced tail as a branch) — or appends when the id was never stored,
   * which is the failed-run case: nothing, not even the prompt, persists.
   * `regenerate()` must NOT back retry: the server rejects it for unstored
   * tails (docs/research/conversation-durability.md §2-3).
   */
  const resubmitUserMessage = (messageId: string, text: string): void => {
    void sendMessage({ text, messageId }).catch((err: unknown) => {
      // InvalidArgumentError if the id vanished from state mid-click —
      // request errors land in `error`/the banner instead.
      console.warn('Resubmit failed:', err)
    })
  }

  /** Error-banner retry: resubmit the latest user prompt verbatim. */
  const lastUser = lastUserMessage(messages)
  const retry = lastUser
    ? (): void => resubmitUserMessage(lastUser.id, messageText(lastUser))
    : undefined

  return (
    <>
      {runMeta && (
        <div className="flex h-8 shrink-0 items-center justify-end border-b border-subtle px-3">
          <RunMetaBadge meta={runMeta} />
        </div>
      )}
      <MessageList
        messages={messages}
        status={status}
        onApprovalResponse={addToolApprovalResponse}
        onEditMessage={resubmitUserMessage}
        onRegenerate={(id) => void regenerate({ messageId: id })}
      />
      {error && (
        <ChatError error={error} onDismiss={clearError} onRetry={retry} />
      )}
      {/* Composer stays enabled in `error` status so the user can also
          just retype; `sendMessage` self-clears the error on send. */}
      <Composer
        chatId={chat.id}
        workspaceId={workspaceId}
        status={status}
        onSend={(text) => void sendMessage({ text })}
        onStop={() => void stopActive()}
      />
    </>
  )
}

/** Inline run error; 402 gets a settings shortcut, everything else a retry. */
function ChatError({
  error,
  onDismiss,
  onRetry,
}: Readonly<{
  error: Error
  onDismiss: () => void
  /** Undefined when there's no user message to resubmit — no button then. */
  onRetry?: () => void
}>): React.JSX.Element {
  const statusCode =
    error instanceof APICallError ? error.statusCode : undefined

  if (statusCode === 402) {
    return (
      <Banner tone="error">
        <span className="truncate">
          No model provider configured — add an API key in Settings.
        </span>
        <button
          type="button"
          onClick={() => void window.api.openSettings()}
          className="flex shrink-0 items-center gap-1 rounded bg-red-600 px-2 py-0.5 text-white hover:bg-red-700"
        >
          <Settings className="h-3 w-3" />
          Open Settings
        </button>
      </Banner>
    )
  }

  return (
    <Banner tone="error">
      <span className="truncate">{describeError(error)}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded bg-red-600 px-2 py-0.5 text-white hover:bg-red-700"
        >
          Retry
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 text-red-300 hover:text-white"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </Banner>
  )
}

/**
 * FastAPI error bodies are `{"detail": "…"}`; APICallError.message is the raw
 * body text, so unwrap the detail when it's JSON.
 */
function describeError(error: Error): string {
  const body =
    error instanceof APICallError ? error.responseBody : undefined
  if (body) {
    try {
      const parsed: unknown = JSON.parse(body)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'detail' in parsed &&
        typeof (parsed as { detail: unknown }).detail === 'string'
      ) {
        return (parsed as { detail: string }).detail
      }
    } catch {
      /* not JSON — fall through */
    }
  }
  return error.message || 'Something went wrong.'
}

function Banner({
  tone,
  children,
}: Readonly<{
  tone: 'error' | 'info'
  children: React.ReactNode
}>): React.JSX.Element {
  return (
    <div
      role="alert"
      className={`flex shrink-0 items-center gap-2 px-3 py-1.5 text-xs ${
        tone === 'error'
          ? 'bg-red-600 text-white'
          : 'border-b border-subtle bg-subtle text-secondary'
      }`}
    >
      {tone === 'error' && <AlertCircle className="h-3.5 w-3.5 shrink-0" />}
      {children}
    </div>
  )
}
