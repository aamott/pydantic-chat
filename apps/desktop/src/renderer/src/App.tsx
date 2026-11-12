import { useEffect } from 'react'
import { PanelRight } from 'lucide-react'
import { useUiStore } from './stores/ui'
import { useChatsStore } from './stores/chats'
import { SplitLayout } from './features/editor/SplitLayout'
import { RightPanel } from './features/editor/RightPanel'
import { ChatPanel } from './features/chat/ChatPanel'
import { ActivityBar } from './features/sidebar/ActivityBar'
import { Sidebar } from './features/sidebar/Sidebar'

export function App(): React.JSX.Element {
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen)
  const togglePanel = useUiStore((s) => s.togglePanel)
  const activeWorkspaceId = useChatsStore((s) => s.activeWorkspaceId)
  const loadWorkspaces = useChatsStore((s) => s.loadWorkspaces)
  const createWorkspace = useChatsStore((s) => s.createWorkspace)

  /* Initial workspace/chat load. */
  useEffect(() => {
    void loadWorkspaces()
  }, [loadWorkspaces])

  /* File ▸ Open Workspace… routes through the same flow as the button. */
  useEffect(() => window.api.onOpenWorkspace(() => void createWorkspace()), [
    createWorkspace,
  ])

  /* Ctrl/Cmd+B toggles the right panel. */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        togglePanel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [togglePanel])

  return (
    <div className="flex h-screen text-neutral-900">
      <ActivityBar />
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <header className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-200 px-3">
          <span className="text-sm font-medium text-neutral-700">Chat</span>
          <button
            onClick={togglePanel}
            aria-label="Toggle right panel"
            aria-pressed={rightPanelOpen}
            title="Toggle right panel (Ctrl/Cmd+B)"
            className={`rounded p-1.5 hover:bg-neutral-100 ${
              rightPanelOpen ? 'text-blue-600' : 'text-neutral-500'
            }`}
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </header>

        {/*
          The split Group is only mounted while the panel is open — sizes
          persist via useDefaultLayout and restore on remount.
        */}
        {rightPanelOpen ? (
          <SplitLayout
            chat={<ChatPanel />}
            right={<RightPanel workspaceId={activeWorkspaceId} />}
          />
        ) : (
          <main className="min-h-0 flex-1">
            <ChatPanel />
          </main>
        )}
      </div>
    </div>
  )
}
