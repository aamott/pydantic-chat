# P2 — File viewer (editor-centric right popout)

**Status:** todo · **Order:** 6th · **Depends on:** P1-chat-core

## Goal

The right-panel tool surface: file tabs on top, a left-edge drawer for
secondary views, no terminal tab. The popout is phone-width — it must work
at ~350–400px without clutter. The design below is the contract; the
app-#1 layout prototype does not ship.

## Locked design

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

- **Editor popout** = the right panel slot (chat|tools split stays,
  `react-resizable-panels`, hideable); inside it is an editor workbench.
- **File tabs across the top** — multi-buffer, per workspace. Explorer
  click opens a *preview* tab (italic, one unpinned slot reused per pick);
  editing or double-click pins. Dirty dot + close guards on every
  buffer-dropping path.
- **Left-edge drawer** inside the popout: a selector at its top chooses the
  panel — Explorer, Diff, room for more. Behavior:
  - popout width < breakpoint (~560px): rail toggles overlay open/closed;
    any file selection (even the already-open file), Esc, or outside-tap closes it
  - ≥ breakpoint: rail toggles the persisted pin beside the editor
  - reopening the editor panel starts with the overlay closed; narrow-mode
    toggles do not change the persisted wide-mode pin
- **No terminal view** — `data-shell` streams live inside the chat's shell
  tool card (per-call, 64k cap); no dedicated view.
- **Monaco everywhere text is shown** (`specs/libraries.md` for the
  approved stack): `DiffEditor` for the Diff panel + save-conflict compare.
- **View modes per kind:** text→Monaco; `.md`→source/preview toggle
  (Streamdown); image→`/raw` blob; binary→"can't display" +
  open-in-default-app IPC; `#L<n>` → `revealLineInCenter` + decoration.

## Architecture decisions

- **Files API** (ported contract): `GET/PUT /api/files` confined to the
  workspace (lexical + realpath); `if_match` version → 409; `/raw` for
  non-text; secret patterns (write-protect defaults + `denied_patterns`
  read-denial); 2 MiB cap + kind classification.
- **Explorer is lazy-loaded:** root fetch = one level; expand fetches that
  dir via `GET /api/files/tree?workspace_id&path=<dir>&depth=<n>`
  (`path` omitted = whole tree, depth 3 — unchanged; `path` present =
  scoped, depth default 1, `root` = the dir node).
  - Scoped `rg` = `rg --files` with **cwd = the dir** (keeps ancestor
    `.gitignore` rules, scope-relative output). Fallback traversal must
    preserve ignore rules, denied patterns, and realpath confinement; otherwise
    return an explicit discovery error, not an unfiltered tree.
  - **Frontier dirs:** scoped responses emit ancestor dirs of deeper files
    as `type:"dir", children:[]` — a strict depth-1 prune would hide
    subdirs (rg reports no empty dirs). Clients treat empty `children` on
    a dir as "not yet fetched", never "empty".
  - Errors: 403 on `..`/absolute/protected escapes, 404 missing, 400
    file-as-dir.
  - Client cache: session-only `Map` per dir; collapse keeps cache;
    errored dirs retry on next expand; refresh clears + re-fetches root +
    expanded dirs.
- **Buffer model:** per-workspace tab model in `ui` store —
  `openTabs[{path, pinned, line}]` + `activePath`; Monaco `model`s are the
  buffers (lazy create, dispose on close); `savedVersion` echoes as
  `if_match`; 409 → conflict banner (reload / overwrite / DiffEditor
  compare). Effective `read-only` profile disables editing; the backend
  enforces the same rule on PUT, not just the UI.
- **Drawer state:** `ui` store — `drawerView`, `drawerOpen` (session),
  `drawerPinned` (persisted); a width-observer on the popout drives
  overlay↔pinned.
- **Agent-write freshness:** save-time `if_match` 409 only — no fs watch
  in v1.
- **Monaco+Vite wiring:** `loader.config({ monaco })` before first
  `<Editor>` mounts (else silent CDN fallback); `self.MonacoEnvironment.
  getWorker` via `?worker` imports (`editor.worker` + language workers as
  needed); eager `monaco-editor` import (~5MB) gated behind a lazy setup
  module.
- **a11y:** overlay drawer = dialog semantics (focus trap, Esc, scrim) —
  `@base-ui/react` once approved; tabs are a real `tablist`.

## Stories (in order)

1. **Files API** — read/write/`raw`/tree per the contract above, incl.
   scoped `path` + frontier dirs + confinement errors. Test symlink/parent
   swaps and concurrent writes; reuse workspace protections where applicable,
   without assuming a separate realpath check makes later I/O race-safe.
2. **Tabbed editor shell** — open/preview/pin/close/reorder; dirty dots +
   guards; per-workspace tab sets; `#L<n>` deep-link.
3. **Monaco integration** — local bundling verified (airplane-mode test);
   workers wired; lazy setup gate; theme matches app tokens; `DiffEditor`
   for conflicts + Diff panel.
4. **Drawer** — selector (Explorer/Diff); overlay+scrim < breakpoint vs
   pinned ≥ breakpoint; Esc/outside-tap close; keyboard accessible.
5. **Explorer panel** — lazy tree per contract; file → preview tab;
   refresh re-fetches expanded dirs; agent-created files appear.
6. **Diff panel** — reconstructed from transcript tool/`data-*` parts via
   `DiffEditor`; live view, empty on reload.
7. **Shell-card integration check** — reuse Chat Core's live shell-output
   cards; the workbench adds no terminal view.


