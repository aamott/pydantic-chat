/**
 * Shared fixtures + store seeding for renderer component tests.
 *
 * The Zustand stores are module singletons — tests seed them directly
 * (`setState`) instead of mocking fetch, matching the store/apiJson seam
 * the app already uses. `loaded: true` makes every `ensureLoaded` a
 * no-op so component mounts never reach the network.
 */
import type {
  ChatSummary,
  ModelProviderGroup,
  ToolProfile,
  Workspace,
} from '@pydantic-chat/shared'
import { useChatsStore } from '../stores/chats'
import { useModelsStore } from '../stores/models'
import { useProfilesStore } from '../stores/profiles'
import { useUiStore } from '../stores/ui'
import { useUserToolsStore } from '../stores/userTools'

export function chatSummary(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: 'chat-1',
    workspace_id: 'ws-1',
    title: 'Test chat',
    updated_at: 0,
    ...overrides,
  }
}

export function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    // A user-home path, not /tmp — the literal is display-only fixture data,
    // but S5443 flags world-writable paths even in tests.
    path: '/home/test/ws-1',
    display_name: 'ws-1',
    last_chat_id: null,
    last_opened_at: 0,
    chats: [chatSummary()],
    ...overrides,
  }
}

export function toolProfile(overrides: Partial<ToolProfile> = {}): ToolProfile {
  return {
    id: 'manual',
    name: 'Manual',
    description: 'Ask before every file write and shell command.',
    approval_mode: 'manual',
    workspace_read_only: false,
    tools: null,
    tool_prefixes: [],
    skills: null,
    builtin: true,
    ...overrides,
  }
}

export function providerGroup(
  overrides: Partial<ModelProviderGroup> = {},
): ModelProviderGroup {
  return {
    provider: 'anthropic',
    label: 'Anthropic',
    models: [
      {
        id: 'anthropic:claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        thinking_levels: ['off', 'low', 'high'],
        max_context: 200_000,
      },
    ],
    ...overrides,
  }
}

/** Baseline the singleton stores before each test. */
export function seedStores(overrides: {
  workspaces?: Workspace[]
  providers?: ModelProviderGroup[]
  defaultModel?: string
  globalProfile?: string
  profiles?: ToolProfile[]
} = {}): void {
  useChatsStore.setState({
    workspaces: overrides.workspaces ?? [workspace()],
    activeWorkspaceId: null,
    activeChatId: null,
    loaded: true,
    backendError: null,
    notice: null,
  })
  useModelsStore.setState({
    providers: overrides.providers ?? [],
    defaultModel: overrides.defaultModel ?? 'anthropic:claude-sonnet-4-6',
    globalProfile: overrides.globalProfile ?? 'manual',
    loaded: true,
    error: null,
  })
  useProfilesStore.setState({
    profiles: overrides.profiles ?? [],
    loaded: true,
    error: null,
  })
  useUserToolsStore.setState({
    tools: [],
    workspaceId: null,
    loaded: false,
    error: null,
  })
  /* The Composer's draft lives in the ui store — clear it so text never
   * leaks between tests. */
  useUiStore.setState({ drafts: {} })
}
