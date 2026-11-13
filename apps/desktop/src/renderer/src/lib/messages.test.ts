/**
 * Unit tests for `lib/messages.ts` — the pure helpers behind the
 * edit / retry / regenerate affordances (see
 * `docs/research/conversation-durability.md`).
 */
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import {
  lastAssistantMessage,
  lastUserMessage,
  messageText,
} from './messages'

function msg(
  role: UIMessage['role'],
  parts: UIMessage['parts'],
  id = `${role}-${Math.random().toString(36).slice(2)}`,
): UIMessage {
  return { id, role, parts } as UIMessage
}

const text = (t: string): UIMessage['parts'][number] =>
  ({ type: 'text', text: t }) as UIMessage['parts'][number]

const data = (name: string): UIMessage['parts'][number] =>
  ({ type: `data-${name}`, data: {} }) as UIMessage['parts'][number]

const file = (): UIMessage['parts'][number] =>
  ({
    type: 'file',
    mediaType: 'image/png',
    url: 'data:image/png;base64,x',
  }) as UIMessage['parts'][number]

describe('messageText', () => {
  it('returns the empty string for a message with no parts', () => {
    expect(messageText(msg('user', []))).toBe('')
  })

  it('returns the text of a single text part', () => {
    expect(messageText(msg('user', [text('hello')]))).toBe('hello')
  })

  it('joins multiple text parts in order', () => {
    expect(messageText(msg('user', [text('a'), text('b'), text('c')]))).toBe(
      'abc',
    )
  })

  it('ignores non-text parts', () => {
    expect(
      messageText(msg('user', [data('plan'), text('hi'), file()])),
    ).toBe('hi')
  })

  it('works on assistant messages too', () => {
    expect(messageText(msg('assistant', [text('answer')]))).toBe('answer')
  })
})

describe('lastUserMessage', () => {
  it('returns undefined for an empty transcript', () => {
    expect(lastUserMessage([])).toBeUndefined()
  })

  it('returns the only user message', () => {
    const m = msg('user', [text('hi')], 'u1')
    expect(lastUserMessage([m])).toBe(m)
  })

  it('returns the latest user message even when an assistant reply follows', () => {
    const u1 = msg('user', [text('first')], 'u1')
    const a1 = msg('assistant', [text('answer')], 'a1')
    const u2 = msg('user', [text('second')], 'u2')
    expect(lastUserMessage([u1, a1, u2])).toBe(u2)
  })

  it('skips assistant and system messages', () => {
    const u1 = msg('user', [text('hi')], 'u1')
    const a1 = msg('assistant', [text('answer')], 'a1')
    const s1 = msg('system', [text('sys')], 's1')
    expect(lastUserMessage([u1, a1, s1])).toBe(u1)
  })

  it('finds a failed tail: user message last, nothing after it', () => {
    // After a mid-run provider error the unsent-on-server user prompt is
    // still the last client-side message — the retry path keys off it.
    const u1 = msg('user', [text('retry me')], 'u1')
    expect(lastUserMessage([msg('assistant', [], 'a0'), u1])).toBe(u1)
  })
})

describe('lastAssistantMessage', () => {
  it('returns undefined for an empty transcript', () => {
    expect(lastAssistantMessage([])).toBeUndefined()
  })

  it('returns the message when the last message is an assistant reply', () => {
    const a1 = msg('assistant', [text('done')], 'a1')
    expect(lastAssistantMessage([msg('user', [], 'u1'), a1])).toBe(a1)
  })

  it('returns undefined when the transcript ends on a user message', () => {
    // Failed/interrupted tail: regenerate must NOT be offered — cutting
    // here would drop the unanswered user prompt from the request.
    const u1 = msg('user', [text('unanswered')], 'u1')
    expect(
      lastAssistantMessage([msg('assistant', [], 'a1'), u1]),
    ).toBeUndefined()
  })

  it('returns undefined when the transcript ends on a system message', () => {
    expect(
      lastAssistantMessage([msg('assistant', [], 'a1'), msg('system', [], 's1')]),
    ).toBeUndefined()
  })
})
