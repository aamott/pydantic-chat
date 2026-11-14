"""Tests for MCP server support: spec validation, REST CRUD, run-kwargs wiring.

Storage is the ``mcp_servers`` key of the settings KV table (a JSON list of
``MCPServerSpec`` dicts). Run-side, each *enabled* spec becomes an
``MCPToolset`` (stdio via ``StdioTransport``, http via URL + headers) prefixed
with the server name, wrapped in a resilient outer layer so an unreachable
server warns and contributes no tools instead of breaking the run, and —
outside ``bypass`` — an ``ApprovalRequiredToolset`` so its calls join the same
deferred-approval flow ``Permissions`` uses.
"""

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from pydantic_ai import RunContext
from pydantic_ai.capabilities import Toolset
from pydantic_ai.models.test import TestModel
from pydantic_ai.toolsets import (
    AbstractToolset,
    ApprovalRequiredToolset,
    FunctionToolset,
)
from pydantic_ai.toolsets.prefixed import PrefixedToolset
from pydantic_ai.usage import RunUsage

from app.agent.factory import ToolAllowlist, build_run_kwargs
from app.api.chat import _run_settings
from app.api.schemas import MCPServerSpec
from app.config import set_secret
from app.db.store import ChatStore
from app.main import create_app
from app.mcp_servers import (
    MCP_SERVERS_KEY,
    ResilientToolset,
    apply_mcp_mask,
    build_mcp_capabilities,
    load_mcp_servers,
    parse_mcp_mask,
    parse_mcp_servers,
    save_mcp_servers,
)

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

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
    with TestClient(create_app(), base_url="http://127.0.0.1") as test_client:
        yield test_client, tmp_path


@pytest.fixture
def isolated_config(tmp_path, monkeypatch):
    """Point APP_DATA_DIR at tmp and strip every provider env var."""
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path))
    for name in _CREDENTIAL_ENVS:
        monkeypatch.delenv(name, raising=False)
    return tmp_path


def _stdio_server(**overrides):
    spec = {
        "name": "fs-tools",
        "transport": "stdio",
        "command": "uvx",
        "args": ["mcp-server-fs"],
        "enabled": True,
    }
    spec.update(overrides)
    return spec


def _http_server(**overrides):
    spec = {
        "name": "web-tools",
        "transport": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": {"Authorization": "Bearer test"},
        "enabled": True,
    }
    spec.update(overrides)
    return spec


def _walk(toolset):
    """Yield a toolset and every nested ``wrapped`` layer, outermost first."""
    seen = set()
    while toolset is not None and id(toolset) not in seen:
        seen.add(id(toolset))
        yield toolset
        toolset = getattr(toolset, "wrapped", None)


def _mcp_capabilities(kwargs):
    """The MCP-providing capabilities inside a ``build_run_kwargs`` result."""
    return [
        cap
        for cap in kwargs["capabilities"]
        if isinstance(cap, Toolset) and isinstance(cap.toolset, ResilientToolset)
    ]


# ---------------------------------------------------------------------------
# Spec validation
# ---------------------------------------------------------------------------


def test_stdio_spec_requires_command():
    with pytest.raises(ValidationError):
        MCPServerSpec.model_validate({"name": "x", "transport": "stdio"})


def test_http_spec_requires_url():
    with pytest.raises(ValidationError):
        MCPServerSpec.model_validate({"name": "x", "transport": "http"})


def test_spec_rejects_unknown_transport():
    with pytest.raises(ValidationError):
        MCPServerSpec.model_validate(
            {"name": "x", "transport": "sse", "url": "http://x"}
        )


def test_spec_rejects_unknown_keys():
    with pytest.raises(ValidationError):
        MCPServerSpec.model_validate({**_stdio_server(), "bogus": True})


def test_spec_rejects_name_with_slash():
    """Names address servers in URL paths — a slash would break routing."""
    with pytest.raises(ValidationError):
        MCPServerSpec.model_validate(_stdio_server(name="a/b"))


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------


