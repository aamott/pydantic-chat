/**
 * Pure helpers behind the tool-profile surfaces (`ProfilePicker`,
 * `RunMetaBadge`, `PermissionsSection`, `ToolProfilesSection`).
 *
 * Wire semantics (`docs/research/tool-profiles-and-skills.md` §6):
 *
 * - `tools: null` means "all tools" — but only as the *unfiltered* state.
 *   The backend adds its `ToolAllowlist` capability only when `tools` is a
 *   list or `tool_prefixes` is non-empty, so `tools: null` combined with a
 *   partial prefix list is ambiguous. `encodeToolSelection` therefore sends
 *   `null` only when builtin tools AND MCP prefixes are all checked, and
 *   falls back to explicit lists for every other state (including the
 *   "all builtin tools, no MCP" case, which must spell out the tool names
 *   because `tools: null` + `prefixes: []` reads as "allow everything").
 * - `skills: null` means "all skills"; `[]` disables skills entirely — so
 *   skills use plain `compressSelection` and keep `[]` meaningful.
 * - Checkbox state is derived from a saved profile via `checkedFromProfile`;
 *   names absent from the catalog (removed tools/skills, disabled MCP
 *   servers) are dropped so a round-trip can't resurrect them.
 */
import type {
  ApprovalMode,
  ToolGroup,
  ToolProfile,
  ToolProfileInput,
} from '@pydantic-chat/shared'

/** Approval modes shown in the editor select, with one-line descriptions. */
export const APPROVAL_MODES: ReadonlyArray<{
  value: ApprovalMode
  name: string
  description: string
}> = [
  {
    value: 'manual',
    name: 'Manual',
    description: 'Ask before every file write and shell command.',
  },
  {
    value: 'smart',
    name: 'Smart',
    description:
      'A judge model auto-approves low-risk calls; risky ones still ask.',
  },
  {
    value: 'bypass',
    name: 'Bypass',
    description: 'Run every tool call without asking.',
  },
]

/** Group labels for the catalog's `group` field (checkbox sections). */
export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = {
  filesystem: 'Filesystem',
  shell: 'Shell',
  planning: 'Planning',
  mcp: 'MCP servers',
}

/**
 * Split a fetched profile list into builtins and customs, preserving the
 * server ordering within each group (builtins arrive first).
 */
export function partitionProfiles(profiles: readonly ToolProfile[]): {
  builtin: ToolProfile[]
  custom: ToolProfile[]
} {
  const builtin: ToolProfile[] = []
  const custom: ToolProfile[] = []
  for (const p of profiles) {
    ;(p.builtin ? builtin : custom).push(p)
  }
  return { builtin, custom }
}

/**
 * Display name for a profile id. Falls back to the raw id so renamed or
 * deleted custom profiles still render something readable.
 */
export function profileName(
  profiles: readonly ToolProfile[],
  id: string,
): string {
  return profiles.find((p) => p.id === id)?.name ?? id
}

/**
 * Compress a checkbox selection into its wire form: `null` when every
 * universe item is checked (the "all" state), else the checked names in
 * universe order. Checked names outside the universe are dropped — they
 * refer to tools/skills the catalog no longer lists.
 */
export function compressSelection(
  selected: ReadonlySet<string>,
  universe: readonly string[],
): string[] | null {
  if (universe.every((name) => selected.has(name))) return null
  return universe.filter((name) => selected.has(name))
}

/** Checked checkbox sets derived from a saved profile + the catalogs. */
export interface ProfileCheckedSets {
  tools: Set<string>
  prefixes: Set<string>
  skills: Set<string>
}

/**
 * Expand a profile's nullable allowlists into concrete checkbox sets.
 *
 * `tools: null` checks every catalog tool. `tool_prefixes` checks only the
 * listed prefixes — EXCEPT the `tools: null` + `prefixes: []` combination,
 * which is the unfiltered state and therefore means "all MCP servers too".
 * `skills: null` checks every skill; `skills: []` checks none.
 */
