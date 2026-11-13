/**
 * Chat/workspace state for the main window.
 *
 * Streaming state lives inside AI SDK `Chat` objects, NOT in Zustand: this
 * store keeps a non-reactive `Map<chatId, Chat>` registry (the documented
 * pattern for externally-owned `useChat({ chat })` instances) plus the
 * reactive shell — workspace list, active ids, and a connectivity banner.
 * Because `Chat` instances outlive their panel mount, background chats keep
 * streaming while another chat is selected.
 */
import { create } from 'zustand'
import type { UIMessage } from 'ai'
import type { ChatSummary, Workspace } from '@pydantic-chat/shared'
import { apiFetch, apiJson } from '../lib/api'
import { makeChat, type AppChat } from '../lib/transport'

/**
 * Registry of live `Chat` instances keyed by chat id. Non-reactive on
 * purpose: `useChat` subscribes to the instance itself, and Zustand
 * snapshots would fight the SDK's internal state.
 */
const chatRegistry = new Map<string, AppChat>()

/** Chat ids whose server transcript was already pulled into the registry. */
const hydratedChats = new Set<string>()

/** Look up (never create) the `Chat` for an id — used by panels/selectors. */
export function getChat(chatId: string): AppChat | undefined {
  return chatRegistry.get(chatId)
}

/** Register (or reuse) a Chat instance for `chatId`. */
function ensureChat(chatId: string): AppChat {
  let chat = chatRegistry.get(chatId)
  if (!chat) {
    chat = makeChat(chatId)
    chatRegistry.set(chatId, chat)
  }
  return chat
}

/**
 * Pull the persisted transcript into the `Chat` instance on first open.
 * Skipped while the instance is mid-stream — its in-flight state is newer
 * than anything the server could hand back.
 */
async function hydrateChat(chatId: string): Promise<void> {
  if (hydratedChats.has(chatId)) return
  hydratedChats.add(chatId) // optimistic: one fetch per chat per session
  try {
    const messages = await apiJson<UIMessage[]>(
      `/api/chats/${chatId}/messages`,
    )
    const chat = ensureChat(chatId)
    if (chat.status === 'ready' || chat.status === 'error') {
      // `chat.messages =` is the SDK's hydration setter (same thing
      // `useChat().setMessages` calls through to).
      chat.messages = messages
      if (chat.status === 'error') chat.clearError()
    }
  } catch (error) {
    // 404 = chat deleted server-side; surface it and let the caller prune.
    hydratedChats.delete(chatId)
    throw error
  }
}

/** Fields `PATCH /api/chats/{id}` accepts besides `title` (rename). */
export interface ChatUpdate {
  model?: string | null
  thinking?: string | null
  /** Any tool-profile id (builtin or custom), or null to inherit. */
  permission_profile?: string | null
}

/**
 * Find a chat's summary row inside the nested `workspaces[].chats` data.
 *
 * Chat model/thinking/permission_profile hydration comes from these rows:
 * `GET /api/workspaces` returns `ChatSummaryOut` per chat — the same schema
 * `PATCH /api/chats/{id}` returns — so a single source feeds both the
 * sidebar and the composer pickers. Fields absent on an older backend read
 * as `undefined`, which the pickers treat like `null` (inherit).
 */
export function findChatSummary(
  workspaces: Workspace[],
  chatId: string,
): ChatSummary | undefined {
  for (const workspace of workspaces) {
    const summary = (workspace.chats ?? []).find((c) => c.id === chatId)
    if (summary) return summary
  }
  return undefined
}

interface ChatsState {
  /** Workspaces with nested chat summaries, straight from GET /api/workspaces. */
  workspaces: Workspace[]
  /** Selected workspace; null until the first load resolves. */
  activeWorkspaceId: string | null
  /** Chat shown in the panel; null when no chat exists yet. */
  activeChatId: string | null
  /** True once the initial `loadWorkspaces` has settled (success or failure). */
  loaded: boolean
  /** Connectivity banner text; null while the backend is reachable. */
  backendError: string | null
  /** Transient user-facing notice (deleted chat, failed action). */
  notice: string | null

  /** GET workspaces, then pick the first workspace + a chat as active. */
  loadWorkspaces: () => Promise<void>
  /** Re-pull the workspace list without touching the selection. */
  refreshWorkspaces: () => Promise<void>
  /** Native folder dialog → POST /api/workspaces → select it. */
  createWorkspace: () => Promise<void>
  /** POST /api/workspaces/{id}/chats → select the new chat. */
  createChat: (workspaceId: string) => Promise<void>
  /** PATCH /api/chats/{id} — rename; false on failure (row keeps editing). */
  renameChat: (chatId: string, title: string) => Promise<boolean>
  /**
   * PATCH /api/chats/{id} — per-chat model/thinking/permission_profile
   * overrides (null inherits); false on failure.
   */
  updateChat: (chatId: string, patch: ChatUpdate) => Promise<boolean>
  /** DELETE /api/chats/{id} — prune it; selects a sibling when it was active. */
  deleteChat: (chatId: string) => Promise<void>
  /** DELETE /api/workspaces/{id} — prune it + its chats; activates a sibling. */
  deleteWorkspace: (workspaceId: string) => Promise<void>
  /** Point the panel at a chat, hydrating its transcript on first open. */
  selectChat: (chatId: string) => Promise<void>
  /** Switch the active workspace (and its last/first chat). */
  selectWorkspace: (workspaceId: string) => Promise<void>
  /** Abort the active chat's stream locally, then POST /api/chats/{id}/stop. */
  stopActive: () => Promise<void>
  /** Clear the notice banner. */
  dismissNotice: () => void
}

