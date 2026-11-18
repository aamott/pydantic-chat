/**
 * Workspace file tree for the right panel's Explorer tab — lazy-loaded:
 * only one directory level crosses the wire per fetch.
 *
 * The root level is fetched on mount/workspace change
 * (`GET /api/files/tree?workspace_id&path=&depth=1`); expanding a dir
 * fetches `path=<dir>` and caches the result in `dirs` for the session —
 * collapsing never drops the cache, so re-expanding is free. The refresh
 * button clears the cache and re-fetches the root plus every dir in
 * `expanded`, preserving the expansion state.
 *
 * Path form: node `path` is workspace-relative POSIX (`""` on the root),
 * which is exactly what `GET /api/files?path=` and `ui.filePath` expect, so
 * it is passed through unchanged — no absolute-path resolution needed.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode,
  FileImage,
  FileJson,
  FileTerminal,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { apiFetch } from '../../lib/api'
import { iconButtonClass } from '../../lib/ui'
import { useUiStore } from '../../stores/ui'
import { EmptyState } from './EmptyState'

/* ------------------------------------------------------------------ */
/* Contract (mirrors `FileTreeNode`/`FileTreeOut` in app/api/schemas.py) */
/* ------------------------------------------------------------------ */

interface FileTreeNode {
  /** Basename of the file or directory. */
  name: string
  /** Workspace-relative POSIX path; `""` on the root node. */
  path: string
  type: 'file' | 'dir'
  /**
   * Set on directories — empty at the listing frontier (the dir exists but
   * its children were not fetched) — absent/`null` on files.
   */
  children?: FileTreeNode[] | null
}

interface FileTreeResponse {
  root: FileTreeNode
  /** True when the server-side entry cap cut the listing short. */
  truncated: boolean
}

/** One directory's fetch state, cached by workspace-relative dir path. */
interface DirListing {
  /** Fetched children; `null` until the first fetch resolves. */
  children: FileTreeNode[] | null
  loading: boolean
  /** Last fetch's error, if any — retried on the next expand. */
  error: string | null
}

type ExplorerState =
  | { status: 'loading' }
  | { status: 'ready'; root: FileTreeNode }
  | { status: 'error'; message: string }

/** Depth requested per scoped fetch — the explorer lazily loads one level. */
const LISTING_DEPTH = 1

/* ------------------------------------------------------------------ */
/* File icons                                                           */
/* ------------------------------------------------------------------ */

/**
 * Extension → icon map. Deliberately small: anything unmapped falls back to
 * the generic `File` icon.
 */
const ICON_BY_EXT: Record<string, LucideIcon> = {
  // Source code
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  py: FileCode,
  rs: FileCode,
  go: FileCode,
  java: FileCode,
  c: FileCode,
  h: FileCode,
  cpp: FileCode,
  hpp: FileCode,
  cs: FileCode,
  rb: FileCode,
  php: FileCode,
  html: FileCode,
  css: FileCode,
  scss: FileCode,
  less: FileCode,
  vue: FileCode,
  svelte: FileCode,
  sql: FileCode,
  // Structured data / config
  json: FileJson,
  jsonc: FileJson,
  yaml: FileJson,
  yml: FileJson,
  toml: FileJson,
  xml: FileJson,
  ini: FileJson,
  lock: FileJson,
  // Shell scripts
  sh: FileTerminal,
  bash: FileTerminal,
  zsh: FileTerminal,
  fish: FileTerminal,
  ps1: FileTerminal,
  bat: FileTerminal,
  // Images
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  webp: FileImage,
  ico: FileImage,
  bmp: FileImage,
  // Prose / docs
  md: FileText,
  txt: FileText,
  rst: FileText,
  pdf: FileText,
}

/** Extensionless filenames worth a special icon (e.g. `Dockerfile`). */
const ICON_BY_NAME: Record<string, LucideIcon> = {
  dockerfile: FileTerminal,
  makefile: FileTerminal,
  'cmakelists.txt': FileCode,
  license: FileText,
}

/** Pick the icon for a file node: exact-name map first, then extension. */
function fileIcon(name: string): LucideIcon {
  const lower = name.toLowerCase()
  if (ICON_BY_NAME[lower]) return ICON_BY_NAME[lower]
  const dot = lower.lastIndexOf('.')
  const ext = dot > 0 ? lower.slice(dot + 1) : ''
  return ICON_BY_EXT[ext] ?? File
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/** Map non-OK tree responses (404 unknown/gone workspace) to readable text. */
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
  if (res.status === 404) return detail ?? 'Workspace not found.'
  return detail ?? `Request failed (HTTP ${res.status}).`
}

