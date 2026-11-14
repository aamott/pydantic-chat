"""Provider registry: resolve ``provider:model`` specs to pydantic-ai models.

Supported prefixes (verified against ``pydantic-ai-slim==2.68.0``):

- ``anthropic:``          -> ``AnthropicModel`` + ``AnthropicProvider``
- ``openai:``             -> ``OpenAIResponsesModel`` + ``OpenAIProvider``
- ``openai-chat:``        -> ``OpenAIChatModel`` + ``OpenAIProvider``
- ``google:``             -> ``GoogleModel`` + ``GoogleProvider`` (Gemini API)
- ``google-cloud:``       -> ``GoogleModel`` + ``GoogleCloudProvider`` (Vertex)
- ``ollama:``             -> ``OllamaModel`` + ``OllamaProvider`` (local default)
- ``openai-compatible:``  -> ``OpenAIChatModel`` + ``OpenAICompatibleProvider``

Credentials resolve through :func:`app.config.get_secret`, so a key in
``secrets.json`` wins over the matching environment variable (secret names are
the lowercased env names: ``anthropic_api_key`` -> ``ANTHROPIC_API_KEY``).
Missing credentials raise :class:`ProviderNotConfigured`, which the API layer
turns into a 4xx — keys are never logged.
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Any, TypedDict, cast

import httpx
from anthropic._constants import ANTHROPIC_API_VERSION
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.google_cloud import GoogleCloudProvider
from pydantic_ai.providers.ollama import OllamaProvider
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.providers.openai_compatible import OpenAICompatibleProvider

from app.config import get_secret

if TYPE_CHECKING:
    from pydantic_ai.models import Model
    from pydantic_ai.settings import ModelSettings, ThinkingLevel

logger = logging.getLogger(__name__)

DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434"
"""Where a local Ollama server listens when no ``ollama_base_url`` is configured."""

OLLAMA_TAGS_TIMEOUT = 3.0
"""Seconds to wait for ``GET {ollama}/api/tags`` before treating the server as offline."""

GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"
"""Google AI Gemini API model-listing endpoint (``?key=<api_key>``)."""

GEMINI_MODELS_TIMEOUT = 3.0
"""Seconds to wait for the Gemini model list before falling back to the static catalog."""

OPENAI_MODELS_URL = "https://api.openai.com/v1/models"
"""OpenAI model-listing endpoint (``Authorization: Bearer <api_key>``)."""

OPENAI_MODELS_TIMEOUT = 3.0
"""Seconds to wait for the OpenAI model list before falling back to the static catalog."""

ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models"
"""Anthropic model-listing endpoint (``x-api-key`` + ``anthropic-version`` headers)."""

ANTHROPIC_MODELS_TIMEOUT = 3.0
"""Seconds to wait for the Anthropic model list before falling back to the static catalog."""

THINKING_LEVELS: tuple[str, ...] = ("off", "low", "medium", "high")
"""Normalized thinking levels the model picker offers on every thinking-capable model.

