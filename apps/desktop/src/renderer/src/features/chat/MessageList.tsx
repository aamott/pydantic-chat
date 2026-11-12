/**
 * Transcript view: user bubbles right-aligned, assistant parts full-width on
 * the left. Auto-scroll sticks to the bottom while streaming but releases
 * the moment the user scrolls up (and re-engages when they scroll back).
 */
import { useEffect, useRef } from 'react'
import type { ChatStatus, UIMessage } from 'ai'
import { MessagePart } from './MessagePart'

/** Pixels from the bottom that still count as "at the bottom". */
const STICK_THRESHOLD_PX = 48

interface MessageListProps {
  messages: UIMessage[]
  status: ChatStatus
}

export function MessageList({
  messages,
  status,
}: MessageListProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

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
          {messages.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}
          {status === 'submitted' && (
            <p className="text-xs text-neutral-400">Waiting for response…</p>
          )}
        </div>
      )}
    </div>
  )
}

function MessageRow({ message }: { message: UIMessage }): React.JSX.Element {
  if (message.role === 'user') {
    const text = message.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('')
    const otherParts = message.parts.filter((p) => p.type !== 'text')
    return (
      <div className="flex flex-col items-end gap-1">
        {text && (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-blue-600 px-3.5 py-2 text-sm text-white">
            {text}
          </div>
        )}
        {otherParts.map((part, i) => (
          <div key={i} className="max-w-[85%]">
            <MessagePart part={part} />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="text-sm text-neutral-800">
      {message.parts.map((part, i) => (
        <MessagePart key={i} part={part} />
      ))}
      {message.parts.length === 0 && (
        <span className="text-neutral-400">…</span>
      )}
    </div>
  )
}

function EmptyState({ status }: { status: ChatStatus }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-neutral-400">
        {status === 'submitted' || status === 'streaming'
          ? 'Waiting for response…'
          : 'Send a message to start.'}
      </p>
    </div>
  )
}
