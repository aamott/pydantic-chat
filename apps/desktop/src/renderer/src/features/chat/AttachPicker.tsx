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
import { File, LoaderCircle, Plus, TriangleAlert } from 'lucide-react'
import { fileMentionMarkdown, type FlatFile } from '../../lib/workspaceFiles'
import { Popover } from './Popover'
import { useWorkspaceFiles } from './useWorkspaceFiles'

const MAX_SHOWN = 50

interface AttachPickerProps {
  /** Workspace whose files are listed; null disables the picker. */
  workspaceId: string | null
  /** Insert `[name](file:path)` into the composer text. */
  onInsert: (markdown: string) => void
  disabled?: boolean
}

export function AttachPicker({
  workspaceId,
  onInsert,
  disabled,
}: AttachPickerProps): React.JSX.Element {
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
        className="shrink-0 rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="h-4 w-4" />
      </button>

      {open && (
        <Popover
          anchor={buttonRef.current}
          onClose={() => setOpen(false)}
          className="w-72"
        >
          <div className="border-b border-neutral-100 p-1.5">
            <input
              ref={inputRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Filter files…"
              spellCheck={false}
              className="w-full rounded-md border border-neutral-200 px-2 py-1 text-xs outline-none placeholder:text-neutral-400 focus:border-blue-400"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1" role="listbox" aria-label="Workspace files">
            {state.status === 'loading' && (
              <p className="flex items-center gap-1.5 px-2.5 py-3 text-xs text-neutral-400">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                Loading files…
              </p>
            )}
            {state.status === 'error' && (
              <p className="px-2.5 py-3 text-xs text-red-600">
                Couldn't list files: {state.message}
              </p>
            )}
            {state.status === 'ready' && shown.length === 0 && (
              <p className="px-2.5 py-3 text-xs text-neutral-400">
                {filter ? 'No files match.' : 'No files in this workspace.'}
              </p>
            )}
            {shown.map((file) => (
              <button
                key={file.path}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => pick(file)}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-100 focus:bg-neutral-100 focus:outline-none"
              >
                <File className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                <span className="min-w-0 truncate" title={file.path}>
                  {file.path}
                </span>
              </button>
            ))}
            {state.status === 'ready' && state.truncated && (
              <p className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] text-amber-600">
                <TriangleAlert className="h-3 w-3" />
                Listing truncated — filter to narrow it down.
              </p>
            )}
          </div>
        </Popover>
      )}
    </>
  )
}
