"""Tests for user-defined tools: discovery, loading, REST API, run wiring.

Tool files live in ``data_dir()/tools`` (global) and ``<workspace>/.devin|
.agents|.claude/tools``; every top-level public def becomes a ``user_<name>``
tool through a prefixed ``FunctionToolset``. The listing/catalog paths parse
with ``ast`` only — exec happens exclusively at run-build inside
``build_user_tool_capabilities``, where failures degrade to warn + skip.
"""

import pytest
from fastapi.testclient import TestClient
from pydantic_ai import RunContext
from pydantic_ai.exceptions import ApprovalRequired
from pydantic_ai.models.test import TestModel
from pydantic_ai.toolsets import (
    ApprovalRequiredToolset,
    FunctionToolset,
)
from pydantic_ai.toolsets.prefixed import PrefixedToolset
from pydantic_ai.usage import RunUsage

from app.agent.factory import ToolAllowlist, build_run_kwargs
from app.api.schemas import UserToolSpec
from app.config import set_secret
from app.db.store import ChatStore
from app.main import create_app
from app.user_tools import (
    USER_TOOLS_KEY,
    build_user_tool_capabilities,
    discover_user_tool_files,
    global_tools_dir,
    load_user_tool_module,
    load_user_tools,
    parse_tool_key,
    parse_user_tool_file,
    parse_user_tools,
    public_functions,
    save_user_tools,
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

GREETER = '''\
"""A greeter module."""


def greet(name: str) -> str:
    """Greet someone by name.

    Args:
        name: Who to greet.
    """
    return f"Hello, {name}!"


async def add(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b
'''

BAD_SOURCE = "def broken(:\n"


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


def _write(path, source: str = GREETER):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source)
    return path


def _run_ctx() -> RunContext:
    return RunContext(deps=None, model=TestModel(), usage=RunUsage())


def _user_capability(kwargs):
    """The user-tools capability inside a ``build_run_kwargs`` result, or None."""
    for cap in kwargs["capabilities"]:
        toolset = getattr(cap, "toolset", None)
        seen = set()
        # Walk the wrap chain (ApprovalRequired -> Prefixed -> FunctionToolset).
        while toolset is not None and id(toolset) not in seen:
            seen.add(id(toolset))
            if getattr(toolset, "id", None) == "user_tools":
                return cap
            toolset = getattr(toolset, "wrapped", None)
    return None


# ---------------------------------------------------------------------------
# Registry persistence + parsing
# ---------------------------------------------------------------------------


async def test_user_tools_store_roundtrip(isolated_config):
    store = ChatStore()
    try:
        assert await load_user_tools(store) == []
        specs = [
            UserToolSpec(
                key="global:greet.py",
                name="greet",
                origin="global",
                rel_path="greet.py",
            ),
            UserToolSpec(
                key="workspace:.devin/tools/calc.py",
                name="calc",
                origin="workspace",
                rel_path=".devin/tools/calc.py",
                enabled=False,
            ),
        ]
        await save_user_tools(store, specs)
        assert USER_TOOLS_KEY in await store.get_settings()
        loaded = await load_user_tools(store)
        assert [s.key for s in loaded] == [s.key for s in specs]
        assert loaded[1].enabled is False
        # Emptying the list deletes the row.
        await save_user_tools(store, [])
        assert USER_TOOLS_KEY not in await store.get_settings()
    finally:
        store.close()


def test_parse_user_tools_skips_malformed_entries():
    raw = [
        {"key": "global:a.py", "name": "a", "origin": "global", "rel_path": "a.py"},
        {"key": "bogus"},  # missing fields
        "not-a-dict",
        {
            "key": "workspace:.devin/tools/b.py",
            "name": "b",
            "origin": "workspace",
            "rel_path": ".devin/tools/b.py",
            "enabled": False,
        },
    ]
    specs = parse_user_tools(raw)
    assert [s.key for s in specs] == ["global:a.py", "workspace:.devin/tools/b.py"]
    assert specs[1].enabled is False


