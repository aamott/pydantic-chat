/**
 * Approve/deny cards for tool parts in `state: 'approval-requested'`.
 *
 * The backend emits a `tool-approval-request` stream chunk per deferred call
 * (harness `Permissions` capability), which the SDK folds into the tool
 * part's `approval` object — there is no standalone approval part type.
 * `approval.id` is the toolCallId on this backend. `addToolApprovalResponse`
 * flips the part to `approval-responded` locally; once every pending approval
 * on the last assistant step is answered, `sendAutomaticallyWhen`
 * (`lastAssistantMessageIsCompleteWithApprovalResponses`, lib/transport.ts)
 * resubmits the transcript and the server resumes the run with
 * `deferred_tool_results` extracted from the responded parts. Denials arrive
 * back as `output-denied` parts, rendered by the generic ToolCard.
 *
 * Reloads hydrate the same shape — `GET /api/chats/{id}/messages` dumps
 * still-deferred calls as `approval-requested` — so pending requests keep
 * working Approve/Deny buttons across restarts.
 *
 * The Coder agent routinely defers several calls in one step, so consecutive
 * pending parts render as one card (`groupApprovals` + `ApprovalGroup`).
 */
import { useEffect, useRef, useState } from 'react'
import {
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIDataTypes,
  type UIMessagePart,
  type UITools,
} from 'ai'
import { Check, ShieldQuestion, X } from 'lucide-react'
import { isRecord, stringField, toolName } from '../../lib/toolArgs'
import { extractEdits } from '../editor/diff'
import { useUiStore } from '../../stores/ui'

type Part = UIMessagePart<UIDataTypes, UITools>

/** A tool part narrowed to the pending-approval variant. */
export type PendingApprovalPart = Extract<
  ToolUIPart | DynamicToolUIPart,
  { state: 'approval-requested' }
>

/** Type guard: the part is a tool call waiting on a user approval decision. */
export function isPendingApproval(part: Part): part is PendingApprovalPart {
  return isToolUIPart(part) && part.state === 'approval-requested'
}

/**
 * Signature-compatible subset of `useChat`'s `addToolApprovalResponse`
 * (`ChatAddToolApproveResponseFunction`). `id` is the approval request id —
 * `part.approval.id`, which this backend sets to the tool call id.
 */
export type ApprovalResponder = (response: {
  id: string
  approved: boolean
  reason?: string
}) => void | PromiseLike<void>

/** Chunked render item: a part, or a run of consecutive pending approvals. */
export type PartGroup =
  | { kind: 'part'; part: Part }
  | { kind: 'approvals'; parts: PendingApprovalPart[] }

/**
 * Merge consecutive pending-approval parts into one group so a step that asks
 * for several tools at once renders a single card instead of N disconnected
 * ones. Order is preserved — a part's card never moves.
 */
export function groupApprovals(parts: Part[]): PartGroup[] {
  const groups: PartGroup[] = []
  for (const part of parts) {
    const last = groups[groups.length - 1]
    if (isPendingApproval(part)) {
      if (last?.kind === 'approvals') {
        last.parts.push(part)
      } else {
        groups.push({ kind: 'approvals', parts: [part] })
      }
    } else {
      groups.push({ kind: 'part', part })
    }
  }
  return groups
}

/** Lines of arg preview shown before truncating. */
const PREVIEW_LINE_LIMIT = 8

/** Chars of fallback JSON shown before truncating. */
const JSON_CHAR_LIMIT = 600

