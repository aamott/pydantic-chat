# Google model catalog: dynamic Gemini list

## Goal

Make the `google` section of `GET /api/models` dynamic — list every Gemini
model the configured `google_api_key` can generate with, via
`GET https://generativelanguage.googleapis.com/v1beta/models?key=<key>` —
mirroring `ollama_model_catalog`'s live-fetch pattern, so free-tier and
newly-released models appear without hand-editing `MODEL_CATALOG`.

## Acceptance criteria

- With `google_api_key` configured, `google_model_catalog()` fetches
  `v1beta/models` with the key and returns rows filtered to
  `supportedGenerationMethods` containing `generateContent` AND `name`
  starting with `models/gemini-`.
- Row mapping: `id` = `google:` + name minus `models/`; `name` =
  `displayName` (fallback: model id); `max_context` = `inputTokenLimit` or
  `None`; `thinking_levels` = static `MODEL_CATALOG` entry's levels when the
  id matches, else heuristic (`pro`-named -> `["low","medium","high"]`,
  others -> all levels).
- Static flagship merge: static `google` entries the API didn't return are
  appended; dedup by id (dynamic wins).
- Transport error, non-200, or malformed payload falls back to the static
  `google` list — a Google outage never breaks `GET /api/models`.
- No key -> static list (section wouldn't render anyway, but the function
  stays safe to call). `google-cloud` (Vertex) stays static.
- `uv run pytest -q` green; `uv run ruff check app tests` clean; no new deps.

## Files

- `apps/backend/app/agent/models.py`
- `apps/backend/app/api/models.py`
- `apps/backend/tests/test_models.py`

## Depends on

- none

## Implementation notes

- `app/agent/models.py` — `google_model_catalog()` fetches
  `v1beta/models?key=` with `httpx.AsyncClient(timeout=GEMINI_MODELS_TIMEOUT)`
  (3.0s, same style as `ollama_model_catalog`); filters to `models/gemini-*`
  + `generateContent`; maps `displayName`/`inputTokenLimit`; dedups by spec
  id and appends static `MODEL_CATALOG["google"]` entries the API missed.
  `_gemini_thinking_levels()` is the heuristic fallback (`pro` in the name ->
  `_NO_OFF`, else `_ALL_THINKING`); static levels win on id match.
  `httpx.HTTPError`/`ValueError`/missing key all return the static list.
- `app/api/models.py` — `google` branch mirrors `ollama`'s, but its fallback
  is the static section rather than `[]`.
- No pagination (`nextPageToken`) — page size covers the current catalog;
  revisit if the list ever truncates flagships.
