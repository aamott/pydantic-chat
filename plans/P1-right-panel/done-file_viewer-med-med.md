# File viewer

## Goal

Read-only CodeMirror 6 viewer for any file in the workspace, fetched through the backend.

## Acceptance criteria

- `GET /api/files?workspace_id&path` — resolves path under workspace root (containment check, symlink-resolved), returns `{content, language?, size}`; rejects outside-root + binary/large files gracefully
- CM6 via thin `useRef`/`useEffect` wrapper; `@codemirror/language-data` lazy modes; read-only; scrolls to `#L` anchor
- Loading/error/not-found states; refresh on file change (re-fetch on focus is enough for v1)

## Files
- `apps/backend/app/api/files.py`, `features/editor/FileViewer.tsx`

## Implementation notes

- `apps/backend/app/api/files.py` — DONE. `GET /api/files?workspace_id&path`: lexical + symlink-resolved containment against the store's workspace root, protected-pattern jail (`first_matching_pattern` reused from `pydantic_ai_harness.filesystem._access`, patterns mirroring `FileSystem` defaults), 2MB cap, null-byte binary sniff → 413, extension → CM6 `language-data` hint. Response `{content, language, size, path}` (`FileOut`); covered by `tests/test_files.py`.
- `features/editor/FileViewer.tsx` — done, frontend portion only.
- Thin `useRef`+`useEffect` wrapper; `EditorState.readOnly.of(true)` + `EditorView.editable.of(false)`; `minimalSetup` + lineNumbers/foldGutter/bracketMatching.
- Lazy languages via `LanguageDescription.matchLanguageName` (backend `language` hint) with `matchFilename` fallback on the path.
- `#L` anchor: clamps to doc, `scrollIntoView({y:'center'})` + persistent line decoration via `StateEffect`/`StateField` (`cm-anchor-line` class, tinted in `viewerTheme`).
- Fetches via `apiFetch` + `URLSearchParams`; 403/404/413 mapped to readable errors (honors FastAPI `{detail}` body); loading/error/no-workspace overlays; identical-content refetch skips rebuild (preserves scroll); window-`focus` listener bumps a refetch.
- `workspaceId` is a prop — currently `null` from `App.tsx` (shows "Open a workspace" empty state) until `stores/chats.ts` (sidebar story) supplies the active workspace. TODO marked in App.tsx.
- **Dependency note:** `@codemirror/{state,view,language}` promoted to declared deps in `apps/desktop/package.json` (same pinned versions already in the lockfile as transitives) — Bun's isolated install makes undeclared transitive imports unresolvable; required for `EditorState`/`EditorView` facets per ACs.
- Depends on: pending-split_layout-med-easy.md — satisfied; pending-workspace_chat_api-high-easy.md — supplies workspace_id wiring + the endpoint itself.