export function ApprovalGroup({
  parts,
  onRespond,
  disabled,
}: {
  parts: PendingApprovalPart[]
  onRespond: ApprovalResponder
  disabled?: boolean
}): React.JSX.Element {
  const approveAll = (): void => {
    for (const part of parts) {
      void onRespond({ id: part.approval.id, approved: true })
    }
  }

  return (
    <div className="my-1.5 rounded-md border border-amber-300 bg-amber-50">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-amber-800">
        <ShieldQuestion className="h-3.5 w-3.5 shrink-0" />
        <span>
          {parts.length === 1
            ? 'Approval required'
            : `${parts.length} approvals required`}
        </span>
        {parts.length > 1 && (
          <button
            type="button"
            onClick={approveAll}
            disabled={disabled}
            className="ml-auto shrink-0 rounded bg-emerald-600 px-2 py-0.5 text-[11px] text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Approve all
          </button>
        )}
      </div>
      <div className="space-y-1.5 border-t border-amber-200 p-2">
        {parts.map((part) => (
          <ApprovalRow
            key={part.approval.id}
            part={part}
            onRespond={onRespond}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * One pending request: tool name, arg summary, and Approve/Deny. Deny expands
 * an optional reason field — the reason reaches the model as `ToolDenied`'s
 * message, so it doubles as steering feedback.
 */
function ApprovalRow({
  part,
  onRespond,
  disabled,
}: {
  part: PendingApprovalPart
  onRespond: ApprovalResponder
  disabled?: boolean
}): React.JSX.Element {
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  // Local latch against double clicks — once the SDK applies the response the
  // part flips to `approval-responded` and this row unmounts.
  const [sent, setSent] = useState(false)
  const reasonInputRef = useRef<HTMLInputElement>(null)
  const busy = disabled === true || sent

  // Focus the reason field when it mounts — same UX as `autoFocus` without
  // the attribute (S9379).
  useEffect(() => {
    if (denying) reasonInputRef.current?.focus()
  }, [denying])

  const respond = (approved: boolean): void => {
    if (busy) return
    setSent(true)
    void onRespond({
      id: part.approval.id,
      approved,
      reason: approved ? undefined : reason.trim() || undefined,
    })
  }

  return (
    <div className="rounded border border-amber-200 bg-white p-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-neutral-800">
            {toolName(part)}
          </p>
          <ArgsSummary input={part.input} />
          {part.approval.requestReason && (
            <p className="mt-1 text-[11px] italic text-amber-700">
              {part.approval.requestReason}
            </p>
          )}
        </div>
        {!denying && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => respond(true)}
              disabled={busy}
              className="flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check className="h-3 w-3" />
              Approve
            </button>
            <button
              type="button"
              onClick={() => setDenying(true)}
              disabled={busy}
              className="flex items-center gap-1 rounded bg-red-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="h-3 w-3" />
              Deny
            </button>
          </div>
        )}
      </div>
      {denying && (
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            respond(false)
          }}
        >
          <input
            ref={reasonInputRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setDenying(false)
              }
            }}
            placeholder="Reason for denying (optional)"
            className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-[11px] outline-none focus:border-red-400"
          />
          <button
            type="submit"
            disabled={busy}
            className="shrink-0 rounded bg-red-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => setDenying(false)}
            className="shrink-0 rounded px-1.5 py-1 text-[11px] text-neutral-500 hover:bg-neutral-100"
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* arg summaries                                                       */
/* ------------------------------------------------------------------ */

/**
 * Human-readable preview of the call's `input`: shell tools get the command
 * line, file tools the workspace path (clickable → right panel) plus a
 * content/diff snippet, everything else compact JSON.
 */
function ArgsSummary({ input }: { input: unknown }): React.JSX.Element | null {
  const args = isRecord(input) ? input : null
  if (!args) return null

  const command = stringField(args, 'command')
  if (command !== undefined) {
    return (
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-neutral-900 px-2 py-1.5 font-mono text-[11px] text-neutral-100">
        $ {command}
      </pre>
    )
  }

  const path = stringField(args, 'path')
  if (path !== undefined) {
    return (
      <div className="mt-1 space-y-1">
        <PathLink path={path} />
        <EditPreview input={args} />
      </div>
    )
  }

  return (
    <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-neutral-100 px-2 py-1 font-mono text-[11px] text-neutral-600">
      {truncateJson(args)}
    </pre>
  )
}

/** File path that opens in the right panel's read-only File tab on click. */
function PathLink({ path }: { path: string }): React.JSX.Element {
  const openFile = useUiStore((s) => s.openFile)
  return (
    <button
      type="button"
      onClick={() => openFile(path)}
      title={`Preview ${path}`}
      className="font-mono text-[11px] text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700"
    >
      {path}
    </button>
  )
}

/**
 * What the write/edit will do to `path`: `edit_file` args become a small
 * unified-diff-ish block (first replacement only), `write_file`'s `content`
 * a truncated preview. Anything else renders nothing.
 */
function EditPreview({
  input,
}: {
  input: Record<string, unknown>
}): React.JSX.Element | null {
  const edits = extractEdits(input)
  const replacement = edits[0]
  if (replacement) {
    const extras = edits.length - 1
    return (
      <div className="overflow-hidden rounded border border-neutral-200 font-mono text-[11px]">
        <DiffBlock sign="-" text={replacement.oldText} tone="removed" />
        <DiffBlock sign="+" text={replacement.newText} tone="added" />
        {extras > 0 && (
          <p className="bg-neutral-50 px-2 py-0.5 text-neutral-400">
            +{extras} more {extras === 1 ? 'edit' : 'edits'}
          </p>
        )}
      </div>
    )
  }

  const content = stringField(input, 'content')
  if (content !== undefined) {
    return (
      <pre className="whitespace-pre-wrap break-words rounded border border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-[11px] text-neutral-600">
        {truncateLines(content)}
      </pre>
    )
  }
  return null
}

function DiffBlock({
  sign,
  text,
  tone,
}: {
  sign: '+' | '-'
  text: string
  tone: 'added' | 'removed'
}): React.JSX.Element {
  const toneClass =
    tone === 'added' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
  return (
    <pre
      className={`whitespace-pre-wrap break-words px-2 py-1 ${toneClass}`}
    >
      {truncateLines(text)
        .split('\n')
        .map((line) => `${sign} ${line}`)
        .join('\n')}
    </pre>
  )
}

/* ------------------------------------------------------------------ */
/* input parsing helpers                                               */
/* ------------------------------------------------------------------ */

function truncateLines(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= PREVIEW_LINE_LIMIT) return text
  const kept = lines.slice(0, PREVIEW_LINE_LIMIT).join('\n')
  return `${kept}\n… (${lines.length - PREVIEW_LINE_LIMIT} more lines)`
}

function truncateJson(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  if (text.length > JSON_CHAR_LIMIT) {
    text = `${text.slice(0, JSON_CHAR_LIMIT)}…`
  }
  return truncateLines(text)
}
