/**
 * `useWorkspaceFiles` — shared tree fetch for the composer's file
 * surfaces (`AttachPicker`, the `@` mention popup).
 *
 * Fetches `GET /api/files/tree` via `fetchWorkspaceFiles` each time
 * `active` flips true (each picker open / each mention session), so
 * newly created files show up. The previous state is kept while
 * inactive — callers only render while `active`.
 */
import { useEffect, useState } from 'react'
import {
  fetchWorkspaceFiles,
  type FlatFile,
} from '../../lib/workspaceFiles'

export type WorkspaceFilesState =
  | { status: 'loading' }
  | { status: 'ready'; files: FlatFile[]; truncated: boolean }
  | { status: 'error'; message: string }

export function useWorkspaceFiles(
  workspaceId: string | null,
  active: boolean,
): WorkspaceFilesState {
  const [state, setState] = useState<WorkspaceFilesState>({
    status: 'loading',
  })

  useEffect(() => {
    if (!active || !workspaceId) return
    let cancelled = false
    setState({ status: 'loading' })

    fetchWorkspaceFiles(workspaceId)
      .then(({ files, truncated }) => {
        if (!cancelled) setState({ status: 'ready', files, truncated })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [active, workspaceId])

  return state
}
