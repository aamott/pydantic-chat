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
    id: 'api-keys',
    title: 'API Keys',
    keywords: [
      'api key keys secret credential credentials providers anthropic openai chat completions google gemini vertex cloud ollama openai-compatible base url endpoint',
    ],
    component: ApiKeysSection,
  },
]
