"""User-defined tools: file discovery, settings persistence, per-run building.

Users drop plain ``*.py`` files into a tool directory; every top-level public
``def``/``async def`` becomes an LLM tool named ``user_<func>`` via
``FunctionToolset(fns, id='user_tools').prefixed('user')``.

Discovery dirs (verified against ``pydantic-ai-slim==2.68.0`` /
``pydantic-ai-harness==0.68.0``):

- Global: ``data_dir()/tools/*.py``.
- Workspace-local: ``<root>/.pydantic-chat/tools`` — the app's own
  namespace. Unlike ``WORKSPACE_SKILL_DIRS`` (``.claude/skills`` & co.)
  there is no third-party convention for tool dirs, so the dir is named
  for the app.

Workspace files shadow global files of the same *filename*. Shadowing is
by basename, so ``.pydantic-chat/tools/greet.py`` masks a global
``greet.py``.

Two consumers, two read strategies:

- **Listing** (``GET /api/user-tools``, ``GET /api/tool-catalog``) is pure
  ``ast`` parsing — importing a file runs module-level user code with backend
  privileges, so a settings-page load must never exec it.
- **Run build** (``build_user_tool_capabilities``) compiles+execs each enabled
  file under a digest-keyed ``sys.modules`` name — the same mechanics the
  harness uses in ``capability_creation/_validate.py`` (which itself can't be
  reused: ``load_capability_instance`` demands exactly one
  ``AbstractCapability`` subclass, while our files hold plain functions).
  Exec failures degrade to a logged warning + skip — never a run crash.

Tool names must match ``^[a-z0-9_]{1,59}$`` so ``user_<name>`` fits provider
tool-name regexes (Anthropic ``^[a-zA-Z0-9_-]{1,64}$``; dots are illegal, so
module qualification was never an option). Illegal names are skipped and
reported, never registered.

``Permissions`` only gates file-write kinds and shell-command tools — plain
``FunctionToolset`` tools are invisible to it. So every non-``bypass``
profile wraps the toolset in ``ApprovalRequiredToolset`` exactly as
``build_mcp_capabilities`` does: calls become deferred approvals flowing
through the existing approval-card UI (``smart``'s ``ApprovalReviewer``
judges them too). In-process exec means user tools run with full backend
privileges outside the FileSystem jail — approval gating is the control.

The registry is one JSON row in the settings KV table (``user_tools``),
mirroring ``mcp_servers``: ``list[UserToolSpec]`` of
``{key, name, origin, rel_path, enabled}`` where ``key`` =
``"{origin}:{rel_path}"``. It stores enablement only — the file's contents
and function list always come from disk.
"""

from __future__ import annotations

import ast
import hashlib
import inspect
import json
import logging
import re
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import TYPE_CHECKING, Literal, cast

from pydantic import TypeAdapter, ValidationError
from pydantic_ai.capabilities import Toolset as ToolsetCapability
from pydantic_ai.toolsets import ApprovalRequiredToolset, FunctionToolset

from app.api.schemas import UserToolSpec
from app.config import data_dir

if TYPE_CHECKING:
    from pydantic_ai.capabilities import AbstractCapability

    from app.db.store import ChatStore

logger = logging.getLogger(__name__)

USER_TOOLS_KEY = "user_tools"
"""Settings-table key holding the JSON-encoded ``list[UserToolSpec]``."""

_SPECS_ADAPTER = TypeAdapter(list[UserToolSpec])

WORKSPACE_TOOL_DIRS: tuple[str, ...] = (".pydantic-chat/tools",)
"""Per-workspace tool dirs, in precedence order.

``.pydantic-chat`` is the app's own namespace (same idea as the
``.pydantic-ai-harness`` pattern already in ``PROTECTED_PATTERNS``); the
first entry is the canonical write target — ``POST /api/user-tools``
creates workspace files there.
"""

TOOL_NAME_PREFIX = "user_"
"""Prefix applied by ``.prefixed('user')`` — collision-avoidance + allowlist hook."""

_FUNCTION_NAME_RE = re.compile(r"[a-z0-9_]{1,59}")
"""Legal tool-function names: ``user_<name>`` must fit the 64-char provider limit."""

