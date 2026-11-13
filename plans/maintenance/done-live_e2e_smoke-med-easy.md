# Live end-to-end smoke of profiles/skills/MCP

## Goal

The last three features (tool profiles, skill store, MCP support) are test-verified but never exercised against a live backend + real run. Smoke them: seed data dir, hit the endpoints, run a FunctionModel turn proving a filtered tool disappears and a skill loads.

## Acceptance criteria

- `GET /api/tool-profiles` returns 4 builtins; POST/PUT/DELETE a custom profile round-trips.
- `GET /api/tool-catalog` includes MCP `{server}_*` rows when a server is enabled.
- `GET /api/skills` returns the seeded `commit-helper` system skill.
- A `build_run_kwargs` (or real agent run) with a restricted profile shows the filtered toolset (no `shell` when excluded).
- Findings reported; bugs found become their own stories.

## File references

- `apps/backend/app/api/profiles.py`, `app/mcp_servers.py`, `agent/factory.py`
