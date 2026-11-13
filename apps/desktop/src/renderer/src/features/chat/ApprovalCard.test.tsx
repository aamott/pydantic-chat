/**
 * Component tests for `ApprovalGroup` (`ApprovalCard.tsx`) — the
 * approve/deny cards rendered for `approval-requested` tool parts. The
 * `onRespond` callback (wired to `useChat().addToolApprovalResponse` in
 * the app) is spied; no store or fetch seams are involved.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  ApprovalGroup,
  type PendingApprovalPart,
} from './ApprovalCard'

/** Minimal pending-approval tool part fixture. */
function pendingPart(
  id: string,
  input: unknown = { command: `echo ${id}` },
): PendingApprovalPart {
  return {
    type: 'tool-shell',
    toolCallId: id,
    state: 'approval-requested',
    input,
    approval: { id },
  } as PendingApprovalPart
}

describe('ApprovalGroup', () => {
  it('renders a single-request card and Approve responds approved', () => {
    const onRespond = vi.fn()
    render(<ApprovalGroup parts={[pendingPart('call-1')]} onRespond={onRespond} />)

    expect(screen.getByText('Approval required')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }))

    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(onRespond).toHaveBeenCalledWith({
      id: 'call-1',
      approved: true,
      reason: undefined,
    })
  })

  it('Deny expands a reason field and responds denied with it', () => {
    const onRespond = vi.fn()
    render(<ApprovalGroup parts={[pendingPart('call-2')]} onRespond={onRespond} />)

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    const reason = screen.getByPlaceholderText('Reason for denying (optional)')
    fireEvent.change(reason, { target: { value: 'too risky' } })
    // The expanded form's submit button is also labelled Deny.
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

    expect(onRespond).toHaveBeenCalledWith({
      id: 'call-2',
      approved: false,
      reason: 'too risky',
    })
  })

  it('sends reason: undefined when the deny field is left blank', () => {
    const onRespond = vi.fn()
    render(<ApprovalGroup parts={[pendingPart('call-3')]} onRespond={onRespond} />)

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

    expect(onRespond).toHaveBeenCalledWith({
      id: 'call-3',
      approved: false,
      reason: undefined,
    })
  })

  it('groups consecutive requests under one card with Approve all', () => {
    const onRespond = vi.fn()
    render(
      <ApprovalGroup
        parts={[pendingPart('call-a'), pendingPart('call-b')]}
        onRespond={onRespond}
      />,
    )

    expect(screen.getByText('2 approvals required')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))

    expect(onRespond).toHaveBeenCalledTimes(2)
    expect(onRespond).toHaveBeenNthCalledWith(1, {
      id: 'call-a',
      approved: true,
      reason: undefined,
    })
    expect(onRespond).toHaveBeenNthCalledWith(2, {
      id: 'call-b',
      approved: true,
      reason: undefined,
    })
  })

  it('Cancel backs out of the deny form without responding', () => {
    const onRespond = vi.fn()
    render(<ApprovalGroup parts={[pendingPart('call-4')]} onRespond={onRespond} />)

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onRespond).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Approve/ })).toBeTruthy()
  })
})
