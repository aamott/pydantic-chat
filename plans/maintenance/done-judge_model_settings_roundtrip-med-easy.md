# judge_model settings round-trip poisons the smart profile

## Goal

`GET /api/settings` echoes `judge_model` as `SMART_DEFAULT_JUDGE`
(`anthropic:claude-haiku-4-5`) even when the user never set it. The settings
form writes every field back on save, so the display-default gets persisted
as an *explicit* setting. On the next `smart` run `build_run_kwargs` resolves
that anthropic spec; a user with no anthropic key gets
`ProviderNotConfigured` → reviewer `None` → `smart` silently degrades to
`manual` and every write/command still asks (confirmed in a live DB +
backend log: "Judge model unavailable... falling back to manual").

Two fixes:

1. **Nullable judge_model, no display-default echo.** `SettingsOut.judge_model`
   becomes `str | None`; `GET` returns the stored row verbatim (`None` when
   unset). Clearing the field in the form (submitting `null` or `""`) must
   actually remove/falsy the stored row so the explicit value clears.
   `SMART_DEFAULT_JUDGE` stays as `resolve_permission_capabilities`'s
   last-resort spec for direct callers with no run model.
2. **Unresolvable explicit judge degrades to the run model, not `manual`.**
   When a `judge_model` spec is set but can't resolve (any resolution
   error), warn and fall back to the run's own resolved model — already in
   hand inside `build_run_kwargs`. `manual` stays the last resort only.

## Acceptance criteria

- `build_run_kwargs` with `permission_profile='smart'`, an explicit
  `judge_model='anthropic:claude-haiku-4-5'`, NO anthropic key, and a
  resolvable non-anthropic run model yields an `ApprovalReviewer` judging
  with the run's own model plus `Permissions('auto')` — not the manual
  `[Coder, Permissions('read-only')]` pair.
- `GET /api/settings` with no `judge_model` row returns `judge_model: null`
  (not the anthropic spec).
- PUT `{"judge_model": null}` or `{"judge_model": ""}` clears the value:
  subsequent GET returns `null` and the stored row is falsy.
- An explicit *working* `judge_model` still wins over the run model
  (existing pin).
- Judge priority order (resolved): `judge_model` setting → run's own
  resolved model → `SMART_DEFAULT_JUDGE` → `manual` fallback.
- Settings form: judge input shows a clear placeholder when empty
  ("Auto — uses the chat's model"); typing still sets the value.
- `uv run pytest -q` green; `uv run ruff check app tests` clean;
  `bun run verify` in apps/desktop green.

## Files

- `apps/backend/app/agent/factory.py` (`_approval_reviewer`,
  `resolve_permission_capabilities`, `build_run_kwargs`)
- `apps/backend/app/api/settings.py` (`_settings_out`, `_apply_setting`)
- `apps/backend/app/api/schemas.py` (`SettingsOut.judge_model`)
- `packages/shared/src/index.ts` (`AppSettings.judge_model`)
- `apps/desktop/src/renderer/src/features/settings/sections/ModelSection.tsx`
- `apps/backend/tests/test_agent.py`, `apps/backend/tests/test_settings.py`

## Depends on

- none

## Implementation notes

### Which tests failed pre-fix

- `test_agent.py::test_build_run_kwargs_broken_explicit_judge_falls_back_to_run_model`
  (new) — explicit `judge_model='anthropic:claude-haiku-4-5'`, no anthropic
  key, Google run model → no `ApprovalReviewer`, `Permissions('read-only')`
  (manual) instead of `auto`.
- `test_settings.py::test_settings_defaults` (updated) — GET echoed
  `anthropic:claude-haiku-4-5` for an unset `judge_model`.
- `test_settings.py::test_judge_model_unset_round_trip_and_clear` (new) —
  same echo; `{"judge_model": ""}` would also have 400'd as an invalid spec.

### Fallback order now

`judge_model` setting (Model or resolvable spec) → run's own resolved model
(`fallback_model`, passed by `build_run_kwargs`) → `SMART_DEFAULT_JUDGE`
(direct `resolve_permission_capabilities` callers with no run model) →
`manual` fallback with a warning. Every skipped candidate logs a warning;
`ProviderNotConfigured` *and* `UnknownProviderError` both degrade rather than
crash. `build_run_kwargs` no longer folds `or model` into `judge_model` — it
passes the raw setting plus `fallback_model=model` so the chain lives in one
place (`_approval_reviewer`).

### Settings round-trip semantics

- GET: `judge_model` returns the stored row verbatim — `None` when unset or
  empty (`raw.get(...) or None`); no display-default echo.
- PUT/PATCH: `null` deletes the row (existing semantics); `""` or
  whitespace-only also deletes it — the form's way of clearing an optional
  field. A non-empty value still validates as a `provider:model` spec.
- `SettingsOut.judge_model` is `str | None`; shared `AppSettings.judge_model`
  is `string | null`.

### UI

- `ModelSection.tsx` judge input: `value={settings.judge_model ?? ''}`,
  placeholder `Auto — uses the chat's model`, hint extended with "Empty
  judges with the chat's model." Clearing the field PUTs `""` → row deleted →
  next GET returns `null` → empty field again.
- `SMART_DEFAULT_JUDGE` remains exported from `factory.py` (test_chat.py
  imports it); `settings.py` no longer imports it.

### Verification

- `uv run pytest -q`: 120 passed. `uv run ruff check app tests`: clean.
- `bun run verify` (apps/desktop): tsc (node + web) + vitest 32/32 green.
