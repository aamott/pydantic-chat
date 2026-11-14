/**
 * Per-workspace MCP server mask: a plug icon in the workspace header's hover
 * actions that opens a popover listing the global `/api/mcp-servers` registry
 * with one checkbox per server.
 *
 * The override model is a *mask*, not a separate registry: `mcp_overrides`
 * maps server name -> enabled, and each entry replaces the spec's global
 * `enabled` flag for this workspace's runs (`true` may re-enable a server
 * disabled globally). `null` inherits the registry verbatim. Toggling a
 * server back to its global flag drops the mask entry so the workspace keeps
 * following future global toggles; an emptied mask is written as `null`.
 *
 * Entries naming deleted servers are stale — the backend ignores them at
 * resolution, and this list only renders servers that still exist.
 */
import { useEffect, useRef, useState } from 'react'
import { Plug } from 'lucide-react'
import type { McpServer, Workspace } from '@pydantic-chat/shared'
import { apiJson } from '../../lib/api'
import { iconButtonClass } from '../../lib/ui'
import { useChatsStore } from '../../stores/chats'
import {
  optionRowClass,
  PickerError,
  PickerNote,
  pickerStatusClass,
} from '../chat/partKit'
import { Popover } from '../chat/Popover'

interface WorkspaceMcpPickerProps {
  workspace: Workspace
}

/** A server's effective enabled flag in this workspace (mask -> global flag). */
function effectiveEnabled(server: McpServer, workspace: Workspace): boolean {
  return workspace.mcp_overrides?.[server.name] ?? server.enabled
}

export function WorkspaceMcpPicker({
  workspace,
}: Readonly<WorkspaceMcpPickerProps>): React.JSX.Element {
  const updateWorkspace = useChatsStore((s) => s.updateWorkspace)

  const [open, setOpen] = useState(false)
  const [servers, setServers] = useState<McpServer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  /* Fetch the global registry fresh each time the popover opens — a server
   * added/disabled in Settings should appear on the next click. */
  useEffect(() => {
    if (!open) return
    let cancelled = false
    apiJson<McpServer[]>('/api/mcp-servers')
      .then((list) => {
        if (cancelled) return
        setServers(list)
        setError(null)
      })
      .catch((fetchError: unknown) => {
        if (cancelled) return
        setError(
          fetchError instanceof Error
            ? fetchError.message
            : "Couldn't load MCP servers",
        )
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const overrides = workspace.mcp_overrides ?? {}
  const overrideCount = Object.keys(overrides).length

  const toggle = (server: McpServer): void => {
    const mask = { ...overrides }
    const next = !effectiveEnabled(server, workspace)
    // An entry equal to the global flag adds nothing — drop it so the mask
    // stays minimal and keeps inheriting future global toggles.
    if (next === server.enabled) delete mask[server.name]
    else mask[server.name] = next
    void updateWorkspace(workspace.id, {
      mcp_overrides: Object.keys(mask).length ? mask : null,
    })
  }

  const resetToGlobal = (): void => {
    void updateWorkspace(workspace.id, { mcp_overrides: null })
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`MCP servers for ${workspace.display_name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          overrideCount
            ? `MCP servers (${overrideCount} overridden in this workspace)`
            : 'MCP servers in this workspace'
        }
        className={iconButtonClass({ surface: 'subtle' })}
      >
        <Plug className="h-3.5 w-3.5" />
      </button>

      {open && (
        <Popover
          anchor={buttonRef.current}
          onClose={() => setOpen(false)}
          side="bottom"
          className="w-64"
        >
          <div className="p-1">
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
              MCP servers — this workspace
            </p>
            {error && <PickerError>{error}</PickerError>}
            {!error && servers === null && (
              <p className={`${pickerStatusClass} text-faint`}>Loading…</p>
            )}
            {!error && servers?.length === 0 && (
              <PickerNote>
                No MCP servers configured — add them under Settings.
              </PickerNote>
            )}
            {servers?.map((server) => (
              <label
                key={server.name}
                className={`${optionRowClass} cursor-pointer text-secondary`}
              >
                <input
                  type="checkbox"
                  checked={effectiveEnabled(server, workspace)}
                  onChange={() => toggle(server)}
                  aria-label={`Enable ${server.name} in this workspace`}
                  className="accent-blue-600"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-default">
                    {server.name}
                  </span>
                  <span className="block truncate text-[11px] text-faint">
                    {server.transport === 'stdio'
                      ? server.command
                      : server.url}
                  </span>
                </span>
                {/* Dot = this server has a workspace-level override. */}
                {server.name in overrides && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full border border-accent bg-accent-soft"
                    title="Overridden in this workspace"
                  />
                )}
              </label>
            ))}
            {overrideCount > 0 && (
              <button
                type="button"
                onClick={resetToGlobal}
                className={`${optionRowClass} text-accent`}
              >
                Reset to global defaults
              </button>
            )}
          </div>
        </Popover>
      )}
    </>
  )
}
