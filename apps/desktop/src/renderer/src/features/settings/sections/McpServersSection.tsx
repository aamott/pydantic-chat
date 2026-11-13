/**
 * MCP Servers settings: the registry the agent's per-run toolsets come from.
 *
 * The list lives server-side in the settings table (`mcp_servers` key) and is
 * managed through `/api/mcp-servers` — writes take effect immediately (like
 * the API Keys section's secrets flow), not through the AppSettings draft.
 * Each enabled server becomes a pydantic-ai `MCPToolset` at run time:
 * `stdio` launches `command`/`args`/`env`, `http` connects to `url` with
 * `headers`. `env`/`headers` values may be secrets — they round-trip here
 * for editing but are never logged server-side.
 */
import { useCallback, useEffect, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { McpServer, McpServerPatch, McpTransport } from '@pydantic-chat/shared'
import { apiFetch, apiJson } from '../../../lib/api'
import {
  Field,
  SectionHeading,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '../components'

/** Error.message or a generic fallback for row-level failures. */
function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** `KEY=VALUE` lines <-> dict for the env/headers textareas. */
function kvToLines(kv: Record<string, string> | null | undefined): string {
  return Object.entries(kv ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

function kvFromLines(text: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return Object.keys(out).length ? out : null
}

/** Blank add-form state, or a copy of the server being edited. */
interface FormState {
  /** Name of the server being edited; `null` means this is an add. */
  originalName: string | null
  name: string
  transport: McpTransport
  command: string
  argsText: string
  envText: string
  url: string
  headersText: string
}

const EMPTY_FORM: FormState = {
  originalName: null,
  name: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  headersText: '',
}

function formFromServer(server: McpServer): FormState {
  return {
    originalName: server.name,
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    argsText: (server.args ?? []).join(' '),
    envText: kvToLines(server.env),
    url: server.url ?? '',
    headersText: kvToLines(server.headers),
  }
}

export function McpServersSection(): React.JSX.Element {
  const [servers, setServers] = useState<McpServer[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setServers(await apiJson<McpServer[]>('/api/mcp-servers'))
      setError(null)
    } catch (e) {
      setError(errorText(e, "Couldn't load MCP servers"))
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (server: McpServer): Promise<void> => {
    try {
      setServers(
        await apiJson<McpServer[]>(`/api/mcp-servers/${encodeURIComponent(server.name)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !server.enabled } satisfies McpServerPatch),
        }),
      )
      setError(null)
    } catch (e) {
      setError(errorText(e, `Couldn't update ${server.name}`))
    }
  }

  const remove = async (server: McpServer): Promise<void> => {
    try {
      const response = await apiFetch(
        `/api/mcp-servers/${encodeURIComponent(server.name)}`,
        { method: 'DELETE' },
      )
      if (!response.ok) throw new Error(`DELETE failed (${response.status})`)
      setServers((current) => current.filter((s) => s.name !== server.name))
      setError(null)
    } catch (e) {
      setError(errorText(e, `Couldn't remove ${server.name}`))
    }
  }

  /** POST (add) or PATCH (edit) the form's server, then close the form. */
  const submit = async (): Promise<void> => {
    if (!form || busy) return
    const args = form.argsText.trim().split(/\s+/).filter(Boolean)
    setBusy(true)
    try {
      if (form.originalName === null) {
        // Add: POST the full spec; irrelevant transport fields are omitted.
        const body: McpServer =
          form.transport === 'stdio'
            ? {
                name: form.name.trim(),
                transport: 'stdio',
                command: form.command.trim(),
                args,
                env: kvFromLines(form.envText),
                enabled: true,
              }
            : {
                name: form.name.trim(),
                transport: 'http',
                url: form.url.trim(),
                headers: kvFromLines(form.headersText),
                enabled: true,
              }
        setServers(
          await apiJson<McpServer[]>('/api/mcp-servers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
        )
      } else {
        // Edit: PATCH merge — send this transport's fields and explicitly
        // null the other transport's so no stale fields linger.
        const renamed = form.name.trim() !== form.originalName
        const body: McpServerPatch =
          form.transport === 'stdio'
            ? {
                command: form.command.trim(),
                args,
                env: kvFromLines(form.envText),
                url: null,
                headers: null,
                ...(renamed ? { name: form.name.trim() } : {}),
              }
            : {
                url: form.url.trim(),
                headers: kvFromLines(form.headersText),
                command: null,
                args: null,
                env: null,
                ...(renamed ? { name: form.name.trim() } : {}),
              }
        setServers(
          await apiJson<McpServer[]>(
            `/api/mcp-servers/${encodeURIComponent(form.originalName)}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            },
          ),
        )
      }
      setForm(null)
      setError(null)
    } catch (e) {
      setError(errorText(e, "Couldn't save the MCP server"))
    } finally {
      setBusy(false)
    }
  }

  const formValid =
    form !== null &&
    form.name.trim().length > 0 &&
    (form.transport === 'stdio'
      ? form.command.trim().length > 0
      : form.url.trim().length > 0)

  return (
    <div className="space-y-5">
      <SectionHeading
        title="MCP Servers"
        description="External tool servers the agent may call. Changes apply to the next run; every call still goes through your permission profile."
      />
      {error && (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
      <Field
        label="Registered servers"
        keywords="mcp server tools stdio http command url headers env enabled"
      >
        {!loaded ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading…</p>
        ) : servers.length === 0 && !form ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No MCP servers configured.
          </p>
        ) : (
          <ul className="space-y-2">
            {servers.map((server) => (
              <li
                key={server.name}
                className="flex items-center gap-3 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-700"
              >
                <input
                  type="checkbox"
                  checked={server.enabled}
                  onChange={() => void toggle(server)}
                  aria-label={`Enable ${server.name}`}
                  className="accent-blue-600"
                />
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                    {server.name}
                  </span>
                  <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                    {server.transport}
                  </span>
                  <span className="block truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">
                    {server.transport === 'stdio'
                      ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
                      : server.url}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setForm(formFromServer(server))}
                  aria-label={`Edit ${server.name}`}
                  className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void remove(server)}
                  aria-label={`Remove ${server.name}`}
                  className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {!form && (
          <button
            type="button"
            onClick={() => setForm(EMPTY_FORM)}
            className={`${secondaryButtonClass} mt-2 inline-flex items-center gap-1.5`}
          >
            <Plus className="h-4 w-4" />
            Add server
          </button>
        )}
      </Field>

      {form && (
        <div className="space-y-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-700">
          <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            {form.originalName === null ? 'Add MCP server' : `Edit ${form.originalName}`}
          </span>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">Name</span>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. fs-tools"
                className={inputClass}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                Transport
              </span>
              <select
                value={form.transport}
                onChange={(e) =>
                  setForm({ ...form, transport: e.target.value as McpTransport })
                }
                disabled={form.originalName !== null}
                className={inputClass}
              >
                <option value="stdio">stdio (local command)</option>
                <option value="http">http (remote URL)</option>
              </select>
            </label>
          </div>
          {form.transport === 'stdio' ? (
            <>
              <label className="block space-y-1">
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  Command
                </span>
                <input
                  type="text"
                  value={form.command}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                  placeholder="e.g. uvx or npx"
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  Arguments (space-separated)
                </span>
                <input
                  type="text"
                  value={form.argsText}
                  onChange={(e) => setForm({ ...form, argsText: e.target.value })}
                  placeholder="e.g. mcp-server-fs --root ."
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  Environment (KEY=VALUE per line)
                </span>
                <textarea
                  value={form.envText}
                  onChange={(e) => setForm({ ...form, envText: e.target.value })}
                  rows={2}
                  placeholder={'API_KEY=…'}
                  className={inputClass}
                />
              </label>
            </>
          ) : (
            <>
              <label className="block space-y-1">
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  URL
                </span>
                <input
                  type="text"
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="https://mcp.example.com/mcp"
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  Headers (KEY=VALUE per line)
                </span>
                <textarea
                  value={form.headersText}
                  onChange={(e) =>
                    setForm({ ...form, headersText: e.target.value })
                  }
                  rows={2}
                  placeholder={'Authorization=Bearer …'}
                  className={inputClass}
                />
              </label>
            </>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!formValid || busy}
              className={primaryButtonClass}
            >
              {form.originalName === null ? 'Add' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setForm(null)}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
