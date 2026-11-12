/**
 * Terminal tab body: the persistent `shell` tool's live output for the
 * active chat, one block per tool call.
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
import type { UIMessage } from 'ai'
import { Loader2, SquareTerminal } from 'lucide-react'
import { dataPartsOf, asShellPhase } from '../../lib/dataParts'
import { FileLink } from '../chat/partKit'
import type { AppChat } from '../../lib/transport'
import { getChat, useChatsStore } from '../../stores/chats'
import { useUiStore } from '../../stores/ui'

/** Mirrors the backend's 64k tool-output cap; the tail is what matters. */
const OUTPUT_CHAR_CAP = 64 * 1024

/** Pixels from the bottom that still count as "at the bottom". */
const STICK_THRESHOLD_PX = 48

/** One `shell` tool call, accumulated across its `data-shell` phases. */
interface CommandBlock {
  /** `tool_call_id` — also the DOM anchor for tool-card jumps. */
  id: string
  toolName: string | null
  command: string | null
  pid: number | null
  output: string
  finished: boolean
  exitCode: number | null
  truncated: boolean | null
  lineCount: number | null
  outputPath: string | null
  statusPath: string | null
}

/**
 * Fold every `data-shell` part in the transcript into per-call blocks.
 * Events missing `tool_call_id` (shouldn't happen — the envelope always
 * carries it, but the field is nullable on the wire) share one block rather
 * than being dropped. `finished` fires when the tool stops waiting, so a
 * detached command reports `exitCode: null`.
 */
export function collectShellBlocks(messages: UIMessage[]): CommandBlock[] {
  const blocks = new Map<string, CommandBlock>()
  for (const phase of dataPartsOf(messages, 'shell', asShellPhase)) {
    const id = phase.tool_call_id ?? 'shell'
    let block = blocks.get(id)
    if (!block) {
      block = {
        id,
        toolName: phase.tool_name,
        command: null,
        pid: null,
        output: '',
        finished: false,
        exitCode: null,
        truncated: null,
        lineCount: null,
        outputPath: null,
        statusPath: null,
      }
      blocks.set(id, block)
    }
    if (phase.tool_name) block.toolName = phase.tool_name
    if (phase.command) block.command = phase.command
    if (phase.pid !== null) block.pid = phase.pid
    if (phase.phase === 'output' && phase.text) block.output += phase.text
    if (phase.phase === 'finished') {
      block.finished = true
      block.exitCode = phase.exit_code
      block.truncated = phase.truncated
      block.lineCount = phase.line_count
      block.outputPath = phase.output_path
      block.statusPath = phase.status_path
    }
  }
  return [...blocks.values()]
}

export function TerminalView(): React.JSX.Element {
  const activeChatId = useChatsStore((s) => s.activeChatId)
  const chat = activeChatId ? getChat(activeChatId) : undefined
  if (!chat) return <EmptyTerminal />
  // Keyed remount: each chat gets a fresh useChat binding + scroll state.
  return <TerminalList key={chat.id} chat={chat} />
}

function TerminalList({ chat }: { chat: AppChat }): React.JSX.Element {
  const { messages } = useChat({ chat })
  const blocks = useMemo(() => collectShellBlocks(messages), [messages])

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const terminalTarget = useUiStore((s) => s.terminalTarget)
  const clearTerminalTarget = useUiStore((s) => s.clearTerminalTarget)

  // Follow appended output while the user hasn't scrolled away.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [blocks])

  // A shell tool card's "View in Terminal" jump scrolls to its block.
  useEffect(() => {
    if (!terminalTarget || !scrollRef.current) return
    const el = scrollRef.current.querySelector(
      `[data-shell-block="${CSS.escape(terminalTarget)}"]`,
    )
    if (el) {
      stickToBottom.current = false
      el.scrollIntoView({ block: 'start' })
      clearTerminalTarget()
    }
    // Not found yet: the block may still be streaming in — retry next render.
  }, [terminalTarget, blocks, clearTerminalTarget])

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
}: {
  block: CommandBlock
}): React.JSX.Element {
  const overflow = block.output.length > OUTPUT_CHAR_CAP
  const output = overflow ? block.output.slice(-OUTPUT_CHAR_CAP) : block.output

  return (
    <div
      data-shell-block={block.id}
      className="overflow-hidden rounded-md border border-neutral-200 bg-neutral-50"
    >
      {/* `$ command` header + status badge */}
      <div className="flex items-center gap-2 border-b border-neutral-200 px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-700">
          <span className="mr-1 select-none text-neutral-400">$</span>
          {block.command ?? '…'}
        </span>
        <StatusBadge block={block} />
      </div>

      {output !== '' && (
        <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words px-2.5 py-1.5 font-mono text-xs text-neutral-700">
          {overflow && '… (earlier output truncated)\n'}
          {output}
        </pre>
      )}

      {(block.truncated ||
        block.lineCount !== null ||
        block.outputPath ||
        block.statusPath) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-neutral-200 px-2.5 py-1.5 text-[11px] text-neutral-400">
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
function StatusBadge({ block }: { block: CommandBlock }): React.JSX.Element {
  if (!block.finished) {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700">
        <Loader2 className="h-3 w-3 animate-spin" />
        running
      </span>
    )
  }
  if (block.exitCode === null) {
    return (
      <span className="shrink-0 rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600">
        detached
      </span>
    )
  }
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${
        block.exitCode === 0
          ? 'bg-neutral-200 text-neutral-600'
          : 'bg-red-100 text-red-700'
      }`}
    >
      exit {block.exitCode}
    </span>
  )
}

function EmptyTerminal(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <SquareTerminal className="h-6 w-6 text-neutral-300" />
      <p className="text-sm text-neutral-500">No shell activity yet</p>
      <p className="text-xs text-neutral-400">
        Live `shell` tool output appears here while a command runs.
      </p>
    </div>
  )
}