def test_parse_user_tools_handles_garbage():
    assert parse_user_tools(None) == []
    assert parse_user_tools("oops") == []
    assert parse_user_tools("[]") == []
    assert parse_user_tools({"not": "a list"}) == []


def test_parse_tool_key():
    assert parse_tool_key("global:greet.py") == ("global", "greet.py")
    assert parse_tool_key("workspace:.devin/tools/x.py") == (
        "workspace",
        ".devin/tools/x.py",
    )
    assert parse_tool_key("nocolon") is None
    assert parse_tool_key("nope:x.py") is None
    assert parse_tool_key("global:") is None


# ---------------------------------------------------------------------------
# Discovery + static parsing (never execs)
# ---------------------------------------------------------------------------


def test_discovery_global_and_workspace(isolated_config):
    root = isolated_config / "ws"
    global_file = _write(global_tools_dir() / "shared.py")
    ws_file = _write(root / ".devin" / "tools" / "local.py")
    _write(root / ".claude" / "tools" / "other.py", source="def f():\n    pass\n")

    files = {f.key: f for f in discover_user_tool_files(root)}
    assert files["global:shared.py"].path == global_file
    assert files["global:shared.py"].origin == "global"
    assert files["workspace:.devin/tools/local.py"].path == ws_file
    assert "workspace:.claude/tools/other.py" in files
    # Workspace-first ordering.
    keys = list(files)
    assert keys.index("workspace:.devin/tools/local.py") < keys.index(
        "global:shared.py"
    )


def test_discovery_workspace_shadows_global(isolated_config):
    root = isolated_config / "ws"
    _write(global_tools_dir() / "same.py")
    _write(root / ".devin" / "tools" / "same.py")
    files = {f.key: f for f in discover_user_tool_files(root)}
    assert files["workspace:.devin/tools/same.py"].shadowed_by is None
    assert files["global:same.py"].shadowed_by == "workspace:.devin/tools/same.py"


def test_discovery_workspace_dir_precedence(isolated_config):
    """``.devin`` beats ``.agents`` beats ``.claude`` on same-name files."""
    root = isolated_config / "ws"
    _write(root / ".claude" / "tools" / "x.py")
    _write(root / ".devin" / "tools" / "x.py")
    _write(root / ".agents" / "tools" / "x.py")
    files = {f.key: f for f in discover_user_tool_files(root)}
    assert files["workspace:.devin/tools/x.py"].shadowed_by is None
    assert (
        files["workspace:.agents/tools/x.py"].shadowed_by
        == "workspace:.devin/tools/x.py"
    )
    assert (
        files["workspace:.claude/tools/x.py"].shadowed_by
        == "workspace:.devin/tools/x.py"
    )


def test_discovery_missing_dirs(isolated_config):
    assert discover_user_tool_files(isolated_config / "empty-ws") == []
    assert discover_user_tool_files(None) == []


def test_parse_file_extracts_public_functions_and_docstrings(tmp_path):
    path = _write(
        tmp_path / "tools" / "m.py",
        source='''\
"""Module blurb."""


def ok(a: int) -> int:
    """Docstring."""
    return a


def _private():
    pass


def Bad_Name():
    pass


async def async_ok():
    pass
''',
    )
    parsed = parse_user_tool_file(path)
    assert parsed.error is None
    assert parsed.docstring == "Module blurb."
    by_name = {f.name: f for f in parsed.functions}
    assert "_private" not in by_name
    assert by_name["ok"].legal and by_name["ok"].docstring == "Docstring."
    assert by_name["async_ok"].legal
    assert not by_name["Bad_Name"].legal


def test_parse_file_reports_syntax_error_without_exec(tmp_path):
    path = _write(tmp_path / "tools" / "bad.py", source=BAD_SOURCE)
    parsed = parse_user_tool_file(path)
    assert parsed.error is not None
    assert "SyntaxError" in parsed.error


