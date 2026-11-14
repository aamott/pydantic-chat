/**
 * Preload: exposes `window.api` to the renderer via contextBridge.
 *
 * `backendUrl`/`token` are parsed synchronously from `process.argv` — main
 * passes them via `webPreferences.additionalArguments` (the only sync
 * channel into a preload; see windows.ts). `getBackendInfo()` offers an
 * async refetch over IPC for post-restart recovery.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IpcChannels,
  type BackendInfo,
  type BackendStatus,
} from '@pydantic-chat/shared'

const argvValue = (prefix: string): string => {
  const arg = process.argv.find((a) => a.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : ''
}

const api = {
  /** Loopback base URL of the FastAPI sidecar (from launch argv). */
  backendUrl: argvValue('--backend-url='),
  /** Per-launch bearer token for backend requests (from launch argv). */
  token: argvValue('--backend-token='),

  /** Async refetch of connection info (e.g. after a backend restart). */
  getBackendInfo: (): Promise<BackendInfo | null> =>
    ipcRenderer.invoke(IpcChannels.backendInfo),

  /** Native directory picker → absolute path, or null when cancelled. */
  pickWorkspace: (): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.pickWorkspace),

  /** Open (or focus) the singleton settings window. */
  openSettings: (): Promise<void> => ipcRenderer.invoke(IpcChannels.settingsOpen),

  /** File ▸ Open Workspace… — subscribe; returns an unsubscribe fn. */
  onOpenWorkspace: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IpcChannels.menuOpenWorkspace, listener)
    return () => ipcRenderer.removeListener(IpcChannels.menuOpenWorkspace, listener)
  },

  /** Sidecar lifecycle broadcasts — subscribe; returns an unsubscribe fn. */
  onBackendStatus: (callback: (status: BackendStatus) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, status: BackendStatus): void =>
      callback(status)
    ipcRenderer.on(IpcChannels.backendStatus, listener)
    return () => ipcRenderer.removeListener(IpcChannels.backendStatus, listener)
  },

  /** Settings window → main: theme changed; main relays to other windows. */
  notifyTheme: (theme: string): void => {
    ipcRenderer.send(IpcChannels.settingsTheme, theme)
  },

  /** Theme broadcast from another window — subscribe; returns unsubscribe. */
  onTheme: (callback: (theme: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, theme: string): void =>
      callback(theme)
    ipcRenderer.on(IpcChannels.settingsTheme, listener)
    return () => ipcRenderer.removeListener(IpcChannels.settingsTheme, listener)
  },
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
