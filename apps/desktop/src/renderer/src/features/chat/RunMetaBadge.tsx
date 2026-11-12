/**
 * Chat-header chip showing the run's effective settings from the latest
 * `data-run-meta` part: permission profile + model short name, full spec in
 * the tooltip. Stream-only chunk → renders nothing for reloaded transcripts.
 */
import { ShieldCheck } from 'lucide-react'
import type { RunMeta } from '../../lib/dataParts'

/** `anthropic:claude-sonnet-4-5` → `claude-sonnet-4-5` (no prefix → as-is). */
function shortModelName(model: string): string {
  const sep = model.indexOf(':')
  return sep >= 0 ? model.slice(sep + 1) : model
}

export function RunMetaBadge({
  meta,
}: {
  meta: RunMeta
}): React.JSX.Element {
  return (
    <span
      title={`Permission profile: ${meta.permission_profile}\nModel: ${meta.model}`}
      className="inline-flex items-center gap-1.5 rounded border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[11px] text-neutral-600"
    >
      <ShieldCheck className="h-3 w-3 text-neutral-400" />
      {meta.permission_profile}
      <span aria-hidden className="text-neutral-300">
        ·
      </span>
      {shortModelName(meta.model)}
    </span>
  )
}
