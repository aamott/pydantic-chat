/**
 * Settings window root: left section nav + searchable content area.
 *
 * The section registry drives both panes. While the search box is empty the
 * content area shows the single active section; with a query it stacks every
 * matching section and lets each `Field` filter itself (search.ts /
 * components.tsx). The footer Save/Revert bar appears on unsaved changes;
 * the draft/saved bookkeeping lives in stores/settings.ts.
 */
import { useEffect, useState } from 'react'
import { AlertCircle, Search, X } from 'lucide-react'
import { useSettingsStore } from '../../stores/settings'
import { SETTINGS_SECTIONS } from './registry'
import {
  SearchContext,
  SectionMatchedContext,
  matchesSearch,
  sectionMatchesQuery,
} from './search'
import { primaryButtonClass, secondaryButtonClass } from './components'

export function SettingsApp(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const loaded = useSettingsStore((s) => s.loaded)
  const dirty = useSettingsStore((s) => s.dirty)
  const saving = useSettingsStore((s) => s.saving)
  const error = useSettingsStore((s) => s.error)
  const savedAt = useSettingsStore((s) => s.savedAt)
  const load = useSettingsStore((s) => s.load)
  const save = useSettingsStore((s) => s.save)
  const revert = useSettingsStore((s) => s.revert)
  const dismissError = useSettingsStore((s) => s.dismissError)

  const [activeId, setActiveId] = useState(SETTINGS_SECTIONS[0]?.id ?? '')
  const [rawQuery, setRawQuery] = useState('')
  const query = rawQuery.trim().toLowerCase()
  const searching = query.length > 0

  // Brief "Saved" confirmation after a successful save.
  const [savedFlash, setSavedFlash] = useState(false)
  useEffect(() => {
    if (!savedAt) return
    setSavedFlash(true)
    const timer = setTimeout(() => setSavedFlash(false), 2500)
    return () => clearTimeout(timer)
  }, [savedAt])

  useEffect(() => {
    void load()
  }, [load])

  const visibleSections = searching
    ? SETTINGS_SECTIONS.filter((section) => sectionMatchesQuery(query, section))
    : SETTINGS_SECTIONS

  /** Nav click: select the section (and scroll to it while searching). */
  const jumpTo = (id: string): void => {
    setActiveId(id)
    if (searching) {
      document
        .getElementById(`settings-section-${id}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  return (
    <div className="flex h-screen flex-col bg-white text-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
      {/* Search header — filters nav items and individual fields. */}
      <header className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-2.5 dark:border-neutral-700">
        <Search className="h-4 w-4 shrink-0 text-neutral-400" />
        <input
          type="text"
          value={rawQuery}
          onChange={(event) => setRawQuery(event.target.value)}
          placeholder="Search settings"
          spellCheck={false}
          className="w-full bg-transparent text-sm outline-none placeholder:text-neutral-400"
        />
        {rawQuery && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setRawQuery('')}
            className="shrink-0 rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Section nav — filtered by the search query. */}
        <nav className="w-40 shrink-0 overflow-y-auto border-r border-neutral-200 py-2 dark:border-neutral-700">
          {visibleSections.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => jumpTo(section.id)}
              className={`block w-full border-r-2 px-4 py-1.5 text-left text-sm ${
                activeId === section.id
                  ? 'border-blue-600 bg-blue-50 font-medium text-blue-700 dark:border-blue-400 dark:bg-blue-950/40 dark:text-blue-300'
                  : 'border-transparent text-neutral-600 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-800'
              }`}
            >
              {section.title}
            </button>
          ))}
        </nav>

        {/* Content: stacked matching sections while searching, else the active one. */}
        <main className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div
              role="alert"
              className="mb-4 flex items-center gap-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300"
            >
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
              <button
                type="button"
                onClick={() => void load()}
                className="shrink-0 rounded bg-red-600 px-2 py-0.5 text-white hover:bg-red-700"
              >
                Retry
              </button>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={dismissError}
                className="shrink-0 text-red-400 hover:text-red-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {!loaded || !settings ? (
            <p className="text-sm text-neutral-400">
              {loaded ? 'Settings unavailable.' : 'Loading…'}
            </p>
          ) : visibleSections.length === 0 ? (
            <p className="text-sm text-neutral-400">
              No settings match “{rawQuery.trim()}”.
            </p>
          ) : (
            <SearchContext.Provider value={query}>
              {(searching ? visibleSections : visibleSections.filter((s) => s.id === activeId)).map(
                (section) => {
                  const Section = section.component
                  // A title match keeps every field in the section visible;
                  // keyword-only matches let fields filter themselves.
                  const titleMatched = matchesSearch(query, section.title)
                  return (
                    <section
                      key={section.id}
                      id={`settings-section-${section.id}`}
                      className="mb-8 scroll-mt-4 last:mb-2"
                    >
                      <SectionMatchedContext.Provider value={titleMatched}>
                        <Section />
                      </SectionMatchedContext.Provider>
                    </section>
                  )
                },
              )}
            </SearchContext.Provider>
          )}
        </main>
      </div>

      {/* Save bar — visible while there are unsaved changes or fresh feedback. */}
      {(dirty || saving || savedFlash) && (
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-neutral-200 px-4 py-2.5 dark:border-neutral-700">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={revert}
              disabled={!dirty || saving}
              className={secondaryButtonClass}
            >
              Revert
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving}
              className={primaryButtonClass}
            >
              Save
            </button>
          </div>
        </footer>
      )}
    </div>
  )
}
