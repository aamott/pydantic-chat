/**
 * CodeMirror 6 viewer/editor for workspace files, fetched and saved through
 * the backend (`GET`/`PUT /api/files?workspace_id&path`, image bytes via
 * `GET /api/files/raw`). Thin useRef/useEffect wrapper — no React editor
 * binding library. Language modes are lazy-loaded via
 * `@codemirror/language-data`; freshness is a re-fetch on window focus.
 *
 * Viewer modes (`viewerModeFor`, driven by `WorkspaceFile.kind`): text
 * files get the CodeMirror editor; `.md`/`.markdown` add a rendered-preview
 * toggle (Streamdown, same component+plugins as the chat transcript);
 * images render inline from a `?raw` blob fetch (the backend serves no
 * decoded body for non-text kinds); binaries get a "can't display" panel
 * with an **Open with default app** button routed through the confined
 * `shell:open-path` IPC.
 *
 * Editing: files open writable by default whenever the effective profile
 * isn't `workspace_read_only` (same fail-open lookup the pencil gating
 * uses); the pencil remains as a manual lock/unlock. Unsaved edits mark
 * the buffer dirty (header dot + `ui.fileDirty` so file-switch/tab/
 * panel-close can guard). Save is Ctrl/Cmd-S or the Save button → `PUT`
 * with the read-time `version` echoed as `if_match` — a 409 means the
 * file drifted (agent write, external edit) and the conflict banner
 * offers reload / overwrite plus a disk→buffer diff. This save-time
 * check is the story's chosen stand-in for fs watching: the tree and
 * buffers never learn about agent writes in real time.
 */
import { useEffect, useRef, useState } from 'react'
import { minimalSetup } from 'codemirror'
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view'
import {
  bracketMatching,
  foldGutter,
  LanguageDescription,
  syntaxHighlighting,
} from '@codemirror/language'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { languages } from '@codemirror/language-data'
import { Streamdown } from 'streamdown'
import {
  Code,
  Eye,
  FileWarning,
  Pencil,
  Save,
  TriangleAlert,
  X,
} from 'lucide-react'
import type {
  FileKind,
  WorkspaceFile,
  WorkspaceFileWrite,
} from '@pydantic-chat/shared'
import { apiFetch } from '../../lib/api'
import { iconButtonClass } from '../../lib/ui'
import { effectiveProfileId, useChatsStore } from '../../stores/chats'
import { useModelsStore } from '../../stores/models'
import { useProfilesStore } from '../../stores/profiles'
import { useUiStore } from '../../stores/ui'
import { markdownComponents, rehypePlugins } from '../chat/MessagePart'
import { unifiedLines, type DiffRow, type DiffRowKind } from './diff'

/* ------------------------------------------------------------------ */
/* Anchor-line highlight (the `#L<n>` target)                          */
/* ------------------------------------------------------------------ */

/** Sets the 1-based "anchor" line to highlight (null clears). */
const setAnchorLine = StateEffect.define<number | null>()

const anchorLineMark = Decoration.line({ class: 'cm-anchor-line' })

/** Holds the anchor line decoration so it survives doc changes. */
const anchorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setAnchorLine)) {
        deco =
          e.value === null || e.value < 1 || e.value > tr.state.doc.lines
            ? Decoration.none
            : Decoration.set([
                anchorLineMark.range(tr.state.doc.line(e.value).from),
              ])
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

/**
 * Viewer chrome: fill parent, monospace scroller, no focus ring, anchor tint.
 * Colors reference the `--c-*` theme vars from styles/index.css so the editor
 * follows `data-theme` — only the syntax-highlight style needs swapping (it
 * can't be expressed as a var), which `highlightCompartment` handles below.
 */
const viewerTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--c-surface)',
    color: 'var(--c-ink)',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--c-subtle)',
    color: 'var(--c-ink-faint)',
    borderRight: '1px solid var(--c-line)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'var(--c-raised)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--c-overlay)',
  },
  /* foldGutter's collapsed-region chip — CM's base theme ships a light
   * `#eee` block that clashes in dark mode, so restyle it on the vars. */
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--c-raised)',
    border: '1px solid var(--c-line)',
    color: 'var(--c-ink-faint)',
  },
  /* bracketMatching() + highlightSelectionMatches() marks: the defaults are
   * tuned for a white page, so tint them on vars that flip per theme. */
  '.cm-matchingBracket': {
    backgroundColor: 'var(--c-accent-soft)',
    outline: '1px solid var(--c-accent-line-soft)',
  },
  '.cm-nonmatchingBracket': {
    backgroundColor: 'var(--c-danger-soft)',
    outline: '1px solid var(--c-danger-line)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'var(--c-accent-soft)',
  },
  '.cm-anchor-line': { backgroundColor: 'var(--c-anchor)' },
  '&.cm-focused': { outline: 'none' },
})

