/**
 * Component tests for `VersionChip` — the "edited" affordance under a user
 * bubble that lists replaced prompt versions and resubmits a pick.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PromptVersion } from '@pydantic-chat/shared'
import { VersionChip } from './VersionChip'

function version(overrides: Partial<PromptVersion> = {}): PromptVersion {
  return {
    id: 'entry-1',
    message_id: 'm-1',
    tip: 'tip-1',
    text: 'first try',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

const VERSIONS: PromptVersion[] = [
  version({ id: 'b', tip: 'tip-b', text: 'second try' }),
  version({ id: 'a', tip: 'tip-a', text: 'first try' }),
]

describe('VersionChip', () => {
  it('renders nothing when there are no previous versions', () => {
    const { container } = render(
      <VersionChip versions={[]} onPick={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('lists previous versions on click and calls onPick with the choice', () => {
    const onPick = vi.fn()
    render(<VersionChip versions={VERSIONS} onPick={onPick} />)

    fireEvent.click(
      screen.getByRole('button', { name: /edited — 2 previous versions/ }),
    )
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    fireEvent.click(options[0])
    expect(onPick).toHaveBeenCalledWith(VERSIONS[0])
    // Picking closes the popover.
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('is disabled while a run is live', () => {
    render(<VersionChip versions={VERSIONS} disabled onPick={vi.fn()} />)
    const chip = screen.getByRole('button', {
      name: /edited — 2 previous versions/,
    })
    expect(chip).toHaveProperty('disabled', true)
    fireEvent.click(chip)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('uses the singular label for a single version', () => {
    render(<VersionChip versions={[version()]} onPick={vi.fn()} />)
    expect(
      screen.getByRole('button', { name: 'edited — 1 previous version' }),
    ).toBeTruthy()
  })
})