def test_mcp_servers_empty_by_default(client):
    test_client, _ = client
    response = test_client.get("/api/mcp-servers", headers=AUTH)
    assert response.status_code == 200
    assert response.json() == []


def test_mcp_server_crud_roundtrip(client):
    test_client, _ = client

    created = test_client.post("/api/mcp-servers", json=_stdio_server(), headers=AUTH)
    assert created.status_code == 201
    servers = created.json()
    assert len(servers) == 1
    assert servers[0]["name"] == "fs-tools"
    assert servers[0]["transport"] == "stdio"
    assert servers[0]["command"] == "uvx"
    assert servers[0]["enabled"] is True

    listed = test_client.get("/api/mcp-servers", headers=AUTH)
    assert listed.status_code == 200
    assert [s["name"] for s in listed.json()] == ["fs-tools"]

    toggled = test_client.patch(
        "/api/mcp-servers/fs-tools", json={"enabled": False}, headers=AUTH
    )
    assert toggled.status_code == 200
    assert toggled.json()[0]["enabled"] is False
    # Untouched fields survive the patch.
    assert toggled.json()[0]["command"] == "uvx"

    deleted = test_client.delete("/api/mcp-servers/fs-tools", headers=AUTH)
    assert deleted.status_code == 204
    assert test_client.get("/api/mcp-servers", headers=AUTH).json() == []


def test_mcp_server_post_validation_errors(client):
    test_client, _ = client
    missing_command = test_client.post(
        "/api/mcp-servers",
        json={"name": "bad", "transport": "stdio"},
        headers=AUTH,
    )
    assert 400 <= missing_command.status_code < 500

    missing_url = test_client.post(
        "/api/mcp-servers",
        json={"name": "bad", "transport": "http"},
        headers=AUTH,
    )
    assert 400 <= missing_url.status_code < 500


def test_mcp_server_duplicate_name_conflict(client):
    test_client, _ = client
    assert (
        test_client.post(
            "/api/mcp-servers", json=_stdio_server(), headers=AUTH
        ).status_code
        == 201
    )
    duplicate = test_client.post(
        "/api/mcp-servers", json=_http_server(name="fs-tools"), headers=AUTH
    )
    assert duplicate.status_code == 409


def test_mcp_server_patch_and_delete_unknown_404(client):
    test_client, _ = client
    patched = test_client.patch(
        "/api/mcp-servers/nope", json={"enabled": False}, headers=AUTH
    )
    assert patched.status_code == 404
    deleted = test_client.delete("/api/mcp-servers/nope", headers=AUTH)
    assert deleted.status_code == 404


def test_mcp_server_patch_revalidates(client):
    """A patch can't leave a spec invalid (e.g. clearing a required field)."""
    test_client, _ = client
    test_client.post("/api/mcp-servers", json=_stdio_server(), headers=AUTH)
    response = test_client.patch(
        "/api/mcp-servers/fs-tools", json={"command": None}, headers=AUTH
    )
    assert 400 <= response.status_code < 500


def test_mcp_servers_require_auth(client):
    test_client, _ = client
    assert test_client.get("/api/mcp-servers").status_code == 401


async def test_mcp_servers_store_roundtrip(isolated_config):
    """The settings-table store layer round-trips specs verbatim."""
    store = ChatStore()
    try:
        assert await load_mcp_servers(store) == []
        specs = [
            MCPServerSpec.model_validate(_stdio_server(env={"KEY": "secret"})),
            MCPServerSpec.model_validate(_http_server(enabled=False)),
        ]
        await save_mcp_servers(store, specs)
        raw = await store.get_settings()
        assert MCP_SERVERS_KEY in raw
        loaded = await load_mcp_servers(store)
        assert [s.name for s in loaded] == ["fs-tools", "web-tools"]
        assert loaded[0].env == {"KEY": "secret"}
        assert loaded[1].enabled is False
    finally:
        store.close()


# ---------------------------------------------------------------------------
# Parsing (settings table -> specs)
# ---------------------------------------------------------------------------


