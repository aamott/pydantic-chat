/**
 * Left-edge drawer inside the right panel: a view selector across the top
 * (Explorer / Diff — room for more entries) above the selected view's
 * body.
 *
 * RightPanel measures the panel width and picks one of two placements:
 *
 * - `overlay` (below the breakpoint): absolutely positioned over the
 *   editor on a translucent scrim. Esc, a scrim click, or selecting a
 *   file closes it (all handled by RightPanel).
 * - `pinned` (at/above the breakpoint): a flex sibling that pushes the
 *   editor right and stays open until the rail button toggles it.
 */
import {
  FolderTree,
  GitCompareArrows,
  X,
  type LucideIcon,
} from 'lucide-react'
import { iconButtonClass } from '../../lib/ui'
import { useUiStore, type DrawerView } from '../../stores/ui'
import { DiffPanel } from './DiffPanel'
import { FileExplorer } from './FileExplorer'

/** Selector entries, in order. Add views by extending this list. */
const VIEWS: { id: DrawerView; label: string; icon: LucideIcon }[] = [
  { id: 'explorer', label: 'Explorer', icon: FolderTree },
  { id: 'diff', label: 'Diff', icon: GitCompareArrows },
]

interface PanelDrawerProps {
  /** Active workspace id (null until workspace selection lands). */
  readonly workspaceId: string | null
  /** 'pinned' = flex sibling; 'overlay' = floats over the editor. */
  readonly mode: 'pinned' | 'overlay'
}

export function PanelDrawer({
  workspaceId,
  mode,
}: Readonly<PanelDrawerProps>): React.JSX.Element {
  const drawerView = useUiStore((s) => s.drawerView)
  const setDrawerView = useUiStore((s) => s.setDrawerView)
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen)

  return (
    <aside
      role={mode === 'overlay' ? 'dialog' : 'complementary'}
      aria-label="Panel drawer"
      className={
        mode === 'overlay'
          ? 'absolute inset-y-0 left-0 z-20 flex w-64 max-w-[80%] flex-col border-r border-subtle bg-surface shadow-lg'
          : 'flex h-full w-56 shrink-0 flex-col border-r border-subtle bg-surface'
      }
    >
      {/* View selector — segmented icon buttons. */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-subtle px-2">
        {VIEWS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setDrawerView(id)}
            aria-pressed={drawerView === id}
            title={label}
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs ${
              drawerView === id
                ? 'bg-raised text-strong'
                : 'text-muted hover-bg-raised hover-text-default'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
        {mode === 'overlay' && (
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close drawer"
            title="Close drawer (Esc)"
            className={`ml-auto ${iconButtonClass()}`}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Selected view body */}
      <div className="min-h-0 flex-1">
        {drawerView === 'explorer' ? (
          <FileExplorer workspaceId={workspaceId} />
        ) : (
          <DiffPanel />
        )}
      </div>
    </aside>
  )
}
