/**
 * UI chrome state for the right-hand tool panel.
 *
 * Persisted: panel open state + active tab only. `filePath`/`line` are
 * navigation context tied to the active workspace/chat — restoring a stale
 * path across workspaces or restarts would surface the wrong file, so they
 * stay session-only and are repopulated via `openFile` (file links, explorer).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** Tabs available in the right split panel. */
export type RightPanelTab = 'file' | 'explorer' | 'diff' | 'terminal'

interface UiState {
  /** Whether the right split panel is visible. */
  rightPanelOpen: boolean
  /** Active tab inside the right panel. */
  activeTab: RightPanelTab
  /** Workspace-relative path shown in the File tab (session-only). */
  filePath: string | null
  /** 1-based line anchor to scroll to in the File tab, or null. */
  line: number | null
  /** Open the panel on the File tab showing `path`, optionally scrolled to `line`. */
  openFile: (path: string, line?: number) => void
  /** Hide the right panel. */
  closePanel: () => void
  /** Flip panel visibility (Ctrl/Cmd+B + toolbar button). */
  togglePanel: () => void
  /** Switch the active right-panel tab. */
  setTab: (tab: RightPanelTab) => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      rightPanelOpen: false,
      activeTab: 'file',
      filePath: null,
      line: null,
      openFile: (path, line) =>
        set({
          rightPanelOpen: true,
          activeTab: 'file',
          filePath: path,
          line: line ?? null,
        }),
      closePanel: () => set({ rightPanelOpen: false }),
      togglePanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
      setTab: (tab) => set({ activeTab: tab }),
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
