/**
 * Pure trigger/filter/insert logic for the composer's `@file` mention
 * popup (see `features/chat/MentionList.tsx`).
 *
 * Trigger rule: `@` opens a mention when it is NOT preceded by a word
 * character — start of input, after whitespace, or after punctuation like
 * `(` or `"`. An `@` inside a word (`a@b`, `mail@example.com`) never
 * triggers, so typing emails is safe. The query is the run of
 * non-whitespace, non-`@` characters between the `@` and the caret; it
 * may be empty (`@` alone lists everything).
 */
import { fileMentionMarkdown, type FlatFile } from './workspaceFiles'

export interface MentionQuery {
  /** Index of the `@` that triggered the popup. */
  start: number
  /** Text between the `@` and the caret — the live filter. */
  query: string
}

/** Letters/digits/underscore — the chars that make `x@y` a word token. */
const WORD_CHAR = /[\p{L}\p{N}_]/u
const WHITESPACE = /\s/

/**
 * Locate an active `@query` token ending at `cursor`, or null.
 *
 * Scans back from the caret: whitespace before any `@` means the token
 * ended (no mention); an `@` preceded by a word char is mid-token
 * (emails) and also yields null.
 */
export function detectMention(
  text: string,
  cursor: number,
): MentionQuery | null {
  if (cursor <= 0 || cursor > text.length) return null
  let i = cursor - 1
  while (i >= 0) {
    const ch = text[i]
    if (ch === '@') break
    if (WHITESPACE.test(ch)) return null
    i--
  }
  if (i < 0) return null
  if (i > 0 && WORD_CHAR.test(text[i - 1])) return null
  return { start: i, query: text.slice(i + 1, cursor) }
}

/**
 * Filter + rank workspace files for a mention query.
 *
 * Case-insensitive substring match on the path; files whose basename
 * matches outrank path-only matches, and each tier sorts by lowercase
 * path. An empty query returns the first `limit` files in tree order.
 */
export function filterMentionFiles(
  files: readonly FlatFile[],
  query: string,
  limit: number = 50,
): FlatFile[] {
  if (!query) return files.slice(0, limit)
  const q = query.toLowerCase()
  const scored: { file: FlatFile; tier: number }[] = []
  for (const file of files) {
    if (!file.path.toLowerCase().includes(q)) continue
    scored.push({ file, tier: file.name.toLowerCase().includes(q) ? 0 : 1 })
  }
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.file.path.toLowerCase().localeCompare(b.file.path.toLowerCase()),
  )
  return scored.slice(0, limit).map((entry) => entry.file)
}

/**
 * Splice the picked file's `[name](file:path)` link over the `@query`
 * token (from the `@` up to the caret), adding a trailing space — a
 * space already sitting there is absorbed so it never doubles up.
 * Returns the new text and where the caret should land — right after
 * the inserted link.
 */
export function applyMention(
  text: string,
  mention: MentionQuery,
  file: FlatFile,
): { text: string; cursor: number } {
  let end = mention.start + 1 + mention.query.length
  if (text[end] === ' ') end++ // absorb the existing space
  const insert = `${fileMentionMarkdown(file)} `
  return {
    text: text.slice(0, mention.start) + insert + text.slice(end),
    cursor: mention.start + insert.length,
  }
}
