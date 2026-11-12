/**
 * One workspace group in the sidebar: a collapsible header (chevron +
 * folder name, amber "missing" badge when the folder is gone) with hover
 * actions for new-chat and delete-workspace, and the nested `ChatList`.
 * Delete is a two-step inline confirm — no dialog component exists yet.
 */
import { useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import type { Workspace } from '@pydantic-chat/shared'
import { useChatsStore } from '../../stores/chats'
import { ChatList } from './ChatList'

interface WorkspaceSectionProps {
  workspace: Workspace
}

export function WorkspaceSection({
  workspace,
}: WorkspaceSectionProps): React.JSX.Element {
  const activeChatId = useChatsStore((s) => s.activeChatId)
  const activeWorkspaceId = useChatsStore((s) => s.activeWorkspaceId)
  const selectChat = useChatsStore((s) => s.selectChat)
  const renameChat = useChatsStore((s) => s.renameChat)
  const deleteChat = useChatsStore((s) => s.deleteChat)
  const createChat = useChatsStore((s) => s.createChat)
  const deleteWorkspace = useChatsStore((s) => s.deleteWorkspace)

  const [open, setOpen] = useState(true)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const name = workspace.display_name || basename(workspace.path)
  const isActive = workspace.id === activeWorkspaceId
  const Chevron = open ? ChevronDown : ChevronRight

  if (confirmingDelete) {
    return (
      <div className="space-y-0.5">
        <div className="flex items-center gap-1 rounded-md bg-red-50 px-1.5 py-1 text-xs text-red-700">
          <span className="min-w-0 flex-1 truncate" title={workspace.path}>
            Delete “{name}” and its chats?
          </span>
          <button
            type="button"
            aria-label="Confirm delete workspace"
            title="Confirm delete"
            onClick={() => void deleteWorkspace(workspace.id)}
            className="rounded p-1 text-red-600 hover:bg-red-100"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Cancel"
            title="Cancel"
            onClick={() => setConfirmingDelete(false)}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-0.5">
      {/* Section header — whole row toggles collapse. */}
      <div
        className={`group flex items-center gap-0.5 rounded-md px-1.5 py-1 ${
          isActive ? 'text-neutral-900' : 'text-neutral-700'
        } hover:bg-neutral-100`}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`Workspace ${name}`}
          title={workspace.path}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          <Chevron className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          {open ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          )}
          <span
            className={`truncate text-xs ${
              isActive ? 'font-semibold' : 'font-medium'
            }`}
          >
            {name}
          </span>
          {workspace.missing && (
            <span
              className="shrink-0 rounded bg-amber-100 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-700"
              title={`Folder not found: ${workspace.path}`}
            >
              missing
            </span>
          )}
        </button>

        {/* Hover actions: new chat, delete workspace. */}
        <span className="hidden shrink-0 items-center group-hover:flex">
          <button
            type="button"
            onClick={() => void createChat(workspace.id)}
            aria-label={`New chat in ${name}`}
            title="New chat"
            className="rounded p-1 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-800"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            aria-label={`Delete workspace ${name}`}
            title="Delete workspace"
            className="rounded p-1 text-neutral-500 hover:bg-red-100 hover:text-red-700"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      {open && (
        <div className="pl-3">
          <ChatList
            chats={workspace.chats ?? []}
            activeChatId={isActive ? activeChatId : null}
            onSelect={(chatId) => void selectChat(chatId)}
            onRename={renameChat}
            onDelete={(chatId) => void deleteChat(chatId)}
          />
        </div>
      )}
    </div>
  )
}

/** Last path segment, for workspaces with no display_name set. */
function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || path
}
