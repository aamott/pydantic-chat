/**
 * Chat rows under one workspace: title + relative activity time, active
 * highlight, and hover affordances for inline rename and confirmed delete.
 * All mutations live in the chats store — this file is presentation plus
 * per-row editing state only.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, Pencil, Trash2, X } from 'lucide-react'
import type { ChatSummary } from '@pydantic-chat/shared'
import { formatRelativeTime } from '../../lib/time'

interface ChatListProps {
  chats: ChatSummary[]
  activeChatId: string | null
  onSelect: (chatId: string) => void
  /** Resolves false when the PATCH fails — the row stays in edit mode. */
  onRename: (chatId: string, title: string) => Promise<boolean>
  onDelete: (chatId: string) => void
}

export function ChatList({
  chats,
  activeChatId,
  onSelect,
  onRename,
  onDelete,
}: Readonly<ChatListProps>): React.JSX.Element {
  if (chats.length === 0) {
    return (
      <p className="px-2 py-1.5 text-[11px] text-faint">No chats yet.</p>
    )
  }
  return (
    <ul aria-label="Chats" className="space-y-0.5">
      {chats.map((chat) => (
        <li key={chat.id}>
          <ChatRow
            chat={chat}
            active={chat.id === activeChatId}
            onSelect={onSelect}
            onRename={onRename}
            onDelete={onDelete}
          />
        </li>
      ))}
    </ul>
  )
}

interface ChatRowProps {
  chat: ChatSummary
  active: boolean
  onSelect: (chatId: string) => void
  onRename: (chatId: string, title: string) => Promise<boolean>
  onDelete: (chatId: string) => void
}

function ChatRow({
  chat,
  active,
  onSelect,
  onRename,
  onDelete,
}: Readonly<ChatRowProps>): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(chat.title)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Focus the rename field when it mounts — same UX as `autoFocus` without
  // the attribute (S9379).
  useEffect(() => {
    if (editing) renameInputRef.current?.focus()
  }, [editing])

  /** Commit the rename; empty/unchanged titles just close the input. */
  const commitRename = async (): Promise<void> => {
    const next = draft.trim()
    if (!next || next === chat.title) {
      setDraft(chat.title)
      setEditing(false)
      return
    }
    // On failure the store has already surfaced a notice — stay editing.
    if (await onRename(chat.id, next)) setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1 rounded-md bg-raised px-2 py-1">
        <input
          ref={renameInputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitRename()
            else if (e.key === 'Escape') {
              setDraft(chat.title)
              setEditing(false)
            }
          }}
          onBlur={() => void commitRename()}
          aria-label="Rename chat"
          className="min-w-0 flex-1 rounded border border-accent-soft bg-surface px-1.5 py-0.5 text-xs text-default outline-none"
        />
        <RowButton label="Save" onClick={() => void commitRename()}>
          <Check className="h-3.5 w-3.5" />
        </RowButton>
        <RowButton
          label="Cancel"
          onClick={() => {
            setDraft(chat.title)
            setEditing(false)
          }}
        >
          <X className="h-3.5 w-3.5" />
        </RowButton>
      </div>
    )
  }

  if (confirmingDelete) {
    return (
      <div className="flex items-center gap-1 rounded-md bg-danger-soft px-2 py-1 text-xs text-danger">
        <span className="min-w-0 flex-1 truncate">Delete this chat?</span>
        <RowButton
          label="Confirm delete"
          tone="danger"
          onClick={() => onDelete(chat.id)}
        >
          <Check className="h-3.5 w-3.5" />
        </RowButton>
        <RowButton label="Cancel" onClick={() => setConfirmingDelete(false)}>
          <X className="h-3.5 w-3.5" />
        </RowButton>
      </div>
    )
  }

  return (
    <div
      className={`group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${
        active
          ? 'bg-accent-soft font-medium text-accent'
          : 'text-secondary hover-bg-raised'
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(chat.id)}
        title={chat.title}
        className="min-w-0 flex-1 truncate text-left"
      >
        {chat.title}
      </button>
      {/* Activity time gives way to the hover actions on the same slot. */}
      <span className="shrink-0 text-[10px] text-faint group-hover:hidden">
        {formatRelativeTime(chat.updated_at)}
      </span>
      <span className="hidden shrink-0 items-center group-hover:flex">
        <RowButton
          label="Rename chat"
          onClick={() => {
            setDraft(chat.title)
            setEditing(true)
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
        </RowButton>
        <RowButton
          label="Delete chat"
          tone="danger"
          onClick={() => setConfirmingDelete(true)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </RowButton>
      </span>
    </div>
  )
}

/** Tiny square icon button used inside chat/workspace rows. */
function RowButton({
  label,
  tone = 'neutral',
  onClick,
  children,
}: Readonly<{
  label: string
  tone?: 'neutral' | 'danger'
  onClick: () => void
  children: React.ReactNode
}>): React.JSX.Element {
  return (
    <button
      type="button"
      // Keep the rename input's focus until the click lands — otherwise its
      // blur handler would commit the draft before Cancel gets to run.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      aria-label={label}
      title={label}
      className={`rounded p-1 ${
        tone === 'danger'
          ? 'text-muted hover-bg-danger-soft hover-text-danger'
          : 'text-muted hover-bg-overlay hover-text-default'
      }`}
    >
      {children}
    </button>
  )
}
