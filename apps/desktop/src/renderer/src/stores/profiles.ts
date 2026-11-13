/**
 * Tool-profile catalog for the composer pickers, the settings permission
 * section, and `RunMetaBadge`'s id→name lookup.
 *
 * `GET /api/tool-profiles` returns builtins + customs (builtins first).
 * CRUD goes through POST/PUT/DELETE on the same resource; each successful
 * write triggers a plain refetch rather than optimistic merging — the
 * server owns slug assignment and builtin rows, so the list is the only
 * source of truth worth keeping.
 *
 * The endpoint can 404 while the backend contract lands — `load` tolerates
 * that (`profiles: []`, error text kept for callers that want it) so the
 * pickers degrade to raw ids instead of breaking.
 */
import { create } from 'zustand'
import type { ToolProfile, ToolProfileInput } from '@pydantic-chat/shared'
import { apiFetch, apiJson } from '../lib/api'
import { slugifyProfileId } from '../lib/profiles'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/**
 * Extract FastAPI's `detail` from an error response, falling back to the
 * status line — mirrors `apiJson`'s mapping for the apiFetch call sites.
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

interface ProfilesState {
  /** Builtin + custom profiles, builtins first; `[]` until/unless fetched. */
  profiles: ToolProfile[]
  /** True once `ensureLoaded` settled (success or tolerated failure). */
  loaded: boolean
  /** Last failure text (load or write); null when healthy. */
  error: string | null

  /**
   * Fetch the list once per session. Safe to call from every consumer
   * mount — dedupes via an in-flight flag.
   */
  ensureLoaded: () => Promise<void>
  /** Force a refetch (retry after an error, or after a write elsewhere). */
  reload: () => Promise<void>
  /**
   * POST (`existingId === null`) or PUT a profile, then refetch.
   * Returns false and stores the error text on failure.
   */
  save: (input: ToolProfileInput, existingId: string | null) => Promise<boolean>
  /** DELETE a custom profile, then refetch; false on failure. */
  remove: (id: string) => Promise<boolean>
  /** Clear the stored error text. */
  dismissError: () => void
}

/** Guards `ensureLoaded`/`reload` only — writes refetch unconditionally. */
let inFlight = false

export const useProfilesStore = create<ProfilesState>()((set, get) => {
  /** Replace the list from a fresh GET (post-write refresh path). */
  async function refresh(): Promise<void> {
    const profiles = await apiJson<ToolProfile[]>('/api/tool-profiles')
    set({ profiles, loaded: true, error: null })
  }

  return {
    profiles: [],
    loaded: false,
    error: null,

    ensureLoaded: async () => {
      if (get().loaded || inFlight) return
      await get().reload()
    },

    reload: async () => {
      if (inFlight) return
      inFlight = true
      try {
        await refresh()
      } catch (error) {
        set({
          loaded: true,
          error:
            error instanceof Error
              ? `Couldn't load tool profiles: ${error.message}`
              : "Couldn't load tool profiles",
        })
      } finally {
        inFlight = false
      }
    },

    save: async (input, existingId) => {
      try {
        /* The API requires `id` in the body on POST (PUT's path wins over
         * it anyway) — fall back to a slug of the display name. */
        const id = existingId ?? (input.id?.trim() || slugifyProfileId(input.name))
        const response = await apiFetch(
          existingId === null
            ? '/api/tool-profiles'
            : `/api/tool-profiles/${encodeURIComponent(existingId)}`,
          {
            method: existingId === null ? 'POST' : 'PUT',
            headers: JSON_HEADERS,
            body: JSON.stringify({ ...input, id }),
          },
        )
        if (!response.ok) throw new Error(await errorDetail(response))
        await refresh()
        return true
      } catch (error) {
        set({
          error:
            error instanceof Error
              ? `Couldn't save profile: ${error.message}`
              : "Couldn't save profile",
        })
        return false
      }
    },

    remove: async (id) => {
      try {
        const response = await apiFetch(
          `/api/tool-profiles/${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        )
        if (!response.ok) throw new Error(await errorDetail(response))
        await refresh()
        return true
      } catch (error) {
        set({
          error:
            error instanceof Error
              ? `Couldn't delete profile: ${error.message}`
              : "Couldn't delete profile",
        })
        return false
      }
    },

    dismissError: () => set({ error: null }),
  }
})
