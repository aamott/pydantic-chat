/**
 * General settings: app theme.
 *
 * Selecting a theme applies it to the document immediately (see
 * lib/theme.ts) so the window previews the choice before Save.
 */
import { useSettingsStore } from '../../../stores/settings'
import { Field, SectionHeading, inputClass } from '../components'

export function GeneralSection(): React.JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings)
  const patch = useSettingsStore((s) => s.patch)
  if (!settings) return null

  return (
    <div className="space-y-5">
      <SectionHeading title="General" />
      <Field
        label="Theme"
        hint="Light, dark, or follow the OS. Applies right away; Save makes it permanent."
        keywords="theme appearance dark light system color mode colours"
      >
        <select
          value={settings.theme}
          onChange={(event) => patch('theme', event.target.value)}
          className={inputClass}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </Field>
    </div>
  )
}
