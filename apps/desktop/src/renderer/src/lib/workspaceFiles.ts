/**
 * Workspace file listing shared by the composer's attach surfaces —
 * the `+` `AttachPicker` and the `@` mention popup both flatten the
 * `GET /api/files/tree` response into `FlatFile[]` and insert the same
 * `[name](file:path)` markdown link.
 */
import { apiFetch } from './api'

/* Mirrors `FileTreeNode` in app/api/schemas.py (see FileExplorer). */
export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: FileTreeNode[] | null
}

export interface FileTreeResponse {
  root: FileTreeNode
  truncated: boolean
}

export interface FlatFile {
  name: string
  path: string
}

/** Deeper than the explorer's 3 — attachments can live anywhere. */
export const FILE_TREE_DEPTH = 6

/** Depth-first flatten of the tree into file entries only. */
export function flattenTree(node: FileTreeNode, out: FlatFile[]): void {
  if (node.type === 'file') {
    out.push({ name: node.name, path: node.path })
    return
  }
  for (const child of node.children ?? []) flattenTree(child, out)
}

/**
 * Fetch + flatten the workspace file tree (`GET /api/files/tree`).
 * Throws `Error("HTTP <status>")` on a non-2xx — callers map it to an
 * error state, same as the rest of the composer's inline fetches.
 */
export async function fetchWorkspaceFiles(
  workspaceId: string,
  depth: number = FILE_TREE_DEPTH,
): Promise<{ files: FlatFile[]; truncated: boolean }> {
  const params = new URLSearchParams({
    workspace_id: workspaceId,
    depth: String(depth),
  })
  const res = await apiFetch(`/api/files/tree?${params}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const tree = (await res.json()) as FileTreeResponse
  const files: FlatFile[] = []
  flattenTree(tree.root, files)
  return { files, truncated: tree.truncated }
}

/**
 * The markdown a file pick inserts into the composer — `[name](file:path)`,
 * matching the `file:` scheme `lib/fileRefs.ts` parses and the system
 * prompt's link guidance for the model.
 */
export function fileMentionMarkdown(file: FlatFile): string {
  return `[${file.name}](file:${file.path})`
}
