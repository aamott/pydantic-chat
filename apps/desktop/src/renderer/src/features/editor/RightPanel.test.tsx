/**
 * RightPanel tab-strip tests: the File tab's unsaved-changes dot mirrors
 * `ui.fileDirty` (set by FileViewer's buffer tracking). jsdom can't mount
 * CodeMirror, so the File tab body is exercised via its empty state — the
 * dot lives on the tab button, which renders regardless.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useUiStore } from '../../stores/ui'
import { RightPanel } from './RightPanel'

describe('RightPanel File tab dirty indicator', () => {
  it('shows the dirty dot on the File tab while the buffer is modified', () => {
    useUiStore.setState({ filePath: null, fileDirty: true })
    render(<RightPanel workspaceId="ws-1" />)
    expect(screen.getByLabelText('Unsaved changes')).toBeTruthy()
  })

  it('hides the dot when the buffer is clean', () => {
    useUiStore.setState({ filePath: null, fileDirty: false })
    render(<RightPanel workspaceId="ws-1" />)
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull()
  })
})
