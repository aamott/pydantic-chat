/**
 * `@file` mention popup: an inline file list the composer opens while an
 * `@query` token sits at the caret (`lib/mentions.ts` owns the trigger
 * rule). Anchored above the composer bubble via `Popover`; keyboard nav
 * stays in the textarea (ArrowUp/Down highlight, Enter/Tab pick, Escape
 * closes) — rows are `tabIndex={-1}` and mousedown-preventDefault so the
 * textarea never loses focus, matching Slack/VS Code mention UX.
 *
 * The file list itself comes from `useWorkspaceFiles` — the same tree
 * fetch as the `+` AttachPicker — and picking a row replaces the `@query`
 * token with the same `[name](file:path)` markdown.
 */
import { useEffect, useRef } from 'react'
import { File, LoaderCircle, TriangleAlert } from 'lucide-react'
import type { FlatFile } from '../../lib/workspaceFiles'
import { Popover } from './Popover'
import type { WorkspaceFilesState } from './useWorkspaceFiles'

interface MentionListProps {
  /** Element the popup anchors above — the composer bubble. */
  anchor: HTMLElement | null
  /** File fetch state (loading/error/ready), same as AttachPicker. */
  state: WorkspaceFilesState
  /** Ranked files for the current query (from `filterMentionFiles`). */
  shown: FlatFile[]
  /** Index into `shown` of the keyboard-highlighted row. */
  activeIndex: number
  /** Called when a row is picked (click); keyboard picks live in Composer. */
  onPick: (file: FlatFile) => void
  /** Escape / outside-click dismissal. */
  onClose: () => void
  /** Hovering a row syncs the keyboard highlight to it. */
  onHighlight: (index: number) => void
}

export function MentionList({
  anchor,
  state,
  shown,
  activeIndex,
  onPick,
  onClose,
  onHighlight,
}: Readonly<MentionListProps>): React.JSX.Element {
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])

  /* Keep the highlighted row in view as arrows move it. */
  useEffect(() => {
    rowRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <Popover anchor={anchor} onClose={onClose} className="w-80">
      <div
        role="listbox"
        aria-label="Mention a workspace file"
        // Kept out of the tab order — keyboard nav lives on the textarea
        // (aria-activedescendant), focus must never leave it.
        tabIndex={-1}
        className="max-h-72 overflow-y-auto p-1"
      >
        {state.status === 'loading' && (
          <p className="flex items-center gap-1.5 px-2.5 py-3 text-xs text-faint">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            Loading files…
          </p>
        )}
        {state.status === 'error' && (
          <p className="px-2.5 py-3 text-xs text-danger">
            Couldn't list files: {state.message}
          </p>
        )}
        {state.status === 'ready' && shown.length === 0 && (
          <p className="px-2.5 py-3 text-xs text-faint">
            No files match.
          </p>
        )}
        {shown.map((file, index) => (
          <button
            key={file.path}
            id={`mention-option-${index}`}
            ref={(el) => {
              rowRefs.current[index] = el
            }}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            tabIndex={-1}
            /* preventDefault keeps focus (and the caret) in the textarea;
               the click still fires and picks the row. */
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(file)}
            onMouseEnter={() => onHighlight(index)}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-secondary hover-bg-raised ${
              index === activeIndex ? 'bg-raised' : ''
            }`}
          >
            <File className="h-3.5 w-3.5 shrink-0 text-faint" />
            <span className="min-w-0 truncate" title={file.path}>
              {file.path}
            </span>
          </button>
        ))}
        {state.status === 'ready' && state.truncated && (
          <p className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] text-warning">
            <TriangleAlert className="h-3 w-3" />
            Listing truncated — keep typing to narrow it down.
          </p>
        )}
      </div>
    </Popover>
  )
}
