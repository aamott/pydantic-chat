"""User-tool REST routes: ``/api/user-tools``.

The registry is one JSON row in the settings KV table (``user_tools`` — see
:mod:`app.user_tools`) carrying enable flags keyed ``"{origin}:{rel_path}"``;
the files themselves live in the global dir (``data_dir()/tools``) or the
workspace tool dir (``.pydantic-chat/tools``). Listings are ``ast``-parsed —
user code is only ever executed at run-build time, never to render a
settings page.

Source reads/writes are jailed: workspace files go through
``_resolve_workspace_file`` containment (lexical + resolved, protected
patterns) restricted to the recognized tool dirs; global files get the same
double-check under ``data_dir()/tools``. Unlike ``PUT /api/files`` the source
route *creates* missing files — that's how a new tool is first written.

Never log file contents: paths only.
"""

from __future__ import annotations

import logging
import os
import stat
import tempfile
from pathlib import Path, PurePath

from anyio.to_thread import run_sync
from fastapi import APIRouter, HTTPException, Query, status

from app.api.deps import StoreDep
from app.api.files import MAX_FILE_BYTES, _resolve_workspace_file
from app.api.schemas import (
    SkippedUserToolFunctionOut,
    UserToolCreate,
    UserToolFunctionOut,
    UserToolOut,
    UserToolPatch,
    UserToolSourceIn,
    UserToolSourceOut,
    UserToolSpec,
)
from app.user_tools import (
    TOOL_FILENAME_RE,
    WORKSPACE_TOOL_DIRS,
    discover_user_tool_files,
    enabled_flags,
    global_tools_dir,
    load_user_tools,
    parse_tool_key,
    parse_user_tool_file,
    save_user_tools,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/user-tools", tags=["user-tools"])

_TOOL_TEMPLATE = '''\
"""{name} — user-defined tools.

Every top-level public function here becomes an LLM tool named
``user_<func>``; the signature's type hints become the tool schema and the
docstring its description.
"""


def example_tool(name: str) -> str:
    """Describe what this tool does so the model knows when to call it.

    Args:
        name: Describe the parameter.
    """
    return f"Hello, {{name}}!"
'''


# ---------------------------------------------------------------------------
# Resolution helpers
# ---------------------------------------------------------------------------


async def _workspace_root(store: StoreDep, workspace_id: str) -> Path:
    """The workspace's existing root, or a 404 (unknown row or missing folder)."""
    workspace = await store.get_workspace(workspace_id)
    if workspace is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No workspace named {workspace_id!r}",
        )
    root = Path(workspace.path).resolve()
    if not root.is_dir():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace path does not exist",
        )
    return root


def _check_tool_rel_shape(origin: str, rel_path: str) -> None:
    """Restrict ``rel_path`` to ``*.py`` files directly inside a tool dir.

    Global keys name a bare file (``greet.py``); workspace keys name
    ``<tool-dir>/<file>`` where the dir is one of
    :data:`WORKSPACE_TOOL_DIRS` — deeper nesting wouldn't be discovered
    anyway, so the API refuses to create files it couldn't list.
    """
    parts = PurePath(rel_path).parts
    if origin == "global":
        if len(parts) != 1 or not rel_path.endswith(".py"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Global tool paths must be a bare '*.py' filename",
            )
        return
    if len(parts) != 3 or not rel_path.endswith(".py"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Workspace tool paths must be '<tool-dir>/<file>.py'",
        )
    if PurePath(*parts[:2]).as_posix() not in WORKSPACE_TOOL_DIRS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Tool dir must be one of {', '.join(WORKSPACE_TOOL_DIRS)}",
        )


def _resolve_global_tool_path(rel_path: str) -> Path:
    """``rel_path`` resolved under the global tool dir — jailed both spellings.

    Same contract as ``_resolve_workspace_file``: inside the base lexically
    (``..`` normalized) and after symlink resolution.
    """
    base = global_tools_dir().resolve()
    lexical = Path(os.path.normpath(base / rel_path))
    resolved = lexical.resolve()
    for candidate in (lexical, resolved):
        if not candidate.is_relative_to(base):
            logger.info("Rejected global tool path %r: escapes %s", rel_path, base)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Path is outside the global tools directory",
            )
    return resolved


