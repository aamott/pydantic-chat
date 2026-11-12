/**
 * Application menu. File actions are delegated back to index.ts via deps so
 * this module stays free of window/sidecar coupling.
 */
import { app, Menu, type MenuItemConstructorOptions } from 'electron'

export interface MenuDeps {
  /** File ▸ Open Workspace… — send `menu:open-workspace` to a window. */
  openWorkspace: () => void
  /** File ▸ Open Settings — open/focus the settings window. */
  openSettings: () => void
}

export function installMenu(deps: MenuDeps): void {
  // Reload/devtools are only useful against the dev server / unpacked build.
  const isDev = !app.isPackaged

  const viewSubmenu: MenuItemConstructorOptions[] = isDev
    ? [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ]
    : [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }]

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Workspace…',
          accelerator: 'CmdOrCtrl+O',
          click: () => deps.openWorkspace(),
        },
        {
          label: 'Open Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => deps.openSettings(),
        },
        { type: 'separator' },
        process.platform === 'darwin'
          ? { role: 'close' }
          : { role: 'quit', label: 'Quit' },
      ],
    },
    { role: 'editMenu' },
    { label: 'View', submenu: viewSubmenu },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
