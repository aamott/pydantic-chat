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
 * `default_model`/`judge_model` are `provider:model` specs; `judge_model`
 * is `null` unless an explicit judge is set — the null means the smart
 * profile judges with the run's own model.
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
  judge_model: string | null
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
/* MCP servers API contract (/api/mcp-servers)                         */
/* ------------------------------------------------------------------ */

/** Transport kinds the backend can build a pydantic-ai `MCPToolset` for. */
export type McpTransport = 'stdio' | 'http'

/**
 * One registered MCP server (`GET /api/mcp-servers` row, `POST` body).
 * `stdio` launches `command` with `args`/`env`; `http` connects to `url`
 * with optional `headers`. `env`/`headers` may hold secrets — they are
 * stored server-side and echoed back for editing, never logged.
 */
export interface McpServer {
  /** Unique key — also the tool-name prefix and PATCH/DELETE path segment. */
  name: string
  transport: McpTransport
  command?: string | null
  args?: string[]
  env?: Record<string, string> | null
  url?: string | null
  headers?: Record<string, string> | null
  enabled: boolean
}

/**
 * `PATCH /api/mcp-servers/{name}` body — merge semantics; unset fields keep
 * their stored values, an explicit `null` clears an optional field.
 * `transport` is immutable (delete + re-add to change it).
 */
export interface McpServerPatch {
  name?: string
  command?: string | null
  args?: string[] | null
  env?: Record<string, string> | null
  url?: string | null
  headers?: Record<string, string> | null
  enabled?: boolean
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
/* Tool profiles API contract (/api/tool-profiles + /api/tool-catalog) */
/* ------------------------------------------------------------------ */

/**
 * How eagerly a profile runs tool calls without asking; maps to the
 * backend's `Permissions` capability modes (full / auto / read-only).
 * `smart` additionally binds an `ApprovalReviewer` judge.
 */
export type ApprovalMode = 'bypass' | 'smart' | 'manual'

/**
 * One permission profile (`GET /api/tool-profiles` row).
 *
 * `id` is the value stored in `permission_profile` fields — builtin ids
 * keep the legacy literals (`bypass`/`smart`/`manual`/`read-only`), custom
 * profiles get a server-assigned slug. `tools: null` means "all tools";
 * `tool_prefixes` allowlists whole MCP servers by their `{server}_`
 * name prefix; `skills: null` means "all discovered skills" while `[]`
 * disables skills entirely.
 */
export interface ToolProfile {
  id: string
  name: string
  description: string
  approval_mode: ApprovalMode
  workspace_read_only: boolean
  tools: string[] | null
  tool_prefixes: string[]
  skills: string[] | null
  /** Server-owned constant — PUT/DELETE on builtins return 403/409. */
  builtin: boolean
}

/**
 * `POST /api/tool-profiles` / `PUT /api/tool-profiles/{id}` body — the
 * profile shape minus `builtin`; `id` is optional on POST (the server may
 * assign a slug from `name`) and redundant on PUT (the path carries it).
 */
export interface ToolProfileInput {
  id?: string
  name: string
  description: string
  approval_mode: ApprovalMode
  workspace_read_only: boolean
  tools: string[] | null
  tool_prefixes: string[]
  skills: string[] | null
}

/** Capability-group a catalog tool belongs to ('mcp' = a `{server}_*` prefix row). */
export type ToolGroup = 'filesystem' | 'shell' | 'planning' | 'mcp'

/**
 * One selectable item in `GET /api/tool-catalog`. Builtin tools match a
 * profile's `tools`; `prefix: true` rows (`name` like `github_*`) match a
 * profile's `tool_prefixes` — store the prefix without the trailing `*`.
 */
export interface ToolCatalogEntry {
  name: string
  description: string
  group: ToolGroup
  prefix: boolean
}

/** `GET /api/tool-catalog` — the editor's checkbox universe, flat list. */
export type ToolCatalog = ToolCatalogEntry[]

/* ------------------------------------------------------------------ */
/* Skills API contract (GET /api/skills)                               */
/* ------------------------------------------------------------------ */

/** Where a skill's SKILL.md directory was discovered. */
export type SkillOrigin = 'system' | 'workspace'

/** One discovered skill in `GET /api/skills`. */
export interface SkillInfo {
  name: string
  description: string
  origin: SkillOrigin
  path: string
  model_invocable: boolean
  user_invocable: boolean
}

/** A `SKILL.md` the loader skipped, with the reason — diagnostics only. */
export interface SkippedSkill {
  path: string
  reason: string
  message: string
}

export interface SkillsOut {
  skills: SkillInfo[]
  skipped: SkippedSkill[]
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
  /** settings window → main → other renderers: theme applied live. */
  settingsTheme: 'settings:theme',
} as const
