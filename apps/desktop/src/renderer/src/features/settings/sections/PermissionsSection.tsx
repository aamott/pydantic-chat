/**
 * Permissions settings: the agent's permission profile plus the four
 * allow/deny lists handed to its Shell/FileSystem capabilities.
 *
 * Profiles mirror the backend's `PermissionProfile` literal
 * (app/agent/factory.py); descriptions use the same plain-language
 * semantics: bypass asks for nothing, smart lets a judge model approve
 * low-risk calls, manual asks before every write/command, read-only
 * removes write tools and the shell entirely.
 */
import { useSettingsStore } from '../../../stores/settings'
import {
  Field,
  SectionHeading,
  TagListEditor,
} from '../components'

const PROFILES: Array<{ value: string; name: string; description: string }> = [
  {
    value: 'manual',
    name: 'Manual',
    description:
      'Ask before every file write and shell command. Safest everyday default.',
  },
  {
    value: 'smart',
    name: 'Smart',
    description:
      'A judge model auto-approves low-risk calls; anything that could destroy data, spend money, or leak secrets still asks.',
  },
  {
    value: 'bypass',
    name: 'Bypass',
    description:
      'Run every tool call without asking. Fastest — use only in trusted workspaces.',
  },
  {
    value: 'read-only',
    name: 'Read-only',
    description:
      'The agent can read files but cannot write or run shell commands.',
  },
]

export function PermissionsSection(): React.JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings)
  const patch = useSettingsStore((s) => s.patch)
  if (!settings) return null

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
          {PROFILES.map((profile) => (
            <label
              key={profile.value}
              className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 ${
                settings.permission_profile === profile.value
                  ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/40'
                  : 'border-neutral-200 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800'
              }`}
            >
              <input
                type="radio"
                name="permission_profile"
                value={profile.value}
                checked={settings.permission_profile === profile.value}
                onChange={() => patch('permission_profile', profile.value)}
                className="mt-1 accent-blue-600"
              />
              <span>
                <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
                  {profile.name}
                </span>
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                  {profile.description}
                </span>
              </span>
            </label>
          ))}
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
