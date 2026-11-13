# SonarQube findings sweep

## Goal

Clear the current SonarQube findings batch: three renderer a11y issues,
one super-linear regex, and two unsafe-PATH findings in the sidecar
supervisor.

## Acceptance criteria

- `ModelPicker` listbox is programmatically focusable (`tabIndex={-1}`) —
  keyboard nav stays on the search input via `aria-activedescendant`.
- `ApprovalCard` deny-reason input and `ChatList` rename input keep their
  focus-on-mount UX without the `autoFocus` attribute (ref + effect).
- `PermissionsSection` profile `<label>` satisfies
  `label-has-associated-control` — visible name text reachable by AT
  (expression moved to label depth ≤ 2, same layout).
- `basename` for workspace display names lives in
  `renderer/src/lib/paths.ts`, regex-free (no S8786), covered by
  `paths.test.ts`.
- `sidecar.ts` children never inherit the ambient PATH wholesale:
  `buildChildEnv` substitutes a fixed allowlist (system dirs + well-known
  `uv` install locations + the dir ambient PATH would resolve `uv` from),
  and `taskkill` is invoked by absolute `%SystemRoot%\System32` path.
  Cross-platform separators honored (`path.delimiter`).
- `bun run --cwd apps/desktop verify` green.

## Implementation notes

### S4036 PATH reasoning

The two flagged sites share one fix point: `spawn('uv', …)` reads PATH from
`buildChildEnv` (line ~229), and `execFile('taskkill', …)` (line ~98)
resolved the binary through the ambient PATH.

- `buildChildEnv` now replaces `env.PATH` with `sanitizedPath()` — a fixed
  allowlist of system dirs (`/usr/local/bin`, `/usr/bin`, `/bin`,
  `/usr/sbin`, `/sbin` on POSIX; `%SystemRoot%\System32` + siblings on
  win32) plus the well-known `uv` install roots (`~/.local/bin`,
  `~/.cargo/bin`, Homebrew prefixes, `%LOCALAPPDATA%\Programs` on win32).
- To avoid breaking nonstandard `uv` installs (the risk called out in the
  finding triage), the ambient PATH is consulted exactly once to locate
  the directory that would supply `uv`, and that single directory is
  appended to the allowlist. Rationale: we execute that binary either
  way — this preserves launch on exotic layouts (nix, pipx shims, custom
  prefixes) while still excluding every *other* user-writable PATH entry.
  The lookup only grants a directory, so a shadowed-but-present `uv` in a
  writable dir still loses to a system `uv` earlier in the list.
- `taskkill` is invoked by its absolute `%SystemRoot%\System32` path, so
  the Windows tree-kill path no longer performs a PATH lookup at all.
- `uv run`'s own needs are unaffected: it uses the project `.venv` and its
  own managed-Python discovery, not the child PATH.

Marking these "accepted" in SonarQube is defensible too — the app
deliberately executes developer-installed tooling — but the allowlist fix
costs little and removes a real (if low) privilege-shadowing surface.
