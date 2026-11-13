/**
 * Composer model picker: a button showing the chat's current model short
 * name that opens an anchored-above popover listing every model across the
 * configured providers (`GET /api/models`, flattened).
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
import { Check, ChevronUp } from 'lucide-react'
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
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])
  /** model id → level the user picked in the flyout (not yet applied). */
  const [pending, setPending] = useState<Record<string, string>>({})
  const [flyout, setFlyout] = useState<FlyoutAnchor | null>(null)
  const hideTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

  const effectiveModel = chat?.model ?? defaultModel
  const rows: Row[] = providers.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  )

  /* Seed pending overrides with the chat's stored thinking when the popover
   * opens, so the flyout dropdown shows the persisted level for the current
   * model instead of "Default". */
  useLayoutEffect(() => {
    if (open) {
      setPending(chat?.thinking ? { [effectiveModel]: chat.thinking } : {})
      setFlyout(null)
    }
    // chat?.thinking intentionally read once per open, not live-edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /* Focus the active row on open so arrow-key nav starts in place. */
  useLayoutEffect(() => {
    if (!open) return
    const index = rows.findIndex((r) => r.model.id === effectiveModel)
    rowRefs.current[index >= 0 ? index : 0]?.focus()
    // rows/effectiveModel change between opens, not while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

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

  /* Arrow keys move focus between row buttons; Enter is a native button
   * click. Escape is handled globally by `Popover`. */
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
        : Math.min(Math.max(current + delta, 0), rows.length - 1)
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
          <div
            role="listbox"
            aria-label="Chat model"
            onKeyDown={onListKeyDown}
            onMouseLeave={scheduleHide}
            className="max-h-80 overflow-y-auto p-1"
          >
            {rows.length === 0 && (
              <p className="px-2.5 py-3 text-xs text-neutral-400">
                {modelsError ??
                  'No configured model providers — add an API key in Settings.'}
              </p>
            )}
            {rows.map((row, index) => {
              const selected = row.model.id === effectiveModel
              const level = levelFor(row.model) ?? 'default'
              return (
                <button
                  key={row.model.id}
                  ref={(el) => {
                    rowRefs.current[index] = el
                  }}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => selectModel(row)}
                  onMouseEnter={(e) => showFlyout(row, e.currentTarget)}
                  onFocus={(e) => showFlyout(row, e.currentTarget)}
                  title={row.model.id}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-neutral-100 focus:bg-neutral-100 focus:outline-none ${
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
                  <span className="min-w-0 flex-1 truncate">
                    {row.model.name}
                  </span>
                  {selected && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-blue-600" />
                  )}
                  <span className="shrink-0 text-[11px] text-neutral-400">
                    {level}
                  </span>
                </button>
              )
            })}
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
