/**
 * Shared centered empty/status panel for the right panel's tabs: an optional
 * faint icon, an optional `text-sm` title, and a `text-xs` note line.
 * `tone: 'error'` switches the note to danger text (fetch/listing failures).
 *
 * Replaces the per-tab `Placeholder`/`EmptyDiff`/`EmptyTerminal`/`Centered`
 * copies — FileViewer's `Overlay` intentionally stays local to that file.
 */
import type { LucideIcon } from 'lucide-react'

export function EmptyState({
  icon: Icon,
  title,
  note,
  tone = 'muted',
}: Readonly<{
  /** Optional icon rendered faint above the text. */
  icon?: LucideIcon
  /** Optional headline line (`text-sm text-muted`). */
  title?: string
  /** Supporting line (`text-xs`); colored by `tone`. */
  note: string
  /** 'muted' (default, text-faint note) or 'error' (text-danger note). */
  tone?: 'muted' | 'error'
}>): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      {Icon && <Icon className="h-6 w-6 text-faint" />}
      {title && <p className="text-sm text-muted">{title}</p>}
      <p
        className={`text-xs ${tone === 'error' ? 'text-danger' : 'text-faint'}`}
      >
        {note}
      </p>
    </div>
  )
}
