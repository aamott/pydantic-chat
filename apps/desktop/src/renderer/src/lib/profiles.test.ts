/**
 * Unit tests for `lib/profiles.ts` — the pure logic behind the tool-profile
 * pickers and the settings editor: null-compression of checkbox selections
 * (all-checked round-trips to `null` = "all"), builtin/custom partitioning,
 * id→name resolution, and request-body shaping for the CRUD endpoints.
 */
import { describe, expect, it } from 'vitest'
import type { ToolProfile } from '@pydantic-chat/shared'
import {
  checkedFromProfile,
  compressSelection,
  duplicateDraft,
  emptyProfileDraft,
  encodeToolSelection,
  partitionProfiles,
  profileName,
  profileToInput,
  slugifyProfileId,
} from './profiles'

const TOOLS = ['read_file', 'write_file', 'shell', 'write_plan']
const PREFIXES = ['github_', 'fs_']
const SKILLS = ['code-review', 'commit']

/** Minimal profile fixture; fields default to the "allow everything" state. */
function profile(overrides: Partial<ToolProfile> = {}): ToolProfile {
  return {
    id: 'custom-1',
    name: 'Custom',
    description: '',
    approval_mode: 'manual',
    workspace_read_only: false,
    tools: null,
    tool_prefixes: [],
    skills: null,
    builtin: false,
    ...overrides,
  }
}

describe('compressSelection', () => {
  it('returns null when every universe item is selected', () => {
    expect(compressSelection(new Set(TOOLS), TOOLS)).toBeNull()
  })

  it('returns the checked names in universe order when partial', () => {
    // Deliberately out of order — the wire list follows the catalog.
    expect(
      compressSelection(new Set(['write_plan', 'read_file']), TOOLS),
    ).toEqual(['read_file', 'write_plan'])
  })

  it('returns an empty list when nothing is selected', () => {
    expect(compressSelection(new Set(), TOOLS)).toEqual([])
  })

  it('treats an empty universe as all-selected (null)', () => {
    expect(compressSelection(new Set(), [])).toBeNull()
  })

  it('drops selected names that are not in the universe', () => {
    expect(
      compressSelection(new Set(['read_file', 'removed_tool']), TOOLS),
    ).toEqual(['read_file'])
  })

  it('still compresses to null when extras accompany a full selection', () => {
    // A stale name in the saved profile must not block null-compression.
    expect(
      compressSelection(new Set([...TOOLS, 'removed_tool']), TOOLS),
    ).toBeNull()
  })
})

describe('checkedFromProfile', () => {
  it('checks everything for the null/default state', () => {
    const checked = checkedFromProfile(profile(), TOOLS, PREFIXES, SKILLS)
    expect(checked.tools).toEqual(new Set(TOOLS))
    expect(checked.prefixes).toEqual(new Set(PREFIXES))
    expect(checked.skills).toEqual(new Set(SKILLS))
  })

  it('intersects explicit lists with the catalog, dropping stale names', () => {
    const checked = checkedFromProfile(
      profile({
        tools: ['read_file', 'gone_tool'],
        tool_prefixes: ['github_', 'gone_'],
        skills: ['commit', 'gone-skill'],
      }),
      TOOLS,
      PREFIXES,
      SKILLS,
    )
    expect(checked.tools).toEqual(new Set(['read_file']))
    expect(checked.prefixes).toEqual(new Set(['github_']))
    expect(checked.skills).toEqual(new Set(['commit']))
  })

  it('treats non-empty prefixes on a tools:null profile as the allowed subset', () => {
    const checked = checkedFromProfile(
      profile({ tools: null, tool_prefixes: ['github_'] }),
      TOOLS,
      PREFIXES,
      SKILLS,
    )
    expect(checked.tools).toEqual(new Set(TOOLS))
    expect(checked.prefixes).toEqual(new Set(['github_']))
  })

  it('treats empty prefixes on a tools:list profile as no MCP tools', () => {
    const checked = checkedFromProfile(
      profile({ tools: ['read_file'], tool_prefixes: [] }),
      TOOLS,
      PREFIXES,
      SKILLS,
    )
    expect(checked.tools).toEqual(new Set(['read_file']))
    expect(checked.prefixes).toEqual(new Set())
  })

  it('honours skills:[] as "no skills" rather than "all"', () => {
    const checked = checkedFromProfile(
      profile({ skills: [] }),
      TOOLS,
      PREFIXES,
      SKILLS,
    )
    expect(checked.skills).toEqual(new Set())
  })
})

