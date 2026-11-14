# Viewer modes: auto-edit, special viewers, open-externally, dirty indicator

## Goal

Four UX upgrades to the right-panel file viewer, building on the writable-editor work (`done-writable_editor-low-med.md`):

1. **Auto-edit**: files open in edit mode by default whenever editing is allowed (effective profile is not `workspace_read_only`). The pencil remains as a manual lock/unlock toggle.
2. **Special viewers where easy**: markdown gets a rendered preview (source/preview toggle — `streamdown` is already a dep used by chat); images (png/jpg/gif/webp/svg) render inline rather than as text.
3. **Unknown/binary files**: instead of showing contents, show a "can't display" prompt with an **Open with default app** button — Electron `shell.openPath`, like double-clicking in a file explorer.
4. **Dirty indicator**: a clear unsaved-changes indicator (dot on the file tab + header state) whenever the buffer differs from disk.

## Backend / main-process work

- `GET /api/files` gains a `kind` field (`'text' | 'image' | 'binary'` — from extension + content sniffing for NUL bytes). Binary files return `kind` + metadata, **not** body bytes (don't ship garbage to the renderer).
- Images need bytes: either `GET /api/files?raw=1` (bytes, same confinement) or the renderer fetches via a custom protocol — pick whichever composes with existing code; document choice.
- New main-process IPC `shell:open-path` → `shell.openPath(resolved)`; validate the resolved path stays inside a registered workspace root (mirror `_resolve_workspace_file`'s lexical+symlink checks in TS — the renderer passes workspace id + relative path, main resolves via the workspace's stored root). Bind through preload `window.api`.

## Frontend

- `FileOut`/`FileWriteIn` shared types: `kind` (and raw/image fetch path as designed).
- `FileViewer`: default `editable` when allowed; dirty dot on tab/header (the "modified" text already exists — make it a proper indicator); markdown preview toggle; image rendering branch; binary branch → open-externally button.
- Keep conflict/dirty-guard behavior from the writable editor intact.

## Acceptance criteria

- Open a `.md` → rendered preview toggle works; open `.ts` → editable immediately under a writable profile; open `.png` → image renders; open a random binary → open-externally prompt, button launches the file; edit without saving → dirty dot shows in the header/tab.
- Path escape attempts through `shell:open-path` rejected (test lexical + symlink escapes).
- TDD: backend `kind` detection + confinement tests; frontend pure-logic tests (kind→viewer-mode mapping, dirty detection reuse).

## File references

- `apps/backend/app/api/files.py`, `tests/test_files.py`
- `apps/desktop/src/renderer/src/features/editor/{FileViewer,RightPanel}.tsx`
- `apps/desktop/src/renderer/src/stores/{ui,chats}.ts` (`fileDirty`, `effectiveProfileId`)
- `apps/desktop/src/main/{index,windows}.ts` + `src/preload/index.ts` (existing IPC patterns)