/*
 * minimalSetup ships the light `defaultHighlightStyle` (fallback precedence);
 * in dark mode the compartment overrides it with oneDarkHighlightStyle.
 * `data-theme` is set by lib/theme.ts — a MutationObserver reconfigures the
 * compartment live so an in-session theme switch doesn't need a remount.
 */
const highlightCompartment = new Compartment()

const darkHighlight = (): Extension =>
  document.documentElement.dataset.theme === 'dark'
    ? syntaxHighlighting(oneDarkHighlightStyle)
    : []

/* Read-only vs writable — the two states `editCompartment` flips between. */
const READ_ONLY_EXT: Extension = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
]
const WRITABLE_EXT: Extension = [
  EditorState.readOnly.of(false),
  EditorView.editable.of(true),
]

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Identity of the file currently rendered in the editor (`loadedRef`). */
export interface LoadedFile {
  workspaceId: string
  path: string
  content: string
  /** `WorkspaceFile.version` — echoed as `if_match` on save (409 guard). */
  version: string
}

/**
 * Whether `loaded` is the exact file a fetch targets. Drives both decisions
 * in the load effect: a match means the fetch is a "silent" refresh of the
 * file on screen (failures keep the stale view; identical content skips the
 * rebuild), while a mismatch is a fresh load that must surface errors and
 * rebuild. The `workspaceId` check matters because two workspaces can hold
 * the same relative path — a workspace switch must not look like a refresh.
 */
export function isDisplayedFile(
  loaded: LoadedFile | null,
  workspaceId: string,
  path: string,
): boolean {
  return (
    loaded !== null &&
    loaded.workspaceId === workspaceId &&
    loaded.path === path
  )
}

export type RefetchOutcome = 'rebuild' | 'keep' | 'drift'

/**
 * What a completed fetch should do to the on-screen buffer.
 *
 * - `rebuild` — a different file, or the disk copy moved under a clean one.
 * - `keep` — identical content: skip the rebuild, preserve scroll.
 * - `drift` — the file changed on disk while the buffer has unsaved edits:
 *   the edits win (rebuilding would drop them) and the header flags it.
 *   The read-time `version` is deliberately NOT updated, so the next save
 *   still 409s and the conflict UI takes over.
 */
export function refetchOutcome(
  loaded: LoadedFile | null,
  workspaceId: string,
  path: string,
  newContent: string,
  dirty: boolean,
): RefetchOutcome {
  if (loaded === null || !isDisplayedFile(loaded, workspaceId, path)) {
    return 'rebuild'
  }
  if (loaded.content === newContent) return 'keep'
  return dirty ? 'drift' : 'rebuild'
}

/**
 * The render branch for one fetched file. `editor` and `markdown` are both
 * CodeMirror text modes (markdown adds the Streamdown preview toggle);
 * `image` renders the raw-bytes blob inline; `binary` is the
 * open-externally panel.
 */
export type FileViewerMode = 'editor' | 'markdown' | 'image' | 'binary'

const MARKDOWN_SUFFIX = /\.(?:md|markdown)$/i

