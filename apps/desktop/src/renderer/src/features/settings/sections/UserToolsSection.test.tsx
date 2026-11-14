/**
 * Component tests for `UserToolsSection` — the settings window's
 * user-defined-tool registry. `lib/api` is mocked at the `apiJson`/
 * `apiFetch` seam so the exact PATCH/POST/DELETE bodies can be asserted;
 * the chats store is seeded so `useSectionWorkspace` resolves ws-1
 * without a fetch. The `openFileInViewer` IPC bridge is a no-op stub from
 * test/setup.ts — spied on where the Edit flow matters.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserTool } from '@pydantic-chat/shared'
import { apiFetch, apiJson } from '../../../lib/api'
import { seedStores } from '../../../test/fixtures'
import { UserToolsSection } from './UserToolsSection'

vi.mock('../../../lib/api', () => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
}))

const apiJsonMock = vi.mocked(apiJson)
const apiFetchMock = vi.mocked(apiFetch)

const GLOBAL_TOOL: UserTool = {
  key: 'global:greet.py',
  name: 'greet',
  origin: 'global',
  rel_path: 'greet.py',
  enabled: true,
  docstring: 'Greeting helpers.',
  functions: [{ name: 'greet', docstring: 'Greet someone.' }],
  skipped_functions: [],
}

const WS_TOOL: UserTool = {
  key: 'workspace:.pydantic-chat/tools/proj.py',
  name: 'proj',
  origin: 'workspace',
  rel_path: '.pydantic-chat/tools/proj.py',
  enabled: false,
  functions: [{ name: 'build', docstring: null }],
  skipped_functions: [],
}

const BROKEN_TOOL: UserTool = {
  key: 'global:broken.py',
  name: 'broken',
  origin: 'global',
  rel_path: 'broken.py',
  enabled: true,
  functions: [],
  skipped_functions: [
    { name: 'Bad-Name', reason: 'illegal tool name' },
  ],
  error: 'SyntaxError: invalid syntax',
}

const SHADOWED_TOOL: UserTool = {
  key: 'global:dup.py',
  name: 'dup',
  origin: 'global',
  rel_path: 'dup.py',
  enabled: true,
  functions: [],
  skipped_functions: [],
  skipped_reason: 'shadowed by workspace:.pydantic-chat/tools/dup.py',
}

const ALL_TOOLS = [GLOBAL_TOOL, WS_TOOL, BROKEN_TOOL, SHADOWED_TOOL]

/** JSON body of the most recent apiJson call that carried one — writes
 * are followed by a bodyless refetch GET, so scan backwards. */
function lastBody(): Record<string, unknown> {
  const call = [...apiJsonMock.mock.calls]
    .reverse()
    .find(([, init]) => init?.body)
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>
}

