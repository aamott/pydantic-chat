# P1-right-panel

## Goal

Optional right split panel: view any file the agent references (read-only), browse workspace files, see diffs and shell output.

## Scope

- `react-resizable-panels` split; panel state + sizes persisted via Zustand persist
- `GET /api/files?path=` — backend reads file, sandboxed to registered workspace roots; CodeMirror 6 viewer (`language-data` lazy modes), `#L` line anchors
- File references: intercept `file:`-scheme links in Streamdown + tool-card links → `ui.openFile(path, line)`
- File explorer tab: workspace dir tree (backend listing endpoint) → click opens file
- Diff view (`@codemirror/merge`) rendering agent edit previews from tool parts
- Terminal view: scrollable output card fed by shell-tool `data-*` parts

## Architecture decisions

- Read-only in v1 — no save path; file content always fetched fresh from backend (never renderer fs access)
- All panel tabs share one open state in the ui store: `{open, activeTab, filePath, line}`

Depends on: P1-app-scaffold, P1-chat-core (tool parts exist to link from)

## Status

- ⬜ Split layout + persisted panel state
- ⬜ File viewer (backend endpoint + CM6)
- ⬜ File links open panel at line
- ⬜ File explorer
- ⬜ Diff view
- ⬜ Terminal/output view
