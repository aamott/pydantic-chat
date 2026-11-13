/**
 * Electron main entry: single-instance lock → sidecar launch → main window.
 * The renderer only loads after the backend answers /health; persistent
 * failure swaps the window to a plain error page.
 */
import { app, BrowserWindow } from 'electron'
import {
  IpcChannels,
  type BackendInfo,
  type BackendStatus,
} from '@pydantic-chat/shared'
import { registerIpcHandlers } from './ipc'
import { installMenu } from './menu'
import { BackendSidecar } from './sidecar'
import {
  createMainWindow,
  getMainWindow,
  loadLoadingPage,
  loadMainRenderer,
  openSettingsWindow,
  showBackendError,
} from './windows'

let backendInfo: BackendInfo | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

const sidecar = new BackendSidecar((status: BackendStatus) => {
  broadcast(IpcChannels.backendStatus, status)
  // Backend died past the retry cap while the app was running → error page.
  if (status.state === 'failed') {
    const win = getMainWindow()
    if (win) showBackendError(win, status.error)
  }
})

function openSettings(): void {
  if (backendInfo) openSettingsWindow(backendInfo)
}

/** Open Workspace… goes to the focused window (settings excluded via type). */
function sendOpenWorkspace(): void {
  const win = BrowserWindow.getFocusedWindow() ?? getMainWindow()
  win?.webContents.send(IpcChannels.menuOpenWorkspace)
}

/** Swap in the real renderer once the backend is healthy; else error page. */
function loadWhenReady(win: BrowserWindow): void {
  loadLoadingPage(win)
  sidecar
    .waitReady()
    .then(() => loadMainRenderer(win))
    .catch((err: unknown) =>
      showBackendError(win, err instanceof Error ? err.message : String(err)),
    )
}

async function bootstrap(): Promise<void> {
  registerIpcHandlers({ getBackendInfo: () => backendInfo, openSettings })
  installMenu({ openSettings, openWorkspace: sendOpenWorkspace })

  backendInfo = await sidecar.launch()
  loadWhenReady(createMainWindow(backendInfo))
}

/* ------------------------------ app events ------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault() // hold quit until the sidecar tree is dead
    void sidecar.stop().finally(() => app.quit())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && backendInfo) {
      loadWhenReady(createMainWindow(backendInfo))
    }
  })

  void app.whenReady().then(bootstrap)
}
