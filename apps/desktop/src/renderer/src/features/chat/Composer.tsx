/**
 * Message composer: one bordered "bubble" — the auto-growing textarea on
 * top and a bottom toolbar row:
 *
 *   + attach · profile picker ········ model picker · send/stop
 *
 * The textarea owns its own input state (AI SDK v7 `useChat` no longer
 * manages input); Enter sends / Shift+Enter newlines; send flips to stop
 * while a run is live. `AttachPicker` inserts `[name](file:path)` links at
 * the textarea cursor.
 */
import { useRef, useState } from 'react'
import type { ChatStatus } from 'ai'
import { SendHorizontal, Square } from 'lucide-react'
import { AttachPicker } from './AttachPicker'
import { ModelPicker } from './ModelPicker'
import { ProfilePicker } from './ProfilePicker'

interface ComposerProps {
  /** Chat this composer writes to — the pickers PATCH their overrides on it. */
  chatId: string
  /** Workspace the attach picker lists files from. */
  workspaceId: string | null
  /** Chat status — drives the send/stop button swap. */
  status: ChatStatus
  /** Called with the trimmed text when the user sends. */
  onSend: (text: string) => void
  /** Called when the user hits stop (local abort + backend cancel). */
  onStop: () => void
  /** Disable input entirely (e.g. no chat selected). */
  disabled?: boolean
}

export function Composer({
  chatId,
  workspaceId,
  status,
  onSend,
  onStop,
  disabled,
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const busy = status === 'submitted' || status === 'streaming'

  const send = (): void => {
    const trimmed = text.trim()
    if (!trimmed || busy || disabled) return
    onSend(trimmed)
    setText('')
    // Reset the auto-grown height after clearing.
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  /** Grow the textarea up to ~8 lines, then scroll. */
  const autoGrow = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  /**
   * Splice `markdown` in at the textarea cursor (used by the attach picker
   * for `[name](file:path)` links), add a trailing space, and put the caret
   * back after the inserted text.
   */
  const insertAtCursor = (markdown: string): void => {
    const el = textareaRef.current
    const snippet = `${markdown} `
    if (!el) {
      setText((prev) => prev + snippet)
      return
    }
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    setText(text.slice(0, start) + snippet + text.slice(end))
    // Defer until React has flushed the new value into the textarea.
    requestAnimationFrame(() => {
      const caret = start + snippet.length
      el.focus()
      el.setSelectionRange(caret, caret)
      autoGrow()
    })
  }

  return (
    <div className="shrink-0 border-t border-neutral-200 bg-white p-3">
      <div className="mx-auto max-w-3xl rounded-xl border border-neutral-300 bg-white px-3 pt-2 pb-1.5 focus-within:border-blue-400">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            autoGrow()
          }}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          placeholder={
            disabled ? 'Select or create a chat…' : 'Message the agent…'
          }
          className="max-h-40 min-h-[1.5rem] w-full resize-none bg-transparent text-sm outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed"
        />
        {/* Toolbar: attach + profile on the left, model + send on the right. */}
        <div className="mt-1 flex items-center gap-1">
          <AttachPicker
            workspaceId={workspaceId}
            onInsert={insertAtCursor}
            disabled={disabled}
          />
          <ProfilePicker chatId={chatId} disabled={disabled} />
          <div className="flex-1" />
          <ModelPicker chatId={chatId} disabled={disabled} />
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              title="Stop"
              className="shrink-0 rounded-lg bg-neutral-800 p-2 text-white hover:bg-neutral-700"
            >
              <Square className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={disabled || !text.trim()}
              aria-label="Send message"
              title="Send (Enter)"
              className="shrink-0 rounded-lg bg-blue-600 p-2 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
            >
              <SendHorizontal className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <p className="mx-auto mt-1.5 max-w-3xl text-[10px] text-neutral-400">
        Enter to send · Shift+Enter for newline
      </p>
    </div>
  )
}
