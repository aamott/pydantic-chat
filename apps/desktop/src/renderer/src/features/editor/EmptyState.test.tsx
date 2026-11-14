/**
 * Component tests for the shared `EmptyState` panel extracted from the
 * right-panel tabs (RightPanel / DiffPanel / TerminalView / FileExplorer):
 * icon + title + note rendering and the muted/error note tones.
 */
import { render, screen } from '@testing-library/react'
import { FileCode } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('renders icon, title and note', () => {
    const { container } = render(
      <EmptyState
        icon={FileCode}
        title="No file open"
        note="File references in chat and the explorer will open here."
      />,
    )

    // The Lucide icon renders as an inline <svg>.
    expect(container.querySelector('svg')).not.toBeNull()
    expect(screen.getByText('No file open')).toBeTruthy()
    expect(
      screen.getByText(
        'File references in chat and the explorer will open here.',
      ),
    ).toBeTruthy()
  })

  it('renders note-only when icon and title are omitted', () => {
    const { container } = render(<EmptyState note="Loading files…" />)

    expect(screen.getByText('Loading files…')).toBeTruthy()
    expect(container.querySelector('svg')).toBeNull()
    // No title line — the note is the only <p>.
    expect(container.querySelectorAll('p')).toHaveLength(1)
  })

  it('uses the faint note tone by default', () => {
    render(<EmptyState note="No files in this workspace." />)
    const note = screen.getByText('No files in this workspace.')
    expect(note.className).toContain('text-faint')
    expect(note.className).not.toContain('text-danger')
  })

  it('switches the note to danger on tone="error"', () => {
    render(<EmptyState tone="error" note="Request failed (HTTP 500)." />)
    const note = screen.getByText('Request failed (HTTP 500).')
    expect(note.className).toContain('text-danger')
    expect(note.className).not.toContain('text-faint')
  })

  it('keeps the icon faint even on tone="error"', () => {
    const { container } = render(
      <EmptyState icon={FileCode} tone="error" note="Workspace not found." />,
    )
    expect(container.querySelector('svg')?.classList.contains('text-faint')).toBe(
      true,
    )
  })
})
