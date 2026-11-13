/**
 * Tool profiles settings: CRUD for the permission profiles that appear in
 * the composer picker and the Permissions default.
 *
 * Profiles live server-side (`settings['tool_profiles']` for customs,
 * constants for builtins) and are managed through `/api/tool-profiles` —
 * writes take effect immediately (like the MCP Servers section), not
 * through the AppSettings draft. Builtins are read-only; "Duplicate"
 * copies one into an editable custom row.
 *
 * Checkbox semantics (`lib/profiles.ts`): `tools`/`skills` null-compress
 * to "all"; MCP prefixes allowlist whole servers by `{server}_*`; the
 * unfiltered state is `tools: null` + `prefixes: []`, so partial selections
 * always go on the wire as explicit lists.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Lock,
  Plus,
  Trash2,
} from 'lucide-react'
import type {
  ApprovalMode,
  SkillInfo,
  SkillsOut,
  ToolCatalog,
  ToolGroup,
  ToolProfile,
  ToolProfileInput,
} from '@pydantic-chat/shared'
import { apiJson } from '../../../lib/api'
import {
  APPROVAL_MODES,
  checkedFromProfile,
  compressSelection,
  duplicateDraft,
  encodeToolSelection,
  TOOL_GROUP_LABELS,
} from '../../../lib/profiles'
import { useProfilesStore } from '../../../stores/profiles'
import {
  Field,
  SectionHeading,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '../components'

/** Error.message or a generic fallback for row-level failures. */
function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** Catalog groups rendered in a stable order. */
const TOOL_GROUP_ORDER: ToolGroup[] = ['filesystem', 'shell', 'planning']

/**
 * The one expanded row's state. `id`/`readOnly` are meta (which profile,
 * whether it's a builtin view); the rest is the editable content.
 * `tools`/`prefixes`/`skills` are CHECKED sets — compressed to the wire's
 * nullable lists only at save time.
 */
interface DraftState {
  /** Source profile id; `null` while creating a new profile. */
  id: string | null
  /** Builtin rows expand read-only — edits start from Duplicate. */
  readOnly: boolean
  name: string
  description: string
  approval_mode: ApprovalMode
  workspace_read_only: boolean
  tools: Set<string>
  prefixes: Set<string>
  skills: Set<string>
}

