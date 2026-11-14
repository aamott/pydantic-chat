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
  const setWorkspaceContext = useUiStore((s) => s.setWorkspaceContext)
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

  /* Cross-window file-open requests (the settings window's user-tools
   * Edit affordance). The FileViewer binds to the active workspace, so
   * switch first when the file belongs to another — selectWorkspace can
   * bail on a declined dirty-buffer confirm, which we honor by not
   * opening. `setWorkspaceContext` runs eagerly here because App's own
   * context effect fires on the next render, after openFile may already
   * have run (it keys `openFiles` by the current context). */
  useEffect(
    () =>
      window.api.onOpenFileInViewer((workspaceId, path) => {
        void (async () => {
          const chats = useChatsStore.getState()
          if (chats.activeWorkspaceId !== workspaceId) {
            await chats.selectWorkspace(workspaceId)
            if (useChatsStore.getState().activeWorkspaceId !== workspaceId) {
              return
            }
          }
          useUiStore.getState().setWorkspaceContext(workspaceId)
          useUiStore.getState().openFile(path)
        })()
      }),
    [],
  )

  /* Keep the ui store's workspace context in sync — restores the incoming
   * workspace's remembered open file and stashes the outgoing one. The
   * dirty-buffer guard runs earlier, inside selectWorkspace/selectChat. */
  useEffect(() => {
    setWorkspaceContext(activeWorkspaceId)
  }, [activeWorkspaceId, setWorkspaceContext])

  /* Warn before the app window closes with unsaved file edits. Electron
   * shows the native "Leave site?" dialog on a nonzero returnValue. */
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (useUiStore.getState().fileDirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

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
    <div className="bg-surface text-strong flex h-screen">
      <ActivityBar />
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <header className="flex h-10 shrink-0 items-center justify-between border-b border-subtle px-3">
          <span className="text-sm font-medium text-secondary">Chat</span>
          <button
            onClick={togglePanel}
            aria-label="Toggle right panel"
            aria-pressed={rightPanelOpen}
            title="Toggle right panel (Ctrl/Cmd+B)"
            className={`rounded p-1.5 hover-bg-raised ${
              rightPanelOpen ? 'text-accent' : 'text-muted'
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
