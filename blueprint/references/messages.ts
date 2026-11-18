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

/**
 * The new turn to POST under `manage_message_history='server'`: the
 * client's messages after its last `assistant` message.
 *
 * The backend's `_take_new_turn` derives the same slice server-side, so
 * sending only this tail is equivalent for a well-formed transcript — and
 * strictly safer for a degenerate one: when a cancelled run left the
 * client holding several user prompts and no assistant reply, sending the
 * full transcript made the first stored prompt's `ui_message_id` match,
 * resubmit-cutting history and merging every earlier prompt into one
 * stored request (quadratic growth).
 *
 * When the slice is empty — the transcript ends on an assistant message,
 * as approval (`addToolApprovalResponse`) and tool-output (`addToolOutput`)
 * auto-resubmits do — the last message is returned alone so the request
 * still carries the message the body's `messageId` refers to.
 */
export function newTurnMessages(messages: UIMessage[]): UIMessage[] {
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant') {
      lastAssistant = i
      break
    }
  }
  const newTurn = messages.slice(lastAssistant + 1)
  if (newTurn.length > 0) return newTurn
  const last = messages[messages.length - 1]
  return last ? [last] : []
}
