/**
 * Typed readers for the app's `data-*` UI parts.
 *
 * The backend (`app/agent/events.py`) bridges capability events into Vercel
 * AI `data-{name}` stream chunks; the AI SDK lands each non-transient chunk
 * on the streamed assistant message as a `DataUIPart` of shape
 * `{type: 'data-{name}', id?: string, data: <payload>}`. Payloads are
 * `unknown` at the type level (`UIMessage` carries no `UIDataTypes`), so every
 * consumer goes through the guards here rather than casting.
 *
 * Wire contracts (verified end-to-end):
 * - `data-plan`     `{change, tasks: [{id, content, status, active_form}]}`
 *                   — one FULL plan snapshot per mutation; the last is current.
 * - `data-shell`    `{phase, tool_call_id, tool_name, command, pid, text,
 *                   exit_code, truncated, line_count, output_path,
 *                   status_path}` — keys always present, null when n/a.
 * - `data-run-meta` `{permission_profile, model}` — once, at stream start.
 *
 * `data-*` parts are stream-only: a reloaded transcript contains none of
 * them, so every reader must tolerate their absence.
 */
import type { UIDataTypes, UIMessage, UIMessagePart, UITools } from 'ai'
import { isRecord } from './toolArgs'

type Part = UIMessagePart<UIDataTypes, UITools>

/* ------------------------------------------------------------------ */
/* payload types                                                       */
/* ------------------------------------------------------------------ */

/** One task inside a `data-plan` snapshot. */
export interface PlanTask {
  id: string
  content: string
  /** `PlanStatus.value`; `pending` | `in_progress` | `completed`. */
  status: string
  /** Present-tense label shown while the task is `in_progress`. */
  active_form: string
}

/** `data-plan` payload — the whole plan, not a diff. */
export interface PlanSnapshot {
  /** `created` | `updated` | `status_changed` | `completed` | `deleted`. */
  change: string
  tasks: PlanTask[]
}

/** `data-shell` payload — one phase of one `shell` tool call. */
export interface ShellPhase {
  phase: 'started' | 'output' | 'finished'
  tool_call_id: string | null
  tool_name: string | null
  command: string | null
  pid: number | null
  text: string | null
  exit_code: number | null
  truncated: boolean | null
  line_count: number | null
  output_path: string | null
  status_path: string | null
}

/** `data-run-meta` payload — effective (post-override) run settings. */
export interface RunMeta {
  permission_profile: string
  /** Full `provider:model` spec, e.g. `anthropic:claude-sonnet-4-5`. */
  model: string
}

/* ------------------------------------------------------------------ */
/* guards                                                              */
/* ------------------------------------------------------------------ */

/** `value` when it is a string, else `null` (payloads use null, not absent). */
function optString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function optNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function optBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export function asPlanSnapshot(data: unknown): PlanSnapshot | null {
  if (!isRecord(data) || typeof data.change !== 'string') return null
  if (!Array.isArray(data.tasks)) return null
  const tasks: PlanTask[] = []
  for (const raw of data.tasks) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== 'string' ||
      typeof raw.content !== 'string' ||
      typeof raw.status !== 'string'
    ) {
      return null
    }
    tasks.push({
      id: raw.id,
      content: raw.content,
      status: raw.status,
      active_form: typeof raw.active_form === 'string' ? raw.active_form : '',
    })
  }
  return { change: data.change, tasks }
}

const SHELL_PHASES = new Set(['started', 'output', 'finished'])

export function asShellPhase(data: unknown): ShellPhase | null {
  if (!isRecord(data)) return null
  const phase = data.phase
  if (typeof phase !== 'string' || !SHELL_PHASES.has(phase)) return null
  return {
    phase: phase as ShellPhase['phase'],
    tool_call_id: optString(data.tool_call_id),
    tool_name: optString(data.tool_name),
    command: optString(data.command),
    pid: optNumber(data.pid),
    text: optString(data.text),
    exit_code: optNumber(data.exit_code),
    truncated: optBool(data.truncated),
    line_count: optNumber(data.line_count),
    output_path: optString(data.output_path),
    status_path: optString(data.status_path),
  }
}

export function asRunMeta(data: unknown): RunMeta | null {
  if (!isRecord(data)) return null
  const permission_profile = optString(data.permission_profile)
  const model = optString(data.model)
  if (permission_profile === null || model === null) return null
  return { permission_profile, model }
}