describe('UserToolsSection', () => {
  beforeEach(() => {
    /* Undo window.api spies from earlier tests (module mocks aren't
     * spies — mockReset below handles them). */
    vi.restoreAllMocks()
    apiJsonMock.mockReset()
    apiFetchMock.mockReset()
    apiJsonMock.mockImplementation(async (path: string, init) => {
      if (path.startsWith('/api/user-tools/source')) {
        return { source: 'def greet() -> str:\n    return "hi"\n' }
      }
      if (path.startsWith('/api/user-tools')) {
        // PATCH returns the registry (content ignored); GET/POST → listing.
        return init?.method === 'PATCH' ? [] : ALL_TOOLS
      }
      throw new Error(`Unexpected apiJson path: ${path}`)
    })
    apiFetchMock.mockImplementation(async (path: string, init) => {
      if (init?.method === 'DELETE' && path.startsWith('/api/user-tools')) {
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected apiFetch path: ${path}`)
    })
    /* seedStores resets the userTools singleton and seeds the workspace
     * the section scopes itself to. */
    seedStores()
  })

  it('lists discovered tools with origin badges and functions', async () => {
    render(<UserToolsSection />)

    expect(await screen.findByText('greet')).toBeTruthy()
    // Three global files → three 'Global' badges.
    expect(screen.getAllByText('Global')).toHaveLength(3)
    // Workspace rows badge with the workspace's display name.
    expect(screen.getByText('proj')).toBeTruthy()
    expect(screen.getByText('ws-1')).toBeTruthy()
    expect(screen.getByText('user_greet')).toBeTruthy()
    expect(screen.getByText('user_build')).toBeTruthy()
    expect(screen.getByText('Greet someone.')).toBeTruthy()
  })

  it('fetches the listing scoped to the resolved workspace', async () => {
    render(<UserToolsSection />)
    await screen.findByText('greet')
    expect(apiJsonMock).toHaveBeenCalledWith(
      '/api/user-tools?workspace_id=ws-1',
    )
  })

  it('PATCHes {key, enabled} when the toggle is clicked', async () => {
    render(<UserToolsSection />)
    fireEvent.click(
      await screen.findByRole('checkbox', { name: /Enable greet/i }),
    )
    expect(apiJsonMock).toHaveBeenCalledWith(
      '/api/user-tools',
      expect.objectContaining({ method: 'PATCH' }),
    )
    expect(lastBody()).toEqual({ key: 'global:greet.py', enabled: false })
  })

  it('shows parse errors, skipped functions, and skipped files', async () => {
    render(<UserToolsSection />)
    expect(
      await screen.findByText(/Parse error: SyntaxError: invalid syntax/),
    ).toBeTruthy()
    expect(
      screen.getByText(/Bad-Name: illegal tool name/),
    ).toBeTruthy()
    expect(
      screen.getByText(/Not active: shadowed by workspace:/),
    ).toBeTruthy()
  })

  it('delete is a two-step confirm that issues DELETE with the tool key', async () => {
    render(<UserToolsSection />)
    fireEvent.click(
      await screen.findByRole('button', { name: /Delete greet/i }),
    )
    // Nothing sent until the inline confirm.
    expect(apiFetchMock).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', { name: /Confirm delete greet/i }),
    )
    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('key=global%3Agreet.py'),
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('workspace_id=ws-1'),
      expect.anything(),
    )
  })

  it('creates a workspace tool and opens it in the FileViewer', async () => {
    const openSpy = vi.spyOn(window.api, 'openFileInViewer')
    render(<UserToolsSection />)
    await screen.findByText('greet')

    fireEvent.click(screen.getByRole('button', { name: /Add tool/i }))
    fireEvent.change(screen.getByPlaceholderText('e.g. my_tools'), {
      target: { value: 'my_tools' },
    })
    // 'workspace' is the default origin while a workspace is resolved.
    fireEvent.click(screen.getByRole('button', { name: /Create/i }))

    expect(apiJsonMock).toHaveBeenCalledWith(
      '/api/user-tools',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(lastBody()).toEqual({
      origin: 'workspace',
      workspace_id: 'ws-1',
      filename: 'my_tools.py',
    })
    /* The FileViewer open is awaited after the create POST resolves. */
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        'ws-1',
        '.pydantic-chat/tools/my_tools.py',
      ),
    )
  })

  it('relays workspace-tool edit requests to the main window FileViewer', async () => {
    const openSpy = vi.spyOn(window.api, 'openFileInViewer')
    render(<UserToolsSection />)
    fireEvent.click(
      await screen.findByRole('button', { name: /Edit proj/i }),
    )
    expect(openSpy).toHaveBeenCalledWith('ws-1', '.pydantic-chat/tools/proj.py')
    // No inline source fetch for workspace tools.
    expect(apiJsonMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/user-tools/source'),
    )
  })

  it('edits a global tool inline and PUTs the source', async () => {
    render(<UserToolsSection />)
    fireEvent.click(
      await screen.findByRole('button', { name: /Edit greet/i }),
    )
    const textarea = await screen.findByRole('textbox', {
      name: /Source for greet/i,
    })
    expect(apiJsonMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/user-tools/source?key=global%3Agreet.py'),
    )
    expect((textarea as HTMLTextAreaElement).value).toContain('def greet')

    fireEvent.change(textarea, { target: { value: 'def greet() -> int:\n    return 1\n' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))
    expect(apiJsonMock).toHaveBeenCalledWith(
      '/api/user-tools/source',
      expect.objectContaining({ method: 'PUT' }),
    )
    expect(lastBody()).toEqual({
      key: 'global:greet.py',
      workspace_id: 'ws-1',
      source: 'def greet() -> int:\n    return 1\n',
    })
  })

  it('rejects a filename that violates the tool-name rule', async () => {
    render(<UserToolsSection />)
    await screen.findByText('greet')
    fireEvent.click(screen.getByRole('button', { name: /Add tool/i }))
    fireEvent.change(screen.getByPlaceholderText('e.g. my_tools'), {
      target: { value: 'Bad Name!' },
    })
    const create = screen.getByRole('button', { name: /Create/i })
    expect((create as HTMLButtonElement).disabled).toBe(true)
  })

  it('toggles the help panel from the header "?" button', async () => {
    render(<UserToolsSection />)
    await screen.findByText('greet')

    const toggle = screen.getByRole('button', {
      name: /How user tools work/i,
    })
    // Collapsed by default — no help text or example snippet.
    expect(screen.queryByText(/Where files live/)).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText(/Where files live/)).toBeTruthy()
    // The dir appears in both the bullet and the create-button hint.
    expect(
      screen.getAllByText(/\.pydantic-chat\/tools\//).length,
    ).toBeGreaterThan(0)
    expect(screen.getByText(/def word_count/)).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.queryByText(/Where files live/)).toBeNull()
  })

  it('"Create example" POSTs the canned source through the create flow', async () => {
    render(<UserToolsSection />)
    await screen.findByText('greet')

    fireEvent.click(
      screen.getByRole('button', { name: /How user tools work/i }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: /Create example_tools\.py/i }),
    )

    await waitFor(() =>
      expect(apiJsonMock).toHaveBeenCalledWith(
        '/api/user-tools',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    const body = lastBody()
    expect(body).toMatchObject({
      origin: 'workspace',
      workspace_id: 'ws-1',
      filename: 'example_tools.py',
    })
    // The canned source carries the documented function shapes.
    expect(String(body.source)).toContain('def word_count')
    expect(String(body.source)).toContain('async def')
    // The panel closed so the refetched row is in view.
    await waitFor(() =>
      expect(screen.queryByText(/Where files live/)).toBeNull(),
    )
  })
})
