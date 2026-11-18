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
    (project / "img.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
    (project / "img.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>\n")
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


def test_read_file_missing_and_directory(client):
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
    big = project / "big.txt"
    big.write_text("x" * (2 * 1024 * 1024 + 1))
    response = _get(
        test_client,
        "/api/files",
        workspace_id=workspace_id,
        path="big.txt",
    )
    # Oversize files are a display-limit fact, not an error — 200 with the
    # oversize flag so the viewer can offer open-externally.
    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "text"
    assert body["oversize"] is True
    assert body["content"] == ""
    assert body["size"] == 2 * 1024 * 1024 + 1
    assert body["version"]


# --------------------------------------------------------------------- #
# kind detection — extension for images, NUL sniff for binaries          #
# --------------------------------------------------------------------- #


def test_read_file_kind_text_for_plain_files(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    for path in ("README.md", "src/main.py", "src/lib/util.ts"):
        body = _get(
            test_client, "/api/files", workspace_id=workspace_id, path=path
        ).json()
        assert body["kind"] == "text", path
        assert body["content"], path


def test_read_file_kind_image_by_extension(client):
    """Image extensions serve metadata only — bytes come via /api/files/raw."""
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    for path in ("img.png", "img.svg"):
        response = _get(test_client, "/api/files", workspace_id=workspace_id, path=path)
        assert response.status_code == 200, path
        body = response.json()
        assert body["kind"] == "image", path
        # No decoded body bytes for non-text kinds — the renderer fetches raw.
        assert body["content"] == "", path
        assert body["size"] > 0 and body["version"], path


def test_read_file_kind_binary_on_nul_sniff(client):
    """NUL in the first 8KB marks binary — even under a text-ish extension."""
    test_client, project = client
    (project / "notes.txt").write_bytes(b"real text\x00\x01\x02")
    workspace_id = _workspace_id(test_client, project)
    for path in ("blob.bin", "notes.txt"):
        response = _get(test_client, "/api/files", workspace_id=workspace_id, path=path)
        assert response.status_code == 200, path
        body = response.json()
        assert body["kind"] == "binary", path
        assert body["content"] == "", path


def test_read_file_kind_binary_by_extension(client):
    """Known-binary extensions classify without a NUL — including ASCII
    content (a text `.stl` is still CAD data, not something to edit)."""
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    for path, payload in (
        # ASCII-shaped bodies the NUL sniff would never catch:
        ("mesh.stl", "solid cube\nendsolid cube\n"),
        ("model.obj", "v 0 0 0\nv 1 0 0\n"),
        ("sketch.dxf", "0\nSECTION\n"),
        ("model.3mf", b"PK\x03\x04" + b"\x00" * 100),
        ("app.zip", b"PK\x03\x04" + b"\x00" * 100),
        ("mod.wasm", b"\x00asm\x01\x00\x00\x00"),
        ("doc.pdf", "%PDF-1.4 plain header\n"),
    ):
        (project / path).write_bytes(
            payload.encode() if isinstance(payload, str) else payload
        )
        body = _get(
            test_client, "/api/files", workspace_id=workspace_id, path=path
        ).json()
        assert body["kind"] == "binary", path
        assert body["content"] == "", path


def test_read_file_oversize_binary_is_binary_not_error(client):
    """The core regression: a >2MB binary classified via head-read + stat
    instead of dying on the size cap before kind detection ran."""
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    big = project / "scene.3mf"
    big.write_bytes(b"PK\x03\x04" + b"\x00" * (2 * 1024 * 1024 + 1))
    response = _get(
        test_client, "/api/files", workspace_id=workspace_id, path="scene.3mf"
    )
    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "binary"
    assert body["oversize"] is True
    assert body["content"] == ""
    assert body["size"] == 2 * 1024 * 1024 + 5
    assert body["version"]


def test_read_file_oversize_unknown_extension_still_detected(client):
    """No extension list catch needed for a big NUL-sniff binary either —
    the head read classifies before the cap is consulted."""
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    big = project / "data.xyz"
    big.write_bytes(b"\x00\x01\x02" + b"\x00" * (2 * 1024 * 1024 + 1))
    body = _get(
        test_client, "/api/files", workspace_id=workspace_id, path="data.xyz"
    ).json()
    assert body["kind"] == "binary"
    assert body["oversize"] is True
    assert body["content"] == ""


def test_read_file_oversize_version_tracks_size(client):
    """The partial version (head+size hash) must react to edits that change
    size — it's the drift signal when the client can't diff bytes."""
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    big = project / "big2.txt"
    big.write_text("a" * (2 * 1024 * 1024 + 1))
    first = _get(
        test_client, "/api/files", workspace_id=workspace_id, path="big2.txt"
    ).json()["version"]
    big.write_text("a" * (2 * 1024 * 1024 + 2))
    second = _get(
        test_client, "/api/files", workspace_id=workspace_id, path="big2.txt"
    ).json()["version"]
    assert first != second


def test_read_file_kind_language_hints(client):
    test_client, project = client
    (project / "docs.markdown").write_text("# docs\n")
    workspace_id = _workspace_id(test_client, project)
    for path, language in (
        ("README.md", "markdown"),
        ("docs.markdown", "markdown"),
    ):
        body = _get(
            test_client, "/api/files", workspace_id=workspace_id, path=path
        ).json()
        assert body["language"] == language, path
        assert body["kind"] == "text", path


# --------------------------------------------------------------------- #
# GET /api/files/raw — raw bytes (images); same confinement as the read   #
# --------------------------------------------------------------------- #


def _get_raw(client, path: str, workspace_id: str):
    return client.get(
        "/api/files/raw",
        params={"workspace_id": workspace_id, "path": path},
        headers=AUTH,
    )


def test_read_file_raw_requires_auth(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    assert test_client.get("/api/files/raw").status_code == 401
    assert (
        test_client.get(
            "/api/files/raw",
            params={"workspace_id": workspace_id, "path": "img.png"},
            headers={"Authorization": "Bearer wrong"},
        ).status_code
        == 401
    )


def test_read_file_raw_serves_bytes_and_media_type(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    expected_png = (project / "img.png").read_bytes()
    cases = (
        ("img.png", expected_png, "image/png"),
        ("img.svg", (project / "img.svg").read_bytes(), "image/svg+xml"),
        ("blob.bin", (project / "blob.bin").read_bytes(), "application/octet-stream"),
    )
    for path, body_bytes, media_type in cases:
        response = _get_raw(test_client, path, workspace_id)
        assert response.status_code == 200, path
        assert response.content == body_bytes, path
        assert response.headers["content-type"].startswith(media_type), path


def test_read_file_raw_rejects_paths_outside_root(client):
    test_client, project = client
    outside = project.parent / "outside.png"
    outside.write_bytes(b"\x89PNG\r\n\x1a\n")
    workspace_id = _workspace_id(test_client, project)
    for bad in ("../outside.png", str(outside), "src/../../outside.png"):
        response = _get_raw(test_client, bad, workspace_id)
        assert response.status_code == 403, bad


def test_read_file_raw_rejects_symlink_escape(client):
    test_client, project = client
    outside = project.parent / "outside.png"
    outside.write_bytes(b"\x89PNG\r\n\x1a\n")
    outside_dir = project.parent / "outside_dir"
    outside_dir.mkdir(exist_ok=True)
    (outside_dir / "evil.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    os.symlink(outside, project / "link.png")
    os.symlink(outside_dir, project / "linkdir")
    workspace_id = _workspace_id(test_client, project)
    for bad in ("link.png", "linkdir/evil.png"):
        response = _get_raw(test_client, bad, workspace_id)
        assert response.status_code == 403, bad


def test_read_file_raw_rejects_protected_paths(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    for protected in (".env", "key.pem", "src/secrets.txt", ".git/config"):
        response = _get_raw(test_client, protected, workspace_id)
        assert response.status_code == 403, protected


def test_read_file_raw_missing_directory_and_workspace(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    assert _get_raw(test_client, "gone.png", workspace_id).status_code == 404
    assert _get_raw(test_client, "src", workspace_id).status_code == 400
    assert _get_raw(test_client, "img.png", "nope").status_code == 404


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


# --------------------------------------------------------------------- #
# GET /api/files/tree?path= — scoped one-level listings (lazy explorer)   #
# --------------------------------------------------------------------- #


def test_tree_scoped_returns_one_level(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    response = _get(
        test_client,
        "/api/files/tree",
        workspace_id=workspace_id,
        path="src",
    )
    assert response.status_code == 200
    body = response.json()
    root = body["root"]
    assert root["type"] == "dir"
    assert root["name"] == "src"
    assert root["path"] == "src"
    by_name = {child["name"]: child for child in root["children"]}
    # Direct files are listed; deeper content surfaces only as a frontier
    # dir with no children — the explorer fetches it on expand.
    assert by_name["main.py"]["type"] == "file"
    assert by_name["secrets.txt"]["type"] == "file"
    assert by_name["lib"]["type"] == "dir"
    assert by_name["lib"]["children"] == []
    assert "util.ts" not in by_name


def test_tree_scoped_empty_path_scopes_to_root(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    body = _get(
        test_client, "/api/files/tree", workspace_id=workspace_id, path=""
    ).json()
    root = body["root"]
    assert root["type"] == "dir" and root["path"] == ""
    by_name = {child["name"]: child for child in root["children"]}
    # One level: top-level files plus the src frontier dir.
    assert by_name["README.md"]["type"] == "file"
    assert by_name["src"]["type"] == "dir"
    assert by_name["src"]["children"] == []
    # Hidden entries are never listed.
    assert ".git" not in by_name
    assert ".env" not in by_name
    assert ".hidden" not in by_name


def test_tree_scoped_honors_depth(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    body = _get(
        test_client,
        "/api/files/tree",
        workspace_id=workspace_id,
        path="",
        depth=2,
    ).json()
    src = next(c for c in body["root"]["children"] if c["name"] == "src")
    src_names = {c["name"] for c in src["children"]}
    # depth=2 lists src's files; util.ts (level 3) leaves only the frontier
    # dir behind.
    assert "main.py" in src_names
    lib = next(c for c in src["children"] if c["name"] == "lib")
    assert lib["children"] == []
    deep = _get(
        test_client,
        "/api/files/tree",
        workspace_id=workspace_id,
        path="src",
        depth=2,
    ).json()
    lib = next(c for c in deep["root"]["children"] if c["name"] == "lib")
    assert lib["children"][0]["path"] == "src/lib/util.ts"


def test_tree_scoped_rejects_paths_outside_root(client):
    test_client, project = client
    outside_dir = project.parent / "outside_dir"
    outside_dir.mkdir(exist_ok=True)
    (outside_dir / "evil.txt").write_text("nope\n")
    workspace_id = _workspace_id(test_client, project)
    for bad in ("../outside_dir", str(outside_dir), "src/../../outside_dir"):
        response = _get(
            test_client, "/api/files/tree", workspace_id=workspace_id, path=bad
        )
        assert response.status_code == 403, bad


def test_tree_scoped_rejects_symlink_escape(client):
    test_client, project = client
    outside_dir = project.parent / "outside_dir"
    outside_dir.mkdir(exist_ok=True)
    (outside_dir / "evil.txt").write_text("nope\n")
    os.symlink(outside_dir, project / "linkdir")
    workspace_id = _workspace_id(test_client, project)
    # The lexical path sits inside the root but resolves outside it.
    assert (
        _get(
            test_client, "/api/files/tree", workspace_id=workspace_id, path="linkdir"
        ).status_code
        == 403
    )


def test_tree_scoped_rejects_protected_dirs(client):
    """The dir itself is pattern-checked — ``.git`` denies as a target too."""
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    assert (
        _get(
            test_client, "/api/files/tree", workspace_id=workspace_id, path=".git"
        ).status_code
        == 403
    )


def test_tree_scoped_missing_and_not_a_dir(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    assert (
        _get(
            test_client, "/api/files/tree", workspace_id=workspace_id, path="gone"
        ).status_code
        == 404
    )
    assert (
        _get(
            test_client,
            "/api/files/tree",
            workspace_id=workspace_id,
            path="README.md",
        ).status_code
        == 400
    )


@pytest.mark.skipif(not HAS_RG, reason="gitignore filtering needs rg on PATH")
def test_tree_scoped_respects_gitignore(client):
    """A scoped rg run keeps the repo's ignore rules from ancestor dirs."""
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    body = _get(
        test_client, "/api/files/tree", workspace_id=workspace_id, path=""
    ).json()
    names = {child["name"] for child in body["root"]["children"]}
    assert "ignored.txt" not in names
    assert "ignored_dir" not in names


def test_tree_scoped_walk_fallback_lists_frontier_dirs(client, monkeypatch):
    """With rg unavailable, the walk still surfaces subdirs at the frontier —
    it lists the scoped subtree unbounded and ``_build_tree`` prunes."""
    monkeypatch.setattr(shutil, "which", lambda *args, **kwargs: None)
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    body = _get(
        test_client,
        "/api/files/tree",
        workspace_id=workspace_id,
        path="src",
    ).json()
    by_name = {child["name"]: child for child in body["root"]["children"]}
    assert by_name["main.py"]["type"] == "file"
    assert by_name["lib"]["type"] == "dir"
    assert by_name["lib"]["children"] == []


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


# --------------------------------------------------------------------- #
# PUT /api/files — the writable viewer's save path                       #
# --------------------------------------------------------------------- #


def _put(client, path: str, body: dict, workspace_id: str, **params):
    return client.put(
        "/api/files",
        params={"workspace_id": workspace_id, "path": path, **params},
        json=body,
        headers=AUTH,
    )


def test_write_file_requires_auth(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    assert test_client.put("/api/files").status_code == 401
    assert (
        test_client.put(
            "/api/files",
            params={"workspace_id": workspace_id, "path": "README.md"},
            json={"content": "x"},
            headers={"Authorization": "Bearer wrong"},
        ).status_code
        == 401
    )


def test_read_file_returns_version(client):
    """``version`` is the conflict token: same bytes -> same token."""
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    response = _get(
        test_client, "/api/files", workspace_id=workspace_id, path="README.md"
    )
    assert response.status_code == 200
    version = response.json()["version"]
    assert isinstance(version, str) and version
    again = _get(test_client, "/api/files", workspace_id=workspace_id, path="README.md")
    assert again.json()["version"] == version
    # A different file (different bytes) yields a different token.
    other = _get(
        test_client,
        "/api/files",
        workspace_id=workspace_id,
        path="src/main.py",
    )
    assert other.json()["version"] != version


def test_write_file_roundtrip_updates_content_and_stat(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    before = _get(
        test_client, "/api/files", workspace_id=workspace_id, path="README.md"
    ).json()

    response = _put(
        test_client,
        "README.md",
        {"content": "# rewritten\n"},
        workspace_id,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["content"] == "# rewritten\n"
    assert body["size"] == len(b"# rewritten\n")
    assert body["path"] == "README.md"
    assert body["language"] == "markdown"
    assert body["kind"] == "text"
    assert body["version"] != before["version"]

    # The file on disk and a fresh GET agree with the write response.
    assert (project / "README.md").read_text() == "# rewritten\n"
    fetched = _get(
        test_client, "/api/files", workspace_id=workspace_id, path="README.md"
    ).json()
    assert fetched["content"] == "# rewritten\n"
    assert fetched["version"] == body["version"]


def test_write_file_accepts_absolute_in_workspace_path(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    response = _put(
        test_client,
        str(project / "src" / "main.py"),
        {"content": "print('v2')\n"},
        workspace_id,
    )
    assert response.status_code == 200
    assert response.json()["path"] == "src/main.py"
    assert (project / "src" / "main.py").read_text() == "print('v2')\n"


def test_write_file_rejects_paths_outside_root(client):
    test_client, project = client
    outside = project.parent / "outside.txt"
    outside.write_text("nope\n")
    workspace_id = _workspace_id(test_client, project)
    for bad in ("../outside.txt", str(outside), "src/../../outside.txt"):
        response = _put(test_client, bad, {"content": "pwned\n"}, workspace_id)
        assert response.status_code == 403, bad
    assert outside.read_text() == "nope\n"


def test_write_file_rejects_symlink_escape(client):
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
        response = _put(test_client, bad, {"content": "pwned\n"}, workspace_id)
        assert response.status_code == 403, bad
    assert outside.read_text() == "nope\n"
    assert (outside_dir / "evil.txt").read_text() == "nope\n"


def test_write_file_rejects_protected_paths(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    for protected in (".env", "key.pem", "src/secrets.txt", ".git/config"):
        response = _put(test_client, protected, {"content": "x"}, workspace_id)
        assert response.status_code == 403, protected


def test_write_file_missing_and_directory(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    # Writes don't create files: the viewer only saves files it could read.
    assert (
        _put(test_client, "gone.txt", {"content": "x"}, workspace_id).status_code == 404
    )
    assert not (project / "gone.txt").exists()
    assert _put(test_client, "src", {"content": "x"}, workspace_id).status_code == 400


def test_write_file_rejects_nul_and_oversize(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    assert (
        _put(
            test_client,
            "README.md",
            {"content": "a\x00b"},
            workspace_id,
        ).status_code
        == 400
    )
    assert (
        _put(
            test_client,
            "README.md",
            {"content": "x" * (2 * 1024 * 1024 + 1)},
            workspace_id,
        ).status_code
        == 413
    )
    assert (project / "README.md").read_text() == "# proj\n"


def test_write_file_unknown_workspace_is_404(client):
    test_client, _ = client
    assert (
        _put(
            test_client, "README.md", {"content": "x"}, workspace_id="nope"
        ).status_code
        == 404
    )


def test_write_file_if_match_conflict(client):
    """Save-time conflict guard: a stale ``if_match`` gets a 409."""
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    version = _get(
        test_client, "/api/files", workspace_id=workspace_id, path="README.md"
    ).json()["version"]

    # The file moves under the open buffer (agent write, external edit).
    (project / "README.md").write_text("# agent wrote this\n")

    conflict = _put(
        test_client,
        "README.md",
        {"content": "# user edits\n", "if_match": version},
        workspace_id,
    )
    assert conflict.status_code == 409
    # The 409 refuses the write — the agent's content survives.
    assert (project / "README.md").read_text() == "# agent wrote this\n"

    # A matching if_match still saves.
    fresh = _get(
        test_client, "/api/files", workspace_id=workspace_id, path="README.md"
    ).json()["version"]
    ok = _put(
        test_client,
        "README.md",
        {"content": "# user edits\n", "if_match": fresh},
        workspace_id,
    )
    assert ok.status_code == 200
    assert (project / "README.md").read_text() == "# user edits\n"


def test_write_file_without_if_match_overwrites(client):
    """Omitting ``if_match`` skips the guard — the deliberate clobber path."""
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    (project / "README.md").write_text("# drifted\n")
    response = _put(
        test_client,
        "README.md",
        {"content": "# forced\n"},
        workspace_id,
    )
    assert response.status_code == 200
    assert (project / "README.md").read_text() == "# forced\n"


def test_write_file_rejects_unexpected_body_keys(client):
    test_client, project = client
    workspace_id = _workspace_id(test_client, project)
    response = _put(
        test_client,
        "README.md",
        {"content": "x", "surprise": True},
        workspace_id,
    )
    assert response.status_code == 422
