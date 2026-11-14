/**
 * "Edited" affordance under a user bubble: opens a popover listing the
 * prompt versions this message replaced (the backend's
 * `ConversationRecord.branches` surfaced via `GET /chats/{id}/versions`).
 *
 * Picking a version calls `onPick(version)` — MessageList wires that to the
 * same `sendMessage({text, messageId})` resubmit the edit path uses, so the
 * current tail is preserved server-side as another branch, never lost. The
 * chip stays visible but disabled while a run is live: cutting mid-run
 * would resubmit under a stale history.
 */
import { useRef, useState } from 'react'
import { History } from 'lucide-react'
import type { PromptVersion } from '@pydantic-chat/shared'
import { formatRelativeTime } from '../../lib/time'
import { versionPreview } from '../../lib/versions'
import { optionRowStartClass } from './partKit'
import { Popover } from './Popover'

export function VersionChip({
  versions,
  disabled,
  onPick,
}: Readonly<{
  /** This message's replaced versions, most recent first (see versionsForMessage). */
  versions: PromptVersion[]
  /** True while a run is live — version switching is disabled then. */
  disabled?: boolean
  onPick: (version: PromptVersion) => void
}>): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)

  if (versions.length === 0) return null

  const label = `edited — ${versions.length} previous version${versions.length === 1 ? '' : 's'}`

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          disabled
            ? 'Wait for the run to finish'
            : 'Show previous versions of this prompt'
        }
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-faint hover-text-default disabled:cursor-not-allowed disabled:opacity-60"
      >
        <History className="h-3 w-3" />
        {label}
      </button>
      {open && (
        <Popover
          anchor={anchorRef.current}
          onClose={() => setOpen(false)}
          align="end"
          className="w-72 p-1.5"
        >
          <p className="px-2 pb-1 pt-1 text-[10px] uppercase tracking-wide text-faint">
            Previous versions — picking one resubmits it
          </p>
          <ul role="listbox" aria-label="Previous versions">
            {versions.map((v) => {
              const sentAt = Date.parse(v.timestamp)
              return (
                <li key={v.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => {
                      setOpen(false)
                      onPick(v)
                    }}
                    className={`${optionRowStartClass} text-secondary`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs" title={v.text}>
                        {versionPreview(v.text)}
                      </span>
                      {!Number.isNaN(sentAt) && (
                        <span className="block text-[10px] text-faint">
                          {formatRelativeTime(sentAt)}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </Popover>
      )}
    </>
  )
}