TOOL_FILENAME_RE = re.compile(r"[a-z0-9_][a-z0-9_-]*\.py")
"""Legal tool-file names for API-created files (bare basename, lowercase)."""

UserToolOrigin = Literal["global", "workspace"]


def global_tools_dir() -> Path:
    """The global tool library: ``data_dir()/tools`` (created on demand, never seeded)."""
    return data_dir() / "tools"


# ---------------------------------------------------------------------------
# Persistence (settings KV table — JSON list, like mcp_servers)
# ---------------------------------------------------------------------------


async def load_user_tools(store: ChatStore) -> list[UserToolSpec]:
    """Every registered user-tool spec, in stored order.

    A missing row reads as ``[]``; malformed entries are skipped with a
    warning (never a crash — the row may have been written by an older
    schema).
    """
    settings = await store.get_settings()
    return parse_user_tools(settings.get(USER_TOOLS_KEY))


async def save_user_tools(store: ChatStore, specs: list[UserToolSpec]) -> None:
    """Rewrite the whole spec list atomically (one JSON settings row)."""
    if not specs:
        await store.delete_setting(USER_TOOLS_KEY)
        return
    payload = json.dumps([spec.model_dump() for spec in specs])
    await store.set_setting(USER_TOOLS_KEY, payload)


def parse_user_tools(raw: object) -> list[UserToolSpec]:
    """Validate a decoded ``user_tools`` value into specs, skipping bad entries.

    ``raw`` is whatever the settings row decoded to (``_decode_setting`` in
    ``app.api.chat`` JSON-decodes it back to a list of dicts). Anything that
    isn't a valid spec is dropped with a warning — one corrupt entry must not
    take the rest of the registry, or the whole run, down.
    """
    if not isinstance(raw, str) and not isinstance(raw, list):
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning(
                "Settings key %r is not valid JSON; ignoring", USER_TOOLS_KEY
            )
            return []
    if not isinstance(raw, list):
        return []
    specs: list[UserToolSpec] = []
    for index, entry in enumerate(raw):
        try:
            specs.append(_SPECS_ADAPTER.validate_python([entry])[0])
        except ValidationError as error:
            key = entry.get("key") if isinstance(entry, dict) else None
            logger.warning(
                "Skipping invalid user-tool entry %d (key=%r): %s",
                index,
                key,
                error.errors()[0]["msg"] if error.errors() else error,
            )
    return specs


def enabled_flags(specs: list[UserToolSpec]) -> dict[str, bool]:
    """A ``key -> enabled`` map over the registry; last write wins on dup keys."""
    return {spec.key: spec.enabled for spec in specs}


def parse_tool_key(key: str) -> tuple[UserToolOrigin, str] | None:
    """Split ``"{origin}:{rel_path}"`` into its parts, or ``None`` if malformed."""
    origin, sep, rel_path = key.partition(":")
    if sep and rel_path and origin in ("global", "workspace"):
        return cast(UserToolOrigin, origin), rel_path
    return None


# ---------------------------------------------------------------------------
# Discovery (filesystem scan — never execs or even parses user code)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DiscoveredUserToolFile:
    """One ``*.py`` file found in a tool dir, with shadowing resolved."""

    key: str
    """``"{origin}:{rel_path}"`` — the stable registry/API identifier."""
    name: str
    """The file stem (``greet`` for ``greet.py``) — the display name."""
    origin: UserToolOrigin
    rel_path: str
    """POSIX path under its base dir's parent: ``greet.py`` (global) or
    ``.pydantic-chat/tools/greet.py`` (workspace)."""
    path: Path
    """Absolute filesystem path."""
    shadowed_by: str | None = None
    """The winning file's ``key`` when a higher-precedence file shares the basename."""


