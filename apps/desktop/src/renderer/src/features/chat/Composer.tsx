/**
 * Message composer: a textarea that owns its own input state (AI SDK v7
 * `useChat` no longer manages input), Enter to send / Shift+Enter for a
 * newline, and a send/stop button that flips while a run is live.
 */
import { useRef, useState } from 'react'
import type { ChatStatus } from 'ai'
import { SendHorizontal, Square } from 'lucide-react'

interface ComposerProps {
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

  return (
    <div className="shrink-0 border-t border-neutral-200 bg-white p-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-neutral-300 bg-white px-3 py-2 focus-within:border-blue-400">
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
          className="max-h-40 min-h-[1.5rem] flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed"
        />
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
      <p className="mx-auto mt-1.5 max-w-3xl text-[10px] text-neutral-400">
        Enter to send · Shift+Enter for newline
      </p>
    </div>
  )
}