``off`` maps to the unified ``ModelSettings.thinking = False`` (thinking disabled, or the
lowest level the model accepts when it can't turn thinking off); the rest pass through to
pydantic-ai's unified ``thinking`` effort field, which translates per provider
(Anthropic ``output_config.effort``, OpenAI ``reasoning_effort``, Gemini ``thinking_level``).
"""


class CatalogModel(TypedDict):
    """One selectable model in the ``GET /api/models`` catalog."""

    id: str  # full `provider:model` spec, ready for `resolve_model`
    name: str  # display name
    thinking_levels: list[str]  # subset of THINKING_LEVELS the model accepts
    max_context: int | None  # context window in tokens; None when unknown


class CatalogProvider(TypedDict):
    """One provider section of the ``GET /api/models`` response."""

    label: str
    models: list[CatalogModel]


def _cm(
    spec: str, name: str, thinking: list[str], max_context: int | None
) -> CatalogModel:
    """Build a :class:`CatalogModel` row (keeps the catalog below terse and editable)."""
    return CatalogModel(
        id=spec, name=name, thinking_levels=thinking, max_context=max_context
    )


_ALL_THINKING = list(THINKING_LEVELS)
_NO_OFF = ["low", "medium", "high"]

# Static model-picklist for the hosted providers, and the fallback/merge
# source for the live catalogs (`google`/`openai`/`anthropic` each fetch their
# provider's model list and merge it with these entries). Ollama's list is
# dynamic (`ollama_model_catalog`) and `openai-compatible` has no fixed list
# (empty).
# This is a plain editable dict — add/rename models freely; ids should match
# pydantic-ai's model profiles (this install knows claude-*-4-8/5, gpt-6.1-*,
# gemini-4-*). Specs absent here still run via PATCH/`default_model`.
#
# `thinking_levels` is the normalized scale each model accepts: 'off' is
# omitted where the model can't disable reasoning (gpt-6.1-sol, gpt-5.3-chat
# advertises only its fixed 'medium', Gemini Pro thinks always).
MODEL_CATALOG: dict[str, CatalogProvider] = {
    "anthropic": {
        "label": "Anthropic",
        "models": [
            _cm("anthropic:claude-opus-4-8", "Claude Opus 4.8", _ALL_THINKING, 200_000),
            _cm("anthropic:claude-sonnet-5", "Claude Sonnet 5", _ALL_THINKING, 200_000),
            _cm(
                "anthropic:claude-sonnet-4-6",
                "Claude Sonnet 4.6",
                _ALL_THINKING,
                200_000,
            ),
            _cm(
                "anthropic:claude-haiku-4-5", "Claude Haiku 4.5", _ALL_THINKING, 200_000
            ),
        ],
    },
    "openai": {
        "label": "OpenAI",
        "models": [
            _cm("openai:gpt-6.1-sol", "GPT-6.1 Sol", _NO_OFF, 1_000_000),
            _cm("openai:gpt-6.1-terra", "GPT-6.1 Terra", _ALL_THINKING, 1_000_000),
            _cm("openai:gpt-5.5", "GPT-5.5", _ALL_THINKING, 400_000),
        ],
    },
    "openai-chat": {
        "label": "OpenAI (Chat)",
        "models": [
            _cm("openai-chat:gpt-5.3-chat", "GPT-5.3 Chat", ["medium"], 128_000),
            _cm("openai-chat:gpt-5.2-chat", "GPT-5.2 Chat", ["medium"], 128_000),
            _cm("openai-chat:gpt-5-chat", "GPT-5 Chat", ["off"], 128_000),
        ],
    },
    "google": {
        "label": "Google Gemini",
        "models": [
            _cm("google:gemini-4-carbon", "Gemini 4 Carbon", _ALL_THINKING, 1_048_576),
            _cm("google:gemini-4-argon", "Gemini 4 Argon", _ALL_THINKING, 1_048_576),
            _cm(
                "google:gemini-3.8-flash", "Gemini 3.8 Flash", _ALL_THINKING, 1_048_576
            ),
            _cm("google:gemini-3.1-pro-preview", "Gemini 3.1 Pro", _NO_OFF, 1_048_576),
        ],
    },
    "google-cloud": {
        "label": "Google Cloud (Vertex AI)",
        "models": [
            _cm(
                "google-cloud:gemini-4-carbon",
                "Gemini 4 Carbon",
                _ALL_THINKING,
                1_048_576,
            ),
            _cm(
                "google-cloud:gemini-4-argon",
                "Gemini 4 Argon",
                _ALL_THINKING,
                1_048_576,
            ),
            _cm(
                "google-cloud:gemini-3.8-flash",
                "Gemini 3.8 Flash",
                _ALL_THINKING,
                1_048_576,
            ),
            _cm(
                "google-cloud:gemini-3.1-pro-preview",
                "Gemini 3.1 Pro",
                _NO_OFF,
                1_048_576,
            ),
        ],
    },
}
"""Static picker catalog keyed by provider prefix. Ollama is dynamic, not listed here."""

KNOWN_PROVIDERS: tuple[str, ...] = (
    "anthropic",
    "openai",
    "openai-chat",
    "google",
    "google-cloud",
    "ollama",
    "openai-compatible",
)
"""Every ``provider`` prefix :func:`resolve_model` accepts, in display order."""


class ProviderNotConfigured(RuntimeError):
    """A provider was selected whose credentials are not configured.

    The API layer maps this to a 4xx; the message names the provider and how to
    fix it, and never contains key material.
    """

    def __init__(self, provider: str, message: str) -> None:
        self.provider = provider
        super().__init__(message)


class UnknownProviderError(ValueError):
    """A ``provider:model`` spec used a prefix the registry doesn't know."""

    def __init__(self, provider: str) -> None:
        self.provider = provider
        known = ", ".join(KNOWN_PROVIDERS)
        super().__init__(
            f"Unknown model provider {provider!r}; expected one of: {known}"
        )


def _require_secret(name: str, provider: str, hint: str) -> str:
    """A configured secret, or a :class:`ProviderNotConfigured` explaining the fix."""
    value = get_secret(name)
    if not value:
        raise ProviderNotConfigured(provider, f"{provider!r} is not configured: {hint}")
    return value


def resolve_model(spec: str) -> Model:
    """Instantiate the pydantic-ai model a ``provider:model`` spec names.

    Args:
        spec: A ``provider:model-name`` string, e.g. ``"anthropic:claude-sonnet-4-6"``.

    Returns:
        A configured ``Model`` ready to pass as ``dispatch_request(model=...)``.

    Raises:
        UnknownProviderError: If the prefix before ``:`` isn't a known provider.
        ProviderNotConfigured: If the provider's credentials are missing.
    """
    provider, sep, model_name = spec.partition(":")
    if not sep or not model_name:
        raise UnknownProviderError(spec or provider)

    if provider == "anthropic":
        key = _require_secret(
            "anthropic_api_key",
            provider,
            "save an Anthropic key in settings or set ANTHROPIC_API_KEY",
        )
        return AnthropicModel(model_name, provider=AnthropicProvider(api_key=key))

    if provider in ("openai", "openai-chat"):
        key = _require_secret(
            "openai_api_key",
            provider,
            "save an OpenAI key in settings or set OPENAI_API_KEY",
        )
        openai_provider = OpenAIProvider(api_key=key)
        if provider == "openai":
            return OpenAIResponsesModel(model_name, provider=openai_provider)
        return OpenAIChatModel(model_name, provider=openai_provider)

    if provider == "google":
        key = _require_secret(
            "google_api_key",
            provider,
            "save a Gemini key in settings or set GOOGLE_API_KEY",
        )
        return GoogleModel(model_name, provider=GoogleProvider(api_key=key))

    if provider == "google-cloud":
        # Vertex AI accepts an Express Mode API key or Application Default
        # Credentials; require one of them up front for a clear error.
        key = get_secret("google_api_key")
        has_adc = bool(
            os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
            or os.environ.get("GOOGLE_CLOUD_PROJECT")
        )
        if not key and not has_adc:
            raise ProviderNotConfigured(
                provider,
                "'google-cloud' is not configured: save a Google key in settings, "
                "set GOOGLE_API_KEY, or configure Application Default Credentials",
            )
        return GoogleModel(model_name, provider=GoogleCloudProvider(api_key=key))

    if provider == "ollama":
        # No key needed for a local server; the base URL defaults to localhost.
        base_url = get_secret("ollama_base_url") or DEFAULT_OLLAMA_BASE_URL
        return OllamaModel(
            model_name,
            provider=OllamaProvider(
                base_url=base_url, api_key=get_secret("ollama_api_key")
            ),
        )

    if provider == "openai-compatible":
        base_url = _require_secret(
            "openai_compatible_base_url",
            provider,
            "save a base URL in settings or set OPENAI_COMPATIBLE_BASE_URL",
        )
        return OpenAIChatModel(
            model_name,
            provider=OpenAICompatibleProvider(
                name=get_secret("openai_compatible_name") or "custom",
                base_url=base_url,
                api_key=get_secret("openai_compatible_api_key"),
            ),
        )

    raise UnknownProviderError(provider)


def configured_providers() -> list[str]:
    """The provider prefixes that can resolve a model right now (for settings UI).

    ``ollama`` always counts: it needs no key and defaults to the local server.
    ``google-cloud`` counts with an API key *or* ADC environment present.
    """
    configured: list[str] = []
    if get_secret("anthropic_api_key"):
        configured.append("anthropic")
    if get_secret("openai_api_key"):
        configured += ["openai", "openai-chat"]
    if get_secret("google_api_key"):
        configured.append("google")
    if get_secret("google_api_key") or (
        os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        or os.environ.get("GOOGLE_CLOUD_PROJECT")
    ):
        configured.append("google-cloud")
    configured.append("ollama")
    if get_secret("openai_compatible_base_url"):
        configured.append("openai-compatible")
    return configured


def split_model_spec(spec: str) -> tuple[str, str]:
    """Split a ``provider:model`` spec into ``(provider, model_name)``.

    Raises:
        UnknownProviderError: If there's no ``:`` separator, no model name, or
            the prefix isn't a known provider.
    """
    provider, sep, model_name = spec.partition(":")
    if not sep or not model_name or provider not in KNOWN_PROVIDERS:
        raise UnknownProviderError(provider if sep and provider else spec)
    return provider, model_name


def catalog_thinking_levels(spec: str) -> list[str] | None:
    """The thinking levels a catalog-listed spec accepts, or ``None`` when unknown.

    ``None`` covers every spec not in :data:`MODEL_CATALOG` — Ollama names,
    ``openai-compatible`` models, and static-catalog misses — which the PATCH
    route treats as free-form rather than validating.
    """
    provider, sep, model_name = spec.partition(":")
    if not sep or not model_name:
        return None
    entry = MODEL_CATALOG.get(provider)
    if entry is None:
        return None
    for model in entry["models"]:
        if model["id"] == spec:
            return model["thinking_levels"]
    return None


def thinking_model_settings(level: str | None) -> ModelSettings | None:
    """Map a normalized thinking level to per-run ``model_settings``, or ``None``.

    All providers take the unified ``ModelSettings.thinking`` field
    (``pydantic_ai.settings``, verified against ``pydantic-ai-slim==2.68.0``):
    the adapters translate it — Anthropic to ``output_config.effort`` /
    ``anthropic_thinking``, OpenAI to ``reasoning_effort`` via
    ``OPENAI_REASONING_EFFORT_MAP``, Gemini to ``thinking_level`` /
    ``thinking_budget``. ``off`` sends ``False`` (thinking disabled where the
    model allows it). Non-normalized free-form values pass through unchanged;
    the provider is the authority on whether it accepts them.
    """
    if not level:
        return None
    if level == "off":
        return {"thinking": False}
    return {"thinking": cast("ThinkingLevel", level)}


async def ollama_model_catalog() -> list[CatalogModel]:
    """The local Ollama server's installed models, or ``[]`` when unreachable.

    Queries ``GET {ollama_base_url}/api/tags`` with a short timeout; any
    transport error or malformed payload reads as "no models" — an offline
    Ollama must never break ``GET /api/models``. ``ollama_base_url`` resolves
    through :func:`get_secret` exactly as ``resolve_model`` reads it.
    """
    base_url = (get_secret("ollama_base_url") or DEFAULT_OLLAMA_BASE_URL).rstrip("/")
    try:
        async with httpx.AsyncClient(
            base_url=base_url, timeout=OLLAMA_TAGS_TIMEOUT
        ) as client:
            response = await client.get("/api/tags")
            response.raise_for_status()
        payload: Any = response.json()
    except (httpx.HTTPError, ValueError):
        logger.info("Ollama at %s unreachable; returning an empty model list", base_url)
        return []
    models = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(models, list):
        return []
    return [
        CatalogModel(
            id=f"ollama:{name}",
            name=name,
            # Ollama's /api/tags doesn't report thinking capability; advertise
            # the full normalized scale — a non-thinking model just ignores it.
            thinking_levels=list(THINKING_LEVELS),
            max_context=None,
        )
        for name in (m.get("name") for m in models if isinstance(m, dict))
        if isinstance(name, str) and name
    ]


def _gemini_thinking_levels(model_name: str) -> list[str]:
    """Thinking levels for a Gemini model with no static catalog entry.

    Gemini Pro models always think and can't disable reasoning, so they get
    the no-off subset; Flash/Flash-Lite/other variants take the full
    normalized scale. Hand-curated :data:`MODEL_CATALOG` levels win whenever
    an id matches — this is only the fallback for API-only models.
    """
    return list(_NO_OFF) if "pro" in model_name else list(_ALL_THINKING)


async def google_model_catalog() -> list[CatalogModel]:
    """Every Gemini model the configured key can use, merged with static entries.

    Queries ``GET {GEMINI_MODELS_URL}?key=<google_api_key>`` with a short
    timeout — the same pattern as :func:`ollama_model_catalog`. Any transport
    error, non-200, malformed payload, or missing key yields the static
    ``google`` section of :data:`MODEL_CATALOG`: the hand-curated entries still
    work, so a Google outage must never break ``GET /api/models``.

    Models are kept only when ``supportedGenerationMethods`` includes
    ``generateContent`` and the resource name starts with ``models/gemini-``
    (drops embedding/AQA/tuned entries). Static flagships the list endpoint
    doesn't expose (e.g. preview models) are appended; ids dedup, dynamic wins.
    """
    static = MODEL_CATALOG.get("google", CatalogProvider(label="", models=[]))["models"]
    key = get_secret("google_api_key")
    if not key:
        return list(static)
    try:
        async with httpx.AsyncClient(timeout=GEMINI_MODELS_TIMEOUT) as client:
            response = await client.get(GEMINI_MODELS_URL, params={"key": key})
            response.raise_for_status()
        payload: Any = response.json()
    except (httpx.HTTPError, ValueError):
        logger.info("Gemini model list unreachable; falling back to the static catalog")
        return list(static)
    models = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(models, list):
        return list(static)

    static_by_id = {m["id"]: m for m in static}
    catalog: list[CatalogModel] = []
    seen: set[str] = set()
    for entry in models:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        methods = entry.get("supportedGenerationMethods")
        if not (
            isinstance(name, str)
            and name.startswith("models/gemini-")
            and isinstance(methods, list)
            and "generateContent" in methods
        ):
            continue
        model_name = name.removeprefix("models/")
        spec = f"google:{model_name}"
        if spec in seen:
            continue
        seen.add(spec)
        display = entry.get("displayName")
        token_limit = entry.get("inputTokenLimit")
        static_entry = static_by_id.get(spec)
        catalog.append(
            CatalogModel(
                id=spec,
                name=display if isinstance(display, str) and display else model_name,
                thinking_levels=(
                    static_entry["thinking_levels"]
                    if static_entry
                    else _gemini_thinking_levels(model_name)
                ),
                max_context=token_limit if isinstance(token_limit, int) else None,
            )
        )
    # Append hand-curated static flagships the list endpoint didn't return.
    catalog.extend(m for m in static if m["id"] not in seen)
    return catalog


def _is_openai_chat_model(model_id: str) -> bool:
    """Whether an OpenAI ``/v1/models`` id is a chat-capable model.

    The list endpoint also returns audio, image, embedding, moderation, and
    legacy-completions models, so the catalog keeps only the chat families:
    ``gpt-*``, ``chatgpt-*``, and the o-series (``o`` + a digit, e.g. ``o1``,
    ``o4-mini``). The digit check drops non-reasoning ids like
    ``omni-moderation-latest``.
    """
    return model_id.startswith(("gpt-", "chatgpt-")) or (
        model_id.startswith("o") and len(model_id) > 1 and model_id[1].isdigit()
    )


def _openai_thinking_levels(model_id: str) -> list[str]:
    """Thinking levels for an OpenAI model with no static catalog entry.

    o-series reasoning models can't turn reasoning off, so they get the no-off
    subset; ``gpt-*``/``chatgpt-*`` chat models take the full normalized scale.
    Hand-curated :data:`MODEL_CATALOG` levels win whenever an id matches — this
    is only the fallback for API-only models.
    """
    is_reasoning = (
        model_id.startswith("o") and len(model_id) > 1 and model_id[1].isdigit()
    )
    return list(_NO_OFF) if is_reasoning else list(_ALL_THINKING)


async def openai_model_catalog() -> list[CatalogModel]:
    """Every chat-capable OpenAI model the configured key can use, merged with statics.

    Queries ``GET {OPENAI_MODELS_URL}`` with an ``Authorization: Bearer
    <openai_api_key>`` header and a short timeout — the same pattern as
    :func:`google_model_catalog`. Any transport error, non-200, malformed
    payload, or missing key yields the static ``openai`` section of
    :data:`MODEL_CATALOG`: the hand-curated entries still work, so an OpenAI
    outage must never break ``GET /api/models``.

    Models are kept only when :func:`_is_openai_chat_model` accepts the id —
    the endpoint also lists ``dall-e-*``, ``whisper-*``, ``tts-*``,
    ``text-embedding-*``, moderation, and legacy completions entries. The API
    returns no display names or context windows, so a matching static entry
    fills name/thinking/max_context; unlisted rows use the id as the name.
    Static flagships are appended; ids dedup, dynamic wins.
    """
    static = MODEL_CATALOG.get("openai", CatalogProvider(label="", models=[]))["models"]
    key = get_secret("openai_api_key")
    if not key:
        return list(static)
    try:
        async with httpx.AsyncClient(timeout=OPENAI_MODELS_TIMEOUT) as client:
            response = await client.get(
                OPENAI_MODELS_URL, headers={"Authorization": f"Bearer {key}"}
            )
            response.raise_for_status()
        payload: Any = response.json()
    except (httpx.HTTPError, ValueError):
        logger.info("OpenAI model list unreachable; falling back to the static catalog")
        return list(static)
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return list(static)

    static_by_id = {m["id"]: m for m in static}
    catalog: list[CatalogModel] = []
    seen: set[str] = set()
    for entry in rows:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get("id")
        if not (isinstance(model_id, str) and _is_openai_chat_model(model_id)):
            continue
        spec = f"openai:{model_id}"
        if spec in seen:
            continue
        seen.add(spec)
        static_entry = static_by_id.get(spec)
        catalog.append(
            CatalogModel(
                id=spec,
                name=static_entry["name"] if static_entry else model_id,
                thinking_levels=(
                    static_entry["thinking_levels"]
                    if static_entry
                    else _openai_thinking_levels(model_id)
                ),
                max_context=static_entry["max_context"] if static_entry else None,
            )
        )
    # Append hand-curated static flagships the list endpoint didn't return.
    catalog.extend(m for m in static if m["id"] not in seen)
    return catalog


def _anthropic_thinking_levels(entry: dict[str, Any]) -> list[str]:
    """Thinking levels for a Claude model with no static catalog entry.

    The ``capabilities`` block reports ``thinking`` and ``effort`` support;
    when it names a reasoning capability and all of them report
    ``supported: false`` the model only gets ``["off"]``. A missing
    capabilities block falls back to the full normalized scale — every Claude
    in the static catalog thinks. Hand-curated :data:`MODEL_CATALOG` levels
    win whenever an id matches.
    """
    caps = entry.get("capabilities")
    if isinstance(caps, dict) and ("thinking" in caps or "effort" in caps):
        reasoning = (
            caps.get("thinking"),
            caps.get("effort"),
        )
        supported = any(
            isinstance(cap, dict) and cap.get("supported") is True for cap in reasoning
        )
        if not supported:
            return ["off"]
    return list(_ALL_THINKING)


async def anthropic_model_catalog() -> list[CatalogModel]:
    """Every Claude model the configured key can use, merged with static entries.

    Queries ``GET {ANTHROPIC_MODELS_URL}?limit=1000`` with ``x-api-key`` and
    ``anthropic-version`` headers — the version is pinned to the installed
    ``anthropic`` SDK's ``ANTHROPIC_API_VERSION`` so the picker speaks exactly
    the API revision the chat path does — under the same timeout/fallback
    pattern as :func:`google_model_catalog`. Any transport error, non-200,
    malformed payload, or missing key yields the static ``anthropic`` section
    of :data:`MODEL_CATALOG`.

    Rows are kept when ``id`` starts with ``claude`` and ``lifecycle`` is
    absent or ``"active"`` — ``deprecated``/``retired`` rows and non-Claude
    account models stay out of the picker. ``display_name`` and
    ``max_input_tokens`` fill name/max_context (a static entry's name backstops
    a missing display name); curated ``thinking_levels`` win on matching ids.
    ``limit=1000`` pulls the whole Claude catalog in one page — the default
    page size would page newest-last results away.
    """
    static = MODEL_CATALOG.get("anthropic", CatalogProvider(label="", models=[]))[
        "models"
    ]
    key = get_secret("anthropic_api_key")
    if not key:
        return list(static)
    try:
        async with httpx.AsyncClient(timeout=ANTHROPIC_MODELS_TIMEOUT) as client:
            response = await client.get(
                ANTHROPIC_MODELS_URL,
                params={"limit": 1000},
                headers={
                    "x-api-key": key,
                    "anthropic-version": ANTHROPIC_API_VERSION,
                },
            )
            response.raise_for_status()
        payload: Any = response.json()
    except (httpx.HTTPError, ValueError):
        logger.info(
            "Anthropic model list unreachable; falling back to the static catalog"
        )
        return list(static)
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return list(static)

    static_by_id = {m["id"]: m for m in static}
    catalog: list[CatalogModel] = []
    seen: set[str] = set()
    for entry in rows:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get("id")
        lifecycle = entry.get("lifecycle")
        if not (
            isinstance(model_id, str)
            and model_id.startswith("claude")
            and (lifecycle is None or lifecycle == "active")
        ):
            continue
        spec = f"anthropic:{model_id}"
        if spec in seen:
            continue
        seen.add(spec)
        display = entry.get("display_name")
        token_limit = entry.get("max_input_tokens")
        static_entry = static_by_id.get(spec)
        catalog.append(
            CatalogModel(
                id=spec,
                name=(
                    display
                    if isinstance(display, str) and display
                    else (static_entry["name"] if static_entry else model_id)
                ),
                thinking_levels=(
                    static_entry["thinking_levels"]
                    if static_entry
                    else _anthropic_thinking_levels(entry)
                ),
                max_context=(
                    token_limit
                    if isinstance(token_limit, int)
                    else (static_entry["max_context"] if static_entry else None)
                ),
            )
        )
    # Append hand-curated static flagships the list endpoint didn't return.
    catalog.extend(m for m in static if m["id"] not in seen)
    return catalog
