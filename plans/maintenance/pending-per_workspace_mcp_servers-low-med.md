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
