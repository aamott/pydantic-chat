/**
 * User-defined tool registry for the settings "User Tools" section.
 *
 * `GET /api/user-tools` is the merged discovery+registry view: every row
 * is ast-parsed server-side, so `functions`/`error`/`skipped_*` are always
 * fresh. Writes refetch the listing rather than merging responses — PATCH
 * returns the registry (`UserToolSpec[]`), not the listing, and POST's
 * response is scoped to the created origin (a global create would drop
 * workspace rows from a workspace-scoped view).
 *
 * `workspaceId` is the scope the listing was fetched for: workspace tool
 * rows only appear when `?workspace_id=` was passed, and workspace-key
 * writes (DELETE, PUT `/source`) need it back to locate the root. The
 * section passes the resolved workspace on every mount/param change —
 * `ensureLoaded` treats a scope change as stale.
 */
import { create } from 'zustand'
import type {
  UserTool,
  UserToolCreate,
  UserToolPatch,
  UserToolSource,
} from '@pydantic-chat/shared'
import { apiFetch, apiJson } from '../lib/api'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/**
 * Extract FastAPI's `detail` from an error response, falling back to the
 * status line — mirrors `apiJson`'s mapping for the apiFetch call sites
 * (DELETE returns 204, which has no JSON body).
 */
async function errorDetail(response: Response): Promise<string> {
  let detail = `${response.status} ${response.statusText}`
  try {
    const body: unknown = await response.json()
    if (
      typeof body === 'object' &&
      body !== null &&
      'detail' in body &&
      typeof (body as { detail: unknown }).detail === 'string'
    ) {
      detail = (body as { detail: string }).detail
    }
  } catch {
    /* non-JSON error body — keep the status line */
  }
  return detail
}

interface UserToolsState {
  /** Discovered tool files (ast-parsed view); `[]` until fetched. */
  tools: UserTool[]
  /** Workspace the current listing is scoped to; null = global rows only. */
  workspaceId: string | null
  /** True once the first fetch settled (success or failure). */
  loaded: boolean
  /** Last failure text (load or write); null when healthy. */
  error: string | null

  /**
   * Fetch once per workspace scope — a scope change refetches. Safe to
   * call on every mount/param change; dedupes via an in-flight flag.
   */
  ensureLoaded: (workspaceId: string | null) => Promise<void>
  /** Force a refetch for the given scope (or the current one when omitted). */
  reload: (workspaceId?: string | null) => Promise<void>
  /** PATCH one file's `enabled` flag, then refetch. False on failure. */
  setEnabled: (key: string, enabled: boolean) => Promise<boolean>
  /** POST a new tool file, then refetch. False on failure. */
  create: (input: UserToolCreate) => Promise<boolean>
  /** DELETE a tool file + its registry row, then refetch. False on failure. */
  remove: (key: string) => Promise<boolean>
  /** GET one file's source; null on failure (error text stored). */
  readSource: (key: string) => Promise<string | null>
  /** PUT a file's source (creates missing files), then refetch. */
  writeSource: (key: string, source: string) => Promise<boolean>
  /** Clear the stored error text. */
  dismissError: () => void
}

/**
 * Serializes listing fetches — the in-flight load's promise, or null.
 * A scope change arriving mid-load waits for it rather than being dropped
 * (a boolean guard would leave the listing stuck on the stale scope).
 */
let inFlight: Promise<void> | null = null

export const useUserToolsStore = create<UserToolsState>()((set, get) => {
  /** `?workspace_id=` suffix — the backend ignores it on global-key routes. */
  function scopeQuery(): string {
    const id = get().workspaceId
    return id ? `workspace_id=${encodeURIComponent(id)}` : ''
  }

  /** Replace the listing from a fresh GET for `workspaceId`'s scope. */
  async function refresh(workspaceId: string | null): Promise<void> {
    const query = workspaceId
      ? `?workspace_id=${encodeURIComponent(workspaceId)}`
      : ''
    const tools = await apiJson<UserTool[]>(`/api/user-tools${query}`)
    set({ tools, workspaceId, loaded: true, error: null })
  }

  function fail(action: string, error: unknown): void {
    set({
      error:
        error instanceof Error
          ? `Couldn't ${action}: ${error.message}`
          : `Couldn't ${action}`,
    })
  }

  /** Wait out any in-flight load, then fetch `scope`'s listing. */
  async function queueLoad(scope: string | null): Promise<void> {
    while (inFlight) await inFlight
    const p = (async () => {
      try {
        await refresh(scope)
      } catch (error) {
        set({ loaded: true })
        fail('load user tools', error)
      }
    })()
    inFlight = p
    try {
      await p
    } finally {
      if (inFlight === p) inFlight = null
    }
  }

  return {
    tools: [],
    workspaceId: null,
    loaded: false,
    error: null,

    ensureLoaded: async (workspaceId) => {
      /* Wait out an in-flight load first — it may resolve into exactly the
       * scope we're asking for (the early check races otherwise). */
      while (inFlight) await inFlight
      const { loaded, workspaceId: current } = get()
      if (loaded && current === workspaceId) return
      await queueLoad(workspaceId)
    },

    reload: async (workspaceId) => {
      const scope = workspaceId === undefined ? get().workspaceId : workspaceId
      await queueLoad(scope)
    },

    setEnabled: async (key, enabled) => {
      try {
        /* PATCH returns the registry, not the listing — refetch instead. */
        await apiJson<unknown>(`/api/user-tools`, {
          method: 'PATCH',
          headers: JSON_HEADERS,
          body: JSON.stringify({ key, enabled } satisfies UserToolPatch),
        })
        await refresh(get().workspaceId)
        return true
      } catch (error) {
        fail('update the tool', error)
        return false
      }
    },

    create: async (input) => {
      try {
        await apiJson<UserTool[]>('/api/user-tools', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(input),
        })
        await refresh(get().workspaceId)
        return true
      } catch (error) {
        fail('create the tool', error)
        return false
      }
    },

    remove: async (key) => {
      try {
        const scope = scopeQuery()
        const response = await apiFetch(
          `/api/user-tools?key=${encodeURIComponent(key)}${scope ? `&${scope}` : ''}`,
          { method: 'DELETE' },
        )
        if (!response.ok) throw new Error(await errorDetail(response))
        await refresh(get().workspaceId)
        return true
      } catch (error) {
        fail('delete the tool', error)
        return false
      }
    },

    readSource: async (key) => {
      try {
        const scope = scopeQuery()
        const out = await apiJson<UserToolSource>(
          `/api/user-tools/source?key=${encodeURIComponent(key)}${scope ? `&${scope}` : ''}`,
        )
        return out.source
      } catch (error) {
        fail('read the tool source', error)
        return null
      }
    },

    writeSource: async (key, source) => {
      try {
        await apiJson<UserToolSource>('/api/user-tools/source', {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify({ key, workspace_id: get().workspaceId, source }),
        })
        /* The saved source re-parses server-side — functions/error/skipped
         * may have changed, so the listing needs a refresh. */
        await refresh(get().workspaceId)
        return true
      } catch (error) {
        fail('save the tool source', error)
        return false
      }
    },

    dismissError: () => set({ error: null }),
  }
})