def discover_user_tool_files(
    workspace_root: Path | None = None,
) -> list[DiscoveredUserToolFile]:
    """Scan the tool dirs, workspace-first, marking shadowed files.

    Pure ``is_dir``/``glob`` — nothing is read, parsed, or executed.
    Workspace dirs come first in :data:`WORKSPACE_TOOL_DIRS` order so the
    earlier dir shadows the later; global files come last so any workspace
    file of the same basename shadows them.

    Args:
        workspace_root: The run/listing workspace root, or ``None`` to scan
            the global dir only (missing dirs contribute nothing).

    Returns:
        Every discovered file, winners and shadowed alike — the API listing
        reports shadowed entries with a ``skipped_reason``; run-build ignores
        them.
    """
    candidates: list[tuple[UserToolOrigin, str, Path]] = []
    if workspace_root is not None and workspace_root.is_dir():
        for dirname in WORKSPACE_TOOL_DIRS:
            tool_dir = workspace_root / dirname
            if not tool_dir.is_dir():
                continue
            for path in sorted(tool_dir.glob("*.py")):
                candidates.append(("workspace", f"{dirname}/{path.name}", path))
    global_dir = global_tools_dir()
    if global_dir.is_dir():
        for path in sorted(global_dir.glob("*.py")):
            candidates.append(("global", path.name, path))

    files: list[DiscoveredUserToolFile] = []
    claimed: dict[str, str] = {}  # basename -> winning key
    for origin, rel_path, path in candidates:
        key = f"{origin}:{rel_path}"
        shadowed_by = claimed.get(path.name)
        if shadowed_by is None:
            claimed[path.name] = key
        files.append(
            DiscoveredUserToolFile(
                key=key,
                name=path.stem,
                origin=origin,
                rel_path=rel_path,
                path=path,
                shadowed_by=shadowed_by,
            )
        )
    return files


# ---------------------------------------------------------------------------
# Static parsing (ast only — listing/catalog must never exec user code)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class UserToolFunctionInfo:
    """One top-level public function found by ``ast`` parsing."""

    name: str
    docstring: str | None
    legal: bool
    """Whether the name fits provider tool-name rules (``user_<name>`` ≤64 chars)."""


@dataclass(frozen=True, slots=True)
class ParsedUserToolFile:
    """The ast-extracted view of one tool file."""

    docstring: str | None
    """The module docstring — the file's catalog blurb."""
    functions: tuple[UserToolFunctionInfo, ...]
    error: str | None = None
    """Parse/read failure (``SyntaxError``, undecodable bytes, unreadable file)."""


def parse_user_tool_file(path: Path) -> ParsedUserToolFile:
    """Extract function names + docstrings without importing anything.

    Only *top-level* public ``def``/``async def`` nodes count — the same set
    the exec loader picks up (defs nested in ``if``/``try`` blocks are not
    tools). Private names (leading ``_``) never become tools.
    """
    try:
        source = path.read_bytes()
        tree = ast.parse(source, filename=str(path))
    except (OSError, SyntaxError, ValueError) as error:
        return ParsedUserToolFile(
            docstring=None, functions=(), error=f"{type(error).__name__}: {error}"
        )
    functions = tuple(
        UserToolFunctionInfo(
            name=node.name,
            docstring=ast.get_docstring(node, clean=False),
            legal=is_legal_function_name(node.name),
        )
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and not node.name.startswith("_")
    )
    return ParsedUserToolFile(
        docstring=ast.get_docstring(tree, clean=False), functions=functions
    )


def is_legal_function_name(name: str) -> bool:
    """Whether ``name`` survives ``user_``-prefixing under provider tool-name rules."""
    return bool(_FUNCTION_NAME_RE.fullmatch(name))


# ---------------------------------------------------------------------------
# Runtime loader (compile+exec — run-build only)
# ---------------------------------------------------------------------------

_LOAD_LOCKS: dict[str, threading.RLock] = {}
_LOAD_LOCKS_GUARD = threading.Lock()


def _load_lock(name: str) -> threading.RLock:
    """The lock serializing loads of one source — mirrors harness ``_validate``."""
    with _LOAD_LOCKS_GUARD:
        return _LOAD_LOCKS.setdefault(name, threading.RLock())


def _module_name(path: Path, code: bytes) -> str:
    """The ``sys.modules`` key for ``code`` loaded from ``path``.

    Digest-keyed on resolved path + bytes so re-loading an edited file
    replaces its entry while classes created by earlier versions keep
    resolving annotations through their own module (each loaded version
    stays registered for the process's life — harmless at run cadence).
    """
    digest = hashlib.sha256(str(path.resolve()).encode() + b"\0" + code).hexdigest()[
        :12
    ]
    return f"_user_tool_{path.stem}_{digest}"


