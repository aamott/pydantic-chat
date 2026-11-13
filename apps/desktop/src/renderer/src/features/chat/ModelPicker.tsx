/**
 * Composer model picker: a button showing the chat's current model short
 * name that opens an anchored-above popover listing every model across the
 * configured providers (`GET /api/models`).
 *
 * The list is grouped under sticky provider headers (badge + label) in
 * catalog order, behind an autofocused filter input: whitespace-separated
 * tokens must each substring-match the model name, provider label, or spec
 * id (case-insensitive); empty groups drop out. The chat's current model is
 * highlighted while unfiltered — typing highlights the first match,
 * ArrowUp/Down move the highlight, Enter selects it, Escape clears a
 * non-empty filter then (empty) closes the popover.
 *
 * Each row carries a provider badge (colored initial — no brand icons), the
 * model name, and a grayed thinking level: the level that would apply if the
 * row were picked right now (pending flyout override → chat's stored
 * `thinking` for the current model → the model's first non-`off` level →
 * "default").
 *
 * Hovering/focusing a row opens a SIDE flyout — a separate fixed card next
 * to the row, outside the popover — with the model name, a thinking-level
 * dropdown, and `max_context` when known. Flyout choices update the pending
 * level (row text + eventual PATCH); clicking the row selects the model and
 * PATCHes `{model, thinking}` on the chat. For the already-selected model a
 * flyout change PATCHes `{thinking}` immediately so it persists without a
 * redundant row click.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { ModelInfo, ModelProviderGroup } from '@pydantic-chat/shared'
import { Check, ChevronUp, Search, X } from 'lucide-react'
import {
  findChatSummary,
  useChatsStore,
} from '../../stores/chats'
import { useModelsStore } from '../../stores/models'
import { Popover } from './Popover'

/** `anthropic:claude-sonnet-4-6` → `claude-sonnet-4-6` (no prefix → as-is). */
export function shortModelName(spec: string): string {
  const sep = spec.indexOf(':')
  return sep >= 0 ? spec.slice(sep + 1) : spec
}

/* Provider badge colors — initials only, deliberately no brand assets. */
const PROVIDER_COLORS: Record<string, string> = {
  anthropic: 'bg-orange-500',
  openai: 'bg-emerald-600',
  'openai-chat': 'bg-emerald-600',
  google: 'bg-blue-500',
  'google-cloud': 'bg-sky-500',
  ollama: 'bg-neutral-600',
  'openai-compatible': 'bg-purple-500',
}
const FALLBACK_BADGE = 'bg-neutral-500'

/** One flattened list row: a model plus the group it came from. */
interface Row {
  provider: ModelProviderGroup
  model: ModelInfo
}

/** Rendered list entries: provider headers interleaved with model rows. */
type ListItem =
  | { type: 'header'; provider: ModelProviderGroup }
  | { type: 'row'; row: Row; index: number }

/** Sidebar geometry captured from a hovered/focused row element. */
interface FlyoutAnchor {
  row: Row
  top: number
  left: number
  right: number
}

const FLYOUT_WIDTH = 208
const FLYOUT_GAP = 6
/** Grace period so the pointer can travel from a row onto the flyout. */
const HIDE_DELAY_MS = 250

/** The level a model falls back to when nothing overrides it. */
function defaultLevel(model: ModelInfo): string | null {
  return model.thinking_levels.find((level) => level !== 'off') ?? null
}

interface ModelPickerProps {
  chatId: string
  disabled?: boolean
}

