/**
 * Unit tests for `lib/paths.ts` — `pathBasename` replaced a regex whose
 * trailing-separator class tripped SonarQube's super-linear-backtracking
 * rule (S8786); these cases pin the exact replacement semantics.
 */
import { describe, expect, it } from 'vitest'
import { pathBasename } from './paths'

describe('pathBasename', () => {
  it('returns the last segment of a POSIX path', () => {
    expect(pathBasename('/home/adam/projects/pydantic-chat')).toBe(
      'pydantic-chat',
    )
  })

  it('returns the last segment of a Windows path', () => {
    expect(pathBasename('C:\\Users\\adam\\projects\\app')).toBe('app')
  })

  it('strips trailing separators first', () => {
    expect(pathBasename('/home/adam/work/')).toBe('work')
    expect(pathBasename('/home/adam/work///')).toBe('work')
    expect(pathBasename('C:\\Users\\adam\\work\\')).toBe('work')
  })

  it('handles mixed separators', () => {
    expect(pathBasename('/home/adam\\work/mixed/')).toBe('mixed')
    expect(pathBasename('a\\b/c')).toBe('c')
  })

  it('returns the segment itself for a bare name', () => {
    expect(pathBasename('workspace')).toBe('workspace')
  })

  it('handles a single trailing separator', () => {
    expect(pathBasename('a/')).toBe('a')
    expect(pathBasename('a\\')).toBe('a')
  })

  it('returns the root slash for a filesystem root', () => {
    expect(pathBasename('/')).toBe('/')
  })

  it('falls back to the raw path when it is only separators', () => {
    expect(pathBasename('///')).toBe('///')
    expect(pathBasename('\\\\')).toBe('\\\\')
  })

  it('falls back to the raw path when it is empty', () => {
    expect(pathBasename('')).toBe('')
  })

  it('trims the trailing slash on a drive root, like the old regex did', () => {
    expect(pathBasename('C:\\')).toBe('C:')
  })

  it('keeps dots and spaces in the last segment', () => {
    expect(pathBasename('/home/adam/my project.v2')).toBe('my project.v2')
  })
})
