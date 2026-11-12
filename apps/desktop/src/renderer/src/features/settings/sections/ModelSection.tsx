/**
 * Model settings: the default `provider:model` spec for new chats, plus the
 * judge model — shown only while the `smart` permission profile is active,
 * since that profile is the judge's only consumer.
 */
import { useSettingsStore } from '../../../stores/settings'
import { Field, SectionHeading, inputClass } from '../components'

const MODEL_SPEC_HINT =
  'A provider:model spec, e.g. anthropic:claude-sonnet-4-6. Prefixes: anthropic, openai, openai-chat, google, google-cloud, ollama, openai-compatible.'

export function ModelSection(): React.JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings)
  const patch = useSettingsStore((s) => s.patch)
  if (!settings) return null

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
      {settings.permission_profile === 'smart' && (
        <Field
          label="Judge model"
          hint="Model that reviews tool calls under the smart permission profile. Same provider:model format."
          keywords="judge model reviewer approval smart permission profile"
        >
          <input
            type="text"
            value={settings.judge_model}
            onChange={(event) => patch('judge_model', event.target.value)}
            placeholder="provider:model"
            spellCheck={false}
            className={`${inputClass} font-mono`}
          />
        </Field>
      )}
    </div>
  )
}
