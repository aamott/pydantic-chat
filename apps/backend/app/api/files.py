"""Workspace file-serving routes: read one file, list the workspace tree.

Both endpoints jail paths to the workspace root recorded in the store. The
containment check mirrors ``pydantic_ai_harness``'s ``FileSystem`` semantics —
the target must sit under the root both as written (lexically normalized) and
once symlinks are resolved. The toolset's own ``_resolve_path`` is not reused
because it runs through the agent-run ``WorkspaceBackend`` abstraction
(``RunContext.workspace``) and cannot be called outside a run; the
protected-pattern matching *is* reused —
``pydantic_ai_harness.filesystem._access.first_matching_pattern`` is a pure
function carrying the capability's exact ``**/`` and ancestor semantics.

Never log file contents: paths only.
"""

from __future__ import annotations

import hashlib
import logging
import mimetypes
import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path, PurePath
from typing import Literal

from anyio.to_thread import run_sync
from fastapi import APIRouter, HTTPException, Query, Response, status
from pydantic_ai_harness.filesystem._access import first_matching_pattern

from app.api.deps import StoreDep
from app.api.schemas import FileOut, FileTreeNode, FileTreeOut, FileWriteIn
from app.db import Workspace

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/files", tags=["files"])

MAX_FILE_BYTES = 2 * 1024 * 1024
"""Most bytes one ``GET /api/files`` returns; larger files get a 413."""

BINARY_SNIFF_BYTES = 8 * 1024
"""A null byte in this leading window marks the file as binary."""

MAX_TREE_ENTRIES = 5_000
"""Most file paths one tree response nests before reporting ``truncated``."""

RG_TIMEOUT_SECONDS = 15
"""How long ``rg --files`` may run before the endpoint falls back to a walk."""

# Mirrors ``FileSystem``'s ``_DEFAULT_READ_ONLY`` (verified against
# pydantic-ai-harness 0.68.0), applied here as *denied*: the viewer must not
# read secrets at all, where the agent may only be forbidden to write them.
PROTECTED_PATTERNS: tuple[str, ...] = (
    "**/.git",
    "**/.env",
    "**/.env.*",
    "*.pem",
    "*.key",
    "**/secrets*",
    "**/.pydantic-ai-harness/**",
)

_SKIP_DIR_NAMES = frozenset({".git", "node_modules", "__pycache__", ".venv"})
"""Directories the fallback walk never descends (hidden names are skipped too)."""

# Filename/extension → CodeMirror ``language-data`` name. Deliberately small:
# the frontend falls back to extensionless highlighting for anything unmapped.
_LANGUAGE_BY_NAME = {
    "dockerfile": "dockerfile",
    "cmakelists.txt": "cmake",
}

_LANGUAGE_BY_SUFFIX = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".json": "json",
    ".html": "html",
    ".css": "css",
    ".scss": "sass",
    ".less": "less",
    ".md": "markdown",
    ".markdown": "markdown",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".sql": "sql",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".c": "cpp",
    ".h": "cpp",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".php": "php",
    ".rb": "ruby",
    ".sh": "shell",
    ".vue": "vue",
    ".svelte": "svelte",
}


def _language_for(name: str) -> str | None:
    """A ``@codemirror/language-data`` language name for the file, if known."""
    if language := _LANGUAGE_BY_NAME.get(name.lower()):
        return language
    return _LANGUAGE_BY_SUFFIX.get(Path(name).suffix.lower())


