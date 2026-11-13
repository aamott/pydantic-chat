"""Model-picklist route: ``GET /api/models`` feeds the composer's model picker.

Only providers that can resolve a model right now are listed —
:func:`app.agent.models.configured_providers` is the single source of truth, so
a provider without credentials never appears. Hosted providers serve the
static, hand-editable :data:`~app.agent.models.MODEL_CATALOG`; Ollama's model
list is fetched live from ``GET {ollama_base_url}/api/tags`` and degrades to an
empty list when the local server is offline.
"""

from fastapi import APIRouter

from app.agent import models as agent_models
from app.agent.models import KNOWN_PROVIDERS
from app.api.schemas import ModelProviderOut, ModelsOut

router = APIRouter(prefix="/api", tags=["models"])

OPENAI_COMPATIBLE_LABEL = "OpenAI-compatible"
"""Display label for the no-fixed-catalog ``openai-compatible`` provider."""


@router.get("/models")
async def list_models() -> ModelsOut:
    """The selectable models for every configured provider.

    ``openai-compatible`` has no fixed catalog and returns ``models: []`` — the
    frontend lets the user type a ``provider:model`` spec, which PATCH accepts
    free-form. Ollama offline likewise returns ``models: []`` rather than
    failing the whole endpoint.
    """
    providers: list[ModelProviderOut] = []
    for provider in KNOWN_PROVIDERS:
        if provider not in agent_models.configured_providers():
            continue
        if provider == "ollama":
            providers.append(
                ModelProviderOut(
                    provider=provider,
                    label="Ollama",
                    models=await agent_models.ollama_model_catalog(),
                )
            )
            continue
        entry = agent_models.MODEL_CATALOG.get(provider)
        providers.append(
            ModelProviderOut(
                provider=provider,
                label=entry["label"] if entry else OPENAI_COMPATIBLE_LABEL,
                models=list(entry["models"]) if entry else [],
            )
        )
    return ModelsOut(providers=providers)
