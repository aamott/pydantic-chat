"""Tests for app.agent (provider registry, capability wiring) and app.config secrets."""

import stat

import pytest
from pydantic_ai.capabilities import LocalWorkspace
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.google_cloud import GoogleCloudProvider
from pydantic_ai.providers.openai_compatible import OpenAICompatibleProvider
from pydantic_ai.usage import UsageLimits
from pydantic_ai.workspaces import LocalWorkspaceBackend
from pydantic_ai_harness import ApprovalReviewer, Coder, Permissions, Planning
from pydantic_ai_harness.filesystem import FileSystem
from pydantic_ai_harness.shell import Shell

from app.agent.factory import (
    PermissionLists,
    build_run_kwargs,
    get_agent,
    resolve_permission_capabilities,
)
from app.agent.models import (
    ProviderNotConfigured,
    UnknownProviderError,
    configured_providers,
    resolve_model,
)
from app.config import (
    DEFAULT_MODEL,
    get_secret,
    resolve_model_name,
    save_settings,
    secrets_path,
    set_secret,
)
from app.db.store import ChatStore

PROVIDER_ENVS = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "OLLAMA_BASE_URL",
    "OLLAMA_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "OPENAI_COMPATIBLE_BASE_URL",
    "OPENAI_COMPATIBLE_API_KEY",
]


@pytest.fixture(autouse=True)
def isolated_config(tmp_path, monkeypatch):
    """Point APP_DATA_DIR at tmp and strip every provider env var."""
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path))
    for name in PROVIDER_ENVS:
        monkeypatch.delenv(name, raising=False)
    return tmp_path


def _leaf_capabilities(capability, seen=None):
    """Yield every leaf capability in a (possibly combined) tree."""
    seen = seen or set()
    if id(capability) in seen:
        return
    seen.add(id(capability))
    children = getattr(capability, "capabilities", None)
    if children is None:
        yield capability
        return
    for child in children:
        yield from _leaf_capabilities(child, seen)


# ---------------------------------------------------------------------------
# Provider registry
# ---------------------------------------------------------------------------


def test_resolve_anthropic():
    # No key configured anywhere -> typed error, not a crash.
    with pytest.raises(ProviderNotConfigured):
        resolve_model("anthropic:claude-sonnet-4-6")
    set_secret("anthropic_api_key", "sk-ant-test")
    model = resolve_model("anthropic:claude-sonnet-4-6")
    assert isinstance(model, AnthropicModel)
    assert model.model_name == "claude-sonnet-4-6"


def test_resolve_openai_variants():
    set_secret("openai_api_key", "sk-test")
    assert isinstance(resolve_model("openai:gpt-5"), OpenAIResponsesModel)
    assert isinstance(resolve_model("openai-chat:gpt-5"), OpenAIChatModel)


def test_resolve_google_variants():
    set_secret("google_api_key", "g-test")
    google = resolve_model("google:gemini-2.5-flash")
    assert isinstance(google, GoogleModel)
    assert isinstance(google.provider, GoogleProvider)
    cloud = resolve_model("google-cloud:gemini-2.5-flash")
    assert isinstance(cloud, GoogleModel)
    assert isinstance(cloud.provider, GoogleCloudProvider)


def test_resolve_ollama_defaults_and_base_url():
    model = resolve_model("ollama:qwen3")
    assert isinstance(model, OllamaModel)
    set_secret("ollama_base_url", "http://example.internal:11434")
    model = resolve_model("ollama:qwen3")
    assert str(model.client.base_url).rstrip("/") == "http://example.internal:11434"


def test_resolve_openai_compatible_escape_hatch():
    with pytest.raises(ProviderNotConfigured):
        resolve_model("openai-compatible:my-model")
    set_secret("openai_compatible_base_url", "http://localhost:9000/v1")
    model = resolve_model("openai-compatible:my-model")
    assert isinstance(model, OpenAIChatModel)
    assert isinstance(model.provider, OpenAICompatibleProvider)


def test_missing_key_raises_typed_error():
    with pytest.raises(ProviderNotConfigured) as excinfo:
        resolve_model("openai:gpt-5")
    assert excinfo.value.provider == "openai"
    assert "OPENAI_API_KEY" in str(excinfo.value)


def test_unknown_provider_prefix():
    with pytest.raises(UnknownProviderError):
        resolve_model("bogus:model")
    with pytest.raises(UnknownProviderError):
        resolve_model("no-prefix")


def test_configured_providers():
    assert "anthropic" not in configured_providers()
    set_secret("anthropic_api_key", "sk-ant-test")
    providers = configured_providers()
    assert "anthropic" in providers
    assert "openai" not in providers
    assert "ollama" in providers  # local default needs no key


