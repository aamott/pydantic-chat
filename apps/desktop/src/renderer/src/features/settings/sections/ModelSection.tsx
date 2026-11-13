/**
 * Model settings: the default `provider:model` spec for new chats, plus the
 * judge model — shown only while the selected permission profile uses the
 * `smart` approval mode, since that mode is the judge's only consumer.
 *
 * The selected profile resolves through `GET /api/tool-profiles` so custom
 * profiles with `approval_mode: 'smart'` also surface the field; when the
 * list can't be fetched, the legacy `smart` id check is the fallback.
 */
import { useEffect } from 'react'
import { useProfilesStore } from '../../../stores/profiles'
import { useSettingsStore } from '../../../stores/settings'
import { Field, SectionHeading, inputClass } from '../components'

const MODEL_SPEC_HINT =
  'A provider:model spec, e.g. anthropic:claude-sonnet-4-6. Prefixes: anthropic, openai, openai-chat, google, google-cloud, ollama, openai-compatible.'

export function ModelSection(): React.JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings)
  const patch = useSettingsStore((s) => s.patch)
  const profiles = useProfilesStore((s) => s.profiles)
  const ensureProfilesLoaded = useProfilesStore((s) => s.ensureLoaded)

  useEffect(() => {
    void ensureProfilesLoaded()
  }, [ensureProfilesLoaded])

  if (!settings) return null

  const selected = profiles.find((p) => p.id === settings.permission_profile)
  const smartActive = selected
    ? selected.approval_mode === 'smart'
    : settings.permission_profile === 'smart'

  return (
    <div className="space-y-5">
      <SectionHeading title="Model" />
      <Field
        label="Default model"
        hint={MODEL_SPEC_HINT}
        keywords="model default provider anthropic openai google ollama claude gpt gemini llama spec"
      >
        <input
          type="text"
          value={settings.default_model}
          onChange={(event) => patch('default_model', event.target.value)}
          placeholder="provider:model"
          spellCheck={false}
          className={`${inputClass} font-mono`}
        />
      </Field>
      {smartActive && (
        <Field
          label="Judge model"
          hint="Model that reviews tool calls under smart approval. Same provider:model format. Empty judges with the chat's model."
          keywords="judge model reviewer approval smart permission profile"
        >
          <input
            type="text"
            value={settings.judge_model ?? ''}
            onChange={(event) => patch('judge_model', event.target.value)}
            placeholder="Auto — uses the chat's model"
            spellCheck={false}
            className={`${inputClass} font-mono`}
          />
        </Field>
      )}
    </div>
  )
}
