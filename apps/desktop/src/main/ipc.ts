/**
 * ipcMain handlers for the renderer-facing API surface.
 * Channel names live in @pydantic-chat/shared (IpcChannels).
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IpcChannels, type BackendInfo } from '@pydantic-chat/shared'

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
