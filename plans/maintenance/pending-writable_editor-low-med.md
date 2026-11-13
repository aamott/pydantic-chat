# Writable editor in the right panel

## Goal

The v1 right panel is read-only by spec. Post-v1: allow editing files the agent surfaced — save writes through the backend (sandboxed), with a diff/merge affordance (`DiffPanel`/`@codemirror/merge` already in-tree).

## Acceptance criteria

- Edit toggle on `FileViewer` — write-back via a new `PUT /api/files` (or similar) endpoint, path strictly confined to the workspace root (mirror `_resolve_workspace_file` checks).
- Dirty-state indication + explicit save (Ctrl/Cmd-S); unsaved-changes guard on file switch.
- Optionally: when the agent's `write_file`/`edit_file` tool touches an open file, offer a merge/diff view rather than clobbering (`DiffPanel`).
- Permissioning: editing stays client-side UX; the agent's own writes remain governed by tool profiles.
- TDD backend (sandboxing, conflict handling); `bun run verify`.

## File references

- `apps/desktop/src/renderer/src/features/editor/{FileViewer,DiffPanel,RightPanel}.tsx`
- `apps/backend/app/api/files.py` — `_resolve_workspace_file`, `_read_file_bytes`