def test_parse_mcp_servers_skips_malformed_entries():
    raw = [
        _stdio_server(),
        {"name": "broken", "transport": "stdio"},  # missing command
        "not-a-dict",
        _http_server(),
    ]
    specs = parse_mcp_servers(raw)
    assert [s.name for s in specs] == ["fs-tools", "web-tools"]


def test_parse_mcp_servers_handles_garbage():
    assert parse_mcp_servers(None) == []
    assert parse_mcp_servers("oops") == []
    assert parse_mcp_servers([]) == []


# ---------------------------------------------------------------------------
# Capability construction + build_run_kwargs wiring
# ---------------------------------------------------------------------------


def test_build_mcp_capabilities_enabled_only():
    specs = [
        MCPServerSpec.model_validate(_stdio_server()),
        MCPServerSpec.model_validate(_http_server(enabled=False)),
    ]
    caps = build_mcp_capabilities(specs, gate=True)
    assert len(caps) == 1
    assert isinstance(caps[0], Toolset)
    layers = list(_walk(caps[0].toolset))
    assert isinstance(layers[0], ResilientToolset)
    assert any(isinstance(layer, PrefixedToolset) for layer in layers)


def test_build_mcp_capabilities_gate_wraps_approval():
    """Gated servers route every call through ``ApprovalRequiredToolset``.

    ``Permissions`` itself only intercepts file-write kinds and shell-command
    tools, so MCP calls would otherwise run ungated in every profile — the
    wrapper puts them in the same ``DeferredToolRequests`` approval flow.
    """
    specs = [MCPServerSpec.model_validate(_stdio_server())]
    gated = build_mcp_capabilities(specs, gate=True)
    assert any(
        isinstance(layer, ApprovalRequiredToolset) for layer in _walk(gated[0].toolset)
    )
    ungated = build_mcp_capabilities(specs, gate=False)
    assert not any(
        isinstance(layer, ApprovalRequiredToolset)
        for layer in _walk(ungated[0].toolset)
    )


def test_build_mcp_capabilities_prefixes_tool_names():
    specs = [MCPServerSpec.model_validate(_http_server())]
    caps = build_mcp_capabilities(specs, gate=False)
    prefixed = next(
        layer for layer in _walk(caps[0].toolset) if isinstance(layer, PrefixedToolset)
    )
    assert prefixed.prefix == "web-tools"


def test_build_mcp_capabilities_construction_failure_skips(monkeypatch):
    """A spec whose toolset can't be built warns and is skipped, not raised."""

    # build_mcp_capabilities imports MCPToolset lazily inside the function,
    # so the name resolves on pydantic_ai.mcp at call time.
    def boom(*args, **kwargs):
        raise RuntimeError("cannot build")

    monkeypatch.setattr("pydantic_ai.mcp.MCPToolset", boom)
    specs = [
        MCPServerSpec.model_validate(_stdio_server()),
        MCPServerSpec.model_validate(_http_server()),
    ]
    caps = build_mcp_capabilities(specs, gate=True)
    assert caps == []


def test_build_run_kwargs_includes_enabled_mcp_servers(isolated_config):
    set_secret("anthropic_api_key", "sk-ant-test")
    settings = {
        "model": "anthropic:claude-sonnet-4-6",
        "permission_profile": "manual",
        # chat.py's _decode_setting leaves the settings-table JSON as a
        # list of dicts — exactly what build_run_kwargs receives.
        "mcp_servers": [
            _stdio_server(),
            _http_server(enabled=False),
        ],
    }
    kwargs = build_run_kwargs(settings, isolated_config / "ws")
    mcp_caps = _mcp_capabilities(kwargs)
    assert len(mcp_caps) == 1


def test_build_run_kwargs_no_mcp_servers(isolated_config):
    set_secret("anthropic_api_key", "sk-ant-test")
    kwargs = build_run_kwargs(
        {"model": "anthropic:claude-sonnet-4-6"}, isolated_config / "ws"
    )
    assert _mcp_capabilities(kwargs) == []


