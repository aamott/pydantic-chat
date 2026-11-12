/**
 * File-edit diff model shared by chat tool cards and the right-panel Diff tab.
 *
 * Source of truth: diffs are DERIVED from `useChat` messages (tool-part args)
 * rather than tracked in the ui store — the transcript already records every
 * edit, so hydrated chats, chat switches, and background streams all render
 * the same diffs for free and nothing can drift out of sync.
 *
 * Line diffing: `@codemirror/merge`'s `presentableDiff` (a maintained Myers
 * implementation with presentation cleanup) produces char-level `Change`s
 * which we map onto whole lines. MergeView / unifiedMergeView were rejected:
 * they embed a full EditorView per diff — editor-in-editor machinery a
 * read-only transcript card doesn't need.
 */
import { presentableDiff } from '@codemirror/merge'
import { isToolUIPart, type UIMessage } from 'ai'
import { isRecord, stringField, toolName } from '../../lib/toolArgs'

/** One exact old→new replacement inside a file. */
export interface DiffEdit {
  oldText: string
  newText: string
}

/** The edits one `edit_file`/`write_file` tool part applies to `path`. */
export interface FileDiff {
  path: string
  /** Producing tool: 'edit_file' | 'write_file'. */
  tool: string
  edits: DiffEdit[]
}

/* ------------------------------------------------------------------ */
/* Extraction from tool parts                                          */
/* ------------------------------------------------------------------ */

/**
 * The diff a tool call's `input` describes, or null for tools/args that carry
 * none. `write_file` diffs from empty (all-added): the prior content isn't in
 * the args, and reconstructing it from earlier `read_file` outputs is left to
 * a later iteration.
 */
export function fileDiffFromTool(
  name: string,
  input: unknown,
): FileDiff | null {
  if (!isRecord(input)) return null
  const path = stringField(input, 'path')
  if (path === undefined) return null
  if (name === 'edit_file') {
    const edits = extractEdits(input)
    return edits.length > 0 ? { path, tool: name, edits } : null
  }
  if (name === 'write_file') {
    const content = stringField(input, 'content')
    return content === undefined
      ? null
      : { path, tool: name, edits: [{ oldText: '', newText: content }] }
  }
  return null
}

/**
 * `edit_file` args → ordered edits: the `replacements[]` batch form or the
 * single `old_text`/`new_text` pair. Entries missing both fields are skipped.
 */
export function extractEdits(input: Record<string, unknown>): DiffEdit[] {
  const list = input.replacements
  if (Array.isArray(list)) {
    const edits: DiffEdit[] = []
    for (const entry of list) {
      if (!isRecord(entry)) continue
      const edit = asEdit(entry)
      if (edit) edits.push(edit)
    }
    return edits
  }
  const single = asEdit(input)
  return single ? [single] : []
}

function asEdit(record: Record<string, unknown>): DiffEdit | null {
  const oldText = stringField(record, 'old_text')
  const newText = stringField(record, 'new_text')
  return oldText === undefined && newText === undefined
    ? null
    : { oldText: oldText ?? '', newText: newText ?? '' }
}

/** Every file diff in a transcript, in message order (oldest first). */
export function collectFileDiffs(messages: UIMessage[]): FileDiff[] {
  const diffs: FileDiff[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue
      const input = 'input' in part ? part.input : undefined
      const diff = fileDiffFromTool(toolName(part), input)
      if (diff) diffs.push(diff)
    }
  }
  return diffs
}

/* ------------------------------------------------------------------ */
/* Unified line diff over presentableDiff                              */
/* ------------------------------------------------------------------ */

export type DiffRowKind = 'ctx' | 'add' | 'del' | 'gap'

export interface DiffRow {
  kind: DiffRowKind
  text: string
  /** 1-based line numbers in the old/new doc, when the row maps to one. */
  oldNo?: number
  newNo?: number
}

/** Unchanged lines kept on each side of a change before a `gap` collapse. */
const CONTEXT_LINES = 3

type LineRange = [first: number, last: number]

/**
 * Char `Change`s → unified line rows (`-` old, `+` new, ` ` shared).
 *
 * A non-empty range maps to the whole lines it touches. A zero-width range
 * (pure insertion on the old side / pure deletion on the new) maps to its
 * containing line only when the change's boundary aligns — inserting at a
 * line start only preserves that line when the inserted text ends on `\n`;
 * the mirror rule applies at a line end. A `\n` sitting at the start of a
 * range merely terminates the line before it: that line is context, not a
 * change, when it's identical on the other side. Identical regions pair
 * old/new lines up; runs past 2×CONTEXT collapse to a `gap` row.
 */
