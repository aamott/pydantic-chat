# Migrate remaining settings files to semantic theme classes

## Goal

`index.css` now defines `.text-strong`, `.text-muted`, `.border-accent`, `.bg-accent-soft`, `.border-subtle`, `.hover-bg-subtle` — one class per light/dark pair. The other ~5 settings files still use `base + dark:` same-property pairs flagged by the Tailwind lint. Migrate them (add new semantic classes where a pair has no existing equivalent).

## Acceptance criteria

- Every `dark:` same-property pair in `apps/desktop/src/renderer/src/features/settings/**` resolves to a semantic class or a non-conflicting structure.
- No visual regressions (identical colors both themes); `bun run verify` green.
- Extend the semantic set only where needed; keep names consistent.

## File references

- `apps/desktop/src/renderer/src/styles/index.css` — semantic classes + `dark` custom variant
- `apps/desktop/src/renderer/src/features/settings/**` — grep `dark:` for sites