def test_build_run_kwargs_bypass_leaves_mcp_ungated(isolated_config):
    set_secret("anthropic_api_key", "sk-ant-test")
    settings = {
        "model": "anthropic:claude-sonnet-4-6",
        "permission_profile": "bypass",
        "mcp_servers": [_stdio_server()],
    }
    kwargs = build_run_kwargs(settings, isolated_config / "ws")
    mcp_caps = _mcp_capabilities(kwargs)
    assert len(mcp_caps) == 1
    assert not any(
        isinstance(layer, ApprovalRequiredToolset)
        for layer in _walk(mcp_caps[0].toolset)
    )


# ---------------------------------------------------------------------------
# Failure isolation at run time
# ---------------------------------------------------------------------------


class _DeadToolset(AbstractToolset):
    """A toolset whose server can never be reached."""

    @property
    def id(self):
        return "dead"

    async def __aenter__(self):
        raise RuntimeError("connection refused")

    async def __aexit__(self, *args):
        raise RuntimeError("connection refused")

    async def get_tools(self, ctx):
        raise RuntimeError("connection refused")

    async def call_tool(self, name, tool_args, ctx, tool):
        raise RuntimeError("connection refused")


async def test_resilient_toolset_swallows_connect_failure():
    """A server that fails to enter contributes no tools and exits cleanly."""
    toolset = ResilientToolset(wrapped=_DeadToolset(), server_name="dead")
    async with toolset:  # must not raise
        pass
    assert await toolset.get_tools(ctx=None) == {}


# ---------------------------------------------------------------------------
# Per-workspace masks (workspaces.mcp_overrides — a name -> enabled JSON map)
# ---------------------------------------------------------------------------


def _tool_profile(**overrides):
    """A valid custom-profile payload for run-kwargs tests."""
    body = {
        "id": "reviewer",
        "name": "Code reviewer",
        "description": "Subset profile",
        "approval_mode": "manual",
        "workspace_read_only": False,
        "tools": None,
        "tool_prefixes": [],
        "skills": None,
    }
    body.update(overrides)
    return body


def _run_ctx() -> RunContext:
    """A minimal run context — enough for toolset ``get_tools`` calls."""
    return RunContext(deps=None, model=TestModel(), usage=RunUsage())


def _toolset_with(*names: str) -> FunctionToolset:
    """A FunctionToolset exposing one no-op tool per name."""
    toolset = FunctionToolset()
    for name in names:
        toolset.add_function(lambda: "", name=name)
    return toolset


def _specs(**flags: bool) -> list[MCPServerSpec]:
    """The two fixture servers with per-name enabled flags (default on)."""
    return [
        MCPServerSpec.model_validate(
            _stdio_server(enabled=flags.get("fs-tools", True))
        ),
        MCPServerSpec.model_validate(
            _http_server(enabled=flags.get("web-tools", True))
        ),
    ]


def _enabled_flags(specs: list[MCPServerSpec]) -> dict[str, bool]:
    return {spec.name: spec.enabled for spec in specs}


def test_parse_mcp_mask_normalizes_decoded_values():
    assert parse_mcp_mask(None) is None
    assert parse_mcp_mask("oops") is None
    assert parse_mcp_mask([]) is None
    assert parse_mcp_mask({"a": True, "b": False}) == {"a": True, "b": False}
    assert parse_mcp_mask({}) == {}
    # Non-bool values are dropped so a corrupt row can't silently flip a flag.
    assert parse_mcp_mask({"a": "yes", "b": 1, "c": False}) == {"c": False}


def test_apply_mcp_mask_unset_returns_specs_verbatim():
    """No mask (NULL column) inherits the global flags exactly."""
    specs = _specs(**{"web-tools": False})
    assert apply_mcp_mask(specs, None) == specs


def test_apply_mcp_mask_partial_override():
    """A named entry replaces that spec's flag; the rest are untouched."""
    masked = apply_mcp_mask(_specs(), {"fs-tools": False})
    assert _enabled_flags(masked) == {"fs-tools": False, "web-tools": True}


