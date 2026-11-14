/**
 * Which workspace a settings section should scope workspace-aware data to
 * (user tools, the tool catalog).
 *
 * The settings window is a separate renderer: its `useChatsStore` copy
 * never ran `loadWorkspaces` — and mustn't, since that call selects/creates
 * chats — so `activeWorkspaceId` stays null there. The fallback is the
 * first row of `GET /api/workspaces`, which arrives recency-ordered
 * (`last_opened_at DESC`) and therefore matches the workspace the main
 * window most likely has open. The fetch is read-only
 * (`refreshWorkspaces` only pulls the list — no selection side-effects).
 */
import { useEffect } from 'react'
import { useChatsStore } from '../../stores/chats'

export interface SectionWorkspace {
  /** Resolved workspace id; null when no workspace exists or is known yet. */
  id: string | null
  /** Its display name (for origin badges); null when unknown. */
  name: string | null
}

export function useSectionWorkspace(): SectionWorkspace {
  const workspaces = useChatsStore((s) => s.workspaces)
  const activeWorkspaceId = useChatsStore((s) => s.activeWorkspaceId)
  const refreshWorkspaces = useChatsStore((s) => s.refreshWorkspaces)

  /* Populate the settings window's store copy read-only. `workspaces` in
   * the dep list (not the array itself) keeps this to one fetch. */
  useEffect(() => {
    if (workspaces.length === 0) void refreshWorkspaces()
  }, [workspaces.length, refreshWorkspaces])

  const id = activeWorkspaceId ?? workspaces[0]?.id ?? null
  return {
    id,
    name: workspaces.find((w) => w.id === id)?.display_name ?? null,
  }
}
