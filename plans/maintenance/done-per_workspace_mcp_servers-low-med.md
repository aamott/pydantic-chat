# Per-workspace MCP servers

## Goal

MCP servers are global-only today. Add a workspace-level override following the permission-profile pattern: workspace config wins over global (inherit when unset).

## Acceptance criteria

- Workspace model gains `mcp_servers` config (enable/disable per server, or workspace-added servers — pick the simpler consistent design; document).
- `build_run_kwargs`/`build_mcp_capabilities` resolves effective servers workspace→global.
- Settings/sidebar UI to edit the workspace override (follow `ProfilePicker` inherit chain UX).
- TDD backend resolution tests; `bun run verify` for any UI work.

## File references

- `apps/backend/app/mcp_servers.py` — load/save + capability building
- `apps/backend/app/agent/factory.py` — `build_run_kwargs`
- `docs/research/tool-profiles-and-skills.md` §5 — inherit-chain pattern

## Decisions (recorded during implementation)

_Status: done — backend 215 tests green, `bun run verify` green._

- **Override model: (a) per-workspace mask over the global registry.** One
  server list lives in `settings['mcp_servers']`; a workspace carries only a
  name→bool `mcp_overrides` map. `mask[name]` *replaces* the spec's global
  `enabled` flag for that workspace's runs (`true` may re-enable a
  globally-disabled server); `NULL`/`{}` inherits; mask entries naming
  unknown servers are stale (deleted/renamed) and ignored with a warning.
  Picked over (b) workspace-defined servers because it matches the
  `permission_profile` workspace→global inherit pattern, keeps the
  `{server}_` tool-prefix story unambiguous, and needs no transport/secrets
  duplication.
- **Schema:** `workspaces.mcp_overrides TEXT` (JSON `{"name": bool}`),
  migration 4 — the `permission_profile` TEXT column pattern, JSON-encoded.
- **UI placement:** workspace sidebar header hover actions gain a plug
  icon opening a popover *below* the header (`Popover` gains a `side` prop)
  with one checkbox per global server plus a "Reset to global" row. There
  is no workspace-settings surface today (the workspace `permission_profile`
  column is API-only; `ProfilePicker` only sets the chat layer), so the
  header popover is the smallest coherent home — the permitted fallback in
  the task brief.
