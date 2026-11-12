/**
 * Small shared helpers for reading tool-part args — `part.input` is typed
 * `unknown` by the AI SDK, so every field goes through a guard.
 */
import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import type { FileRef } from './fileRefs'

/** Display name of a tool part: `tool-x` → `x`, `dynamic-tool` → `toolName`. */
export function toolName(part: ToolUIPart | DynamicToolUIPart): string {
  return part.type === 'dynamic-tool'
    ? part.toolName
    : part.type.slice('tool-'.length)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function stringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key]
  return typeof value === 'string' ? value : undefined
}

export function numberField(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = obj[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Tools whose `input.path` is a file worth linking. Search tools (`grep`,
 * `list_files`, …) take a directory/search root instead — their real file
 * refs come through the per-tool output renderers in ToolCard.
 */
const FILE_PATH_TOOLS = new Set(['read_file', 'write_file', 'edit_file'])

/**
 * The file a tool call touches, for the card's clickable `path` row.
 * `read_file`'s 0-based `offset` becomes a 1-based line anchor.
 */
export function touchedFileRef(name: string, input: unknown): FileRef | null {
  if (!FILE_PATH_TOOLS.has(name) || !isRecord(input)) return null
  const path = stringField(input, 'path')
  if (path === undefined) return null
  const offset = numberField(input, 'offset')
  return { path, line: offset !== undefined ? offset + 1 : undefined }
}
