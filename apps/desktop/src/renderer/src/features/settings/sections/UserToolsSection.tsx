/**
 * User Tools settings: Python files whose public functions become
 * `user_<name>` agent tools.
 *
 * The listing is the backend's merged discovery+registry view
 * (`GET /api/user-tools`) — global files under the app data dir, plus the
 * resolved workspace's `.devin/tools` & co. when a workspace is known.
 * Enabled flags are immediate writes (`PATCH`), same pattern as MCP
 * servers — not the AppSettings draft. Every write refetches the listing
 * (see stores/userTools.ts).
 *
 * Editing: workspace tools open in the main window's FileViewer — the
 * settings window relays the request over `file:open-in-viewer` because
 * its own `useUiStore` is a different instance (the file tree hides
 * dotdirs, so this Edit affordance is the only navigation path).
 * Global tools edit inline in a plain textarea via
 * `/api/user-tools/source` — FileViewer's CodeMirror setup is
 * component-local and not trivially extractable (v1 trade-off).
 */
import { useEffect, useState } from 'react'
import { Check, Pencil, Trash2, X } from 'lucide-react'
import type { UserTool, UserToolCreate, UserToolOrigin } from '@pydantic-chat/shared'
import { iconButtonClass, confirmBannerClass } from '../../../lib/ui'
import { useUserToolsStore } from '../../../stores/userTools'
import { useSectionWorkspace } from '../useSectionWorkspace'
import {
  AddButton,
  Field,
  SectionHeading,
  chipClass,
  errorBannerClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '../components'

/** Stem half of the backend's `^[a-z0-9_][a-z0-9_-]*\.py$` filename rule. */
const STEM_RE = /^[a-z0-9_][a-z0-9_-]*$/

/** Canonical workspace tool dir — matches the backend's create target. */
const WORKSPACE_TOOL_DIR = '.devin/tools'

/** Blank add-form state; origin defaults to the current workspace. */
interface AddForm {
  filename: string
  origin: UserToolOrigin
}

/** Inline source-editor state (global tools only — the editing surface). */
interface SourceDraft {
  /** `UserTool.key` the buffer belongs to. */
  key: string
  source: string
}

export function UserToolsSection(): React.JSX.Element {
  const tools = useUserToolsStore((s) => s.tools)
  const loaded = useUserToolsStore((s) => s.loaded)
  const storeError = useUserToolsStore((s) => s.error)
  const ensureLoaded = useUserToolsStore((s) => s.ensureLoaded)
  const setEnabled = useUserToolsStore((s) => s.setEnabled)
  const create = useUserToolsStore((s) => s.create)
  const remove = useUserToolsStore((s) => s.remove)
  const readSource = useUserToolsStore((s) => s.readSource)
  const writeSource = useUserToolsStore((s) => s.writeSource)

  const { id: workspaceId, name: workspaceName } = useSectionWorkspace()
  const [form, setForm] = useState<AddForm | null>(null)
  /** Key of the row pending its delete confirmation, if any. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [draft, setDraft] = useState<SourceDraft | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void ensureLoaded(workspaceId)
  }, [ensureLoaded, workspaceId])

  /** Open the tool for editing — FileViewer for workspace, inline for global. */
  const openEditor = (tool: UserTool): void => {
    if (tool.origin === 'workspace' && workspaceId) {
      window.api.openFileInViewer(workspaceId, tool.rel_path)
      return
    }
    void readSource(tool.key).then((source) => {
      if (source !== null) setDraft({ key: tool.key, source })
    })
  }

  /** POST the new file, then open it (same routing as openEditor). */
  const submit = async (): Promise<void> => {
    if (!form || busy) return
    const stem = form.filename.trim()
    if (!STEM_RE.test(stem)) return
    const filename = `${stem}.py`
    const workspaceTool = form.origin === 'workspace' && workspaceId !== null
    setBusy(true)
    const ok = await create({
      origin: workspaceTool ? 'workspace' : 'global',
      workspace_id: workspaceTool ? workspaceId : null,
      filename,
    } satisfies UserToolCreate)
    setBusy(false)
    if (!ok) return
    setForm(null)
    if (workspaceTool && workspaceId) {
      window.api.openFileInViewer(workspaceId, `${WORKSPACE_TOOL_DIR}/${filename}`)
    } else {
      const key = `global:${filename}`
      const source = await readSource(key)
      if (source !== null) setDraft({ key, source })
    }
  }

  const banner = storeError
  const formValid = form !== null && STEM_RE.test(form.filename.trim())

  return (
    <div className="space-y-5">
      <SectionHeading
        title="User Tools"
        description="Python files whose public functions become user_<name> agent tools. Global tools apply to every workspace; workspace tools live in .devin/tools inside that workspace. Changes apply to the next run."
      />
      {banner && <p className={errorBannerClass}>{banner}</p>}
      <Field
        label="Tool files"
        hint="Each file lists its discovered functions; a file with a parse error or no public functions contributes no tools."
        keywords="user tools custom python functions workspace global devin user_"
      >
        {!loaded ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : tools.length === 0 && !form ? (
          <p className="text-sm text-muted">No tool files found.</p>
        ) : (
          <ul className="space-y-2">
            {tools.map((tool) => (
              <ToolRow
                key={tool.key}
                tool={tool}
                workspaceName={workspaceName}
                confirming={confirmDelete === tool.key}
                editing={draft?.key === tool.key ? draft : null}
                onToggle={() => void setEnabled(tool.key, !tool.enabled)}
                onEdit={() => openEditor(tool)}
                onDelete={() => setConfirmDelete(tool.key)}
                onConfirmDelete={() => {
                  void remove(tool.key).then((ok) => {
                    if (ok) setConfirmDelete(null)
                  })
                }}
                onCancelDelete={() => setConfirmDelete(null)}
                onDraftChange={(source) =>
                  setDraft((d) => (d ? { ...d, source } : d))
                }
                onDraftSave={async () => {
                  if (!draft) return
                  if (await writeSource(draft.key, draft.source)) {
                    setDraft(null)
                  }
                }}
                onDraftClose={() => setDraft(null)}
              />
            ))}
          </ul>
        )}
        {!form && (
          <AddButton
            label="Add tool"
            onClick={() =>
              /* Workspace is the common case (project helpers get the
               * FileViewer edit path); global only when none is open. */
              setForm({
                filename: '',
                origin: workspaceId ? 'workspace' : 'global',
              })
            }
          />
        )}
      </Field>

      {form && (
        <div className="space-y-3 rounded-md border border-subtle p-3">
          <span className="text-sm font-medium text-default">
            New tool file
          </span>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted">File name</span>
              <span className="flex items-center gap-1">
                <input
                  type="text"
                  value={form.filename}
                  onChange={(e) => setForm({ ...form, filename: e.target.value })}
                  placeholder="e.g. my_tools"
                  className={inputClass}
                />
                <span className="shrink-0 font-mono text-xs text-muted">
                  .py
                </span>
              </span>
              <span className="block text-xs text-faint">
                Lowercase letters, digits, _ and -; must start with a letter,
                digit or underscore.
              </span>
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted">Location</span>
              <select
                value={form.origin}
                onChange={(e) =>
                  setForm({ ...form, origin: e.target.value as UserToolOrigin })
                }
                className={inputClass}
              >
                <option value="global">Global (all workspaces)</option>
                {workspaceId && (
                  <option value="workspace">
                    Workspace ({workspaceName ?? workspaceId})
                  </option>
                )}
              </select>
              <span className="block text-xs text-faint">
                {form.origin === 'workspace'
                  ? `${WORKSPACE_TOOL_DIR}/ — opens in the File panel for editing.`
                  : 'The app data dir — edited inline below.'}
              </span>
            </label>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!formValid || busy}
              className={primaryButtonClass}
            >
              Create
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

/* ------------------------------------------------------------------ */
/* One discovered tool file                                            */
/* ------------------------------------------------------------------ */

function ToolRow({
  tool,
  workspaceName,
  confirming,
  editing,
  onToggle,
  onEdit,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
  onDraftChange,
  onDraftSave,
  onDraftClose,
}: Readonly<{
  tool: UserTool
  /** Display name of the resolved workspace (workspace badge). */
  workspaceName: string | null
  confirming: boolean
  /** Source draft when this row's inline editor is open. */
  editing: SourceDraft | null
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
  onDraftChange: (source: string) => void
  onDraftSave: () => Promise<void>
  onDraftClose: () => void
}>): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const originLabel =
    tool.origin === 'global' ? 'Global' : (workspaceName ?? 'Workspace')

  return (
    <li className="rounded-md border border-subtle px-3 py-2">
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={tool.enabled}
          onChange={onToggle}
          aria-label={`Enable ${tool.name}`}
          className="accent-blue-600"
        />
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium text-default">{tool.name}</span>
          <span
            className={`ml-2 ${chipClass(tool.origin === 'global' ? 'neutral' : 'accent')}`}
          >
            {originLabel}
          </span>
          <span className="block truncate font-mono text-xs text-muted">
            {tool.rel_path}
          </span>
        </div>
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${tool.name}`}
          title={
            tool.origin === 'workspace'
              ? 'Open in the File panel'
              : 'Edit source'
          }
          className={iconButtonClass()}
        >
          <Pencil className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${tool.name}`}
          className={iconButtonClass({ tone: 'danger' })}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {confirming ? (
        <div className={`mt-2 ${confirmBannerClass('px-2')}`}>
          <span className="min-w-0 flex-1 truncate">
            Delete “{tool.name}.py”? The file is removed from disk.
          </span>
          <button
            type="button"
            aria-label={`Confirm delete ${tool.name}`}
            title="Confirm delete"
            onClick={onConfirmDelete}
            className="rounded p-1 text-danger hover-bg-danger-soft-hover"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Cancel"
            title="Cancel"
            onClick={onCancelDelete}
            className="rounded p-1 text-muted hover-bg-overlay"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <>
          {/* Discovered functions → user_<name> tools. */}
          {tool.functions.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 pl-7">
              {tool.functions.map((fn) => (
                <li key={fn.name}>
                  <span className="font-mono text-xs text-secondary">
                    user_{fn.name}
                  </span>
                  {fn.docstring && (
                    <span className="block truncate text-xs text-faint">
                      {fn.docstring.split('\n')[0]}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* Diagnostics: parse failure, whole-file skip, illegal names. */}
          {tool.error && (
            <p className="mt-1.5 pl-7 text-xs text-danger">
              Parse error: {tool.error}
            </p>
          )}
          {tool.skipped_reason && (
            <p className="mt-1.5 pl-7 text-xs text-warning">
              Not active: {tool.skipped_reason}
            </p>
          )}
          {tool.skipped_functions.map((sf) => (
            <p key={sf.name} className="mt-1 pl-7 text-xs text-warning">
              {sf.name}: {sf.reason}
            </p>
          ))}

          {/* Inline source editor (global tools). */}
          {editing && (
            <div className="mt-2 space-y-2 pl-7">
              <textarea
                value={editing.source}
                onChange={(e) => onDraftChange(e.target.value)}
                rows={12}
                spellCheck={false}
                aria-label={`Source for ${tool.name}`}
                className={`${inputClass} font-mono text-xs`}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSaving(true)
                    /* The store refetches the listing on success; local
                     * `saving` only guards double-clicks. */
                    void onDraftSave().finally(() => setSaving(false))
                  }}
                  disabled={saving}
                  className={primaryButtonClass}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={onDraftClose}
                  className={secondaryButtonClass}
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </li>
  )
}
