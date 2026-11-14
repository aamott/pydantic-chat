"""Tests for tool profiles: model, settings-KV persistence, REST CRUD, run wiring.

Profiles are data: builtins are constants merged at read time over the custom
list stored as JSON under ``settings['tool_profiles']`` (mirroring
``mcp_servers``). ``build_run_kwargs`` resolves a ``ToolProfile`` — approval
mode -> ``Permissions``/``ApprovalReviewer``, ``workspace_read_only`` ->
``LocalWorkspace(read_only=)``, ``tools``/``tool_prefixes`` -> a
``ToolAllowlist`` capability wrapping the assembled toolset in
``FilteredToolset`` (always exempting ``load_capability``), and ``skills`` ->
``Skills`` capabilities (``None`` = all discovered, ``[]`` = none at all).
"""

import asyncio
import json

import pytest
from fastapi.testclient import TestClient
from pydantic_ai import RunContext
from pydantic_ai.models.test import TestModel
from pydantic_ai.toolsets import FilteredToolset, FunctionToolset
from pydantic_ai.usage import RunUsage
from pydantic_ai_harness import ApprovalReviewer, Coder, Permissions
from pydantic_ai_harness.filesystem import FileSystem
from pydantic_ai_harness.repo_context import RepoContext
from pydantic_ai_harness.shell import Shell
from pydantic_ai_harness.skills import Skills

