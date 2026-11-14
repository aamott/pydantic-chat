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
import type { FlatFile } from '../../lib/workspaceFiles'
import {
  FileOption,
  PickerError,
  PickerLoading,
  PickerNote,
  PickerTruncated,
  optionRowClass,
} from './partKit'
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
        {state.status === 'loading' && <PickerLoading />}
        {state.status === 'error' && (
          <PickerError>Couldn't list files: {state.message}</PickerError>
        )}
        {state.status === 'ready' && shown.length === 0 && (
          <PickerNote>No files match.</PickerNote>
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
            className={`${optionRowClass} text-secondary ${
              index === activeIndex ? 'bg-raised' : ''
            }`}
          >
            <FileOption path={file.path} />
          </button>
        ))}
        {state.status === 'ready' && state.truncated && (
          <PickerTruncated>
            Listing truncated — keep typing to narrow it down.
          </PickerTruncated>
        )}
      </div>
    </Popover>
  )
}
