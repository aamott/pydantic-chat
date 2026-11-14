/**
 * Component tests for `WorkspaceMcpPicker` — the workspace header's MCP
 * enable/disable mask popover. `lib/api` is mocked at the `apiJson` seam:
 * the GET returns the global registry, and the PATCH body `updateWorkspace`
 * sends can be asserted without a backend.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@pydantic-chat/shared'
import { apiJson } from '../../lib/api'
import { seedStores, workspace } from '../../test/fixtures'
import { WorkspaceMcpPicker } from './WorkspaceMcpPicker'

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
}))

const apiJsonMock = vi.mocked(apiJson)

const SERVERS: McpServer[] = [
  {
    name: 'fs-tools',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fs'],
    enabled: true,
  },
  {
    name: 'web-tools',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    enabled: false,
  },
]

/** The PATCH body `updateWorkspace` last sent (apiJson init arg). */
function lastPatchBody(): Record<string, unknown> {
  const init = apiJsonMock.mock.calls.at(-1)?.[1]
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

describe('WorkspaceMcpPicker', () => {
  beforeEach(() => {
    apiJsonMock.mockReset()
    apiJsonMock.mockImplementation(async (path, init) => {
      if (path === '/api/mcp-servers') return SERVERS
      // PATCH /api/workspaces/{id} — echo the mask back like WorkspaceOut.
      const body = JSON.parse(String(init?.body)) as {
        mcp_overrides?: Record<string, boolean> | null
      }
      return workspace({ mcp_overrides: body.mcp_overrides })
    })
    seedStores()
  })

  it('lists the global registry with effective (masked) enabled flags', async () => {
    const ws = workspace({ mcp_overrides: { 'fs-tools': false } })
    render(<WorkspaceMcpPicker workspace={ws} />)
    fireEvent.click(
      screen.getByRole('button', { name: /MCP servers for ws-1/i }),
    )

    const fsBox = await screen.findByRole('checkbox', {
      name: /Enable fs-tools/i,
    })
    const webBox = screen.getByRole('checkbox', { name: /Enable web-tools/i })
    // fs-tools masked off for this workspace; web-tools stays globally off.
    expect((fsBox as HTMLInputElement).checked).toBe(false)
    expect((webBox as HTMLInputElement).checked).toBe(false)
  })

  it('PATCHes a mask entry when a server is toggled off', async () => {
    render(<WorkspaceMcpPicker workspace={workspace()} />)
    fireEvent.click(
      screen.getByRole('button', { name: /MCP servers/i }),
    )
    fireEvent.click(
      await screen.findByRole('checkbox', { name: /Enable fs-tools/i }),
    )

    expect(apiJsonMock).toHaveBeenCalledWith(
      '/api/workspaces/ws-1',
      expect.objectContaining({ method: 'PATCH' }),
    )
    expect(lastPatchBody()).toEqual({ mcp_overrides: { 'fs-tools': false } })
  })

  it('merges toggles into the existing mask', async () => {
    const ws = workspace({ mcp_overrides: { 'fs-tools': false } })
    render(<WorkspaceMcpPicker workspace={ws} />)
    fireEvent.click(screen.getByRole('button', { name: /MCP servers/i }))
    // Re-enabling a globally-disabled server writes an explicit `true`.
    fireEvent.click(
      await screen.findByRole('checkbox', { name: /Enable web-tools/i }),
    )

    expect(lastPatchBody()).toEqual({
      mcp_overrides: { 'fs-tools': false, 'web-tools': true },
    })
  })

  it('PATCHes null when the last mask entry toggles back to the global flag', async () => {
    const ws = workspace({ mcp_overrides: { 'fs-tools': false } })
    render(<WorkspaceMcpPicker workspace={ws} />)
    fireEvent.click(screen.getByRole('button', { name: /MCP servers/i }))
    // fs-tools is globally enabled, so toggling it back on drops the entry —
    // and with the mask emptied it writes null (full inherit).
    fireEvent.click(
      await screen.findByRole('checkbox', { name: /Enable fs-tools/i }),
    )

    expect(lastPatchBody()).toEqual({ mcp_overrides: null })
  })

  it('shows a reset row while overrides exist and clears them on click', async () => {
    const ws = workspace({ mcp_overrides: { 'fs-tools': false } })
    render(<WorkspaceMcpPicker workspace={ws} />)
    fireEvent.click(screen.getByRole('button', { name: /MCP servers/i }))
    fireEvent.click(
      await screen.findByRole('button', { name: /Reset to global/i }),
    )

    expect(lastPatchBody()).toEqual({ mcp_overrides: null })
  })

  it('hides the reset row when the workspace inherits fully', async () => {
    render(<WorkspaceMcpPicker workspace={workspace()} />)
    fireEvent.click(screen.getByRole('button', { name: /MCP servers/i }))
    await screen.findByRole('checkbox', { name: /Enable fs-tools/i })

    expect(screen.queryByRole('button', { name: /Reset to global/i })).toBeNull()
  })
})
