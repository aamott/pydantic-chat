# Blueprint — app #2 specification

The deliberate re-spec of `pydantic-chat` for a second repository. Same
architecture, similar scope (~13k LOC), with explicit cuts and approved
library choices. Pending approvals are tracked in `specs/libraries.md`.

**Ship unit for the dev team:** the entire contents of this folder,
including its `AGENTS.md`, copied into the new repository root. Do not ship
the predecessor's root `AGENTS.md` or `plans/` instead. `plans/`, `specs/`,
`inventory/`, and `references/` all travel together; app-#1 code outside
this package is not required.

## Contents

- `AGENTS.md` — root rules file for the new repo
- `plans/app-vision.md` — locked decisions + ordered epic map (start here)
- `plans/P1-*.md`, `P2-*.md` — epics: architecture decisions + ordered
  numbered stories (acceptance criteria inline)
- `plans/open-questions.md` — **every unresolved decision in one place**
- `specs/libraries.md` — approved dependency manifest; incl. the
  pending-external-approval tracker
- `specs/pydantic-ai.md`, `specs/pydantic-ai-harness.md`,
  `specs/vercel-ai-sdk.md` — the exact API surfaces used, verified against
  installed versions (read-only API truth — epics cite, never restate)
- `specs/vendor/` — upstream docs vendored so implementors don't google:
  the pydantic-ai/-harness **skill docs** plus `monaco/` (the only
  dependency with no docs in-repo or in-package). Everything else arrives
  with `uv sync`/`bun install` — specs point at the in-package doc
  locations instead of duplicating them. Refresh vendored files on bumps
- `inventory/current-app.md` — what app #1 actually does; file paths are
  app-#1 provenance, load-bearing code is vendored under `references/`
- `references/` — working implementations + configs copied from the
  predecessor: **examples, not contracts** — for library-interop code
  that's expensive to re-derive. Includes `research/` — verified
  wire-contract notes. See `references/README.md`

## Status

Implementation has not started. Epics and stories are ordered; drawer UX
is locked. Remaining approval and implementation decisions are tracked in
`plans/open-questions.md`.

## How implementation consumes this

1. Copy this folder's contents into the new repo root. Paths such as
   `plans/`, `specs/`, and `references/` then resolve from that root.
2. Start at `plans/app-vision.md`; work epics in order; fan stories into
   `pending-*` files per the planning system.
3. Keep `specs/libraries.md` synchronized with manifests; do not maintain
   a second copy of the dependency manifest.
4. `plans/` defines target behavior; `specs/` defines the library surface
   (check against installed pins as needed). Both outrank `references/`,
   which are examples, not files to port. `inventory/` is the regression
   checklist: every behavior ships or is an explicit cut in app-vision.