export function unifiedLines(oldText: string, newText: string): DiffRow[] {
  // '' is zero lines, not one empty line — keeps all-add/all-del diffs clean.
  const oldLines = oldText === '' ? [] : oldText.split('\n')
  const newLines = newText === '' ? [] : newText.split('\n')
  const oldStarts = lineStarts(oldText)
  const newStarts = lineStarts(newText)

  const rows: DiffRow[] = []
  let aCursor = 0
  let bCursor = 0

  const emitContext = (aFrom: number, aTo: number, bFrom: number): void => {
    const count = aTo - aFrom
    if (count <= 0) return
    const collapse = count > CONTEXT_LINES * 2
    const head = collapse ? CONTEXT_LINES : count
    const tail = collapse ? CONTEXT_LINES : 0
    for (let k = 0; k < head; k++) {
      rows.push({
        kind: 'ctx',
        text: oldLines[aFrom + k],
        oldNo: aFrom + k + 1,
        newNo: bFrom + k + 1,
      })
    }
    if (tail > 0) {
      const skipped = count - head - tail
      rows.push({
        kind: 'gap',
        text: `${skipped} unchanged ${skipped === 1 ? 'line' : 'lines'}`,
      })
      for (let k = count - tail; k < count; k++) {
        rows.push({
          kind: 'ctx',
          text: oldLines[aFrom + k],
          oldNo: aFrom + k + 1,
          newNo: bFrom + k + 1,
        })
      }
    }
  }

  for (const change of presentableDiff(oldText, newText)) {
    let aRange = changedLines(
      oldStarts,
      oldText,
      change.fromA,
      change.toA,
      lineIntact(
        oldText,
        change.fromA,
        newText.slice(change.fromB, change.toB),
      ),
    )
    const bRange = changedLines(
      newStarts,
      newText,
      change.fromB,
      change.toB,
      lineIntact(
        newText,
        change.fromB,
        oldText.slice(change.fromA, change.toA),
      ),
    )

    // A range starting on a '\n': that char only terminates the line before
    // it. When that line survives verbatim on the B side it's context, not
    // a deletion — fold it into the pre-change run.
    if (
      aRange &&
      aRange[0] >= aCursor &&
      oldText[change.fromA] === '\n'
    ) {
      const pair = bCursor + (aRange[0] - aCursor)
      if (pair < newLines.length && newLines[pair] === oldLines[aRange[0]]) {
        aRange[0] += 1
        if (aRange[0] > aRange[1]) aRange = null
      }
    }

    // Identical gap before the change: A and B advance through it together.
    const ctxEnd = aRange ? aRange[0] : lineIndexAt(oldStarts, change.fromA)
    emitContext(aCursor, ctxEnd, bCursor)
    bCursor += Math.max(0, ctxEnd - aCursor)
    aCursor = Math.max(aCursor, ctxEnd)

    if (aRange) {
      for (let i = Math.max(aRange[0], aCursor); i <= aRange[1]; i++) {
        if (i < oldLines.length) {
          rows.push({ kind: 'del', text: oldLines[i], oldNo: i + 1 })
        }
      }
      aCursor = Math.max(aCursor, aRange[1] + 1)
    }
    if (bRange) {
      let j0 = Math.max(bRange[0], bCursor)
      // Mirror of the A-side '\n' check: an identical leading line emits as
      // context. Only valid when it is the very next unconsumed A line —
      // otherwise treat it as an add (never drop content).
      if (j0 === bRange[0] && newText[change.fromB] === '\n') {
        const pair = aCursor + (j0 - bCursor)
        if (
          pair === aCursor &&
          pair < oldLines.length &&
          oldLines[pair] === newLines[j0]
        ) {
          rows.push({
            kind: 'ctx',
            text: newLines[j0],
            oldNo: pair + 1,
            newNo: j0 + 1,
          })
          j0 += 1
          aCursor += 1
        }
      }
      for (let j = j0; j <= bRange[1]; j++) {
        if (j < newLines.length) {
          rows.push({ kind: 'add', text: newLines[j], newNo: j + 1 })
        }
      }
      bCursor = Math.max(bCursor, bRange[1] + 1)
    }
  }

  emitContext(aCursor, oldLines.length, bCursor)
  return rows
}

/** 0-based start offset of every line in `text`. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    starts.push(i + 1)
  }
  return starts
}

/** Line containing `pos` — the greatest index whose start is ≤ `pos`. */
function lineIndexAt(starts: number[], pos: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Does the line containing `pos` survive a zero-width change there? A
 * mid-line insert/delete always rewrites the line; at a line start the line
 * survives iff `other` (the text added on the opposite side) ends on '\n',
 * and at a line end iff `other` starts on '\n'.
 */
function lineIntact(doc: string, pos: number, other: string): boolean {
  const atLineStart = pos === 0 || doc[pos - 1] === '\n'
  const atLineEnd = pos === doc.length || doc[pos] === '\n'
  if (atLineStart && other.endsWith('\n')) return true
  if (atLineEnd && other.startsWith('\n')) return true
  return false
}

/**
 * Lines a char range touches, inclusive — or null for a zero-width range
 * whose containing line is left intact (see `unifiedLines`).
 *
 * A range ending on a '\n' removes a line boundary: when the line that
 * '\n' terminated is only partially consumed (the range started inside
 * it), the next line merges into it and is touched too. When the line was
 * consumed whole the next line is unaffected.
 */
function changedLines(
  starts: number[],
  doc: string,
  from: number,
  to: number,
  intact: boolean,
): LineRange | null {
  if (from === to) {
    if (intact) return null
    const line = lineIndexAt(starts, from)
    return [line, line]
  }
  let last = lineIndexAt(starts, to - 1)
  if (doc[to - 1] === '\n' && from > starts[last]) last += 1
  return [lineIndexAt(starts, from), last]
}