def load_user_tool_module(path: Path) -> ModuleType:
    """Compile+exec a tool file, returning the loaded module.

    The source is compiled directly (``dont_inherit=True`` keeps this
    module's ``__future__`` imports out), registered in ``sys.modules``
    during exec so dataclass/pydantic annotation lookups resolve, and kept
    there under its digest key on success — a failed exec leaves
    ``sys.modules`` as it was.

    Raises:
        Whatever the module raises at exec — callers degrade it to a
        warning + skip. ``KeyboardInterrupt``/``SystemExit`` propagate like
        anything else; the builder catches ``BaseException`` except
        ``KeyboardInterrupt``.
    """
    code = path.read_bytes()
    name = _module_name(path, code)
    module = ModuleType(name)
    module.__file__ = str(path.resolve())
    compiled = compile(code, str(path), "exec", dont_inherit=True)
    with _load_lock(name):
        sys.modules[name] = module
        try:
            # Deliberate in-process exec — these files are user-authored
            # code the operator installed for exactly this; the control is
            # approval gating on the resulting tools, not sandboxing.
            exec(compiled, module.__dict__)  # noqa: S102
        except BaseException:
            if sys.modules.get(name) is module:
                del sys.modules[name]
            raise
    return module


def public_functions(module: ModuleType) -> list[Callable[..., object]]:
    """The public functions *defined in* ``module`` — the tool candidates.

    ``__module__`` filtering excludes names imported from elsewhere
    (``from os.path import join`` must not become a tool); name filtering
    excludes privates. Import order is preserved for determinism.
    """
    return [
        obj
        for name, obj in vars(module).items()
        if not name.startswith("_")
        and inspect.isfunction(obj)
        and obj.__module__ == module.__name__
    ]


# ---------------------------------------------------------------------------
# Run-time toolset construction
# ---------------------------------------------------------------------------


def build_user_tool_capabilities(
    specs: list[UserToolSpec],
    *,
    workspace_root: Path | None,
    gate: bool,
) -> list[AbstractCapability]:
    """One ``Toolset`` capability holding every enabled user tool, for ``build_run_kwargs``.

    Enabled, non-shadowed files are exec'd one by one — a file that raises
    (or yields only unusable functions) warns and is skipped, never breaks
    the run. All functions land in a single
    ``FunctionToolset(id='user_tools').prefixed('user')``; on name
    collisions the earlier file in discovery precedence order (workspace
    first) wins. With ``gate=True`` (every profile except ``bypass``) an
    ``ApprovalRequiredToolset`` wrap makes each call a deferred approval,
    since ``Permissions`` can't see plain tools.

    Args:
        specs: The ``user_tools`` registry (enable flags only — discovery
            always comes from the filesystem).
        workspace_root: The run workspace root; ``None`` scans global only.
        gate: Whether calls require approval.

    Returns:
        ``[]`` or a single ``Toolset`` capability for the run's capability
        list.
    """
    enabled = enabled_flags(specs)
    toolset: FunctionToolset[None] = FunctionToolset(id="user_tools")
    registered = 0
    for file in discover_user_tool_files(workspace_root):
        if file.shadowed_by is not None or not enabled.get(file.key, True):
            continue
        try:
            module = load_user_tool_module(file.path)
        except KeyboardInterrupt:
            raise
        except BaseException as error:  # noqa: BLE001 — one bad file must not kill the run
            logger.warning(
                "Skipping user-tool file %s — failed to load: %s: %s",
                file.path,
                type(error).__name__,
                error,
            )
            continue
        for function in public_functions(module):
            if not is_legal_function_name(function.__name__):
                logger.warning(
                    "Skipping user tool %r in %s — illegal tool name "
                    "(must match [a-z0-9_], user_<name> ≤64 chars)",
                    function.__name__,
                    file.path,
                )
                continue
            try:
                toolset.add_function(function)
            except Exception as error:  # noqa: BLE001 — e.g. UserError on a bad signature/dup name
                logger.warning(
                    "Skipping user tool %r in %s — could not register: %s",
                    function.__name__,
                    file.path,
                    error,
                )
                continue
            registered += 1
    if registered == 0:
        return []
    wrapped = toolset.prefixed(TOOL_NAME_PREFIX.removesuffix("_"))
    if gate:
        wrapped = ApprovalRequiredToolset(wrapped)
    return [ToolsetCapability(wrapped)]