def test_parse_never_execs_user_code(tmp_path):
    """A file that would raise at import still parses cleanly."""
    path = _write(
        tmp_path / "tools" / "boom.py",
        source='raise RuntimeError("side effect")\n\ndef f():\n    pass\n',
    )
    parsed = parse_user_tool_file(path)
    assert parsed.error is None
    assert [f.name for f in parsed.functions] == ["f"]


# ---------------------------------------------------------------------------
# Loader (exec — run-build only)
# ---------------------------------------------------------------------------


def test_load_module_execs_and_collects_public_functions(tmp_path):
    path = _write(
        tmp_path / "tools" / "m.py",
        source="""\
import math
from os.path import join  # noqa: F401 — imported names must not become tools


def local(x):
    return x


def _hidden():
    pass


CONSTANT = 42
""",
    )
    module = load_user_tool_module(path)
    fns = public_functions(module)
    names = [fn.__name__ for fn in fns]
    assert names == ["local"]
    assert module.__name__.startswith("_user_tool_m_")


def test_load_module_failure_leaves_sys_modules_clean(tmp_path):
    import sys

    path = _write(tmp_path / "tools" / "boom.py", source='raise RuntimeError("x")\n')
    with pytest.raises(RuntimeError):
        load_user_tool_module(path)
    assert not any(name.startswith("_user_tool_boom_") for name in sys.modules)


# ---------------------------------------------------------------------------
# build_user_tool_capabilities
# ---------------------------------------------------------------------------


def _spec(key: str, enabled: bool = True) -> UserToolSpec:
    origin, rel = key.split(":", 1)
    return UserToolSpec(
        key=key,
        name=rel.split("/")[-1].removesuffix(".py"),
        origin=origin,
        rel_path=rel,
        enabled=enabled,
    )


async def test_capabilities_expose_prefixed_callable_tools(isolated_config):
    root = isolated_config / "ws"
    _write(root / ".devin" / "tools" / "greeter.py")
    caps = build_user_tool_capabilities(
        [_spec("workspace:.devin/tools/greeter.py")],
        workspace_root=root,
        gate=False,
    )
    assert len(caps) == 1
    toolset = caps[0].toolset
    assert isinstance(toolset, PrefixedToolset)
    tools = await toolset.get_tools(_run_ctx())
    assert sorted(tools) == ["user_add", "user_greet"]
    # Docstring becomes the tool description.
    assert "Greet someone by name" in tools["user_greet"].tool_def.description
    # Sync + async functions both dispatch through call_tool.
    assert (
        await toolset.call_tool(
            "user_greet", {"name": "Ada"}, _run_ctx(), tools["user_greet"]
        )
        == "Hello, Ada!"
    )
    assert (
        await toolset.call_tool(
            "user_add", {"a": 2, "b": 3}, _run_ctx(), tools["user_add"]
        )
        == 5
    )


async def test_capabilities_gate_wraps_approval(isolated_config):
    """Non-bypass profiles route every user-tool call through approval."""
    root = isolated_config / "ws"
    _write(root / ".devin" / "tools" / "greeter.py")
    caps = build_user_tool_capabilities([], workspace_root=root, gate=True)
    toolset = caps[0].toolset
    assert isinstance(toolset, ApprovalRequiredToolset)
    tools = await toolset.get_tools(_run_ctx())
    with pytest.raises(ApprovalRequired):
        await toolset.call_tool(
            "user_greet", {"name": "Ada"}, _run_ctx(), tools["user_greet"]
        )


def test_capabilities_disabled_and_shadowed_skipped(isolated_config):
    root = isolated_config / "ws"
    _write(global_tools_dir() / "on.py")
    _write(global_tools_dir() / "off.py")
    _write(root / ".devin" / "tools" / "on.py")  # shadows the global file
    specs = [
        _spec("global:on.py"),
        _spec("global:off.py", enabled=False),
        _spec("workspace:.devin/tools/on.py"),
    ]
    caps = build_user_tool_capabilities(specs, workspace_root=root, gate=False)
    # Only the workspace copy's functions registered — the global same-name
    # file is shadowed and 'off.py' is disabled.
    function_toolset = caps[0].toolset.wrapped
    assert isinstance(function_toolset, FunctionToolset)
    assert sorted(function_toolset.tools) == ["add", "greet"]