from app.agent.factory import (
    ToolAllowlist,
    build_run_kwargs,
    get_agent,
    resolve_permission_capabilities,
)
from app.api.chat import _run_settings
from app.config import set_secret
from app.db.store import ChatStore
from app.main import create_app
from app.profiles import (
    BUILTIN_PROFILES,
    TOOL_PROFILES_KEY,
    ToolProfile,
    load_tool_profiles,
    parse_tool_profiles,
    resolve_tool_profile,
    save_tool_profiles,
    system_skills_dir,
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


def _profile_body(**overrides):
    """A valid custom-profile payload; keyword args override fields."""
    body = {
        "id": "reviewer",
        "name": "Code reviewer",
        "description": "Read tools and the plan only",
        "approval_mode": "manual",
        "workspace_read_only": False,
        "tools": ["read_file", "list_files", "grep"],
        "tool_prefixes": [],
        "skills": None,
    }
    body.update(overrides)
    return body


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


def _run_ctx() -> RunContext:
    """A minimal run context — enough for toolset ``get_tools`` calls."""
    return RunContext(deps=None, model=TestModel(), usage=RunUsage())


def _toolset_with(*names: str) -> FunctionToolset:
    """A FunctionToolset exposing one no-op tool per name."""
    toolset = FunctionToolset()
    for name in names:
        toolset.add_function(lambda: "", name=name)
    return toolset


# ---------------------------------------------------------------------------
# ToolProfile model + settings-KV persistence
# ---------------------------------------------------------------------------


def test_builtin_profiles_match_legacy_ids():
    """The four builtins carry the legacy ``permission_profile`` values."""
    by_id = {profile.id: profile for profile in BUILTIN_PROFILES}
    assert set(by_id) == {"bypass", "smart", "manual", "read-only"}
    assert all(profile.builtin for profile in BUILTIN_PROFILES)
    assert by_id["bypass"].approval_mode == "bypass"
    assert by_id["smart"].approval_mode == "smart"
    assert by_id["manual"].approval_mode == "manual"
    assert by_id["read-only"].approval_mode == "manual"
    assert by_id["read-only"].workspace_read_only is True
    assert by_id["read-only"].tools == [
        "read_file",
        "list_files",
        "grep",
        "write_plan",
        "read_plan",
        "add_task",
        "update_task_status",
        "update_task_statuses",
        "remove_task",
    ]


async def test_tool_profiles_store_roundtrip(isolated_config):
    """Custom profiles persist as one JSON row, exactly like ``mcp_servers``."""
    store = ChatStore()
    try:
        assert await load_tool_profiles(store) == []
        profiles = [ToolProfile.model_validate(_profile_body())]
        await save_tool_profiles(store, profiles)
        raw = await store.get_settings()
        assert json.loads(raw[TOOL_PROFILES_KEY])[0]["id"] == "reviewer"
        loaded = await load_tool_profiles(store)
        assert loaded == profiles
        assert loaded[0].builtin is False
        # An empty list deletes the row rather than storing "[]".
        await save_tool_profiles(store, [])
        assert TOOL_PROFILES_KEY not in await store.get_settings()
    finally:
        store.close()


def test_parse_tool_profiles_skips_malformed_entries():
    raw = [
        _profile_body(),
        {"name": "no id"},  # missing required id
        "not-a-dict",
        _profile_body(id="second", name="Second"),
    ]
    profiles = parse_tool_profiles(raw)
    assert [p.id for p in profiles] == ["reviewer", "second"]
    assert parse_tool_profiles(None) == []
    assert parse_tool_profiles("oops") == []


# ---------------------------------------------------------------------------
# resolve_tool_profile
# ---------------------------------------------------------------------------


def test_resolve_tool_profile_builtin(isolated_config):
    profile = resolve_tool_profile({"permission_profile": "bypass"})
    assert profile.id == "bypass"
    assert profile.builtin is True
    assert profile.approval_mode == "bypass"


def test_resolve_tool_profile_unknown_falls_back_to_manual(isolated_config):
    profile = resolve_tool_profile({"permission_profile": "does-not-exist"})
    assert profile.id == "manual"
    assert profile.builtin is True


def test_resolve_tool_profile_missing_defaults_to_manual(isolated_config):
    assert resolve_tool_profile({}).id == "manual"


def test_resolve_tool_profile_custom(isolated_config):
    settings = {
        "permission_profile": "reviewer",
        # _run_settings JSON-decodes the settings row back into a list of dicts.
        "tool_profiles": [_profile_body()],
    }
    profile = resolve_tool_profile(settings)
    assert profile.id == "reviewer"
    assert profile.builtin is False
    assert profile.tools == ["read_file", "list_files", "grep"]


def test_resolve_tool_profile_custom_beats_nothing(isolated_config):
    """Custom ids can never shadow builtins — builtin wins either way."""
    settings = {
        "permission_profile": "manual",
        "tool_profiles": [_profile_body(id="manual")],
    }
    assert resolve_tool_profile(settings).builtin is True


# ---------------------------------------------------------------------------
# REST API — CRUD
# ---------------------------------------------------------------------------


def _profiles(client) -> list[dict]:
    response = client.get("/api/tool-profiles", headers=AUTH)
    assert response.status_code == 200
    return response.json()


def test_tool_profiles_lists_builtins(client):
    test_client, _ = client
    profiles = _profiles(test_client)
    by_id = {p["id"]: p for p in profiles}
    assert set(by_id) == {"bypass", "smart", "manual", "read-only"}
    assert all(p["builtin"] for p in profiles)
    assert by_id["read-only"]["workspace_read_only"] is True


def test_tool_profile_crud_roundtrip(client):
    test_client, _ = client
    created = test_client.post("/api/tool-profiles", json=_profile_body(), headers=AUTH)
    assert created.status_code == 201
    profiles = created.json()
    custom = next(p for p in profiles if p["id"] == "reviewer")
    assert custom["builtin"] is False
    assert custom["tools"] == ["read_file", "list_files", "grep"]

    updated = test_client.put(
        "/api/tool-profiles/reviewer",
        json=_profile_body(name="Renamed", skills=["commit-helper"]),
        headers=AUTH,
    )
    assert updated.status_code == 200
    custom = next(p for p in updated.json() if p["id"] == "reviewer")
    assert custom["name"] == "Renamed"
    assert custom["skills"] == ["commit-helper"]

    deleted = test_client.delete("/api/tool-profiles/reviewer", headers=AUTH)
    assert deleted.status_code == 204
    assert "reviewer" not in {p["id"] for p in _profiles(test_client)}


def test_tool_profile_builtins_are_immutable(client):
    test_client, _ = client
    for profile_id in ("bypass", "smart", "manual", "read-only"):
        assert (
            test_client.put(
                f"/api/tool-profiles/{profile_id}",
                json=_profile_body(id=profile_id),
                headers=AUTH,
            ).status_code
            == 403
        )
        assert (
            test_client.delete(
                f"/api/tool-profiles/{profile_id}", headers=AUTH
            ).status_code
            == 403
        )
        # A custom profile may not claim a builtin id either.
        assert (
            test_client.post(
                "/api/tool-profiles",
                json=_profile_body(id=profile_id),
                headers=AUTH,
            ).status_code
            == 409
        )


def test_tool_profile_post_validation(client):
    test_client, _ = client
    # approval_mode outside the three modes is a schema error.
    assert (
        test_client.post(
            "/api/tool-profiles",
            json=_profile_body(approval_mode="yolo"),
            headers=AUTH,
        ).status_code
        == 422
    )
    # Missing name / malformed id shapes are rejected.
    bad = _profile_body()
    del bad["name"]
    assert (
        test_client.post("/api/tool-profiles", json=bad, headers=AUTH).status_code
        == 422
    )
    assert (
        test_client.post(
            "/api/tool-profiles",
            json=_profile_body(id="has/slash"),
            headers=AUTH,
        ).status_code
        == 422
    )


def test_tool_profile_duplicate_id_conflict(client):
    test_client, _ = client
    assert (
        test_client.post(
            "/api/tool-profiles", json=_profile_body(), headers=AUTH
        ).status_code
        == 201
    )
    assert (
        test_client.post(
            "/api/tool-profiles", json=_profile_body(), headers=AUTH
        ).status_code
        == 409
    )


def test_tool_profile_put_delete_unknown_404(client):
    test_client, _ = client
    assert (
        test_client.put(
            "/api/tool-profiles/nope",
            json=_profile_body(id="nope"),
            headers=AUTH,
        ).status_code
        == 404
    )
    assert (
        test_client.delete("/api/tool-profiles/nope", headers=AUTH).status_code == 404
    )


def test_tool_profiles_require_auth(client):
    test_client, _ = client
    assert test_client.get("/api/tool-profiles").status_code == 401
    assert (
        test_client.post("/api/tool-profiles", json=_profile_body()).status_code == 401
    )


# ---------------------------------------------------------------------------
# GET /api/tool-catalog
# ---------------------------------------------------------------------------


def test_tool_catalog_static_tools(client):
    test_client, _ = client
    response = test_client.get("/api/tool-catalog", headers=AUTH)
    assert response.status_code == 200
    entries = response.json()
    by_name = {entry["name"]: entry for entry in entries}
    # The Coder file surface, the persistent shell, and the Planning set.
    for name in ("read_file", "write_file", "edit_file", "list_files", "grep"):
        assert by_name[name]["group"] == "filesystem"
        assert by_name[name]["prefix"] is False
        assert by_name[name]["description"]
    assert by_name["shell"]["group"] == "shell"
    for name in (
        "write_plan",
        "read_plan",
        "add_task",
        "update_task_status",
        "update_task_statuses",
        "remove_task",
    ):
        assert by_name[name]["group"] == "planning"
    # Framework tools are not user-selectable.
    assert "load_capability" not in by_name


def test_tool_catalog_lists_enabled_mcp_prefixes(client):
    test_client, _ = client
    enabled = test_client.post(
        "/api/mcp-servers",
        json={
            "name": "testserver",
            "transport": "http",
            "url": "https://mcp.example.com/mcp",
        },
        headers=AUTH,
    )
    assert enabled.status_code == 201
    test_client.post(
        "/api/mcp-servers",
        json={
            "name": "disabled-server",
            "transport": "http",
            "url": "https://mcp.example.com/off",
            "enabled": False,
        },
        headers=AUTH,
    )
    entries = test_client.get("/api/tool-catalog", headers=AUTH).json()
    prefixes = {entry["name"]: entry for entry in entries if entry["group"] == "mcp"}
    assert prefixes["testserver_*"]["prefix"] is True
    assert "disabled-server_*" not in prefixes


# ---------------------------------------------------------------------------
# GET /api/skills
# ---------------------------------------------------------------------------


def test_skills_endpoint_returns_seeded_system_skill(client):
    test_client, _ = client
    response = test_client.get("/api/skills", headers=AUTH)
    assert response.status_code == 200
    body = response.json()
    by_name = {skill["name"]: skill for skill in body["skills"]}
    assert "commit-helper" in by_name
    assert by_name["commit-helper"]["origin"] == "system"
    assert by_name["commit-helper"]["description"]


def test_skills_endpoint_includes_workspace_library(client, tmp_path):
    test_client, _ = client
    ws_root = tmp_path / "ws"
    skill_dir = ws_root / ".claude" / "skills" / "local-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: local-skill\ndescription: A workspace-local skill.\n---\nBody.\n",
        encoding="utf-8",
    )
    workspace = test_client.post(
        "/api/workspaces", json={"path": str(ws_root)}, headers=AUTH
    ).json()

    response = test_client.get(
        f"/api/skills?workspace_id={workspace['id']}", headers=AUTH
    )
    assert response.status_code == 200
    by_name = {skill["name"]: skill for skill in response.json()["skills"]}
    assert by_name["local-skill"]["origin"] == "workspace"
    assert by_name["commit-helper"]["origin"] == "system"

    # An unknown workspace id is a 404, not a silent system-only listing.
    assert (
        test_client.get("/api/skills?workspace_id=nope", headers=AUTH).status_code
        == 404
    )


