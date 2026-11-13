/**
 * Permissions settings: the agent's default permission profile plus the
 * four allow/deny lists handed to its Shell/FileSystem capabilities.
 *
 * The profile radios come from `GET /api/tool-profiles` (builtin + custom,
 * cached in `stores/profiles.ts`) — custom profiles are editable in the
 * Tool profiles section. A saved value that no longer resolves (deleted
 * custom profile) still renders as a selected "unknown" row, since the
 * backend falls back to `manual` for unresolvable ids.
 */
import { useEffect } from 'react'
import { useProfilesStore } from '../../../stores/profiles'
import { useSettingsStore } from '../../../stores/settings'
import {
  Field,
  SectionHeading,
  TagListEditor,
} from '../components'

export function PermissionsSection(): React.JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings)
  const patch = useSettingsStore((s) => s.patch)
  const profiles = useProfilesStore((s) => s.profiles)
  const ensureProfilesLoaded = useProfilesStore((s) => s.ensureLoaded)

  useEffect(() => {
    void ensureProfilesLoaded()
  }, [ensureProfilesLoaded])

  if (!settings) return null

  const currentKnown = profiles.some(
    (p) => p.id === settings.permission_profile,
  )

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Permissions"
        description="How much the agent may do on its own. Applies to the next run."
      />

      <Field
        label="Profile"
        keywords="permission profile approval bypass smart manual read-only readonly ask allow"
      >
        <div className="space-y-2" role="radiogroup" aria-label="Permission profile">
          {profiles.map((profile) => (
            <label
              key={profile.id}
              className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 ${
                settings.permission_profile === profile.id
                  ? 'border-accent bg-accent-soft'
                  : 'border-subtle hover-bg-subtle'
              }`}
            >
              <input
                type="radio"
                name="permission_profile"
                value={profile.id}
                checked={settings.permission_profile === profile.id}
                onChange={() => patch('permission_profile', profile.id)}
                className="mt-1 accent-blue-600"
              />
              {/* The name text must sit within label-depth 2 for S6853's
                  accessible-text check — keep it a direct child of this
                  span rather than nesting it inside another element. */}
              <span className="text-strong text-sm font-medium">
                {profile.name}
                {!profile.builtin && (
                  <span className="ml-1.5 font-normal text-neutral-400">
                    (custom)
                  </span>
                )}
                <span className="text-muted block text-xs font-normal">
                  {profile.description}
                </span>
              </span>
            </label>
          ))}
          {!currentKnown && (
            <label className="border-accent bg-accent-soft flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2">
              <input
                type="radio"
                name="permission_profile"
                value={settings.permission_profile}
                checked
                readOnly
                className="mt-1 accent-blue-600"
              />
              <span className="text-strong text-sm font-medium">
                {settings.permission_profile}
                <span className="text-muted block text-xs font-normal">
                  Unknown profile id — the backend falls back to Manual. Pick
                  another profile to replace it.
                </span>
              </span>
            </label>
          )}
        </div>
      </Field>

      <Field
        label="Allowed commands"
        hint="When this list has entries, only these shell commands may run — the deny list below still wins per command. Leave empty for normal profile behavior."
        keywords="allow allowed whitelist commands shell bash run terminal approve"
      >
        <TagListEditor
          value={settings.allowed_commands}
          onChange={(next) => patch('allowed_commands', next)}
          placeholder="e.g. git status"
        />
      </Field>

      <Field
        label="Denied commands"
        hint="Shell commands the agent may never run. Wins over the allow list per command."
        keywords="deny denied blacklist block commands shell bash run terminal"
      >
        <TagListEditor
          value={settings.denied_commands}
          onChange={(next) => patch('denied_commands', next)}
          placeholder="e.g. rm -rf"
        />
      </Field>

      <Field
        label="Allowed file patterns"
        hint="Glob patterns for files the agent may touch (e.g. src/**)."
        keywords="allow allowed whitelist file patterns glob filesystem path"
      >
        <TagListEditor
          value={settings.allowed_patterns}
          onChange={(next) => patch('allowed_patterns', next)}
          placeholder="e.g. src/**"
        />
      </Field>

      <Field
        label="Denied file patterns"
        hint="Glob patterns for files the agent must never touch (e.g. **/.env, **/secrets/**). Wins over the allow list."
        keywords="deny denied blacklist block file patterns glob filesystem path secrets env"
      >
        <TagListEditor
          value={settings.denied_patterns}
          onChange={(next) => patch('denied_patterns', next)}
          placeholder="e.g. **/.env"
        />
      </Field>
    </div>
  )
}
