"""Tests for the model-picker backend: GET /api/models + chat PATCH overrides.

Provider credentials are controlled purely through env vars here — ``get_secret``
prefers ``secrets.json`` (absent under the tmp ``APP_DATA_DIR``) and falls back
to the environment, so ``monkeypatch.setenv``/``delenv`` flips
``configured_providers()`` deterministically.
"""

import httpx
import pytest
from anthropic._constants import ANTHROPIC_API_VERSION
from fastapi.testclient import TestClient

from app.agent.factory import build_run_kwargs
from app.agent.models import (
    MODEL_CATALOG,
    UnknownProviderError,
    anthropic_model_catalog,
    catalog_thinking_levels,
    google_model_catalog,
    ollama_model_catalog,
    openai_model_catalog,
    split_model_spec,
)
from app.api.chat import _run_settings
from app.main import create_app

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

# Every env var configured_providers()/get_secret() can read — cleared so no
# ambient key on the dev box leaks into the catalog tests.
_PROVIDER_ENV_VARS = (
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "OLLAMA_API_KEY",
    "OLLAMA_BASE_URL",
    "OPENAI_COMPATIBLE_API_KEY",
    "OPENAI_COMPATIBLE_BASE_URL",
    "OPENAI_COMPATIBLE_NAME",
)


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A TestClient over a fresh app with all provider env cleared."""
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("APP_TOKEN", TOKEN)
    for var in _PROVIDER_ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    # TrustedHostMiddleware only allows loopback hosts.
    with TestClient(create_app(), base_url="http://127.0.0.1") as test_client:
        yield test_client, tmp_path


def _create_workspace(client, path) -> dict:
    response = client.post("/api/workspaces", json={"path": str(path)}, headers=AUTH)
    assert response.status_code == 200
    return response.json()


def _create_chat(client, workspace_id: str, body: dict | None = None) -> dict:
    response = client.post(
        f"/api/workspaces/{workspace_id}/chats", json=body or {}, headers=AUTH
    )
    assert response.status_code == 201
    return response.json()


def _patch_chat(client, chat_id: str, body: dict):
    return client.patch(f"/api/chats/{chat_id}", json=body, headers=AUTH)


# ---------------------------------------------------------------------------
# GET /api/models — shape and configured-only filtering
# ---------------------------------------------------------------------------


def test_models_requires_auth(client):
    test_client, _ = client
    assert test_client.get("/api/models").status_code == 401


def test_models_catalog_shape_and_filtering(client, monkeypatch):
    """Only configured providers appear; each entry has the documented shape."""
    test_client, _ = client

    # Nothing configured -> only Ollama (it needs no key).
    catalog = test_client.get("/api/models", headers=AUTH).json()
    assert set(catalog.keys()) == {"providers"}
    providers = {entry["provider"]: entry for entry in catalog["providers"]}
    assert list(providers) == ["ollama"]
    assert providers["ollama"]["label"] == "Ollama"
    assert isinstance(providers["ollama"]["models"], list)

    # An Anthropic key adds its section; OpenAI/Google stay absent. The fake
    # client refuses connections, so the live fetch falls back to the static
    # list without touching the network.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    _anthropic_client(monkeypatch, None, error=httpx.ConnectError("offline"))
    catalog = test_client.get("/api/models", headers=AUTH).json()
    providers = {entry["provider"]: entry for entry in catalog["providers"]}
    assert "anthropic" in providers
    assert "openai" not in providers
    assert "google" not in providers
    anthropic = providers["anthropic"]
    assert anthropic["label"] == "Anthropic"
    assert anthropic["models"], "static catalog returned no models"
    for model in anthropic["models"]:
        assert model["id"].startswith("anthropic:")
        assert isinstance(model["name"], str)
        assert model["name"]
        assert isinstance(model["thinking_levels"], list)
        assert set(model["thinking_levels"]) <= {"off", "low", "medium", "high"}
        assert model["max_context"] is None or isinstance(model["max_context"], int)


def test_models_openai_key_adds_both_openai_sections(client, monkeypatch):
    test_client, _ = client
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    # Offline -> openai_model_catalog falls back to the static list.
    _openai_client(monkeypatch, None, error=httpx.ConnectError("offline"))
    providers = {
        entry["provider"]: entry
        for entry in test_client.get("/api/models", headers=AUTH).json()["providers"]
    }
    assert "openai" in providers
    assert "openai-chat" in providers
    for model in providers["openai"]["models"]:
        assert model["id"].startswith("openai:")


def test_models_openai_compatible_empty_list(client, monkeypatch):
    """openai-compatible has no fixed catalog but still shows up when configured."""
    test_client, _ = client
    monkeypatch.setenv("OPENAI_COMPATIBLE_BASE_URL", "http://localhost:1234/v1")
    providers = {
        entry["provider"]: entry
        for entry in test_client.get("/api/models", headers=AUTH).json()["providers"]
    }
    assert providers["openai-compatible"]["models"] == []


# ---------------------------------------------------------------------------
# Ollama dynamic catalog
# ---------------------------------------------------------------------------


def test_models_ollama_offline_empty(client, monkeypatch):
    """An unreachable Ollama yields models: [] — never an endpoint error."""
    test_client, _ = client

    async def offline() -> list:
        return []

    monkeypatch.setattr("app.agent.models.ollama_model_catalog", offline)
    catalog = test_client.get("/api/models", headers=AUTH).json()
    (ollama,) = [e for e in catalog["providers"] if e["provider"] == "ollama"]
    assert ollama["models"] == []


def test_models_ollama_dynamic_models(client, monkeypatch):
    """A reachable Ollama's tags become ollama:<name> catalog entries."""
    test_client, _ = client

    async def online() -> list:
        return [
            {
                "id": "ollama:qwen3:8b",
                "name": "qwen3:8b",
                "thinking_levels": ["off", "low", "medium", "high"],
                "max_context": None,
            }
        ]

    monkeypatch.setattr("app.agent.models.ollama_model_catalog", online)
    catalog = test_client.get("/api/models", headers=AUTH).json()
    (ollama,) = [e for e in catalog["providers"] if e["provider"] == "ollama"]
    assert [m["id"] for m in ollama["models"]] == ["ollama:qwen3:8b"]
    assert ollama["models"][0]["max_context"] is None


