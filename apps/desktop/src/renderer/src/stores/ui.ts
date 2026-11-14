/**
 * UI chrome state for the right-hand tool panel.
 *
 * Persisted: panel open state + active tab, per-workspace open file
 * (`openFiles`), per-chat composer drafts (`drafts`), and per-workspace
 * sidebar collapse (`workspaceOpen`) — the continuity set. `filePath`/`line`
 * stay session-only but are repopulated from `openFiles` whenever the
 * workspace context changes (`setWorkspaceContext`), so a stale path from
 * one workspace never surfaces under another's root.
 *
 * `fileDirty` mirrors the FileViewer's unsaved-edits flag so the store can
 * guard the paths that would drop the buffer: `openFile` to a different
 * path, closing the panel, leaving the File tab, and — via
 * `guardWorkspaceSwitch`, called from the chats store — switching
 * workspaces. The buffer itself is never persisted: disk may have drifted,
 * so unsaved edits warn rather than restore.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** Tabs available in the right split panel. */
export type RightPanelTab = 'file' | 'explorer' | 'diff' | 'terminal'

/** A remembered open file for one workspace (path + last line anchor). */
interface OpenFileRef {
  path: string
  line: number | null
}

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
   * Open file per workspace (persisted). Restored into `filePath`/`line` by
   * `setWorkspaceContext` on workspace switch and on app start; updated by
   * `openFile`.
   */
  openFiles: Record<string, OpenFileRef>
  /**
   * Composer draft text per chat (persisted). The Composer reads/writes it
   * instead of holding a local `useState`, so text survives chat switches
   * and restarts; cleared by `send`.
   */
  drafts: Record<string, string>
  /**
   * Sidebar workspace-section collapse state (persisted); a missing key
   * means expanded.
   */
  workspaceOpen: Record<string, boolean>
  /** Workspace the File tab's `openFiles`/`filePath` currently belong to. */
  currentWorkspaceId: string | null
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
  /**
   * Track the workspace the File tab is bound to (called from App when the
   * chats store's active workspace changes and on first load). On change:
   * guards a dirty buffer, stashes the outgoing file ref, and restores the
   * incoming workspace's remembered file.
   */
  setWorkspaceContext: (workspaceId: string | null) => void
  /**
   * Dirty-buffer guard for workspace switching, called by the chats store
   * BEFORE it commits `activeWorkspaceId`. Returns false when the user
   * declines the discard — the caller must abort the switch (the buffer
   * dies either way once the workspace changes).
   */
  guardWorkspaceSwitch: () => boolean
  /** Write (or clear) the composer's draft for a chat. */
  setDraft: (chatId: string, text: string) => void
  /** Toggle a workspace sidebar section's expanded/collapsed state. */
  toggleWorkspaceOpen: (workspaceId: string) => void
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
      openFiles: {},
      drafts: {},
      workspaceOpen: {},
      currentWorkspaceId: null,
      openFile: (path, line) => {
        const { fileDirty, filePath, currentWorkspaceId } = get()
        // Re-selecting the same file never discards the buffer; a different
        // file with unsaved edits must be confirmed away first.
        if (fileDirty && path !== filePath && !confirmDiscard(filePath)) {
          return
        }
        const openFiles = { ...get().openFiles }
        if (currentWorkspaceId) {
          openFiles[currentWorkspaceId] = { path, line: line ?? null }
        }
        set({
          rightPanelOpen: true,
          activeTab: 'file',
          filePath: path,
          line: line ?? null,
          openFiles,
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
      setWorkspaceContext: (workspaceId) => {
        const { currentWorkspaceId, filePath, line, openFiles } = get()
        if (workspaceId === currentWorkspaceId) return
        /* Stash the outgoing file under the old workspace, restore the
         * incoming one (or clear — a new workspace has no remembered file).
         * The dirty flag is simply dropped: the buffer dies on the prop
         * change regardless, and the confirm already ran inside
         * `guardWorkspaceSwitch` before the workspace switched. */
        const stash = { ...openFiles }
        if (currentWorkspaceId && filePath) {
          stash[currentWorkspaceId] = { path: filePath, line }
        }
        const next = workspaceId ? stash[workspaceId] : undefined
        set({
          currentWorkspaceId: workspaceId,
          openFiles: stash,
          filePath: next?.path ?? null,
          line: next?.line ?? null,
          fileDirty: false,
        })
      },
      guardWorkspaceSwitch: () => {
        const { fileDirty, filePath } = get()
        if (!fileDirty) return true
        return confirmDiscard(filePath)
      },
      setDraft: (chatId, text) => {
        const drafts = { ...get().drafts }
        if (text) {
          drafts[chatId] = text
        } else {
          delete drafts[chatId]
        }
        set({ drafts })
      },
      toggleWorkspaceOpen: (workspaceId) =>
        set((s) => ({
          workspaceOpen: {
            ...s.workspaceOpen,
            // Missing key = expanded, so toggling records the inverse.
            [workspaceId]: !(s.workspaceOpen[workspaceId] ?? true),
          },
        })),
    }),
    {
      name: 'pydantic-chat:ui',
      version: 1,
      migrate: (persisted) => {
        /* v0 → v1: panel flag/tab carry over untouched; the new continuity
         * maps default empty. */
        const state = persisted as Partial<
          Pick<
            UiState,
            | 'rightPanelOpen'
            | 'activeTab'
            | 'openFiles'
            | 'drafts'
            | 'workspaceOpen'
          >
        >
        return {
          rightPanelOpen: state.rightPanelOpen ?? false,
          activeTab: state.activeTab ?? 'file',
          openFiles: state.openFiles ?? {},
          drafts: state.drafts ?? {},
          workspaceOpen: state.workspaceOpen ?? {},
        }
      },
      partialize: (s) => ({
        rightPanelOpen: s.rightPanelOpen,
        activeTab: s.activeTab,
        openFiles: s.openFiles,
        drafts: s.drafts,
        workspaceOpen: s.workspaceOpen,
      }),
    },
  ),
)
