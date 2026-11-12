# P1-agent-harness

## Goal

A real coding agent: scoped file tools, rg search, shell, planning, permission profiles with approval round-trips, multi-provider models.

## Scope

- Shared `Agent`; per-run params: `model`, `capabilities=[LocalWorkspace(root), Coder(), Planning(), Permissions(mode)]`, `usage_limits` — resolved from chat/workspace settings
- Provider registry: `provider:model` strings → Anthropic/OpenAI/Google/Ollama model instances with keys from settings file + env
- Permission profiles: `bypass` / `smart` (LLM command-safety eval — verify exact harness API at impl time) / `manual` / `read-only`; allow & deny lists checked before any approval path; per-workspace override + global default
- Approval UX: `tool-approval-request` parts → approve/deny in chat → `addToolApprovalResponse` → auto-resubmit; denials render as denied
- `Planning` events mirrored to UI via `data-*` parts (plan/todo card)
- Shell tools incl. `start_command`/`check_command`/`stop_command` for dev servers

## Architecture decisions

- Wire-level deferred tools (not in-process approvers) — resume state lives in ConversationStore; fits HTTP cleanly
- `LocalWorkspace` containment is not a sandbox — `shell` runs as the user; `Permissions` + lists are the gate
- Pin `pydantic-ai-harness` (0.x, moving fast); verify `SqliteConversationStore` isn't already shipped before hand-rolling; watch issue #5154 (stale approval parts on continuation)

Depends on: P1-app-scaffold, P1-chat-core

## Status

- ⬜ Capability wiring + LocalWorkspace scoping
- ⬜ Provider registry (4 providers)
- ⬜ Permission profiles + allow/deny lists
- ⬜ Approval UI round-trip
- ⬜ Plan progress surface
