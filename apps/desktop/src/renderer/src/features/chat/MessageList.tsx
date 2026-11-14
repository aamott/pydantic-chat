/**
 * Transcript view: user bubbles right-aligned, assistant parts full-width on
 * the left. Auto-scroll sticks to the bottom while streaming but releases
 * the moment the user scrolls up (and re-engages when they scroll back).
 *
 * Consecutive `approval-requested` tool parts render as one `ApprovalGroup`
 * card — the agent often defers several calls in a single step. Buttons are
 * disabled while a run is live because `addToolApprovalResponse` only
 * auto-resubmits when the chat isn't streaming.
 */
import { useEffect, useRef, useState } from 'react'
import type { ChatStatus, UIMessage } from 'ai'
import { Pencil, RotateCcw } from 'lucide-react'
import { transcriptParts } from '../../lib/dataParts'
import { lastAssistantMessage, messageText } from '../../lib/messages'
import {
  formatElapsed,
  showWorkingIndicator,
} from '../../lib/workingIndicator'
import { MessagePart } from './MessagePart'
import {
  ApprovalGroup,
  groupApprovals,
  type ApprovalResponder,
} from './ApprovalCard'

/** Pixels from the bottom that still count as "at the bottom". */
const STICK_THRESHOLD_PX = 48

interface MessageListProps {
  messages: UIMessage[]
  status: ChatStatus
  /** `useChat`'s `addToolApprovalResponse`, threaded to approval cards. */
  onApprovalResponse: ApprovalResponder
  /**
   * Edit save → `sendMessage({text, messageId})` in ChatPanel: the SDK
   * truncates state at that message and resubmits; the server cuts stored
   * history there (old tail kept as a branch).
   */
  onEditMessage: (messageId: string, text: string) => void
  /**
   * `regenerate({messageId})` — only wired on the trailing assistant
   * message (see `lastAssistantMessage`); anything earlier would drop
   * later user turns, and an unstored tail is rejected server-side.
   */
  onRegenerate: (messageId: string) => void
}

export function MessageList({
  messages,
  status,
  onApprovalResponse,
  onEditMessage,
  onRegenerate,
}: Readonly<MessageListProps>): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const busy = status === 'submitted' || status === 'streaming'
  /** Id of the user message whose bubble is swapped for the editor. */
  const [editingId, setEditingId] = useState<string | null>(null)

  // Edit/regenerate only while no run is live; regenerate additionally
  // requires a completed (ready) tail assistant message.
  const regenerateId =
    status === 'ready' ? lastAssistantMessage(messages)?.id : undefined

  const showWorking = showWorkingIndicator(status, messages)

  // Follow the stream only while the user hasn't scrolled away.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, status])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
    >
      {messages.length === 0 ? (
        <EmptyState status={status} />
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {messages.map((message) =>
            message.id === editingId && !busy ? (
              <UserEditRow
                key={message.id}
                initial={messageText(message)}
                onSave={(text) => {
                  setEditingId(null)
                  onEditMessage(message.id, text)
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <MessageRow
                key={message.id}
                message={message}
                onApprovalResponse={onApprovalResponse}
                approvalsDisabled={busy}
                canEdit={!busy}
                onStartEdit={() => setEditingId(message.id)}
                canRegenerate={message.id === regenerateId}
                onRegenerate={() => onRegenerate(message.id)}
              />
            ),
          )}
          {/* Dead-air cover: a live run with no rendered output yet gets
              a ticking elapsed line so slow first tokens read as working.
              Hidden parts (run-meta, shell) and bare step-start <hr>s
              don't count as output — see lib/workingIndicator.ts. */}
          {showWorking && <WorkingIndicator />}
        </div>
      )}
    </div>
  )
}

