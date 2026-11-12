/**
 * Per-part renderer for a `UIMessage`.
 *
 * One switch over the AI SDK part union: `text` → Streamdown (with `file:`
 * link interception into the right panel), `reasoning` → collapsible trace,
 * `tool-*`/`dynamic-tool` → collapsible tool card (ToolCard.tsx), `data-*` →
 * JSON card, `file`/`source-*` → minimal chips.
 *
 * Approvals: `approval-requested` tool parts route to `ApprovalGroup`
 * (MessageList groups consecutive ones); responded/denied states stay on the
 * generic tool card, which surfaces the approval outcome + deny reason.
 *
 * Shared bits (Collapsible, Chip, JsonCard, stringify/truncate) live in
 * partKit.tsx; the `file:` href grammar lives in lib/fileRefs.ts.
 */
import {
  isDataUIPart,
  isToolUIPart,
  type FileUIPart,
  type ReasoningUIPart,
  type SourceDocumentUIPart,
  type SourceUrlUIPart,
  type TextUIPart,
  type UIDataTypes,
  type UIMessagePart,
  type UITools,
} from 'ai'
import {
  Streamdown,
  defaultRehypePlugins,
  type Components,
  type ExtraProps,
  type StreamdownProps,
} from 'streamdown'
import { FileCode, Globe, Paperclip } from 'lucide-react'
import { parseFileHref } from '../../lib/fileRefs'
import { useUiStore } from '../../stores/ui'
import {
  ApprovalGroup,
  isPendingApproval,
  type ApprovalResponder,
} from './ApprovalCard'
import { Chip, Collapsible, JsonCard } from './partKit'
import { PlanCard } from './PlanCard'
import { ToolCard } from './ToolCard'

type Part = UIMessagePart<UIDataTypes, UITools>

/*
 * Streamdown's default rehype chain is [raw, rehype-sanitize(schema),
 * rehype-harden]. rehype-harden hard-blocks the `file:` protocol in a
 * `blockedProtocols` set no option can override — the model's
 * `[x.ts](file:src/x.ts#L12)` links would render as inert "[blocked]" text
 * before our `<a>` override ever sees them. So the chain is rebuilt
 * without harden and with 'file' added to sanitize's href protocols.
 * Sanitize still strips javascript:/data: and friends; safety isn't
 * weakened because EVERY `file:` anchor is intercepted below
 * (FileAwareLink) into a panel button — it can never navigate.
 */
const sanitizeEntry = defaultRehypePlugins.sanitize
const sanitizePlugin = Array.isArray(sanitizeEntry)
  ? sanitizeEntry[0]
  : sanitizeEntry
const sanitizeSchema = (
  Array.isArray(sanitizeEntry) ? sanitizeEntry[1] : undefined
) as { protocols?: { href?: string[] } } | undefined

const rehypePlugins = [
  defaultRehypePlugins.raw,
  [
    sanitizePlugin,
    {
      ...sanitizeSchema,
      protocols: {
        ...sanitizeSchema?.protocols,
        href: [...(sanitizeSchema?.protocols?.href ?? []), 'file'],
      },
    },
  ],
] as NonNullable<StreamdownProps['rehypePlugins']>

export function MessagePart({
  part,
  onApprovalResponse,
  approvalsDisabled,
}: {
  part: Part
  onApprovalResponse: ApprovalResponder
  approvalsDisabled?: boolean
}): React.JSX.Element | null {
  if (isPendingApproval(part)) {
    // Normally reached via grouped calls in MessageList; lone stragglers
    // (e.g. a pending part on a non-assistant message) still get the card.
    return (
      <ApprovalGroup
        parts={[part]}
        onRespond={onApprovalResponse}
        disabled={approvalsDisabled}
      />
    )
  }
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
      rehypePlugins={rehypePlugins}
      className="prose-chat"
    >
      {part.text}
    </Streamdown>
  )
}

/**
 * Custom `<a>` renderer: `file:` links the agent emits
 * (`[x.ts](file:src/x.ts#L12)`, plus the `file:path:line` and `file:///abs`
 * spellings — see lib/fileRefs.ts) open the right panel's File tab instead
 * of navigating. Everything else renders as a normal external link.
 */
function FileAwareLink({
  href,
  children,
}: React.ComponentProps<'a'> & ExtraProps): React.JSX.Element {
  const openFile = useUiStore((s) => s.openFile)
  const ref = href ? parseFileHref(href) : null
  if (ref) {
    return (
      <button
        type="button"
        onClick={() => openFile(ref.path, ref.line)}
        title={ref.path}
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
> = {
  // `data-plan` — full plan snapshot; latest per message (see transcriptParts).
  plan: (data) => <PlanCard data={data} />,
  // `data-shell`/`data-run-meta` are intentionally unregistered: the Terminal
  // tab and the chat header own them, and MessageList drops them inline.
}

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
