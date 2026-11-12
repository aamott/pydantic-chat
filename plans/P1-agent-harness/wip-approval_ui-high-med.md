# Approval UI

## Goal

Deferred tool approvals round-trip through chat: agent pauses, user approves/denies inline, run resumes.

## Acceptance criteria

- `tool-approval-request` parts render an approve/deny card (tool name, args preview — file diff or command line)
- `addToolApprovalResponse` + `sendAutomaticallyWhen` resubmits; adapter resumes run; approved action executes, denial reaches model as `ToolDenied`
- Pending approvals survive reload/restart (stored via `deferred_tools_json` in ConversationStore)
- Known-bug guard: strip stale `approval-responded` parts before continuation if pinned version is affected by pydantic-ai #5154

## Files
- `features/chat/MessagePart.tsx` (approval card), `stores/chats.ts`, `api/chat.py`

## Depends on
- pending-message_rendering-high-easy.md, pending-permission_profiles-high-med.md
