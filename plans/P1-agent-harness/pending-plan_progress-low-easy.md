# Plan progress surface

## Goal

The agent's `Planning` todo list is visible in the UI as it updates.

## Acceptance criteria

- `Planning()` event emitter → custom events → `data-plan-*` parts in the stream
- Plan card renderer in message list shows tasks/status; optionally `SqlitePlanStore` for reload persistence
- Works while streaming; static snapshot renders from stored message parts after reload

## Depends on
- pending-capability_wiring-high-med.md, pending-message_rendering-high-easy.md
