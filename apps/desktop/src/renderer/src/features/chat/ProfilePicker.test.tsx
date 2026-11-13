/**
 * Component tests for `ProfilePicker` — the composer's permission-profile
 * dropdown. The Zustand stores are seeded directly (loaded: true, so
 * `ensureLoaded` never fetches); `lib/api` is mocked at the `apiJson`
 * seam so a pick's PATCH body can be asserted without a backend.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiJson } from '../../lib/api'
import {
  chatSummary,
  seedStores,
  toolProfile,
  workspace,
} from '../../test/fixtures'
import { ProfilePicker } from './ProfilePicker'

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
}))

const apiJsonMock = vi.mocked(apiJson)

const PROFILES = [
  toolProfile({ id: 'manual', name: 'Manual' }),
  toolProfile({
    id: 'smart',
    name: 'Smart',
    description: 'A judge model auto-approves low-risk calls.',
    approval_mode: 'smart',
  }),
  toolProfile({
    id: 'read-only',
    name: 'Read only',
    description: 'No writes.',
    builtin: true,
  }),
  toolProfile({
    id: 'ci-mode',
    name: 'CI mode',
    description: 'Custom profile.',
    builtin: false,
  }),
]

/** The PATCH body `updateChat` last sent (apiJson init arg). */
function lastPatchBody(): Record<string, unknown> {
  const init = apiJsonMock.mock.calls.at(-1)?.[1]
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

describe('ProfilePicker', () => {
  beforeEach(() => {
    apiJsonMock.mockReset()
    seedStores({ profiles: PROFILES, globalProfile: 'manual' })
  })

  it('shows the inherited global profile when the chat has no override', () => {
    render(<ProfilePicker chatId="chat-1" />)
    expect(
      screen.getByRole('button', { name: /inherited \(manual\)/i }),
    ).toBeTruthy()
  })

  it('falls back to the workspace profile before the global one', () => {
    seedStores({
      profiles: PROFILES,
      globalProfile: 'manual',
      workspaces: [
        workspace({
          permission_profile: 'read-only',
          chats: [chatSummary({ permission_profile: null })],
        }),
      ],
    })
    render(<ProfilePicker chatId="chat-1" />)
    expect(
      screen.getByRole('button', { name: /inherited \(read only\)/i }),
    ).toBeTruthy()
  })

  it('opens a popover listing Inherit plus every profile, Inherit selected', () => {
    render(<ProfilePicker chatId="chat-1" />)
    fireEvent.click(screen.getByRole('button', { name: /inherited/i }))

    expect(screen.getByRole('dialog')).toBeTruthy()
    const inherit = screen.getByRole('button', { name: /^Inherit/ })
    expect(inherit.getAttribute('aria-current')).toBe('true')
    // Builtin rows lead with the Lock icon's "Built-in profile" label.
    expect(
      screen.getByRole('button', { name: /^Built-in profileManual/ }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /^Built-in profileSmart/ }),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: /^CI mode/ })).toBeTruthy()
  })

  it('PATCHes permission_profile when a profile row is picked', () => {
    apiJsonMock.mockImplementation(async () =>
      chatSummary({ permission_profile: 'smart' }),
    )
    render(<ProfilePicker chatId="chat-1" />)
    fireEvent.click(screen.getByRole('button', { name: /inherited/i }))
    fireEvent.click(
      screen.getByRole('button', { name: /^Built-in profileSmart/ }),
    )

    expect(apiJsonMock).toHaveBeenCalledWith(
      '/api/chats/chat-1',
      expect.objectContaining({ method: 'PATCH' }),
    )
    expect(lastPatchBody()).toEqual({ permission_profile: 'smart' })
    // The popover closes on pick.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('PATCHes null when Inherit is picked on a chat with an override', () => {
    apiJsonMock.mockImplementation(async () =>
      chatSummary({ permission_profile: null }),
    )
    seedStores({
      profiles: PROFILES,
      workspaces: [
        workspace({
          chats: [chatSummary({ permission_profile: 'smart' })],
        }),
      ],
    })
    render(<ProfilePicker chatId="chat-1" />)
    // The button shows the override's name, not "inherited (...)".
    fireEvent.click(screen.getByRole('button', { name: 'Smart' }))
    fireEvent.click(screen.getByRole('button', { name: /^Inherit/ }))

    expect(lastPatchBody()).toEqual({ permission_profile: null })
  })
})
