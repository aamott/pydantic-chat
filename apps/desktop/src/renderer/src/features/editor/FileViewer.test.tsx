/**
 * Tests for FileViewer's extracted pure helpers — `isDisplayedFile` (silent
 * refresh vs fresh load) and `refetchOutcome` (what a completed fetch does
 * to the buffer, including the dirty-drift case).
 *
 * Regression `isDisplayedFile` guards: two workspaces containing the same
 * relative path (e.g. both have `src/main.ts`). Without the workspaceId in
 * the check, a workspace switch was treated as a silent refresh — fetch
 * failures were swallowed (the previous workspace's file stayed displayed
 * with no error) and identical content skipped the rebuild.
 *
 * `refetchOutcome` guards the writable-viewer invariant: a focus refetch
 * must never clobber unsaved edits — disk drift under a dirty buffer keeps
 * the buffer and flags the header instead.
 *
 * The component itself mounts a real CodeMirror EditorView, which jsdom
 * can't do (no ResizeObserver / Range.getClientRects), so the decisions are
 * extracted and tested here rather than through a rendered component.
 *
 * `viewerModeFor` guards the kind → branch mapping: the backend's `kind`
 * decides image/binary, markdown is the only text sub-mode (language hint
 * first, `.md`/`.markdown` extension as the older-backend fallback).
 */
import { describe, expect, it } from 'vitest'
import {
  isDisplayedFile,
  refetchOutcome,
  viewerModeFor,
  type LoadedFile,
} from './FileViewer'

const loaded: LoadedFile = {
  workspaceId: 'ws-1',
  path: 'src/main.ts',
  content: 'const a = 1',
  version: 'v1',
}

describe('isDisplayedFile', () => {
  it('is true for the same workspace + path → silent refresh', () => {
    // Silent: a failed focus refetch keeps the stale view on screen, and
    // identical content skips the editor rebuild.
    expect(isDisplayedFile(loaded, 'ws-1', 'src/main.ts')).toBe(true)
  })

  it('is false for a different workspace + same path → fresh load', () => {
    // Not silent: a fetch failure surfaces an error instead of leaving the
    // previous workspace's file displayed.
    expect(isDisplayedFile(loaded, 'ws-2', 'src/main.ts')).toBe(false)
  })

  it('blocks the identical-content early return across a workspace switch', () => {
    // The early return requires isDisplayedFile AND identical content; the
    // workspace switch fails the first gate, so identical content in the
    // new workspace still rebuilds the editor.
    const identical = { ...loaded } // same path + same content, ws-1
    expect(isDisplayedFile(identical, 'ws-2', 'src/main.ts')).toBe(false)
  })

  it('is false for a different path in the same workspace', () => {
    expect(isDisplayedFile(loaded, 'ws-1', 'src/other.ts')).toBe(false)
  })

  it('is false when nothing is loaded yet', () => {
    expect(isDisplayedFile(null, 'ws-1', 'src/main.ts')).toBe(false)
  })
})

describe('refetchOutcome', () => {
  it('rebuilds for a different file', () => {
    expect(
      refetchOutcome(loaded, 'ws-1', 'src/other.ts', 'x', false),
    ).toBe('rebuild')
    expect(refetchOutcome(null, 'ws-1', 'src/main.ts', 'x', false)).toBe(
      'rebuild',
    )
  })

  it('keeps the view on identical content (clean or dirty)', () => {
    // Dirty buffers stay dirty — identical disk content touches nothing.
    expect(
      refetchOutcome(loaded, 'ws-1', 'src/main.ts', 'const a = 1', false),
    ).toBe('keep')
    expect(
      refetchOutcome(loaded, 'ws-1', 'src/main.ts', 'const a = 1', true),
    ).toBe('keep')
  })

  it('rebuilds a clean buffer when the disk copy moved', () => {
    expect(
      refetchOutcome(loaded, 'ws-1', 'src/main.ts', 'const a = 2', false),
    ).toBe('rebuild')
  })

  it('keeps a dirty buffer when the disk copy moved → drift flag', () => {
    // The core writable-viewer guard: an agent/external write under an open
    // dirty buffer must not clobber the user's edits; the stale version
    // stays so the next save still 409s.
    expect(
      refetchOutcome(loaded, 'ws-1', 'src/main.ts', 'const a = 2', true),
    ).toBe('drift')
  })
})

describe('viewerModeFor', () => {
  it('routes non-text kinds to their own branches', () => {
    expect(viewerModeFor('image', null, 'pic.png')).toBe('image')
    expect(viewerModeFor('binary', null, 'blob.bin')).toBe('binary')
    // kind wins over the language hint — a binary never reaches the editor.
    expect(viewerModeFor('binary', 'python', 'x.py')).toBe('binary')
    expect(viewerModeFor('image', 'markdown', 'x.svg')).toBe('image')
  })

  it('routes text kinds to editor or markdown', () => {
    expect(viewerModeFor('text', 'typescript', 'src/main.ts')).toBe('editor')
    expect(viewerModeFor('text', null, 'data.xyz')).toBe('editor')
    expect(viewerModeFor('text', 'markdown', 'README.md')).toBe('markdown')
  })

  it('falls back to the .md/.markdown extension without a hint', () => {
    for (const p of ['a.md', 'a.MD', 'docs/guide.markdown']) {
      expect(viewerModeFor('text', null, p), p).toBe('markdown')
    }
    // Lookalikes stay plain editor files.
    expect(viewerModeFor('text', null, 'a.mdx')).toBe('editor')
    expect(viewerModeFor('text', null, 'a.md.txt')).toBe('editor')
  })
})
