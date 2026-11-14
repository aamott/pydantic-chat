/**
 * Component tests for `MessageList`'s version-switcher wiring: a user
 * message with replaced versions gets the "edited" chip, and picking a
 * version resubmits its text through `onEditMessage` — the same
 * `sendMessage({text, messageId})` cut the edit path uses, so the current
 * tail survives as a stored branch.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { PromptVersion } from '@pydantic-chat/shared'
import { MessageList } from './MessageList'

function userMessage(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

const VERSIONS: PromptVersion[] = [
  {
    id: 'entry-old',
    message_id: 'm-1',
    tip: 'tip-old',
    text: 'the earlier wording',
    timestamp: new Date().toISOString(),
  },
]

function renderList(
  props: Partial<Parameters<typeof MessageList>[0]> = {},
) {
  return render(
    <MessageList
      messages={[
        userMessage('m-1', 'the current wording'),
        { id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
      ]}
      status="ready"
      onApprovalResponse={vi.fn()}
      onEditMessage={vi.fn()}
      onRegenerate={vi.fn()}
      {...props}
    />,
  )
}

describe('MessageList version switcher', () => {
  it('shows the chip only on messages with replaced versions', () => {
    const onEditMessage = vi.fn()
    renderList({
      versions: VERSIONS,
      onEditMessage,
      messages: [
        userMessage('m-1', 'the current wording'),
        userMessage('m-2', 'a different prompt'),
      ],
    })

    const chips = screen.getAllByRole('button', {
      name: 'edited — 1 previous version',
    })
    expect(chips).toHaveLength(1)

    fireEvent.click(chips[0])
    fireEvent.click(screen.getByRole('option'))
    expect(onEditMessage).toHaveBeenCalledWith('m-1', 'the earlier wording')
  })

  it('disables the chip while a run is live', () => {
    renderList({ versions: VERSIONS, status: 'streaming' })
    const chip = screen.getByRole('button', {
      name: 'edited — 1 previous version',
    })
    expect(chip).toHaveProperty('disabled', true)
  })
})
