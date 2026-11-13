/**
 * Composer permission-profile picker: a compact button + dropdown that sets
 * the chat's `permission_profile` override via `PATCH /api/chats/{id}`.
 *
 * Inherit chain, weakest to strongest override:
 *   global `settings.permission_profile`
 *   → workspace `permission_profile`
 *   → chat `permission_profile`
 * A null chat value inherits — the button shows `inherited (manual)` style
 * text so the effective profile is never a mystery.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronUp, ShieldCheck } from 'lucide-react'
import { findChatSummary, useChatsStore } from '../../stores/chats'
import { useModelsStore } from '../../stores/models'
import { Popover } from './Popover'

/** Profile value → label + one-line sublabel (same semantics as Settings). */
const PROFILES: Array<{ value: string; name: string; description: string }> = [
  {
    value: 'bypass',
    name: 'Bypass',
    description: 'Run every tool call without asking. Trusted workspaces only.',
  },
  {
    value: 'smart',
    name: 'Smart',
    description: 'A judge model auto-approves low-risk calls; risky ones ask.',
  },
  {
    value: 'manual',
    name: 'Manual',
    description: 'Ask before every file write and shell command.',
  },
  {
    value: 'read-only',
    name: 'Read-only',
    description: 'Read files only — no writes, no shell.',
  },
]

function profileName(value: string | null | undefined): string | null {
  return PROFILES.find((p) => p.value === value)?.name ?? null
}

interface ProfilePickerProps {
  chatId: string
  disabled?: boolean
}

export function ProfilePicker({
  chatId,
  disabled,
}: ProfilePickerProps): React.JSX.Element {
  const workspaces = useChatsStore((s) => s.workspaces)
  const updateChat = useChatsStore((s) => s.updateChat)
  const globalProfile = useModelsStore((s) => s.globalProfile)
  const ensureLoaded = useModelsStore((s) => s.ensureLoaded)

  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

  const chat = findChatSummary(workspaces, chatId)
  const workspace = workspaces.find((w) => w.id === chat?.workspace_id)
  /** What `null` (inherit) on the chat resolves to: workspace → global. */
  const inheritedProfile = workspace?.permission_profile ?? globalProfile
  const override = chat?.permission_profile ?? null

  const pick = (value: string | null): void => {
    void updateChat(chatId, { permission_profile: value })
    setOpen(false)
  }

  const buttonLabel =
    override !== null
      ? (profileName(override) ?? override)
      : `inherited (${(profileName(inheritedProfile) ?? inheritedProfile).toLowerCase()})`

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Permission profile: ${override ?? `${inheritedProfile} (inherited)`}`}
        className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ShieldCheck className="h-3.5 w-3.5 text-neutral-400" />
        <span className="max-w-36 truncate">{buttonLabel}</span>
        <ChevronUp className="h-3.5 w-3.5 text-neutral-400" />
      </button>

      {open && (
        <Popover
          anchor={buttonRef.current}
          onClose={() => setOpen(false)}
          className="w-64"
        >
          <div role="listbox" aria-label="Permission profile" className="p-1">
            {/* Inherit option — null clears the chat override. */}
            <OptionRow
              name="Inherit"
              description={`Use the workspace/global default (${inheritedProfile}).`}
              selected={override === null}
              onPick={() => pick(null)}
            />
            {PROFILES.map((profile) => (
              <OptionRow
                key={profile.value}
                name={profile.name}
                description={profile.description}
                selected={override === profile.value}
                onPick={() => pick(profile.value)}
              />
            ))}
          </div>
        </Popover>
      )}
    </>
  )
}

function OptionRow({
  name,
  description,
  selected,
  onPick,
}: {
  name: string
  description: string
  selected: boolean
  onPick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onPick}
      className="flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-neutral-100 focus:bg-neutral-100 focus:outline-none"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-neutral-800">{name}</span>
        <span className="block text-[11px] text-neutral-400">{description}</span>
      </span>
      {selected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600" />}
    </button>
  )
}
