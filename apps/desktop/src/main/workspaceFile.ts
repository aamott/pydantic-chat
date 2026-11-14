/**
 * Workspace path confinement for `shell:open-path` — the TS mirror of the
 * backend's `_resolve_workspace_file` (apps/backend/app/api/files.py).
 *
 * The renderer passes a workspace id + relative path; the IPC handler looks
 * up the workspace's stored root via `GET /api/workspaces`, then this
 * resolver enforces the same double containment the file API uses: the
 * target must sit under the root lexically (`..` normalized, no symlink
 * hops) AND once symlinks are resolved, so a link named innocently cannot
 * reach a file outside the workspace.
 *
 * Protected-pattern matching is deliberately NOT mirrored: `shell.openPath`
 * hands the file to the OS (a user-initiated "double-click"), it never
 * ships bytes into the renderer, so the viewer's read-time secret shield
 * doesn't apply.
 */
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/**
 * `realpathSync` that tolerates a missing leaf: walks up to the deepest
 * existing ancestor, realpaths it, and re-appends the missing tail.
 * Python's `Path.resolve(strict=False)` does this natively; Node's
 * realpath throws on the first missing component, which would hide a
 * symlinked-outside parent behind an ENOENT.
 */
function realpathLenient(target: string): string {
  const missing: string[] = []
  let cursor = target
  for (;;) {
    try {
      return join(realpathSync(cursor), ...missing.reverse())
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) throw new Error('Path does not exist')
      missing.push(basename(cursor))
      cursor = parent
    }
  }
}

/**
 * Resolve `raw` under `root`, enforcing lexical + resolved containment.
 *
 * Returns the fully resolved absolute path, guaranteed inside `root`.
 *
 * @throws Error when `root` doesn't exist, or the path escapes the root
 *   (lexically or through a symlink).
 */
export function resolveWorkspaceFile(root: string, raw: string): string {
  const absRoot = realpathSync(root) // throws when the root is gone
  const lexical = resolve(absRoot, raw)
  const resolved = realpathLenient(lexical)
  for (const candidate of [lexical, resolved]) {
    if (candidate !== absRoot && !candidate.startsWith(absRoot + sep)) {
      throw new Error('Path is outside the workspace root')
    }
  }
  return resolved
}
