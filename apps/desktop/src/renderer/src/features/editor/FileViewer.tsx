/**
 * Read-only CodeMirror 6 viewer for workspace files, fetched through the
 * backend (`GET /api/files?workspace_id&path`). Thin useRef/useEffect wrapper —
 * no React editor binding library. Language modes are lazy-loaded via
 * `@codemirror/language-data`; freshness for v1 is a re-fetch on window focus.
 */
import { useEffect, useRef, useState } from 'react'
import { minimalSetup } from 'codemirror'
import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view'
import { bracketMatching, foldGutter, LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { apiFetch } from '../../lib/api'

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

/** Viewer chrome: fill parent, monospace scroller, no focus ring, anchor tint. */
const viewerTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  },
  '.cm-anchor-line': { backgroundColor: 'rgb(250 204 21 / 0.18)' },
  '&.cm-focused': { outline: 'none' },
})

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Contract of `GET /api/files` (backend route lands in a later story). */
interface FileResponse {
  content: string
  language?: string
  size: number
}

type ViewerState =
  | { status: 'no-workspace' }
  | { status: 'loading' }
  | { status: 'ready'; size: number; languageName: string | null }
  | { status: 'error'; message: string }

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
  hint: string | undefined,
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
  workspaceId: string | null
  /** Workspace-relative (or absolute) file path to preview. */
  path: string
  /** Optional 1-based line anchor to scroll to / highlight. */
  line?: number | null
}

export function FileViewer({
  workspaceId,
  path,
  line = null,
}: FileViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  /** Doc currently in the editor — skips rebuilds on identical refetches. */
  const loadedRef = useRef<{ path: string; content: string } | null>(null)
  const [state, setState] = useState<ViewerState>({ status: 'loading' })
  /** Bumped on window focus → re-fetch. */
  const [refreshKey, setRefreshKey] = useState(0)
  /** Bumped after each editor rebuild → retriggers the line-scroll effect. */
  const [docVersion, setDocVersion] = useState(0)

  /* Fetch + (re)build the editor. Skips the rebuild (keeps scroll) when a
   * focus refetch returns identical content. */
  useEffect(() => {
    if (!workspaceId) {
      setState({ status: 'no-workspace' })
      return
    }
    let cancelled = false
    // "Silent" = re-fetching the file already displayed (focus refresh).
    const silent = loadedRef.current?.path === path
    if (!silent) setState({ status: 'loading' })

    const load = async (): Promise<void> => {
      const params = new URLSearchParams({ workspace_id: workspaceId, path })
      const res = await apiFetch(`/api/files?${params}`)
      if (!res.ok) throw new Error(await describeError(res))
      const file = (await res.json()) as FileResponse
      const lang = await loadLanguage(file.language, path)
      if (cancelled) return

      if (
        loadedRef.current?.path === path &&
        loadedRef.current.content === file.content
      ) {
        setState({
          status: 'ready',
          size: file.size,
          languageName: lang?.name ?? null,
        })
        return
      }

      const parent = containerRef.current
      if (!parent) return
      viewRef.current?.destroy()
      viewRef.current = new EditorView({
        parent,
        state: EditorState.create({
          doc: file.content,
          extensions: [
            minimalSetup,
            lineNumbers(),
            foldGutter(),
            bracketMatching(),
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            anchorLineField,
            viewerTheme,
            ...(lang ? [lang.support] : []),
          ],
        }),
      })
      loadedRef.current = { path, content: file.content }
      setState({
        status: 'ready',
        size: file.size,
        languageName: lang?.name ?? null,
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

  /* Destroy the editor on unmount (rebuilds destroy the previous instance
   * inside the load effect instead, so identical-content refetches keep it). */
  useEffect(
    () => () => {
      viewRef.current?.destroy()
      viewRef.current = null
      loadedRef.current = null
    },
    [],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: path + file meta */}
      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-b border-neutral-200 px-3">
        <span
          className="truncate font-mono text-xs text-neutral-600"
          title={path}
        >
          {path}
        </span>
        {state.status === 'ready' && (
          <span className="shrink-0 text-xs text-neutral-400">
            {state.languageName ?? 'Plain text'} · {formatSize(state.size)} ·
            read-only
          </span>
        )}
      </div>

      {/* Editor host + status overlays */}
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="h-full" />
        {state.status === 'loading' && (
          <Overlay>Loading…</Overlay>
        )}
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

function Overlay({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode
  tone?: 'muted' | 'error'
}): React.JSX.Element {
  return (
    <div
      className={`absolute inset-0 flex items-center justify-center bg-white px-6 text-center text-sm ${
        tone === 'error' ? 'text-red-600' : 'text-neutral-400'
      }`}
    >
      {children}
    </div>
  )
}
