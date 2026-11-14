# User-defined tools — frontend

## Goal

A "Tools" settings section where users manage their own Python tools
(global + workspace), plus the "user" tool group in profile tool pickers.
Depends on `wip-user_tools_backend-med-hard.md` for the API contract
(`/api/user-tools`, `/api/user-tools/source`, `group="user"` catalog rows).

Research: `docs/research/user-tools-integration-map.md` §5–6 (storage +
frontend surfaces).

## UI shape

- New `UserToolsSection` in settings registry (`features/settings/registry.ts`
  — mirror `McpServersSection`): table/list of discovered tools showing
  name, origin badge (Global / workspace name), enabled toggle, per-file
  function list with docstrings, error/skipped state, delete button.
- "Add tool" flow: name input + origin choice (Global / current workspace)
  → `POST /api/user-tools` creates the file with a commented template →
  immediately open it for editing.
- Editing: workspace tools open in the existing FileViewer (`openFile` the
  `.devin/tools/<file>.py` path — note the file tree hides dotdirs so a
  direct link from the section is the navigation path). Global tools edit
  inline via `GET`/`PUT /api/user-tools/source` in a simple textarea or
  CodeMirror (check if a lightweight shared CM editor exists to reuse —
  FileViewer's `buildEditor` internals are component-local).
- `ToolProfilesSection`: add `"user"` to `TOOL_GROUP_ORDER` +
  `TOOL_GROUP_LABELS` (`lib/profiles.ts`), `ToolGroup` union in
  `packages/shared/src/index.ts`. Checkbox grid renders automatically.
- Skipped/error tools render a warning row with the parse/exec error so the
  user knows why a file isn't live.

## Notes

- `.devin/tools/*.py` editable via FileViewer but invisible in the file
  explorer (dotdirs skipped) — the section's "Edit" affordance is the
  entry point; don't build a custom tree.
- `PUT /api/files` can't create files — tool creation goes through
  `POST /api/user-tools`, edits through `/api/user-tools/source` (global)
  or the normal file PUT (workspace, since the file exists).
- Persist: enable flags come from the `user_tools` registry — toggles are
  immediate writes (`PATCH /api/user-tools`), same pattern as MCP servers,
  not the AppSettings draft.
- Store: extend `stores/profiles.ts` or a small dedicated store —
  `ensureLoaded` + refetch-after-write like MCP.

## Tests

- `UserToolsSection` component tests (jsdom): list render, enable toggle
  PATCH body, error row display, delete confirm.
- `ToolProfilesSection` user-group checkboxes round-trip through
  `encodeToolSelection`/`checkedFromProfile` (`user_*` prefix entries).
- `bun run verify` green.