# Extensions rendered inline as images rather than as text. Detection is
# extension-only (before the NUL sniff): an SVG is perfectly valid UTF-8
# text but still wants the image branch.
_IMAGE_SUFFIXES = frozenset(
    {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif"}
)

# Extensions classified binary by name — content sniffing can't catch
# ASCII-shaped containers (`.stl`, `.dxf` can be pure text yet are CAD data,
# not files you edit), and a large archive/executable may carry its first
# NUL past the sniff window. Formats that are genuinely editable text stay
# off this list (`.gltf` is JSON, `.gcode`/`.scad` are real source).
_KNOWN_BINARY_SUFFIXES = frozenset(
    {
        # 3D / CAD (binary AND ascii-shaped variants)
        ".3mf",
        ".stl",
        ".step",
        ".stp",
        ".igs",
        ".iges",
        ".dxf",
        ".glb",
        ".fbx",
        ".blend",
        ".obj",
        # archives / disk images
        ".zip",
        ".7z",
        ".rar",
        ".gz",
        ".bz2",
        ".xz",
        ".zst",
        ".tar",
        ".iso",
        ".dmg",
        ".img",
        # executables / compiled
        ".exe",
        ".dll",
        ".so",
        ".dylib",
        ".wasm",
        ".o",
        ".a",
        ".lib",
        ".class",
        ".jar",
        ".pyc",
        ".pyo",
        ".pyd",
        ".whl",
        # office docs
        ".pdf",
        ".doc",
        ".docx",
        ".xls",
        ".xlsx",
        ".ppt",
        ".pptx",
        ".pages",
        ".numbers",
        ".key",
        # audio / video
        ".mp3",
        ".mp4",
        ".m4a",
        ".wav",
        ".flac",
        ".ogg",
        ".opus",
        ".aac",
        ".mov",
        ".avi",
        ".mkv",
        ".webm",
        ".mpg",
        ".mpeg",
        # fonts + non-renderable image formats
        ".woff",
        ".woff2",
        ".ttf",
        ".otf",
        ".eot",
        ".tif",
        ".tiff",
        ".heic",
        ".heif",
        ".psd",
        ".raw",
        ".dng",
        # data / ML artifacts
        ".db",
        ".sqlite",
        ".sqlite3",
        ".npy",
        ".npz",
        ".pkl",
        ".pickle",
        ".onnx",
        ".pt",
        ".pth",
        ".ckpt",
        ".gguf",
        ".safetensors",
        ".h5",
        ".hdf5",
        ".parquet",
        ".feather",
        ".arrow",
        # misc
        ".bin",
        ".dat",
    }
)

FileKind = Literal["text", "image", "binary"]


def _kind_for(name: str, data: bytes) -> FileKind:
    """The viewer's render branch for one file.

    Image extensions win by name — content sniffing can't tell an SVG from
    other markup, and a mislabeled image still renders best-effort through
    ``<img>``. Known-binary extensions win next: ASCII-shaped CAD data and
    late-NUL archives would otherwise slip the sniff. Everything else is
    text unless a NUL byte lands in the first ``BINARY_SNIFF_BYTES``.
    """
    suffix = Path(name).suffix.lower()
    if suffix in _IMAGE_SUFFIXES:
        return "image"
    if suffix in _KNOWN_BINARY_SUFFIXES:
        return "binary"
    if b"\x00" in data[:BINARY_SNIFF_BYTES]:
        return "binary"
    return "text"


def _resolve_workspace_file(root: Path, raw: str) -> Path:
    """Resolve ``raw`` under ``root``, enforcing containment and protected patterns.

    Like ``FileSystemToolset._resolve_path``, the path must be inside ``root``
    twice: lexically (``..`` normalized, no symlinks followed) and after
    resolving symlinks. Both spellings are also checked against
    ``PROTECTED_PATTERNS`` so a link named innocently cannot reach a denied
    target, nor a denied name reach an innocent target.

    Returns:
        The fully resolved absolute path, guaranteed inside ``root``.

    Raises:
        HTTPException: 403 when the path escapes the root or is protected.
    """
    lexical = Path(os.path.normpath(root / raw))
    resolved = lexical.resolve()
    for candidate in (lexical, resolved):
        if not candidate.is_relative_to(root):
            logger.info("Rejected %r: resolves outside workspace root %s", raw, root)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Path is outside the workspace root",
            )
        rel = candidate.relative_to(root).as_posix()
        if matched := first_matching_pattern(rel, PROTECTED_PATTERNS):
            logger.info("Rejected %r: matches protected pattern %r", raw, matched)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Path matches a protected pattern",
            )
    return resolved


def _resolve_workspace_dir(root: Path, raw: str) -> Path:
    """``_resolve_workspace_file`` for a directory target (``tree?path=``).

    Same lexical + resolved containment and protected-pattern checks; the
    resolved path must additionally exist and be a directory.

    Raises:
        HTTPException: 403 escapes/protected (from the file resolver), 404
            missing, 400 not a directory.
    """
    target = _resolve_workspace_file(root, raw)
    try:
        info = target.stat()
    except FileNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Directory not found"
        ) from None
    if not stat.S_ISDIR(info.st_mode):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Path is not a directory",
        )
    return target


def _stat_regular_file(target: Path) -> os.stat_result:
    """Stat ``target`` as a regular file — no bytes read.

    Runs on a worker thread; the JSON read uses it to classify a file
    before deciding whether a full read is even warranted.

    Raises:
        HTTPException: 404 missing, 400 not a regular file.
    """
    try:
        info = target.stat()
    except FileNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
        ) from None
    if not stat.S_ISREG(info.st_mode):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Path is not a file"
        )
    return info


