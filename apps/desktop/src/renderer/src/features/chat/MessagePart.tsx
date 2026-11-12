/**
 * Per-part renderer for a `UIMessage`.
 *
 * One switch over the AI SDK part union: `text` → Streamdown (with `file:`
 * link interception into the right panel), `reasoning` → collapsible trace,
 * `tool-*`/`dynamic-tool` → collapsible tool card, `data-*` → JSON card,
 * `file`/`source-*` → minimal chips.
 *
 * Approval UX is a later story: the server emits `tool-approval-request`
 * stream chunks (sdk_version=7) which the SDK folds into tool-part
 * `approval-requested`/`approval-responded`/`output-denied` states — the
 * generic tool card renders those states with a badge for now.
 */
import { useState, type ReactNode } from 'react'
import {
  isDataUIPart,
  isToolUIPart,
  type DynamicToolUIPart,
  type FileUIPart,
  type ReasoningUIPart,
  type SourceDocumentUIPart,
  type SourceUrlUIPart,
  type TextUIPart,
  type ToolUIPart,
  type UIMessagePart,
  type UIDataTypes,
  type UITools,
} from 'ai'
import { Streamdown, type Components, type ExtraProps } from 'streamdown'
import { ChevronRight, FileCode, Globe, Paperclip, Wrench } from 'lucide-react'
import { useUiStore } from '../../stores/ui'

type Part = UIMessagePart<UIDataTypes, UITools>

const OUTPUT_LINE_LIMIT = 50

export function MessagePart({ part }: { part: Part }): React.JSX.Element | null {
  if (isToolUIPart(part)) {
    return <ToolCard part={part} />
  }
  if (isDataUIPart(part)) {
    return <DataCard part={part} />
  }
  switch (part.type) {
    case 'text':
      return <TextPart part={part} />
    case 'reasoning':
      return <ReasoningPart part={part} />
    case 'file':
      return <FilePart part={part} />
    case 'source-url':
      return <SourceUrlPart part={part} />
    case 'source-document':
      return <SourceDocumentPart part={part} />
    case 'step-start':
      return <hr className="my-2 border-neutral-200" />
    case 'reasoning-file':
      return <Chip icon={Paperclip} label={part.mediaType} title={part.url} />
    case 'custom':
      return <JsonCard title={part.kind} value={part.providerMetadata} />
    default:
      // Future part kinds land here rather than crashing the transcript.
      return <JsonCard title={(part as { type: string }).type} value={part} />
  }
}

/* ------------------------------------------------------------------ */
/* text                                                                */
/* ------------------------------------------------------------------ */

function TextPart({ part }: { part: TextUIPart }): React.JSX.Element {
  return (
    <Streamdown
      mode="streaming"
      isAnimating={part.state === 'streaming'}
      components={markdownComponents}
      className="prose-chat"
    >
      {part.text}
    </Streamdown>
  )
}

/**
 * Custom `<a>` renderer: `file:` links (and bare `file:line` refs the agent
 * emits) open the right panel's File tab instead of navigating. Everything
 * else renders as a normal external link.
 */
function FileAwareLink({
  href,
  children,
}: React.ComponentProps<'a'> & ExtraProps): React.JSX.Element {
  const openFile = useUiStore((s) => s.openFile)
  if (href?.startsWith('file:')) {
    // Accept `file:path` and `file:path:line` spellings.
    const ref = href.slice('file:'.length)
    const match = /^(.*?)(?::(\d+))?$/.exec(ref)
    const path = match?.[1] ?? ref
    const line = match?.[2] ? Number(match[2]) : undefined
    return (
      <button
        type="button"
        onClick={() => openFile(path, line)}
        title={path}
        className="inline cursor-pointer border-0 bg-transparent p-0 font-medium text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700"
      >
        {children}
      </button>
    )
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700">
      {children}
    </a>
  )
}

const markdownComponents: Components = { a: FileAwareLink }

/* ------------------------------------------------------------------ */
/* reasoning                                                           */
/* ------------------------------------------------------------------ */

function ReasoningPart({ part }: { part: ReasoningUIPart }): React.JSX.Element {
  const label =
    part.state === 'streaming' ? 'Thinking…' : 'Thought process'
  return (
    <Collapsible label={label} muted defaultOpen={part.state === 'streaming'}>
      <pre className="whitespace-pre-wrap break-words text-xs text-neutral-500">
        {part.text}
      </pre>
    </Collapsible>
  )
}

/* ------------------------------------------------------------------ */
/* tools                                                               */
/* ------------------------------------------------------------------ */

const STATE_LABEL: Record<string, string> = {
  'input-streaming': 'calling…',
  'input-available': 'called',
  'approval-requested': 'awaiting approval',
  'approval-responded': 'approval answered',
  'output-available': 'done',
  'output-error': 'failed',
  'output-denied': 'denied',
}

function toolName(part: ToolUIPart | DynamicToolUIPart): string {
  return part.type === 'dynamic-tool' ? part.toolName : part.type.slice('tool-'.length)
}

