/**
 * Diff tab body: every `edit_file`/`write_file` diff in the active chat's
 * transcript, newest first.
 *
 * Diffs are derived from `useChat` messages rather than tracked in a store —
 * the transcript is the source of truth, so hydrated chats and background
 * streams render identically for free (see `diff.ts`). `useChat` re-binds to
 * the externally-owned `Chat` instance the same way ChatPanel does; keyed
 * remount gives each chat a fresh subscription.
 */
import { useMemo } from 'react'
import { useChat } from '@ai-sdk/react'
import { GitCompareArrows } from 'lucide-react'
import type { AppChat } from '../../lib/transport'
import { getChat, useChatsStore } from '../../stores/chats'
import { collectFileDiffs } from './diff'
import { DiffView } from './DiffView'

export function DiffPanel(): React.JSX.Element {
  const activeChatId = useChatsStore((s) => s.activeChatId)
  const chat = activeChatId ? getChat(activeChatId) : undefined
  if (!chat) return <EmptyDiff />
  return <DiffList key={chat.id} chat={chat} />
}

function DiffList({ chat }: Readonly<{ chat: AppChat }>): React.JSX.Element {
  const { messages } = useChat({ chat })
  const diffs = useMemo(() => collectFileDiffs(messages), [messages])
  if (diffs.length === 0) return <EmptyDiff />
  // Newest first: index back into the original array for stable keys.
  return (
    <div className="h-full space-y-3 overflow-y-auto p-3">
      {[...diffs].reverse().map((diff, i) => (
        <DiffView key={diffs.length - 1 - i} diff={diff} />
      ))}
    </div>
  )
}

function EmptyDiff(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <GitCompareArrows className="h-6 w-6 text-faint" />
      <p className="text-sm text-muted">No edits yet</p>
      <p className="text-xs text-faint">
        Agent edit_file / write_file diffs appear here.
      </p>
    </div>
  )
}
