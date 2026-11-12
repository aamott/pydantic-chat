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
from typing import TYPE_CHECKING

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

logger = logging.getLogger(__name__)

DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434"
"""Where a local Ollama server listens when no ``ollama_base_url`` is configured."""

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
        super().__init__(f"Unknown model provider {provider!r}; expected one of: {known}")


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
