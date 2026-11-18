/**
 * FileExplorer lazy-loading tests: the explorer must fetch only one
 * directory level per request — root on mount (`path=&depth=1`), a dir's
 * children on first expand — cache listings across collapse/re-expand,
 * and re-fetch expanded dirs on refresh while preserving expansion.
 *
 * `lib/api` is mocked so the request shapes are asserted directly; the
 * component mounts fine under jsdom (no CodeMirror/ResizeObserver deps).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '../../lib/api'
import { useUiStore } from '../../stores/ui'
import { FileExplorer } from './FileExplorer'

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
}))

const mockApiFetch = vi.mocked(apiFetch)

interface TestNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children: TestNode[] | null
}

/* Scoped listing per `path=` param — dirs report empty `children` at the
 * frontier, matching the backend's lazy-loading contract. */
const TREE: Record<string, TestNode[]> = {
  '': [
    { name: 'src', path: 'src', type: 'dir', children: [] },
    { name: 'README.md', path: 'README.md', type: 'file', children: null },
  ],
  src: [
    { name: 'lib', path: 'src/lib', type: 'dir', children: [] },
    { name: 'main.ts', path: 'src/main.ts', type: 'file', children: null },
  ],
  'src/lib': [
    { name: 'util.ts', path: 'src/lib/util.ts', type: 'file', children: null },
  ],
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** apiFetch implementation serving `TREE` through the scoped endpoint. */
function serveTree(path: string): Promise<Response> {
  const dir = new URL(`http://backend${path}`).searchParams.get('path') ?? ''
  return Promise.resolve(
    jsonResponse({
      root: {
        name: dir ? (dir.split('/').pop() ?? dir) : 'proj',
        path: dir,
        type: 'dir',
        children: TREE[dir] ?? [],
      },
      truncated: false,
    }),
  )
}

/** Fetch URLs the mock was called with, for one `path=` value. */
function callsFor(dir: string): string[] {
  return mockApiFetch.mock.calls
    .map(([path]) => path)
    .filter(
      (path) =>
        new URL(`http://backend${path}`).searchParams.get('path') === dir,
    )
}

beforeEach(() => {
  mockApiFetch.mockReset()
  mockApiFetch.mockImplementation(serveTree)
  useUiStore.setState({
    currentWorkspaceId: 'ws-1',
    filePath: null,
    openFile: vi.fn(),
  })
})

describe('FileExplorer lazy loading', () => {
  it('fetches only the root level on mount', async () => {
    render(<FileExplorer workspaceId="ws-1" />)
    await screen.findByText('README.md')
    expect(screen.getByText('src')).toBeTruthy()
    // One request: the root scope at depth 1 — no whole-workspace fetch.
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(callsFor('')[0]).toContain('workspace_id=ws-1')
    expect(callsFor('')[0]).toContain('path=&depth=1')
    // The frontier dir renders collapsed — its children were never fetched.
    expect(screen.queryByText('main.ts')).toBeNull()
  })

  it('fetches a dir on first expand, then caches it across collapse', async () => {
    render(<FileExplorer workspaceId="ws-1" />)
    fireEvent.click(await screen.findByText('src'))
    await screen.findByText('main.ts')
    expect(callsFor('src')).toHaveLength(1)

    // Collapse, then re-expand: the cached listing is reused, no refetch.
    fireEvent.click(screen.getByText('src'))
    expect(screen.queryByText('main.ts')).toBeNull()
    fireEvent.click(screen.getByText('src'))
    await screen.findByText('main.ts')
    expect(callsFor('src')).toHaveLength(1)

    // Nested dirs fetch their own level on expand.
    fireEvent.click(screen.getByText('lib'))
    await screen.findByText('util.ts')
    expect(callsFor('src/lib')).toHaveLength(1)
  })

  it('opens a file through the ui store on click', async () => {
    render(<FileExplorer workspaceId="ws-1" />)
    fireEvent.click(await screen.findByText('README.md'))
    expect(useUiStore.getState().openFile).toHaveBeenCalledWith('README.md')
  })

  it('re-fetches expanded dirs on refresh and keeps them expanded', async () => {
    render(<FileExplorer workspaceId="ws-1" />)
    fireEvent.click(await screen.findByText('src'))
    await screen.findByText('main.ts')

    fireEvent.click(screen.getByLabelText('Refresh file tree'))
    // Root + the still-expanded dir are both re-fetched.
    await waitFor(() => expect(callsFor('src')).toHaveLength(2))
    expect(callsFor('')).toHaveLength(2)
    // Expansion survived the cache clear.
    await screen.findByText('main.ts')
  })

  it('renders the error state when the root fetch fails', async () => {
    mockApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Workspace not found' }), {
        status: 404,
      }),
    )
    render(<FileExplorer workspaceId="ws-1" />)
    await screen.findByText('Workspace not found')
  })
})
