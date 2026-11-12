"""Tests for the workspace file-serving API (containment, reads, tree)."""

import os
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
HAS_RG = shutil.which("rg") is not None


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A TestClient over a fresh app, plus a populated tmp workspace folder."""
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("APP_TOKEN", TOKEN)
    project = tmp_path / "proj"
    (project / "src" / "lib").mkdir(parents=True)
    (project / "src" / "main.py").write_text("print('hi')\n")
    (project / "src" / "lib" / "util.ts").write_text("export const x = 1;\n")
    (project / "README.md").write_text("# proj\n")
    # An empty .git dir makes rg treat the folder as a repo (gitignore applies)
    # and gives the protected-pattern tests a real target.
    (project / ".git").mkdir()
    (project / ".git" / "config").write_text("[core]\n")
    (project / ".env").write_text("SECRET=hunter2\n")
    (project / "key.pem").write_text("-----BEGIN-----\n")
    (project / "src" / "secrets.txt").write_text("shh\n")
    (project / ".hidden").mkdir()
    (project / ".hidden" / "note.txt").write_text("hidden\n")
    (project / ".gitignore").write_text("ignored.txt\nignored_dir/\n")
    (project / "ignored.txt").write_text("skip me\n")
    (project / "ignored_dir").mkdir()
    (project / "ignored_dir" / "deep.txt").write_text("skip me too\n")
    (project / "blob.bin").write_bytes(b"\x89PNG\x00\x01")
    # TrustedHostMiddleware only allows loopback hosts.
    with TestClient(create_app(), base_url="http://127.0.0.1") as test_client:
        yield test_client, project


def _workspace_id(test_client, project: Path) -> str:
    response = test_client.post(
        "/api/workspaces", json={"path": str(project)}, headers=AUTH
    )
    assert response.status_code == 200
    return response.json()["id"]


def _get(client, url, **params):
    return client.get(url, params=params, headers=AUTH)


def test_files_routes_require_auth(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    assert test_client.get("/api/files").status_code == 401
    assert test_client.get("/api/files/tree").status_code == 401
    assert (
        test_client.get(
            "/api/files",
            params={"workspace_id": workspace_id, "path": "README.md"},
            headers={"Authorization": "Bearer wrong"},
        ).status_code
        == 401
    )


def test_read_file_returns_content_language_size_path(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    response = _get(
        test_client,
        "/api/files",
        workspace_id=workspace_id,
        path="src/lib/util.ts",
    )
    assert response.status_code == 200
    body = response.json()
    assert body["content"] == "export const x = 1;\n"
    assert body["language"] == "typescript"
    assert body["size"] == len(b"export const x = 1;\n")
    assert body["path"] == "src/lib/util.ts"


def test_read_file_unknown_extension_language_is_null(client):
    test_client, project = client
    (project / "data.xyz").write_text("??\n")
    workspace_id = _workspace_id(test_client, project)
    response = _get(
        test_client, "/api/files", workspace_id=workspace_id, path="data.xyz"
    )
    assert response.status_code == 200
    assert response.json()["language"] is None


def test_read_file_rejects_paths_outside_root(client):
    test_client, project = client
    outside = project.parent / "outside.txt"
    outside.write_text("nope\n")
    workspace_id = _workspace_id(test_client, project)
    for bad in ("../outside.txt", str(outside), "src/../../outside.txt"):
        response = _get(test_client, "/api/files", workspace_id=workspace_id, path=bad)
        assert response.status_code == 403, bad


def test_read_file_rejects_symlink_escape(client):
    test_client, project = client
    outside = project.parent / "outside.txt"
    outside.write_text("nope\n")
    outside_dir = project.parent / "outside_dir"
    outside_dir.mkdir(exist_ok=True)
    (outside_dir / "evil.txt").write_text("nope\n")
    os.symlink(outside, project / "link.txt")
    os.symlink(outside_dir, project / "linkdir")
    workspace_id = _workspace_id(test_client, project)
    for bad in ("link.txt", "linkdir/evil.txt"):
        response = _get(test_client, "/api/files", workspace_id=workspace_id, path=bad)
        assert response.status_code == 403, bad


def test_read_file_rejects_protected_paths(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    for protected in (".env", "key.pem", "src/secrets.txt", ".git/config"):
        response = _get(
            test_client,
            "/api/files",
            workspace_id=workspace_id,
            path=protected,
        )
        assert response.status_code == 403, protected


def test_read_file_missing_directory_and_binary(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    assert (
        _get(
            test_client,
            "/api/files",
            workspace_id=workspace_id,
            path="gone.txt",
        ).status_code
        == 404
    )
    assert (
        _get(
            test_client, "/api/files", workspace_id=workspace_id, path="src"
        ).status_code
        == 400
    )
    # Null bytes in the first 8KB mark a binary.
    assert (
        _get(
            test_client,
            "/api/files",
            workspace_id=workspace_id,
            path="blob.bin",
        ).status_code
        == 413
    )
    big = project / "big.txt"
    big.write_text("x" * (2 * 1024 * 1024 + 1))
    assert (
        _get(
            test_client,
            "/api/files",
            workspace_id=workspace_id,
            path="big.txt",
        ).status_code
        == 413
    )


def test_files_unknown_workspace_is_404(client):
    test_client, _ = client
    assert (
        _get(
            test_client,
            "/api/files",
            workspace_id="nope",
            path="README.md",
        ).status_code
        == 404
    )
    assert _get(test_client, "/api/files/tree", workspace_id="nope").status_code == 404


def test_tree_returns_nested_shape(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    response = _get(test_client, "/api/files/tree", workspace_id=workspace_id)
    assert response.status_code == 200
    body = response.json()
    assert body["truncated"] is False

    root = body["root"]
    assert root["type"] == "dir" and root["path"] == ""
    # Dirs sort before files.
    by_name = {child["name"]: child for child in root["children"]}
    assert by_name["src"]["type"] == "dir"
    assert by_name["README.md"]["type"] == "file"
    assert by_name["README.md"]["path"] == "README.md"
    assert by_name["README.md"]["children"] is None

    src = by_name["src"]
    assert src["path"] == "src"
    src_names = {child["name"] for child in src["children"]}
    assert src_names == {"lib", "main.py", "secrets.txt"}
    lib = next(c for c in src["children"] if c["name"] == "lib")
    assert lib["children"][0]["path"] == "src/lib/util.ts"

    # Hidden entries are never listed.
    assert ".git" not in by_name
    assert ".env" not in by_name
    assert ".hidden" not in by_name


@pytest.mark.skipif(not HAS_RG, reason="gitignore filtering needs rg on PATH")
def test_tree_respects_gitignore(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    body = _get(test_client, "/api/files/tree", workspace_id=workspace_id).json()
    names = {child["name"] for child in body["root"]["children"]}
    assert "ignored.txt" not in names
    assert "ignored_dir" not in names
    assert ".gitignore" not in names  # hidden file


def test_tree_honors_depth(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    body = _get(
        test_client, "/api/files/tree", workspace_id=workspace_id, depth=1
    ).json()
    by_name = {child["name"]: child for child in body["root"]["children"]}
    # depth=1 keeps top-level entries; 'src' is listed but has no children.
    assert "README.md" in by_name
    if "src" in by_name:
        assert by_name["src"]["children"] == []
    deep = _get(
        test_client, "/api/files/tree", workspace_id=workspace_id, depth=2
    ).json()
    src = next(c for c in deep["root"]["children"] if c["name"] == "src")
    src_names = {c["name"] for c in src["children"]}
    assert "main.py" in src_names
    # util.ts is three levels down: pruned at depth 2.
    lib = next((c for c in src["children"] if c["name"] == "lib"), None)
    assert lib is None or lib["children"] == []


def test_tree_and_read_missing_workspace_path(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    shutil.rmtree(project)
    assert (
        _get(test_client, "/api/files/tree", workspace_id=workspace_id).status_code
        == 404
    )
    assert (
        _get(
            test_client,
            "/api/files",
            workspace_id=workspace_id,
            path="README.md",
        ).status_code
        == 404
    )