def _read_head(target: Path) -> bytes:
    """The leading ``BINARY_SNIFF_BYTES`` of ``target`` — kind sniffing + the
    drift token for files the viewer never sees whole."""
    with target.open("rb") as fh:
        return fh.read(BINARY_SNIFF_BYTES)


def _read_file_bytes(target: Path) -> tuple[bytes, int]:
    """Stat and read a regular file, enforcing the size cap.

    Runs on a worker thread; returns the raw bytes and byte size. Binary
    content is *not* rejected here — ``_kind_for`` classifies it, the JSON
    read withholds the body, and the raw route serves it verbatim.

    Raises:
        HTTPException: 404 missing, 400 not a regular file, 413 too large.
    """
    info = _stat_regular_file(target)
    if info.st_size > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"File exceeds the {MAX_FILE_BYTES}-byte limit",
        )
    data = target.read_bytes()
    return data, len(data)


def _file_version(data: bytes) -> str:
    """The ``FileOut.version`` conflict token — a sha256 of the raw bytes.

    A content hash (not mtime) is the conflict signal: mtime granularity
    varies across filesystems, and an agent rewrite that lands identical
    bytes shouldn't read as drift.
    """
    return hashlib.sha256(data).hexdigest()


def _partial_version(head: bytes, size: int) -> str:
    """Drift token for files the viewer never sees whole (binary/oversize).

    sha256 over the head window plus the byte size — cheap on any size, and
    a change almost certainly alters one of the two. Not comparable to
    ``_file_version`` output: a file crossing into/out of oversize gets a
    fresh token either way, which correctly reads as drift.
    """
    return hashlib.sha256(head + str(size).encode()).hexdigest()


def _write_file_bytes(target: Path, content: str, if_match: str | None) -> bytes:
    """Validate and write ``content`` to ``target``; returns the bytes written.

    Runs on a worker thread. Guards mirror ``_read_file_bytes`` — the viewer
    can only save files it could have read (existing regular file, same size
    cap, no NUL bytes) — plus the save-time conflict check: when ``if_match``
    carries the ``version`` from the client's read, a drifted file gets a 409
    instead of a silent clobber. The check-then-write gap is accepted for v1
    (no fs watching — see the story's known shortcomings).

    The write itself goes through a same-directory temp file + ``os.replace``
    so a crash mid-write can't leave a truncated file, and the original
    file's mode is copied onto the temp first.

    Raises:
        HTTPException: 400 not a regular file or NUL in ``content``, 404
            missing, 409 ``if_match`` stale, 413 content over the size cap.
    """
    try:
        info = target.stat()
    except FileNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
        ) from None
    if not stat.S_ISREG(info.st_mode):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Path is not a file"
        )
    if "\x00" in content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="NUL bytes are not writable (binary file?)",
        )
    data = content.encode("utf-8")
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Content exceeds the {MAX_FILE_BYTES}-byte limit",
        )
    if if_match is not None:
        current = target.read_bytes()
        if _file_version(current) != if_match:
            logger.info("Rejected write to %s: if_match is stale", target)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="File changed on disk since it was read",
            )

    fd, tmp_name = tempfile.mkstemp(
        dir=target.parent, prefix=f".{target.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        # fdopen+write can't short-write the way a bare os.write can.
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        fd = -1  # fdopen owns the descriptor now
        # Preserve the original mode — mkstemp creates 0o600.
        os.chmod(tmp, stat.S_IMODE(info.st_mode))
        os.replace(tmp, target)
    finally:
        if fd >= 0:
            os.close(fd)
        tmp.unlink(missing_ok=True)
    return data


def _rg_files(cwd: Path) -> list[str]:
    """``rg --files --sort path`` — gitignore-aware, matching Coder's ``list_files``.

    Runs inside ``cwd`` (the workspace root, or a scoped subdirectory for
    ``tree?path=``) so the returned paths are relative to it. ``rg`` still
    applies the repo's ignore rules from ancestor directories, so a scoped
    run stays gitignore-aware.
    """
    result = subprocess.run(
        ["rg", "--files", "--sort", "path"],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=RG_TIMEOUT_SECONDS,
        check=False,
    )
    # rg exits 1 on "no matches" (an empty tree) and 2 on a real error.
    if result.returncode not in (0, 1):
        raise RuntimeError(f"rg --files exited {result.returncode}")
    return result.stdout.splitlines()


def _walk_files(root: Path, depth: int | None, cap: int) -> tuple[list[str], bool]:
    """Bounded ``os.walk`` fallback for when ``rg`` is unavailable.

    Skips hidden entries, ``_SKIP_DIR_NAMES``, and symlinked directories
    (``followlinks=False`` already declines to descend them; this keeps them
    out of the listing too, as ``rg`` would). ``depth=None`` lists the whole
    subtree — matching ``rg --files``, which has no depth limit — and leaves
    pruning to ``_build_tree``. Returns root-relative POSIX paths and
    whether the ``cap`` cut the listing short.
    """
    rel_paths: list[str] = []
    truncated = False
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            name
            for name in dirnames
            if not name.startswith(".")
            and name not in _SKIP_DIR_NAMES
            and not (Path(dirpath) / name).is_symlink()
        )
        rel_dir = Path(dirpath).relative_to(root)
        # Files inside this directory sit one level deeper; once even those
        # exceed ``depth`` nothing below can qualify, so stop descending too.
        if depth is not None and len(rel_dir.parts) + 1 > depth:
            dirnames[:] = []
            continue
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            rel_paths.append((rel_dir / name).as_posix())
            if len(rel_paths) >= cap:
                truncated = True
                return rel_paths, truncated
    return rel_paths, truncated