# ---------------------------------------------------------------------------
# ToolAllowlist capability
# ---------------------------------------------------------------------------


async def test_tool_allowlist_drops_disallowed_tools():
    allowlist = ToolAllowlist(allowed=frozenset({"read_file", "list_files"}))
    toolset = _toolset_with("read_file", "write_file", "shell", "list_files")
    filtered = allowlist.get_wrapper_toolset(toolset)
    assert isinstance(filtered, FilteredToolset)
    tools = await filtered.get_tools(_run_ctx())
    assert sorted(tools) == ["list_files", "read_file"]


async def test_tool_allowlist_always_keeps_load_capability():
    """``load_capability`` must survive or skills can never be loaded."""
    allowlist = ToolAllowlist(allowed=frozenset({"read_file"}))
    toolset = _toolset_with("read_file", "load_capability")
    tools = await allowlist.get_wrapper_toolset(toolset).get_tools(_run_ctx())
    assert sorted(tools) == ["load_capability", "read_file"]


async def test_tool_allowlist_prefixes_match_mcp_names():
    """``{server}_*`` prefixes admit a whole MCP server's tools."""
    allowlist = ToolAllowlist(
        allowed=frozenset({"read_file"}),
        prefixes=frozenset({"testserver_"}),
    )
    toolset = _toolset_with("read_file", "shell", "testserver_search", "other_search")
    tools = await allowlist.get_wrapper_toolset(toolset).get_tools(_run_ctx())
    assert sorted(tools) == ["read_file", "testserver_search"]


