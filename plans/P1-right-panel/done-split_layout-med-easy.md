# Split layout

## Goal

Chat left, tool/file panel right — resizable, toggleable, persisted.

## Acceptance criteria

- `react-resizable-panels` v4 horizontal split (`Group`/`Panel`/`Separator` — renamed API); `useDefaultLayout({id, storage})` persists sizes built-in
- Zustand `ui` store `{open, activeTab, filePath, line}` persists open state/tab/file (sizes handled by useDefaultLayout, don't duplicate); optional v4 `Workspace` component for dockable tabs if it stays simple
- Toggle via keyboard shortcut + toolbar button; tabs: File, Explorer, Diff, Terminal

## Files
- `features/editor/RightPanel.tsx`, `stores/ui.ts` — also `features/editor/SplitLayout.tsx` (Group wrapper), `App.tsx` (toggle wiring)

## Implementation notes (done)

- `stores/ui.ts`: `useUiStore` (zustand `persist`, key `pydantic-chat:ui`) — persists `rightPanelOpen` + `activeTab` only. `filePath`/`line` deliberately NOT persisted: they're navigation context tied to the active workspace, and a stale restored path would surface the wrong file. Actions: `openFile(path, line?)` (opens panel + File tab), `closePanel`, `togglePanel`, `setTab`.
- `features/editor/SplitLayout.tsx`: `Group`/`Panel`/`Separator` + `useDefaultLayout({id:'main-split', storage:localStorage, onlySaveAfterUserInteractions:true})` — the flag prevents mount/recompute writes from clobbering the user's manual split. Panels: `chat` (min 30%), `right` (default 35%, min 280px, max 80%). Skipped v4 `Workspace` component — overkill for a fixed tab strip.
- `App.tsx`: split `Group` mounts only while `rightPanelOpen` (sizes restore on remount); Ctrl/Cmd+B + toolbar button (`PanelRight` icon) toggle it.
- Depends on: pending-repo_scaffold-high-easy.md — satisfied.