/* ------------------------------------------------------------------ */
/* message scanning                                                    */
/* ------------------------------------------------------------------ */

/**
 * Every `data-{name}` part's payload across `messages`, in stream order.
 * Malformed payloads are skipped (guard returns null).
 */
export function dataPartsOf<T>(
  messages: UIMessage[],
  name: string,
  guard: (data: unknown) => T | null,
): T[] {
  const type = `data-${name}`
  const out: T[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === type && 'data' in part) {
        const parsed = guard(part.data)
        if (parsed !== null) out.push(parsed)
      }
    }
  }
  return out
}

/** Most recent well-formed `data-{name}` payload, or null when none exists. */
export function latestDataPart<T>(
  messages: UIMessage[],
  name: string,
  guard: (data: unknown) => T | null,
): T | null {
  const type = `data-${name}`
  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const parts = messages[m].parts
    for (let p = parts.length - 1; p >= 0; p -= 1) {
      const part = parts[p]
      if (part.type === type && 'data' in part) {
        const parsed = guard(part.data)
        if (parsed !== null) return parsed
      }
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* shell blocks                                                        */
/* ------------------------------------------------------------------ */

/** One `shell` tool call, accumulated across its `data-shell` phases. */
export interface CommandBlock {
  /** `tool_call_id` — also the lookup key for its tool card. */
  id: string
  toolName: string | null
  command: string | null
  pid: number | null
  output: string
  finished: boolean
  exitCode: number | null
  truncated: boolean | null
  lineCount: number | null
  outputPath: string | null
  statusPath: string | null
}

/**
 * Fold every `data-shell` part in `messages` into per-call blocks.
 * Events missing `tool_call_id` (shouldn't happen — the envelope always
 * carries it, but the field is nullable on the wire) share one block rather
 * than being dropped. `finished` fires when the tool stops waiting, so a
 * detached command reports `exitCode: null`.
 */
export function collectShellBlocks(messages: UIMessage[]): CommandBlock[] {
  const blocks = new Map<string, CommandBlock>()
  for (const phase of dataPartsOf(messages, 'shell', asShellPhase)) {
    const id = phase.tool_call_id ?? 'shell'
    let block = blocks.get(id)
    if (!block) {
      block = {
        id,
        toolName: phase.tool_name,
        command: null,
        pid: null,
        output: '',
        finished: false,
        exitCode: null,
        truncated: null,
        lineCount: null,
        outputPath: null,
        statusPath: null,
      }
      blocks.set(id, block)
    }
    if (phase.tool_name) block.toolName = phase.tool_name
    if (phase.command) block.command = phase.command
    if (phase.pid !== null) block.pid = phase.pid
    if (phase.phase === 'output' && phase.text) block.output += phase.text
    if (phase.phase === 'finished') {
      block.finished = true
      block.exitCode = phase.exit_code
      block.truncated = phase.truncated
      block.lineCount = phase.line_count
      block.outputPath = phase.output_path
      block.statusPath = phase.status_path
    }
  }
  return [...blocks.values()]
}

/* ------------------------------------------------------------------ */
/* transcript shaping                                                  */
/* ------------------------------------------------------------------ */

/**
 * Data parts that never render inline in the transcript: `data-shell` is
 * folded into the matching shell tool card (`collectShellBlocks`) and
 * `data-run-meta` lives in the chat header — as inline cards they'd be one
 * JSON dump per shell output chunk / run.
 */
const HIDDEN_DATA_PARTS = new Set(['data-shell', 'data-run-meta'])

/**
 * The parts a message row actually renders.
 *
 * - `data-shell`/`data-run-meta` are dropped (dedicated surfaces own them).
 * - Every `data-plan` chunk is a full snapshot, so only the LAST one per
 *   message carries live information — earlier snapshots are dropped, and
 *   the survivor keeps its stream position (where the plan last changed).
 */
export function transcriptParts(parts: Part[]): Part[] {
  let lastPlan = -1
  parts.forEach((part, i) => {
    if (part.type === 'data-plan') lastPlan = i
  })
  return parts.filter(
    (part, i) =>
      !HIDDEN_DATA_PARTS.has(part.type) &&
      (part.type !== 'data-plan' || i === lastPlan),
  )
}