def test_capabilities_exec_failure_skips_file(isolated_config):
    root = isolated_config / "ws"
    _write(
        root / ".devin" / "tools" / "boom.py",
        source='raise RuntimeError("module blew up")\n',
    )
    _write(root / ".devin" / "tools" / "fine.py", source="def ok():\n    return 1\n")
    caps = build_user_tool_capabilities([], workspace_root=root, gate=False)
    assert len(caps) == 1
    assert list(caps[0].toolset.wrapped.tools) == ["ok"]


def test_capabilities_illegal_and_duplicate_names_skipped(isolated_config):
    root = isolated_config / "ws"
    _write(
        root / ".devin" / "tools" / "a.py",
        source="def BadName():\n    pass\n\ndef ok_a():\n    return 1\n",
    )
    _write(
        root / ".devin" / "tools" / "b.py",
        source="def ok_a():\n    return 2\n",  # dup of a.py's — first wins
    )
    caps = build_user_tool_capabilities([], workspace_root=root, gate=False)
    fns = caps[0].toolset.wrapped.tools
    assert list(fns) == ["ok_a"]
    assert fns["ok_a"].function.__module__.startswith("_user_tool_a_")


def test_capabilities_no_files_no_capability(isolated_config):
    assert (
        build_user_tool_capabilities(
            [], workspace_root=isolated_config / "ws", gate=False
        )
        == []
    )


# ---------------------------------------------------------------------------
# build_run_kwargs wiring
# ---------------------------------------------------------------------------


def test_run_kwargs_include_user_tools_under_bypass(isolated_config):
    set_secret("anthropic_api_key", "sk-ant-test")
    root = isolated_config / "ws"
    _write(root / ".devin" / "tools" / "greeter.py")
    kwargs = build_run_kwargs(
        {
            "model": "anthropic:claude-sonnet-4-6",
            "permission_profile": "bypass",
            "user_tools": [_spec("workspace:.devin/tools/greeter.py").model_dump()],
        },
        root,
    )
    cap = _user_capability(kwargs)
    assert cap is not None
    toolset = cap.toolset
    seen = set()
    gated = False
    while toolset is not None and id(toolset) not in seen:
        seen.add(id(toolset))
        gated = gated or isinstance(toolset, ApprovalRequiredToolset)
        toolset = getattr(toolset, "wrapped", None)
    assert not gated


def test_run_kwargs_gate_user_tools_under_manual(isolated_config):
    set_secret("anthropic_api_key", "sk-ant-test")
    root = isolated_config / "ws"
    _write(root / ".devin" / "tools" / "greeter.py")
    kwargs = build_run_kwargs(
        {
            "model": "anthropic:claude-sonnet-4-6",
            "permission_profile": "manual",
        },
        root,
    )
    cap = _user_capability(kwargs)
    assert cap is not None
    assert isinstance(cap.toolset, ApprovalRequiredToolset)


def test_run_kwargs_no_tools_no_capability(isolated_config):
    set_secret("anthropic_api_key", "sk-ant-test")
    kwargs = build_run_kwargs(
        {"model": "anthropic:claude-sonnet-4-6"}, isolated_config / "ws"
    )
    assert _user_capability(kwargs) is None


