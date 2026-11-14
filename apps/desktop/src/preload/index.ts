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

  /**
   * Open a workspace file with the OS default app (`shell.openPath`) — the
   * binary file branch's escape hatch. Main resolves `path` against the
   * workspace's stored root and rejects escapes. Resolves to '' on success
   * or a system error string; the invoke itself rejects on confinement
   * failures.
   */
  openPath: (workspaceId: string, path: string): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.shellOpenPath, workspaceId, path),

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

  /**
   * Settings window → main: open `path` in the main window's FileViewer.
   * Renderer stores are per-window, so `useUiStore.openFile` can't be
   * invoked cross-window — main focuses the main window and relays the
   * request to it.
   */
  openFileInViewer: (workspaceId: string, path: string): void => {
    ipcRenderer.send(IpcChannels.openFileInViewer, { workspaceId, path })
  },

  /** Main window: cross-window file-open requests; returns unsubscribe. */
  onOpenFileInViewer: (
    callback: (workspaceId: string, path: string) => void,
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { workspaceId: string; path: string },
    ): void => callback(payload.workspaceId, payload.path)
    ipcRenderer.on(IpcChannels.openFileInViewer, listener)
    return () =>
      ipcRenderer.removeListener(IpcChannels.openFileInViewer, listener)
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