export const useChatsStore = create<ChatsState>()((set, get) => {
  /** Pick a chat inside `workspace`: last-open, else first, else create one. */
  async function activateWorkspaceChat(workspace: Workspace): Promise<void> {
    const chats = workspace.chats ?? []
    const target =
      chats.find((c) => c.id === workspace.last_chat_id) ?? chats[0]
    if (target) {
      await get().selectChat(target.id)
    } else {
      // A workspace without chats still needs one to type into.
      await get().createChat(workspace.id)
    }
  }

  /**
   * Remember which chat was open so reopening the workspace restores it —
   * PATCH `last_chat_id` plus the matching local update. Fire-and-forget:
   * a lost bookmark only means the wrong chat restores next time.
   */
  function bookmarkLastChat(
    workspaceId: string | undefined,
    chatId: string,
  ): void {
    if (!workspaceId) return
    const workspace = get().workspaces.find((w) => w.id === workspaceId)
    if (!workspace || workspace.last_chat_id === chatId) return
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, last_chat_id: chatId } : w,
      ),
    }))
    apiFetch(`/api/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ last_chat_id: chatId }),
    }).catch((error: unknown) => {
      console.warn('Failed to persist last_chat_id:', error)
    })
  }

  return {
    workspaces: [],
    activeWorkspaceId: null,
    activeChatId: null,
    loaded: false,
    backendError: null,
    notice: null,

    loadWorkspaces: async () => {
      try {
        const workspaces = await apiJson<Workspace[]>('/api/workspaces')
        set({ workspaces, loaded: true, backendError: null })
        const first = workspaces[0]
        if (first) {
          set({ activeWorkspaceId: first.id })
          await activateWorkspaceChat(first)
        }
      } catch (error) {
        set({
          loaded: true,
          backendError:
            error instanceof Error
              ? `Backend unreachable: ${error.message}`
              : 'Backend unreachable',
        })
      }
    },

    refreshWorkspaces: async () => {
      try {
        const workspaces = await apiJson<Workspace[]>('/api/workspaces')
        set({ workspaces, backendError: null })
      } catch {
        /* keep the last good list; connectivity banner is owned by loadWorkspaces */
      }
    },

    createWorkspace: async () => {
      const path = await window.api.pickWorkspace()
      if (!path) return // dialog cancelled
      try {
        const workspace = await apiJson<Workspace>('/api/workspaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        })
        // Upsert on the server → replace any existing row, keep recency order.
        set((s) => ({
          workspaces: [
            workspace,
            ...s.workspaces.filter((w) => w.id !== workspace.id),
          ],
          activeWorkspaceId: workspace.id,
          backendError: null,
        }))
        await activateWorkspaceChat(workspace)
      } catch (error) {
        set({
          notice:
            error instanceof Error
              ? `Couldn't open workspace: ${error.message}`
              : "Couldn't open workspace",
        })
      }
    },

    createChat: async (workspaceId) => {
      const chat = await apiJson<ChatSummary>(
        `/api/workspaces/${workspaceId}/chats`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      ).catch((error: unknown) => {
        set({
          notice:
            error instanceof Error
              ? `Couldn't create chat: ${error.message}`
              : "Couldn't create chat",
        })
        return null
      })
      if (!chat) return
      set((s) => ({
        workspaces: s.workspaces.map((w) =>
          w.id === workspaceId ? { ...w, chats: [chat, ...(w.chats ?? [])] } : w,
        ),
      }))
      await get().selectChat(chat.id)
    },

    renameChat: async (chatId, title) => {
      const trimmed = title.trim()
      if (!trimmed) return false
      try {
        const summary = await apiJson<ChatSummary>(`/api/chats/${chatId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: trimmed }),
        })
        set((s) => ({
          workspaces: s.workspaces.map((w) => ({
            ...w,
            chats: (w.chats ?? []).map((c) => (c.id === chatId ? summary : c)),
          })),
        }))
        return true
      } catch (error) {
        set({
          notice:
            error instanceof Error
              ? `Couldn't rename chat: ${error.message}`
              : "Couldn't rename chat",
        })
        return false
      }
    },

    updateChat: async (chatId, patch) => {
      try {
        const summary = await apiJson<ChatSummary>(`/api/chats/${chatId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          // Undefined keys serialize away, so only provided fields are sent.
          body: JSON.stringify(patch),
        })
        set((s) => ({
          workspaces: s.workspaces.map((w) => ({
            ...w,
            chats: (w.chats ?? []).map((c) =>
              // Merge rather than replace: a stale/partial response must not
              // drop fields the row already knows.
              c.id === chatId ? { ...c, ...summary } : c,
            ),
          })),
        }))
        return true
      } catch (error) {
        set({
          notice:
            error instanceof Error
              ? `Couldn't update chat: ${error.message}`
              : "Couldn't update chat",
        })
        return false
      }
    },

    deleteChat: async (chatId) => {
      // Look up the workspace before the delete so the fallback selection
      // still knows which sibling chats remain.
      const workspace = get().workspaces.find((w) =>
        (w.chats ?? []).some((c) => c.id === chatId),
      )
      try {
        const response = await apiFetch(`/api/chats/${chatId}`, {
          method: 'DELETE',
        })
        // 404 = already gone server-side; prune the stale row either way.
        if (!response.ok && response.status !== 404) {
          throw new Error(`${response.status} ${response.statusText}`)
        }
      } catch (error) {
        set({
          notice:
            error instanceof Error
              ? `Couldn't delete chat: ${error.message}`
              : "Couldn't delete chat",
        })
        return
      }
      chatRegistry.delete(chatId)
      hydratedChats.delete(chatId)
      set((s) => ({
        workspaces: s.workspaces.map((w) =>
          (w.chats ?? []).some((c) => c.id === chatId)
            ? {
                ...w,
                chats: (w.chats ?? []).filter((c) => c.id !== chatId),
                // The server clears the pointer on delete; mirror that.
                last_chat_id:
                  w.last_chat_id === chatId ? null : w.last_chat_id,
              }
            : w,
        ),
      }))
      if (get().activeChatId === chatId) {
        const next = (workspace?.chats ?? []).find((c) => c.id !== chatId)
        if (next) {
          await get().selectChat(next.id)
        } else {
          // Last chat in the workspace — the sidebar offers "+ New chat".
          set({ activeChatId: null })
        }
      }
    },

    deleteWorkspace: async (workspaceId) => {
      const workspace = get().workspaces.find((w) => w.id === workspaceId)
      try {
        const response = await apiFetch(`/api/workspaces/${workspaceId}`, {
          method: 'DELETE',
        })
        if (!response.ok && response.status !== 404) {
          throw new Error(`${response.status} ${response.statusText}`)
        }
      } catch (error) {
        set({
          notice:
            error instanceof Error
              ? `Couldn't delete workspace: ${error.message}`
              : "Couldn't delete workspace",
        })
        return
      }
      // Chats cascade server-side; drop their local Chat instances too.
      for (const chat of workspace?.chats ?? []) {
        chatRegistry.delete(chat.id)
        hydratedChats.delete(chat.id)
      }
      set((s) => ({
        workspaces: s.workspaces.filter((w) => w.id !== workspaceId),
      }))
      if (get().activeWorkspaceId === workspaceId) {
        const next = get().workspaces[0]
        if (next) {
          await get().selectWorkspace(next.id)
        } else {
          set({ activeWorkspaceId: null, activeChatId: null })
        }
      }
    },

    selectChat: async (chatId) => {
      const workspace = get().workspaces.find((w) =>
        (w.chats ?? []).some((c) => c.id === chatId),
      )
      ensureChat(chatId)
      try {
        await hydrateChat(chatId)
        set({
          activeChatId: chatId,
          ...(workspace ? { activeWorkspaceId: workspace.id } : {}),
        })
        bookmarkLastChat(workspace?.id, chatId)
      } catch (error) {
        const status = (error as { status?: number }).status
        if (status === 404) {
          // Chat was deleted server-side — prune it and fall back.
          set((s) => ({
            workspaces: s.workspaces.map((w) => ({
              ...w,
              chats: (w.chats ?? []).filter((c) => c.id !== chatId),
            })),
            notice: 'That chat no longer exists.',
          }))
          chatRegistry.delete(chatId)
          hydratedChats.delete(chatId)
          if (workspace) await activateWorkspaceChat(workspace)
        } else {
          set({
            notice:
              error instanceof Error
                ? `Couldn't load chat: ${error.message}`
                : "Couldn't load chat",
          })
        }
      }
    },

    selectWorkspace: async (workspaceId) => {
      const workspace = get().workspaces.find((w) => w.id === workspaceId)
      if (!workspace) return
      set({ activeWorkspaceId: workspaceId })
      await activateWorkspaceChat(workspace)
    },

    stopActive: async () => {
      const chatId = get().activeChatId
      if (!chatId) return
      // Abort the local SSE reader first so the UI flips to `ready` at once…
      await chatRegistry.get(chatId)?.stop()
      // …then kill the server-side run — client disconnect alone does NOT
      // cancel it (see apps/backend/app/api/chat.py).
      try {
        await apiFetch(`/api/chats/${chatId}/stop`, { method: 'POST' })
      } catch {
        /* 404 = nothing running (already finished); still fine */
      }
    },

    dismissNotice: () => set({ notice: null }),
  }
})
