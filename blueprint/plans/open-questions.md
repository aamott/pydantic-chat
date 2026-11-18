# Open questions

Only unresolved approvals and implementation choices live here. Accepted
behavior belongs in the relevant epic; approved libraries in `specs/libraries.md`.

## External approval

- [ ] **`@base-ui/react`** — company approval pending; version/status tracked
  in `specs/libraries.md`. Until approved, use the fallback boundaries in
  P1-settings-registry; do not add it to manifests.

## Implementation decisions (resolve before the affected story)

- **`@vitejs/plugin-rsc`** — during Foundation, omit unless a concrete
  feature needs it; record the reason if retained.
- **Per-chat cwd continuity** — P1-agent-backend. Upstream persistence is
  per-run; this does not require persistent shell variables/processes.
  If native harness seams cannot support it, escalate rather than replacing
  the shell tool wholesale.
- **Monaco Vite workers** — P2-file-viewer. Choose the wiring during
  implementation; local bundling and offline operation are mandatory.
