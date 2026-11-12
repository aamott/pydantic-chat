/**
 * BrowserWindow factories.
 *
 * Window bounds/maximized state persist via the built-in
 * `name` + `windowStatePersistence` options (Electron 44+, verified in
 * electron@45.2.3 types — still marked _Experimental_).
 *
 * Token delivery: `webPreferences.additionalArguments` appends
 * `--backend-url=`/`--backend-token=` to the renderer's argv, which the
 * preload reads synchronously from `process.argv` — the only synchronous
 * channel available before IPC is usable. It's a per-launch loopback
 * secret; argv exposure is equivalent to the env exposure the uvicorn
 * child already has. (`ipcMain.handle('backend:info')` remains available
 * for async refetches.)
 */
import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { BackendInfo } from '@pydantic-chat/shared'

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

function webPreferences(info: BackendInfo): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: false,
    additionalArguments: [
      `--backend-url=${info.url}`,
      `--backend-token=${info.token}`,
    ],
  }
}

export function createMainWindow(info: BackendInfo): BrowserWindow {
  const win = new BrowserWindow({
    name: 'main',
    windowStatePersistence: true,
    width: 1280,
    height: 800,
    webPreferences: webPreferences(info),
  })
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

/** Singleton settings window — focuses the existing one if still open. */
export function openSettingsWindow(info: BackendInfo): BrowserWindow {
  const existing = settingsWindow
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return existing
  }
  const win = new BrowserWindow({
    name: 'settings',
    windowStatePersistence: true,
    width: 700,
    height: 500,
    autoHideMenuBar: true,
    webPreferences: webPreferences(info),
  })
  settingsWindow = win
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/settings.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/settings.html'))
  }
  return win
}

export function loadMainRenderer(win: BrowserWindow): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/* ------------------------ placeholder pages ------------------------ */

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const page = (title: string, body: string): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><html><body style="font-family:system-ui;margin:3rem;color:#ddd;background:#1e1e1e">` +
      `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></body></html>`,
  )}`

/** Shown while the sidecar boots — swapped for the real renderer on ready. */
export function loadLoadingPage(win: BrowserWindow): void {
  void win.loadURL(page('pydantic-chat', 'Starting backend…'))
}

/** Terminal error state when the backend fails after all retries. */
export function showBackendError(win: BrowserWindow, message: string): void {
  void win.loadURL(
    page(
      'Backend unavailable',
      `${message} — restart the app to retry. ` +
        `Logs: see backend.log under the app's logs directory.`,
    ),
  )
}
