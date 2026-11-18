/**
 * UI chrome state for the right-hand tool panel.
 *
 * Persisted: panel open state, per-workspace file tabs (`openTabs`) plus
 * the remembered active file (`openFiles`), the drawer's pinned
 * preference (`drawerPinned`), per-chat composer drafts (`drafts`), and
 * per-workspace sidebar collapse (`workspaceOpen`) — the continuity set.
 * `filePath`/`line` stay session-only but are repopulated from `openFiles`
 * whenever the workspace context changes (`setWorkspaceContext`), so a
 * stale path from one workspace never surfaces under another's root.
 * Drawer overlay open-state and `drawerView` are session-only.
 *
 * Tab model: each workspace owns an ordered `FileTab[]`. Picks (explorer
 * clicks, `file:` links) open *preview* tabs — a single unpinned slot,
 * reused per selection and rendered italic in the strip; editing the
 * buffer or double-clicking the tab pins it into a permanent slot.
 *
 * `fileDirty` mirrors the FileViewer's unsaved-edits flag so the store can
 * guard the paths that would drop the buffer: `openFile`/`activateTab` to
 * a different path, `closeTab` on the active tab, closing the panel, and
 * — via `guardWorkspaceSwitch`, called from the chats store — switching
 * workspaces. PROTOTYPE simplification: a single FileViewer buffer serves
 * whichever tab is active, so the dirty flag is per-active-tab only and
 * switching away discards the buffer (confirmed first). The buffer itself
 * is never persisted: disk may have drifted, so unsaved edits warn rather
 * than restore.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** Views the right panel's left-edge drawer can host. */
export type DrawerView = 'explorer' | 'diff'

/** One file tab in the right panel's tab strip. */
export interface FileTab {
  /** Workspace-relative path, as opened by `openFile`. */
  path: string
  /**
   * Pinned tabs are permanent slots. The single unpinned slot is the
   * preview tab — replaced by the next pick until editing or a
   * double-click pins it.
   */
  pinned: boolean
  /** Last `#L<n>` line anchor this tab was opened with, or null. */
  line: number | null
}

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

/**
 * Add `path` to `tabs` preview-style: an existing tab is reused (and its
 * line updated), else the single unpinned slot is replaced, else a new
 * preview tab is appended. Returns a new array.
 */
function upsertPreviewTab(
  tabs: readonly FileTab[],
  path: string,
  line: number | null,
): FileTab[] {
  const existing = tabs.findIndex((t) => t.path === path)
  if (existing >= 0) {
    const next = [...tabs]
    next[existing] = { ...next[existing], line }
    return next
  }
  const previewIdx = tabs.findIndex((t) => !t.pinned)
  const tab: FileTab = { path, pinned: false, line }
  if (previewIdx >= 0) {
    const next = [...tabs]
    next[previewIdx] = tab
    return next
  }
  return [...tabs, tab]
}

