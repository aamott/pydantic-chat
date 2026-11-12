/**
 * Small renderers shared by the part components (MessagePart, ToolCard):
 * the bordered Collapsible wrapper, label/value dumps, chips, and the
 * clickable FileLink that opens the right panel's File tab.
 */
import { useState, type ReactNode } from 'react'
import { ChevronRight, Paperclip } from 'lucide-react'
import { useUiStore } from '../../stores/ui'

export const OUTPUT_LINE_LIMIT = 50

export function Collapsible({
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

export function KeyValue({
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

export function JsonCard({
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

export function Chip({
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

/**
 * Clickable file reference inside tool cards and listings — opens the right
 * panel's File tab at `line` via `ui.openFile`.
 */
export function FileLink({
  path,
  line,
  children,
}: {
  path: string
  line?: number
  children?: ReactNode
}): React.JSX.Element {
  const openFile = useUiStore((s) => s.openFile)
  return (
    <button
      type="button"
      onClick={() => openFile(path, line)}
      title={line !== undefined ? `${path}:${line}` : path}
      className="cursor-pointer break-all border-0 bg-transparent p-0 text-left font-mono text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700"
    >
      {children ?? (line !== undefined ? `${path}:${line}` : path)}
    </button>
  )
}

export function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Cap long tool output at ~50 lines so one noisy call can't flood the view. */
export function truncate(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= OUTPUT_LINE_LIMIT) return text
  return `${lines.slice(0, OUTPUT_LINE_LIMIT).join('\n')}\n… (${lines.length - OUTPUT_LINE_LIMIT} more lines)`
}
