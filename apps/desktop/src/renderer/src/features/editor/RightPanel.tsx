/**
 * Right-hand tool panel: file tabs across the top above the editor, plus a
 * left-edge drawer (Explorer / Diff) sliding in from the panel's left edge.
 *
 * Tabs come from `ui.openTabs[workspaceId]`: explorer clicks and `file:`
 * links open *preview* tabs — one unpinned slot, italic in the strip —
 * that editing or a double-click pins. Each tab carries a close (x) and
 * the active tab carries the dirty dot. PROTOTYPE simplification: a
 * single FileViewer remounts per active tab (keyed on the path) rather
 * than keeping per-tab buffers, so a tab switch re-fetches the file and
 * the store's confirmDiscard guards cover every dirty-drop path.
 *
 * The drawer is width-responsive, measured here with a ResizeObserver:
 * below `DRAWER_BREAKPOINT_PX` it renders as an overlay on a scrim (Esc,
 * scrim click, or selecting a file closes it); at/above it pins open as a
 * flex sibling that pushes the editor right. A rail button on the tab
 * strip's left edge toggles whichever mode is active.
 */
import { useEffect, useRef, useState } from 'react'
import { FileCode, PanelLeft, X } from 'lucide-react'
import { useUiStore, type FileTab } from '../../stores/ui'
import { EmptyState } from './EmptyState'
import { FileViewer } from './FileViewer'
import { PanelDrawer } from './PanelDrawer'

/** Panel width below which the drawer overlays the editor instead of pinning. */
const DRAWER_BREAKPOINT_PX = 560

/** Stable empty array for the tab selector (avoids per-render `[]`). */
const NO_TABS: FileTab[] = []

interface RightPanelProps {
  /** Active workspace id (null until workspace selection lands). */
  readonly workspaceId: string | null
}

export function RightPanel({
  workspaceId,
}: Readonly<RightPanelProps>): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [narrow, setNarrow] = useState(false)

  const filePath = useUiStore((s) => s.filePath)
  const line = useUiStore((s) => s.line)
  const fileDirty = useUiStore((s) => s.fileDirty)
  const tabs = useUiStore(
    (s) => (workspaceId ? s.openTabs[workspaceId] : undefined) ?? NO_TABS,
  )
  const activateTab = useUiStore((s) => s.activateTab)
  const pinTab = useUiStore((s) => s.pinTab)
  const closeTab = useUiStore((s) => s.closeTab)
  const closePanel = useUiStore((s) => s.closePanel)
  const drawerOpen = useUiStore((s) => s.drawerOpen)
  const drawerPinned = useUiStore((s) => s.drawerPinned)
  const toggleDrawer = useUiStore((s) => s.toggleDrawer)
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen)

  const drawerVisible = narrow ? drawerOpen : drawerPinned

  /* Measure the panel → overlay vs pinned drawer. jsdom lacks
   * ResizeObserver, so tests render the pinned layout. */
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth
      setNarrow(width < DRAWER_BREAKPOINT_PX)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /* Leaving overlay mode clears the session-only open flag — otherwise a
   * drawer opened at narrow width would reappear on the next narrow stint
   * even after the user watched the pinned drawer take over. */
  useEffect(() => {
    if (!narrow) useUiStore.getState().setDrawerOpen(false)
  }, [narrow])

  /* Esc closes the overlay drawer. */
  useEffect(() => {
    if (!(narrow && drawerOpen)) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [narrow, drawerOpen, setDrawerOpen])

  /* Selecting a file while the overlay is up closes it. `drawerOpen` is
   * session-only and meaningless in pinned mode, so keying off `filePath`
   * alone is enough — and the dep on `drawerOpen` is deliberately absent
   * or opening the drawer would immediately close it again. */
  useEffect(() => {
    if (useUiStore.getState().drawerOpen) {
      useUiStore.getState().setDrawerOpen(false)
    }
  }, [filePath])

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-surface">
      {/* File tab strip: rail toggle + open-file tabs + panel close. */}
      <div className="flex h-9 shrink-0 items-stretch border-b border-subtle">
        <button
          type="button"
          onClick={() => toggleDrawer(narrow)}
          aria-label="Toggle panel drawer"
          aria-pressed={drawerVisible}
          title={narrow ? 'Toggle drawer' : 'Toggle pinned drawer'}
          className={`shrink-0 px-2 hover-text-default ${
            drawerVisible ? 'text-accent' : 'text-faint'
          }`}
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <div
          role="tablist"
          aria-label="Open files"
          className="flex min-w-0 flex-1 overflow-x-auto"
        >
          {tabs.map((tab) => (
            <FileTabButton
              key={tab.path}
              tab={tab}
              active={tab.path === filePath}
              /* Single-buffer prototype: only the active tab can be dirty. */
              dirty={tab.path === filePath && fileDirty}
              onActivate={() => activateTab(tab.path)}
              onPin={() => pinTab(tab.path)}
              onClose={() => closeTab(tab.path)}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={closePanel}
          aria-label="Close panel"
          title="Close panel (Ctrl/Cmd+B)"
          className="shrink-0 px-2 text-faint hover-text-default"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Drawer (pinned sibling | overlay) + the active file's viewer. */}
      <div className="relative flex min-h-0 flex-1">
        {!narrow && drawerPinned && (
          <PanelDrawer mode="pinned" workspaceId={workspaceId} />
        )}
        <div className="min-w-0 flex-1">
          {filePath ? (
            <FileViewer
              key={filePath}
              workspaceId={workspaceId}
              path={filePath}
              line={line}
            />
          ) : (
            <EmptyState
              icon={FileCode}
              title="No file open"
              note="Pick one in the Explorer drawer — file references in chat open here too."
            />
          )}
        </div>
        {narrow && drawerOpen && (
          <>
            {/* Translucent scrim behind the overlay drawer. */}
            <button
              type="button"
              aria-label="Close drawer"
              onClick={() => setDrawerOpen(false)}
              className="absolute inset-0 z-10 cursor-default bg-black/40"
            />
            <PanelDrawer mode="overlay" workspaceId={workspaceId} />
          </>
        )}
      </div>
    </div>
  )
}

/** Basename for the tab label; the full path stays on `title`. */
function tabName(path: string): string {
  return path.split('/').pop() ?? path
}

function FileTabButton({
  tab,
  active,
  dirty,
  onActivate,
  onPin,
  onClose,
}: Readonly<{
  tab: FileTab
  active: boolean
  /** Unsaved-changes dot (active tab only in the single-buffer prototype). */
  dirty: boolean
  onActivate: () => void
  onPin: () => void
  onClose: () => void
}>): React.JSX.Element {
  const name = tabName(tab.path)
  return (
    /* role="tab" on a div so the close control can nest as a real button. */
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={
        tab.pinned
          ? tab.path
          : `${tab.path} — preview tab (edits or double-click to pin)`
      }
      onClick={onActivate}
      onDoubleClick={onPin}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onActivate()
      }}
      className={`flex min-w-0 max-w-44 shrink-0 cursor-pointer items-center gap-1 border-b-2 py-1.5 pl-3 pr-1 text-xs select-none ${
        active
          ? 'border-accent text-strong'
          : 'border-transparent text-muted hover-text-default'
      }`}
    >
      <span className={`truncate ${tab.pinned ? '' : 'italic'}`}>{name}</span>
      {dirty && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
          aria-label="Unsaved changes"
        />
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label={`Close ${name}`}
        title={`Close ${name}`}
        className="shrink-0 rounded p-0.5 text-faint hover-bg-raised hover-text-default"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