interface UiState {
  /** Whether the right split panel is visible. */
  rightPanelOpen: boolean
  /** Workspace-relative path of the active file tab (session-only). */
  filePath: string | null
  /** 1-based line anchor to scroll to in the FileViewer, or null. */
  line: number | null
  /** True while the FileViewer holds unsaved edits (session-only). */
  fileDirty: boolean
  /**
   * Active file per workspace (persisted). Restored into `filePath`/`line`
   * by `setWorkspaceContext` on workspace switch and on app start; updated
   * by `openFile`/`activateTab`/`closeTab`.
   */
  openFiles: Record<string, OpenFileRef>
  /**
   * File tabs per workspace (persisted); `filePath` names the active one.
   * The single unpinned entry is the preview slot.
   */
  openTabs: Record<string, FileTab[]>
  /** Selected drawer view (session-only). */
  drawerView: DrawerView
  /** Overlay-mode drawer open state — session-only, used below the width
   *  breakpoint where the drawer floats over the editor. */
  drawerOpen: boolean
  /** Pinned-mode drawer preference (persisted) — above the breakpoint the
   *  drawer sits beside the editor until toggled. */
  drawerPinned: boolean
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
  /** Workspace `openTabs`/`openFiles`/`filePath` currently belong to. */
  currentWorkspaceId: string | null
  /**
   * Open the panel showing `path`, optionally scrolled to `line`. Creates
   * (or reuses the) preview tab; no-ops when a dirty buffer for a
   * different file isn't confirmed away.
   */
  openFile: (path: string, line?: number) => void
  /**
   * Make an existing tab active — same dirty-buffer guard as `openFile`,
   * since the single viewer buffer is dropped on the switch.
   */
  activateTab: (path: string) => void
  /**
   * Remove a tab. Closing the active tab moves activation to a neighbor
   * (or clears the view); a dirty active tab asks first.
   */
  closeTab: (path: string) => void
  /** Pin a preview tab into a permanent slot (double-click affordance). */
  pinTab: (path: string) => void
  /** Hide the right panel; a dirty file buffer must be confirmed away. */
  closePanel: () => void
  /** Flip panel visibility (Ctrl/Cmd+B + toolbar button); guards dirty closes. */
  togglePanel: () => void
  /**
   * Flip the drawer's open state. `overlay` picks which flag flips: the
   * session-only overlay open-state at narrow widths, the persisted
   * pinned preference at wide ones (the panel passes what its
   * ResizeObserver measured).
   */
  toggleDrawer: (overlay: boolean) => void
  /** Set the overlay drawer's open state directly (scrim/Esc/select). */
  setDrawerOpen: (open: boolean) => void
  /** Select which view the drawer hosts. */
  setDrawerView: (view: DrawerView) => void
  /** FileViewer's dirty flag — the source for the open/close guards. */
  setFileDirty: (dirty: boolean) => void
  /**
   * Track the workspace the file tabs are bound to (called from App when
   * the chats store's active workspace changes and on first load). On
   * change: guards a dirty buffer, stashes the outgoing file ref, and
   * restores the incoming workspace's remembered file.
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
      filePath: null,
      line: null,
      fileDirty: false,
      openFiles: {},
      openTabs: {},
      drawerView: 'explorer',
      drawerOpen: false,
      drawerPinned: true,
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
        const openTabs = { ...get().openTabs }
        if (currentWorkspaceId) {
          openFiles[currentWorkspaceId] = { path, line: line ?? null }
          openTabs[currentWorkspaceId] = upsertPreviewTab(
            openTabs[currentWorkspaceId] ?? [],
            path,
            line ?? null,
          )
        }
        set({
          rightPanelOpen: true,
          filePath: path,
          line: line ?? null,
          openFiles,
          openTabs,
          // Same-path re-select keeps the buffer — and its dirty flag; a
          // confirmed switch clears it (the viewer rebuilds and re-marks).
          fileDirty: path === filePath && fileDirty,
        })
      },
      activateTab: (path) => {
        const { fileDirty, filePath, currentWorkspaceId, openTabs } = get()
        // Already active: nothing to do — the buffer (and dirty flag) stay.
        if (path === filePath) return
        if (fileDirty && !confirmDiscard(filePath)) return
        const tab = currentWorkspaceId
          ? (openTabs[currentWorkspaceId] ?? []).find((t) => t.path === path)
          : undefined
        const nextLine = tab?.line ?? null
        const openFiles = { ...get().openFiles }
        if (currentWorkspaceId) {
          openFiles[currentWorkspaceId] = { path, line: nextLine }
        }
        set({ filePath: path, line: nextLine, openFiles, fileDirty: false })
      },
      closeTab: (path) => {
        const { currentWorkspaceId, openTabs, filePath, fileDirty } = get()
        if (!currentWorkspaceId) return
        const tabs = openTabs[currentWorkspaceId] ?? []
        const idx = tabs.findIndex((t) => t.path === path)
        if (idx < 0) return
        const isActive = path === filePath
        if (isActive && fileDirty && !confirmDiscard(path)) return
        const next = tabs.filter((t) => t.path !== path)
        const update: Partial<UiState> = {
          openTabs: { ...openTabs, [currentWorkspaceId]: next },
        }
        if (isActive) {
          /* Activate the tab that slid into the closed slot (or the last
           * one, or nothing). The buffer dies either way — dirty was
           * already confirmed. */
          const neighbor = next[Math.min(idx, next.length - 1)] ?? null
          const openFiles = { ...get().openFiles }
          if (neighbor) {
            openFiles[currentWorkspaceId] = {
              path: neighbor.path,
              line: neighbor.line,
            }
          } else {
            delete openFiles[currentWorkspaceId]
          }
          update.openFiles = openFiles
          update.filePath = neighbor?.path ?? null
          update.line = neighbor?.line ?? null
          update.fileDirty = false
        }
        set(update)
      },
      pinTab: (path) => {
        const { currentWorkspaceId, openTabs } = get()
        if (!currentWorkspaceId) return
        const tabs = openTabs[currentWorkspaceId] ?? []
        set({
          openTabs: {
            ...openTabs,
            [currentWorkspaceId]: tabs.map((t) =>
              t.path === path ? { ...t, pinned: true } : t,
            ),
          },
        })
      },
      closePanel: () => {
        if (get().fileDirty && !confirmDiscard(get().filePath)) return
        set({ rightPanelOpen: false, fileDirty: false, drawerOpen: false })
      },
      togglePanel: () => {
        const { rightPanelOpen, fileDirty, filePath } = get()
        if (rightPanelOpen && fileDirty && !confirmDiscard(filePath)) return
        set((s) => ({
          rightPanelOpen: !s.rightPanelOpen,
          fileDirty: false,
          drawerOpen: false,
        }))
      },
      toggleDrawer: (overlay) =>
        set((s) =>
          overlay
            ? { drawerOpen: !s.drawerOpen }
            : { drawerPinned: !s.drawerPinned },
        ),
      setDrawerOpen: (open) => set({ drawerOpen: open }),
      setDrawerView: (view) => set({ drawerView: view }),
      setFileDirty: (dirty) => {
        set({ fileDirty: dirty })
        /* Editing pins the preview tab (per the spec's "editing pins it").
         * Only the dirty→true transition matters; clearing on save must
         * not un-pin. */
        const { currentWorkspaceId, filePath } = get()
        if (dirty && currentWorkspaceId && filePath) {
          get().pinTab(filePath)
        }
      },
      setWorkspaceContext: (workspaceId) => {
        const { currentWorkspaceId, filePath, line, openFiles } = get()
        if (workspaceId === currentWorkspaceId) return
        /* Stash the outgoing file under the old workspace, restore the
         * incoming one (or clear — a new workspace has no remembered file).
         * `openTabs` needs nothing: sets are already keyed per workspace.
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
      version: 2,
      migrate: (persisted) => {
        /* v1 → v2: `activeTab` (file/explorer/diff/terminal strip) is gone —
         * the panel is file tabs + a drawer now. Each remembered
         * `openFiles` entry seeds a pinned tab so previously open files
         * keep their slot. */
        const state = persisted as Partial<
          Pick<
            UiState,
            | 'rightPanelOpen'
            | 'openFiles'
            | 'openTabs'
            | 'drawerPinned'
            | 'drafts'
            | 'workspaceOpen'
          >
        >
        const openFiles = state.openFiles ?? {}
        const openTabs =
          state.openTabs ??
          Object.fromEntries(
            Object.entries(openFiles).map(([ws, ref]) => [
              ws,
              [{ path: ref.path, pinned: true, line: ref.line }],
            ]),
          )
        return {
          rightPanelOpen: state.rightPanelOpen ?? false,
          openFiles,
          openTabs,
          drawerPinned: state.drawerPinned ?? true,
          drafts: state.drafts ?? {},
          workspaceOpen: state.workspaceOpen ?? {},
        }
      },
      partialize: (s) => ({
        rightPanelOpen: s.rightPanelOpen,
        openFiles: s.openFiles,
        openTabs: s.openTabs,
        drawerPinned: s.drawerPinned,
        drafts: s.drafts,
        workspaceOpen: s.workspaceOpen,
      }),
    },
  ),
)