function ToolCard({
  part,
}: {
  part: ToolUIPart | DynamicToolUIPart
}): React.JSX.Element {
  const state = part.state
  const errored = state === 'output-error' || state === 'output-denied'
  return (
    <Collapsible
      icon={<Wrench className="h-3.5 w-3.5" />}
      label={toolName(part)}
      badge={STATE_LABEL[state] ?? state}
      errored={errored}
      defaultOpen={state === 'input-streaming'}
    >
      <div className="space-y-2 text-xs">
        {'input' in part && part.input !== undefined && (
          <KeyValue label="input" value={truncate(stringify(part.input))} />
        )}
        {'output' in part && part.output !== undefined && (
          <KeyValue label="output" value={truncate(stringify(part.output))} />
        )}
        {'errorText' in part && part.errorText && (
          <KeyValue label="error" value={part.errorText} error />
        )}
        {'approval' in part && part.approval && (
          <p className="text-neutral-500">
            approval: {part.approval.approved ? 'approved' : 'denied'}
            {part.approval.reason ? ` — ${part.approval.reason}` : ''}
          </p>
        )}
      </div>
    </Collapsible>
  )
}

/* ------------------------------------------------------------------ */
/* data / files / sources                                              */
/* ------------------------------------------------------------------ */

/**
 * Named renderers for `data-{name}` parts. Plan progress and shell-event
 * parts (P1-agent-harness) register dedicated cards here; anything
 * unregistered falls back to a generic JSON card.
 */
const DATA_RENDERERS: Record<
  string,
  (data: unknown, id?: string) => React.JSX.Element
> = {}

function DataCard({
  part,
}: {
  part: Extract<Part, { type: `data-${string}` }>
}): React.JSX.Element {
  const name = part.type.slice('data-'.length)
  const render = DATA_RENDERERS[name]
  if (render) return render(part.data, part.id)
  return <JsonCard title={name} value={part.data} />
}

function FilePart({ part }: { part: FileUIPart }): React.JSX.Element {
  if (part.mediaType.startsWith('image')) {
    return (
      <img
        src={part.url}
        alt={part.filename ?? 'attachment'}
        className="max-h-64 rounded border border-neutral-200"
      />
    )
  }
  return (
    <Chip
      icon={Paperclip}
      label={part.filename ?? part.mediaType}
      title={part.url}
    />
  )
}

function SourceUrlPart({ part }: { part: SourceUrlUIPart }): React.JSX.Element {
  return (
    <a
      href={part.url}
      target="_blank"
      rel="noreferrer"
      className="my-1 inline-flex items-center gap-1.5 rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs text-blue-600 hover:bg-neutral-100"
    >
      <Globe className="h-3 w-3" />
      {part.title ?? part.url}
    </a>
  )
}

function SourceDocumentPart({
  part,
}: {
  part: SourceDocumentUIPart
}): React.JSX.Element {
  return <Chip icon={FileCode} label={part.title} title={part.filename} />
}

/* ------------------------------------------------------------------ */
/* shared bits                                                         */
/* ------------------------------------------------------------------ */

function Collapsible({
  label,
  badge,
  icon,
  muted,
  errored,
  defaultOpen,
  children,
}: {
  label: string
  badge?: string
  icon?: ReactNode
  muted?: boolean
  errored?: boolean
  defaultOpen?: boolean
  children: ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen ?? false)
  return (
    <div
      className={`my-1.5 rounded-md border text-left ${
        errored ? 'border-red-200 bg-red-50' : 'border-neutral-200 bg-neutral-50'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs ${
          muted ? 'text-neutral-500' : 'text-neutral-700'
        }`}
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {icon}
        <span className="truncate font-medium">{label}</span>
        {badge && (
          <span
            className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
              errored
                ? 'bg-red-100 text-red-700'
                : 'bg-neutral-200 text-neutral-600'
            }`}
          >
            {badge}
          </span>
        )}
      </button>
      {open && <div className="border-t border-neutral-200 px-3 py-2">{children}</div>}
    </div>
  )
}

function KeyValue({
  label,
  value,
  error,
}: {
  label: string
  value: string
  error?: boolean
}): React.JSX.Element {
  return (
    <div>
      <p className={`mb-0.5 font-medium ${error ? 'text-red-600' : 'text-neutral-500'}`}>
        {label}
      </p>
      <pre
        className={`whitespace-pre-wrap break-words rounded bg-white px-2 py-1.5 font-mono ${
          error ? 'text-red-700' : 'text-neutral-700'
        }`}
      >
        {value}
      </pre>
    </div>
  )
}

function JsonCard({
  title,
  value,
}: {
  title: string
  value: unknown
}): React.JSX.Element {
  return (
    <Collapsible label={title}>
      <pre className="whitespace-pre-wrap break-words text-xs text-neutral-600">
        {truncate(stringify(value))}
      </pre>
    </Collapsible>
  )
}

function Chip({
  icon: Icon,
  label,
  title,
}: {
  icon: typeof Paperclip
  label: string
  title?: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      className="my-1 inline-flex items-center gap-1.5 rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs text-neutral-600"
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  )
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Cap long tool output at ~50 lines so one noisy call can't flood the view. */
function truncate(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= OUTPUT_LINE_LIMIT) return text
  return `${lines.slice(0, OUTPUT_LINE_LIMIT).join('\n')}\n… (${lines.length - OUTPUT_LINE_LIMIT} more lines)`
}