async def test_tool_allowlist_no_prefixes_blocks_mcp():
    allowlist = ToolAllowlist(allowed=frozenset({"read_file"}))
    toolset = _toolset_with("read_file", "testserver_search")
    tools = await allowlist.get_wrapper_toolset(toolset).get_tools(_run_ctx())
    assert sorted(tools) == ["read_file"]


# ---------------------------------------------------------------------------
# build_run_kwargs — profile resolution + capability assembly
# ---------------------------------------------------------------------------


def _chat_settings(**overrides):
    base = {"model": "anthropic:claude-sonnet-4-6"}
    base.update(overrides)
    return base


def test_build_run_kwargs_custom_profile_allowlists_tools(isolated_config):
    set_secret("anthropic_api_key", "sk-ant-test")
    kwargs = build_run_kwargs(
        _chat_settings(
            permission_profile="reviewer",
            tool_profiles=[_profile_body()],
        ),
        isolated_config / "ws",
    )
    capabilities = kwargs["capabilities"]
    allowlist = next(c for c in capabilities if isinstance(c, ToolAllowlist))
    assert allowlist.allowed == frozenset({"read_file", "list_files", "grep"})
    assert allowlist.prefixes == frozenset()
    # approval_mode 'manual' -> Permissions('read-only'); Coder still supplies
    # the tool surface the allowlist then cuts down.
    permissions = [c for c in capabilities if isinstance(c, Permissions)]
    assert permissions and permissions[0].mode == "read-only"
    assert any(isinstance(c, Coder) for c in capabilities)


