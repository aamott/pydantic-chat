# P2 — File viewer (editor-centric right popout)

**Status:** design locked — prototype in app #1 in progress ·
**Depends on:** P1-chat-core

## Goal

The right-panel tool surface redesigned around Monaco: file tabs across the
top, a left-edge drawer for secondary views, no terminal tab. The whole
popout is treated as phone-width — it must work at ~350–400px without
clutter.

## Locked design (owner-reviewed)

```
┌─ chat ─────────────┬─ editor popout (right panel) ─┐
│                    │ drawer │ [f1][f2][f3*][x…]    │
│   transcript       │ ▚▚▚▚▚▚ │──────────────────────│
│   (tool cards show │ view  │                      │
│    live shell out) │ sel + │      Monaco          │
│                    │ panel │      editor          │
│                    │  ◀── slides from left edge    │
└────────────────────┴──────────────────────────────┘
```

- **Editor popout** = the existing right panel slot (chat|tools split stays,
  `react-resizable-panels`, hideable). Inside it is now an editor workbench.
- **File tabs across the top** — multi-buffer. Explorer click opens a
  *preview* tab (italic, single-click); editing or double-click pins it.
  Tabs carry the dirty dot; close guards reuse `fileDirty` logic. Replaces
  app #1's single `openFiles[workspaceId]` ref with a per-workspace tab
  model.
- **Left-edge drawer** inside the popout: a selector at its top chooses the
  panel — **Explorer**, **Diff**, plus room for future views. Behavior is
  mobile-style:
  - popout width < breakpoint (~560px, tune in prototype): drawer overlays
    the editor with scrim, closes on select/esc/outside-tap
  - popout width ≥ breakpoint: drawer pins open beside the editor
  - opened via a rail button on the popout's left edge — the popout must
    be usable at phone width with the drawer closed
- **No terminal view.** `data-shell` events still stream — consumed by the
  chat's tool cards for live per-command output. The prototype already
  shipped this plumbing in the working tree (`collectShellBlocks` →
  `ToolCard` live tail; `TerminalView.tsx` dormant) — app #2 carries the
  tool-card behavior forward and deletes TerminalView entirely.
- **Monaco everywhere text is shown:** `@monaco-editor/react`, bundled
  locally (`loader.config({ monaco })`) — no CDN. `DiffEditor` for the Diff
  panel and save-conflict compare; `diff.ts` + CodeMirror stack deleted.
  Vite wiring: `self.MonacoEnvironment.getWorker` must be set with native
  `?worker` imports (`editor.worker?worker` + language workers as needed —
  no plugin required); `loader.config` must run **before** the first
  `<Editor>` mounts or it silently falls back to jsDelivr; gate the eager
  `monaco-editor` import (~5MB) behind a lazy setup module.
- **View modes per file kind** (same as app #1): text→Monaco;
  `.md`→source/preview toggle (Streamdown); image→`/raw` blob;
  binary→"can't display" + open-in-default-app IPC; `#L<n>` anchor →
  `revealLineInCenter` + decoration.

## Architecture decisions

- **Backend unchanged in shape:** `GET/PUT /api/files` + `if_match`
  versions + `GET …/raw` + `rg` tree — specced in P1 epics; this epic is
  UI + the file API story below.
- **Buffer model:** `Map<path, {model, savedVersion, dirty}>` per
  workspace; Monaco `models` are the buffers — created lazily, disposed on
  tab close. `if_match` echoes `savedVersion`; 409 → conflict banner
  (reload / overwrite / DiffEditor compare).
- **Drawer state:** `ui` store — `drawerOpen`, `drawerView`, plus a
  width-observer on the popout driving overlay↔pinned. Only pinned-state
  persists (partialize); overlay is session-only.
- **Tab model:** `openTabs[workspaceId]: [{path, pinned}]` + `activePath`
  in ui store; preview tab = single unpinned slot reused per selection.
- **Agent-write freshness:** save-time `if_match` 409 only (app #1's
  stand-in) — no fs watch in v1. A `data-*` "file-written" hint from agent
  write tools is a possible follow-up, not specced.
- **a11y:** drawer = dialog semantics when overlaying (focus trap, esc,
  scrim) — from `@base-ui/react` once approved; tabs are a real `tablist`.

## Prototype findings (app #1, uncommitted — feel-test pending)

Built in the working tree via subagent: `PanelDrawer.tsx` (new),
`RightPanel.tsx` rewritten, `ui.ts` → `openTabs`+drawer state (persist v2,
migrates old `openFiles`), TerminalView dormant, `data-shell`→`ToolCard`
plumbed. Typecheck + 239 tests green.

Simplifications to NOT carry into app #2: single FileViewer remounted per
tab (`key={path}`) — only the active tab can be dirty, pinned tabs don't
preserve edits, dirty dot only on active tab; Explorer expansion resets on
drawer close. The real build uses per-tab Monaco `model`s so pinned dirty
buffers actually survive.

Feel-test questions the prototype raised:

- **Toggle asymmetry:** one rail button flips *pinned pref* when wide but
  *session overlay* when narrow — does the narrow-mode button read as
  "open" or "toggle pin"?
- **Overlay + already-open file:** selecting the file that's already open
  leaves the drawer up (it only closes on `filePath` change) — acceptable?
- **Panel close → reopen:** `drawerOpen` is cleared on close — restore the
  overlay on reopen, or always reopen closed? (currently: closed)
- **Dirty preview auto-pin:** pin-on-dirty keeps the tab, but the buffer
  was already discarded — in the real multi-buffer build pinning preserves
  it, so behavior will shift slightly. Confirm the multi-buffer semantics
  feel right once built.

## Stories

| Story | Acceptance criteria |
|---|---|
| Prototype in app #1 | ✅ done — feel-test + the 4 questions above resolve before app #2 builds it |
| Files API | `GET/PUT /api/files` confined to workspace (lexical + realpath); `if_match`→409; `raw` for non-text; `rg` tree w/ gitignore + `os.walk` fallback; secret patterns (write-protect defaults + `denied_patterns` read-denial); 2 MiB cap + kind classification |
| Tabbed editor | Open/preview/pin/close/reorder tabs; dirty dots + close guards; per-workspace tab sets; `#L<n>` deep-link opens + scrolls |
| Monaco integration | Local bundling verified (airplane-mode test); lazy language loading; theme matches app tokens; DiffEditor used for conflicts + Diff panel |
| Drawer | Selector (Explorer/Diff); overlay+scrim < breakpoint, pinned ≥ breakpoint; esc/outside-tap close; keyboard accessible |
| Explorer panel | Tree → preview tab; gitignore-aware; agent-created files appear on refresh |
| Diff panel | Reconstructed from transcript tool/`data-*` parts via `DiffEditor`; live view, empty on reload (same rule as app #1) |
| Delete terminal | TerminalView removed; `data-shell` renders live in chat tool cards; no selector entry |

## Non-goals

Fs watching / live file-change notifications (save-time conflict only);
multi-cursor/LSP/workbench features beyond tabs+diff; terminal emulator.
