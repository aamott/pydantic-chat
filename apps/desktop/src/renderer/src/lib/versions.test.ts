import { describe, expect, it } from 'vitest'
import type { PromptVersion } from '@pydantic-chat/shared'
import { versionPreview, versionsForMessage } from './versions'

function version(overrides: Partial<PromptVersion> = {}): PromptVersion {
  return {
    id: 'entry-1',
    message_id: 'm-1',
    tip: 'tip-1',
    text: 'first try',
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('versionsForMessage', () => {
  it('filters by message_id and returns newest first', () => {
    const versions = [
      version({ id: 'a', message_id: 'm-1', text: 'v1' }),
      version({ id: 'b', message_id: 'm-2', text: 'other' }),
      version({ id: 'c', message_id: 'm-1', text: 'v2' }),
    ]
    expect(versionsForMessage(versions, 'm-1').map((v) => v.text)).toEqual([
      'v2',
      'v1',
    ])
  })

  it('returns an empty list for messages with no replaced versions', () => {
    expect(versionsForMessage([version()], 'm-x')).toEqual([])
    expect(versionsForMessage([], 'm-1')).toEqual([])
  })
})

describe('versionPreview', () => {
  it('collapses whitespace into a single line', () => {
    expect(versionPreview('line one\n\n  line\ttwo')).toBe('line one line two')
  })

  it('truncates long text with an ellipsis', () => {
    const long = 'word '.repeat(30)
    const preview = versionPreview(long)
    expect(preview.endsWith('…')).toBe(true)
    expect(preview.length).toBeLessThanOrEqual(81)
  })
})