def test_build_run_kwargs_no_allowlist_for_default_profile(isolated_config):
    set_secret("anthropic_api_key", "sk-ant-test")
    kwargs = build_run_kwargs(_chat_settings(), isolated_config / "ws")
    assert not any(isinstance(c, ToolAllowlist) for c in kwargs["capabilities"])


def test_build_run_kwargs_workspace_read_only_flag(isolated_config):
    set_secret("anthropic_api_key", "sk-ant-test")
    profile = _profile_body(workspace_read_only=True)
    kwargs = build_run_kwargs(
        _chat_settings(permission_profile="reviewer", tool_profiles=[profile]),
        isolated_config / "ws",
    )
    from pydantic_ai.capabilities import LocalWorkspace

    workspace_cap = next(
        c for c in kwargs["capabilities"] if isinstance(c, LocalWorkspace)
    )
    assert workspace_cap.read_only is True


def test_build_run_kwargs_custom_bypass_mode(isolated_config):
    """A custom profile can choose approval_mode 'bypass' (no MCP gate)."""
    set_secret("anthropic_api_key", "sk-ant-test")
    profile = _profile_body(approval_mode="bypass", tools=None)
    kwargs = build_run_kwargs(
        _chat_settings(
            permission_profile="reviewer",
            tool_profiles=[profile],
            mcp_servers=[
                {
                    "name": "testserver",
                    "transport": "http",
                    "url": "https://mcp.example.com/mcp",
                }
            ],
        ),
        isolated_config / "ws",
    )
    from pydantic_ai.capabilities import Toolset
    from pydantic_ai.toolsets import ApprovalRequiredToolset

    from app.mcp_servers import ResilientToolset

    mcp_caps = [
        c
        for c in kwargs["capabilities"]
        if isinstance(c, Toolset) and isinstance(c.toolset, ResilientToolset)
    ]
    assert len(mcp_caps) == 1
    toolset = mcp_caps[0].toolset
    while toolset is not None:
        assert not isinstance(toolset, ApprovalRequiredToolset)
        toolset = getattr(toolset, "wrapped", None)


def test_build_run_kwargs_smart_approval_mode_adds_reviewer(isolated_config):
    set_secret("anthropic_api_key", "sk-ant-test")
    profile = _profile_body(approval_mode="smart")
    kwargs = build_run_kwargs(
        _chat_settings(permission_profile="reviewer", tool_profiles=[profile]),
        isolated_config / "ws",
    )
    reviewer = next(
        (c for c in kwargs["capabilities"] if isinstance(c, ApprovalReviewer)),
        None,
    )
    assert reviewer is not None
    assert reviewer.model is kwargs["model"]
    permissions = [c for c in kwargs["capabilities"] if isinstance(c, Permissions)]
    assert permissions[0].mode == "auto"


