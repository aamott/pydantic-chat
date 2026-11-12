/**
 * Collapsible card for one `tool-*`/`dynamic-tool` part: name + state badge,
 * expandable body with — when the call carries them — the touched `path` as a
 * file link and a `diff` section (edit_file/write_file), then input/output.
 *
 * Output gets a per-tool renderer for the filesystem tools whose result is a
 * list of file references: grep/search_files matches link `path:line`, and
 * list_files/find_files/list_directory entries link to the file. Everything
 * else keeps the generic JSON dump.
 */
import type { ReactNode } from 'react'
import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import { SquareTerminal, Wrench } from 'lucide-react'
import { fileDiffFromTool } from '../editor/diff'
import { DiffView } from '../editor/DiffView'
import { touchedFileRef, toolName } from '../../lib/toolArgs'
import { useUiStore } from '../../stores/ui'
import {
  Collapsible,
  FileLink,
  KeyValue,
  stringify,
  truncate,
} from './partKit'

const STATE_LABEL: Record<string, string> = {
  'input-streaming': 'calling…',
  'input-available': 'called',
  'approval-requested': 'awaiting approval',
  'approval-responded': 'approval answered',
  'output-available': 'done',
  'output-error': 'failed',
  'output-denied': 'denied',
}

export function ToolCard({
  part,
}: {
  part: ToolUIPart | DynamicToolUIPart
}): React.JSX.Element {
  const state = part.state
  const errored = state === 'output-error' || state === 'output-denied'
  const name = toolName(part)
  const openTerminal = useUiStore((s) => s.openTerminal)
  const input = 'input' in part ? part.input : undefined
  const output = 'output' in part ? part.output : undefined
  const ref = touchedFileRef(name, input)
  const diff = fileDiffFromTool(name, input)
  const renderOutput =
    typeof output === 'string' ? OUTPUT_RENDERERS[name] : undefined

  return (
    <Collapsible
      icon={<Wrench className="h-3.5 w-3.5" />}
      label={name}
      badge={STATE_LABEL[state] ?? state}
      errored={errored}
      // Denied calls open by default: the deny reason is the interesting bit.
      defaultOpen={state === 'input-streaming' || state === 'output-denied'}
    >
      <div className="space-y-2 text-xs">
        {/* The persistent `shell` tool streams `data-shell` phases during
         * execution — jump to this call's live block in the Terminal tab. */}
        {name === 'shell' && (
          <button
            type="button"
            onClick={() => openTerminal(part.toolCallId)}
            className="flex items-center gap-1 text-blue-600 hover:text-blue-700"
          >
            <SquareTerminal className="h-3 w-3" />
            View in Terminal
          </button>
        )}
        {ref && (
          <div>
            <p className="mb-0.5 font-medium text-neutral-500">path</p>
            <FileLink path={ref.path} line={ref.line} />
          </div>
        )}
        {diff && (
          // The diff IS the input's readable form for edit/write calls, so
          // the raw `input` JSON dump is skipped for them below.
          <Collapsible label="diff" muted>
            <DiffView diff={diff} />
          </Collapsible>
        )}
        {input !== undefined && !diff && (
          <KeyValue label="input" value={truncate(stringify(input))} />
        )}
        {output !== undefined &&
          (renderOutput && typeof output === 'string' ? (
            renderOutput(output)
          ) : (
            <KeyValue label="output" value={truncate(stringify(output))} />
          ))}
        {'errorText' in part && part.errorText && (
          <KeyValue label="error" value={part.errorText} error />
        )}
        {'approval' in part && part.approval && (
          <p
            className={
              part.approval.approved === false
                ? 'text-red-600'
                : 'text-neutral-500'
            }
          >
            {part.approval.approved === false ? 'denied' : 'approved'}
            {part.approval.reason ? `: ${part.approval.reason}` : ''}
          </p>
        )}
      </div>
    </Collapsible>
  )
}

/* ------------------------------------------------------------------ */
/* per-tool output renderers (paths → File tab links)                  */
/* ------------------------------------------------------------------ */

const OUTPUT_RENDERERS: Record<string, (output: string) => ReactNode> = {
  grep: renderSearchOutput,
  search_files: renderSearchOutput,
  list_files: renderPathList,
  find_files: renderPathList,
  list_directory: renderDirList,
}

function OutputBlock({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div>
      <p className="mb-0.5 font-medium text-neutral-500">output</p>
      <div className="whitespace-pre-wrap break-words rounded bg-white px-2 py-1.5 font-mono text-neutral-700">
        {children}
      </div>
    </div>
  )
}

/**
 * grep/search_files results: `file:line:text` match lines and `file-line-text`
 * context lines (when the call passed `context`). The path:line prefix links
 * to the File tab; bracketed `[...]` notices and `No matches found.` render
 * plain. Match form is tried first — context lines are rarer.
 */
const GREP_MATCH_RE = /^(.+):(\d+):(.*)$/
const GREP_CONTEXT_RE = /^(.+)-(\d+)-(.*)$/

function renderSearchOutput(output: string): ReactNode {
  return (
    <OutputBlock>
      {truncate(output)
        .split('\n')
        .map((line, i) => {
          const match = GREP_MATCH_RE.exec(line)
          const context = match ? null : GREP_CONTEXT_RE.exec(line)
          const parsed = match ?? context
          if (!parsed) return <div key={i}>{line || ' '}</div>
          return (
            <div key={i}>
              <FileLink path={parsed[1]} line={Number(parsed[2])} />
              {match ? ':' : '-'}
              {parsed[3]}
            </div>
          )
        })}
    </OutputBlock>
  )
}

/**
 * list_files/find_files results: one workspace-relative path per line plus
 * bracketed notices (`[... truncated]`, `[N paths could not be read]`) and
 * the `No … found.` sentences. Directory entries (trailing `/`) and notices
 * render plain — only files link.
 */
const LISTING_NOISE = new Set([
  'No files found.',
  'No matches found.',
  '(empty directory)',
])

function renderPathList(output: string): ReactNode {
  return (
    <OutputBlock>
      {truncate(output)
        .split('\n')
        .map((line, i) => {
          const path = line.trimEnd()
          const isFile =
            path !== '' &&
            !path.endsWith('/') &&
            !path.startsWith('[') &&
            !LISTING_NOISE.has(path)
          return (
            <div key={i}>
              {isFile ? <FileLink path={path} /> : line || ' '}
            </div>
          )
        })}
    </OutputBlock>
  )
}

/**
 * list_directory results: `relpath  (N bytes)` / `relpath  (size unknown)`
 * for files, `relpath/` for dirs, `(empty directory)` + bracketed notices
 * otherwise. Files link; the size note stays visible next to the path.
 */
const DIR_ENTRY_RE = /^(.*?)\s{2}\(([^)]+)\)$/

function renderDirList(output: string): ReactNode {
  return (
    <OutputBlock>
      {truncate(output)
        .split('\n')
        .map((line, i) => {
          const entry = DIR_ENTRY_RE.exec(line)
          if (!entry || !entry[1] || entry[1].endsWith('/')) {
            return <div key={i}>{line || ' '}</div>
          }
          return (
            <div key={i}>
              <FileLink path={entry[1]} />
              <span className="text-neutral-400">  ({entry[2]})</span>
            </div>
          )
        })}
    </OutputBlock>
  )
}
