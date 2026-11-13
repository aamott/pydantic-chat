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
  newTurnMessages,
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

describe('newTurnMessages', () => {
  /**
   * The slice `prepareSendMessagesRequest` POSTs under
   * `manage_message_history='server'`: the client's messages after its
   * last assistant message. Sending the full transcript let a transcript
   * with no assistant message (run cancelled before the response arrived)
   * resubmit-cut at the first stored user prompt and merge every earlier
   * prompt into one stored request — quadratic history growth.
   */

  const toolApproval = (): UIMessage['parts'][number] =>
    ({
      type: 'tool-read_file',
      toolCallId: 'call-1',
      state: 'approval-responded',
      input: { path: '/x' },
      approval: { id: 'call-1', approved: true },
    }) as UIMessage['parts'][number]

  it('returns the whole transcript for a single user message', () => {
    const u1 = msg('user', [text('hi')], 'u1')
    expect(newTurnMessages([u1])).toEqual([u1])
  })

  it('sends only the user messages after the last assistant reply', () => {
    // The bug case: without slicing, all three were POSTed and the server
    // merged u1's stored turn into the resubmission.
    const u1 = msg('user', [text('first')], 'u1')
    const a1 = msg('assistant', [text('answer')], 'a1')
    const u2 = msg('user', [text('second')], 'u2')
    expect(newTurnMessages([u1, a1, u2])).toEqual([u2])
  })

  it('keeps consecutive user messages after the last assistant reply', () => {
    // A cancelled/failed turn (no client-side assistant reply) followed by
    // a new send: both unanswered prompts are the new turn. UIMessage has
    // no 'tool' role in v7 — tool results and approvals are parts on the
    // assistant message itself, so only 'user'/'system' can trail it.
    const u1 = msg('user', [text('first')], 'u1')
    const a1 = msg('assistant', [text('answer')], 'a1')
    const u2 = msg('user', [text('cancelled')], 'u2')
    const u3 = msg('user', [text('third')], 'u3')
    expect(newTurnMessages([u1, a1, u2, u3])).toEqual([u2, u3])
  })

  it('returns the lone user message after a resubmit truncation', () => {
    // `sendMessage({text, messageId})` truncates state at the edited user
    // message before the POST, so the transport sees just that message.
    const u1 = msg('user', [text('edited text')], 'u1')
    expect(newTurnMessages([u1])).toEqual([u1])
  })

  it('falls back to the last message when the tail is an assistant message', () => {
    // Approval / tool-output auto-resubmits (`addToolApprovalResponse`,
    // `addToolOutput`) POST a transcript ending in the assistant message
    // carrying the answered part — the slice after it is empty, so the
    // fallback keeps the message `messageId` refers to.
    const u1 = msg('user', [text('do it')], 'u1')
    const a1 = msg('assistant', [toolApproval()], 'a1')
    expect(newTurnMessages([u1, a1])).toEqual([a1])
  })

  it('returns an empty array for an empty transcript', () => {
    expect(newTurnMessages([])).toEqual([])
  })

  it('slices after the LAST assistant message, not the first', () => {
    const u1 = msg('user', [], 'u1')
    const a1 = msg('assistant', [], 'a1')
    const u2 = msg('user', [], 'u2')
    const a2 = msg('assistant', [], 'a2')
    const u3 = msg('user', [], 'u3')
    expect(newTurnMessages([u1, a1, u2, a2, u3])).toEqual([u3])
  })
})
