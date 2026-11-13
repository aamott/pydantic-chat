/** Shared types mirroring the FastAPI API contract. */

export interface Workspace {
  id: string
  path: string
  display_name: string
  last_chat_id: string | null
  last_opened_at: number
  /** Per-workspace permission override; null/absent inherits the global setting. */
  permission_profile?: string | null
  missing?: boolean
  chats?: ChatSummary[]
}

export interface ChatSummary {
  id: string
  workspace_id: string
  title: string
  updated_at: number
  /**
   * Per-chat `provider:model` override; null/absent uses the settings
   * default. `thinking`/`permission_profile` are the matching per-chat
   * overrides — null means "inherit". Optional because pre-migration
   * backends may omit them entirely; treat absent as null.
   */
  model?: string | null
  thinking?: string | null
  permission_profile?: string | null
}

/* ------------------------------------------------------------------ */
/* Settings API contract (apps/backend/app/api/settings.py)           */
/* ------------------------------------------------------------------ */

/**
 * `GET /api/settings` response — every non-secret app setting, fully
 * populated (missing rows fall back to app defaults server-side).
 * `default_model`/`judge_model` are `provider:model` specs.
 */
export interface AppSettings {
  theme: string
  default_model: string
  permission_profile: string
  allowed_commands: string[]
  denied_commands: string[]
  allowed_patterns: string[]
  denied_patterns: string[]
  ollama_base_url: string
  judge_model: string
}

/**
 * `GET /api/settings/providers` row — one provider's credential status.
 * Never carries key material; `has_key`/`source` only describe the secret's
 * presence and origin (`secrets.json` file vs environment variable).
 */
export interface ProviderStatus {
  provider: string
  /** The provider can resolve a model right now (ollama needs no key). */
  configured: boolean
  has_key: boolean
  source: 'file' | 'env' | null
}

/* ------------------------------------------------------------------ */
/* Models API contract (GET /api/models)                               */
/* ------------------------------------------------------------------ */

/** One selectable model inside a `ModelProviderGroup`. */
export interface ModelInfo {
  /** `provider:model` spec, e.g. `anthropic:claude-sonnet-4-6`. */
  id: string
  /** Display name, e.g. `Claude Sonnet 4.6`. */
  name: string
  /** Thinking levels the model supports (`[]` when it has none). */
  thinking_levels: string[]
  /** Context window in tokens, when known. */
  max_context: number | null
}

/** `GET /api/models` — one entry per configured provider. */
export interface ModelProviderGroup {
  provider: string
  /** Human label, e.g. `Anthropic`. */
  label: string
  models: ModelInfo[]
}

export interface ModelsOut {
  providers: ModelProviderGroup[]
}

/* ------------------------------------------------------------------ */
/* IPC surface: Electron main ↔ preload ↔ renderer                    */
/* ------------------------------------------------------------------ */

/** Loopback connection details for the FastAPI sidecar. */
export interface BackendInfo {
  url: string
  token: string
}

/** Lifecycle state of the supervised backend process. */
export type BackendStatus =
  | { state: 'starting' }
  | { state: 'ready' }
  | { state: 'restarting'; attempt: number }
  | { state: 'failed'; error: string }

/** Channel names shared by `ipcMain`/`ipcRenderer` call sites. */
export const IpcChannels = {
  backendInfo: 'backend:info',
  pickWorkspace: 'dialog:pickWorkspace',
  settingsOpen: 'settings:open',
  /** main → renderer: File ▸ Open Workspace… was triggered. */
  menuOpenWorkspace: 'menu:open-workspace',
  /** main → renderer: sidecar lifecycle status broadcast. */
  backendStatus: 'backend:status',
} as const
