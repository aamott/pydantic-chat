/**
 * Tests for `effectiveProfileId` — the chat → workspace → global inherit
 * chain the FileViewer's read-only gate shares with ProfilePicker.
 */
import { describe, expect, it } from 'vitest'
import type { ChatSummary, Workspace } from '@pydantic-chat/shared'
import { effectiveProfileId } from './chats'

function chat(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: 'chat-1',
    workspace_id: 'ws-1',
    title: 't',
    updated_at: 0,
    ...overrides,
  }
}

function ws(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    path: '/home/test/ws-1',
    display_name: 'ws-1',
    last_chat_id: null,
    last_opened_at: 0,
    chats: [chat()],
    ...overrides,
  }
}

describe('effectiveProfileId', () => {
  it('chat override beats workspace and global', () => {
    const workspaces = [
      ws({
        permission_profile: 'bypass',
        chats: [chat({ permission_profile: 'read-only' })],
      }),
    ]
    expect(effectiveProfileId(workspaces, 'chat-1', 'ws-1', 'manual')).toBe(
      'read-only',
    )
  })

  it('a null chat override inherits the workspace profile', () => {
    const workspaces = [
      ws({ permission_profile: 'read-only', chats: [chat()] }),
    ]
    expect(effectiveProfileId(workspaces, 'chat-1', 'ws-1', 'manual')).toBe(
      'read-only',
    )
  })

  it('falls through to the global profile', () => {
    const workspaces = [ws({ chats: [chat()] })]
    expect(effectiveProfileId(workspaces, 'chat-1', 'ws-1', 'manual')).toBe(
      'manual',
    )
  })

  it('no active chat resolves from the workspace alone', () => {
    const workspaces = [
      ws({ permission_profile: 'read-only', chats: [chat()] }),
    ]
    expect(effectiveProfileId(workspaces, null, 'ws-1', 'manual')).toBe(
      'read-only',
    )
  })

  it('unknown chat and workspace still return the global profile', () => {
    const workspaces = [ws()]
    expect(effectiveProfileId(workspaces, 'nope', 'ws-9', 'manual')).toBe(
      'manual',
    )
  })

  it('a chat in another workspace uses its own workspace profile', () => {
    const other = ws({
      id: 'ws-2',
      permission_profile: 'bypass',
      chats: [chat({ id: 'chat-2', workspace_id: 'ws-2' })],
    })
    const workspaces = [ws({ permission_profile: 'read-only' }), other]
    // The viewer's workspaceId must not leak into another workspace's chain.
    expect(effectiveProfileId(workspaces, 'chat-2', 'ws-1', 'manual')).toBe(
      'bypass',
    )
  })
})
