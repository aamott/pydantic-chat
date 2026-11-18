/**
 * DORMANT — no longer mounted anywhere. The P2 right-panel redesign
 * removed the Terminal tab: live `data-shell` output is folded into the
 * matching chat tool card instead (`lib/dataParts.collectShellBlocks` +
 * ToolCard's `shellBlock` prop). This file is kept on disk in case a
 * dedicated shell view returns.
 *
 * `data-shell` parts stream `started`/`output`/`finished` phases DURING a
 * command (the static `tool-shell` part only resolves at the end), so this
 * view is rebuilt from the `useChat` transcript the same way DiffPanel is —
 * `useChat` binds the externally-owned `Chat` instance from the registry and
 * updates on every new chunk. Blocks group phases by `tool_call_id` in
 * first-seen order.
 *
 * Caveat: `data-*` chunks are stream-only, so a reloaded transcript renders
 * the empty state — the terminal is a live view, not a log.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useChat } from '@ai-sdk/react'
import { Loader2, SquareTerminal } from 'lucide-react'
import {
  collectShellBlocks,
  type CommandBlock,
} from '../../lib/dataParts'
import { FileLink } from '../chat/partKit'
import { EmptyState } from './EmptyState'
import type { AppChat } from '../../lib/transport'
import { getChat, useChatsStore } from '../../stores/chats'

/** Mirrors the backend's 64k tool-output cap; the tail is what matters. */
const OUTPUT_CHAR_CAP = 64 * 1024

/** Pixels from the bottom that still count as "at the bottom". */
const STICK_THRESHOLD_PX = 48

export function TerminalView(): React.JSX.Element {
  const activeChatId = useChatsStore((s) => s.activeChatId)
  const chat = activeChatId ? getChat(activeChatId) : undefined
  if (!chat) return <EmptyTerminal />
  // Keyed remount: each chat gets a fresh useChat binding + scroll state.
  return <TerminalList key={chat.id} chat={chat} />
}

function TerminalList({ chat }: Readonly<{ chat: AppChat }>): React.JSX.Element {
  const { messages } = useChat({ chat })
  const blocks = useMemo(() => collectShellBlocks(messages), [messages])

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  // Follow appended output while the user hasn't scrolled away.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [blocks])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX
  }

  if (blocks.length === 0) return <EmptyTerminal />

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="h-full space-y-3 overflow-y-auto p-3"
    >
      {blocks.map((block) => (
        <CommandBlockView key={block.id} block={block} />
      ))}
    </div>
  )
}

function CommandBlockView({
  block,
}: Readonly<{
  block: CommandBlock
}>): React.JSX.Element {
  const overflow = block.output.length > OUTPUT_CHAR_CAP
  const output = overflow ? block.output.slice(-OUTPUT_CHAR_CAP) : block.output

  return (
    <div
      data-shell-block={block.id}
      className="overflow-hidden rounded-md border border-subtle bg-subtle"
    >
      {/* `$ command` header + status badge */}
      <div className="flex items-center gap-2 border-b border-subtle px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-secondary">
          <span className="mr-1 select-none text-faint">$</span>
          {block.command ?? '…'}
        </span>
        <StatusBadge block={block} />
      </div>

      {output !== '' && (
        <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words px-2.5 py-1.5 font-mono text-xs text-secondary">
          {overflow && '… (earlier output truncated)\n'}
          {output}
        </pre>
      )}

      {(block.truncated ||
        block.lineCount !== null ||
        block.outputPath ||
        block.statusPath) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-subtle px-2.5 py-1.5 text-[11px] text-faint">
          {block.lineCount !== null && <span>{block.lineCount} lines</span>}
          {block.truncated && <span>capped by tool</span>}
          {block.pid !== null && <span>pid {block.pid}</span>}
          {block.outputPath && (
            <FileLink path={block.outputPath}>full output</FileLink>
          )}
          {block.statusPath && (
            <FileLink path={block.statusPath}>status</FileLink>
          )}
        </div>
      )}
    </div>
  )
}

/** running spinner · `exit N` · `detached` (still running in background). */
function StatusBadge({ block }: Readonly<{ block: CommandBlock }>): React.JSX.Element {
  if (!block.finished) {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">
        <Loader2 className="h-3 w-3 animate-spin" />
        running
      </span>
    )
  }
  if (block.exitCode === null) {
    return (
      <span className="shrink-0 rounded bg-overlay px-1.5 py-0.5 text-[10px] text-secondary">
        detached
      </span>
    )
  }
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${
        block.exitCode === 0
          ? 'bg-overlay text-secondary'
          : 'bg-danger-soft text-danger'
      }`}
    >
      exit {block.exitCode}
    </span>
  )
}

function EmptyTerminal(): React.JSX.Element {
  return (
    <EmptyState
      icon={SquareTerminal}
      title="No shell activity yet"
      note="Live `shell` tool output appears here while a command runs."
    />
  )
}
