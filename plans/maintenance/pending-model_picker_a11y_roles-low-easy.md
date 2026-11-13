# ModelPicker ARIA roles → native elements

## Goal

`ModelPicker.tsx` still uses `role="listbox"`/`role="option"` (grandfathered). Prefer-native-elements flags these — refactor onto native buttons like `ProfilePicker`/`MentionList` did (`aria-current` for the selected row, `aria-activedescendant` pattern where keyboard nav lives elsewhere).

## Acceptance criteria

- No abstract ARIA roles where a native element suffices; keyboard nav (arrows/Enter/Escape) + `aria-activedescendant` semantics preserved.
- Side flyout still drives from the highlight.
- `bun run verify` green; IDE lint clean for the file.

## File references

- `apps/desktop/src/renderer/src/features/chat/ModelPicker.tsx`
- `apps/desktop/src/renderer/src/features/chat/{ProfilePicker,MentionList}.tsx` — post-refactor pattern