async def _resolve_tool_file(
    store: StoreDep, key: str, workspace_id: str | None
) -> Path:
    """The absolute path a ``{origin}:{rel_path}`` key names, fully jailed.

    Workspace-origin keys need ``workspace_id`` to locate the root (the same
    key means the same rel-path in *any* workspace — the flag is global, the
    file is not).
    """
    parsed = parse_tool_key(key)
    if parsed is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Malformed tool key {key!r} — expected '{{origin}}:{{rel_path}}'",
        )
    origin, rel_path = parsed
    _check_tool_rel_shape(origin, rel_path)
    if origin == "global":
        return _resolve_global_tool_path(rel_path)
    if workspace_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="workspace_id is required for workspace-origin tool keys",
        )
    root = await _workspace_root(store, workspace_id)
    return _resolve_workspace_file(root, rel_path)


def _write_source_file(target: Path, source: str) -> None:
    """Write ``source`` to ``target``, creating it if needed, atomically.

    Mirrors ``_write_file_bytes`` (temp file + ``os.replace``, mode preserved
    on overwrite) minus the must-exist and ``if_match`` checks — this route's
    job is precisely to create files the plain file API can't.
    """
    if "\x00" in source:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="NUL bytes are not writable",
        )
    data = source.encode("utf-8")
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Source exceeds the {MAX_FILE_BYTES}-byte limit",
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=target.parent, prefix=f".{target.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        if target.exists():
            os.chmod(tmp, stat.S_IMODE(target.stat().st_mode))
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)


def _tool_out(specs: list[UserToolSpec], file) -> UserToolOut:
    """Build the listing row for one discovered file (ast-parsed, never exec'd)."""
    parsed = parse_user_tool_file(file.path)
    enabled = enabled_flags(specs).get(file.key, True)
    skipped_reason = None
    if file.shadowed_by is not None:
        skipped_reason = f"shadowed by {file.shadowed_by}"
    elif parsed.error is None and not parsed.functions:
        skipped_reason = "no public functions"
    return UserToolOut(
        key=file.key,
        name=file.name,
        origin=file.origin,
        rel_path=file.rel_path,
        enabled=enabled,
        docstring=parsed.docstring,
        functions=[
            UserToolFunctionOut(name=fn.name, docstring=fn.docstring)
            for fn in parsed.functions
            if fn.legal
        ],
        skipped_functions=[
            SkippedUserToolFunctionOut(
                name=fn.name,
                reason="illegal tool name (must match [a-z0-9_], user_<name> ≤64 chars)",
            )
            for fn in parsed.functions
            if not fn.legal
        ],
        error=parsed.error,
        skipped_reason=skipped_reason,
    )


async def _listing(store: StoreDep, workspace_id: str | None) -> list[UserToolOut]:
    """The merged discovered+registry view for ``GET``/``POST`` responses."""
    root: Path | None = None
    if workspace_id is not None:
        workspace = await store.get_workspace(workspace_id)
        if workspace is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No workspace named {workspace_id!r}",
            )
        candidate = Path(workspace.path)
        if candidate.is_dir():
            root = candidate
        else:
            # Missing folder lists global tools only — the row is already
            # flagged `missing` for the UI (same as /api/skills).
            logger.warning(
                "Workspace %r path %s is missing; skipping its tool dirs",
                workspace_id,
                workspace.path,
            )
    specs = await load_user_tools(store)
    return [_tool_out(specs, file) for file in discover_user_tool_files(root)]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("")
