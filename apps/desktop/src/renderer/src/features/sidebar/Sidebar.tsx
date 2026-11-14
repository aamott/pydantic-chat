/**
 * Left sidebar: "Open workspace…" entry point plus the workspace → chats
 * tree (`WorkspaceSection`). Rendering states come straight from the chats
 * store — `loaded` gates the initial spinner, `backendError` downgrades
 * the empty state to a connectivity note (the full banner lives in
 * ChatPanel).
 */
import { FolderOpen } from 'lucide-react'
import { useChatsStore } from '../../stores/chats'
import { WorkspaceSection } from './WorkspaceSection'

export function Sidebar(): React.JSX.Element {
  const workspaces = useChatsStore((s) => s.workspaces)
  const loaded = useChatsStore((s) => s.loaded)
  const backendError = useChatsStore((s) => s.backendError)
  const createWorkspace = useChatsStore((s) => s.createWorkspace)

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-subtle bg-surface">
      <div className="border-b border-subtle p-2">
        <button
          type="button"
          onClick={() => void createWorkspace()}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-strong px-2 py-1.5 text-xs text-secondary hover-bg-subtle"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          Open workspace…
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {!loaded && (
          <p className="px-2 py-3 text-center text-xs text-faint">
            Loading…
          </p>
        )}
        {loaded && workspaces.length === 0 && (
          <p className="px-3 py-4 text-center text-xs text-faint">
            {backendError
              ? "Couldn't reach the backend — workspaces will appear once it's back."
              : 'Open a workspace to start chatting.'}
          </p>
        )}
        <div className="space-y-1.5">
          {workspaces.map((workspace) => (
            <WorkspaceSection key={workspace.id} workspace={workspace} />
          ))}
        </div>
      </div>
    </aside>
  )
}
