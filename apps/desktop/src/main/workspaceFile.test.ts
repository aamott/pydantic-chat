/**
 * Tests for `resolveWorkspaceFile` — the `shell:open-path` confinement check.
 *
 * Mirrors the backend's `_resolve_workspace_file` (apps/backend/app/api/files.py):
 * the target must sit under the workspace root twice — lexically (`..`
 * normalized) and after symlink resolution — because a link named innocently
 * must not reach an outside target. Uses a real tmpdir tree so symlink cases
 * exercise the filesystem, not mocks.
 */
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { resolveWorkspaceFile } from './workspaceFile'

let root: string
let outside: string

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'wsfile-'))
  root = join(base, 'proj')
  outside = join(base, 'outside')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(root, 'README.md'), '# hi\n')
  writeFileSync(join(root, 'src', 'main.ts'), 'const x = 1\n')
  writeFileSync(join(outside, 'evil.txt'), 'nope\n')
  writeFileSync(join(outside, 'evil.png'), 'PNG')
  symlinkSync(join(outside, 'evil.txt'), join(root, 'link.txt'))
  symlinkSync(outside, join(root, 'linkdir'))
})

describe('resolveWorkspaceFile', () => {
  it('resolves plain relative paths inside the root', () => {
    expect(resolveWorkspaceFile(root, 'README.md')).toBe(
      join(root, 'README.md'),
    )
    expect(resolveWorkspaceFile(root, 'src/main.ts')).toBe(
      join(root, 'src', 'main.ts'),
    )
  })

  it('accepts absolute paths that stay inside the root', () => {
    expect(resolveWorkspaceFile(root, join(root, 'src', 'main.ts'))).toBe(
      join(root, 'src', 'main.ts'),
    )
  })

  it('rejects lexical escapes (.., absolute outside)', () => {
    for (const bad of [
      '../outside/evil.txt',
      join(outside, 'evil.txt'),
      'src/../../outside/evil.txt',
      '..',
      '../..',
    ]) {
      expect(() => resolveWorkspaceFile(root, bad), bad).toThrow(
        /outside the workspace root/,
      )
    }
  })

  it('rejects symlink escapes (file link and dir link)', () => {
    for (const bad of ['link.txt', 'linkdir/evil.txt', 'linkdir/evil.png']) {
      expect(() => resolveWorkspaceFile(root, bad), bad).toThrow(
        /outside the workspace root/,
      )
    }
  })

  it('rejects a missing leaf inside a symlinked-outside dir', () => {
    // The leaf doesn't exist, but the symlinked parent still resolves the
    // path outside the root — lenient resolution must catch it.
    expect(() => resolveWorkspaceFile(root, 'linkdir/new.txt')).toThrow(
      /outside the workspace root/,
    )
  })

  it('allows a missing leaf inside the root', () => {
    expect(resolveWorkspaceFile(root, 'src/not-yet.ts')).toBe(
      join(root, 'src', 'not-yet.ts'),
    )
  })

  it('throws when the workspace root itself is gone', () => {
    expect(() => resolveWorkspaceFile(join(root, 'gone'), 'x.txt')).toThrow()
  })
})
