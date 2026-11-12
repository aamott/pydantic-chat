# Permission profiles

## Goal

Four permission profiles — bypass / smart / manual / read-only — composed from built-in harness capabilities; allow/deny lists handled natively.

## Verified APIs (harness 0.68.0)

- `pydantic_ai_harness.permissions.Permissions(mode, ask_commands=?)` — modes `'full'` (bypass), `'auto'` (file writes run; commands run unless the built-in risky-command analyzer flags them — splits compound commands, conservative parse on subshells/`$()`/redirects/globs, read-only safelist; adapted from Codex CLI), `'read-only'` (asks on writes AND commands). Held calls → `ApprovalRequired` → deferred flow.
- `pydantic_ai_harness.approval_reviewer.ApprovalReviewer(model, <risk question>)` — second model judges calls AWAITING approval; `no` auto-approves, else goes to human → this IS the "smart" profile.
- `pydantic_ai_harness.tool_call_judge.ToolCallJudge` — model judges pre-execution; `yes` blocks (harsher; use if "smart" should auto-deny too).
- Lists are built-in: `Shell(allowed_commands=[...] | denied_commands=[...])` (mutually exclusive; deny defaults to destructive list — Coder overrides to `[]`), `denied_operators`, `denied_env_patterns` (Coder already strips `LLM_API_KEY_ENV_PATTERNS`); `FileSystem(allowed/denied/protected_patterns)` for paths.

## Acceptance criteria

- Profile resolution per run: `bypass` → `Permissions('full')`; `smart` → `Permissions('auto')` + `ApprovalReviewer(judge_model)`; `manual` → `Permissions('auto')` (or read-only-style asks); `read-only` → `Permissions('read-only')` AND FileSystem `read_only` + no shell tools
- User allow/deny lists passed into `Shell`/`FileSystem` constructor args; deny wins (build denylist on top of Coder's default empty list — DO NOT silently widen)
- `smart` judge model configurable (default cheapest provider model, e.g. haiku-class); falls back to `manual` if no judge model key configured
- Effective profile shown in chat UI header; per-workspace override + global default via settings
- Tests: denied command refused pre-approval; allowed command runs under manual without prompting; smart auto-approves `ls` but asks human for `rm -rf` when judge says unsure

## Files
- `apps/backend/app/agent/permissions.py`, `app/config.py`

## Depends on
- pending-capability_wiring-high-med.md, pending-provider_registry-high-med.md (judge model)
