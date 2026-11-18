/**
 * Tests for the ui store's file-tab model and unsaved-edits guards.
 *
 * Every path that would drop the FileViewer's dirty buffer — `openFile` or
 * `activateTab` to a different file, `closeTab` on the active tab,
 * `closePanel`, `togglePanel` — asks `globalThis.confirm` first. A missing
 * confirm (node env, odd host) allows the action rather than trapping the
 * user.
 *
 * The tab model itself: picks open preview tabs (one unpinned slot reused
 * per selection), pinning frees the slot, and editing a buffer pins its
 * tab via `setFileDirty`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUiStore } from './ui'

function seed(overrides: Partial<ReturnType<typeof useUiStore.getState>> = {}) {
  useUiStore.setState({
    rightPanelOpen: true,
    filePath: 'src/a.ts',
    line: null,
    fileDirty: false,
    openFiles: {},
    openTabs: {},
    drawerView: 'explorer',
    drawerOpen: false,
    drawerPinned: true,
    drafts: {},
    workspaceOpen: {},
    currentWorkspaceId: 'ws-1',
    ...overrides,
  })
}

function stubConfirm(result: boolean) {
  const confirm = vi.fn(() => result)
  vi.stubGlobal('confirm', confirm)
  return confirm
}

beforeEach(() => {
  vi.unstubAllGlobals()
  seed()
})

describe('openFile', () => {
  it('blocks a switch to a different file when the discard is declined', () => {
    const confirm = stubConfirm(false)
    seed({ fileDirty: true })
    useUiStore.getState().openFile('src/b.ts')
    const s = useUiStore.getState()
    expect(confirm).toHaveBeenCalledOnce()
    expect(s.filePath).toBe('src/a.ts')
    expect(s.fileDirty).toBe(true)
  })

  it('switches and clears dirty when the discard is confirmed', () => {
    stubConfirm(true)
    seed({ fileDirty: true })
    useUiStore.getState().openFile('src/b.ts')
    const s = useUiStore.getState()
    expect(s.filePath).toBe('src/b.ts')
    expect(s.fileDirty).toBe(false)
  })

  it('re-selecting the same file never asks (buffer is kept)', () => {
    const confirm = stubConfirm(false)
    seed({ fileDirty: true })
    useUiStore.getState().openFile('src/a.ts', 42)
    const s = useUiStore.getState()
    expect(confirm).not.toHaveBeenCalled()
    expect(s.line).toBe(42)
    // The buffer — and its dirty flag — survives a same-path re-select.
    expect(s.fileDirty).toBe(true)
  })

  it('a clean buffer switches without asking', () => {
    const confirm = stubConfirm(false)
    useUiStore.getState().openFile('src/b.ts')
    expect(confirm).not.toHaveBeenCalled()
    expect(useUiStore.getState().filePath).toBe('src/b.ts')
  })
})

describe('preview tabs', () => {
  it('openFile creates a single preview tab reused by the next pick', () => {
    useUiStore.getState().openFile('src/b.ts')
    useUiStore.getState().openFile('src/c.ts')
    const s = useUiStore.getState()
    // The unpinned slot is replaced — one tab total, now c.ts.
    expect(s.openTabs['ws-1']).toEqual([
      { path: 'src/c.ts', pinned: false, line: null },
    ])
    expect(s.filePath).toBe('src/c.ts')
  })

  it('re-opening an existing tab reuses it instead of the preview slot', () => {
    seed({
      openTabs: {
        'ws-1': [
          { path: 'src/a.ts', pinned: true, line: null },
          { path: 'src/b.ts', pinned: false, line: null },
        ],
      },
    })
    useUiStore.getState().openFile('src/a.ts')
    expect(useUiStore.getState().openTabs['ws-1']).toHaveLength(2)
  })

  it('a pinned tab frees the preview slot — the next pick appends', () => {
    useUiStore.getState().openFile('src/b.ts')
    useUiStore.getState().pinTab('src/b.ts')
    useUiStore.getState().openFile('src/c.ts')
    expect(useUiStore.getState().openTabs['ws-1']).toEqual([
      { path: 'src/b.ts', pinned: true, line: null },
      { path: 'src/c.ts', pinned: false, line: null },
    ])
  })

  it('marking the buffer dirty pins the active tab', () => {
    useUiStore.getState().openFile('src/b.ts')
    useUiStore.getState().setFileDirty(true)
    expect(useUiStore.getState().openTabs['ws-1']).toEqual([
      { path: 'src/b.ts', pinned: true, line: null },
    ])
    // Clearing dirty (save) does NOT un-pin.
    useUiStore.getState().setFileDirty(false)
    expect(useUiStore.getState().openTabs['ws-1']?.[0].pinned).toBe(true)
  })
})

describe('activateTab', () => {
  const tabs = {
    'ws-1': [
      { path: 'src/a.ts', pinned: true, line: 10 },
      { path: 'src/b.ts', pinned: false, line: null },
    ],
  }

  it('blocks a switch with a dirty buffer when the discard is declined', () => {
    stubConfirm(false)
    seed({ fileDirty: true, openTabs: tabs })
    useUiStore.getState().activateTab('src/b.ts')
    const s = useUiStore.getState()
    expect(s.filePath).toBe('src/a.ts')
    expect(s.fileDirty).toBe(true)
  })

  it('switches (restoring the tab line) when the discard is confirmed', () => {
    stubConfirm(true)
    seed({ fileDirty: true, openTabs: tabs })
    useUiStore.getState().activateTab('src/b.ts')
    const s = useUiStore.getState()
    expect(s.filePath).toBe('src/b.ts')
    expect(s.fileDirty).toBe(false)
    expect(s.openFiles['ws-1']).toEqual({ path: 'src/b.ts', line: null })
  })

  it('restores the tab\'s remembered line', () => {
    seed({ filePath: 'src/b.ts', openTabs: tabs })
    useUiStore.getState().activateTab('src/a.ts')
    expect(useUiStore.getState().line).toBe(10)
  })

  it('activating the current tab is a no-op (buffer kept)', () => {
    const confirm = stubConfirm(false)
    seed({ fileDirty: true, openTabs: tabs })
    useUiStore.getState().activateTab('src/a.ts')
    expect(confirm).not.toHaveBeenCalled()
    expect(useUiStore.getState().fileDirty).toBe(true)
  })
})

describe('closeTab', () => {
  const tabs = {
    'ws-1': [
      { path: 'src/a.ts', pinned: true, line: null },
      { path: 'src/b.ts', pinned: false, line: null },
    ],
  }

  it('removes a non-active tab without touching the buffer', () => {
    seed({ fileDirty: true, openTabs: tabs })
    useUiStore.getState().closeTab('src/b.ts')
    const s = useUiStore.getState()
    expect(s.openTabs['ws-1']).toHaveLength(1)
    expect(s.filePath).toBe('src/a.ts')
    expect(s.fileDirty).toBe(true)
  })

  it('closing the active dirty tab asks first and honors a decline', () => {
    stubConfirm(false)
    seed({ fileDirty: true, openTabs: tabs })
    useUiStore.getState().closeTab('src/a.ts')
    expect(useUiStore.getState().openTabs['ws-1']).toHaveLength(2)
  })

  it('closing the active tab activates its neighbor', () => {
    seed({ openTabs: tabs })
    useUiStore.getState().closeTab('src/a.ts')
    const s = useUiStore.getState()
    expect(s.filePath).toBe('src/b.ts')
    expect(s.openFiles['ws-1']).toEqual({ path: 'src/b.ts', line: null })
  })

  it('closing the last tab clears the view', () => {
    seed({ openTabs: { 'ws-1': [{ path: 'src/a.ts', pinned: false, line: 5 }] } })
    useUiStore.getState().closeTab('src/a.ts')
    const s = useUiStore.getState()
    expect(s.filePath).toBeNull()
    expect(s.line).toBeNull()
    expect(s.openFiles['ws-1']).toBeUndefined()
  })
})

describe('closePanel / togglePanel', () => {
  it('closePanel keeps the panel open when the discard is declined', () => {
    stubConfirm(false)
    seed({ fileDirty: true })
    useUiStore.getState().closePanel()
    expect(useUiStore.getState().rightPanelOpen).toBe(true)
  })

  it('closePanel closes when the discard is confirmed', () => {
    stubConfirm(true)
    seed({ fileDirty: true })
    useUiStore.getState().closePanel()
    const s = useUiStore.getState()
    expect(s.rightPanelOpen).toBe(false)
    expect(s.fileDirty).toBe(false)
  })

  it('togglePanel guards only the closing direction', () => {
    const confirm = stubConfirm(false)
    seed({ fileDirty: true })
    useUiStore.getState().togglePanel() // open → stays open
    expect(useUiStore.getState().rightPanelOpen).toBe(true)
    seed({ rightPanelOpen: false, fileDirty: true })
    useUiStore.getState().togglePanel() // closed → opens without asking
    expect(confirm).toHaveBeenCalledTimes(1) // only the close asked
    expect(useUiStore.getState().rightPanelOpen).toBe(true)
  })
})

describe('drawer', () => {
  it('toggleDrawer flips the overlay flag or the pinned preference', () => {
    useUiStore.getState().toggleDrawer(true)
    expect(useUiStore.getState().drawerOpen).toBe(true)
    expect(useUiStore.getState().drawerPinned).toBe(true)
    useUiStore.getState().toggleDrawer(false)
    expect(useUiStore.getState().drawerPinned).toBe(false)
    expect(useUiStore.getState().drawerOpen).toBe(true)
  })

  it('setDrawerView selects the hosted view', () => {
    useUiStore.getState().setDrawerView('diff')
    expect(useUiStore.getState().drawerView).toBe('diff')
  })
})

describe('openFiles per-workspace map', () => {
  it('openFile records the file under the current workspace', () => {
    useUiStore.getState().openFile('src/b.ts', 10)
    const s = useUiStore.getState()
    expect(s.openFiles['ws-1']).toEqual({ path: 'src/b.ts', line: 10 })
  })

  it('setWorkspaceContext stashes the outgoing file and restores the incoming one', () => {
    seed({
      filePath: 'ws1-file.ts',
      line: 7,
      openFiles: { 'ws-2': { path: 'ws2-file.ts', line: 3 } },
    })
    useUiStore.getState().setWorkspaceContext('ws-2')
    const s = useUiStore.getState()
    expect(s.filePath).toBe('ws2-file.ts')
    expect(s.line).toBe(3)
    // Outgoing file stashed back under ws-1.
    expect(s.openFiles['ws-1']).toEqual({ path: 'ws1-file.ts', line: 7 })
    expect(s.currentWorkspaceId).toBe('ws-2')
  })

  it('setWorkspaceContext to a workspace with no remembered file clears the view', () => {
    useUiStore.getState().setWorkspaceContext('ws-2')
    const s = useUiStore.getState()
    expect(s.filePath).toBeNull()
    expect(s.line).toBeNull()
    expect(s.openFiles['ws-1']).toEqual({ path: 'src/a.ts', line: null })
  })

  it('setWorkspaceContext drops the dirty flag (guard ran earlier in the switch path)', () => {
    seed({ fileDirty: true })
    useUiStore.getState().setWorkspaceContext('ws-2')
    expect(useUiStore.getState().fileDirty).toBe(false)
  })

  it('a same-workspace call is a no-op', () => {
    useUiStore.getState().setWorkspaceContext('ws-1')
    expect(useUiStore.getState().filePath).toBe('src/a.ts')
  })
})

describe('guardWorkspaceSwitch', () => {
  it('allows a switch with a clean buffer without asking', () => {
    const confirm = stubConfirm(false)
    expect(useUiStore.getState().guardWorkspaceSwitch()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks on a dirty buffer and honors the answer', () => {
    stubConfirm(false)
    seed({ fileDirty: true })
    expect(useUiStore.getState().guardWorkspaceSwitch()).toBe(false)
    vi.unstubAllGlobals()
    stubConfirm(true)
    expect(useUiStore.getState().guardWorkspaceSwitch()).toBe(true)
  })
})

describe('drafts', () => {
  it('setDraft stores and clears per-chat text', () => {
    const s = useUiStore.getState()
    s.setDraft('chat-1', 'hello')
    s.setDraft('chat-2', 'other')
    expect(useUiStore.getState().drafts).toEqual({
      'chat-1': 'hello',
      'chat-2': 'other',
    })
    // Empty text removes the key rather than leaving '' entries behind.
    s.setDraft('chat-1', '')
    expect(useUiStore.getState().drafts).toEqual({ 'chat-2': 'other' })
  })
})

describe('workspaceOpen', () => {
  it('defaults to expanded and toggles persist per workspace', () => {
    expect(useUiStore.getState().workspaceOpen['ws-1']).toBeUndefined()
    useUiStore.getState().toggleWorkspaceOpen('ws-1')
    expect(useUiStore.getState().workspaceOpen['ws-1']).toBe(false)
    useUiStore.getState().toggleWorkspaceOpen('ws-1')
    expect(useUiStore.getState().workspaceOpen['ws-1']).toBe(true)
  })
})
