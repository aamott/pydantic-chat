# P1 — Settings, catalogs & registries

**Status:** todo · **Order:** 5th · **Depends on:** P1-persistence
(∥ P1-chat-core)

## Goal

The surfaces that configure everything else: settings window, model
catalogs, tool profiles, and the MCP server registry.

## Architecture decisions

- **Resolution:** profile = chat → workspace → global → built-in default;
  MCP = workspace mask over the global registry; model/thinking = chat →
  global → built-in default. Judge follows P1-agent-backend, including errors
  for an invalid explicit judge. Backend and renderer use the same profile
  rules for tool permissions and editor gating.
- **Secrets/settings storage:** restricted `secrets.json` (provider keys +
  MCP env/header credentials) + sqlite KV (non-secret config and defaults).
  Reads expose configured/masked state only. Writes preserve omitted secret
  fields, replace explicit values, and clear explicit `null`; masked display
  placeholders are never saved as credentials.
- **Profiles:** built-ins immutable — `bypass`/`smart`/`manual`/`read-only`;
  custom = validated JSON docs (allow/deny + mode + judge hints) in KV.
- **Settings = second `BrowserWindow`** (singleton, `settings.html`), with
  theme relay → both windows (`data-theme`; dark/light/system).
- **MCP registry:** CRUD for stdio+http specs; per-workspace mask;
  lazy status probe — failures degrade to disabled + notice, never crash.
- **Model catalog:** live provider discovery + static fallback (no external
  service); thinking picker maps to `ModelSettings.thinking` levels the
  provider supports.
- **Default model:** `openai:gpt-5.6-luna` (owner-confirmed — Anthropic is
  cut); stale ordinary model selections fall back to it with a notice.
  Missing provider credentials prompt setup; invalid explicit judges never
  silently fall back.
- **UI components:** Tailwind + `@base-ui/react` (pending company sign-off —
  `specs/libraries.md`). Until then: hand-rolled behind identical component
  boundaries so the swap is mechanical. No shadcn.

## Stories (in order)

1. **Settings window integration** — reuse Foundation's singleton window
   and theme relay; theme key round-trips through persisted settings.
2. **Settings search + save bar** — searchable section/field registry with
   jump-to-field; draft/dirty + Save/Revert bar + "Saved" flash; failed
   saves retryable.
3. **Settings API** — masked-key reads; validated writes; secrets.json +
   KV; resolution matrix unit-tested on both sides.
4. **Model pickers** — provider-grouped filterable picker per chat + global
   default; "no providers → open settings" empty state; inheritance labels;
   context-window display; thinking side-flyout; stale → default + notice.
5. **Profiles UI** — built-ins read-only; custom profile CRUD; tool catalog
   lists every exposed tool incl. MCP prefixes; skill catalog shows
   system+workspace.
6. **MCP registry UI** — stdio+http CRUD; masked secret fields;
   per-workspace enable mask; status indicator (untested/ok/failed).
7. **Workspace settings** — `permission_profile` + MCP mask only;
   override-vs-inherited shown; missing-folder badge.
8. **Pickers/popovers a11y** — keyboard + focus trap everywhere;
   `@base-ui/react` if approved, else audited hand-rolled (app #1's a11y
   story must not repeat).
