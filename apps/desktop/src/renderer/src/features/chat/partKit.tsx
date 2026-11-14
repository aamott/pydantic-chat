/**
 * Small renderers shared by the part components (MessagePart, ToolCard):
 * the bordered Collapsible wrapper, label/value dumps, chips, and the
 * clickable FileLink that opens the right panel's File tab.
 *
 * The bottom section is the composer-picker kit: the option-row class and
 * the loading/error/empty/truncation status lines shared by AttachPicker,
 * MentionList, ModelPicker and ProfilePicker.
 */
import { useState, type ReactNode } from 'react'
import {
  ChevronRight,
  File,
  LoaderCircle,
  Paperclip,
  TriangleAlert,
} from 'lucide-react'
import { useUiStore } from '../../stores/ui'

const OUTPUT_LINE_LIMIT = 50

export function Collapsible({
  label,
  badge,
  icon,
  muted,
  errored,
  defaultOpen,
  children,
}: Readonly<{
  label: string
  badge?: string
  icon?: ReactNode
  muted?: boolean
  errored?: boolean
  defaultOpen?: boolean
  children: ReactNode
}>): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen ?? false)
  return (
    <div
      className={`my-1.5 rounded-md border text-left ${
        errored ? 'border-danger bg-danger-soft' : 'border-subtle bg-subtle'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs ${
          muted ? 'text-muted' : 'text-secondary'
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
                ? 'bg-danger-soft text-danger'
                : 'bg-overlay text-secondary'
            }`}
          >
            {badge}
          </span>
        )}
      </button>
      {open && <div className="border-t border-subtle px-3 py-2">{children}</div>}
    </div>
  )
}

export function KeyValue({
  label,
  value,
  error,
}: Readonly<{
  label: string
  value: string
  error?: boolean
}>): React.JSX.Element {
  return (
    <div>
      <p className={`mb-0.5 font-medium ${error ? 'text-danger' : 'text-muted'}`}>
        {label}
      </p>
      <pre
        className={`whitespace-pre-wrap break-words rounded bg-surface px-2 py-1.5 font-mono ${
          error ? 'text-danger' : 'text-secondary'
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
}: Readonly<{
  title: string
  value: unknown
}>): React.JSX.Element {
  return (
    <Collapsible label={title}>
      <pre className="whitespace-pre-wrap break-words text-xs text-secondary">
        {truncate(stringify(value))}
      </pre>
    </Collapsible>
  )
}

export function Chip({
  icon: Icon,
  label,
  title,
}: Readonly<{
  icon: typeof Paperclip
  label: string
  title?: string
}>): React.JSX.Element {
  return (
    <span
      title={title}
      className="my-1 inline-flex items-center gap-1.5 rounded border border-subtle bg-subtle px-2 py-1 text-xs text-secondary"
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
}: Readonly<{
  path: string
  line?: number
  children?: ReactNode
}>): React.JSX.Element {
  const openFile = useUiStore((s) => s.openFile)
  return (
    <button
      type="button"
      onClick={() => openFile(path, line)}
      title={line !== undefined ? `${path}:${line}` : path}
      className="cursor-pointer break-all border-0 bg-transparent p-0 text-left font-mono text-accent underline decoration-blue-300 underline-offset-2 hover-text-accent"
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

/* ------------------------------------------------------------------ */
/* Composer picker kit (AttachPicker / MentionList / ModelPicker /      */
/* ProfilePicker)                                                      */
/* ------------------------------------------------------------------ */

/**
 * Shared className for single-line listbox option rows. Text color is
 * deliberately NOT included — ModelPicker switches `text-strong`/
 * `text-secondary` per row, and two emitted text colors would collide.
 * Compose with `text-secondary`, `focus-bg-raised focus:outline-none`,
 * active `bg-raised`, etc.
 */
export const optionRowClass =
  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs hover-bg-raised'

/** Two-line option-row variant (name + description — ProfilePicker). */
export const optionRowStartClass =
  'flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left hover-bg-raised'

/** Composer toolbar picker trigger (ModelPicker / ProfilePicker). */
export const pickerTriggerClass =
  'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-secondary hover-bg-raised disabled:cursor-not-allowed disabled:opacity-50'

/** Filter-input wrapper strip at the top of picker popovers. */
export const pickerFilterWrapClass = 'border-b border-faint p-1.5'

/** Base padding/size of the status lines inside picker listboxes. */
export const pickerStatusClass = 'px-2.5 py-3 text-xs'

/** "Loading files…" spinner row (AttachPicker / MentionList). */
export function PickerLoading(): React.JSX.Element {
  return (
    <p className={`${pickerStatusClass} flex items-center gap-1.5 text-faint`}>
      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
      Loading files…
    </p>
  )
}

/** Danger status line inside picker listboxes. */
export function PickerError({
  children,
}: Readonly<{
  children: ReactNode
}>): React.JSX.Element {
  return <p className={`${pickerStatusClass} text-danger`}>{children}</p>
}

/** Faint status line inside picker listboxes (empty/no-match hints). */
export function PickerNote({
  children,
}: Readonly<{
  children: ReactNode
}>): React.JSX.Element {
  return <p className={`${pickerStatusClass} text-faint`}>{children}</p>
}

/** "Listing truncated" warning footer inside picker listboxes. */
export function PickerTruncated({
  children,
}: Readonly<{
  children: ReactNode
}>): React.JSX.Element {
  return (
    <p className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] text-warning">
      <TriangleAlert className="h-3 w-3" />
      {children}
    </p>
  )
}

/** File icon + truncated path — the row content shared by file pickers. */
export function FileOption({
  path,
}: Readonly<{
  path: string
}>): React.JSX.Element {
  return (
    <>
      <File className="h-3.5 w-3.5 shrink-0 text-faint" />
      <span className="min-w-0 truncate" title={path}>
        {path}
      </span>
    </>
  )
}