/**
 * Pure helpers over `UIMessage[]` for the edit / retry / regenerate
 * affordances (design: `docs/research/conversation-durability.md`).
 *
 * One mechanism covers all three resubmit flows:
 * `sendMessage({text, messageId})` truncates client state at the named user
 * message, replaces its text, and POSTs `submit-message`; server-side the
 * stored history is cut just before the matching user prompt (the replaced
 * tail is kept as a branch) or appended when the id was never stored — e.g.
 * a run that failed mid-stream saved nothing, not even the prompt.
 *
 * `regenerate({messageId})` is reserved for re-answering a completed
 * assistant response: on an unstored tail it is rejected server-side
 * (`UserError`), so it must never back the error-retry path.
 */
import type { UIMessage } from 'ai'

/**
 * The message's text content: every `text` part joined in order.
 * Non-text parts (files, data parts, tool parts) contribute nothing.
 */
export function messageText(message: UIMessage): string {
  let out = ''
  for (const part of message.parts) {
    if (part.type === 'text' && 'text' in part) out += part.text
  }
  return out
}

/**
 * The most recent `user` message in the transcript, or undefined.
 *
 * After a failed run this is the unanswered tail prompt — it exists only
 * client-side (nothing was persisted), which is exactly the id/text pair
 * `sendMessage({text, messageId})` needs to retry it.
 */
export function lastUserMessage(
  messages: UIMessage[],
): UIMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i]
  }
  return undefined
}

/**
 * The trailing assistant message, or undefined when the transcript does
 * not end on one.
 *
 * Regenerate is only safe on a completed tail: slicing at a mid-history
 * assistant message would drop later user turns from the request, and on
 * an unstored tail the server rejects `regenerate-message` outright.
 */
export function lastAssistantMessage(
  messages: UIMessage[],
): UIMessage | undefined {
  const last = messages[messages.length - 1]
  return last?.role === 'assistant' ? last : undefined
}
