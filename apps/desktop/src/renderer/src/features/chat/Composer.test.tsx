/**
 * Component tests for `Composer`'s `@` mention popup and send path.
 *
 * `useWorkspaceFiles` (the `/api/files/tree` fetch hook) is mocked to a
 * ready fixture so the mention popup renders instantly and
 * deterministically; the embedded ProfilePicker/ModelPicker read seeded
 * Zustand stores (`loaded: true` → no fetches).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlatFile } from '../../lib/workspaceFiles'
import { seedStores } from '../../test/fixtures'
import { Composer } from './Composer'
import { useWorkspaceFiles } from './useWorkspaceFiles'

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
}))

vi.mock('./useWorkspaceFiles', () => ({
  useWorkspaceFiles: vi.fn(),
}))

const filesMock = vi.mocked(useWorkspaceFiles)

const FILES: FlatFile[] = [
  { name: 'api.ts', path: 'src/lib/api.ts' },
  { name: 'App.tsx', path: 'src/App.tsx' },
  { name: 'README.md', path: 'README.md' },
]

function renderComposer(): void {
  filesMock.mockReturnValue({
    status: 'ready',
    files: FILES,
    truncated: false,
  })
  render(
    <Composer
      chatId="chat-1"
      workspaceId="ws-1"
      status="ready"
      onSend={vi.fn()}
      onStop={vi.fn()}
    />,
  )
}

function textarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(
    'Message the agent…',
  ) as HTMLTextAreaElement
}

/**
 * Set the textarea's value and park a collapsed caret at its end, then
 * fire `select` so `updateMention` re-detects the `@query` token. The
 * explicit selection dance keeps the test independent of where jsdom
 * leaves the caret after a programmatic `value` assignment.
 */
function typeText(value: string): void {
  const el = textarea()
  fireEvent.change(el, { target: { value } })
  el.setSelectionRange(el.value.length, el.value.length)
  fireEvent.select(el)
}

describe('Composer @ mentions', () => {
  beforeEach(() => {
    filesMock.mockReset()
    seedStores()
  })

  it('opens the mention listbox on `@` and filters by the typed query', () => {
    renderComposer()
    typeText('check @ap')

    const listbox = screen.getByRole('listbox', {
      name: 'Mention a workspace file',
    })
    expect(listbox).toBeTruthy()
    // 'ap' matches both api.ts and App.tsx, not README.md.
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(
      screen.getByRole('option', { name: 'src/lib/api.ts' }),
    ).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'README.md' })).toBeNull()
  })

  it('does not open for an email-like token (`a@b`)', () => {
    renderComposer()
    typeText('mail me@example.com')
    expect(
      screen.queryByRole('listbox', { name: 'Mention a workspace file' }),
    ).toBeNull()
  })

  it('Enter replaces the @query with the highlighted file link', () => {
    renderComposer()
    typeText('check @api')

    // Only api.ts matches `api`, so Enter picks it.
    fireEvent.keyDown(textarea(), { key: 'Enter' })

    expect(textarea().value).toBe('check [api.ts](file:src/lib/api.ts) ')
    expect(
      screen.queryByRole('listbox', { name: 'Mention a workspace file' }),
    ).toBeNull()
  })

  it('clicking a mention row inserts its file link', () => {
    renderComposer()
    typeText('see @rea')

    fireEvent.click(screen.getByRole('option', { name: 'README.md' }))
    expect(textarea().value).toBe('see [README.md](file:README.md) ')
  })

  it('Escape closes the popup and leaves the text alone', () => {
    renderComposer()
    typeText('check @ap')
    fireEvent.keyDown(textarea(), { key: 'Escape' })

    expect(
      screen.queryByRole('listbox', { name: 'Mention a workspace file' }),
    ).toBeNull()
    expect(textarea().value).toBe('check @ap')
  })
})

describe('Composer send', () => {
  beforeEach(() => {
    filesMock.mockReset()
    seedStores()
  })

  it('Enter calls onSend with the trimmed text and clears the field', () => {
    const onSend = vi.fn()
    filesMock.mockReturnValue({
      status: 'ready',
      files: FILES,
      truncated: false,
    })
    render(
      <Composer
        chatId="chat-1"
        workspaceId="ws-1"
        status="ready"
        onSend={onSend}
        onStop={vi.fn()}
      />,
    )

    fireEvent.change(textarea(), { target: { value: '  hello there  ' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('hello there')
    expect(textarea().value).toBe('')
  })
})
