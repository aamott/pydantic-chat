/**
 * Compact relative timestamp for sidebar lists ("just now", "5m", "2h",
 * "3d", then a short date). Backend timestamps are unix ms (`_now_ms()`).
 *
 * Deliberately coarser than `Intl.RelativeTimeFormat`: these render beside
 * every chat row, so single-token strings keep the column narrow.
 */
export function formatRelativeTime(
  epochMs: number,
  now: number = Date.now(),
): string {
  const seconds = Math.max(0, Math.floor((now - epochMs) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: new Date(epochMs).getFullYear() === new Date(now).getFullYear()
      ? undefined
      : 'numeric',
  })
}
