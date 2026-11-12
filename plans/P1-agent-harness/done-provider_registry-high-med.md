# Provider registry

## Goal

`provider:model` strings resolve to configured model instances across Anthropic, OpenAI, Google, Ollama.

## Acceptance criteria

- Registry maps e.g. `anthropic:claude-sonnet-4-6`, `openai:gpt-…`, `google:gemini-…`, `ollama:<name>` (via `OllamaProvider(base_url)` from settings) to pydantic-ai model instances
- API keys resolved: backend secrets file → env fallback; missing key yields clear UI-visible error, not crash
- Chat's `model` setting overrides global default; `PUT /api/settings` model change takes effect next run without restart
- `GET /api/settings/providers` → which providers have keys configured (for settings UI)

## Files
- `apps/backend/app/agent/models.py`, `app/config.py`

## Depends on
- pending-repo_scaffold-high-easy.md

## Implementation notes (2026-11-12 subagent)

- Implemented in `app/agent/models.py` + `app/config.py`. `resolve_model(spec)` + `configured_providers()`; secrets via `get_secret`/`set_secret` (`data_dir()/secrets.json`, atomic write, mode 600, secrets.json beats env).
- Secret names are lowercased env names: `anthropic_api_key`, `openai_api_key`, `google_api_key`, `ollama_base_url`, `ollama_api_key`, `openai_compatible_{base_url,name,api_key}` — env fallback auto-derives via `.upper()`.
- **API deltas vs story:** `google-cloud:` resolves to `GoogleCloudProvider` (Vertex; API key or ADC envs), NOT `GoogleProvider` — the correct class for that prefix. `openai:` → `OpenAIResponsesModel`; `openai-chat:` → `OpenAIChatModel`; `openai-compatible:` → `OpenAIChatModel`+`OpenAICompatibleProvider` (needs `openai_compatible_base_url`). `ollama:` needs no key — `ollama_base_url` defaults to `http://localhost:11434`, so `configured_providers()` always lists it.
- Missing key → `ProviderNotConfigured` (typed, `.provider`, clear fix hint, no key material); unknown prefix → `UnknownProviderError`.
- `resolve_model_name(chat)` (async): chat.model → `default_model` setting → `anthropic:claude-sonnet-4-6`. Reads settings fresh each call → takes effect next run without restart.
- AC pending on other agent: `PUT /api/settings`, `GET /api/settings/providers` routes (helpers are ready).

- Marked done: unit-tested (test_agent.py) + exercised e2e via /api/chat with FunctionModel; live tool behavior vs real provider verified on first keyed run.
