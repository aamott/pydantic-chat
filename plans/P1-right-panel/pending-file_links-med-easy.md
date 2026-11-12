# File links

## Goal

Any file reference in chat opens the right panel at the right line.

## Acceptance criteria

- Streamdown `<a>` override intercepts `file:`-scheme links (`[x.ts](file:///abs/path#L12)`) → `ui.openFile(path, line)`
- Tool cards (read/edit/write results) link their touched paths the same way
- Agent instructed to emit `file:` links for workspace paths (system-prompt guidance); relative workspace paths resolve against the chat's workspace root
- Panel opens + correct tab/file/line on click

## Depends on
- pending-file_viewer-med-med.md, pending-message_rendering-high-easy.md
