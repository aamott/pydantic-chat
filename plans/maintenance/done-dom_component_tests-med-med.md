# DOM/component test harness for renderer

## Goal

All renderer coverage today is pure-helper vitest (node env) — every component is tsc-only. Add a jsdom + React Testing Library harness and cover the highest-risk interactive components.

## Acceptance criteria

- `vitest` configured for jsdom on `*.test.tsx` (keep node env for `*.test.ts` — per-file override or environmentMatchGlobs); `@testing-library/react` + `@testing-library/dom` + `jsdom` dev deps (pin versions ≥7 days old; run `bun add -d`).
- Coverage for: `ProfilePicker` (opens popover, picks option, inherit row), `ApprovalCard` (approve/deny flows), `ModelPicker` (search filters, Enter selects), `Composer` mention popup (typing `@` → list → Enter inserts) where feasible without a live backend — mock fetch/store hooks per existing store patterns.
- `bun run verify` green including the new tests.

## File references

- `apps/desktop/vitest.config.mts`, `apps/desktop/package.json`
- `apps/desktop/src/renderer/src/features/chat/{ProfilePicker,ApprovalCard,ModelPicker,Composer}.tsx`
- `apps/desktop/src/renderer/src/lib/*.test.ts` — existing conventions
