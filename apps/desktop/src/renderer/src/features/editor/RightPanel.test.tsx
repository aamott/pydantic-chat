/**
 * RightPanel file-tab tests: the active tab's unsaved-changes dot mirrors
 * `ui.fileDirty` (set by FileViewer's buffer tracking). jsdom can't mount
 * CodeMirror — or ResizeObserver, so the drawer renders in its pinned
 * layout — but the dot lives on the tab button, which renders regardless.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useUiStore } from '../../stores/ui'
import { RightPanel } from './RightPanel'

function seedTab(overrides: Record<string, unknown> = {}): void {
  useUiStore.setState({
    currentWorkspaceId: 'ws-1',
    filePath: 'src/a.ts',
    line: null,
    fileDirty: false,
    drawerOpen: false,
    openTabs: { 'ws-1': [{ path: 'src/a.ts', pinned: false, line: null }] },
    ...overrides,
  })
}

describe('RightPanel active-tab dirty indicator', () => {
  it('shows the dirty dot on the active file tab while modified', () => {
    seedTab({ fileDirty: true })
    render(<RightPanel workspaceId="ws-1" />)
    expect(screen.getByLabelText('Unsaved changes')).toBeTruthy()
  })

  it('hides the dot when the buffer is clean', () => {
    seedTab({ fileDirty: false })
    render(<RightPanel workspaceId="ws-1" />)
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull()
  })

  it('renders preview tabs in italics and pinned tabs plain', () => {
    seedTab({
      fileDirty: false,
      openTabs: {
        'ws-1': [
          { path: 'src/a.ts', pinned: true, line: null },
          { path: 'src/b.ts', pinned: false, line: null },
        ],
      },
      filePath: 'src/b.ts',
    })
    render(<RightPanel workspaceId="ws-1" />)
    expect(screen.getByText('b.ts').className).toContain('italic')
    expect(screen.getByText('a.ts').className).not.toContain('italic')
  })
})
