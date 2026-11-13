/**
 * Path display helpers for renderer UI. Workspace paths arrive from the
 * backend already normalized for the user's OS, but they can use either
 * separator and carry trailing slashes — display only, never resolved
 * against the filesystem here.
 */

const isSeparator = (ch: string): boolean => ch === '/' || ch === '\\'

/**
 * Last path segment, for workspaces with no `display_name` set.
 *
 * Regex-free by design (S8786): scans once from the end — skips trailing
 * separators, then walks back to the previous separator. Falls back to the
 * raw path when nothing but separators remains, matching the old
 * `split().pop() || path` behavior.
 */
export function pathBasename(path: string): string {
  let end = path.length
  while (end > 0 && isSeparator(path[end - 1])) end--
  if (end === 0) return path
  let start = end
  while (start > 0 && !isSeparator(path[start - 1])) start--
  return path.slice(start, end)
}