export function ToolProfilesSection(): React.JSX.Element {
  const profiles = useProfilesStore((s) => s.profiles)
  const loaded = useProfilesStore((s) => s.loaded)
  const storeError = useProfilesStore((s) => s.error)
  const ensureLoaded = useProfilesStore((s) => s.ensureLoaded)
  const save = useProfilesStore((s) => s.save)
  const remove = useProfilesStore((s) => s.remove)

  const [catalog, setCatalog] = useState<ToolCatalog | null>(null)
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftState | null>(null)
  /** Id of a profile with an in-flight duplicate/delete, or true for save. */
  const [busy, setBusy] = useState<string | boolean>(false)

  /* The catalog is flat: `prefix: false` rows are builtin tools (match
   * `tools`), `prefix: true` rows are `{server}_*` MCP entries (match
   * `tool_prefixes` — stored without the `*`, matching ToolAllowlist's
   * startswith). */
  const toolNames = (catalog ?? [])
    .filter((e) => !e.prefix)
    .map((e) => e.name)
  const prefixNames = (catalog ?? [])
    .filter((e) => e.prefix)
    .map((e) => e.name.replace(/\*$/, ''))
  const skillNames = (skills ?? []).map((s) => s.name)
  const catalogsReady = catalog !== null && skills !== null

  const loadCatalogs = useCallback(async () => {
    try {
      const [cat, sk] = await Promise.all([
        apiJson<ToolCatalog>('/api/tool-catalog'),
        apiJson<SkillsOut>('/api/skills'),
      ])
      setCatalog(cat)
      setSkills(sk.skills)
      setError(null)
    } catch (e) {
      setError(errorText(e, "Couldn't load the tool catalog"))
    }
  }, [])

  useEffect(() => {
    void ensureLoaded()
    void loadCatalogs()
  }, [ensureLoaded, loadCatalogs])

  /** Expand a profile row — builtins open read-only. */
  const openProfile = (profile: ToolProfile): void => {
    if (draft?.id === profile.id) {
      setDraft(null)
      return
    }
    const checked = checkedFromProfile(profile, toolNames, prefixNames, skillNames)
    setDraft({
      id: profile.id,
      readOnly: profile.builtin,
      name: profile.name,
      description: profile.description,
      approval_mode: profile.approval_mode,
      workspace_read_only: profile.workspace_read_only,
      ...checked,
    })
  }

  /** "New profile" — blank custom draft, everything allowed by default. */
  const openNew = (): void => {
    setDraft({
      id: null,
      readOnly: false,
      name: '',
      description: '',
      approval_mode: 'manual',
      workspace_read_only: false,
      tools: new Set(toolNames),
      prefixes: new Set(prefixNames),
      skills: new Set(skillNames),
    })
  }

  /** POST the profile's content under a " copy" name. */
  const duplicate = async (profile: ToolProfile): Promise<void> => {
    setBusy(profile.id)
    await save(duplicateDraft(profile), null)
    setBusy(false)
  }

  /** POST (new) or PUT (custom) the draft, then close it. */
  const submit = async (): Promise<void> => {
    if (!draft || draft.readOnly || busy) return
    const { tools, tool_prefixes } = encodeToolSelection(
      draft.tools,
      draft.prefixes,
      toolNames,
      prefixNames,
    )
    const input: ToolProfileInput = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      approval_mode: draft.approval_mode,
      workspace_read_only: draft.workspace_read_only,
      tools,
      tool_prefixes,
      skills: compressSelection(draft.skills, skillNames),
    }
    setBusy(true)
    const ok = await save(input, draft.id)
    setBusy(false)
    if (ok) setDraft(null)
  }

  const removeProfile = async (id: string): Promise<void> => {
    setBusy(id)
    const ok = await remove(id)
    setBusy(false)
    if (ok && draft?.id === id) setDraft(null)
  }

  const banner = error ?? storeError

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Tool profiles"
        description="Named bundles of approval mode + tool/skill allowlists. Profiles are selectable per chat in the composer and as the global default under Permissions; changes apply to the next run."
      />
      {banner && (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {banner}
        </p>
      )}
      <Field
        label="Profiles"
        hint="Expand a row to view or edit. Built-in profiles are read-only — duplicate one to customize it."
        keywords="tool profile profiles permission custom builtin duplicate approval tools skills mcp allowlist"
      >
        {!loaded || !catalogsReady ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Loading…
          </p>
        ) : (
          <ul className="space-y-2">
            {profiles.map((profile) => (
              <li
                key={profile.id}
                className="rounded-md border border-neutral-200 dark:border-neutral-700"
              >
                {draft?.id === profile.id ? (
                  <ProfileEditor
                    draft={draft}
                    onChange={(fn) =>
                      setDraft((d) => (d ? fn(d) : d))
                    }
                    catalog={catalog}
                    skills={skills ?? []}
                    busy={busy === true || busy === profile.id}
                    onSave={() => void submit()}
                    onDelete={() => void removeProfile(profile.id)}
                    onDuplicate={() => void duplicate(profile)}
                    onClose={() => setDraft(null)}
                  />
                ) : (
                  <ProfileRow
                    profile={profile}
                    busy={busy === profile.id}
                    onToggle={() => openProfile(profile)}
                    onDuplicate={() => void duplicate(profile)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {catalogsReady && !draft && (
          <button
            type="button"
            onClick={openNew}
            className={`${secondaryButtonClass} mt-2 inline-flex items-center gap-1.5`}
          >
            <Plus className="h-4 w-4" />
            New profile
          </button>
        )}
      </Field>

      {/* The new-profile form renders below the list (same pattern as the
          MCP server add form). */}
      {draft?.id === null && (
        <div className="rounded-md border border-neutral-200 dark:border-neutral-700">
          <ProfileEditor
            draft={draft}
            onChange={(fn) => setDraft((d) => (d ? fn(d) : d))}
            catalog={catalog}
            skills={skills ?? []}
            busy={busy === true}
            onSave={() => void submit()}
            onClose={() => setDraft(null)}
          />
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Collapsed row                                                       */
/* ------------------------------------------------------------------ */

function ProfileRow({
  profile,
  busy,
  onToggle,
  onDuplicate,
}: {
  profile: ToolProfile
  busy: boolean
  onToggle: () => void
  onDuplicate: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={false}
        aria-label={`Expand ${profile.name}`}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">
              {profile.name}
            </span>
            {profile.builtin ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                <Lock className="h-3 w-3" />
                built-in
              </span>
            ) : (
              <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600 dark:bg-blue-950/60 dark:text-blue-300">
                custom
              </span>
            )}
            <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
              {profile.approval_mode}
            </span>
          </span>
          {profile.description && (
            <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">
              {profile.description}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={onDuplicate}
        disabled={busy}
        aria-label={`Duplicate ${profile.name}`}
        title="Duplicate as a custom profile"
        className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      >
        <Copy className="h-4 w-4" />
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Expanded editor (read-only for builtins)                            */
/* ------------------------------------------------------------------ */

interface ProfileEditorProps {
  draft: DraftState
  /** Apply a pure update to the draft (no-op while closed). */
  onChange: (fn: (draft: DraftState) => DraftState) => void
  catalog: ToolCatalog | null
  skills: SkillInfo[]
  busy: boolean
  onSave: () => void
  onClose: () => void
  onDelete?: () => void
  onDuplicate?: () => void
}

function ProfileEditor({
  draft,
  onChange,
  catalog,
  skills,
  busy,
  onSave,
  onClose,
  onDelete,
  onDuplicate,
}: ProfileEditorProps): React.JSX.Element {
  const readOnly = draft.readOnly
  const toolNames = (catalog ?? [])
    .filter((e) => !e.prefix)
    .map((e) => e.name)
  const skillNames = skills.map((s) => s.name)

  const toggle =
    (key: 'tools' | 'prefixes' | 'skills') =>
    (name: string): void => {
      onChange((d) => {
        const next = new Set(d[key])
        if (next.has(name)) {
          next.delete(name)
        } else {
          next.add(name)
        }
        return { ...d, [key]: next }
      })
    }

  const setAll =
    (key: 'tools' | 'prefixes' | 'skills', names: readonly string[]) =>
    (checked: boolean): void => {
      onChange((d) => ({ ...d, [key]: checked ? new Set(names) : new Set() }))
    }

  const groups = TOOL_GROUP_ORDER.map((group) => ({
    group,
    entries: (catalog ?? []).filter((e) => e.group === group),
  })).filter((g) => g.entries.length > 0)

  return (
    <div className="space-y-3 px-3 py-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
          {draft.id === null
            ? 'New profile'
            : readOnly
              ? `${draft.name} (built-in)`
              : `Edit ${draft.name}`}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Collapse"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      {readOnly && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Built-in profiles can’t be edited — duplicate this one to customize
          a copy.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            Name
          </span>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => onChange((d) => ({ ...d, name: e.target.value }))}
            disabled={readOnly}
            placeholder="e.g. Reviewer"
            className={inputClass}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            Description
          </span>
          <input
            type="text"
            value={draft.description}
            onChange={(e) =>
              onChange((d) => ({ ...d, description: e.target.value }))
            }
            disabled={readOnly}
            placeholder="What this profile is for"
            className={inputClass}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            Approval mode
          </span>
          <select
            value={draft.approval_mode}
            onChange={(e) =>
              onChange((d) => ({
                ...d,
                approval_mode: e.target.value as ApprovalMode,
              }))
            }
            disabled={readOnly}
            className={inputClass}
          >
            {APPROVAL_MODES.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.name}
              </option>
            ))}
          </select>
          <span className="block text-xs text-neutral-400">
            {
              APPROVAL_MODES.find((m) => m.value === draft.approval_mode)
                ?.description
            }
          </span>
        </label>
        <label className="flex items-start gap-2 pt-5">
          <input
            type="checkbox"
            checked={draft.workspace_read_only}
            onChange={(e) =>
              onChange((d) => ({ ...d, workspace_read_only: e.target.checked }))
            }
            disabled={readOnly}
            className="mt-0.5 accent-blue-600"
          />
          <span className="text-sm text-neutral-700 dark:text-neutral-300">
            Read-only workspace
            <span className="block text-xs text-neutral-400">
              Mount the workspace read-only so file writes fail outright.
            </span>
          </span>
        </label>
      </div>

      {/* Builtin tool checkboxes, grouped by catalog group. */}
      <div className="space-y-1.5">
        <MasterCheckbox
          label="All tools"
          names={toolNames}
          checked={draft.tools}
          disabled={readOnly}
          onSetAll={setAll('tools', toolNames)}
        />
        <div className="space-y-2 pl-6">
          {groups.map(({ group, entries }) => (
            <div key={group}>
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                {TOOL_GROUP_LABELS[group]}
              </span>
              <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
                {entries.map((tool) => (
                  <CheckItem
                    key={tool.name}
                    name={tool.name}
                    hint={tool.description}
                    checked={draft.tools.has(tool.name)}
                    disabled={readOnly}
                    onToggle={() => toggle('tools')(tool.name)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* MCP server prefix checkboxes — one per enabled server. */}
      <div className="space-y-1.5">
        <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
          MCP servers
        </span>
        {(catalog ?? []).filter((e) => e.prefix).length === 0 ? (
          <p className="pl-6 text-xs text-neutral-400">
            No MCP servers enabled.
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-x-3 gap-y-1 pl-6">
            {(catalog ?? [])
              .filter((e) => e.prefix)
              .map((entry) => {
                /* `entry.name` is `server_*`; the stored prefix is `server_`. */
                const prefix = entry.name.replace(/\*$/, '')
                return (
                  <CheckItem
                    key={entry.name}
                    name={entry.name.replace(/_\*$/, '')}
                    hint={entry.name}
                    checked={draft.prefixes.has(prefix)}
                    disabled={readOnly}
                    onToggle={() => toggle('prefixes')(prefix)}
                  />
                )
              })}
          </ul>
        )}
      </div>

      {/* Skill checkboxes — null-compresses like tools. */}
      <div className="space-y-1.5">
        {skills.length === 0 ? (
          <>
            <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
              Skills
            </span>
            <p className="pl-6 text-xs text-neutral-400">
              No skills discovered.
            </p>
          </>
        ) : (
          <>
            <MasterCheckbox
              label="All skills"
              names={skillNames}
              checked={draft.skills}
              disabled={readOnly}
              onSetAll={setAll('skills', skillNames)}
            />
            <ul className="grid grid-cols-2 gap-x-3 gap-y-1 pl-6">
              {skills.map((skill) => (
                <CheckItem
                  key={`${skill.origin}:${skill.name}`}
                  name={skill.name}
                  hint={skill.description}
                  badge={skill.origin}
                  checked={draft.skills.has(skill.name)}
                  disabled={readOnly}
                  onToggle={() => toggle('skills')(skill.name)}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="flex gap-2 pt-1">
        {readOnly ? (
          <>
            {onDuplicate && (
              <button
                type="button"
                onClick={onDuplicate}
                disabled={busy}
                className={primaryButtonClass}
              >
                Duplicate
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className={secondaryButtonClass}
            >
              Close
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onSave}
              disabled={!draft.name.trim() || busy}
              className={primaryButtonClass}
            >
              {draft.id === null ? 'Create' : 'Save'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                disabled={busy}
                className={`${secondaryButtonClass} inline-flex items-center gap-1.5 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40`}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Checkbox primitives                                                  */
/* ------------------------------------------------------------------ */

/**
 * "All X" master checkbox: checked when every name is checked,
 * indeterminate on a partial selection; toggling sets/clears the lot.
 */
function MasterCheckbox({
  label,
  names,
  checked,
  disabled,
  onSetAll,
}: {
  label: string
  names: readonly string[]
  checked: ReadonlySet<string>
  disabled: boolean
  onSetAll: (checked: boolean) => void
}): React.JSX.Element {
  const all = names.every((name) => checked.has(name))
  const some = names.some((name) => checked.has(name))
  return (
    <label
      className={`flex items-center gap-2 text-sm font-medium text-neutral-800 dark:text-neutral-200 ${
        disabled ? '' : 'cursor-pointer'
      }`}
    >
      <input
        type="checkbox"
        checked={all}
        ref={(el) => {
          // Partial selections show as indeterminate — clearer than a bare
          // unchecked box that looks like "none allowed".
          if (el) el.indeterminate = some && !all
        }}
        onChange={(e) => onSetAll(e.target.checked)}
        disabled={disabled}
        className="accent-blue-600"
      />
      {label}
    </label>
  )
}

/** One selectable tool/prefix/skill row inside a checkbox group. */
function CheckItem({
  name,
  hint,
  badge,
  checked,
  disabled,
  onToggle,
}: {
  name: string
  hint?: string
  badge?: string
  checked: boolean
  disabled: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <li>
      <label
        className={`flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300 ${
          disabled ? '' : 'cursor-pointer'
        }`}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={disabled}
          className="mt-0.5 shrink-0 accent-blue-600"
        />
        <span className="min-w-0">
          <span className="font-mono text-xs">{name}</span>
          {badge && (
            <span className="ml-1.5 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
              {badge}
            </span>
          )}
          {hint && (
            <span className="block truncate text-xs text-neutral-400">
              {hint}
            </span>
          )}
        </span>
      </label>
    </li>
  )
}