async def test_allowlist_prefix_admits_user_tools(isolated_config):
    """``tool_prefixes=['user_']`` admits; explicit names without them exclude."""
    allowlist = ToolAllowlist(allowed=frozenset(), prefixes=frozenset({"user_"}))
    inner = FunctionToolset()
    inner.add_function(lambda: "", name="user_greet")
    inner.add_function(lambda: "", name="read_file")
    filtered = allowlist.get_wrapper_toolset(inner)
    assert sorted(await filtered.get_tools(_run_ctx())) == ["user_greet"]

    # An explicit tools list without user_* names drops them.
    allowlist = ToolAllowlist(allowed=frozenset({"read_file"}))
    filtered = allowlist.get_wrapper_toolset(inner)
    assert sorted(await filtered.get_tools(_run_ctx())) == ["read_file"]


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------


def _workspace_id(test_client, path) -> str:
    response = test_client.post(
        "/api/workspaces", json={"path": str(path)}, headers=AUTH
    )
    assert response.status_code == 200
    return response.json()["id"]


def test_user_tools_routes_require_auth(client):
    test_client, _ = client
    assert test_client.get("/api/user-tools").status_code == 401


def test_user_tools_empty_by_default(client):
    test_client, _ = client
    response = test_client.get("/api/user-tools", headers=AUTH)
    assert response.status_code == 200
    assert response.json() == []


def test_user_tools_listing_and_shadowing(client):
    test_client, tmp_path = client
    project = tmp_path / "proj"
    project.mkdir()
    workspace_id = _workspace_id(test_client, project)
    data_tools = tmp_path / "data" / "tools"
    _write(data_tools / "shared.py")
    _write(project / ".devin" / "tools" / "local.py")
    _write(project / ".devin" / "tools" / "shared.py")  # shadows global

    response = test_client.get(
        "/api/user-tools", params={"workspace_id": workspace_id}, headers=AUTH
    )
    assert response.status_code == 200
    rows = {row["key"]: row for row in response.json()}
    local = rows["workspace:.devin/tools/local.py"]
    assert local["enabled"] is True
    assert [f["name"] for f in local["functions"]] == ["greet", "add"]
    assert local["docstring"] == "A greeter module."
    assert rows["global:shared.py"]["skipped_reason"].startswith("shadowed by")
    assert rows["workspace:.devin/tools/shared.py"]["skipped_reason"] is None

    # Without workspace_id only global files list.
    response = test_client.get("/api/user-tools", headers=AUTH)
    assert [row["key"] for row in response.json()] == ["global:shared.py"]

    # Unknown workspace is a 404.
    assert (
        test_client.get(
            "/api/user-tools", params={"workspace_id": "nope"}, headers=AUTH
        ).status_code
        == 404
    )


def test_user_tools_listing_reports_errors(client):
    test_client, tmp_path = client
    data_tools = tmp_path / "data" / "tools"
    _write(data_tools / "broken.py", source=BAD_SOURCE)
    _write(data_tools / "empty.py", source="x = 1\n")
    _write(data_tools / "illegal.py", source="def Bad():\n    pass\n")
    rows = {
        row["key"]: row
        for row in test_client.get("/api/user-tools", headers=AUTH).json()
    }
    assert "SyntaxError" in rows["global:broken.py"]["error"]
    assert rows["global:empty.py"]["skipped_reason"] == "no public functions"
    illegal = rows["global:illegal.py"]
    assert illegal["functions"] == []
    assert illegal["skipped_functions"][0]["name"] == "Bad"


def test_create_user_tool_global_template(client):
    test_client, tmp_path = client
    created = test_client.post(
        "/api/user-tools",
        json={"origin": "global", "filename": "mine.py"},
        headers=AUTH,
    )
    assert created.status_code == 201
    path = tmp_path / "data" / "tools" / "mine.py"
    assert path.is_file()
    assert "def example_tool" in path.read_text()
    rows = created.json()
    assert any(row["key"] == "global:mine.py" for row in rows)

    # Duplicate is a 409.
    assert (
        test_client.post(
            "/api/user-tools",
            json={"origin": "global", "filename": "mine.py"},
            headers=AUTH,
        ).status_code
        == 409
    )
    # Traversal/bad names are a 400.
    for bad in ("../evil.py", "sub/x.py", "x.txt", "Caps.py"):
        assert (
            test_client.post(
                "/api/user-tools",
                json={"origin": "global", "filename": bad},
                headers=AUTH,
            ).status_code
            == 400
        ), bad


