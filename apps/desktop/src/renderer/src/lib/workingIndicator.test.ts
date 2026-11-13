/**
 * Unit tests for `lib/workingIndicator.ts` — the pure rules behind the
 * "Working… Ns" dead-air indicator: when it shows, what counts as the run
 * having produced visible output, and how elapsed time renders.
 */
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import {
  formatElapsed,
  runHasVisibleOutput,
  showWorkingIndicator,
} from './workingIndicator'

function msg(
  role: UIMessage['role'],
  parts: UIMessage['parts'],
  id = `${role}-${Math.random().toString(36).slice(2)}`,
): UIMessage {
  return { id, role, parts } as UIMessage
}

const text = (t: string): UIMessage['parts'][number] =>
  ({ type: 'text', text: t }) as UIMessage['parts'][number]

const reasoning = (t: string): UIMessage['parts'][number] =>
  ({ type: 'reasoning', text: t, state: 'streaming' }) as UIMessage['parts'][number]

const toolCall = (): UIMessage['parts'][number] =>
  ({
    type: 'tool-read_file',
    toolCallId: 'call-1',
    state: 'input-streaming',
    input: { path: '/x' },
  }) as UIMessage['parts'][number]

const stepStart = (): UIMessage['parts'][number] =>
  ({ type: 'step-start' }) as UIMessage['parts'][number]

const data = (name: string, payload: unknown = {}): UIMessage['parts'][number] =>
  ({ type: `data-${name}`, data: payload }) as UIMessage['parts'][number]

describe('formatElapsed', () => {
  it('renders zero elapsed as 0s', () => {
    expect(formatElapsed(0)).toBe('0s')
  })

  it('floors sub-second remainders', () => {
    expect(formatElapsed(999)).toBe('0s')
    expect(formatElapsed(12_999)).toBe('12s')
  })

  it('renders whole seconds under a minute', () => {
    expect(formatElapsed(1_000)).toBe('1s')
    expect(formatElapsed(59_000)).toBe('59s')
  })

  it('switches to m:ss at one minute', () => {
    expect(formatElapsed(60_000)).toBe('1:00')
    expect(formatElapsed(65_000)).toBe('1:05')
    expect(formatElapsed(119_999)).toBe('1:59')
  })

  it('renders multi-digit minutes with zero-padded seconds', () => {
    expect(formatElapsed(600_000)).toBe('10:00')
    expect(formatElapsed(727_400)).toBe('12:07')
  })

  it('clamps negative elapsed to 0s', () => {
    // Clock skew / a `now` captured before the recorded start.
    expect(formatElapsed(-5_000)).toBe('0s')
  })
})

describe('runHasVisibleOutput', () => {
  it('returns false for an empty transcript', () => {
    expect(runHasVisibleOutput([])).toBe(false)
  })

  it('returns false when the tail is a user message', () => {
    // Run submitted, assistant message not created yet — the dead-air case.
    expect(runHasVisibleOutput([msg('user', [text('hi')], 'u1')])).toBe(false)
  })

  it('returns false for a tail assistant message with no parts', () => {
    expect(runHasVisibleOutput([msg('assistant', [], 'a1')])).toBe(false)
  })

  it('ignores stream-only data parts that never render inline', () => {
    // data-run-meta lands on the assistant message at stream start — it
    // must NOT count as output or the indicator would never appear.
    const hidden = [
      data('run-meta', { permission_profile: 'coder', model: 'm' }),
      data('shell', { phase: 'started' }),
    ]
    expect(runHasVisibleOutput([msg('assistant', hidden, 'a1')])).toBe(false)
  })

  it('ignores step boundaries and empty text placeholders', () => {
    // A step-start renders only an <hr>; an empty text part renders
    // nothing. Neither signals liveness.
    const parts = [stepStart(), text('')]
    expect(runHasVisibleOutput([msg('assistant', parts, 'a1')])).toBe(false)
  })

  it('returns true once a non-empty text part exists', () => {
    const a1 = msg('assistant', [stepStart(), text('Hel')], 'a1')
    expect(runHasVisibleOutput([a1])).toBe(true)
  })

  it('returns true for reasoning output', () => {
    // The reasoning part renders a live "Thinking…" collapsible.
    expect(
      runHasVisibleOutput([msg('assistant', [reasoning('hmm')], 'a1')]),
    ).toBe(true)
  })

  it('returns true for a tool call', () => {
    // The ToolCard itself shows the call's live state — the run is not
    // dead air even though no text has landed yet.
    expect(
      runHasVisibleOutput([msg('assistant', [toolCall()], 'a1')]),
    ).toBe(true)
  })

  it('returns true for rendered data parts (e.g. a plan snapshot)', () => {
    const plan = data('plan', { change: 'created', tasks: [] })
    expect(runHasVisibleOutput([msg('assistant', [plan], 'a1')])).toBe(true)
  })

  it("only considers the TAIL message: a prior turn's text doesn't count", () => {
    // Turn 2 just started — turn 1's assistant text must not suppress the
    // indicator while the new run is silent.
    const a1 = msg('assistant', [text('old answer')], 'a1')
    const u2 = msg('user', [text('next')], 'u2')
    expect(runHasVisibleOutput([a1, u2])).toBe(false)
  })
})

describe('showWorkingIndicator', () => {
  it('shows during submitted while the run is silent', () => {
    const messages = [msg('user', [text('hi')], 'u1')]
    expect(showWorkingIndicator('submitted', messages)).toBe(true)
  })

  it('shows during streaming while the run is still silent', () => {
    // The stream emitted `start` (assistant message exists, maybe even a
    // run-meta data part) but no content yet — the slow-first-token gap.
    const messages = [
      msg('user', [text('hi')], 'u1'),
      msg('assistant', [data('run-meta', {}), stepStart()], 'a1'),
    ]
    expect(showWorkingIndicator('streaming', messages)).toBe(true)
  })

  it('hides once the run produces visible output', () => {
    const messages = [
      msg('user', [text('hi')], 'u1'),
      msg('assistant', [text('Hello')], 'a1'),
    ]
    expect(showWorkingIndicator('streaming', messages)).toBe(false)
    expect(showWorkingIndicator('submitted', messages)).toBe(false)
  })

  it('hides when the run is not live, even if the tail has no output', () => {
    // Error/stop leave a silent tail (e.g. an unanswered user prompt);
    // the indicator must be gone.
    const messages = [msg('user', [text('hi')], 'u1')]
    expect(showWorkingIndicator('ready', messages)).toBe(false)
    expect(showWorkingIndicator('error', messages)).toBe(false)
  })

  it('hides on an empty transcript unless a run is live', () => {
    expect(showWorkingIndicator('ready', [])).toBe(false)
    expect(showWorkingIndicator('submitted', [])).toBe(true)
  })
})
