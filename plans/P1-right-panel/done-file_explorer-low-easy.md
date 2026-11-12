# File explorer

## Goal

Workspace directory tree in the right panel.

## Acceptance criteria

- `GET /api/files/tree?workspace_id` — lazy-friendly dir listing (exclude `.git`, `node_modules`, hidden dirs beyond depth 1); containment-checked
- Tree component (Explorer tab): expand/collapse, file click → viewer tab, folder filter; gitignore-aware if cheap via `rg --files`
- Shows files from the active chat's workspace

## Status
- DONE (backend): `GET /api/files/tree?workspace_id&depth=3` — `rg --files --sort path` when rg is on PATH (gitignore-aware, Coder `list_files` parity), bounded-walk fallback; returns `{root: {name, path, type, children}, truncated}` (`FileTreeOut` in `app/api/schemas.py`), capped at 5000 files. Containment enforced by the root jail; empty dirs aren't listed (same as `rg --files`).
- DONE (frontend): `FileExplorer.tsx` — tree with client-side expand/collapse (nested response, no extra fetches), file/dir icons by extension, refresh + `truncated` indicator, loading/error/null-workspace states; file click → `openFile(node.path)` (workspace-relative, matching `GET /api/files?path=`). Wired into the RightPanel Explorer tab.

## Depends on
- pending-file_viewer-med-med.md