async def test_run_toolset_is_filtered_by_profile(isolated_config):
    """A real run under the custom profile only sees the allowlisted tools."""
    set_secret("anthropic_api_key", "sk-ant-test")
    kwargs = build_run_kwargs(
        _chat_settings(
            permission_profile="reviewer",
            tool_profiles=[_profile_body()],
        ),
        isolated_config,
    )
    model = TestModel(call_tools=[])
    await get_agent().run(
        "hi",
        model=model,
        capabilities=kwargs["capabilities"],
        workspace=kwargs["workspace"],
        instructions=kwargs["instructions"],
        usage_limits=kwargs["usage_limits"],
    )
    names = {tool.name for tool in model.last_model_request_parameters.function_tools}
    assert {"read_file", "list_files", "grep"} <= names
    assert "shell" not in names
    assert "write_file" not in names
    assert "edit_file" not in names
    assert "write_plan" not in names
    # Skills exist (the seeded system skill) -> the loader tool is offered.
    assert "load_capability" in names


# ---------------------------------------------------------------------------
# build_run_kwargs — skills wiring
# ---------------------------------------------------------------------------


def _skills_caps(kwargs):
    return [c for c in kwargs["capabilities"] if isinstance(c, Skills)]


def test_skills_none_includes_all(isolated_config):
    set_secret("anthropic_api_key", "sk-ant-test")
    kwargs = build_run_kwargs(_chat_settings(), isolated_config / "ws")
    skills = _skills_caps(kwargs)
    assert len(skills) == 2  # workspace-local + system library
    assert all(cap.include is None for cap in skills)


def test_skills_empty_list_omits_capability(isolated_config):
    set_secret("anthropic_api_key", "sk-ant-test")
    kwargs = build_run_kwargs(
        _chat_settings(
            permission_profile="reviewer",
            tool_profiles=[_profile_body(skills=[])],
        ),
        isolated_config / "ws",
    )
    assert _skills_caps(kwargs) == []


def test_skills_list_includes_subset(isolated_config):
    set_secret("anthropic_api_key", "sk-ant-test")
    kwargs = build_run_kwargs(
        _chat_settings(
            permission_profile="reviewer",
            tool_profiles=[_profile_body(skills=["commit-helper", "gone"])],
        ),
        isolated_config / "ws",
    )
    skills = _skills_caps(kwargs)
    assert len(skills) == 2
    assert all(cap.include == frozenset({"commit-helper", "gone"}) for cap in skills)


def test_system_skills_dir_seeded(isolated_config):
    """First resolve seeds ``data_dir()/skills`` from the bundled template."""
    set_secret("anthropic_api_key", "sk-ant-test")
    assert not (system_skills_dir() / "commit-helper" / "SKILL.md").exists()
    build_run_kwargs(_chat_settings(), isolated_config / "ws")
    assert (system_skills_dir() / "commit-helper" / "SKILL.md").exists()


# ---------------------------------------------------------------------------
# Mid-chat profile PATCH -> next run's capabilities
# ---------------------------------------------------------------------------


def test_chat_patch_accepts_custom_profile_id(client):
    test_client, tmp_path = client
    workspace = test_client.post(
        "/api/workspaces", json={"path": str(tmp_path / "ws")}, headers=AUTH
    ).json()
    chat = test_client.post(
        f"/api/workspaces/{workspace['id']}/chats", json={}, headers=AUTH
    ).json()

    patched = test_client.patch(
        f"/api/chats/{chat['id']}",
        json={"permission_profile": "reviewer"},
        headers=AUTH,
    )
    assert patched.status_code == 200
    assert patched.json()["permission_profile"] == "reviewer"