export function ModelPicker({
  chatId,
  disabled,
}: ModelPickerProps): React.JSX.Element {
  const chat = useChatsStore((s) => findChatSummary(s.workspaces, chatId))
  const updateChat = useChatsStore((s) => s.updateChat)
  const providers = useModelsStore((s) => s.providers)
  const defaultModel = useModelsStore((s) => s.defaultModel)
  const modelsError = useModelsStore((s) => s.error)
  const ensureLoaded = useModelsStore((s) => s.ensureLoaded)

  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])
  /** model id → level the user picked in the flyout (not yet applied). */
  const [pending, setPending] = useState<Record<string, string>>({})
  const [flyout, setFlyout] = useState<FlyoutAnchor | null>(null)
  const [query, setQuery] = useState('')
  /** Index into `visibleRows` of the keyboard/hover-active row. */
  const [highlighted, setHighlighted] = useState(0)
  const hideTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

  const effectiveModel = chat?.model ?? defaultModel
  const rows: Row[] = providers.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  )

  /* Filter: every whitespace-separated token must substring-match the
   * model name, provider label, or spec id. Empty-token queries (blank
   * input) match everything. Provider groups that filter to nothing are
   * dropped entirely. */
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = (row: Row): boolean =>
    tokens.every(
      (token) =>
        row.model.name.toLowerCase().includes(token) ||
        row.provider.label.toLowerCase().includes(token) ||
        row.model.id.toLowerCase().includes(token),
    )
  const items: ListItem[] = []
  const visibleRows: Row[] = []
  for (const provider of providers) {
    const groupRows = provider.models
      .map((model) => ({ provider, model }))
      .filter(matches)
    if (groupRows.length === 0) continue
    items.push({ type: 'header', provider })
    for (const row of groupRows) {
      items.push({ type: 'row', row, index: visibleRows.length })
      visibleRows.push(row)
    }
  }
  /** Highlight clamped into range — the list can shrink under the index. */
  const activeIndex = Math.min(highlighted, Math.max(visibleRows.length - 1, 0))

  /* On open: seed pending overrides with the chat's stored thinking so the
   * flyout dropdown shows the persisted level for the current model instead
   * of "Default"; reset the filter + highlight and focus the search input. */
  useLayoutEffect(() => {
    if (open) {
      setPending(chat?.thinking ? { [effectiveModel]: chat.thinking } : {})
      setFlyout(null)
      setQuery('')
      rowRefs.current = []
      const index = rows.findIndex((r) => r.model.id === effectiveModel)
      setHighlighted(index >= 0 ? index : 0)
      inputRef.current?.focus()
    }
    // chat?.thinking intentionally read once per open, not live-edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /* Filter changes reset the active row: the current model when the input
   * is empty, the first match while filtering. A still-open flyout anchors
   * to a row that may have filtered out, so it closes too. */
  useLayoutEffect(() => {
    if (!open) return
    const index = rows.findIndex((r) => r.model.id === effectiveModel)
    setHighlighted(tokens.length === 0 ? Math.max(index, 0) : 0)
    setFlyout(null)
    // effectiveModel/rows read live; providers in deps so a late catalog
    // load still lands the unfiltered highlight on the current model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, providers])

  /** Pending override → chat's level (current model) → model default. */
  const levelFor = (model: ModelInfo): string | null =>
    pending[model.id] ??
    (model.id === effectiveModel ? (chat?.thinking ?? null) : null) ??
    defaultLevel(model)

  const scheduleHide = (): void => {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(
      () => setFlyout(null),
      HIDE_DELAY_MS,
    )
  }
  const cancelHide = (): void => window.clearTimeout(hideTimer.current)

  const showFlyout = (row: Row, el: HTMLElement): void => {
    cancelHide()
    const rect = el.getBoundingClientRect()
    setFlyout({ row, top: rect.top, left: rect.left, right: rect.right })
  }

  /** Row click: persist `{model, thinking}` and close the picker. */
  const selectModel = (row: Row): void => {
    void updateChat(chatId, {
      model: row.model.id,
      thinking: levelFor(row.model),
    })
    setOpen(false)
  }

  /**
   * Flyout dropdown change: always record the pending level for the row
   * text; PATCH straight away when it's the chat's model already, since the
   * user shouldn't have to re-click a selected row to persist thinking.
   */
  const pickLevel = (row: Row, value: string): void => {
    const thinking = value === 'default' ? null : value
    setPending((prev) => {
      const next = { ...prev }
      if (thinking === null) delete next[row.model.id]
      else next[row.model.id] = thinking
      return next
    })
    if (row.model.id === effectiveModel) {
      void updateChat(chatId, { thinking })
    }
  }

  const clearQuery = (): void => {
    setQuery('')
    inputRef.current?.focus()
  }

  /** Move the active row by `delta`, scroll it into view, and show its
   * flyout — the same preview hover/focus would have produced. */
  const moveHighlight = (delta: number): void => {
    if (visibleRows.length === 0) return
    const next = Math.min(
      Math.max(activeIndex + delta, 0),
      visibleRows.length - 1,
    )
    setHighlighted(next)
    const el = rowRefs.current[next]
    if (el) {
      el.scrollIntoView({ block: 'nearest' })
      showFlyout(visibleRows[next], el)
    }
  }

  /* Search input keys: arrows move the highlight, Enter selects it, and
   * Escape clears a non-empty filter — an empty-filter Escape is left to
   * propagate so `Popover`'s global handler closes the dialog. */
  const onSearchKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      moveHighlight(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter') {
      const row = visibleRows[activeIndex]
      if (row) {
        e.preventDefault()
        selectModel(row)
      }
    } else if (e.key === 'Escape' && query !== '') {
      e.preventDefault()
      e.stopPropagation()
      clearQuery()
    }
  }

  /* Arrow keys move DOM focus between row buttons (focus also triggers the
   * flyout via onFocus); Enter is a native button click. Escape is handled
   * globally by `Popover`. */
  const onListKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const current = rowRefs.current.findIndex(
      (el) => el === document.activeElement,
    )
    const delta = e.key === 'ArrowDown' ? 1 : -1
    const next =
      current < 0
        ? 0
        : Math.min(Math.max(current + delta, 0), visibleRows.length - 1)
    setHighlighted(next)
    rowRefs.current[next]?.focus()
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Model for this chat: ${effectiveModel}`}
        className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="max-w-40 truncate">{shortModelName(effectiveModel)}</span>
        <ChevronUp className="h-3.5 w-3.5 text-neutral-400" />
      </button>

      {open && (
        <Popover
          anchor={buttonRef.current}
          onClose={() => setOpen(false)}
          align="end"
          className="w-64"
        >
          <div className="border-b border-neutral-100 p-1.5">
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400"
              />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder="Filter models…"
                aria-label="Filter models"
                aria-activedescendant={
                  visibleRows.length > 0
                    ? `model-picker-option-${activeIndex}`
                    : undefined
                }
                spellCheck={false}
                className="w-full rounded-md border border-neutral-200 py-1 pl-7 pr-6 text-xs outline-none placeholder:text-neutral-400 focus:border-blue-400"
              />
              {query !== '' && (
                <button
                  type="button"
                  onClick={clearQuery}
                  aria-label="Clear model filter"
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div
            role="listbox"
            // Programmatically focusable for the aria-activedescendant
            // pattern — keyboard nav lives on the search input, so the
            // listbox stays out of the tab order (S6852).
            tabIndex={-1}
            aria-label="Chat model"
            onKeyDown={onListKeyDown}
            onMouseLeave={scheduleHide}
            className="max-h-80 overflow-y-auto p-1"
          >
            {visibleRows.length === 0 && (
              <p className="px-2.5 py-3 text-xs text-neutral-400">
                {providers.length === 0
                  ? (modelsError ??
                    'No configured model providers — add an API key in Settings.')
                  : 'No models match.'}
              </p>
            )}
            {items.map((item) =>
              item.type === 'header' ? (
                <div
                  key={`provider-${item.provider.provider}`}
                  className="sticky top-0 z-10 flex items-center gap-1.5 bg-white px-2.5 pb-1 pt-1.5"
                >
                  <span
                    aria-hidden
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[9px] font-semibold text-white ${
                      PROVIDER_COLORS[item.provider.provider] ??
                      FALLBACK_BADGE
                    }`}
                  >
                    {item.provider.label.charAt(0).toUpperCase() || '◆'}
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                    {item.provider.label}
                  </span>
                </div>
              ) : (
                <ModelRow
                  key={item.row.model.id}
                  item={item}
                  selected={item.row.model.id === effectiveModel}
                  active={item.index === activeIndex}
                  level={levelFor(item.row.model) ?? 'default'}
                  onSelect={selectModel}
                  onActivate={(row, el, index) => {
                    setHighlighted(index)
                    showFlyout(row, el)
                  }}
                  registerRef={(index, el) => {
                    rowRefs.current[index] = el
                  }}
                />
              ),
            )}
          </div>
        </Popover>
      )}

      {open && flyout && (
        <ModelFlyout
          anchor={flyout}
          pending={pending[flyout.row.model.id] ?? null}
          onPick={(value) => pickLevel(flyout.row, value)}
          onEnter={cancelHide}
          onLeave={() => setFlyout(null)}
        />
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Model row                                                           */
/* ------------------------------------------------------------------ */

interface ModelRowProps {
  item: Extract<ListItem, { type: 'row' }>
  /** The chat's current model — gets the Check. */
  selected: boolean
  /** Keyboard/hover-highlighted row (the input's activedescendant). */
  active: boolean
  /** Effective thinking level shown grayed on the right. */
  level: string
  onSelect: (row: Row) => void
  /** Hover or DOM focus — syncs the highlight and opens the flyout. */
  onActivate: (row: Row, el: HTMLElement, index: number) => void
  registerRef: (index: number, el: HTMLButtonElement | null) => void
}

function ModelRow({
  item,
  selected,
  active,
  level,
  onSelect,
  onActivate,
  registerRef,
}: ModelRowProps): React.JSX.Element {
  const { row, index } = item
  return (
    <button
      id={`model-picker-option-${index}`}
      ref={(el) => registerRef(index, el)}
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(row)}
      onMouseEnter={(e) => onActivate(row, e.currentTarget, index)}
      onFocus={(e) => onActivate(row, e.currentTarget, index)}
      title={row.model.id}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs focus:outline-none ${
        active ? 'bg-neutral-100' : ''
      } hover:bg-neutral-100 focus:bg-neutral-100 ${
        selected ? 'text-neutral-900' : 'text-neutral-700'
      }`}
    >
      <span
        aria-hidden
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white ${
          PROVIDER_COLORS[row.provider.provider] ?? FALLBACK_BADGE
        }`}
      >
        {row.provider.label.charAt(0).toUpperCase() || '◆'}
      </span>
      <span className="min-w-0 flex-1 truncate">{row.model.name}</span>
      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-blue-600" />}
      <span className="shrink-0 text-[11px] text-neutral-400">{level}</span>
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Side flyout                                                         */
/* ------------------------------------------------------------------ */

interface ModelFlyoutProps {
  anchor: FlyoutAnchor
  /** The pending level for this model, or null (inherit/default). */
  pending: string | null
  onPick: (value: string) => void
  onEnter: () => void
  onLeave: () => void
}

function ModelFlyout({
  anchor,
  pending,
  onPick,
  onEnter,
  onLeave,
}: ModelFlyoutProps): React.JSX.Element {
  const { model } = anchor.row
  // Prefer hanging off the row's right edge; flip left when it won't fit.
  const fitsRight =
    anchor.right + FLYOUT_GAP + FLYOUT_WIDTH <= window.innerWidth - 8
  const left = fitsRight
    ? anchor.right + FLYOUT_GAP
    : Math.max(anchor.left - FLYOUT_GAP - FLYOUT_WIDTH, 8)
  const applied = pending ?? defaultLevel(model)
  // Rows live just above the composer — clamp so the card can't run off
  // the viewport's bottom edge (~140px is the tallest flyout content).
  const top = Math.min(anchor.top, Math.max(window.innerHeight - 148, 8))

  return (
    <div
      data-popover-keep
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ position: 'fixed', top, left, width: FLYOUT_WIDTH }}
      className="z-50 rounded-lg border border-neutral-200 bg-white p-2.5 shadow-lg"
    >
      <p className="truncate text-xs font-medium text-neutral-800">
        {model.name}
      </p>
      <p className="truncate text-[10px] text-neutral-400">{model.id}</p>

      {model.thinking_levels.length > 0 && (
        <label className="mt-2 block">
          <span className="mb-0.5 block text-[10px] font-medium tracking-wide text-neutral-400 uppercase">
            Thinking
          </span>
          <select
            value={pending ?? 'default'}
            onChange={(e) => onPick(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-1.5 py-1 text-xs text-neutral-700 focus:border-blue-400 focus:outline-none"
          >
            <option value="default">
              Default{applied ? ` (${applied})` : ''}
            </option>
            {model.thinking_levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      )}

      {model.max_context !== null && (
        <p className="mt-2 text-[11px] text-neutral-500">
          Context: {model.max_context.toLocaleString()} tokens
        </p>
      )}
    </div>
  )
}
