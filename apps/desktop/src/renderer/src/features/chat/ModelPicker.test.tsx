/**
 * Component tests for `ModelPicker` — the composer's model catalog
 * dropdown. Stores are seeded directly; `lib/api` is mocked at the
 * `apiJson` seam so a selection's PATCH body can be asserted without a
 * backend.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProviderGroup } from '@pydantic-chat/shared'
import { apiJson } from '../../lib/api'
import {
  chatSummary,
  providerGroup,
  seedStores,
  workspace,
} from '../../test/fixtures'
import { ModelPicker } from './ModelPicker'

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
}))

const apiJsonMock = vi.mocked(apiJson)

const PROVIDERS: ModelProviderGroup[] = [
  providerGroup({
    models: [
      {
        id: 'anthropic:claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        thinking_levels: ['off', 'low', 'high'],
        max_context: 200_000,
      },
      {
        id: 'anthropic:claude-opus-4-5',
        name: 'Claude Opus 4.5',
        thinking_levels: ['off', 'medium', 'high'],
        max_context: 200_000,
      },
    ],
  }),
  providerGroup({
    provider: 'openai',
    label: 'OpenAI',
    models: [
      {
        id: 'openai:gpt-5.2',
        name: 'GPT 5.2',
        thinking_levels: [],
        max_context: null,
      },
    ],
  }),
]

function lastPatchBody(): Record<string, unknown> {
  const init = apiJsonMock.mock.calls.at(-1)?.[1]
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

/** Open the picker: click the trigger showing the current short name. */
function openPicker(): void {
  fireEvent.click(
    screen.getByRole('button', { name: /claude-sonnet-4-6/ }),
  )
}

/** Model rows inside the open popover — the dialog's buttons minus the
 *  clear-filter control, which only renders while the filter is non-empty. */
function pickerRows(): HTMLElement[] {
  return within(screen.getByRole('dialog'))
    .queryAllByRole('button')
    .filter((el) => el.getAttribute('aria-label') !== 'Clear model filter')
}

describe('ModelPicker', () => {
  beforeEach(() => {
    apiJsonMock.mockReset()
    apiJsonMock.mockImplementation(async () => chatSummary())
    seedStores({
      providers: PROVIDERS,
      workspaces: [
        workspace({
          chats: [
            chatSummary({ model: 'anthropic:claude-sonnet-4-6' }),
          ],
        }),
      ],
    })
  })

  it('opens the catalog with every model listed and the input focused', () => {
    render(<ModelPicker chatId="chat-1" />)
    openPicker()

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(pickerRows()).toHaveLength(3)
    const input = screen.getByRole('textbox', { name: 'Filter models' })
    expect(document.activeElement).toBe(input)
  })

  it('filters the list on whitespace-separated tokens', () => {
    render(<ModelPicker chatId="chat-1" />)
    openPicker()
    const input = screen.getByRole('textbox', { name: 'Filter models' })

    fireEvent.change(input, { target: { value: 'opus' } })
    let options = pickerRows()
    expect(options).toHaveLength(1)
    expect(options[0].textContent).toContain('Claude Opus 4.5')

    // Provider labels match too — 'openai' leaves only the GPT row.
    fireEvent.change(input, { target: { value: 'openai' } })
    options = pickerRows()
    expect(options).toHaveLength(1)
    expect(options[0].textContent).toContain('GPT 5.2')

    // Nothing matches → the empty-state message.
    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(pickerRows()).toHaveLength(0)
    expect(screen.getByText('No models match.')).toBeTruthy()
  })

  it('Enter picks the highlighted match and PATCHes model + thinking', () => {
    render(<ModelPicker chatId="chat-1" />)
    openPicker()
    const input = screen.getByRole('textbox', { name: 'Filter models' })

    fireEvent.change(input, { target: { value: 'opus' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(apiJsonMock).toHaveBeenCalledWith(
      '/api/chats/chat-1',
      expect.objectContaining({ method: 'PATCH' }),
    )
    // Opus's first non-`off` level is applied as the thinking choice.
    expect(lastPatchBody()).toEqual({
      model: 'anthropic:claude-opus-4-5',
      thinking: 'medium',
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('clicking a row selects it directly', () => {
    render(<ModelPicker chatId="chat-1" />)
    openPicker()
    fireEvent.click(screen.getByRole('button', { name: /GPT 5\.2/ }))

    expect(lastPatchBody()).toEqual({
      model: 'openai:gpt-5.2',
      // No thinking levels → `default` resolves to null.
      thinking: null,
    })
  })
})