/** One level of a directory listing via the scoped tree endpoint. */
async function fetchTree(
  workspaceId: string,
  dirPath: string,
): Promise<FileTreeResponse> {
  const params = new URLSearchParams({
    workspace_id: workspaceId,
    path: dirPath,
    depth: String(LISTING_DEPTH),
  })
  const res = await apiFetch(`/api/files/tree?${params}`)
  if (!res.ok) throw new Error(await describeError(res))
  return (await res.json()) as FileTreeResponse
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

interface FileExplorerProps {
  /** Active workspace id; null renders an empty state (no fetch). */
  readonly workspaceId: string | null
}

export function FileExplorer({
  workspaceId,
}: Readonly<FileExplorerProps>): React.JSX.Element {
  const openFile = useUiStore((s) => s.openFile)
  const activePath = useUiStore((s) => s.filePath)
  const [state, setState] = useState<ExplorerState>({ status: 'loading' })
  /** Bumped by the toolbar refresh button → cache clear + re-fetch. */
  const [refreshKey, setRefreshKey] = useState(0)
  /** Workspace-relative paths of expanded dirs; survives refreshes. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  /** Per-dir listings keyed by workspace-relative dir path (`""` = root). */
  const [dirs, setDirs] = useState<ReadonlyMap<string, DirListing>>(new Map())
  /** OR of every listing's `truncated` flag — any capped dir warns. */
  const [truncated, setTruncated] = useState(false)
  /** Session token — stale fetches (pre-switch/pre-refresh) discard results. */
  const sessionRef = useRef(0)

  /* Merge a patch into one dir's cached listing. */
  const updateDir = (dirPath: string, patch: Partial<DirListing>): void => {
    setDirs((prev) => {
      const next = new Map(prev)
      next.set(dirPath, {
        children: null,
        loading: false,
        error: null,
        ...prev.get(dirPath),
        ...patch,
      })
      return next
    })
  }

  /* Fetch one dir's children into the cache. Loading and error states are
   * recorded on the entry so the row can render them; results landing after
   * a workspace switch/refresh are discarded via the session token. */
  const loadDir = async (dirPath: string): Promise<void> => {
    if (!workspaceId) return
    const session = sessionRef.current
    updateDir(dirPath, { loading: true, error: null })
    try {
      const tree = await fetchTree(workspaceId, dirPath)
      if (session !== sessionRef.current) return
      updateDir(dirPath, {
        children: tree.root.children ?? [],
        loading: false,
        error: null,
      })
      if (tree.truncated) setTruncated(true)
    } catch (err: unknown) {
      if (session !== sessionRef.current) return
      updateDir(dirPath, {
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /* Fetch the root listing whenever the workspace or refresh key changes.
   * A refresh clears the cache first, then re-fetches every dir in
   * `expanded` so the visible tree stays expanded with fresh children.
   * (`expanded`/`loadDir` are read at fire time — the latest render's
   * values, which is exactly "the dirs expanded when refresh fired".) */
  useEffect(() => {
    if (!workspaceId) return
    sessionRef.current += 1
    const session = sessionRef.current
    setState({ status: 'loading' })
    setTruncated(false)
    setDirs(new Map())

    fetchTree(workspaceId, '')
      .then((tree) => {
        if (session !== sessionRef.current) return
        setDirs(
          new Map([
            [
              '',
              {
                children: tree.root.children ?? [],
                loading: false,
                error: null,
              },
            ],
          ]),
        )
        if (tree.truncated) setTruncated(true)
        setState({ status: 'ready', root: tree.root })
        for (const dirPath of expanded) void loadDir(dirPath)
      })
      .catch((err: unknown) => {
        if (session !== sessionRef.current) return
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, refreshKey])

  /* Null workspace → empty state, no fetch (mirrors FileViewer). */
  if (!workspaceId) {
    return (
      <EmptyState icon={FolderTree} note="Open a workspace to browse files." />
    )
  }

  const toggleDir = (path: string): void => {
    /* Fetch on expand only: a cached listing (even a collapsed one) is
     * reused — collapsing never drops the cache — while an errored or
     * never-fetched dir fetches on the next expand. */
    const listing = dirs.get(path)
    if (!expanded.has(path) && (!listing || listing.error !== null)) {
      void loadDir(path)
    }
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const root = state.status === 'ready' ? state.root : null
  const children = dirs.get('')?.children ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar: workspace root name, truncation warning, refresh */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-subtle px-2">
        {root ? (
          <span
            className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium text-secondary"
            title={root.name}
          >
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-faint" />
            <span className="truncate">{root.name}</span>
          </span>
        ) : (
          <span className="flex-1 text-xs text-faint">Explorer</span>
        )}
        {state.status === 'ready' && truncated && (
          <span
            className="flex shrink-0 items-center gap-1 text-xs text-warning"
            title="File listing hit the server cap — the tree is a prefix, not the whole workspace."
          >
            <TriangleAlert className="h-3.5 w-3.5" />
            Truncated
          </span>
        )}
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          disabled={state.status === 'loading'}
          aria-label="Refresh file tree"
          title="Refresh file tree"
          className={`shrink-0 ${iconButtonClass({ muted: true })} disabled:opacity-40`}
        >
          {state.status === 'loading' ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* Tree body */}
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {state.status === 'loading' && <EmptyState note="Loading files…" />}
        {state.status === 'error' && (
          <EmptyState tone="error" note={state.message} />
        )}
        {state.status === 'ready' &&
          (children.length === 0 ? (
            <EmptyState note="No files in this workspace." />
          ) : (
            <div role="tree" aria-label="Workspace files">
              {children.map((node) => (
                <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  dirs={dirs}
                  activePath={activePath}
                  onToggleDir={toggleDir}
                  onOpenFile={openFile}
                />
              ))}
            </div>
          ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tree rows                                                            */
/* ------------------------------------------------------------------ */

interface TreeRowProps {
  readonly node: FileTreeNode
  /** Indent level; root's children start at 0. */
  readonly depth: number
  readonly expanded: ReadonlySet<string>
  /** Per-dir listings cache — an expanded dir renders from its own entry. */
  readonly dirs: ReadonlyMap<string, DirListing>
  /** Currently viewed file (highlighted), or null. */
  readonly activePath: string | null
  readonly onToggleDir: (path: string) => void
  readonly onOpenFile: (path: string) => void
}

/**
 * One tree row. Expanded dirs render their cached listing — a spinner row
 * while fetching, an error row on failure, the children otherwise. An
 * empty dir expands to nothing (same as the pre-lazy empty-dir handling).
 */
function TreeRow({
  node,
  depth,
  expanded,
  dirs,
  activePath,
  onToggleDir,
  onOpenFile,
}: Readonly<TreeRowProps>): React.JSX.Element {
  const isDir = node.type === 'dir'
  const isExpanded = isDir && expanded.has(node.path)
  const isActive = !isDir && node.path === activePath
  const dirIcon = isExpanded ? FolderOpen : Folder
  const Icon = isDir ? dirIcon : fileIcon(node.name)
  const Chevron = isExpanded ? ChevronDown : ChevronRight
  const listing = isExpanded ? dirs.get(node.path) : undefined

  const activate = (): void => {
    if (isDir) onToggleDir(node.path)
    else onOpenFile(node.path)
  }

  /* Keyboard support: Enter/Space activates; arrows expand/collapse dirs. */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activate()
    } else if (isDir && e.key === 'ArrowRight' && !isExpanded) {
      onToggleDir(node.path)
    } else if (isDir && e.key === 'ArrowLeft' && isExpanded) {
      onToggleDir(node.path)
    }
  }

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={isDir ? isExpanded : undefined}
        aria-selected={isActive}
        tabIndex={0}
        title={node.path}
        onClick={activate}
        onKeyDown={onKeyDown}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        className={`flex cursor-pointer items-center gap-1 py-0.5 pr-2 text-xs outline-none select-none focus-bg-raised ${
          isActive
            ? 'bg-accent-soft text-accent'
            : 'text-secondary hover-bg-raised'
        }`}
      >
        {/* Chevron slot — fixed width so file names align with dir names. */}
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {isDir && <Chevron className="h-3.5 w-3.5 text-faint" />}
        </span>
        <Icon
          className={`h-3.5 w-3.5 shrink-0 ${
            isDir ? 'text-faint' : 'text-muted'
          }`}
        />
        <span className="truncate">{node.name}</span>
      </div>
      {isDir && isExpanded && (
        /* role="group" is the ARIA-prescribed wrapper for a treeitem's
         * children — the suggested native elements don't apply. */
        <div role="group" /* NOSONAR */>
          {listing?.loading && (
            <TreeNote depth={depth + 1}>
              <LoaderCircle className="h-3 w-3 animate-spin" />
              Loading…
            </TreeNote>
          )}
          {listing?.error !== null && listing?.error !== undefined && (
            <TreeNote depth={depth + 1} tone="error">
              {listing.error}
            </TreeNote>
          )}
          {listing?.children?.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              dirs={dirs}
              activePath={activePath}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </>
  )
}

/** Indented status line inside an expanded dir (loading/error rows). */
function TreeNote({
  depth,
  tone = 'muted',
  children,
}: Readonly<{
  depth: number
  tone?: 'muted' | 'error'
  children: React.ReactNode
}>): React.JSX.Element {
  return (
    <div
      /* +24px clears the chevron + icon slots so text aligns with names. */
      style={{ paddingLeft: `${depth * 12 + 24}px` }}
      className={`flex items-center gap-1.5 py-0.5 pr-2 text-xs select-none ${
        tone === 'error' ? 'text-danger' : 'text-faint'
      }`}
    >
      {children}
    </div>
  )
}
