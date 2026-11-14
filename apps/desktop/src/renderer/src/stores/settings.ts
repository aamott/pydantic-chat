/**
 * Settings-window state: the `GET /api/settings` draft plus provider status.
 *
 * The form edits `settings` (a draft); `saved` is the last-known persisted
 * snapshot and the revert target — `dirty` is a deep compare of the two, so
 * patching a key back to its saved value clears the flag again.
 *
 * Secrets never enter this store: key/base-url writes go straight through
 * `PUT /api/settings/secrets/{provider}` (`saveSecret`) and only the
 * resulting `ProviderStatus` rows are kept. `ollama_base_url` is the one
 * exception — it lives in `AppSettings` but is written immediately by the
 * API Keys section (same secrets.json storage as the secrets route), so
 * `save()` deliberately omits it from the PUT body to avoid a stale draft
 * clobbering a just-saved URL.
 */
import { create } from 'zustand'
import type { AppSettings, ProviderStatus } from '@pydantic-chat/shared'
import { apiFetch, apiJson } from '../lib/api'
import { applyTheme } from '../lib/theme'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** Apply locally AND relay to the other windows via the main process. */
function applyThemeLive(theme: string): void {
  applyTheme(theme)
  window.api.notifyTheme(theme)
}

/** Body for a secrets PUT — at least one field required by the backend. */
export interface SecretPatch {
  key?: string
  base_url?: string
}

/** Draft-vs-persisted compare; both are flat JSON-safe objects. */
function isDirty(settings: AppSettings | null, saved: AppSettings | null): boolean {
  return (
    settings !== null &&
    saved !== null &&
    JSON.stringify(settings) !== JSON.stringify(saved)
  )
}

interface SettingsState {
  /** Draft settings the form edits; null until `load` resolves. */
  settings: AppSettings | null
  /** Last persisted snapshot — the revert target. */
  saved: AppSettings | null
  /** Per-provider credential status (never key material). */
  providers: ProviderStatus[]
  /** True once the initial `load` has settled (success or failure). */
  loaded: boolean
  /** Draft differs from `saved`. */
  dirty: boolean
  /** A `save` request is in flight. */
  saving: boolean
  /** Load/save failure text for the inline banner; null when healthy. */
  error: string | null
  /** Timestamp of the last successful save (drives the "Saved" flash). */
  savedAt: number | null

  /** GET settings + providers; applies the persisted theme immediately. */
  load: () => Promise<void>
  /** Refresh only the provider credential rows (after a secret write). */
  loadProviders: () => Promise<void>
  /** Update one draft key; `theme` is applied to the document live. */
  patch: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  /** PUT the draft; on success `saved`/`settings` adopt the response. */
  save: () => Promise<void>
  /** Discard the draft and restore `saved` (reverting a live theme too). */
  revert: () => void
  /**
   * Store a provider API key and/or base URL via the secrets route.
   * Throws on failure so the calling row can show the detail inline.
   */
  saveSecret: (provider: string, body: SecretPatch) => Promise<void>
  /** Remove a provider's stored credential material (DELETE → 204). */
  clearSecret: (provider: string) => Promise<void>
  /** Clear the banner. */
  dismissError: () => void
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: null,
  saved: null,
  providers: [],
  loaded: false,
  dirty: false,
  saving: false,
  error: null,
  savedAt: null,

  load: async () => {
    try {
      const [settings, providers] = await Promise.all([
        apiJson<AppSettings>('/api/settings'),
        apiJson<ProviderStatus[]>('/api/settings/providers'),
      ])
      set({ settings, saved: settings, providers, loaded: true, dirty: false, error: null })
      applyTheme(settings.theme)
    } catch (error) {
      set({
        loaded: true,
        error: error instanceof Error ? `Couldn't load settings: ${error.message}` : "Couldn't load settings",
      })
    }
  },

  loadProviders: async () => {
    try {
      const providers = await apiJson<ProviderStatus[]>('/api/settings/providers')
      set({ providers })
    } catch {
      /* keep the last good list — the row-level error already surfaced */
    }
  },

  patch: (key, value) => {
    const settings = get().settings
    if (!settings) return
    const next = { ...settings, [key]: value }
    if (key === 'theme') applyThemeLive(value as string)
    set({ settings: next, dirty: isDirty(next, get().saved), savedAt: null })
  },

  save: async () => {
    const settings = get().settings
    if (!settings || get().saving) return
    set({ saving: true, error: null })
    try {
      // ollama_base_url is owned by the API Keys section (immediate save
      // through the secrets route) — sending the draft copy could overwrite
      // a URL stored moments ago.
      const { ollama_base_url: _ollamaOwnedBySecrets, ...payload } = settings
      const persisted = await apiJson<AppSettings>('/api/settings', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
      })
      set({
        settings: persisted,
        saved: persisted,
        dirty: false,
        saving: false,
        savedAt: Date.now(),
      })
      applyThemeLive(persisted.theme)
    } catch (error) {
      set({
        saving: false,
        error: error instanceof Error ? `Couldn't save settings: ${error.message}` : "Couldn't save settings",
      })
    }
  },

  revert: () => {
    const saved = get().saved
    if (!saved) return
    set({ settings: saved, dirty: false, error: null })
    applyThemeLive(saved.theme)
  },

  saveSecret: async (provider, body) => {
    await apiJson<ProviderStatus>(`/api/settings/secrets/${provider}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    })
    // Siblings share credentials (openai/openai-chat, google/google-cloud)
    // so a single write can change several rows — refresh them all.
    await get().loadProviders()
    // Keep the draft in step when the Ollama base URL moves through the
    // secrets route; both copies update so `dirty` stays honest.
    if (provider === 'ollama' && body.base_url) {
      const sync = (s: AppSettings | null): AppSettings | null =>
        s ? { ...s, ollama_base_url: body.base_url ?? s.ollama_base_url } : s
      set((state) => ({
        settings: sync(state.settings),
        saved: sync(state.saved),
      }))
    }
  },

  clearSecret: async (provider) => {
    const response = await apiFetch(`/api/settings/secrets/${provider}`, {
      method: 'DELETE',
    })
    if (!response.ok) {
      throw new Error(`Failed to clear ${provider} credentials (${response.status})`)
    }
    await get().loadProviders()
  },

  dismissError: () => set({ error: null }),
}))
