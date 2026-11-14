/**
 * Composer permission-profile picker: a compact button + dropdown that sets
 * the chat's `permission_profile` override via `PATCH /api/chats/{id}`.
 *
 * Profiles come from `GET /api/tool-profiles` (builtin + custom, cached in
 * `stores/profiles.ts`) — builtin rows carry a lock marker; unknown ids
 * (deleted custom profiles) render as their raw id.
 *
 * Inherit chain, weakest to strongest override:
 *   global `settings.permission_profile`
 *   → workspace `permission_profile`
 *   → chat `permission_profile`
 * A null chat value inherits — the button shows `inherited (manual)` style
 * text so the effective profile is never a mystery.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronUp, Lock, ShieldCheck } from 'lucide-react'
import { profileName } from '../../lib/profiles'
import { findChatSummary, useChatsStore } from '../../stores/chats'
import { useModelsStore } from '../../stores/models'
import { useProfilesStore } from '../../stores/profiles'
import { Popover } from './Popover'

interface ProfilePickerProps {
  readonly chatId: string
  readonly disabled?: boolean
}

export function ProfilePicker({
  chatId,
  disabled,
}: Readonly<ProfilePickerProps>): React.JSX.Element {
  const workspaces = useChatsStore((s) => s.workspaces)
  const updateChat = useChatsStore((s) => s.updateChat)
  const globalProfile = useModelsStore((s) => s.globalProfile)
  const ensureModelsLoaded = useModelsStore((s) => s.ensureLoaded)
  const profiles = useProfilesStore((s) => s.profiles)
  const ensureProfilesLoaded = useProfilesStore((s) => s.ensureLoaded)

  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    void ensureModelsLoaded()
    void ensureProfilesLoaded()
  }, [ensureModelsLoaded, ensureProfilesLoaded])

  const chat = findChatSummary(workspaces, chatId)
  const workspace = workspaces.find((w) => w.id === chat?.workspace_id)
  /** What `null` (inherit) on the chat resolves to: workspace → global. */
  const inheritedProfile = workspace?.permission_profile ?? globalProfile
  const override = chat?.permission_profile ?? null

  const pick = (value: string | null): void => {
    void updateChat(chatId, { permission_profile: value })
    setOpen(false)
  }

  const inheritedName = profileName(profiles, inheritedProfile)
  const buttonLabel =
    override !== null
      ? profileName(profiles, override)
      : `inherited (${inheritedName.toLowerCase()})`
  const titleProfile = override ?? `${inheritedProfile} (inherited)`

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Permission profile: ${titleProfile}`}
        className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-secondary hover-bg-raised disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ShieldCheck className="h-3.5 w-3.5 text-faint" />
        <span className="max-w-36 truncate">{buttonLabel}</span>
        <ChevronUp className="h-3.5 w-3.5 text-faint" />
      </button>

      {open && (
        <Popover
          anchor={buttonRef.current}
          onClose={() => setOpen(false)}
          className="w-64"
        >
          <div className="p-1">
            {/* Inherit option — null clears the chat override. */}
            <OptionRow
              name="Inherit"
              description={`Use the workspace/global default (${inheritedName}).`}
              selected={override === null}
              onPick={() => pick(null)}
            />
            {profiles.map((profile) => (
              <OptionRow
                key={profile.id}
                name={profile.name}
                description={profile.description}
                builtin={profile.builtin}
                selected={override === profile.id}
                onPick={() => pick(profile.id)}
              />
            ))}
            {/* A saved override that no longer resolves (deleted custom
                profile) stays selectable so the row isn't a dead end. */}
            {override !== null &&
              !profiles.some((p) => p.id === override) && (
                <OptionRow
                  name={override}
                  description="Unknown profile — the backend falls back to Manual."
                  selected
                  onPick={() => setOpen(false)}
                />
              )}
          </div>
        </Popover>
      )}
    </>
  )
}

function OptionRow({
  name,
  description,
  builtin = false,
  selected,
  onPick,
}: Readonly<{
  name: string
  description: string
  builtin?: boolean
  selected: boolean
  onPick: () => void
}>): React.JSX.Element {
  return (
    <button
      type="button"
      aria-current={selected}
      onClick={onPick}
      className="flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left hover-bg-raised focus-bg-raised focus:outline-none"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-xs text-default">
          {builtin && (
            <Lock
              className="h-3 w-3 shrink-0 text-faint"
              aria-label="Built-in profile"
            />
          )}
          <span className="truncate">{name}</span>
        </span>
        <span className="block text-[11px] text-faint">{description}</span>
      </span>
      {selected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
    </button>
  )
}