def test_apply_mcp_mask_true_reenables_globally_disabled():
    """``true`` is a real override — it may un-disable a global server."""
    masked = apply_mcp_mask(_specs(**{"fs-tools": False}), {"fs-tools": True})
    assert _enabled_flags(masked) == {"fs-tools": True, "web-tools": True}


def test_apply_mcp_mask_unknown_names_ignored():
    """Stale entries (deleted/renamed servers) change nothing."""
    specs = _specs()
    masked = apply_mcp_mask(specs, {"gone": False, "also-gone": True})
    assert _enabled_flags(masked) == {"fs-tools": True, "web-tools": True}


def test_apply_mcp_mask_empty_dict_is_inherit():
    masked = apply_mcp_mask(_specs(**{"fs-tools": False}), {})
    assert _enabled_flags(masked) == {"fs-tools": False, "web-tools": True}


def test_build_run_kwargs_workspace_mask_filters_servers(isolated_config):
    """``mcp_overrides`` in chat_settings cuts masked-out servers from the run."""
    set_secret("anthropic_api_key", "sk-ant-test")
    settings = {
        "model": "anthropic:claude-sonnet-4-6",
        "permission_profile": "manual",
        "mcp_servers": [_stdio_server(), _http_server()],
        "mcp_overrides": {"fs-tools": False},
    }
    kwargs = build_run_kwargs(settings, isolated_config / "ws")
    mcp_caps = _mcp_capabilities(kwargs)
    assert [cap.toolset.server_name for cap in mcp_caps] == ["web-tools"]


def test_build_run_kwargs_workspace_mask_all_disabled(isolated_config):
    set_secret("anthropic_api_key", "sk-ant-test")
    settings = {
        "model": "anthropic:claude-sonnet-4-6",
        "permission_profile": "manual",
        "mcp_servers": [_stdio_server(), _http_server()],
        "mcp_overrides": {"fs-tools": False, "web-tools": False},
    }
    kwargs = build_run_kwargs(settings, isolated_config / "ws")
    assert _mcp_capabilities(kwargs) == []


def test_build_run_kwargs_mask_unknown_names_still_ignored(isolated_config):
    """A mask naming only stale servers leaves every global server in."""
    set_secret("anthropic_api_key", "sk-ant-test")
    settings = {
        "model": "anthropic:claude-sonnet-4-6",
        "mcp_servers": [_stdio_server()],
        "mcp_overrides": {"deleted-server": False},
    }
    kwargs = build_run_kwargs(settings, isolated_config / "ws")
    assert [cap.toolset.server_name for cap in _mcp_capabilities(kwargs)] == [
        "fs-tools"
    ]


async def test_profile_prefixes_still_gate_masked_in_servers(isolated_config):
    """The mask admits a capability; ``tool_prefixes`` still gate its tools.

    A masked-in server not named by the profile's ``tool_prefixes`` keeps its
    toolset capability (it exists, gated or not) but the assembled-toolset
    ``FilteredToolset`` drops its tools — masking can never widen a profile.
    """
    set_secret("anthropic_api_key", "sk-ant-test")
    settings = {
        "model": "anthropic:claude-sonnet-4-6",
        "permission_profile": "reviewer",
        "tool_profiles": [_tool_profile(tool_prefixes=["fs-tools_*"])],
        "mcp_servers": [_stdio_server(), _http_server()],
        # Mask set but empty — both servers admitted by the workspace layer.
        "mcp_overrides": {},
    }
    kwargs = build_run_kwargs(settings, isolated_config / "ws")
    assert len(_mcp_capabilities(kwargs)) == 2
    allowlist = next(c for c in kwargs["capabilities"] if isinstance(c, ToolAllowlist))
    assert allowlist.prefixes == frozenset({"fs-tools_"})
    filtered = allowlist.get_wrapper_toolset(
        _toolset_with("read_file", "fs-tools_read", "web-tools_search")
    )
    tools = await filtered.get_tools(_run_ctx())
    # Only the prefixed server's tools survive: web-tools' tools are dropped
    # (no prefix), and so is read_file (the profile declared prefixes only —
    # tools=None keeps an empty exact-name allowlist).
    assert sorted(tools) == ["fs-tools_read"]


