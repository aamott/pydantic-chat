# Dynamic OpenAI + Anthropic model catalogs

## Goal

Google already lists models live (`google_model_catalog` → `GET v1beta/models`); OpenAI and Anthropic stay static. Give both the same treatment: `GET /v1/models` (OpenAI: `Authorization: Bearer <key>`; Anthropic: `x-api-key` + `anthropic-version`), merge with curated static entries for display names/thinking levels, fall back to static on any error.

## Acceptance criteria

- `openai_model_catalog()` + `anthropic_model_catalog()` in `agent/models.py` mirroring the Google implementation — live rows when a key is configured, static entries merged/deduped by spec id, non-fatal fallback (no key / non-200 / malformed / timeout).
- Only chat-capable models listed (filter per each API's model metadata — verify response shapes; document assumptions).
- TDD mirroring `test_models.py`'s Google cases: filtering, merge/dedup, each fallback path.
- `uv run pytest -q` + ruff green.

## File references

- `apps/backend/app/agent/models.py` — `google_model_catalog` template, `MODEL_CATALOG`
- `apps/backend/tests/test_models.py` — Google dynamic-catalog tests