function MessageRow({
  message,
  onApprovalResponse,
  approvalsDisabled,
  canEdit,
  onStartEdit,
  canRegenerate,
  onRegenerate,
}: Readonly<{
  message: UIMessage
  onApprovalResponse: ApprovalResponder
  approvalsDisabled: boolean
  /** True while no run is live — edit affordance shown on hover. */
  canEdit: boolean
  onStartEdit: () => void
  /** True only for the trailing assistant message in `ready` status. */
  canRegenerate: boolean
  onRegenerate: () => void
}>): React.JSX.Element {
  // Dedicated surfaces own some data parts: `data-shell` → Terminal tab,
  // `data-run-meta` → header badge, and only the latest `data-plan`
  // snapshot per message is worth a card (see transcriptParts).
  const parts = transcriptParts(message.parts)

  if (message.role === 'user') {
    const text = messageText(message)
    const otherParts = parts.filter((p) => p.type !== 'text')
    return (
      <div className="flex flex-col items-end gap-1">
        {text && (
          <div className="group relative max-w-[85%]">
            {canEdit && (
              <button
                type="button"
                onClick={onStartEdit}
                aria-label="Edit message"
                title="Edit"
                className="absolute -left-6 top-1/2 -translate-y-1/2 text-faint opacity-0 transition-opacity hover-text-default group-hover:opacity-100"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            <div className="whitespace-pre-wrap break-words rounded-2xl bg-blue-600 px-3.5 py-2 text-sm text-white">
              {text}
            </div>
          </div>
        )}
        {otherParts.map((part, i) => (
          <div key={i} className="max-w-[85%]">
            <MessagePart
              part={part}
              onApprovalResponse={onApprovalResponse}
              approvalsDisabled={approvalsDisabled}
            />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="group text-sm text-default">
      {groupApprovals(parts).map((group, i) =>
        group.kind === 'approvals' ? (
          <ApprovalGroup
            key={i}
            parts={group.parts}
            onRespond={onApprovalResponse}
            disabled={approvalsDisabled}
          />
        ) : (
          <MessagePart
            key={i}
            part={group.part}
            onApprovalResponse={onApprovalResponse}
            approvalsDisabled={approvalsDisabled}
          />
        ),
      )}
      {parts.length === 0 && <span className="text-faint">…</span>}
      {canRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          title="Regenerate response"
          className="mt-1 flex items-center gap-1 text-xs text-faint opacity-0 transition-opacity hover-text-default group-hover:opacity-100"
        >
          <RotateCcw className="h-3 w-3" />
          Regenerate
        </button>
      )}
    </div>
  )
}

/**
 * Inline replacement for a user bubble while it's being edited.
 * Save resubmits via `sendMessage({text, messageId})` (ChatPanel), which
 * both the SDK and the server treat as "cut here and re-run" — the old
 * tail survives as a stored branch. Enter saves, Shift+Enter newlines,
 * Escape cancels.
 */
function UserEditRow({
  initial,
  onSave,
  onCancel,
}: Readonly<{
  initial: string
  onSave: (text: string) => void
  onCancel: () => void
}>): React.JSX.Element {
  const [draft, setDraft] = useState(initial)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const autoGrow = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  // Focus on mount, caret at end, and size to the existing content.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    autoGrow(el)
  }, [])

  const save = (): void => {
    const trimmed = draft.trim()
    if (trimmed) onSave(trimmed)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      save()
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          autoGrow(e.target)
        }}
        onKeyDown={onKeyDown}
        rows={1}
        aria-label="Edit message"
        className="max-h-52 w-full max-w-[85%] resize-none rounded-xl border border-accent-soft bg-surface px-3.5 py-2 text-sm outline-none focus:border-blue-500"
      />
      <div className="flex gap-1.5 text-xs">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-strong px-2.5 py-1 text-secondary hover-bg-subtle"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!draft.trim()}
          title="Resubmit from this message"
          className="rounded-lg bg-blue-600 px-2.5 py-1 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled-bg-overlay disabled-text-faint"
        >
          Save &amp; send
        </button>
      </div>
    </div>
  )
}

function EmptyState({ status }: Readonly<{ status: ChatStatus }>): React.JSX.Element {
  const busy = status === 'submitted' || status === 'streaming'
  return (
    <div className="flex h-full items-center justify-center">
      {busy ? (
        <WorkingIndicator className="text-sm text-faint" />
      ) : (
        <p className="text-sm text-faint">Send a message to start.</p>
      )}
    </div>
  )
}

/**
 * "Working… Ns" elapsed line for a live run with no rendered output yet.
 *
 * Mounting marks the run's start: the parent renders this only while
 * `showWorkingIndicator` is true, so it unmounts on the first visible
 * part / on ready/error/stop and each run gets a fresh clock. A 1s
 * `setInterval` drives the tick (stream chunks alone can't — dead air is
 * exactly the absence of renders). The counter span is `aria-hidden` so
 * screen readers aren't spammed every second; `tabular-nums` keeps the
 * digits from jittering the line's width.
 */
function WorkingIndicator({
  className = 'text-xs text-faint',
}: Readonly<{
  className?: string
}>): React.JSX.Element {
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(startedAt)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <p className={className}>
      Working…{' '}
      <span aria-hidden="true" className="tabular-nums">
        {formatElapsed(now - startedAt)}
      </span>
    </p>
  )
}