def test_secret_env_fallback_and_file_precedence(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env")
    assert get_secret("anthropic_api_key") == "sk-env"
    set_secret("anthropic_api_key", "sk-file")
    assert get_secret("anthropic_api_key") == "sk-file"


# ---------------------------------------------------------------------------
# Secrets file
# ---------------------------------------------------------------------------


def test_secrets_file_mode_600_and_roundtrip():
    set_secret("openai_api_key", "sk-roundtrip")
    path = secrets_path()
    assert path.exists()
    mode = stat.S_IMODE(path.stat().st_mode)
    assert mode == 0o600
    assert get_secret("openai_api_key") == "sk-roundtrip"
    set_secret("openai_api_key", None)
    assert get_secret("openai_api_key") is None
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


# ---------------------------------------------------------------------------
# Capability wiring
# ---------------------------------------------------------------------------


def test_agent_output_type_includes_deferred_requests():
    """``_AGENT`` can pause a run on approval-required calls instead of erroring.

    The adapter auto-adds ``DeferredToolRequests`` to the run output type only
    for client-supplied toolsets; calls deferred by run *capabilities* (the
    ``manual`` profile's ``Permissions``) need it declared on the agent itself,
    or the run dies with ``UserError`` when it pauses.
    """
    from pydantic_ai import DeferredToolRequests

    assert DeferredToolRequests in get_agent().output_type


def _chat_settings(**overrides):
    base = {"model": "anthropic:claude-sonnet-4-6"}
    base.update(overrides)
    return base


def test_build_run_kwargs_contents(tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    set_secret("anthropic_api_key", "sk-ant-test")

    kwargs = build_run_kwargs(_chat_settings(), workspace)
    assert set(kwargs) == {
        "model",
        "capabilities",
        "instructions",
        "workspace",
        "usage_limits",
        "model_settings",
    }
    assert isinstance(kwargs["model"], AnthropicModel)
    assert isinstance(kwargs["workspace"], LocalWorkspaceBackend)
    assert kwargs["workspace"].ref.id == str(workspace)
    assert isinstance(kwargs["usage_limits"], UsageLimits)
    # No `thinking` override -> no model_settings (the model keeps its default).
    assert kwargs["model_settings"] is None
    assert kwargs["usage_limits"].request_limit == 50

    capabilities = kwargs["capabilities"]
    assert any(isinstance(c, LocalWorkspace) for c in capabilities)
    assert any(isinstance(c, Coder) for c in capabilities)
    assert any(isinstance(c, Planning) for c in capabilities)
    assert any(isinstance(c, Permissions) for c in capabilities)


def test_run_kwargs_carry_file_link_and_run_meta(tmp_path):
    """`file:`-link instructions + the run-meta Hooks ride in every run."""
    from pydantic_ai.capabilities import Hooks

    set_secret("anthropic_api_key", "sk-ant-test")
    kwargs = build_run_kwargs(_chat_settings(permission_profile="bypass"), tmp_path)
    # The instruction names the exact wire spellings the renderer intercepts.
    assert "file:" in kwargs["instructions"]
    assert "file:src/app.py:12" in kwargs["instructions"]
    assert any(isinstance(c, Hooks) for c in kwargs["capabilities"])


def test_read_only_profile_has_no_shell(tmp_path):
    caps = resolve_permission_capabilities("read-only")
    all_leaves = [leaf for cap in caps for leaf in _leaf_capabilities(cap)]
    file_systems = [c for c in all_leaves if isinstance(c, FileSystem)]
    assert file_systems
    assert all(fs.read_only for fs in file_systems)
    assert not any(isinstance(c, Shell) for c in all_leaves)
    permissions = [c for c in caps if isinstance(c, Permissions)]
    assert permissions
    assert permissions[0].mode == "read-only"


def test_deny_list_passes_through_to_shell():
    caps = resolve_permission_capabilities(
        "manual", PermissionLists(denied_commands=["rm", "sudo"])
    )
    coder = next(c for c in caps if isinstance(c, Coder))
    shells = [c for c in _leaf_capabilities(coder) if isinstance(c, Shell)]
    assert shells
    assert set(shells[0].denied_commands) == {"rm", "sudo"}


def test_allow_list_filters_denied_commands():
    caps = resolve_permission_capabilities(
        "bypass",
        PermissionLists(allowed_commands=["ls", "rm"], denied_commands=["rm"]),
    )
    coder = next(c for c in caps if isinstance(c, Coder))
    shells = [c for c in _leaf_capabilities(coder) if isinstance(c, Shell)]
    assert shells[0].allowed_commands == ["ls"]
    assert shells[0].denied_commands == []


def test_bypass_profile_full_permissions():
    caps = resolve_permission_capabilities("bypass")
    permissions = [c for c in caps if isinstance(c, Permissions)]
    assert permissions
    assert permissions[0].mode == "full"


def test_unknown_profile_falls_back_to_manual():
    caps = resolve_permission_capabilities("bogus")
    permissions = [c for c in caps if isinstance(c, Permissions)]
    assert permissions
    assert permissions[0].mode == "read-only"


def test_smart_profile_falls_back_to_manual_without_judge():
    caps = resolve_permission_capabilities("smart")
    permissions = [c for c in caps if isinstance(c, Permissions)]
    # No anthropic key for the default haiku judge -> manual fallback.
    assert permissions
    assert permissions[0].mode == "read-only"


def test_smart_profile_uses_given_judge_model():
    """A ``Model`` instance as ``judge_model`` builds the reviewer directly."""
    judge = TestModel()
    caps = resolve_permission_capabilities("smart", judge_model=judge)
    reviewer = next((c for c in caps if isinstance(c, ApprovalReviewer)), None)
    assert reviewer is not None, "smart profile built no ApprovalReviewer"
    assert reviewer.model is judge
    permissions = [c for c in caps if isinstance(c, Permissions)]
    assert permissions
    assert permissions[0].mode == "auto"


def test_build_run_kwargs_smart_defaults_judge_to_run_model(tmp_path):
    """A configured run model supplies the judge when ``judge_model`` is unset.

    Regression for the reported bug: a user with only a Google key gets
    ``ProviderNotConfigured`` resolving the anthropic ``SMART_DEFAULT_JUDGE``,
    so ``smart`` silently fell back to ``manual`` and every command asked.
    The run's own model is configured by definition — it judges instead.
    """
    set_secret("google_api_key", "g-test")  # anthropic stays unconfigured
    kwargs = build_run_kwargs(
        _chat_settings(model="google:gemini-2.5-flash", permission_profile="smart"),
        tmp_path,
    )
    capabilities = kwargs["capabilities"]
    reviewer = next((c for c in capabilities if isinstance(c, ApprovalReviewer)), None)
    assert reviewer is not None, (
        "smart profile fell back to manual despite a configured run model"
    )
    assert reviewer.model is kwargs["model"]  # the run's own resolved model
    permissions = [c for c in capabilities if isinstance(c, Permissions)]
    assert permissions
    assert permissions[0].mode == "auto"


def test_build_run_kwargs_explicit_judge_model_wins(tmp_path):
    """A ``judge_model`` setting outranks the run model for the reviewer."""
    set_secret("google_api_key", "g-test")
    kwargs = build_run_kwargs(
        _chat_settings(
            model="google:gemini-2.5-flash",
            permission_profile="smart",
            judge_model="ollama:qwen3",  # ollama resolves without a key
        ),
        tmp_path,
    )
    reviewer = next(
        c for c in kwargs["capabilities"] if isinstance(c, ApprovalReviewer)
    )
    assert isinstance(reviewer.model, OllamaModel)


def test_build_run_kwargs_broken_explicit_judge_falls_back_to_run_model(
    tmp_path,
):
    """An unresolvable ``judge_model`` setting degrades to the run model.

    Regression for the settings round-trip bug: ``GET /api/settings`` echoed
    ``SMART_DEFAULT_JUDGE`` as the judge default and the form wrote it back
    as an explicit setting, so a user with no anthropic key hit
    ``ProviderNotConfigured`` → silent ``manual`` fallback on every smart
    run. The run's own model is configured by definition — it judges instead.
    """
    set_secret("google_api_key", "g-test")  # anthropic stays unconfigured
    kwargs = build_run_kwargs(
        _chat_settings(
            model="google:gemini-2.5-flash",
            permission_profile="smart",
            judge_model="anthropic:claude-haiku-4-5",  # persisted echo
        ),
        tmp_path,
    )
    capabilities = kwargs["capabilities"]
    reviewer = next((c for c in capabilities if isinstance(c, ApprovalReviewer)), None)
    assert reviewer is not None, (
        "broken explicit judge_model degraded smart to manual "
        "instead of judging with the run model"
    )
    assert reviewer.model is kwargs["model"]  # the run's own resolved model
    permissions = [c for c in capabilities if isinstance(c, Permissions)]
    assert permissions
    assert permissions[0].mode == "auto"


# ---------------------------------------------------------------------------
# resolve_model_name
# ---------------------------------------------------------------------------


async def test_resolve_model_name_precedence(tmp_path):
    store = ChatStore(tmp_path / "app.db")
    try:
        ws = await store.get_or_create_workspace(tmp_path / "ws")
        chat = await store.create_chat(ws.id, model="openai:gpt-5")
        assert await resolve_model_name(chat, store) == "openai:gpt-5"

        bare = await store.create_chat(ws.id)
        await save_settings("default_model", "google:gemini-2.5-flash", store)
        assert await resolve_model_name(bare, store) == "google:gemini-2.5-flash"
    finally:
        store.close()

    empty = ChatStore(tmp_path / "other.db")
    try:
        assert await resolve_model_name(None, empty) == DEFAULT_MODEL
    finally:
        empty.close()