/**
 * kind → viewer-mode mapping. The backend's `kind` decides first; markdown
 * is the only text sub-mode, picked by the language hint or the extension
 * (`.md`/`.markdown`) as a fallback for older backends.
 */
export function viewerModeFor(
  kind: FileKind,
  language: string | null,
  path: string,
): FileViewerMode {
  if (kind === 'image') return 'image'
  if (kind === 'binary') return 'binary'
  return language === 'markdown' || MARKDOWN_SUFFIX.test(path)
    ? 'markdown'
    : 'editor'
}

type ViewerState =
  | { status: 'no-workspace' }
  | { status: 'loading' }
  | {
      status: 'ready'
      size: number
      languageName: string | null
      mode: FileViewerMode
    }
  | { status: 'error'; message: string }

/** A save-time 409 plus the fresh disk copy fetched to explain it. */
interface SaveConflict {
  /** Current on-disk copy; null when the refetch itself failed. */
  disk: WorkspaceFile | null
  /** disk → unsaved-buffer rows, snapshotted when the 409 arrived. */
  rows: DiffRow[]
}

/** Map HTTP errors (403 outside-root / 404 / 413 too-big) to readable text. */
async function describeError(res: Response): Promise<string> {
  let detail: string | null = null
  try {
    const body: unknown = await res.json()
    if (
      body !== null &&
      typeof body === 'object' &&
      'detail' in body &&
      typeof (body as { detail: unknown }).detail === 'string'
    ) {
      detail = (body as { detail: string }).detail
    }
  } catch {
    /* non-JSON error body — fall through to the status default */
  }
  switch (res.status) {
    case 403:
      return detail ?? 'This file is outside the workspace root.'
    case 404:
      return detail ?? 'File not found in this workspace.'
    case 409:
      return detail ?? 'File changed on disk since it was read.'
    case 413:
      return detail ?? 'File is too large to preview.'
    default:
      return detail ?? `Request failed (HTTP ${res.status}).`
  }
}

/**
 * Resolve a lazy CM language: backend `language` hint by name/alias first,
 * then fall back to filename matching.
 */
async function loadLanguage(
  hint: string | null,
  path: string,
): Promise<{ support: Extension; name: string } | null> {
  const desc =
    (hint
      ? LanguageDescription.matchLanguageName(languages, hint)
      : null) ?? LanguageDescription.matchFilename(languages, path)
  if (!desc) return null
  try {
    return { support: await desc.load(), name: desc.name }
  } catch {
    return null // dynamic import failed — render as plain text
  }
}