export function checkedFromProfile(
  profile: Pick<ToolProfile, 'tools' | 'tool_prefixes' | 'skills'>,
  toolNames: readonly string[],
  prefixNames: readonly string[],
  skillNames: readonly string[],
): ProfileCheckedSets {
  const unfiltered = profile.tools === null && profile.tool_prefixes.length === 0
  const intersect = (
    list: readonly string[],
    universe: readonly string[],
  ): Set<string> => new Set(list.filter((name) => universe.includes(name)))
  return {
    tools:
      profile.tools === null
        ? new Set(toolNames)
        : intersect(profile.tools, toolNames),
    prefixes: unfiltered
      ? new Set(prefixNames)
      : intersect(profile.tool_prefixes, prefixNames),
    skills:
      profile.skills === null
        ? new Set(skillNames)
        : intersect(profile.skills, skillNames),
  }
}

/** The `tools`/`tool_prefixes` pair a checkbox state serializes to. */
export interface EncodedToolSelection {
  tools: string[] | null
  tool_prefixes: string[]
}

/**
 * Compress checked tool + MCP-prefix sets into the wire pair.
 *
 * `tools: null` is emitted ONLY for the unfiltered state (every builtin
 * tool and every MCP prefix checked) — under the backend's
 * `ToolAllowlist`, `tools: null` plus a partial prefix list is ambiguous,
 * so any partial selection is spelled out explicitly on both sides.
 */
export function encodeToolSelection(
  checkedTools: ReadonlySet<string>,
  checkedPrefixes: ReadonlySet<string>,
  toolNames: readonly string[],
  prefixNames: readonly string[],
): EncodedToolSelection {
  const allTools = toolNames.every((name) => checkedTools.has(name))
  const allPrefixes = prefixNames.every((p) => checkedPrefixes.has(p))
  if (allTools && allPrefixes) {
    return { tools: null, tool_prefixes: [] }
  }
  return {
    tools: toolNames.filter((name) => checkedTools.has(name)),
    tool_prefixes: prefixNames.filter((p) => checkedPrefixes.has(p)),
  }
}

/**
 * Lowercase-kebab slug for a profile id from its display name — the API
 * requires `id` in the body (`[^/]+`); empty results fall back to
 * 'profile' (a 409 on collision reads clearly to the user).
 */
export function slugifyProfileId(name: string): string {
  /* Scan-free slug: collapse each non-alnum run into one dash; leading
   * runs emit nothing, trailing runs die in `pendingDash` — no regex, no
   * backtracking (sonar S5852 flags the replace chain otherwise). */
  let slug = ''
  let pendingDash = false
  for (const ch of name.toLowerCase()) {
    const alnum = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')
    if (!alnum) {
      pendingDash = slug.length > 0
      continue
    }
    if (pendingDash) slug += '-'
    pendingDash = false
    slug += ch
  }
  return slug || 'profile'
}

/**
 * POST/PUT body for a profile — the editable fields plus `id` (the API
 * requires it; PUT's path id wins over the body's anyway).
 */
export function profileToInput(profile: ToolProfile): ToolProfileInput {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    approval_mode: profile.approval_mode,
    workspace_read_only: profile.workspace_read_only,
    tools: profile.tools,
    tool_prefixes: profile.tool_prefixes,
    skills: profile.skills,
  }
}

/**
 * POST body for "Duplicate" — the source's content under a derived id
 * (`<id>-copy`), with a " copy" suffix so the new row reads as a derivative.
 */
export function duplicateDraft(profile: ToolProfile): ToolProfileInput {
  return {
    ...profileToInput(profile),
    id: `${profile.id}-copy`,
    name: `${profile.name} copy`,
  }
}

/** Blank editor state for "New profile" — safe defaults, allow everything. */
export function emptyProfileDraft(): ToolProfileInput {
  return {
    name: '',
    description: '',
    approval_mode: 'manual',
    workspace_read_only: false,
    tools: null,
    tool_prefixes: [],
    skills: null,
  }
}
