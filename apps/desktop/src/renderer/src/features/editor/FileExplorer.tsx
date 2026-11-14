/**
 * Workspace file tree for the right panel's Explorer tab.
 *
 * Fetches `GET /api/files/tree?workspace_id&depth=3` (already nested —
 * expansion is purely client-side, no per-directory fetches) and renders an
 * expandable tree. File clicks route through `useUiStore.openFile`, which
 * switches the panel to the File tab hosting `FileViewer`.
 *
 * Path form: node `path` is workspace-relative POSIX (`""` on the root),
 * which is exactly what `GET /api/files?path=` and `ui.filePath` expect, so
 * it is passed through unchanged — no absolute-path resolution needed.
 */
import { useEffect, useState } from 'react'
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
  /** Set on directories (possibly empty), absent/`null` on files. */
  children?: FileTreeNode[] | null
}

interface FileTreeResponse {
  root: FileTreeNode
  /** True when the server-side entry cap cut the listing short. */
  truncated: boolean
}

type ExplorerState =
  | { status: 'loading' }
  | { status: 'ready'; root: FileTreeNode; truncated: boolean }
  | { status: 'error'; message: string }

/** Server-side depth requested for the tree (backend default is also 3). */
const TREE_DEPTH = 3

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
  /** Bumped by the toolbar refresh button → re-fetch. */
  const [refreshKey, setRefreshKey] = useState(0)
  /** Workspace-relative paths of expanded dirs; survives refreshes. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  /* Fetch the (already nested) tree whenever the workspace or refresh key
   * changes. The cancelled flag avoids setting state after unmount or a
   * workspace switch. */
  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    setState({ status: 'loading' })

    const load = async (): Promise<void> => {
      const params = new URLSearchParams({
        workspace_id: workspaceId,
        depth: String(TREE_DEPTH),
      })
      const res = await apiFetch(`/api/files/tree?${params}`)
      if (!res.ok) throw new Error(await describeError(res))
      const tree = (await res.json()) as FileTreeResponse
      if (!cancelled) {
        setState({
          status: 'ready',
          root: tree.root,
          truncated: tree.truncated,
        })
      }
    }

    load().catch((err: unknown) => {
      if (!cancelled) {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })

    return () => {
      cancelled = true
    }
  }, [workspaceId, refreshKey])

  /* Null workspace → empty state, no fetch (mirrors FileViewer). */
  if (!workspaceId) {
    return (
      <EmptyState icon={FolderTree} note="Open a workspace to browse files." />
    )
  }

  const toggleDir = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const root = state.status === 'ready' ? state.root : null
  const children = root?.children ?? []

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
        {state.status === 'ready' && state.truncated && (
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
  /** Currently viewed file (highlighted), or null. */
  readonly activePath: string | null
  readonly onToggleDir: (path: string) => void
  readonly onOpenFile: (path: string) => void
}

/**
 * One tree row. Directory children render lazily — the subtree data is
 * already in memory, so "lazy" here means "not mounted until expanded".
 */
function TreeRow({
  node,
  depth,
  expanded,
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
      {isDir && isExpanded && node.children && node.children.length > 0 && (
        /* role="group" is the ARIA-prescribed wrapper for a treeitem's
         * children — the suggested native elements don't apply. */
        <div role="group" /* NOSONAR */>
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
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