def _build_tree(
    name: str,
    path: str,
    rel_paths: list[str],
    depth: int,
    *,
    frontier_dirs: bool = False,
) -> FileTreeNode:
    """Nest listing-root-relative file paths into a ``FileTreeNode`` dir tree.

    ``name``/``path`` label the returned root node (``""`` path for the
    workspace root, the scoped dir's workspace-relative path otherwise).
    Files deeper than ``depth`` levels are pruned — unless ``frontier_dirs``
    is set, in which case their ancestor dirs still materialize at the
    frontier with empty children, so a lazy-loading client knows they exist
    and can fetch them on expand (scoped ``tree?path=`` requests use this).
    Directories appear only as ancestors of listed files (``rg --files``
    reports no empty dirs — a known ``list_files`` parity quirk).
    """
    nested: dict[str, dict | None] = {}
    for rel in rel_paths:
        parts = PurePath(rel).parts
        if not parts:
            continue
        cursor = nested
        if len(parts) > depth:
            if not frontier_dirs:
                continue
            # Only the leading dirs survive — the frontier dir's children
            # stay empty, marking it as "exists but not fetched".
            for part in parts[:depth]:
                child = cursor.setdefault(part, {})
                if child is None:  # a file already claims this name
                    break
                cursor = child
            continue
        for part in parts[:-1]:
            child = cursor.setdefault(part, {})
            if child is None:  # a file already claims this name; cannot nest
                break
            cursor = child
        else:
            cursor.setdefault(parts[-1], None)
    return _to_node(name, path, nested)


def _to_node(name: str, path: str, subtree: dict | None) -> FileTreeNode:
    """Convert one ``_build_tree`` nested-dict level into a ``FileTreeNode``."""
    if subtree is None:
        return FileTreeNode(name=name, path=path, type="file")
    children = [
        _to_node(child_name, f"{path}/{child_name}" if path else child_name, child)
        for child_name, child in sorted(
            subtree.items(), key=lambda item: (item[1] is None, item[0].lower())
        )
    ]
    return FileTreeNode(name=name, path=path, type="dir", children=children)


async def _require_workspace(store: StoreDep, workspace_id: str) -> Workspace:
    """The workspace row or a 404; its path is not required to exist here."""
    workspace = await store.get_workspace(workspace_id)
    if workspace is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found"
        )
    return workspace


def _existing_root(workspace: Workspace) -> Path:
    """The workspace's resolved root, or a 404 when the folder is gone."""
    root = Path(workspace.path).resolve()
    if not root.is_dir():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace path does not exist",
        )
    return root


@router.get("")
async def read_file(
    store: StoreDep,
    workspace_id: str = Query(min_length=1),
    path: str = Query(min_length=1),
) -> FileOut:
    """Read one file under the workspace root (the viewer's fetch).

    Text files carry a UTF-8-decoded ``content``; ``kind`` is ``'image'`` or
    ``'binary'`` when the file isn't text-shaped, and then ``content`` is
    empty — image bytes come from ``GET /api/files/raw`` and binaries are
    opened externally, so no undecodable body crosses the wire. Kind and
    size are determined from a stat plus a bounded head read, so a large
    binary classifies correctly instead of dying on the size cap; any file
    past ``MAX_FILE_BYTES`` returns ``oversize=True`` (the viewer's
    open-externally prompt, not an error).
    """
    workspace = await _require_workspace(store, workspace_id)
    root = _existing_root(workspace)
    target = _resolve_workspace_file(root, path)
    info = await run_sync(_stat_regular_file, target)
    head = await run_sync(_read_head, target)
    kind = _kind_for(target.name, head)
    if kind != "text" or info.st_size > MAX_FILE_BYTES:
        return FileOut(
            content="",
            kind=kind,
            language=_language_for(target.name),
            size=info.st_size,
            path=target.relative_to(root).as_posix(),
            version=_partial_version(head, info.st_size),
            oversize=info.st_size > MAX_FILE_BYTES,
        )
    data = await run_sync(target.read_bytes)
    return FileOut(
        content=data.decode("utf-8", errors="replace"),
        kind=kind,
        language=_language_for(target.name),
        size=len(data),
        path=target.relative_to(root).as_posix(),
        version=_file_version(data),
    )