def test_mid_chat_patch_to_custom_profile_changes_next_run(client):
    """PATCH a custom profile id mid-chat; the next run builds its toolset."""
    test_client, tmp_path = client
    test_client.post("/api/tool-profiles", json=_profile_body(), headers=AUTH)
    ws_root = tmp_path / "ws"
    ws_root.mkdir()
    workspace = test_client.post(
        "/api/workspaces", json={"path": str(ws_root)}, headers=AUTH
    ).json()
    chat = test_client.post(
        f"/api/workspaces/{workspace['id']}/chats", json={}, headers=AUTH
    ).json()
    patched = test_client.patch(
        f"/api/chats/{chat['id']}",
        json={"permission_profile": "reviewer"},
        headers=AUTH,
    )
    assert patched.status_code == 200

    store: ChatStore = test_client.app.state.store

    async def settings_for_run():
        return await _run_settings(
            store,
            await store.get_chat(chat["id"]),
            await store.get_workspace(workspace["id"]),
        )

    set_secret("anthropic_api_key", "sk-ant-test")
    settings = asyncio.run(settings_for_run())
    kwargs = build_run_kwargs(settings, ws_root)
    allowlist = next(
        (c for c in kwargs["capabilities"] if isinstance(c, ToolAllowlist)),
        None,
    )
    assert allowlist is not None, (
        "custom profile PATCH did not reach the next run's capabilities"
    )
    assert allowlist.allowed == frozenset({"read_file", "list_files", "grep"})


# ---------------------------------------------------------------------------
# Regression — the four builtin ids keep today's capability shapes
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("profile_id", "expected_mode"),
    [
        ("bypass", "full"),
        ("manual", "read-only"),
    ],
)
def test_builtin_profiles_keep_coder_and_permissions(
    isolated_config, profile_id, expected_mode
):
    set_secret("anthropic_api_key", "sk-ant-test")
    kwargs = build_run_kwargs(
        _chat_settings(permission_profile=profile_id), isolated_config / "ws"
    )
    capabilities = kwargs["capabilities"]
    assert any(isinstance(c, Coder) for c in capabilities)
    permissions = [c for c in capabilities if isinstance(c, Permissions)]
    assert permissions and permissions[0].mode == expected_mode
    assert not any(isinstance(c, ToolAllowlist) for c in capabilities)


def test_read_only_builtin_keeps_standalone_filesystem(isolated_config):
    """Builtin ``read-only`` still builds FileSystem standalone — no Coder."""
    set_secret("anthropic_api_key", "sk-ant-test")
    kwargs = build_run_kwargs(
        _chat_settings(permission_profile="read-only"), isolated_config / "ws"
    )
    capabilities = kwargs["capabilities"]
    assert not any(isinstance(c, Coder) for c in capabilities)
    all_leaves = [leaf for cap in capabilities for leaf in _leaf_capabilities(cap)]
    file_systems = [c for c in all_leaves if isinstance(c, FileSystem)]
    assert file_systems and all(fs.read_only for fs in file_systems)
    assert not any(isinstance(c, Shell) for c in all_leaves)
    assert any(isinstance(c, RepoContext) for c in all_leaves)
    permissions = [c for c in capabilities if isinstance(c, Permissions)]
    assert permissions and permissions[0].mode == "read-only"
    # The builtin's declared tool surface rides in a ToolAllowlist — a no-op
    # against the standalone FileSystem's identical set, but truthful data.
    allowlist = next(c for c in capabilities if isinstance(c, ToolAllowlist))
    assert allowlist.allowed == frozenset(
        {
            "read_file",
            "list_files",
            "grep",
            "write_plan",
            "read_plan",
            "add_task",
            "update_task_status",
            "update_task_statuses",
            "remove_task",
        }
    )


def test_resolve_permission_capabilities_still_takes_strings():
    """The legacy string API keeps working for direct callers/tests."""
    caps = resolve_permission_capabilities("read-only")
    assert any(isinstance(c, FileSystem) for c in caps)
    caps = resolve_permission_capabilities("bogus")
    permissions = [c for c in caps if isinstance(c, Permissions)]
    assert permissions and permissions[0].mode == "read-only"
