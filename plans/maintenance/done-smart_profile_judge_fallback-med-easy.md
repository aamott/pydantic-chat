# Smart profile judge falls back to the run's own model

## Goal

Profile `smart` builds `[Coder, Permissions('auto'), ApprovalReviewer(model)]`
where the judge model is the `judge_model` setting or
`SMART_DEFAULT_JUDGE = 'anthropic:claude-haiku-4-5'`. A user with only a
non-Anthropic provider configured (e.g. a Google key only) gets
`ProviderNotConfigured` resolving the default judge → reviewer is `None` →
`smart` silently falls back to `manual` and every shell command still asks.
The judge should default to a model that is actually configured, in this
priority order:

1. `judge_model` setting (explicit user choice — highest, unchanged).
2. The run's own resolved model — configured by definition; judging with it is
   fine for v1. `build_run_kwargs` already resolves the run model; pass that
   resolved `Model` as `judge_model` to `resolve_permission_capabilities`
   when no explicit `judge_model` is set.
3. `SMART_DEFAULT_JUDGE` — last-resort fallback for callers with no run model
   (direct `resolve_permission_capabilities` calls); keep the current
   manual-fallback warning when even it can't resolve.

## Acceptance criteria

- `resolve_permission_capabilities('smart', judge_model=<Model instance>)`
  returns `[Coder, Permissions('auto'), ApprovalReviewer]` — not the manual
  `[Coder, Permissions('read-only')]` pair.
- `build_run_kwargs` with `permission_profile='smart'`, no `judge_model`
  setting, and a run model whose provider IS configured (while `anthropic`
  is not) yields capabilities containing an `ApprovalReviewer` whose model
  is the run's own resolved model, and `Permissions('auto')` — not the
  manual fallback. This is the reported bug (Google-key-only user).
- An explicit `judge_model` setting still wins over the run model.
- PATCH `permission_profile` on a chat mid-conversation → the NEXT
  `POST /api/chat` builds the new profile's capabilities (regression test
  proving `_run_settings` reads the chat row per request).
- `uv run pytest -q` green; `uv run ruff check app tests` clean.

## Files

- `apps/backend/app/agent/factory.py` (`build_run_kwargs`, docstrings)
- `apps/backend/tests/test_agent.py` (judge priority tests)
- `apps/backend/tests/test_chat.py` (mid-chat profile switch regression)

## Depends on

- none

## Implementation notes (2026-07-01)

- Fix is one line of plumbing in `build_run_kwargs` (`factory.py`): the run
  model is now resolved once up front (`model = resolve_model(model_spec)`)
  and `judge_model = _setting(chat_settings, "judge_model") or model` feeds
  `resolve_permission_capabilities` — so the reviewer shares the run's own
  resolved `Model` instance when no judge is configured. `_approval_reviewer`
  already accepted `str | Model | None`; only docstrings changed there and on
  `SMART_DEFAULT_JUDGE` (now documented as the last-resort spec for direct
  callers, e.g. `resolve_permission_capabilities('smart')` with no run
  model — `test_smart_profile_falls_back_to_manual_without_judge` still pins
  the manual fallback for that edge case).
- A broken *explicit* `judge_model` still degrades to `manual` with the same
  warning rather than silently judging with the chat model — the user's
  explicit choice failing is a config error worth surfacing.
- Judge priority order (resolved): `judge_model` setting → run's own resolved
  model → `SMART_DEFAULT_JUDGE` → manual fallback.
- PATCH mid-chat switch needed no code change: `_run_settings` reads
  `chat.permission_profile` off the row on every `POST /api/chat`. Proven by
  `test_mid_chat_profile_switch_changes_next_run_capabilities`, which spies
  on `app.api.chat.build_run_kwargs` and asserts the real capability list
  (manual pair on run 1 → `Permissions('auto')` + `ApprovalReviewer` on run
  2), not the `data-run-meta` label.
- Tests added: `test_smart_profile_uses_given_judge_model`,
  `test_build_run_kwargs_smart_defaults_judge_to_run_model` (the reported
  Google-key-only bug — failed pre-fix),
  `test_build_run_kwargs_explicit_judge_model_wins`, and the chat-level
  mid-conversation switch test (also failed pre-fix).
- `uv run pytest -q`: 118 passed. `ruff check app tests`: clean.
- `api/chat.py`, `api/settings.py`, `schemas.py`: no changes required —
  `_run_settings` already forwards `judge_model` from the KV table and reads
  the chat profile per request.
