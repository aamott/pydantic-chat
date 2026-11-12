/**
 * Shared form primitives for the settings window.
 *
 * `Field` is the search-aware wrapper: it hides itself when the active
 * query matches neither the field's own label/hint/keywords nor the
 * enclosing section's title (`SectionMatchedContext`). `TagListEditor` is
 * the chip-list control behind the four allow/deny settings. No component
 * library — these are the house styles for hand-rolled controls.
 */
import { useContext, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { SearchContext, SectionMatchedContext, matchesSearch } from './search'

/** Standard text/select input styling (light + dark). */
export const inputClass =
  'w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100'

/** Primary (blue) action button. */
export const primaryButtonClass =
  'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50'

/** Secondary (bordered) action button. */
export const secondaryButtonClass =
  'rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-800'

/** Section title + optional description shown at the top of each section. */
export function SectionHeading({
  title,
  description,
}: {
  title: string
  description?: string
}): React.JSX.Element {
  return (
    <div>
      <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
        {title}
      </h2>
      {description && (
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          {description}
        </p>
      )}
    </div>
  )
}

/**
 * One labeled setting row that participates in search filtering.
 *
 * `keywords` is extra lowercase search text (synonyms, related provider or
 * tool names) beyond the visible label/hint.
 */
export function Field({
  label,
  hint,
  keywords,
  children,
}: {
  label: string
  hint?: string
  keywords?: string
  children: React.ReactNode
}): React.JSX.Element | null {
  const query = useContext(SearchContext)
  const sectionMatched = useContext(SectionMatchedContext)
  if (!sectionMatched && !matchesSearch(query, label, hint, keywords)) {
    return null
  }
  return (
    <div className="space-y-1.5">
      <div>
        <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
          {label}
        </span>
        {hint && (
          <span className="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

/**
 * Chip-list editor for `list[str]` settings (allow/deny commands & globs):
 * input + Add button (or Enter), each entry a removable chip. Duplicates
 * and blank entries are ignored.
 */
export function TagListEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}): React.JSX.Element {
  const [text, setText] = useState('')

  const add = (): void => {
    const entry = text.trim()
    if (entry && !value.includes(entry)) onChange([...value, entry])
    setText('')
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            } else if (event.key === 'Backspace' && !text && value.length) {
              // Convenience: Backspace on an empty input pops the last chip.
              onChange(value.slice(0, -1))
            }
          }}
          placeholder={placeholder}
          className={inputClass}
        />
        <button
          type="button"
          onClick={add}
          disabled={!text.trim()}
          className={secondaryButtonClass}
        >
          <Plus className="h-4 w-4" />
          <span className="sr-only">Add</span>
        </button>
      </div>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((item) => (
            <li
              key={item}
              className="flex items-center gap-1 rounded-full border border-neutral-300 bg-neutral-50 py-0.5 pl-2.5 pr-1 text-xs text-neutral-700 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200"
            >
              <span className="max-w-64 truncate font-mono">{item}</span>
              <button
                type="button"
                aria-label={`Remove ${item}`}
                onClick={() => onChange(value.filter((v) => v !== item))}
                className="rounded-full p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