async def test_run_settings_workspace_mcp_mask(tmp_path, monkeypatch):
    """workspace.mcp_overrides feeds the run settings; NULL means inherit."""
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "data"))
    store = ChatStore(tmp_path / "app.db")
    try:
        workspace = await store.get_or_create_workspace(tmp_path / "ws")
        chat = await store.create_chat(workspace.id)

        settings = await _run_settings(store, chat, workspace)
        assert settings.get("mcp_overrides") is None

        await store.set_workspace_mcp_overrides(workspace.id, {"fs-tools": False})
        workspace = await store.get_workspace(workspace.id)
        settings = await _run_settings(store, chat, workspace)
        assert settings["mcp_overrides"] == {"fs-tools": False}
    finally:
        store.close()


# ---------------------------------------------------------------------------
# Workspace-masked reads: /api/mcp-servers + /api/tool-catalog ?workspace_id=
# ---------------------------------------------------------------------------


def _create_workspace(test_client, path) -> dict:
    response = test_client.post(
        "/api/workspaces", json={"path": str(path)}, headers=AUTH
    )
    assert response.status_code == 200
    return response.json()


def _register_servers(test_client) -> None:
    assert (
        test_client.post(
            "/api/mcp-servers", json=_stdio_server(), headers=AUTH
        ).status_code
        == 201
    )
    assert (
        test_client.post(
            "/api/mcp-servers", json=_http_server(), headers=AUTH
        ).status_code
        == 201
    )


def test_mcp_servers_list_reflects_workspace_mask(client):
    """?workspace_id= reports the effective (masked) enabled flags."""
    test_client, tmp_path = client
    _register_servers(test_client)
    workspace = _create_workspace(test_client, tmp_path / "ws")
    patched = test_client.patch(
        f"/api/workspaces/{workspace['id']}",
        json={"mcp_overrides": {"fs-tools": False}},
        headers=AUTH,
    )
    assert patched.status_code == 200

    masked = test_client.get(
        f"/api/mcp-servers?workspace_id={workspace['id']}", headers=AUTH
    )
    assert masked.status_code == 200
    assert _enabled_flags([MCPServerSpec.model_validate(s) for s in masked.json()]) == {
        "fs-tools": False,
        "web-tools": True,
    }

    # The global registry itself is untouched — the mask is read-time only.
    global_list = test_client.get("/api/mcp-servers", headers=AUTH).json()
    assert all(s["enabled"] for s in global_list)


def test_mcp_servers_list_unknown_workspace_404(client):
    test_client, _ = client
    assert (
        test_client.get("/api/mcp-servers?workspace_id=nope", headers=AUTH).status_code
        == 404
    )


def test_tool_catalog_reflects_workspace_mask(client):
    """Masked-out servers lose their ``{name}_*`` prefix entry for that workspace."""
    test_client, tmp_path = client
    _register_servers(test_client)
    workspace = _create_workspace(test_client, tmp_path / "ws")
    test_client.patch(
        f"/api/workspaces/{workspace['id']}",
        json={"mcp_overrides": {"fs-tools": False}},
        headers=AUTH,
    )

    masked = test_client.get(
        f"/api/tool-catalog?workspace_id={workspace['id']}", headers=AUTH
    ).json()
    prefixes = {e["name"] for e in masked if e["group"] == "mcp"}
    assert "web-tools_*" in prefixes
    assert "fs-tools_*" not in prefixes

    unscoped = test_client.get("/api/tool-catalog", headers=AUTH).json()
    unscoped_prefixes = {e["name"] for e in unscoped if e["group"] == "mcp"}
    assert {"fs-tools_*", "web-tools_*"} <= unscoped_prefixes

    assert (
        test_client.get("/api/tool-catalog?workspace_id=nope", headers=AUTH).status_code
        == 404
    )