/** Scroll `line` (1-based, clamped) into view centered + mark it as anchor. */
function scrollToLine(view: EditorView, line: number): void {
  const target = Math.min(Math.max(1, line), view.state.doc.lines)
  const pos = view.state.doc.line(target).from
  view.dispatch({
    selection: { anchor: pos },
    effects: [
      EditorView.scrollIntoView(pos, { y: 'center' }),
      setAnchorLine.of(target),
    ],
  })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface FileViewerProps {
  /** Active workspace id; null renders an empty state (no fetch). */
  readonly workspaceId: string | null
  /** Workspace-relative (or absolute) file path to preview. */
  readonly path: string
  /** Optional 1-based line anchor to scroll to / highlight. */
  readonly line?: number | null
}

export function FileViewer({
  workspaceId,
  path,
  line = null,
}: Readonly<FileViewerProps>): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  /** Doc currently in the editor — skips rebuilds on identical refetches. */
  const loadedRef = useRef<LoadedFile | null>(null)
  /** Read-only ↔ writable switch, reconfigured instead of rebuilding. */
  const editCompartmentRef = useRef<Compartment | null>(null)
  /** Latest save closure for the Mod-S keymap (extensions are built once). */
  const saveRef = useRef<() => void>(() => {})
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const [state, setState] = useState<ViewerState>({ status: 'loading' })
  /** Bumped on window focus → re-fetch. */
  const [refreshKey, setRefreshKey] = useState(0)
  /** Bumped after each editor rebuild → retriggers the line-scroll effect. */
  const [docVersion, setDocVersion] = useState(0)
  const [editing, setEditing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** A 409's fresh disk copy; non-null shows the conflict banner. */
  const [conflict, setConflict] = useState<SaveConflict | null>(null)
  /** A silent refetch saw the disk move while the buffer was dirty. */
  const [drift, setDrift] = useState(false)
  /** Markdown mode: rendered preview covering the editor. */
  const [previewOn, setPreviewOn] = useState(false)
  /** Buffer snapshot the preview renders (taken when preview opens). */
  const [previewText, setPreviewText] = useState('')
  /** Object URL for the image branch's raw-bytes blob. */
  const [imageSrc, setImageSrc] = useState<string | null>(null)
  /** shell:open-path failure text for the binary branch's button. */
  const [openError, setOpenError] = useState<string | null>(null)

  /* Read-only gating: the active chat's effective profile (chat → workspace
   * → global) is resolved like ProfilePicker's, then looked up in the
   * profile catalog. While the catalog is unloaded the lookup misses and
   * editing stays enabled — the flag only hides a UX affordance; the agent's
   * own writes remain governed server-side per the story. */
  const workspaces = useChatsStore((s) => s.workspaces)
  const activeChatId = useChatsStore((s) => s.activeChatId)
  const globalProfile = useModelsStore((s) => s.globalProfile)
  const ensureModelsLoaded = useModelsStore((s) => s.ensureLoaded)
  const profiles = useProfilesStore((s) => s.profiles)
  const ensureProfilesLoaded = useProfilesStore((s) => s.ensureLoaded)

  useEffect(() => {
    void ensureModelsLoaded()
    void ensureProfilesLoaded()
  }, [ensureModelsLoaded, ensureProfilesLoaded])

  const profileId = effectiveProfileId(
    workspaces,
    activeChatId,
    workspaceId,
    globalProfile,
  )
  const canEdit =
    !(profiles.find((p) => p.id === profileId)?.workspace_read_only ?? false)
  /* Mirror canEdit into a ref: the load effect auto-enters edit mode with
   * the *current* gating (fail-open while the profile catalog is still
   * loading, same as the pencil affordance). */
  const canEditRef = useRef(canEdit)
  useEffect(() => {
    canEditRef.current = canEdit
  }, [canEdit])

  /** Sync the dirty flag into local state, the ref, and the ui store. */
  const markDirty = (value: boolean): void => {
    dirtyRef.current = value
    setDirty(value)
    useUiStore.getState().setFileDirty(value)
  }

  /* The image branch's object URL — a ref mirror so unmount can revoke the
   * current one without re-subscribing to state. */
  const imageSrcRef = useRef<string | null>(null)
  const setImageUrl = (src: string | null): void => {
    if (imageSrcRef.current) URL.revokeObjectURL(imageSrcRef.current)
    imageSrcRef.current = src
    setImageSrc(src)
  }

  /** (Re)create the EditorView inside `containerRef` for `content`. */
  const buildEditor = (
    content: string,
    lang: { support: Extension; name: string } | null,
  ): void => {
    const parent = containerRef.current
    if (!parent) return
    const compartment = (editCompartmentRef.current ??= new Compartment())
    viewRef.current?.destroy()
    viewRef.current = new EditorView({
      parent,
      state: EditorState.create({
        doc: content,
        extensions: [
          minimalSetup,
          lineNumbers(),
          foldGutter(),
          bracketMatching(),
          compartment.of(READ_ONLY_EXT),
          /* Dirty = buffer differs from the read-time base content. */
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const base = loadedRef.current?.content ?? ''
              markDirty(update.state.doc.toString() !== base)
            }
          }),
          /* Mod-S inside the editor; the window-level handler below covers
           * a blurred editor (savingRef dedupes the double-fire). */
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                saveRef.current()
                return true
              },
            },
          ]),
          anchorLineField,
          viewerTheme,
          highlightCompartment.of(darkHighlight()),
          ...(lang ? [lang.support] : []),
        ],
      }),
    })
  }

  /** Flip the editable compartment (and focus when entering edit mode). */
  const setEditingMode = (on: boolean): void => {
    setEditing(on)
    const view = viewRef.current
    const compartment = editCompartmentRef.current
    if (view && compartment) {
      view.dispatch({
        effects: compartment.reconfigure(on ? WRITABLE_EXT : READ_ONLY_EXT),
      })
      if (on) view.focus()
    }
  }

  /**
   * PUT the buffer through the backend. `force` drops the `if_match` token
   * (the conflict banner's "save anyway" — an unconditional overwrite).
   */
  const save = async (force: boolean): Promise<void> => {
    const view = viewRef.current
    const loaded = loadedRef.current
    if (!view || !loaded || !workspaceId || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    const params = new URLSearchParams({ workspace_id: workspaceId, path })
    try {
      const body: WorkspaceFileWrite = {
        content: view.state.doc.toString(),
        if_match: force ? null : loaded.version,
      }
      const res = await apiFetch(`/api/files?${params}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 409 && !force) {
        /* Pull the drifted disk copy so the banner can diff it against the
         * buffer the user was trying to save. */
        const fresh = await apiFetch(`/api/files?${params}`)
        const disk = fresh.ok ? ((await fresh.json()) as WorkspaceFile) : null
        setConflict({
          disk,
          rows: disk ? unifiedLines(disk.content, body.content) : [],
        })
        return
      }
      if (!res.ok) throw new Error(await describeError(res))
      const file = (await res.json()) as WorkspaceFile
      loadedRef.current = {
        workspaceId,
        path,
        content: file.content,
        version: file.version,
      }
      markDirty(false)
      setConflict(null)
      setDrift(false)
      setState((s) =>
        s.status === 'ready' ? { ...s, size: file.size } : s,
      )
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  useEffect(() => {
    saveRef.current = () => {
      void save(false)
    }
  })

  /* Mod-S also reaches a blurred editor; savingRef dedupes the CM keymap's
   * earlier handling of the same keystroke. */
  useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing])

  /* Fetch + (re)build the editor. `refetchOutcome` decides: identical
   * content keeps the view (scroll preserved), drift under a dirty buffer
   * keeps the edits and flags the header, anything else rebuilds. */
  useEffect(() => {
    if (!workspaceId) {
      setState({ status: 'no-workspace' })
      return
    }
    let cancelled = false
    // "Silent" = re-fetching the file already displayed (focus refresh).
    // An identical path in a different workspace is a fresh load, so its
    // failures must surface instead of keeping the other workspace's file.
    const silent = isDisplayedFile(loadedRef.current, workspaceId, path)
    if (!silent) setState({ status: 'loading' })

    const load = async (): Promise<void> => {
      const params = new URLSearchParams({ workspace_id: workspaceId, path })
      const res = await apiFetch(`/api/files?${params}`)
      if (!res.ok) throw new Error(await describeError(res))
      const file = (await res.json()) as WorkspaceFile
      const mode = viewerModeFor(file.kind, file.language, path)

      /* Non-text kinds carry no decoded body — the text-buffer flow below
       * doesn't apply. `version` equality stands in for refetchOutcome's
       * content comparison: identical bytes keep the current view, anything
       * else rebuilds (images additionally re-fetch their raw blob). */
      if (mode === 'image' || mode === 'binary') {
        const stale =
          !isDisplayedFile(loadedRef.current, workspaceId, path) ||
          loadedRef.current?.version !== file.version
        if (stale) {
          let src: string | null = null
          if (mode === 'image') {
            const raw = await apiFetch(`/api/files/raw?${params}`)
            if (!raw.ok) throw new Error(await describeError(raw))
            src = URL.createObjectURL(await raw.blob())
          }
          if (cancelled) {
            if (src) URL.revokeObjectURL(src)
            return
          }
          setImageUrl(src)
          loadedRef.current = {
            workspaceId,
            path,
            content: '',
            version: file.version,
          }
          /* Fresh view: clear every flag a previous file may have set. */
          setEditing(false)
          markDirty(false)
          setConflict(null)
          setDrift(false)
          setSaveError(null)
          setOpenError(null)
          setPreviewOn(false)
        }
        if (!cancelled) {
          setState({
            status: 'ready',
            size: file.size,
            languageName: null,
            mode,
          })
        }
        return
      }

      const outcome = refetchOutcome(
        loadedRef.current,
        workspaceId,
        path,
        file.content,
        dirtyRef.current,
      )
      const lang = await loadLanguage(file.language, path)
      if (cancelled) return

      if (outcome === 'keep') {
        setState({
          status: 'ready',
          size: file.size,
          languageName: lang?.name ?? null,
          mode,
        })
        return
      }
      if (outcome === 'drift') {
        /* Disk moved under a dirty buffer — keep the edits and flag it.
         * loadedRef (base content + version) stays stale on purpose. */
        setDrift(true)
        return
      }

      buildEditor(file.content, lang)
      loadedRef.current = {
        workspaceId,
        path,
        content: file.content,
        version: file.version,
      }
      /* Fresh buffer: clear every flag the previous file set, then open
       * writable — auto-edit unless the effective profile is read-only
       * (the pencil remains as the manual lock/unlock). */
      setImageUrl(null)
      setPreviewOn(mode === 'markdown')
      markDirty(false)
      setConflict(null)
      setDrift(false)
      setSaveError(null)
      setOpenError(null)
      setEditingMode(canEditRef.current)
      setState({
        status: 'ready',
        size: file.size,
        languageName: lang?.name ?? null,
        mode,
      })
      setDocVersion((v) => v + 1) // retrigger the line-scroll effect
    }

    load().catch((err: unknown) => {
      // Silent refetch failures keep the stale view on screen.
      if (!cancelled && !silent) {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })

    return () => {
      cancelled = true
    }
    /* Deps deliberately exclude the helper closures: markDirty/buildEditor/
     * saveRef touch refs and setState only, so re-running on their identity
     * would just churn. */
  }, [workspaceId, path, refreshKey])

  /* Re-fetch when the window regains focus (v1 freshness). */
  useEffect(() => {
    const onFocus = (): void => setRefreshKey((k) => k + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  /* Scroll to the `#L` anchor — on `line` changes and after each rebuild. */
  useEffect(() => {
    const view = viewRef.current
    if (view && line) scrollToLine(view, line)
  }, [line, docVersion])

  /* Swap the syntax-highlight style when `data-theme` flips (theme setting). */
  useEffect(() => {
    const observer = new MutationObserver(() => {
      viewRef.current?.dispatch({
        effects: highlightCompartment.reconfigure(darkHighlight()),
      })
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [])

  /* Destroy the editor + revoke the image blob URL on unmount (rebuilds
   * destroy the previous instance inside buildEditor/setImageUrl instead,
   * so identical-content refetches keep it). */
  useEffect(
    () => () => {
      viewRef.current?.destroy()
      viewRef.current = null
      loadedRef.current = null
      if (imageSrcRef.current) URL.revokeObjectURL(imageSrcRef.current)
      useUiStore.getState().setFileDirty(false)
    },
    [],
  )

  /** Conflict banner's "Reload": drop the buffer, refetch into a fresh view. */
  const reloadFromDisk = (): void => {
    loadedRef.current = null // forces 'rebuild' in the load effect
    markDirty(false)
    setConflict(null)
    setDrift(false)
    setRefreshKey((k) => k + 1)
  }

  /** "Stop editing": discard the buffer back to the read-time base. */
  const discardEdits = (): void => {
    if (
      dirtyRef.current &&
      !window.confirm(`Discard unsaved changes to ${path}?`)
    ) {
      return
    }
    const view = viewRef.current
    const loaded = loadedRef.current
    if (view && loaded) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: loaded.content },
      })
    }
    markDirty(false)
    setConflict(null)
    setEditingMode(false)
  }

  /**
   * Markdown preview toggle: opening snapshots the live buffer so rendered
   * output tracks unsaved edits; the snapshot is static while the preview
   * covers the editor (nothing can change the doc underneath it).
   */
  const togglePreview = (): void => {
    setPreviewOn((on) => {
      if (!on) {
        setPreviewText(viewRef.current?.state.doc.toString() ?? '')
      }
      return !on
    })
  }

  /** Binary branch's button → confined `shell:open-path` in main. */
  const openExternally = async (): Promise<void> => {
    if (!workspaceId) return
    setOpenError(null)
    try {
      const error = await window.api.openPath(workspaceId, path)
      // shell.openPath resolves '' on success or a system error string.
      if (error) setOpenError(error)
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: path + file meta + edit affordances */}
      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-b border-subtle px-3">
        <span className="truncate font-mono text-xs text-secondary" title={path}>
          {path}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {state.status === 'ready' && (
            <span className="text-xs text-faint">
              {state.mode === 'image' || state.mode === 'binary'
                ? `${state.mode === 'image' ? 'Image' : 'Binary file'} · ${formatSize(state.size)}`
                : `${state.languageName ?? 'Plain text'} · ${formatSize(state.size)}`}
              {(state.mode === 'editor' || state.mode === 'markdown') && (
                <>
                  {' · '}
                  {editing ? (
                    dirty ? (
                      /* The unsaved-changes dot — the header half of the
                       * dirty indicator (the File tab carries the other). */
                      <span className="inline-flex items-center gap-1 text-warning">
                        <span
                          className="h-1.5 w-1.5 rounded-full bg-warning"
                          aria-label="Unsaved changes"
                        />
                        modified
                      </span>
                    ) : (
                      'editing'
                    )
                  ) : (
                    'read-only'
                  )}
                </>
              )}
            </span>
          )}
          {state.status === 'ready' && state.mode === 'markdown' && (
            <button
              type="button"
              onClick={togglePreview}
              aria-label={previewOn ? 'Show source' : 'Show preview'}
              title={previewOn ? 'Show source' : 'Show rendered preview'}
              className={iconButtonClass()}
            >
              {previewOn ? (
                <Code className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {state.status === 'ready' &&
            (state.mode === 'editor' || state.mode === 'markdown') &&
            canEdit &&
            !editing && (
              <button
                type="button"
                onClick={() => setEditingMode(true)}
                aria-label="Edit file"
                title="Edit file"
                className={iconButtonClass()}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
          {state.status === 'ready' &&
            (state.mode === 'editor' || state.mode === 'markdown') &&
            editing && (
            <>
              <button
                type="button"
                onClick={() => void save(false)}
                disabled={!dirty || saving}
                aria-label="Save file"
                title="Save (Ctrl/Cmd+S)"
                className={iconButtonClass()}
              >
                <Save className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={discardEdits}
                aria-label="Stop editing"
                title="Stop editing (discards unsaved changes)"
                className={iconButtonClass()}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </span>
      </div>

      {/* Save-time conflict: file drifted since the buffer's read. */}
      {conflict && (
        <div className="shrink-0 border-b border-subtle bg-danger-soft px-3 py-1.5 text-xs">
          <div className="flex items-center gap-1.5 text-danger">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">
              Changed on disk since you opened it.
            </span>
            <span className="ml-auto flex gap-1">
              <button
                type="button"
                onClick={reloadFromDisk}
                className="rounded border border-subtle bg-surface px-2 py-0.5 text-secondary hover-bg-raised"
              >
                Reload
              </button>
              <button
                type="button"
                onClick={() => void save(true)}
                className="rounded border border-subtle bg-surface px-2 py-0.5 text-danger hover-bg-raised"
              >
                Save anyway
              </button>
            </span>
          </div>
          {conflict.disk !== null && conflict.rows.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-muted">
                Diff: disk → your edits
              </summary>
              <div className="mt-1 max-h-60 overflow-auto rounded border border-subtle bg-surface font-mono">
                {conflict.rows.map((row, i) => (
                  <ConflictRow key={i} row={row} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Non-blocking save failure + drift notice. */}
      {saveError && (
        <div className="shrink-0 border-b border-subtle bg-danger-soft px-3 py-1 text-xs text-danger">
          Couldn't save: {saveError}
        </div>
      )}
      {drift && !conflict && (
        <div className="shrink-0 border-b border-subtle px-3 py-1 text-xs text-warning">
          This file changed on disk; your unsaved edits are kept. Saving will
          ask what to do.
        </div>
      )}

      {/* Editor host + status/mode overlays */}
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="h-full" />
        {/* Markdown preview: same Streamdown setup as transcript markdown
         * (shared components + rehype chain from chat/MessagePart). */}
        {state.status === 'ready' && state.mode === 'markdown' && previewOn && (
          <div className="absolute inset-0 overflow-y-auto bg-surface px-4 py-3">
            <Streamdown
              mode="static"
              components={markdownComponents}
              rehypePlugins={rehypePlugins}
              className="prose-chat"
            >
              {previewText}
            </Streamdown>
          </div>
        )}
        {/* Image branch: bytes fetched as a blob from /api/files/raw. */}
        {state.status === 'ready' && state.mode === 'image' && (
          <div className="absolute inset-0 flex items-center justify-center overflow-auto bg-surface p-4">
            {imageSrc ? (
              <img
                src={imageSrc}
                alt={path}
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <span className="text-sm text-faint">Loading…</span>
            )}
          </div>
        )}
        {/* Binary branch: no bytes ship to the renderer — open externally. */}
        {state.status === 'ready' && state.mode === 'binary' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface px-6 text-center">
            <FileWarning className="h-8 w-8 text-faint" />
            <p className="text-sm text-muted">
              Can't display this file — it isn't text.
            </p>
            <button
              type="button"
              onClick={() => void openExternally()}
              className="rounded border border-subtle bg-surface px-3 py-1 text-xs text-secondary hover-bg-raised"
            >
              Open with default app
            </button>
            {openError && (
              <p className="text-xs text-danger">Couldn't open: {openError}</p>
            )}
          </div>
        )}
        {state.status === 'loading' && <Overlay>Loading…</Overlay>}
        {state.status === 'no-workspace' && (
          <Overlay>Open a workspace to preview files.</Overlay>
        )}
        {state.status === 'error' && (
          <Overlay tone="error">{state.message}</Overlay>
        )}
      </div>
    </div>
  )
}

const CONFLICT_ROW_TONE: Record<DiffRowKind, string> = {
  ctx: 'diff-ctx',
  add: 'diff-add',
  del: 'diff-del',
  gap: 'diff-gap',
}

const CONFLICT_ROW_SIGN: Record<DiffRowKind, string> = {
  ctx: ' ',
  add: '+',
  del: '−',
  gap: '⋮',
}

/** One row of the conflict banner's disk→buffer unified diff. */
function ConflictRow({
  row,
}: Readonly<{ row: DiffRow }>): React.JSX.Element {
  return (
    <div className={`flex items-baseline px-1 ${CONFLICT_ROW_TONE[row.kind]}`}>
      <span className="w-8 shrink-0 select-none pr-1 text-right text-faint">
        {row.oldNo ?? ''}
      </span>
      <span className="w-8 shrink-0 select-none pr-1 text-right text-faint">
        {row.newNo ?? ''}
      </span>
      <span className="w-4 shrink-0 select-none text-center">
        {CONFLICT_ROW_SIGN[row.kind]}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-all">{row.text}</span>
    </div>
  )
}

function Overlay({
  children,
  tone = 'muted',
}: Readonly<{
  children: React.ReactNode
  tone?: 'muted' | 'error'
}>): React.JSX.Element {
  return (
    <div
      className={`absolute inset-0 flex items-center justify-center bg-surface px-6 text-center text-sm ${
        tone === 'error' ? 'text-danger' : 'text-faint'
      }`}
    >
      {children}
    </div>
  )
}
