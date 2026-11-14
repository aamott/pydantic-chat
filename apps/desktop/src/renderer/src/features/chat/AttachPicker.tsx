/**
 * Composer `+` attach picker: opens a popover listing the workspace's files
 * (`GET /api/files/tree` via `useWorkspaceFiles`, flattened client-side)
 * behind a filter input. Picking a file inserts a `[name](file:path)`
 * markdown link into the composer at the cursor — the same `file:` scheme
 * MessagePart renders and `parseFileHref` resolves.
 *
 * The tree is re-fetched on every open so newly created files show up; at
 * most `MAX_SHOWN` filtered entries render at once.
 */
import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { fileMentionMarkdown, type FlatFile } from '../../lib/workspaceFiles'
import { iconButtonColors } from '../../lib/ui'
import {
  FileOption,
  PickerError,
  PickerLoading,
  PickerNote,
  PickerTruncated,
  optionRowClass,
  pickerFilterWrapClass,
} from './partKit'
import { Popover } from './Popover'
import { useWorkspaceFiles } from './useWorkspaceFiles'

const MAX_SHOWN = 50

interface AttachPickerProps {
  /** Workspace whose files are listed; null disables the picker. */
  readonly workspaceId: string | null
  /** Insert `[name](file:path)` into the composer text. */
  readonly onInsert: (markdown: string) => void
  readonly disabled?: boolean
}

export function AttachPicker({
  workspaceId,
  onInsert,
  disabled,
}: Readonly<AttachPickerProps>): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const state = useWorkspaceFiles(workspaceId, open)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  /* Reset the filter each time the popover opens. */
  useEffect(() => {
    if (open) setFilter('')
  }, [open])

  /* Focus the filter input once the list has settled. */
  useEffect(() => {
    if (open && state.status !== 'loading') inputRef.current?.focus()
  }, [open, state.status])

  const shown =
    state.status === 'ready'
      ? state.files
          .filter((f) =>
            f.path.toLowerCase().includes(filter.trim().toLowerCase()),
          )
          .slice(0, MAX_SHOWN)
      : []

  const pick = (file: FlatFile): void => {
    onInsert(fileMentionMarkdown(file))
    setOpen(false)
  }

  /* Enter in the filter picks the top match — fastest attach path. */
  const onInputKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && shown.length > 0) {
      e.preventDefault()
      pick(shown[0])
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || !workspaceId}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Attach a workspace file"
        title="Attach a workspace file"
        className={`shrink-0 rounded-md p-1 ${iconButtonColors({ muted: true })} disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <Plus className="h-4 w-4" />
      </button>

      {open && (
        <Popover
          anchor={buttonRef.current}
          onClose={() => setOpen(false)}
          className="w-72"
        >
          <div className={pickerFilterWrapClass}>
            <input
              ref={inputRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Filter files…"
              spellCheck={false}
              className="w-full rounded-md border border-subtle px-2 py-1 text-xs outline-none placeholder-faint focus:ring-2 focus:ring-blue-400"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1" role="listbox" aria-label="Workspace files">
            {state.status === 'loading' && <PickerLoading />}
            {state.status === 'error' && (
              <PickerError>Couldn't list files: {state.message}</PickerError>
            )}
            {state.status === 'ready' && shown.length === 0 && (
              <PickerNote>
                {filter ? 'No files match.' : 'No files in this workspace.'}
              </PickerNote>
            )}
            {shown.map((file) => (
              <button
                key={file.path}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => pick(file)}
                className={`${optionRowClass} text-secondary focus-bg-raised focus:outline-none`}
              >
                <FileOption path={file.path} />
              </button>
            ))}
            {state.status === 'ready' && state.truncated && (
              <PickerTruncated>
                Listing truncated — filter to narrow it down.
              </PickerTruncated>
            )}
          </div>
        </Popover>
      )}
    </>
  )
}
