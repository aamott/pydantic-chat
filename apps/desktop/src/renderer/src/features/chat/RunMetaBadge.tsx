/**
 * Chat-header chip showing the run's effective settings from the latest
 * `data-run-meta` part: permission profile + model short name, full spec in
 * the tooltip. Stream-only chunk → renders nothing for reloaded transcripts.
 *
 * `permission_profile` arrives as a profile id; it's mapped to the fetched
 * display name (raw id fallback for unknown/custom-deleted profiles).
 */
import { useEffect } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { RunMeta } from '../../lib/dataParts'
import { profileName } from '../../lib/profiles'
import { useProfilesStore } from '../../stores/profiles'
import { shortModelName } from './ModelPicker'

export function RunMetaBadge({
  meta,
}: Readonly<{
  meta: RunMeta
}>): React.JSX.Element {
  const profiles = useProfilesStore((s) => s.profiles)
  const ensureLoaded = useProfilesStore((s) => s.ensureLoaded)

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

  const label = profileName(profiles, meta.permission_profile)
  const title =
    label === meta.permission_profile
      ? `Permission profile: ${meta.permission_profile}\nModel: ${meta.model}`
      : `Permission profile: ${label} (${meta.permission_profile})\nModel: ${meta.model}`

  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded border border-subtle bg-subtle px-2 py-0.5 text-[11px] text-secondary"
    >
      <ShieldCheck className="h-3 w-3 text-faint" />
      {label}
      <span aria-hidden className="text-faint">
        ·
      </span>
      {shortModelName(meta.model)}
    </span>
  )
}
