# Diff view

## Goal

Agent file edits render as readable diffs.

## Acceptance criteria

- `write_file`/`edit_file` tool parts carrying old/new text render via `@codemirror/merge` MergeView (or inline diff) in the Diff tab / tool card
- Clicking a diff part opens the target file in viewer

## Depends on
- pending-file_viewer-med-med.md, pending-message_rendering-high-easy.md
