# Blueprint — app #2 specification

The deliberate re-spec of `pydantic-chat` for a second repository.
Same architecture, same scope (~13k LOC), better-organized plans, and every
library accounted for.

## Contents

- `plans/app-vision.md` — locked decisions + epic map (the spec starts here)
- `plans/P1-*.md`, `P2-*.md` — epics with architecture decisions + story
  tables (acceptance criteria inline)
- `specs/libraries.md` — approved dependency manifest; ⚠ marks items needing
  owner confirmation
- `specs/pydantic-ai.md`, `specs/pydantic-ai-harness.md`,
  `specs/vercel-ai-sdk.md` — the exact API surfaces used, verified against
  installed versions
- `specs/vendor/` — upstream skill/reference docs vendored from the
  installed packages (they ship with the libs; refresh on version bumps)
- `inventory/current-app.md` — what app #1 actually does, incl. coupling
  that must survive the rebuild

## Status

- ✅ Specs, inventory, and all epics: written
- ✅ Three-way review pass applied (subagent-verified): every API claim
  checked against installed source, every behavior checked against app
  code, all 33 version pins checked against npm/PyPI — all current
- ✅ File viewer design locked + layout prototyped in app #1 (uncommitted)
- ✅ `electron-vite@6.0.0`, `pyrefly` hard gate: approved
- ⏳ `@base-ui/react@1.9.0` — owner-approved pending company sign-off;
  tracked in `specs/libraries.md` → "Pending external approval"
- ⚠ Default model for app #2 (Anthropic cut → needs an OpenAI default;
  `openai:gpt-5.5` specced pending confirmation)
- ⚠ `@vitejs/plugin-rsc` — confirm actually needed during scaffold; drop if not
- ⚠ Per-chat shell — owner decision recorded; mechanism is new work
  (upstream has per-run toolsets only), spec'd in P1-agent-backend

## How implementation consumes this

1. Copy `plans/` into the new repo; fan story tables into `pending-*` story
   files per the planning system.
2. Seed `docs/libraries.md` from `specs/libraries.md`; keep it in sync with
   manifests forever after.
3. Keep `specs/` as the API reference — verify pinned versions first
   (⚠ notes), then treat the documented signatures as the contract.
4. `inventory/` is the regression checklist: every behavior listed there
   either ships in app #2 or is an explicit cut.