describe('encodeToolSelection', () => {
  it('compresses to null/[] when tools AND prefixes are all checked', () => {
    expect(
      encodeToolSelection(
        new Set(TOOLS),
        new Set(PREFIXES),
        TOOLS,
        PREFIXES,
      ),
    ).toEqual({ tools: null, tool_prefixes: [] })
  })

  it('sends an explicit tool list when any tool is unchecked', () => {
    expect(
      encodeToolSelection(
        new Set(['read_file', 'write_plan']),
        new Set(PREFIXES),
        TOOLS,
        PREFIXES,
      ),
    ).toEqual({
      tools: ['read_file', 'write_plan'],
      tool_prefixes: PREFIXES,
    })
  })

  it('sends all tools explicitly when only some prefixes are checked', () => {
    // `tools: null` + a partial prefix list is ambiguous server-side, so the
    // wire form is always explicit outside the all-checked null state.
    expect(
      encodeToolSelection(
        new Set(TOOLS),
        new Set(['github_']),
        TOOLS,
        PREFIXES,
      ),
    ).toEqual({ tools: TOOLS, tool_prefixes: ['github_'] })
  })

  it('sends all tools explicitly to express "builtin tools, no MCP"', () => {
    // `tools: null` + `prefixes: []` is the unfiltered state, so blocking
    // every MCP server requires an explicit builtin list.
    expect(
      encodeToolSelection(new Set(TOOLS), new Set(), TOOLS, PREFIXES),
    ).toEqual({ tools: TOOLS, tool_prefixes: [] })
  })

  it('sends empty lists for a "no tools at all" profile', () => {
    expect(
      encodeToolSelection(new Set(), new Set(), TOOLS, PREFIXES),
    ).toEqual({ tools: [], tool_prefixes: [] })
  })

  it('emits names in catalog order', () => {
    expect(
      encodeToolSelection(
        new Set(['write_plan', 'read_file']),
        new Set(['fs_', 'github_']),
        TOOLS,
        PREFIXES,
      ),
    ).toEqual({
      tools: ['read_file', 'write_plan'],
      tool_prefixes: ['github_', 'fs_'],
    })
  })
})

describe('partitionProfiles', () => {
  it('splits builtin and custom profiles preserving order', () => {
    const manual = profile({ id: 'manual', name: 'Manual', builtin: true })
    const mine = profile({ id: 'mine', name: 'Mine' })
    const bypass = profile({ id: 'bypass', name: 'Bypass', builtin: true })
    const other = profile({ id: 'other', name: 'Other' })
    const { builtin, custom } = partitionProfiles([manual, mine, bypass, other])
    expect(builtin.map((p) => p.id)).toEqual(['manual', 'bypass'])
    expect(custom.map((p) => p.id)).toEqual(['mine', 'other'])
  })

  it('handles an empty list', () => {
    expect(partitionProfiles([])).toEqual({ builtin: [], custom: [] })
  })
})

describe('profileName', () => {
  const profiles = [
    profile({ id: 'manual', name: 'Manual' }),
    profile({ id: 'mine', name: 'My Profile' }),
  ]

  it('resolves a known id to its display name', () => {
    expect(profileName(profiles, 'mine')).toBe('My Profile')
  })

  it('falls back to the raw id for unknown profiles', () => {
    expect(profileName(profiles, 'deleted-id')).toBe('deleted-id')
    expect(profileName([], 'manual')).toBe('manual')
  })
})

describe('profileToInput', () => {
  it('keeps id (the API requires it) and drops builtin', () => {
    const input = profileToInput(
      profile({
        id: 'abc',
        name: 'Mine',
        tools: ['read_file'],
        skills: [],
        builtin: true,
      }),
    )
    expect(input).toEqual({
      id: 'abc',
      name: 'Mine',
      description: '',
      approval_mode: 'manual',
      workspace_read_only: false,
      tools: ['read_file'],
      tool_prefixes: [],
      skills: [],
    })
    expect('builtin' in input).toBe(false)
  })
})

describe('duplicateDraft', () => {
  it('copies the profile with a " copy" name and a derived id', () => {
    const draft = duplicateDraft(
      profile({ id: 'manual', name: 'Manual', builtin: true }),
    )
    expect(draft.name).toBe('Manual copy')
    expect(draft.id).toBe('manual-copy')
    expect('builtin' in draft).toBe(false)
    expect(draft.tools).toBeNull()
    expect(draft.skills).toBeNull()
  })
})

describe('emptyProfileDraft', () => {
  it('defaults to a safe manual profile that allows everything', () => {
    expect(emptyProfileDraft()).toEqual({
      name: '',
      description: '',
      approval_mode: 'manual',
      workspace_read_only: false,
      tools: null,
      tool_prefixes: [],
      skills: null,
    })
  })
})

describe('slugifyProfileId', () => {
  it('kebab-cases display names', () => {
    expect(slugifyProfileId('My Reviewer Profile')).toBe(
      'my-reviewer-profile',
    )
    expect(slugifyProfileId('Smart (v2)!')).toBe('smart-v2')
    expect(slugifyProfileId('  leading/trailing  ')).toBe('leading-trailing')
  })

  it('falls back to "profile" for names without slug characters', () => {
    expect(slugifyProfileId('')).toBe('profile')
    expect(slugifyProfileId('!!!')).toBe('profile')
  })
})
