/**
 * Tests for FileViewer's `isDisplayedFile` — the predicate that decides
 * whether a fetch is a "silent" refresh of the file already on screen or a
 * fresh load.
 *
 * Regression it guards: two workspaces containing the same relative path
 * (e.g. both have `src/main.ts`). Without the workspaceId in the check, a
 * workspace switch was treated as a silent refresh — fetch failures were
 * swallowed (the previous workspace's file stayed displayed with no error)
 * and identical content skipped the rebuild.
 *
 * The component itself mounts a real CodeMirror EditorView, which jsdom
 * can't do (no ResizeObserver / Range.getClientRects), so the decision is
 * extracted and tested here rather than through a rendered component.
 */
import { describe, expect, it } from 'vitest'
import { isDisplayedFile } from './FileViewer'

const loaded = {
  workspaceId: 'ws-1',
  path: 'src/main.ts',
  content: 'const a = 1',
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
