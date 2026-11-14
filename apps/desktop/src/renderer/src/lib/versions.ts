/**
 * Helpers for the edited-prompt version switcher.
 *
 * `GET /api/chats/{id}/versions` hands back every tail a resubmit replaced
 * (the backend's `ConversationRecord.branches`), each tagged with the
 * `ui_message_id` of the prompt it forked from. The transcript message keeps
 * that same `UIMessage.id` across edits, so `versionsForMessage` is the only
 * join the UI needs.
 */
import type { PromptVersion } from '@pydantic-chat/shared'

/**
 * Versions of the user message `messageId`, most recently replaced first.
 *
 * The endpoint returns branches oldest-left first; reversing gives the
 * popover the natural "previous version on top" order.
 */
export function versionsForMessage(
  versions: PromptVersion[],
  messageId: string,
): PromptVersion[] {
  return versions.filter((v) => v.message_id === messageId).reverse()
}

/** One-line preview of a stored prompt version for a popover row. */
export function versionPreview(text: string, maxChars = 80): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  return `${collapsed.slice(0, maxChars).trimEnd()}…`
}
