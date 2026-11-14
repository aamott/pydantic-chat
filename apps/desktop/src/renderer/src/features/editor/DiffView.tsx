/**
 * Read-only unified diff for one file's tool edit(s): a clickable path header
 * (opens the File tab) over `-`/`+`/context line rows.
 *
 * Plain rows, not `@codemirror/merge`'s MergeView — see `diff.ts` for why
 * (MergeView is a whole EditorView per diff; we only need
 * `presentableDiff`'s line mapping).
 *
 * Row clicks open the file at that line only for `write_file` diffs, whose
 * `newText` is the whole file — `edit_file` snippets carry no file offset,
 * so their rows open the file without an anchor.
 */
import { useMemo } from 'react'
import { FileCode } from 'lucide-react'
import { useUiStore } from '../../stores/ui'
import {
  unifiedLines,
  type DiffEdit,
  type DiffRow,
  type DiffRowKind,
  type FileDiff,
} from './diff'

const ROW_TONE: Record<DiffRowKind, string> = {
  ctx: 'diff-ctx',
  add: 'diff-add',
  del: 'diff-del',
  gap: 'diff-gap',
}

const ROW_SIGN: Record<DiffRowKind, string> = {
  ctx: ' ',
  add: '+',
  del: '−',
  gap: '⋮',
}

export function DiffView({ diff }: Readonly<{ diff: FileDiff }>): React.JSX.Element {
  const openFile = useUiStore((s) => s.openFile)
  // write_file's newText IS the file → new-side rows carry real file lines.
  const anchorLines = diff.tool === 'write_file'

  return (
    <div className="overflow-hidden rounded-md border border-subtle bg-surface text-xs">
      <button
        type="button"
        onClick={() => openFile(diff.path)}
        title={`Open ${diff.path}`}
        className="flex w-full items-center gap-1.5 border-b border-subtle bg-subtle px-2.5 py-1.5 text-left hover-bg-raised"
      >
        <FileCode className="h-3.5 w-3.5 shrink-0 text-faint" />
        <span className="truncate font-mono font-medium text-secondary">
          {diff.path}
        </span>
        <span className="ml-auto shrink-0 text-faint">
          {diff.edits.length === 1 ? '1 edit' : `${diff.edits.length} edits`}
        </span>
      </button>
      <div className="max-h-80 overflow-auto font-mono">
        {diff.edits.map((edit, i) => (
          <EditRows
            key={i}
            edit={edit}
            index={i}
            count={diff.edits.length}
            onOpen={(line) => openFile(diff.path, anchorLines ? line : undefined)}
          />
        ))}
      </div>
    </div>
  )
}

function EditRows({
  edit,
  index,
  count,
  onOpen,
}: Readonly<{
  edit: DiffEdit
  index: number
  count: number
  onOpen: (line?: number) => void
}>): React.JSX.Element {
  const rows = useMemo(
    () => unifiedLines(edit.oldText, edit.newText),
    [edit.oldText, edit.newText],
  )
  return (
    <div>
      {count > 1 && (
        <div className="border-y border-subtle bg-raised px-2 py-0.5 text-muted">
          @@ edit {index + 1} of {count} @@
        </div>
      )}
      {rows.map((row, i) => (
        <DiffRowView key={i} row={row} onOpen={onOpen} />
      ))}
    </div>
  )
}

function DiffRowView({
  row,
  onOpen,
}: Readonly<{
  row: DiffRow
  onOpen: (line?: number) => void
}>): React.JSX.Element {
  const line = row.newNo ?? row.oldNo
  return (
    <button
      type="button"
      onClick={() => onOpen(line)}
      title={line !== undefined ? `Open file at line ${line}` : 'Open file'}
      className={`flex w-full items-baseline px-1 text-left ${ROW_TONE[row.kind]}`}
    >
      <span className="w-8 shrink-0 select-none pr-1 text-right text-faint">
        {row.oldNo ?? ''}
      </span>
      <span className="w-8 shrink-0 select-none pr-1 text-right text-faint">
        {row.newNo ?? ''}
      </span>
      <span className="w-4 shrink-0 select-none text-center">
        {ROW_SIGN[row.kind]}
      </span>
      <span
        className={`min-w-0 whitespace-pre-wrap break-all ${row.kind === 'gap' ? 'italic' : ''}`}
      >
        {row.text}
      </span>
    </button>
  )
}
