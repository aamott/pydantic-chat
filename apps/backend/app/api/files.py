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
import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path, PurePath

from anyio.to_thread import run_sync
from fastapi import APIRouter, HTTPException, Query, status
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


def _read_file_bytes(target: Path) -> tuple[bytes, int]:
    """Stat and read a regular file, enforcing the size cap and binary sniff.

    Runs on a worker thread; returns the raw bytes and byte size.

    Raises:
        HTTPException: 404 missing, 400 not a regular file, 413 too large or
            binary (a null byte in the first ``BINARY_SNIFF_BYTES``).
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
    if info.st_size > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"File exceeds the {MAX_FILE_BYTES}-byte limit",
        )
    data = target.read_bytes()
    if b"\x00" in data[:BINARY_SNIFF_BYTES]:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="Binary files are not served",
        )
    return data, len(data)


def _file_version(data: bytes) -> str:
    """The ``FileOut.version`` conflict token — a sha256 of the raw bytes.

    A content hash (not mtime) is the conflict signal: mtime granularity
    varies across filesystems, and an agent rewrite that lands identical
    bytes shouldn't read as drift.
    """
    return hashlib.sha256(data).hexdigest()


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


def _rg_files(root: Path) -> list[str]:
    """``rg --files --sort path`` — gitignore-aware, matching Coder's ``list_files``."""
    result = subprocess.run(
        ["rg", "--files", "--sort", "path"],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=RG_TIMEOUT_SECONDS,
        check=False,
    )
    # rg exits 1 on "no matches" (an empty tree) and 2 on a real error.
    if result.returncode not in (0, 1):
        raise RuntimeError(f"rg --files exited {result.returncode}")
    return result.stdout.splitlines()


def _walk_files(root: Path, depth: int, cap: int) -> tuple[list[str], bool]:
    """Bounded ``os.walk`` fallback for when ``rg`` is unavailable.

    Skips hidden entries, ``_SKIP_DIR_NAMES``, and symlinked directories
    (``followlinks=False`` already declines to descend them; this keeps them
    out of the listing too, as ``rg`` would). Returns root-relative POSIX paths
    and whether the ``cap`` cut the listing short.
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
        if len(rel_dir.parts) + 1 > depth:
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


def _build_tree(root: Path, rel_paths: list[str], depth: int) -> FileTreeNode:
    """Nest root-relative file paths into a ``FileTreeNode`` dir tree.

    Files deeper than ``depth`` levels are pruned; directories appear only as
    ancestors of listed files (``rg --files`` reports no empty dirs — a known
    ``list_files`` parity quirk).
    """
    nested: dict[str, dict | None] = {}
    for rel in rel_paths:
        parts = PurePath(rel).parts
        if not parts or len(parts) > depth:
            continue
        cursor = nested
        for part in parts[:-1]:
            child = cursor.setdefault(part, {})
            if child is None:  # a file already claims this name; cannot nest
                break
            cursor = child
        else:
            cursor.setdefault(parts[-1], None)
    return _to_node(root.name or str(root), "", nested)


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
    """Read one UTF-8 file under the workspace root (the viewer's fetch)."""
    workspace = await _require_workspace(store, workspace_id)
    root = _existing_root(workspace)
    target = _resolve_workspace_file(root, path)
    data, size = await run_sync(_read_file_bytes, target)
    return FileOut(
        content=data.decode("utf-8", errors="replace"),
        language=_language_for(target.name),
        size=size,
        path=target.relative_to(root).as_posix(),
        version=_file_version(data),
    )


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
    depth: int = Query(default=3, ge=1, le=20),
) -> FileTreeOut:
    """The workspace's directory tree, gitignore-aware when ``rg`` is on PATH."""
    workspace = await _require_workspace(store, workspace_id)
    root = _existing_root(workspace)

    rel_paths: list[str] | None = None
    truncated = False
    if shutil.which("rg"):
        try:
            rel_paths = await run_sync(_rg_files, root)
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            logger.warning(
                "rg --files failed for workspace %s; falling back to a walk",
                workspace.id,
                exc_info=True,
            )
    if rel_paths is None:
        rel_paths, truncated = await run_sync(
            _walk_files, root, depth, MAX_TREE_ENTRIES
        )
    elif len(rel_paths) > MAX_TREE_ENTRIES:
        rel_paths, truncated = rel_paths[:MAX_TREE_ENTRIES], True

    return FileTreeOut(root=_build_tree(root, rel_paths, depth), truncated=truncated)
