# P1 — Settings, catalogs & registries

**Status:** spec'd · **Depends on:** P1-persistence · parallel to P1-chat-core

## Goal

The surfaces that configure everything else: global+workspace settings,
model catalogs, tool profiles, and the MCP server registry.

## Architecture decisions

- **Settings resolution (one resolver, both ends):** profile & MCP mask
  resolve chat → workspace → global → built-in default; model/thinking/
  judge resolve chat → global → built-in default (app #1 has **no**
  workspace-level model defaults — adding them is new scope, not
  carry-over). The same resolution feeds backend profile/model selection
  *and* renderer editability gating.
- **Secrets & settings storage (verified split):** `secrets.json`
  (`chmod 600`, userData) holds API keys **only**; all global defaults +
  custom profiles live in the sqlite `settings` KV table in `app.db`. API
  responses mask secrets (`sk-…` shown, never returned); never logged —
  including inside MCP env/header round-trips.
- **Profiles:** built-ins immutable (`bypass`, `smart`, `manual`,
  `read-only`); custom profiles are JSON documents (tool allow/deny lists +
  `Permissions` mode + judge hints) in settings KV — no schema migration
  needed to add one.
- **Settings window:** a **second `BrowserWindow`** (singleton,
  `settings.html`), not an in-app page — with a theme relay IPC so
  dark/light/system applies to both windows (`data-theme` tokens; editor +
  Streamdown consume them).
- **MCP registry:** CRUD for server specs (stdio command+env /
  streamable-http URL+headers); per-workspace enable mask overrides global
  enable; connection status probed lazily, failures degrade to disabled +
  notice, never crash a run.
- **Model catalog UI:** provider → model pickers fed by cached catalog
  fetches (live provider discovery + static fallback list — there is no
  external catalog service); thinking-level picker maps to
  `ModelSettings.thinking` levels the provider supports.
- **Default model:** app #2's default is an OpenAI model (Anthropic is cut)
  — spec `openai:gpt-5.5` pending owner confirmation; every surface falls
  back to it when a saved selection no longer resolves.
- **UI components:** Tailwind + `@base-ui/react` primitives
  (popover/menu/dialog/combobox) — owner-approved, **pending company
  sign-off** tracked in `specs/libraries.md`. Until approval lands, keep
  hand-rolled versions behind the same component boundaries so the swap is
  mechanical; no shadcn.

## Stories

| Story | Acceptance criteria |
|---|---|
| Settings window | Second `BrowserWindow` (singleton — re-show focuses it); theme relay applies dark/light/system to both windows via `data-theme`; settings + theme keys round-trip to backend |
| Settings search + save bar | Searchable section/field registry (per-section keywords, jump-to-field); draft/dirty tracking with Save/Revert bar + "Saved" flash; failed saves surface retryable errors |
| Settings API | Masked-key reads; validated writes; `secrets.json` chmod 600; defaults + custom profiles in sqlite KV; resolution matrix unit-tested on both sides |
| Model pickers | Provider/model/thinking pickers per chat + global default (no workspace level — see resolver note); provider-grouped filterable list; "no providers configured → open settings" empty state; inheritance labels ("Provider ▸ model (default)"); context-window display; stale selections degrade to default with notice |
| Profiles API + UI | Built-ins (`bypass`/`smart`/`manual`/`read-only`) read-only; custom profile CRUD (JSON doc, validated); tool catalog endpoint lists every exposed tool incl. MCP prefixes; skill catalog shows system+workspace |
| MCP registry UI | CRUD for stdio+http specs; env/header secret fields masked; per-workspace enable checkboxes; status indicator (untested/ok/failed) |
| Workspace settings | Per-workspace `permission_profile` + MCP mask only; inheritance shown in UI (override vs inherited); missing-folder badge when the workspace path is gone |
| Pickers/popovers | All pickers keyboard-accessible with focus trap — from `@base-ui/react` if approved, else audited hand-rolled versions (the a11y story from app #1 must not repeat) |

## Non-goals

Chat streaming (P1-chat-core); file viewer (P2).
