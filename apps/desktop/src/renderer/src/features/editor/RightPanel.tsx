/**
 * Right-hand tool panel: tab strip (File / Explorer / Diff / Terminal) above
 * the active tab body. The File tab hosts the read-only `FileViewer`, the
 * Explorer tab hosts `FileExplorer`, the Diff tab hosts `DiffPanel`, and the
 * Terminal tab hosts `TerminalView` (live `shell` tool output).
 */
import {
  FileCode,
  FolderTree,
  GitCompareArrows,
  SquareTerminal,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useUiStore, type RightPanelTab } from '../../stores/ui'
import { DiffPanel } from './DiffPanel'
import { EmptyState } from './EmptyState'
import { FileExplorer } from './FileExplorer'
import { FileViewer } from './FileViewer'
import { TerminalView } from './TerminalView'

const TABS: { id: RightPanelTab; label: string; icon: LucideIcon }[] = [
  { id: 'file', label: 'File', icon: FileCode },
  { id: 'explorer', label: 'Explorer', icon: FolderTree },
  { id: 'diff', label: 'Diff', icon: GitCompareArrows },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
]

interface RightPanelProps {
  /** Active workspace id (null until workspace selection lands). */
  readonly workspaceId: string | null
}

export function RightPanel({ workspaceId }: Readonly<RightPanelProps>): React.JSX.Element {
  const activeTab = useUiStore((s) => s.activeTab)
  const setTab = useUiStore((s) => s.setTab)
  const closePanel = useUiStore((s) => s.closePanel)
  const filePath = useUiStore((s) => s.filePath)
  const line = useUiStore((s) => s.line)

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* Tab strip */}
      <div className="flex h-9 shrink-0 items-stretch border-b border-subtle">
        <div role="tablist" className="flex min-w-0 flex-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={activeTab === id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 text-xs ${
                activeTab === id
                  ? 'border-accent text-strong'
                  : 'border-transparent text-muted hover-text-default'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={closePanel}
          aria-label="Close panel"
          title="Close panel (Ctrl/Cmd+B)"
          className="px-2 text-faint hover-text-default"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Active tab body */}
      <div className="min-h-0 flex-1">
        {activeTab === 'file' &&
          (filePath ? (
            <FileViewer workspaceId={workspaceId} path={filePath} line={line} />
          ) : (
            <EmptyState
              icon={FileCode}
              title="No file open"
              note="File references in chat and the explorer will open here."
            />
          ))}
        {activeTab === 'explorer' && <FileExplorer workspaceId={workspaceId} />}
        {activeTab === 'diff' && <DiffPanel />}
        {activeTab === 'terminal' && <TerminalView />}
      </div>
    </div>
  )
}