def test_create_user_tool_workspace(client):
    test_client, tmp_path = client
    project = tmp_path / "proj"
    project.mkdir()
    workspace_id = _workspace_id(test_client, project)

    # workspace_id required.
    assert (
        test_client.post(
            "/api/user-tools",
            json={"origin": "workspace", "filename": "t.py"},
            headers=AUTH,
        ).status_code
        == 400
    )
    created = test_client.post(
        "/api/user-tools",
        json={
            "origin": "workspace",
            "workspace_id": workspace_id,
            "filename": "t.py",
            "source": "def mine():\n    return 7\n",
        },
        headers=AUTH,
    )
    assert created.status_code == 201
    assert (project / ".devin" / "tools" / "t.py").is_file()
    assert any(row["key"] == "workspace:.devin/tools/t.py" for row in created.json())


def test_patch_user_tool_toggle(client):
    test_client, tmp_path = client
    _write(tmp_path / "data" / "tools" / "g.py")
    patched = test_client.patch(
        "/api/user-tools",
        json={"key": "global:g.py", "enabled": False},
        headers=AUTH,
    )
    assert patched.status_code == 200
    specs = patched.json()
    assert specs == [
        {
            "key": "global:g.py",
            "name": "g",
            "origin": "global",
            "rel_path": "g.py",
            "enabled": False,
        }
    ]
    # The flag shows up on the listing.
    rows = test_client.get("/api/user-tools", headers=AUTH).json()
    assert rows[0]["enabled"] is False
    # Toggling back.
    patched = test_client.patch(
        "/api/user-tools",
        json={"key": "global:g.py", "enabled": True},
        headers=AUTH,
    )
    assert patched.json()[0]["enabled"] is True
    # Malformed keys are a 400.
    assert (
        test_client.patch(
            "/api/user-tools",
            json={"key": "bogus", "enabled": False},
            headers=AUTH,
        ).status_code
        == 400
    )


def test_source_read_write_roundtrip(client):
    test_client, tmp_path = client
    path = _write(tmp_path / "data" / "tools" / "g.py")
    got = test_client.get(
        "/api/user-tools/source",
        params={"key": "global:g.py"},
        headers=AUTH,
    )
    assert got.status_code == 200
    assert "def greet" in got.json()["source"]

    put = test_client.put(
        "/api/user-tools/source",
        json={"key": "global:g.py", "source": "def new_fn():\n    return 1\n"},
        headers=AUTH,
    )
    assert put.status_code == 200
    assert "def new_fn" in path.read_text()


def test_source_put_creates_and_is_jailed(client):
    test_client, tmp_path = client
    # PUT creates a missing tool file.
    put = test_client.put(
        "/api/user-tools/source",
        json={"key": "global:fresh.py", "source": "def f():\n    pass\n"},
        headers=AUTH,
    )
    assert put.status_code == 200
    assert (tmp_path / "data" / "tools" / "fresh.py").is_file()

    # Traversal escapes are refused.
    for key in ("global:../evil.py", "global:sub/deep.py", "global:x.txt"):
        response = test_client.put(
            "/api/user-tools/source",
            json={"key": key, "source": "x = 1\n"},
            headers=AUTH,
        )
        assert response.status_code in (400, 403), key

    # Workspace-origin keys need workspace_id.
    assert (
        test_client.put(
            "/api/user-tools/source",
            json={
                "key": "workspace:.devin/tools/t.py",
                "source": "x = 1\n",
            },
            headers=AUTH,
        ).status_code
        == 400
    )


