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

## What landed

- **`UserToolsSection`** (`features/settings/sections/UserToolsSection.tsx`),
  registered as the "User Tools" nav entry after MCP Servers: origin-badged
  rows ('Global' chip vs workspace display name), immediate-PATCH enabled
  toggle, `user_<fn>` list with first-line docstrings, warning rows for
  `error`/`skipped_reason`/`skipped_functions`, two-step inline delete
  confirm, and an Add form (filename stem + origin select).
- **Store** `stores/userTools.ts`: `ensureLoaded(workspaceId)` (scope-aware,
  serialized loads) + refetch-after-write for PATCH/POST/DELETE/source PUT.
- **Workspace resolution** `features/settings/useSectionWorkspace.ts`:
  `activeWorkspaceId ?? workspaces[0]` — the settings window is a separate
  renderer whose chats store never ran `loadWorkspaces` (it mustn't — that
  call can create chats), so it populates read-only via `refreshWorkspaces`
  and falls back to the most-recently-opened workspace (list is
  `last_opened_at DESC`).
- **Cross-window edit relay** `file:open-in-viewer` (new `IpcChannels`
  entry + preload `openFileInViewer`/`onOpenFileInViewer` + main-process
  forwarder + `App.tsx` handler): workspace-tool Edit/Add opens the file
  in the main window's FileViewer, switching workspace first when needed.
  Needed because the settings window's `useUiStore.openFile` is a
  different store instance — calling it directly was a silent no-op.
- **Global-tool editing**: plain `<textarea>` + Save via
  `PUT /api/user-tools/source` — FileViewer's CodeMirror setup is
  component-local and not trivially extractable (accepted v1 trade-off).
- **`ToolProfilesSection`**: `'user'` added to `TOOL_GROUP_ORDER`
  (`TOOL_GROUP_LABELS`/`ToolGroup` already extended by the backend agent),
  and the catalog fetch now passes `?workspace_id=` so workspace user
  tools appear (this also applies the workspace's MCP override mask to
  `{server}_*` rows — the intended semantics per the backend docstring).
- **Shared types**: `UserTool`, `UserToolFunction`,
  `SkippedUserToolFunction`, `UserToolPatch`, `UserToolCreate`,
  `UserToolSource` in `packages/shared/src/index.ts`.
- **Tests**: 9 `UserToolsSection` cases (list render, scoped GET, PATCH
  body, error/skipped rows, delete confirm, Add POST body + relay spy,
  global inline edit PUT, filename validation), 2 `ToolProfilesSection`
  cases (scoped catalog fetch, `user_*` checkbox render + save
  round-trip), 2 `lib/profiles` `user_*` round-trip cases. 240 tests
  total, `bun run verify` green.

### Deviations from the story

- Workspace-tool "open it" uses the new IPC relay rather than a bare
  `useUiStore.getState().openFile()` — required for the cross-window
  reach described above.
- Global-tool editor is a textarea, not CodeMirror (story-permitted
  fallback).