async def list_user_tools(
    store: StoreDep, workspace_id: str | None = None
) -> list[UserToolOut]:
    """Every discovered tool file, ast-parsed — never imported.

    ``workspace_id`` adds that workspace's tool dir
    (``.pydantic-chat/tools``); workspace files shadow global ones of the
    same basename (the loser reports ``skipped_reason``). An unknown
    workspace is a 404, matching ``/api/skills``.
    """
    return await _listing(store, workspace_id)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_user_tool(body: UserToolCreate, store: StoreDep) -> list[UserToolOut]:
    """Create a tool file; ``source`` defaults to a starter template.

    Global files land in ``data_dir()/tools``; workspace files in
    ``<root>/.pydantic-chat/tools`` (the canonical — and only — workspace
    tool dir). An existing file is a 409. The file is enabled by default —
    nothing is written to the registry.
    """
    if not TOOL_FILENAME_RE.fullmatch(body.filename):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Illegal filename {body.filename!r} — expected 'name.py' ([a-z0-9_-])",
        )
    if body.origin == "global":
        directory = global_tools_dir()
    else:
        if body.workspace_id is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="workspace_id is required for workspace-origin tools",
            )
        root = await _workspace_root(store, body.workspace_id)
        # The canonical write target is the first workspace tool dir.
        directory = root / WORKSPACE_TOOL_DIRS[0]
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / body.filename
    if target.exists():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A tool file named {body.filename!r} already exists there",
        )
    source = (
        body.source
        if body.source is not None
        else _TOOL_TEMPLATE.format(name=target.stem)
    )
    await run_sync(_write_source_file, target, source)
    logger.info("Created user-tool file %s", target)
    return await _listing(
        store, body.workspace_id if body.origin == "workspace" else None
    )


@router.patch("")
async def patch_user_tool(body: UserToolPatch, store: StoreDep) -> list[UserToolSpec]:
    """Toggle one file's ``enabled`` flag; returns the registry.

    The row is upserted even when the file isn't currently discoverable —
    a workspace key's flag survives the workspace being absent right now,
    and a global file re-created later picks its flag back up.
    """
    parsed = parse_tool_key(body.key)
    if parsed is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Malformed tool key {body.key!r} — expected '{{origin}}:{{rel_path}}'",
        )
    origin, rel_path = parsed
    specs = await load_user_tools(store)
    for index, spec in enumerate(specs):
        if spec.key == body.key:
            specs[index] = spec.model_copy(update={"enabled": body.enabled})
            break
    else:
        specs.append(
            UserToolSpec(
                key=body.key,
                name=Path(rel_path).stem,
                origin=origin,
                rel_path=rel_path,
                enabled=body.enabled,
            )
        )
    await save_user_tools(store, specs)
    logger.info("User tool %r enabled=%s", body.key, body.enabled)
    return specs


@router.get("/source")
async def read_user_tool_source(
    store: StoreDep,
    key: str = Query(min_length=1),
    workspace_id: str | None = None,
) -> UserToolSourceOut:
    """One tool file's source — jailed read under its tool dir."""
    target = await _resolve_tool_file(store, key, workspace_id)
    if not target.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Tool file not found"
        )
    data = await run_sync(target.read_bytes)
    return UserToolSourceOut(source=data.decode("utf-8", errors="replace"))


@router.put("/source")
async def write_user_tool_source(
    body: UserToolSourceIn, store: StoreDep
) -> UserToolSourceOut:
    """Replace a tool file's source — or create it (unlike ``PUT /api/files``).

    The target is jailed to a tool dir exactly as reads are; creates
    auto-mkdir the tool dir.
    """
    target = await _resolve_tool_file(store, body.key, body.workspace_id)
    if target.exists() and not target.is_file():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Path is not a file"
        )
    await run_sync(_write_source_file, target, body.source)
    logger.info("Wrote user-tool file %s", target)
    return UserToolSourceOut(source=body.source)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user_tool(
    store: StoreDep,
    key: str = Query(min_length=1),
    workspace_id: str | None = None,
) -> None:
    """Remove a tool file and its registry row.

    A file already gone but still flagged in the registry cleans up to a
    204; nothing found anywhere is a 404.
    """
    target = await _resolve_tool_file(store, key, workspace_id)
    specs = await load_user_tools(store)
    remaining = [spec for spec in specs if spec.key != key]
    if not target.exists() and len(remaining) == len(specs):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Tool file not found"
        )
    if target.exists():
        if not target.is_file():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Path is not a file"
            )
        await run_sync(target.unlink)
    if len(remaining) != len(specs):
        await save_user_tools(store, remaining)
    logger.info("Deleted user-tool file %s", target)
