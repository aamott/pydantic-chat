"""Tests for the settings REST API: KV round-trip, provider status, secrets file."""

import stat

import pytest
from fastapi.testclient import TestClient

from app.agent.models import DEFAULT_OLLAMA_BASE_URL
from app.config import (
    DEFAULT_MODEL,
    DEFAULT_PERMISSION_PROFILE,
    get_secret,
    secrets_path,
)
from app.main import create_app

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

# Every env var that can feed a provider credential or base URL — cleared per
# test so a developer machine's real keys can't leak into the assertions.
_CREDENTIAL_ENVS = (
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
    """A TestClient over a fresh app backed by a tmp APP_DATA_DIR + APP_TOKEN."""
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("APP_TOKEN", TOKEN)
    for name in _CREDENTIAL_ENVS:
        monkeypatch.delenv(name, raising=False)
    # TrustedHostMiddleware only allows loopback hosts, so the test client must
    # present one too (its default Host header is "testserver").
    with TestClient(create_app(), base_url="http://127.0.0.1") as test_client:
        yield test_client, tmp_path


def _settings(client) -> dict:
    response = client.get("/api/settings", headers=AUTH)
    assert response.status_code == 200
    return response.json()


def _providers(client) -> dict[str, dict]:
    response = client.get("/api/settings/providers", headers=AUTH)
    assert response.status_code == 200
    return {row["provider"]: row for row in response.json()}


def test_settings_defaults(client):
    test_client, _ = client
    assert _settings(test_client) == {
        "theme": "system",
        "default_model": DEFAULT_MODEL,
        "permission_profile": DEFAULT_PERMISSION_PROFILE,
        "allowed_commands": [],
        "denied_commands": [],
        "allowed_patterns": [],
        "denied_patterns": [],
        "ollama_base_url": DEFAULT_OLLAMA_BASE_URL,
        "judge_model": "anthropic:claude-haiku-4-5",
    }


def test_settings_bulk_put_merges_and_round_trips(client):
    test_client, _ = client
    response = test_client.put(
        "/api/settings",
        json={
            "theme": "dark",
            "default_model": "openai:gpt-5",
            "permission_profile": "smart",
            "allowed_commands": ["git status", "ls"],
            "denied_patterns": ["**/.env", "**/secrets/**"],
            "judge_model": "ollama:qwen3",
        },
        headers=AUTH,
    )
    assert response.status_code == 200
    settings = response.json()
    assert settings["theme"] == "dark"
    assert settings["default_model"] == "openai:gpt-5"
    assert settings["permission_profile"] == "smart"
    assert settings["allowed_commands"] == ["git status", "ls"]
    assert settings["denied_patterns"] == ["**/.env", "**/secrets/**"]
    assert settings["judge_model"] == "ollama:qwen3"

    # A later PUT only touches the keys it carries — merge, not replace.
    response = test_client.put("/api/settings", json={"theme": "light"}, headers=AUTH)
    assert response.status_code == 200
    settings = _settings(test_client)
    assert settings["theme"] == "light"
    assert settings["default_model"] == "openai:gpt-5"
    assert settings["denied_patterns"] == ["**/.env", "**/secrets/**"]

    # An explicit null resets a key to its default.
    response = test_client.put(
        "/api/settings", json={"default_model": None}, headers=AUTH
    )
    assert response.status_code == 200
    assert _settings(test_client)["default_model"] == DEFAULT_MODEL


def test_settings_single_key_put(client):
    test_client, _ = client
    response = test_client.put(
        "/api/settings/theme", json={"value": "dark"}, headers=AUTH
    )
    assert response.status_code == 200
    assert response.json()["theme"] == "dark"

    response = test_client.put(
        "/api/settings/allowed_patterns",
        json={"value": ["src/**", "docs/**"]},
        headers=AUTH,
    )
    assert response.status_code == 200
    assert response.json()["allowed_patterns"] == ["src/**", "docs/**"]

    # null resets to default; unknown keys and wrong types are 400s.
    response = test_client.put(
        "/api/settings/theme", json={"value": None}, headers=AUTH
    )
    assert response.status_code == 200
    assert response.json()["theme"] == "system"
    assert (
        test_client.put(
            "/api/settings/nope", json={"value": "x"}, headers=AUTH
        ).status_code
        == 400
    )
    assert (
        test_client.put(
            "/api/settings/allowed_commands",
            json={"value": "ls"},
            headers=AUTH,
        ).status_code
        == 400
    )
    assert (
        test_client.put(
            "/api/settings/theme", json={"value": ["dark"]}, headers=AUTH
        ).status_code
        == 400
    )


def test_ollama_base_url_round_trip(client):
    test_client, _ = client
    response = test_client.put(
        "/api/settings",
        json={"ollama_base_url": "http://gpu-box:11434"},
        headers=AUTH,
    )
    assert response.status_code == 200
    assert response.json()["ollama_base_url"] == "http://gpu-box:11434"
    # It lands where resolve_model actually reads it: the secrets store.
    assert get_secret("ollama_base_url") == "http://gpu-box:11434"

    response = test_client.put(
        "/api/settings", json={"ollama_base_url": None}, headers=AUTH
    )
    assert response.status_code == 200
    assert _settings(test_client)["ollama_base_url"] == DEFAULT_OLLAMA_BASE_URL


def test_providers_env_vs_file_source(client, monkeypatch):
    test_client, _ = client
    providers = _providers(test_client)
    # Ollama is always configured (local, no key); nothing else has credentials.
    assert providers["ollama"] == {
        "provider": "ollama",
        "configured": True,
        "has_key": False,
        "source": None,
    }
    assert providers["anthropic"] == {
        "provider": "anthropic",
        "configured": False,
        "has_key": False,
        "source": None,
    }
    assert set(providers) == {
        "anthropic",
        "openai",
        "openai-chat",
        "google",
        "google-cloud",
        "ollama",
        "openai-compatible",
    }

    # An env-provided key reports source="env" and makes the provider configured.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env-only")
    providers = _providers(test_client)
    assert providers["anthropic"]["has_key"] is True
    assert providers["anthropic"]["source"] == "env"
    assert providers["anthropic"]["configured"] is True

    # A key written through the API reports source="file" (file wins over env).
    response = test_client.put(
        "/api/settings/secrets/anthropic", json={"key": "sk-file"}, headers=AUTH
    )
    assert response.status_code == 200
    assert response.json()["source"] == "file"
    providers = _providers(test_client)
    assert providers["anthropic"]["source"] == "file"


def test_secrets_set_hidden_deleted_and_file_mode(client):
    test_client, _ = client
    response = test_client.put(
        "/api/settings/secrets/openai",
        json={"key": "sk-super-secret-123"},
        headers=AUTH,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["has_key"] is True
    assert body["source"] == "file"
    assert "sk-super-secret-123" not in response.text

    # The secrets file exists, is owner-only, and holds the key.
    path = secrets_path()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert "sk-super-secret-123" in path.read_text(encoding="utf-8")

    # Nothing readable over the API ever contains key material.
    assert "sk-super-secret-123" not in test_client.get(
        "/api/settings", headers=AUTH
    ).text
    assert "sk-super-secret-123" not in test_client.get(
        "/api/settings/providers", headers=AUTH
    ).text
    # openai and openai-chat share OPENAI_API_KEY — both become configured.
    providers = _providers(test_client)
    assert providers["openai"]["configured"] is True
    assert providers["openai-chat"]["configured"] is True
    assert get_secret("openai_api_key") == "sk-super-secret-123"

    response = test_client.delete(
        "/api/settings/secrets/openai", headers=AUTH
    )
    assert response.status_code == 204
    assert get_secret("openai_api_key") is None
    assert "sk-super-secret-123" not in path.read_text(encoding="utf-8")
    providers = _providers(test_client)
    assert providers["openai"] == {
        "provider": "openai",
        "configured": False,
        "has_key": False,
        "source": None,
    }


def test_openai_compatible_needs_base_url(client):
    test_client, _ = client
    providers = _providers(test_client)
    assert providers["openai-compatible"]["configured"] is False

    response = test_client.put(
        "/api/settings/secrets/openai-compatible",
        json={"key": "sk-anything", "base_url": "https://llm.internal/v1"},
        headers=AUTH,
    )
    assert response.status_code == 200
    assert response.json()["configured"] is True

    # DELETE clears the whole credential blob — base URL included.
    assert (
        test_client.delete(
            "/api/settings/secrets/openai-compatible", headers=AUTH
        ).status_code
        == 204
    )
    assert _providers(test_client)["openai-compatible"]["configured"] is False
    assert get_secret("openai_compatible_base_url") is None


def test_settings_validation_errors(client):
    test_client, _ = client
    bad_bodies = (
        {"default_model": "bogus:model"},  # unknown provider prefix
        {"default_model": "no-colon"},
        {"judge_model": "unknown:x"},
        {"permission_profile": "yolo"},
        {"theme": "neon"},
        {"ollama_base_url": "ftp://nope"},
        {"allowed_paths": ["x"]},  # unknown key — extras are forbidden
    )
    for body in bad_bodies:
        response = test_client.put("/api/settings", json=body, headers=AUTH)
        assert response.status_code in (400, 422), (body, response.status_code)

    # A string where a list is required is a schema error.
    assert (
        test_client.put(
            "/api/settings", json={"allowed_commands": "ls"}, headers=AUTH
        ).status_code
        == 422
    )
    # Secrets route validates the provider prefix and requires a payload.
    assert (
        test_client.put(
            "/api/settings/secrets/not-a-provider",
            json={"key": "x"},
            headers=AUTH,
        ).status_code
        == 400
    )
    assert (
        test_client.put(
            "/api/settings/secrets/anthropic", json={}, headers=AUTH
        ).status_code
        == 400
    )
    assert (
        test_client.put(
            "/api/settings/secrets/anthropic",
            json={"key": "   "},
            headers=AUTH,
        ).status_code
        == 400
    )
    assert (
        test_client.put(
            "/api/settings/secrets/anthropic",
            json={"base_url": "http://x"},
            headers=AUTH,
        ).status_code
        == 400
    )


def test_settings_routes_require_bearer_token(client):
    test_client, _ = client
    assert test_client.get("/api/settings").status_code == 401
    assert test_client.get("/api/settings/providers").status_code == 401
    assert test_client.put("/api/settings", json={}).status_code == 401
    assert (
        test_client.put(
            "/api/settings/secrets/anthropic", json={"key": "x"}
        ).status_code
        == 401
    )
    assert test_client.delete("/api/settings/secrets/anthropic").status_code == 401
