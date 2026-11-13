/**
 * Model catalog + app-level defaults for the composer's pickers.
 *
 * `GET /api/models` returns the configured providers and their models
 * (`provider:model` specs, thinking levels, context windows); `GET
 * /api/settings` supplies the fallback `default_model` and the global
 * `permission_profile` a chat inherits when it sets no override.
 *
 * The catalog endpoint can 404 while the backend contract lands — the
 * store tolerates that (empty `providers`, defaults still applied) so the
 * composer keeps rendering the chat's current model instead of breaking.
 */
import { create } from 'zustand'
import type {
  AppSettings,
  ModelProviderGroup,
  ModelsOut,
} from '@pydantic-chat/shared'
import { apiFetch, apiJson } from '../lib/api'

/** Used when `/api/settings` can't be read — matches the backend default. */
const FALLBACK_DEFAULT_MODEL = 'anthropic:claude-sonnet-4-6'
const FALLBACK_PROFILE = 'manual'

interface ModelsState {
  /** Configured providers with their models; `[]` until/unless fetched. */
  providers: ModelProviderGroup[]
  /** Settings `default_model` — the spec new/inheriting chats run on. */
  defaultModel: string
  /** Global `permission_profile` — bottom of the inherit chain. */
  globalProfile: string
  /** True once `ensureLoaded` settled (success or tolerated failure). */
  loaded: boolean
  /** Non-fatal load failure text (the pickers show it as a muted note). */
  error: string | null

  /**
   * Fetch the catalog + settings once per session. Safe to call from every
   * picker mount — dedupes via an in-flight flag.
   */
  ensureLoaded: () => Promise<void>
  /** Force a refetch (e.g. retry after an error). */
  reload: () => Promise<void>
}

let inFlight = false

export const useModelsStore = create<ModelsState>()((set, get) => ({
  providers: [],
  defaultModel: FALLBACK_DEFAULT_MODEL,
  globalProfile: FALLBACK_PROFILE,
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
      const [settings, providers] = await Promise.all([
        apiJson<AppSettings>('/api/settings'),
        // Tolerate a missing/failed catalog: the pickers degrade to showing
        // the chat's own model + the settings default.
        apiFetch('/api/models')
          .then(async (res) =>
            res.ok ? ((await res.json()) as ModelsOut).providers : [],
          )
          .catch(() => [] as ModelProviderGroup[]),
      ])
      set({
        providers,
        defaultModel: settings.default_model || FALLBACK_DEFAULT_MODEL,
        globalProfile: settings.permission_profile || FALLBACK_PROFILE,
        loaded: true,
        error: null,
      })
    } catch (error) {
      set({
        loaded: true,
        error:
          error instanceof Error
            ? `Couldn't load models: ${error.message}`
            : "Couldn't load models",
      })
    } finally {
      inFlight = false
    }
  },
}))
