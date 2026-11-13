/**
 * Message composer: one bordered "bubble" — the auto-growing textarea on
 * top and a bottom toolbar row:
 *
 *   + attach · profile picker ········ model picker · send/stop
 *
 * The textarea owns its own input state (AI SDK v7 `useChat` no longer
 * manages input); Enter sends / Shift+Enter newlines; send flips to stop
 * while a run is live. `AttachPicker` inserts `[name](file:path)` links at
 * the textarea cursor; typing `@` opens `MentionList`, which inserts the
 * same link over the `@query` token (see lib/mentions.ts for the trigger
 * rule — `@` after a non-word char only, so emails never trigger).
 */
import { useRef, useState } from 'react'
import type { ChatStatus } from 'ai'
import { SendHorizontal, Square } from 'lucide-react'
import {
  applyMention,
  detectMention,
  filterMentionFiles,
  type MentionQuery,
} from '../../lib/mentions'
import type { FlatFile } from '../../lib/workspaceFiles'
import { AttachPicker } from './AttachPicker'
import { MentionList } from './MentionList'
import { ModelPicker } from './ModelPicker'
import { ProfilePicker } from './ProfilePicker'
import { useWorkspaceFiles } from './useWorkspaceFiles'

/** Rows shown in the `@` mention popup before it scrolls. */
const MENTION_MAX_SHOWN = 8

interface ComposerProps {
  /** Chat this composer writes to — the pickers PATCH their overrides on it. */
  readonly chatId: string
  /** Workspace the attach/mention pickers list files from. */
  readonly workspaceId: string | null
  /** Chat status — drives the send/stop button swap. */
  readonly status: ChatStatus
  /** Called with the trimmed text when the user sends. */
  readonly onSend: (text: string) => void
  /** Called when the user hits stop (local abort + backend cancel). */
  readonly onStop: () => void
  /** Disable input entirely (e.g. no chat selected). */
  readonly disabled?: boolean
}

export function Composer({
  chatId,
  workspaceId,
  status,
  onSend,
  onStop,
  disabled,
}: Readonly<ComposerProps>): React.JSX.Element {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const busy = status === 'submitted' || status === 'streaming'

  /* `@` mention session: the live token at the caret (null = popup
   * closed) plus the keyboard-highlighted row. */
  const [mention, setMention] = useState<MentionQuery | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const mentionFiles = useWorkspaceFiles(workspaceId, mention !== null)
  const files = mentionFiles.status === 'ready' ? mentionFiles.files : []
  let mentionShown: FlatFile[] = []
  if (mention) {
    mentionShown = filterMentionFiles(files, mention.query, MENTION_MAX_SHOWN)
  }
  /* Clamp: the list can shrink under the highlight as the query narrows. */
  const activeMentionIndex = Math.min(
    mentionIndex,
    Math.max(mentionShown.length - 1, 0),
  )

  const send = (): void => {
    const trimmed = text.trim()
    if (!trimmed || busy || disabled) return
    onSend(trimmed)
    setText('')
    setMention(null)
    // Reset the auto-grown height after clearing.
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  /**
   * Re-detect the `@query` token at the caret — called on every change
   * and selection move so the popup follows typing, deletion, paste and
   * caret clicks. A non-collapsed selection never counts as a mention.
   */
  const updateMention = (el: HTMLTextAreaElement): void => {
    setMention(
      el.selectionStart === el.selectionEnd
        ? detectMention(el.value, el.selectionStart)
        : null,
    )
    setMentionIndex(0)
  }

  /** Replace the `@query` token with the picked file's `file:` link. */
  const insertMention = (file: FlatFile): void => {
    if (!mention) return
    const { text: next, cursor } = applyMention(text, mention, file)
    setText(next)
    setMention(null)
    // Defer until React has flushed the new value into the textarea.
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(cursor, cursor)
      autoGrow()
    })
  }

  /** Move the mention highlight by `delta`, clamped to the shown list. */
  const moveMentionHighlight = (delta: number): void => {
    setMentionIndex(
      Math.min(
        Math.max(activeMentionIndex + delta, 0),
        Math.max(mentionShown.length - 1, 0),
      ),
    )
  }

  /**
   * Route a keystroke to the open mention popup. Returns true when the
   * key was consumed — no other keydown handling should run.
   */
  const onMentionKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
  ): boolean => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      moveMentionHighlight(e.key === 'ArrowDown' ? 1 : -1)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setMention(null)
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const file = mentionShown[activeMentionIndex]
      /* No matches: Enter falls through to send; Tab keeps its default
       * focus move. */
      if (!file) return false
      e.preventDefault()
      insertMention(file)
      return true
    }
    return false
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    /* Mention popup owns the caret keys while open. `isComposing` leaves
     * IME candidate windows (e.g. Japanese input) untouched. */
    if (mention && !e.nativeEvent.isComposing && onMentionKeyDown(e)) return
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
      <div
        ref={bubbleRef}
        className="mx-auto max-w-3xl rounded-xl border border-neutral-300 bg-white px-3 pt-2 pb-1.5 focus-within:ring-2 focus-within:ring-blue-400"
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            updateMention(e.target)
            autoGrow()
          }}
          onSelect={(e) => updateMention(e.currentTarget)}
          /* Focus leaving the composer closes the popup — row clicks
           * can't blur it (mousedown preventDefault in MentionList). */
          onBlur={() => setMention(null)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          placeholder={
            disabled ? 'Select or create a chat…' : 'Message the agent…'
          }
          aria-activedescendant={
            mention && mentionShown.length > 0
              ? `mention-option-${activeMentionIndex}`
              : undefined
          }
          className="max-h-40 min-h-6 w-full resize-none bg-transparent text-sm outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed"
        />
        {mention && workspaceId && (
          <MentionList
            anchor={bubbleRef.current}
            state={mentionFiles}
            shown={mentionShown}
            activeIndex={activeMentionIndex}
            onPick={insertMention}
            onClose={() => setMention(null)}
            onHighlight={setMentionIndex}
          />
        )}
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
              className={
                disabled || !text.trim()
                  ? 'shrink-0 cursor-not-allowed rounded-lg bg-neutral-200 p-2 text-neutral-400'
                  : 'shrink-0 rounded-lg bg-blue-600 p-2 text-white hover:bg-blue-700'
              }
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