async def test_ollama_model_catalog_live_and_offline(tmp_path, monkeypatch):
    """The fetch maps /api/tags names to specs and swallows transport errors."""
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "data"))

    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"models": [{"name": "qwen3:8b"}, {"name": "llama3.2:latest"}]}

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url):
            assert url == "/api/tags"
            return FakeResponse()

    monkeypatch.setattr("app.agent.models.httpx.AsyncClient", FakeClient)
    models = await ollama_model_catalog()
    assert [m["id"] for m in models] == ["ollama:qwen3:8b", "ollama:llama3.2:latest"]
    assert models[0]["max_context"] is None

    class BrokenClient(FakeClient):
        async def get(self, url):
            raise httpx.ConnectError("refused")

    monkeypatch.setattr("app.agent.models.httpx.AsyncClient", BrokenClient)
    assert await ollama_model_catalog() == []


# ---------------------------------------------------------------------------
# Google dynamic catalog
# ---------------------------------------------------------------------------

_STATIC_GOOGLE_IDS = [m["id"] for m in MODEL_CATALOG["google"]["models"]]


class _FakeGoogleClient:
    """Monkeypatched httpx.AsyncClient serving a canned v1beta/models payload."""

    payload: object = {"models": []}
    error: Exception | None = None

    def __init__(self, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def get(self, url, params=None):
        if self.error is not None:
            raise self.error
        assert url == "https://generativelanguage.googleapis.com/v1beta/models"
        assert params == {"key": "test-google-key"}

        class FakeResponse:
            def __init__(self, payload):
                self._payload = payload

            def raise_for_status(self):
                if isinstance(self._payload, Exception):
                    raise self._payload

            def json(self):
                return self._payload

        return FakeResponse(type(self).payload)


def _google_client(monkeypatch, payload, error=None):
    """Install _FakeGoogleClient with the given payload/transport error."""
    _FakeGoogleClient.payload = payload
    _FakeGoogleClient.error = error
    monkeypatch.setattr("app.agent.models.httpx.AsyncClient", _FakeGoogleClient)


def _gemini_env(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("GOOGLE_API_KEY", "test-google-key")


async def test_google_model_catalog_filters_and_maps(tmp_path, monkeypatch):
    """v1beta/models rows become google:<id> entries; non-generative junk drops."""
    _gemini_env(tmp_path, monkeypatch)
    _google_client(
        monkeypatch,
        {
            "models": [
                {
                    "name": "models/gemini-2.5-flash",
                    "displayName": "Gemini 2.5 Flash",
                    "inputTokenLimit": 1_048_576,
                    "supportedGenerationMethods": ["generateContent", "countTokens"],
                },
                {
                    # No displayName -> falls back to the model id part.
                    "name": "models/gemini-2.5-flash-lite",
                    "inputTokenLimit": 65_536,
                    "supportedGenerationMethods": ["generateContent"],
                },
                {
                    # No inputTokenLimit -> max_context None.
                    "name": "models/gemini-2.0-flash",
                    "displayName": "Gemini 2.0 Flash",
                    "supportedGenerationMethods": ["generateContent"],
                },
                {
                    # Embedding model: right family prefix is absent -> dropped.
                    "name": "models/embedding-001",
                    "displayName": "Embedding 001",
                    "supportedGenerationMethods": ["embedContent"],
                },
                {
                    # gemini- prefix but cannot generateContent -> dropped.
                    "name": "models/gemini-1.0-vision",
                    "displayName": "Gemini 1.0 Vision",
                    "supportedGenerationMethods": ["countTokens"],
                },
                {
                    # AQA/tuned-style entry under a non-gemini name -> dropped.
                    "name": "models/aqa",
                    "displayName": "AQA",
                    "supportedGenerationMethods": ["generateAnswer"],
                },
            ]
        },
    )
    models = await google_model_catalog()
    dynamic = models[:3]
    assert [m["id"] for m in dynamic] == [
        "google:gemini-2.5-flash",
        "google:gemini-2.5-flash-lite",
        "google:gemini-2.0-flash",
    ]
    assert dynamic[0]["name"] == "Gemini 2.5 Flash"
    assert dynamic[0]["max_context"] == 1_048_576
    assert dynamic[1]["name"] == "gemini-2.5-flash-lite"
    assert dynamic[1]["max_context"] == 65_536
    assert dynamic[2]["max_context"] is None
    # Static flagships the API didn't return are appended, dedup'd by id.
    assert [m["id"] for m in models[3:]] == _STATIC_GOOGLE_IDS
    assert len({m["id"] for m in models}) == len(models)


async def test_google_model_catalog_static_merge_and_dedup(tmp_path, monkeypatch):
    """A static entry the API also returns keeps its hand-curated thinking levels."""
    _gemini_env(tmp_path, monkeypatch)
    _google_client(
        monkeypatch,
        {
            "models": [
                {
                    # Matches a static catalog id: static thinking_levels win
                    # (_NO_OFF for the Pro preview), displayName still used.
                    "name": "models/gemini-3.1-pro-preview",
                    "displayName": "Gemini 3.1 Pro Preview (API name)",
                    "inputTokenLimit": 999_999,
                    "supportedGenerationMethods": ["generateContent"],
                },
            ]
        },
    )
    models = await google_model_catalog()
    by_id = {m["id"]: m for m in models}
    merged = by_id["google:gemini-3.1-pro-preview"]
    assert merged["name"] == "Gemini 3.1 Pro Preview (API name)"
    assert merged["thinking_levels"] == ["low", "medium", "high"]
    assert merged["max_context"] == 999_999  # live inputTokenLimit wins
    # Each static id appears exactly once, API-returned ones in dynamic position.
    assert models[0]["id"] == "google:gemini-3.1-pro-preview"
    assert sorted(m["id"] for m in models[1:]) == sorted(
        i for i in _STATIC_GOOGLE_IDS if i != "google:gemini-3.1-pro-preview"
    )


async def test_google_model_catalog_thinking_heuristic(tmp_path, monkeypatch):
    """Unlisted 'pro' models can't turn thinking off; flash/others get all levels."""
    _gemini_env(tmp_path, monkeypatch)
    _google_client(
        monkeypatch,
        {
            "models": [
                {
                    "name": "models/gemini-9.9-pro",
                    "displayName": "Gemini 9.9 Pro",
                    "supportedGenerationMethods": ["generateContent"],
                },
                {
                    "name": "models/gemini-9.9-flash",
                    "displayName": "Gemini 9.9 Flash",
                    "supportedGenerationMethods": ["generateContent"],
                },
            ]
        },
    )
    models = await google_model_catalog()
    by_id = {m["id"]: m for m in models}
    assert by_id["google:gemini-9.9-pro"]["thinking_levels"] == [
        "low",
        "medium",
        "high",
    ]
    assert by_id["google:gemini-9.9-flash"]["thinking_levels"] == [
        "off",
        "low",
        "medium",
        "high",
    ]


async def test_google_model_catalog_offline_falls_back_to_static(
    tmp_path, monkeypatch
):
    """Transport errors, non-200s, and malformed payloads all yield the static list."""
    _gemini_env(tmp_path, monkeypatch)
    static = MODEL_CATALOG["google"]["models"]

    _google_client(monkeypatch, None, error=httpx.ConnectError("refused"))
    assert await google_model_catalog() == list(static)

    _google_client(monkeypatch, None, error=httpx.ReadTimeout("slow"))
    assert await google_model_catalog() == list(static)

    # Non-200: raise_for_status throws inside the try block.
    _google_client(
        monkeypatch,
        httpx.HTTPStatusError(
            "403", request=httpx.Request("GET", "https://x"), response=httpx.Response(403)
        ),
    )
    assert await google_model_catalog() == list(static)

    _google_client(monkeypatch, "not even json-shaped")
    assert await google_model_catalog() == list(static)

    _google_client(monkeypatch, {"unexpected": "shape"})
    assert await google_model_catalog() == list(static)


async def test_google_model_catalog_no_key_returns_static(tmp_path, monkeypatch):
    """No google_api_key -> static list, and the HTTP fetch never runs."""
    _gemini_env(tmp_path, monkeypatch)
    monkeypatch.delenv("GOOGLE_API_KEY")
    _google_client(monkeypatch, None, error=httpx.ConnectError("must not be called"))
    assert await google_model_catalog() == list(MODEL_CATALOG["google"]["models"])


def test_models_google_dynamic_in_endpoint(client, monkeypatch):
    """With a key, GET /api/models serves the google section's dynamic rows."""
    test_client, _ = client
    monkeypatch.setenv("GOOGLE_API_KEY", "test-google-key")

    async def dynamic() -> list:
        return [
            {
                "id": "google:gemini-2.5-flash",
                "name": "Gemini 2.5 Flash",
                "thinking_levels": ["off", "low", "medium", "high"],
                "max_context": 1_048_576,
            },
            {
                "id": "google:gemini-3.1-pro-preview",
                "name": "Gemini 3.1 Pro",
                "thinking_levels": ["low", "medium", "high"],
                "max_context": 1_048_576,
            },
        ]

    monkeypatch.setattr("app.agent.models.google_model_catalog", dynamic)
    catalog = test_client.get("/api/models", headers=AUTH).json()
    (google,) = [e for e in catalog["providers"] if e["provider"] == "google"]
    assert google["label"] == "Google Gemini"
    assert [m["id"] for m in google["models"]] == [
        "google:gemini-2.5-flash",
        "google:gemini-3.1-pro-preview",
    ]
    # google-cloud (Vertex) is untouched: still serves its static list.
    (vertex,) = [e for e in catalog["providers"] if e["provider"] == "google-cloud"]
    assert [m["id"] for m in vertex["models"]] == [
        m["id"] for m in MODEL_CATALOG["google-cloud"]["models"]
    ]


# ---------------------------------------------------------------------------
# OpenAI dynamic catalog
# ---------------------------------------------------------------------------

_STATIC_OPENAI_IDS = [m["id"] for m in MODEL_CATALOG["openai"]["models"]]


class _FakeOpenAIClient:
    """Monkeypatched httpx.AsyncClient serving a canned /v1/models payload."""

    payload: object = {"object": "list", "data": []}
    error: Exception | None = None

    def __init__(self, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def get(self, url, headers=None):
        if self.error is not None:
            raise self.error
        assert url == "https://api.openai.com/v1/models"
        assert headers == {"Authorization": "Bearer test-openai-key"}

        class FakeResponse:
            def __init__(self, payload):
                self._payload = payload

            def raise_for_status(self):
                if isinstance(self._payload, Exception):
                    raise self._payload

            def json(self):
                return self._payload

        return FakeResponse(type(self).payload)


def _openai_client(monkeypatch, payload, error=None):
    """Install _FakeOpenAIClient with the given payload/transport error."""
    _FakeOpenAIClient.payload = payload
    _FakeOpenAIClient.error = error
    monkeypatch.setattr("app.agent.models.httpx.AsyncClient", _FakeOpenAIClient)


def _openai_env(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")


async def test_openai_model_catalog_filters_and_maps(tmp_path, monkeypatch):
    """v1/models rows become openai:<id> entries; non-chat models drop."""
    _openai_env(tmp_path, monkeypatch)
    _openai_client(
        monkeypatch,
        {
            "object": "list",
            "data": [
                {"id": "gpt-7.0", "object": "model", "created": 1, "owned_by": "openai"},
                {"id": "o5-mini", "object": "model", "created": 1, "owned_by": "openai"},
                {
                    "id": "chatgpt-6-latest",
                    "object": "model",
                    "created": 1,
                    "owned_by": "openai",
                },
                # Non-chat families the endpoint also lists: all dropped.
                {"id": "dall-e-3", "object": "model", "created": 1, "owned_by": "openai"},
                {"id": "whisper-1", "object": "model", "created": 1, "owned_by": "openai"},
                {
                    "id": "text-embedding-3-large",
                    "object": "model",
                    "created": 1,
                    "owned_by": "openai",
                },
                # Starts with 'o' but is not an o-series reasoning model.
                {
                    "id": "omni-moderation-latest",
                    "object": "model",
                    "created": 1,
                    "owned_by": "openai",
                },
                # Legacy completions-only models.
                {"id": "davinci-002", "object": "model", "created": 1, "owned_by": "openai"},
            ],
        },
    )
    models = await openai_model_catalog()
    dynamic = models[:3]
    assert [m["id"] for m in dynamic] == [
        "openai:gpt-7.0",
        "openai:o5-mini",
        "openai:chatgpt-6-latest",
    ]
    # The API returns no display names or context windows: name falls back to
    # the model id, max_context stays None.
    assert dynamic[0]["name"] == "gpt-7.0"
    assert dynamic[0]["max_context"] is None
    # o-series reasoning can't turn thinking off; gpt-*/chatgpt-* get all levels.
    assert dynamic[0]["thinking_levels"] == ["off", "low", "medium", "high"]
    assert dynamic[1]["thinking_levels"] == ["low", "medium", "high"]
    assert dynamic[2]["thinking_levels"] == ["off", "low", "medium", "high"]
    # Static flagships the API didn't return are appended, dedup'd by id.
    assert [m["id"] for m in models[3:]] == _STATIC_OPENAI_IDS
    assert len({m["id"] for m in models}) == len(models)


async def test_openai_model_catalog_static_merge_and_dedup(tmp_path, monkeypatch):
    """A static entry the API also returns keeps all its curated fields."""
    _openai_env(tmp_path, monkeypatch)
    _openai_client(
        monkeypatch,
        {
            "object": "list",
            "data": [
                # Matches the static `openai:gpt-5.5` id: the API carries no
                # display fields, so name/thinking/max_context all come from
                # the curated static row.
                {"id": "gpt-5.5", "object": "model", "created": 1, "owned_by": "openai"},
            ],
        },
    )
    models = await openai_model_catalog()
    by_id = {m["id"]: m for m in models}
    merged = by_id["openai:gpt-5.5"]
    assert merged["name"] == "GPT-5.5"
    assert merged["thinking_levels"] == ["off", "low", "medium", "high"]
    assert merged["max_context"] == 400_000
    # Each static id appears exactly once, API-returned ones in dynamic position.
    assert models[0]["id"] == "openai:gpt-5.5"
    assert sorted(m["id"] for m in models[1:]) == sorted(
        i for i in _STATIC_OPENAI_IDS if i != "openai:gpt-5.5"
    )


async def test_openai_model_catalog_offline_falls_back_to_static(
    tmp_path, monkeypatch
):
    """Transport errors, non-200s, and malformed payloads all yield the static list."""
    _openai_env(tmp_path, monkeypatch)
    static = MODEL_CATALOG["openai"]["models"]

    _openai_client(monkeypatch, None, error=httpx.ConnectError("refused"))
    assert await openai_model_catalog() == list(static)

    _openai_client(monkeypatch, None, error=httpx.ReadTimeout("slow"))
    assert await openai_model_catalog() == list(static)

    # Non-200: raise_for_status throws inside the try block.
    _openai_client(
        monkeypatch,
        httpx.HTTPStatusError(
            "401", request=httpx.Request("GET", "https://x"), response=httpx.Response(401)
        ),
    )
    assert await openai_model_catalog() == list(static)

    _openai_client(monkeypatch, "not even json-shaped")
    assert await openai_model_catalog() == list(static)

    _openai_client(monkeypatch, {"unexpected": "shape"})
    assert await openai_model_catalog() == list(static)


async def test_openai_model_catalog_no_key_returns_static(tmp_path, monkeypatch):
    """No openai_api_key -> static list, and the HTTP fetch never runs."""
    _openai_env(tmp_path, monkeypatch)
    monkeypatch.delenv("OPENAI_API_KEY")
    _openai_client(monkeypatch, None, error=httpx.ConnectError("must not be called"))
    assert await openai_model_catalog() == list(MODEL_CATALOG["openai"]["models"])


def test_models_openai_dynamic_in_endpoint(client, monkeypatch):
    """With a key, GET /api/models serves the openai section's dynamic rows."""
    test_client, _ = client
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")

    async def dynamic() -> list:
        return [
            {
                "id": "openai:gpt-7.0",
                "name": "gpt-7.0",
                "thinking_levels": ["off", "low", "medium", "high"],
                "max_context": None,
            },
        ]

    monkeypatch.setattr("app.agent.models.openai_model_catalog", dynamic)
    catalog = test_client.get("/api/models", headers=AUTH).json()
    (openai,) = [e for e in catalog["providers"] if e["provider"] == "openai"]
    assert openai["label"] == "OpenAI"
    assert [m["id"] for m in openai["models"]] == ["openai:gpt-7.0"]
    # openai-chat is untouched: still serves its static list.
    (chat,) = [e for e in catalog["providers"] if e["provider"] == "openai-chat"]
    assert [m["id"] for m in chat["models"]] == [
        m["id"] for m in MODEL_CATALOG["openai-chat"]["models"]
    ]


# ---------------------------------------------------------------------------
# Anthropic dynamic catalog
# ---------------------------------------------------------------------------

_STATIC_ANTHROPIC_IDS = [m["id"] for m in MODEL_CATALOG["anthropic"]["models"]]


class _FakeAnthropicClient:
    """Monkeypatched httpx.AsyncClient serving a canned /v1/models payload."""

    payload: object = {"data": [], "has_more": False}
    error: Exception | None = None

    def __init__(self, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def get(self, url, headers=None, params=None):
        if self.error is not None:
            raise self.error
        assert url == "https://api.anthropic.com/v1/models"
        assert headers == {
            "x-api-key": "test-anthropic-key",
            "anthropic-version": ANTHROPIC_API_VERSION,
        }
        # limit=1000 pulls the whole Claude catalog in a single page.
        assert params == {"limit": 1000}

        class FakeResponse:
            def __init__(self, payload):
                self._payload = payload

            def raise_for_status(self):
                if isinstance(self._payload, Exception):
                    raise self._payload

            def json(self):
                return self._payload

        return FakeResponse(type(self).payload)


def _anthropic_client(monkeypatch, payload, error=None):
    """Install _FakeAnthropicClient with the given payload/transport error."""
    _FakeAnthropicClient.payload = payload
    _FakeAnthropicClient.error = error
    monkeypatch.setattr("app.agent.models.httpx.AsyncClient", _FakeAnthropicClient)


def _anthropic_env(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-anthropic-key")


async def test_anthropic_model_catalog_filters_and_maps(tmp_path, monkeypatch):
    """v1/models rows become anthropic:<id> entries; non-Claude/retired drop."""
    _anthropic_env(tmp_path, monkeypatch)
    _anthropic_client(
        monkeypatch,
        {
            "data": [
                {
                    "id": "claude-opus-5",
                    "type": "model",
                    "display_name": "Claude Opus 5",
                    "created_at": "2031-01-01T00:00:00Z",
                    "lifecycle": "active",
                    "max_input_tokens": 500_000,
                },
                {
                    # No display_name -> falls back to the model id.
                    "id": "claude-haiku-5",
                    "type": "model",
                    "created_at": "2031-01-01T00:00:00Z",
                    "lifecycle": "active",
                },
                {
                    # Deprecated rows stay out of the new-chat picker.
                    "id": "claude-sonnet-4-0",
                    "type": "model",
                    "display_name": "Claude Sonnet 4.0",
                    "lifecycle": "deprecated",
                },
                {
                    # Retired rows are no longer callable.
                    "id": "claude-2.1",
                    "type": "model",
                    "display_name": "Claude 2.1",
                    "lifecycle": "retired",
                },
                {
                    # A non-Claude id on the account -> dropped.
                    "id": "some-partner-model",
                    "type": "model",
                    "display_name": "Partner Model",
                    "lifecycle": "active",
                },
            ],
            "has_more": False,
        },
    )
    models = await anthropic_model_catalog()
    dynamic = models[:2]
    assert [m["id"] for m in dynamic] == [
        "anthropic:claude-opus-5",
        "anthropic:claude-haiku-5",
    ]
    assert dynamic[0]["name"] == "Claude Opus 5"
    assert dynamic[0]["max_context"] == 500_000
    assert dynamic[1]["name"] == "claude-haiku-5"
    assert dynamic[1]["max_context"] is None
    # Static flagships the API didn't return are appended, dedup'd by id.
    assert [m["id"] for m in models[2:]] == _STATIC_ANTHROPIC_IDS
    assert len({m["id"] for m in models}) == len(models)


async def test_anthropic_model_catalog_static_merge_and_dedup(
    tmp_path, monkeypatch
):
    """A static entry the API also returns keeps its hand-curated thinking levels."""
    _anthropic_env(tmp_path, monkeypatch)
    _anthropic_client(
        monkeypatch,
        {
            "data": [
                {
                    # Matches the static `anthropic:claude-sonnet-4-6` id:
                    # display_name/max_input_tokens come from the API, the
                    # curated thinking_levels win.
                    "id": "claude-sonnet-4-6",
                    "type": "model",
                    "display_name": "Claude Sonnet 4.6 (API name)",
                    "lifecycle": "active",
                    "max_input_tokens": 999_999,
                },
            ],
            "has_more": False,
        },
    )
    models = await anthropic_model_catalog()
    by_id = {m["id"]: m for m in models}
    merged = by_id["anthropic:claude-sonnet-4-6"]
    assert merged["name"] == "Claude Sonnet 4.6 (API name)"
    assert merged["thinking_levels"] == ["off", "low", "medium", "high"]
    assert merged["max_context"] == 999_999  # live max_input_tokens wins
    # Each static id appears exactly once, API-returned ones in dynamic position.
    assert models[0]["id"] == "anthropic:claude-sonnet-4-6"
    assert sorted(m["id"] for m in models[1:]) == sorted(
        i for i in _STATIC_ANTHROPIC_IDS if i != "anthropic:claude-sonnet-4-6"
    )


async def test_anthropic_model_catalog_thinking_capability(tmp_path, monkeypatch):
    """capabilities.thinking/effort both unsupported -> only 'off' offered."""
    _anthropic_env(tmp_path, monkeypatch)
    _unsupported = {"supported": False}
    _anthropic_client(
        monkeypatch,
        {
            "data": [
                {
                    "id": "claude-fast-1",
                    "type": "model",
                    "display_name": "Claude Fast 1",
                    "lifecycle": "active",
                    "capabilities": {
                        "thinking": _unsupported,
                        "effort": _unsupported,
                    },
                },
                {
                    # No capabilities block -> full normalized scale assumed.
                    "id": "claude-next-1",
                    "type": "model",
                    "lifecycle": "active",
                },
            ],
            "has_more": False,
        },
    )
    models = await anthropic_model_catalog()
    by_id = {m["id"]: m for m in models}
    assert by_id["anthropic:claude-fast-1"]["thinking_levels"] == ["off"]
    assert by_id["anthropic:claude-next-1"]["thinking_levels"] == [
        "off",
        "low",
        "medium",
        "high",
    ]


async def test_anthropic_model_catalog_offline_falls_back_to_static(
    tmp_path, monkeypatch
):
    """Transport errors, non-200s, and malformed payloads all yield the static list."""
    _anthropic_env(tmp_path, monkeypatch)
    static = MODEL_CATALOG["anthropic"]["models"]

    _anthropic_client(monkeypatch, None, error=httpx.ConnectError("refused"))
    assert await anthropic_model_catalog() == list(static)

    _anthropic_client(monkeypatch, None, error=httpx.ReadTimeout("slow"))
    assert await anthropic_model_catalog() == list(static)

    # Non-200: raise_for_status throws inside the try block.
    _anthropic_client(
        monkeypatch,
        httpx.HTTPStatusError(
            "403", request=httpx.Request("GET", "https://x"), response=httpx.Response(403)
        ),
    )
    assert await anthropic_model_catalog() == list(static)

    _anthropic_client(monkeypatch, "not even json-shaped")
    assert await anthropic_model_catalog() == list(static)

    _anthropic_client(monkeypatch, {"unexpected": "shape"})
    assert await anthropic_model_catalog() == list(static)


async def test_anthropic_model_catalog_no_key_returns_static(tmp_path, monkeypatch):
    """No anthropic_api_key -> static list, and the HTTP fetch never runs."""
    _anthropic_env(tmp_path, monkeypatch)
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    _anthropic_client(monkeypatch, None, error=httpx.ConnectError("must not be called"))
    assert await anthropic_model_catalog() == list(MODEL_CATALOG["anthropic"]["models"])


def test_models_anthropic_dynamic_in_endpoint(client, monkeypatch):
    """With a key, GET /api/models serves the anthropic section's dynamic rows."""
    test_client, _ = client
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-anthropic-key")

    async def dynamic() -> list:
        return [
            {
                "id": "anthropic:claude-opus-5",
                "name": "Claude Opus 5",
                "thinking_levels": ["off", "low", "medium", "high"],
                "max_context": 500_000,
            },
        ]

    monkeypatch.setattr("app.agent.models.anthropic_model_catalog", dynamic)
    catalog = test_client.get("/api/models", headers=AUTH).json()
    (anthropic,) = [e for e in catalog["providers"] if e["provider"] == "anthropic"]
    assert anthropic["label"] == "Anthropic"
    assert [m["id"] for m in anthropic["models"]] == ["anthropic:claude-opus-5"]


# ---------------------------------------------------------------------------
# PATCH /api/chats/{id} — model/thinking/permission_profile validation
# ---------------------------------------------------------------------------


def test_chat_patch_exposes_new_fields(client):
    """PATCH + nested workspace listing carry model/thinking/permission_profile."""
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])
    assert chat["model"] is None
    assert chat["thinking"] is None
    assert chat["permission_profile"] is None

    patched = _patch_chat(
        test_client,
        chat["id"],
        {
            "model": "anthropic:claude-sonnet-4-6",
            "thinking": "high",
            "permission_profile": "bypass",
        },
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["model"] == "anthropic:claude-sonnet-4-6"
    assert body["thinking"] == "high"
    assert body["permission_profile"] == "bypass"

    # The workspaces listing (what the sidebar/composer hydrates from) shows them.
    nested = test_client.get("/api/workspaces", headers=AUTH).json()[0]["chats"][0]
    assert nested["thinking"] == "high"
    assert nested["permission_profile"] == "bypass"


def test_chat_patch_model_prefix_validation(client):
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    assert _patch_chat(test_client, chat["id"], {"model": "bogus:x"}).status_code == 400
    assert _patch_chat(test_client, chat["id"], {"model": "nocolon"}).status_code == 400
    assert _patch_chat(test_client, chat["id"], {"model": "openai:"}).status_code == 400
    # Known prefixes pass even when the exact model isn't catalog-listed.
    assert _patch_chat(test_client, chat["id"], {"model": "ollama:anything"}).status_code == 200
    # null clears the override.
    cleared = _patch_chat(test_client, chat["id"], {"model": None})
    assert cleared.status_code == 200
    assert cleared.json()["model"] is None


def test_chat_patch_thinking_validation(client):
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)

    # Catalog-known model: thinking must be one of its advertised levels.
    chat = _create_chat(test_client, workspace["id"], {"model": "anthropic:claude-sonnet-4-6"})
    assert _patch_chat(test_client, chat["id"], {"thinking": "high"}).status_code == 200
    assert _patch_chat(test_client, chat["id"], {"thinking": "bogus"}).status_code == 400
    assert _patch_chat(test_client, chat["id"], {"thinking": None}).status_code == 200

    # A model that can't disable reasoning rejects 'off' too.
    gpt = _create_chat(test_client, workspace["id"], {"model": "openai:gpt-6.1-sol"})
    assert _patch_chat(test_client, gpt["id"], {"thinking": "off"}).status_code == 400
    assert _patch_chat(test_client, gpt["id"], {"thinking": "low"}).status_code == 200

    # Non-catalog specs (Ollama, custom ids) take free-form thinking values.
    free = _create_chat(test_client, workspace["id"], {"model": "ollama:custom"})
    assert _patch_chat(test_client, free["id"], {"thinking": "whatever"}).status_code == 200

    # Setting model and thinking together validates against the new model.
    both = _patch_chat(
        test_client,
        chat["id"],
        {"model": "openai:gpt-6.1-sol", "thinking": "off"},
    )
    assert both.status_code == 400


def test_chat_patch_permission_profile(client):
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    patched = _patch_chat(test_client, chat["id"], {"permission_profile": "read-only"})
    assert patched.status_code == 200
    assert patched.json()["permission_profile"] == "read-only"

    # Profile ids are free-form (custom profiles make any string legal;
    # unknown ids resolve to 'manual' at run time). Explicit null clears.
    patched = _patch_chat(test_client, chat["id"], {"permission_profile": "everything"})
    assert patched.status_code == 200
    assert patched.json()["permission_profile"] == "everything"
    # A non-string value is still a schema error.
    assert (
        _patch_chat(test_client, chat["id"], {"permission_profile": 5}).status_code
        == 422
    )
    cleared = _patch_chat(test_client, chat["id"], {"permission_profile": None})
    assert cleared.status_code == 200
    assert cleared.json()["permission_profile"] is None


def test_chat_patch_misc(client):
    """Rename still works, title:null is a 400, empty patch is a no-op, unknown 404."""
    test_client, tmp_path = client
    workspace = _create_workspace(test_client, tmp_path)
    chat = _create_chat(test_client, workspace["id"])

    renamed = _patch_chat(test_client, chat["id"], {"title": "Renamed"})
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "Renamed"

    assert _patch_chat(test_client, chat["id"], {"title": None}).status_code == 400
    assert _patch_chat(test_client, chat["id"], {"bogus": 1}).status_code == 422

    no_op = _patch_chat(test_client, chat["id"], {})
    assert no_op.status_code == 200
    assert no_op.json()["title"] == "Renamed"

    assert _patch_chat(test_client, "nope", {"title": "x"}).status_code == 404


# ---------------------------------------------------------------------------
# spec/catalog helpers
# ---------------------------------------------------------------------------


def test_split_model_spec():
    assert split_model_spec("anthropic:claude-sonnet-4-6") == (
        "anthropic",
        "claude-sonnet-4-6",
    )
    with pytest.raises(UnknownProviderError):
        split_model_spec("bogus:x")
    with pytest.raises(UnknownProviderError):
        split_model_spec("nocolon")
    with pytest.raises(UnknownProviderError):
        split_model_spec("openai:")


def test_catalog_thinking_levels():
    assert catalog_thinking_levels("anthropic:claude-sonnet-4-6") == [
        "off",
        "low",
        "medium",
        "high",
    ]
    assert catalog_thinking_levels("openai:gpt-6.1-sol") == ["low", "medium", "high"]
    assert catalog_thinking_levels("ollama:qwen3") is None
    assert catalog_thinking_levels("anthropic:unlisted-model") is None


# ---------------------------------------------------------------------------
# thinking -> model_settings, profile merge order
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "spec",
    [
        "anthropic:claude-sonnet-4-6",
        "openai:gpt-6.1-terra",
        "google:gemini-4-carbon",
        "ollama:qwen3",
    ],
)
def test_build_run_kwargs_thinking_levels(tmp_path, monkeypatch, spec):
    """Every provider gets the unified ModelSettings.thinking field."""
    from pydantic_ai.models.test import TestModel

    monkeypatch.setattr(
        "app.agent.factory.resolve_model", lambda s: TestModel()
    )
    kwargs = build_run_kwargs(
        {"model": spec, "thinking": "high"}, tmp_path / "ws"
    )
    assert kwargs["model_settings"] == {"thinking": "high"}

    kwargs = build_run_kwargs({"model": spec, "thinking": "off"}, tmp_path / "ws")
    assert kwargs["model_settings"] == {"thinking": False}

    kwargs = build_run_kwargs({"model": spec, "thinking": "low"}, tmp_path / "ws")
    assert kwargs["model_settings"] == {"thinking": "low"}


def test_build_run_kwargs_no_thinking(tmp_path, monkeypatch):
    from pydantic_ai.models.test import TestModel

    monkeypatch.setattr("app.agent.factory.resolve_model", lambda s: TestModel())
    kwargs = build_run_kwargs({"model": "ollama:qwen3"}, tmp_path / "ws")
    assert kwargs["model_settings"] is None


async def test_run_settings_merge_order(tmp_path, monkeypatch):
    """permission_profile merges chat > workspace > global; model + thinking too."""
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "data"))
    from app.db.store import ChatStore

    store = ChatStore(tmp_path / "app.db")
    try:
        workspace = await store.get_or_create_workspace(tmp_path / "ws")
        chat = await store.create_chat(workspace.id)
        await store.set_setting("permission_profile", "manual")
        await store.set_setting("default_model", "anthropic:claude-sonnet-4-6")

        # Global only.
        settings = await _run_settings(store, chat, workspace)
        assert settings["permission_profile"] == "manual"
        assert settings["model"] == "anthropic:claude-sonnet-4-6"
        assert settings["thinking"] is None

        # Workspace beats global.
        await store.set_workspace_permission_profile(workspace.id, "bypass")
        workspace = await store.get_workspace(workspace.id)
        settings = await _run_settings(store, chat, workspace)
        assert settings["permission_profile"] == "bypass"

        # Chat beats workspace.
        await store.update_chat(
            chat.id,
            permission_profile="read-only",
            model="ollama:qwen3",
            thinking="high",
        )
        chat = await store.get_chat(chat.id)
        settings = await _run_settings(store, chat, workspace)
        assert settings["permission_profile"] == "read-only"
        assert settings["model"] == "ollama:qwen3"
        assert settings["thinking"] == "high"

        # Clearing the chat override falls back to workspace/global again.
        await store.update_chat(chat.id, permission_profile=None, model=None)
        chat = await store.get_chat(chat.id)
        settings = await _run_settings(store, chat, workspace)
        assert settings["permission_profile"] == "bypass"
        assert settings["model"] == "anthropic:claude-sonnet-4-6"
    finally:
        store.close()
