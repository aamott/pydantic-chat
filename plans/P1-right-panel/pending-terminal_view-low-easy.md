# Terminal view

## Goal

Shell command output is visible, live while streaming.

## Acceptance criteria

- Shell tool activity → `data-shell-*` parts with command + stdout/stderr tail
- Terminal tab: scrollable `<pre>` list of command outputs (live-appended while streaming); click a shell tool card jumps to its output
- Output capped (mirror backend 64k tool cap)

## Depends on
- pending-split_layout-med-easy.md, pending-capability_wiring-high-med.md