@router.get("/raw")
async def read_file_raw(
    store: StoreDep,
    workspace_id: str = Query(min_length=1),
    path: str = Query(min_length=1),
) -> Response:
    """One file's raw bytes under the workspace root — the image fetch.

    Same confinement as the JSON read (``_resolve_workspace_file``: lexical
    + resolved containment, protected patterns) and the same size cap. The
    media type is guessed from the extension — images get their real type,
    anything else ``application/octet-stream``.
    """
    workspace = await _require_workspace(store, workspace_id)
    root = _existing_root(workspace)
    target = _resolve_workspace_file(root, path)
    data, _size = await run_sync(_read_file_bytes, target)
    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return Response(content=data, media_type=media_type)


@router.put("")
async def write_file(
    store: StoreDep,
    body: FileWriteIn,
    workspace_id: str = Query(min_length=1),
    path: str = Query(min_length=1),
) -> FileOut:
    """Write one UTF-8 file under the workspace root (the viewer's save).

    Same confinement as the read path — ``_resolve_workspace_file`` — and
    the same "files only, no creation" shape. ``body.if_match`` is the
    save-time conflict guard: echo the ``version`` from the client's last
    read to get a 409 when the file drifted, or omit it to overwrite.
    """
    workspace = await _require_workspace(store, workspace_id)
    root = _existing_root(workspace)
    target = _resolve_workspace_file(root, path)
    data = await run_sync(_write_file_bytes, target, body.content, body.if_match)
    return FileOut(
        content=body.content,
        language=_language_for(target.name),
        size=len(data),
        path=target.relative_to(root).as_posix(),
        version=_file_version(data),
    )


@router.get("/tree")
async def file_tree(
    store: StoreDep,
    workspace_id: str = Query(min_length=1),
    path: str | None = Query(default=None),
    depth: int | None = Query(default=None, ge=1, le=20),
) -> FileTreeOut:
    """The workspace's directory tree, gitignore-aware when ``rg`` is on PATH.

    Omitting ``path`` lists the whole workspace (``depth`` default 3), as
    before. Passing ``path`` — a workspace-relative directory, ``""`` for the
    root — scopes the listing to that directory (``depth`` default 1) for the
    explorer's lazy loading: the returned root node is the directory itself,
    and files deeper than ``depth`` still surface their ancestor dirs at the
    frontier with empty children so the client knows they exist. ``path`` is
    jailed by the same containment as file reads (``_resolve_workspace_file``:
    lexical + resolved checks, protected patterns) and must be an existing
    directory.
    """
    workspace = await _require_workspace(store, workspace_id)
    root = _existing_root(workspace)

    scoped = path is not None
    scope = _resolve_workspace_dir(root, path) if path else root
    effective_depth = depth if depth is not None else (1 if scoped else 3)

    rel_paths: list[str] | None = None
    truncated = False
    if shutil.which("rg"):
        try:
            rel_paths = await run_sync(_rg_files, scope)
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            logger.warning(
                "rg --files failed for workspace %s; falling back to a walk",
                workspace.id,
                exc_info=True,
            )
    if rel_paths is None:
        # Scoped listings walk unbounded — ``_build_tree``'s frontier dirs do
        # the depth pruning, same as the rg path it falls back from.
        rel_paths, truncated = await run_sync(
            _walk_files, scope, None if scoped else effective_depth, MAX_TREE_ENTRIES
        )
    elif len(rel_paths) > MAX_TREE_ENTRIES:
        rel_paths, truncated = rel_paths[:MAX_TREE_ENTRIES], True

    scope_rel = scope.relative_to(root)
    return FileTreeOut(
        root=_build_tree(
            scope.name or str(scope),
            scope_rel.as_posix() if scope_rel.parts else "",
            rel_paths,
            effective_depth,
            frontier_dirs=scoped,
        ),
        truncated=truncated,
    )
