/**
 * UI chrome state for the right-hand tool panel.
 *
 * Persisted: panel open state + active tab only. `filePath`/`line` are
 * navigation context tied to the active workspace/chat — restoring a stale
 * path across workspaces or restarts would surface the wrong file, so they
 * stay session-only and are repopulated via `openFile` (file links, explorer).
 *
 * `fileDirty` mirrors the FileViewer's unsaved-edits flag so the store can
 * guard the two paths that would drop the buffer: `openFile` to a different
 * path (all file-switch callers funnel through it) and closing the panel
 * (`closePanel`/`togglePanel` unmount the viewer).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** Tabs available in the right split panel. */
export type RightPanelTab = 'file' | 'explorer' | 'diff' | 'terminal'

/**
 * The unsaved-edits guard. `window.confirm` in the Electron renderer opens a
 * native dialog; in non-DOM contexts (vitest node project) there is no
 * confirm, and a guard that can't ask shouldn't trap the user — allow.
 */
function confirmDiscard(filePath: string | null): boolean {
  const message = `Discard unsaved changes to ${filePath ?? 'the open file'}?`
  return globalThis.confirm?.(message) ?? true
}

interface UiState {
  /** Whether the right split panel is visible. */
  rightPanelOpen: boolean
  /** Active tab inside the right panel. */
  activeTab: RightPanelTab
  /** Workspace-relative path shown in the File tab (session-only). */
  filePath: string | null
  /** 1-based line anchor to scroll to in the File tab, or null. */
  line: number | null
  /** Shell tool-call id the Terminal tab should scroll to (session-only). */
  terminalTarget: string | null
  /** True while the FileViewer holds unsaved edits (session-only). */
  fileDirty: boolean
  /**
   * Open the panel on the File tab showing `path`, optionally scrolled to `line`.
   * No-ops when a dirty buffer for a different file isn't confirmed away.
   */
  openFile: (path: string, line?: number) => void
  /** Open the panel on the Terminal tab, scrolled to `toolCallId`'s block. */
  openTerminal: (toolCallId?: string) => void
  /** Clear `terminalTarget` once the Terminal tab has consumed it. */
  clearTerminalTarget: () => void
  /** Hide the right panel; a dirty file buffer must be confirmed away. */
  closePanel: () => void
  /** Flip panel visibility (Ctrl/Cmd+B + toolbar button); guards dirty closes. */
  togglePanel: () => void
  /**
   * Switch the active right-panel tab. Leaving the File tab unmounts the
   * viewer, so a dirty buffer must be confirmed away first.
   */
  setTab: (tab: RightPanelTab) => void
  /** FileViewer's dirty flag — the source for the openFile/close guards. */
  setFileDirty: (dirty: boolean) => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      rightPanelOpen: false,
      activeTab: 'file',
      filePath: null,
      line: null,
      terminalTarget: null,
      fileDirty: false,
      openFile: (path, line) => {
        const { fileDirty, filePath } = get()
        // Re-selecting the same file never discards the buffer; a different
        // file with unsaved edits must be confirmed away first.
        if (fileDirty && path !== filePath && !confirmDiscard(filePath)) {
          return
        }
        set({
          rightPanelOpen: true,
          activeTab: 'file',
          filePath: path,
          line: line ?? null,
          // Same-path re-select keeps the buffer — and its dirty flag; a
          // confirmed switch clears it (the viewer rebuilds and re-marks).
          fileDirty: path === filePath && fileDirty,
        })
      },
      openTerminal: (toolCallId) =>
        set({
          rightPanelOpen: true,
          activeTab: 'terminal',
          terminalTarget: toolCallId ?? null,
        }),
      clearTerminalTarget: () => set({ terminalTarget: null }),
      closePanel: () => {
        if (get().fileDirty && !confirmDiscard(get().filePath)) return
        set({ rightPanelOpen: false, fileDirty: false })
      },
      togglePanel: () => {
        const { rightPanelOpen, fileDirty, filePath } = get()
        if (rightPanelOpen && fileDirty && !confirmDiscard(filePath)) return
        set((s) => ({ rightPanelOpen: !s.rightPanelOpen, fileDirty: false }))
      },
      setTab: (tab) => {
        const { activeTab, fileDirty, filePath } = get()
        if (
          activeTab === 'file' &&
          tab !== 'file' &&
          fileDirty &&
          !confirmDiscard(filePath)
        ) {
          return
        }
        set({ activeTab: tab, fileDirty: false })
      },
      setFileDirty: (dirty) => set({ fileDirty: dirty }),
    }),
    {
      name: 'pydantic-chat:ui',
      partialize: (s) => ({
        rightPanelOpen: s.rightPanelOpen,
        activeTab: s.activeTab,
      }),
    },
  ),
)
