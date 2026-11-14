/**
 * Tests for the ui store's unsaved-edits guards.
 *
 * Every path that would drop the FileViewer's dirty buffer — `openFile` to
 * a different file, `setTab` away from File (unmounts the viewer),
 * `closePanel`, `togglePanel` — asks `globalThis.confirm` first. A missing
 * confirm (node env, odd host) allows the action rather than trapping the
 * user.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUiStore } from './ui'

function seed(overrides: Partial<ReturnType<typeof useUiStore.getState>> = {}) {
  useUiStore.setState({
    rightPanelOpen: true,
    activeTab: 'file',
    filePath: 'src/a.ts',
    line: null,
    terminalTarget: null,
    fileDirty: false,
    openFiles: {},
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

describe('setTab', () => {
  it('blocks leaving the File tab with a dirty buffer when declined', () => {
    stubConfirm(false)
    seed({ fileDirty: true })
    useUiStore.getState().setTab('explorer')
    expect(useUiStore.getState().activeTab).toBe('file')
  })

  it('leaves the File tab when the discard is confirmed', () => {
    stubConfirm(true)
    seed({ fileDirty: true })
    useUiStore.getState().setTab('explorer')
    const s = useUiStore.getState()
    expect(s.activeTab).toBe('explorer')
    expect(s.fileDirty).toBe(false)
  })

  it('switching between non-file tabs never asks', () => {
    const confirm = stubConfirm(false)
    seed({ activeTab: 'explorer' })
    useUiStore.getState().setTab('diff')
    expect(confirm).not.toHaveBeenCalled()
    expect(useUiStore.getState().activeTab).toBe('diff')
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
