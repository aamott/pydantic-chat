/**
 * Search plumbing for the settings window.
 *
 * `SearchContext` carries the normalized (lowercased, trimmed) query down to
 * `Field` wrappers; `SectionMatchedContext` tells fields the enclosing
 * section's *title* matched the query, in which case every field in the
 * section stays visible (e.g. searching "permissions" shows the whole
 * section rather than zero fields).
 */
import { createContext } from 'react'
import type { SettingsSection } from './registry'

/** Normalized search query; empty string means "not searching". */
export const SearchContext = createContext('')

/** Whether the enclosing section's own title matched the query. */
export const SectionMatchedContext = createContext(false)

/**
 * Token match: every whitespace-separated token of `query` must appear as a
 * substring of the joined `terms` haystack. More forgiving than a single
 * substring match ("api keys" hits "API key") while staying predictable.
 *
 * Callers pass an already-lowercased query; terms are lowercased here.
 */
export function matchesSearch(
  query: string,
  ...terms: Array<string | undefined | null>
): boolean {
  if (!query) return true
  const haystack = terms
    .filter((term): term is string => Boolean(term))
    .join(' ')
    .toLowerCase()
  return query.split(/\s+/).every((token) => haystack.includes(token))
}

/**
 * Whether a section should appear in the nav/content while searching —
 * matches against the title plus the section's registered keyword index.
 */
export function sectionMatchesQuery(query: string, section: SettingsSection): boolean {
  return matchesSearch(query, section.title, ...section.keywords)
}
