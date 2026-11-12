/**
 * Far-left icon rail, VS Code style. v1 has a single "Chats" view (always
 * active) plus a bottom-anchored settings shortcut that opens the
 * singleton settings window via `settings:open` IPC.
 */
import { MessageSquare, Settings } from 'lucide-react'

export function ActivityBar(): React.JSX.Element {
  return (
    <nav
      aria-label="Activity bar"
      className="flex w-12 shrink-0 flex-col items-center border-r border-neutral-200 bg-neutral-50 py-2"
    >
      <button
        type="button"
        aria-label="Chats"
        aria-current="page"
        title="Chats"
        className="rounded-md p-2 text-blue-600 hover:bg-neutral-100"
      >
        <MessageSquare className="h-5 w-5" />
      </button>

      <div className="flex-1" />

      <button
        type="button"
        onClick={() => void window.api.openSettings()}
        aria-label="Settings"
        title="Settings"
        className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
      >
        <Settings className="h-5 w-5" />
      </button>
    </nav>
  )
}
