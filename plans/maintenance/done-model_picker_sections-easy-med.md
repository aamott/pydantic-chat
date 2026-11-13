# Model picker: provider sections + search

## Goal

Make the composer model picker scannable at catalog scale: group rows under
provider section headers, and add an autofocused filter input at the top of
the popover with keyboard-driven highlight + Enter-to-select.

## Acceptance criteria

- Provider header rows (badge + label) render between groups; catalog order
  preserved; per-row provider badge kept.
- Search input at top of popover, autofocused on open; filters models by
  case-insensitive substring across model name + provider label + spec id —
  all whitespace-separated tokens must match. Empty sections hidden.
- Highlight: current model highlighted when unfiltered; typing highlights
  first match; ArrowUp/Down move the highlight (works from the input);
  Enter selects the highlighted row.
- Clear button empties the filter; Escape with a non-empty filter clears it,
  Escape with an empty filter closes the popover.
- Preserved: side flyout on row hover/focus (thinking dropdown +
  `max_context`, 250ms leave grace), Check on current model, row click
  PATCHes `{model, thinking}` via `updateChat`, flyout not blocked by the
  search input.
- `bun run verify` clean; no new deps; tailwind only.

## Files

- `apps/desktop/src/renderer/src/features/chat/ModelPicker.tsx`

## Depends on

- none

## Implementation notes (2026-03-28)

- `features/chat/ModelPicker.tsx` — flat `rows.map` replaced by a `ListItem`
  stream (provider headers interleaved with rows) built from the catalog in
  order; sticky in-list headers carry badge + uppercase label, per-row badge
  kept. Filter input sits above the listbox inside the `Popover` (Search
  icon + X clear button); every whitespace-separated token must
  substring-match name / provider label / spec id, case-insensitive, and
  empty groups drop out.
- Single `highlighted` index is the active row (visual `bg-neutral-100` +
  `aria-activedescendant` on the input): seeded to the current model on
  open / when the filter empties, reset to first match while filtering;
  ArrowUp/Down move it from the input (scrollIntoView + flyout preview) or
  move DOM focus when a row is focused; Enter in the input selects it.
- Escape with a non-empty filter stops propagation (React root delegation
  runs before `Popover`'s document listener) and clears; empty-filter
  Escape falls through to the popover's global close. Flyout closes on any
  query change since its anchor row may have filtered out; row hover/focus
  still opens it (250ms leave grace unchanged).
- `bun run verify` (tsc node + web) clean.