def test_source_symlink_escape_rejected(client):
    """A symlink inside the tools dir pointing outside resolves to a 403."""
    test_client, tmp_path = client
    tools = tmp_path / "data" / "tools"
    tools.mkdir(parents=True)
    outside = tmp_path / "outside.py"
    outside.write_text("x = 1\n")
    link = tools / "link.py"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks unavailable")
    assert (
        test_client.get(
            "/api/user-tools/source",
            params={"key": "global:link.py"},
            headers=AUTH,
        ).status_code
        == 403
    )


def test_workspace_source_jailed_to_tool_dirs(client):
    test_client, tmp_path = client
    project = tmp_path / "proj"
    project.mkdir()
    workspace_id = _workspace_id(test_client, project)

    # A workspace key outside the tool dirs is a 400 even though it would be
    # inside the workspace root.
    assert (
        test_client.put(
            "/api/user-tools/source",
            json={
                "key": "workspace:src/x.py",
                "workspace_id": workspace_id,
                "source": "x = 1\n",
            },
            headers=AUTH,
        ).status_code
        == 400
    )
    # '..' inside a tool-dir-shaped key escapes — containment still rejects.
    assert test_client.get(
        "/api/user-tools/source",
        params={
            "key": "workspace:.devin/tools/../../secrets/x.py",
            "workspace_id": workspace_id,
        },
        headers=AUTH,
    ).status_code in (400, 403)


def test_delete_user_tool(client):
    test_client, tmp_path = client
    path = _write(tmp_path / "data" / "tools" / "gone.py")
    test_client.patch(
        "/api/user-tools",
        json={"key": "global:gone.py", "enabled": False},
        headers=AUTH,
    )
    deleted = test_client.delete(
        "/api/user-tools", params={"key": "global:gone.py"}, headers=AUTH
    )
    assert deleted.status_code == 204
    assert not path.exists()
    # The registry row went too — the listing no longer disables it.
    assert test_client.get("/api/user-tools", headers=AUTH).json() == []
    # Deleting again is a 404.
    assert (
        test_client.delete(
            "/api/user-tools", params={"key": "global:gone.py"}, headers=AUTH
        ).status_code
        == 404
    )


def test_delete_removes_stale_registry_row(client):
    """A manually-deleted file still lets DELETE clean the registry row."""
    test_client, _ = client
    test_client.patch(
        "/api/user-tools",
        json={"key": "global:stale.py", "enabled": False},
        headers=AUTH,
    )
    assert (
        test_client.delete(
            "/api/user-tools", params={"key": "global:stale.py"}, headers=AUTH
        ).status_code
        == 204
    )
    assert test_client.patch(
        "/api/user-tools",
        json={"key": "global:stale.py", "enabled": True},
        headers=AUTH,
    ).json() == [
        {
            "key": "global:stale.py",
            "name": "stale",
            "origin": "global",
            "rel_path": "stale.py",
            "enabled": True,
        }
    ]


def test_tool_catalog_includes_enabled_user_tools(client):
    test_client, tmp_path = client
    project = tmp_path / "proj"
    project.mkdir()
    workspace_id = _workspace_id(test_client, project)
    _write(tmp_path / "data" / "tools" / "greeter.py")
    _write(project / ".devin" / "tools" / "broken.py", source=BAD_SOURCE)
    test_client.patch(
        "/api/user-tools",
        json={"key": "global:greeter.py", "enabled": False},
        headers=AUTH,
    )

    catalog = test_client.get(
        "/api/tool-catalog",
        params={"workspace_id": workspace_id},
        headers=AUTH,
    ).json()
    user_entries = [e for e in catalog if e["group"] == "user"]
    # Disabled global file contributes nothing; the broken workspace file
    # parses to no functions.
    assert user_entries == []
    test_client.patch(
        "/api/user-tools",
        json={"key": "global:greeter.py", "enabled": True},
        headers=AUTH,
    )
    catalog = test_client.get("/api/tool-catalog", headers=AUTH).json()
    user_entries = {e["name"] for e in catalog if e["group"] == "user"}
    assert user_entries == {"user_greet", "user_add"}
