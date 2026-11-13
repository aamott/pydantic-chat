/**
 * Unit tests for `lib/mentions.ts` — the pure trigger/filter/insert logic
 * behind the composer's `@file` mention popup.
 *
 * Trigger rule (pinned here): `@` opens a mention query when it is NOT
 * preceded by a word character — i.e. at the start of the input, after
 * whitespace, or after punctuation like `(` or `"`. An `@` inside a word
 * (`a@b`, `mail@example.com`) never triggers, so typing emails is safe.
 * The query runs from the `@` to the caret and may contain anything but
 * whitespace or another `@`.
 */
import { describe, expect, it } from 'vitest'
import { applyMention, detectMention, filterMentionFiles } from './mentions'
import { fileMentionMarkdown, type FlatFile } from './workspaceFiles'

const FILES: FlatFile[] = [
  { name: 'fileRefs.ts', path: 'src/lib/fileRefs.ts' },
  { name: 'api.ts', path: 'src/lib/api.ts' },
  { name: 'Composer.tsx', path: 'src/features/chat/Composer.tsx' },
  { name: 'App.tsx', path: 'src/App.tsx' },
  { name: 'README.md', path: 'README.md' },
]

describe('detectMention', () => {
  it('triggers on a lone @ at the start of input', () => {
    expect(detectMention('@', 1)).toEqual({ start: 0, query: '' })
  })

  it('triggers at the start of input with a query', () => {
    expect(detectMention('@sr', 3)).toEqual({ start: 0, query: 'sr' })
  })

  it('triggers after a space', () => {
    expect(detectMention('check @fil', 10)).toEqual({ start: 6, query: 'fil' })
  })

  it('triggers after a newline or tab', () => {
    expect(detectMention('one\n@ab', 7)).toEqual({ start: 4, query: 'ab' })
    expect(detectMention('one\t@ab', 7)).toEqual({ start: 4, query: 'ab' })
  })

  it('triggers after punctuation (non-word boundary)', () => {
    expect(detectMention('see (@app', 9)).toEqual({ start: 5, query: 'app' })
    expect(detectMention('"@x', 3)).toEqual({ start: 1, query: 'x' })
  })

  it('does not trigger inside an email-like token', () => {
    expect(detectMention('a@b', 3)).toBeNull()
    expect(detectMention('mail me@example.com please', 17)).toBeNull()
    expect(detectMention('foo@', 4)).toBeNull()
  })

  it('does not trigger on a second @ inside a query token', () => {
    expect(detectMention('@x@y', 3)).toBeNull()
    expect(detectMention('a @b@c', 6)).toBeNull()
  })

  it('uses the text up to the caret as the query (mid-text caret)', () => {
    // Caret sits right after `@fo` in the middle of a longer message.
    expect(detectMention('see @foo and more', 8)).toEqual({
      start: 4,
      query: 'foo',
    })
    expect(detectMention('@foo bar', 2)).toEqual({ start: 0, query: 'f' })
  })

  it('does not trigger when the caret is before or at the @', () => {
    expect(detectMention('@foo', 0)).toBeNull()
    expect(detectMention('a @foo', 2)).toBeNull()
  })

  it('does not trigger once the query token ends', () => {
    // Whitespace after the token closes the mention — caret beyond it.
    expect(detectMention('@foo ', 5)).toBeNull()
    expect(detectMention('@foo bar', 8)).toBeNull()
  })

  it('does not trigger on an empty string or out-of-range caret', () => {
    expect(detectMention('', 0)).toBeNull()
    expect(detectMention('abc', 10)).toBeNull()
  })
})

describe('filterMentionFiles', () => {
  it('returns the first `limit` files in order for an empty query', () => {
    expect(filterMentionFiles(FILES, '', 3)).toEqual(FILES.slice(0, 3))
  })

  it('matches case-insensitively against the path', () => {
    const hits = filterMentionFiles(FILES, 'COMPOSER')
    expect(hits).toEqual([
      { name: 'Composer.tsx', path: 'src/features/chat/Composer.tsx' },
    ])
  })

  it('ranks basename matches above directory-only matches', () => {
    // 'app' matches the basename of App.tsx but only a directory
    // ('src/api.ts' has no 'app'… pick a real split):
    const files: FlatFile[] = [
      { name: 'x.ts', path: 'src/apple/x.ts' }, // 'apple' only in a dir
      { name: 'apple.ts', path: 'z/apple.ts' }, // basename match
    ]
    expect(filterMentionFiles(files, 'apple')).toEqual([
      files[1],
      files[0],
    ])
  })

  it('sorts within a tier by lowercase path', () => {
    const hits = filterMentionFiles(FILES, 'src')
    expect(hits.map((f) => f.path)).toEqual([
      'src/App.tsx',
      'src/features/chat/Composer.tsx',
      'src/lib/api.ts',
      'src/lib/fileRefs.ts',
    ])
  })

  it('excludes non-matches and respects the limit', () => {
    expect(filterMentionFiles(FILES, 'zzz')).toEqual([])
    const hits = filterMentionFiles(FILES, 'src', 2)
    expect(hits).toHaveLength(2)
  })
})

describe('fileMentionMarkdown', () => {
  it('builds the same [name](file:path) link the attach picker inserts', () => {
    expect(fileMentionMarkdown({ name: 'x.ts', path: 'src/x.ts' })).toBe(
      '[x.ts](file:src/x.ts)',
    )
  })
})

describe('applyMention', () => {
  it('replaces the @query token in place and lands the caret after the link', () => {
    const file = { name: 'api.ts', path: 'src/lib/api.ts' }
    const result = applyMention('check @api now', { start: 6, query: 'api' }, file)
    const insert = '[api.ts](file:src/lib/api.ts) '
    expect(result.text).toBe(`check ${insert}now`)
    expect(result.cursor).toBe(6 + insert.length)
    // Invariant: the caret always sits right after the inserted text.
    expect(result.text.slice(0, result.cursor)).toBe(`check ${insert}`)
  })

  it('replaces from the @ up to the caret only (mid-token caret)', () => {
    // Caret was mid-token when the file was picked: `|@fo|o` — only the
    // typed `@fo` is replaced; the trailing `o` stays.
    const file = { name: 'b.ts', path: 'b.ts' }
    const result = applyMention('@foo bar', { start: 0, query: 'f' }, file)
    expect(result.text).toBe('[b.ts](file:b.ts) oo bar')
  })

  it('works at the very start of the input', () => {
    const file = { name: 'README.md', path: 'README.md' }
    const result = applyMention('@re', { start: 0, query: 're' }, file)
    expect(result.text).toBe('[README.md](file:README.md) ')
    expect(result.cursor).toBe(result.text.length)
  })
})
