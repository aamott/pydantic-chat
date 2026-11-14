/**
 * Component test for `ToolProfilesSection`'s user-tool group: catalog
 * entries with `group: 'user'` (`user_<func>`, `prefix: false`) must render
 * as checkboxes under "User tools" and round-trip through the profile's
 * `tools` allowlist like any other exact-name entry.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCatalogEntry } from '@pydantic-chat/shared'
import { apiFetch, apiJson } from '../../../lib/api'
import { seedStores, toolProfile } from '../../../test/fixtures'
import { ToolProfilesSection } from './ToolProfilesSection'

vi.mock('../../../lib/api', () => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
}))

const apiJsonMock = vi.mocked(apiJson)
const apiFetchMock = vi.mocked(apiFetch)

const CATALOG: ToolCatalogEntry[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    group: 'filesystem',
    prefix: false,
  },
  {
    name: 'shell',
    description: 'Run a shell command',
    group: 'shell',
    prefix: false,
  },
  {
    name: 'user_greet',
    description: 'Greet someone',
    group: 'user',
    prefix: false,
  },
  {
    name: 'fs_*',
    description: "All tools from MCP server 'fs'",
    group: 'mcp',
    prefix: true,
  },
]

const PROFILE = toolProfile({
  id: 'custom-1',
  name: 'Custom',
  builtin: false,
})

describe('ToolProfilesSection — user group', () => {
  beforeEach(() => {
    apiJsonMock.mockReset()
    apiFetchMock.mockReset()
    apiJsonMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/tool-catalog')) return CATALOG
      if (path === '/api/skills') return { skills: [], skipped: [] }
      if (path === '/api/tool-profiles') return [PROFILE]
      throw new Error(`Unexpected apiJson path: ${path}`)
    })
    apiFetchMock.mockImplementation(async () => {
      return new Response(JSON.stringify(PROFILE), { status: 200 })
    })
    seedStores({ profiles: [PROFILE] })
  })

  it('fetches the catalog scoped to the resolved workspace', async () => {
    render(<ToolProfilesSection />)
    await screen.findByRole('button', { name: /Expand Custom/i })
    expect(apiJsonMock).toHaveBeenCalledWith(
      '/api/tool-catalog?workspace_id=ws-1',
    )
  })

  it('renders user_* tools as checkboxes and saves an explicit list', async () => {
    render(<ToolProfilesSection />)
    fireEvent.click(
      await screen.findByRole('button', { name: /Expand Custom/i }),
    )

    // The catalog's 'user' group renders under its label; tools:null →
    // everything checked.
    expect(await screen.findByText('User tools')).toBeTruthy()
    const greet = screen.getByRole('checkbox', { name: /user_greet/ })
    expect((greet as HTMLInputElement).checked).toBe(true)

    fireEvent.click(greet)
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))

    // PUT /api/tool-profiles/custom-1 — explicit lists on both sides:
    // user_greet excluded from tools; the fs_ prefix stays checked.
    const putCall = apiFetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PUT',
    )
    expect(putCall?.[0]).toBe('/api/tool-profiles/custom-1')
    const body = JSON.parse(String(putCall?.[1]?.body)) as {
      tools: string[]
      tool_prefixes: string[]
    }
    expect(body.tools).toEqual(['read_file', 'shell'])
    expect(body.tool_prefixes).toEqual(['fs_'])
  })
})
