/**
 * Section registry: the single source of truth for the settings window's
 * left nav and search index.
 *
 * `keywords` is the section's aggregate search index — it should cover the
 * terms of every `Field` inside the section so a field-level match also
 * surfaces the section in the nav. Fields filter themselves against their
 * own narrower keywords (see components.tsx `Field`).
 */
import type { ComponentType } from 'react'
import { GeneralSection } from './sections/GeneralSection'
import { ModelSection } from './sections/ModelSection'
import { PermissionsSection } from './sections/PermissionsSection'
import { ApiKeysSection } from './sections/ApiKeys'
import { McpServersSection } from './sections/McpServersSection'
import { ToolProfilesSection } from './sections/ToolProfilesSection'
import { UserToolsSection } from './sections/UserToolsSection'

export interface SettingsSection {
  /** Stable id — nav keys and `settings-section-{id}` anchor targets. */
  id: string
  /** Nav + heading title; a title match keeps the whole section visible. */
  title: string
  /** Lowercase terms the search box matches against for this section. */
  keywords: string[]
  component: ComponentType
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'general',
    title: 'General',
    keywords: ['theme appearance dark light system color mode colours'],
    component: GeneralSection,
  },
  {
    id: 'model',
    title: 'Model',
    keywords: [
      'model default provider judge reviewer anthropic openai google ollama claude gpt gemini spec smart',
    ],
    component: ModelSection,
  },
  {
    id: 'permissions',
    title: 'Permissions',
    keywords: [
      'permission profile approval bypass smart manual read-only readonly ask allow allowed deny denied whitelist blacklist commands shell bash terminal file patterns glob filesystem secrets env',
    ],
    component: PermissionsSection,
  },
  {
    id: 'tool-profiles',
    title: 'Tool Profiles',
    keywords: [
      'tool profile profiles permission custom builtin duplicate approval bypass smart manual tools filesystem shell planning mcp prefix allowlist skills system workspace read-only readonly',
    ],
    component: ToolProfilesSection,
  },
  {
    id: 'mcp-servers',
    title: 'MCP Servers',
    keywords: [
      'mcp server tools stdio http command args arguments env environment url headers enabled external tool servers model context protocol',
    ],
    component: McpServersSection,
  },
  {
    id: 'user-tools',
    title: 'User Tools',
    keywords: [
      'user tools custom tool python file functions global workspace devin user_ create edit source enabled',
    ],
    component: UserToolsSection,
  },
  {
    id: 'api-keys',
    title: 'API Keys',
    keywords: [
      'api key keys secret credential credentials providers anthropic openai chat completions google gemini vertex cloud ollama openai-compatible base url endpoint',
    ],
    component: ApiKeysSection,
  },
]
