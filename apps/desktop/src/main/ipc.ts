/**
 * ipcMain handlers for the renderer-facing API surface.
 * Channel names live in @pydantic-chat/shared (IpcChannels).
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  IpcChannels,
  type BackendInfo,
  type Workspace,
} from '@pydantic-chat/shared'
import { resolveWorkspaceFile } from './workspaceFile'
import { getMainWindow } from './windows'

export interface IpcDeps {
  getBackendInfo: () => BackendInfo | null
  openSettings: () => void
}

export function registerIpcHandlers(deps: IpcDeps): void {
  ipcMain.handle(IpcChannels.pickWorkspace, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Open Workspace',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IpcChannels.backendInfo, () => deps.getBackendInfo())

  ipcMain.handle(IpcChannels.settingsOpen, () => deps.openSettings())

  /* The binary file branch's "Open with default app": the renderer sends a
   * workspace id + relative path; main resolves it against the workspace's
   * stored root (fetched from the backend — never trusting renderer-supplied
   * roots) and jails it with the same lexical + symlink containment the file
   * API enforces. Escapes reject loudly (ipcRenderer.invoke propagates the
   * thrown Error). Returns shell.openPath's result: '' on success, else a
   * system error string. */
  ipcMain.handle(
    IpcChannels.shellOpenPath,
    async (_event, workspaceId: string, path: string) => {
      const info = deps.getBackendInfo()
      if (!info) throw new Error('Backend unavailable')
      const res = await fetch(`${info.url}/api/workspaces`, {
        headers: { Authorization: `Bearer ${info.token}` },
      })
      if (!res.ok) {
        throw new Error(`Workspace lookup failed (HTTP ${res.status})`)
      }
      const workspaces = (await res.json()) as Workspace[]
      const workspace = workspaces.find((w) => w.id === workspaceId)
      if (!workspace) throw new Error('Workspace not found')
      const resolved = resolveWorkspaceFile(workspace.path, path)
      return shell.openPath(resolved)
    },
  )

  /* Settings window → main window: open a workspace file in the
   * FileViewer. Zustand stores are per-window, so the settings renderer
   * can't call `useUiStore.openFile` itself — focus the main window and
   * forward the request to it (App subscribes via onOpenFileInViewer). */
  ipcMain.on(
    IpcChannels.openFileInViewer,
    (_event, payload: { workspaceId: string; path: string }) => {
      const win = getMainWindow()
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send(IpcChannels.openFileInViewer, payload)
    },
  )

  /* Settings window live-applies theme changes to itself; relay them to the
   * other windows so they flip without waiting for a restart or refocus. */
  ipcMain.on(IpcChannels.settingsTheme, (event, theme: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents !== event.sender && !win.isDestroyed()) {
        win.webContents.send(IpcChannels.settingsTheme, theme)
      }
    }
  })
}
