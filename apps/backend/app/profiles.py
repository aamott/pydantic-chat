"""Tool profiles: builtin constants, settings-KV persistence, run resolution.

Verified against ``pydantic-ai-slim==2.68.0`` / ``pydantic-ai-harness==0.68.0``
(see ``docs/research/tool-profiles-and-skills.md``):

- A profile is data: an ``id`` (stored in ``permission_profile`` columns), a
  display ``name``, an ``approval_mode`` driving ``Permissions``/``ApprovalReviewer``,
  ``workspace_read_only`` driving ``LocalWorkspace(read_only=)``, a tool
  allowlist (exact names plus ``{server}_*`` MCP prefixes) and a skill
  allowlist (``None`` = all discovered, ``[]`` = none).
- The four builtins carry the legacy ``permission_profile`` values
  (``bypass``/``smart``/``manual``/``read-only``) so existing
  ``chats``/``workspaces``/``settings`` rows resolve with no migration.
  Custom profiles persist as one JSON row under ``settings['tool_profiles']``,
  mirroring :mod:`app.mcp_servers`; builtins are constants merged at read time
  and are immutable through the API.
- ``resolve_tool_profile`` maps the effective ``permission_profile`` id to a
  profile; an unknown id warns and falls back to builtin ``manual`` — the
  same safe fallback the old ``Literal`` performed by hand.
- The system skill library is ``data_dir()/skills/``, seeded once from the
  bundled ``apps/backend/skills/`` template by :func:`ensure_system_skills`
  (called lazily on first resolve and at app startup). Workspace-local skill
  dirs are discovered per run — see :data:`WORKSPACE_SKILL_DIRS`.
"""

from __future__ import annotations

import json
import logging
import shutil
from collections.abc import Collection, Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError
from pydantic_ai.workspaces import LocalWorkspaceBackend
from pydantic_ai_harness.skills import Skills

from app.config import DEFAULT_PERMISSION_PROFILE, data_dir

if TYPE_CHECKING:
    from app.db.store import ChatStore

logger = logging.getLogger(__name__)

ApprovalMode = Literal["bypass", "smart", "manual"]
"""The three approval behaviors a profile can pick — mapped to
``Permissions('full' | 'auto' | 'read-only')``; ``smart`` adds an
``ApprovalReviewer``. ``read-only`` is not a mode: the read-only builtin
combines ``manual`` approval with a stripped-down tool surface."""


class ToolProfile(BaseModel):
    """One selectable run profile — what a ``permission_profile`` id means.

    ``tools`` is the exact-name allowlist applied to the assembled toolset
    (``None`` = every tool); ``tool_prefixes`` admits whole MCP servers by
    their ``{name}_`` prefix. ``load_capability`` is always permitted so
    skills keep loading under any allowlist. ``skills`` selects skill names
    (``None`` = all, ``[]`` = no ``Skills`` capability at all).
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, pattern=r"^[^/]+$")
    name: str = Field(min_length=1)
    description: str = ""
    approval_mode: ApprovalMode
    workspace_read_only: bool = False
    tools: list[str] | None = None
    tool_prefixes: list[str] = Field(default_factory=list)
    skills: list[str] | None = None
    builtin: bool = False


# The effective surface of the legacy `read-only` profile: FileSystem(
# read_only=True, tools=FILE_TOOL_NAMES) keeps read_file/list_files/grep, and
# Planning contributes its six core tools. Display-only — the builtin builds a
# standalone FileSystem, not a Coder + allowlist (option (a) in the research).
_READ_ONLY_TOOLS: tuple[str, ...] = (
    "read_file",
    "list_files",
    "grep",
    "write_plan",
    "read_plan",
    "add_task",
    "update_task_status",
    "update_task_statuses",
    "remove_task",
)

BUILTIN_PROFILES: tuple[ToolProfile, ...] = (
    ToolProfile(
        id="bypass",
        name="Bypass approvals",
        description="Run every tool call without asking.",
        approval_mode="bypass",
        builtin=True,
    ),
    ToolProfile(
        id="smart",
        name="Smart approvals",
        description="An AI reviewer auto-approves low-risk writes and commands.",
        approval_mode="smart",
        builtin=True,
    ),
    ToolProfile(
        id="manual",
        name="Manual approvals",
        description="Ask before every file write and shell command.",
        approval_mode="manual",
        builtin=True,
    ),
    ToolProfile(
        id="read-only",
        name="Read-only",
        description="Read files and search only — no writes, no shell.",
        approval_mode="manual",
        workspace_read_only=True,
        tools=list(_READ_ONLY_TOOLS),
        builtin=True,
    ),
)
"""The immutable builtin profiles; ``id``s equal the legacy profile values."""

BUILTIN_PROFILE_IDS: frozenset[str] = frozenset(p.id for p in BUILTIN_PROFILES)


# ---------------------------------------------------------------------------
# Persistence (settings KV table — JSON list of *custom* profiles)
# ---------------------------------------------------------------------------

TOOL_PROFILES_KEY = "tool_profiles"
"""Settings-table key holding the JSON-encoded ``list[ToolProfile]`` (custom only)."""

_PROFILES_ADAPTER = TypeAdapter(list[ToolProfile])


async def load_tool_profiles(store: ChatStore) -> list[ToolProfile]:
    """Every *custom* profile, in stored order; builtins are merged at read time.

    A missing row reads as ``[]``; malformed entries are skipped with a warning
    (never a crash — the row may have been written by an older schema).
    """
    settings = await store.get_settings()
    return parse_tool_profiles(settings.get(TOOL_PROFILES_KEY))


async def save_tool_profiles(store: ChatStore, profiles: list[ToolProfile]) -> None:
    """Rewrite the whole custom-profile list atomically (one JSON settings row)."""
    if not profiles:
        await store.delete_setting(TOOL_PROFILES_KEY)
        return
    payload = json.dumps([profile.model_dump() for profile in profiles])
    await store.set_setting(TOOL_PROFILES_KEY, payload)


def parse_tool_profiles(raw: Any) -> list[ToolProfile]:
    """Validate a decoded ``tool_profiles`` value into profiles, skipping bad entries.

    ``raw`` is whatever the settings row decoded to (``_decode_setting`` in
    ``app.api.chat`` JSON-decodes it back to a list of dicts). Anything that
    isn't a valid profile is dropped with a warning — one corrupt entry must
    not take the rest of the registry, or the whole run, down.
    """
    if not isinstance(raw, str) and not isinstance(raw, list):
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning(
                "Settings key %r is not valid JSON; ignoring", TOOL_PROFILES_KEY
            )
            return []
    if not isinstance(raw, list):
        return []
    profiles: list[ToolProfile] = []
    for index, entry in enumerate(raw):
        try:
            profiles.append(_PROFILES_ADAPTER.validate_python([entry])[0])
        except ValidationError as error:
            profile_id = entry.get("id") if isinstance(entry, dict) else None
            logger.warning(
                "Skipping invalid tool profile entry %d (id=%r): %s",
                index,
                profile_id,
                error.errors()[0]["msg"] if error.errors() else error,
            )
    return profiles


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


def resolve_tool_profile(chat_settings: Mapping[str, Any] | Any) -> ToolProfile:
    """The ``ToolProfile`` the run's ``permission_profile`` id selects.

    Builtins resolve first — a stored custom profile can never shadow a
    builtin id (the API rejects them anyway). An unknown or missing id falls
    back to builtin ``manual`` with a warning, matching the legacy behavior.
    """
    profile_id = _setting(chat_settings, "permission_profile") or DEFAULT_PERMISSION_PROFILE
    for profile in BUILTIN_PROFILES:
        if profile.id == profile_id:
            return profile
    for profile in parse_tool_profiles(_setting(chat_settings, "tool_profiles")):
        if profile.id == profile_id:
            return profile
    if profile_id != DEFAULT_PERMISSION_PROFILE:
        logger.warning("Unknown tool profile %r; using 'manual'", profile_id)
    return next(p for p in BUILTIN_PROFILES if p.id == DEFAULT_PERMISSION_PROFILE)


def _setting(source: Mapping[str, Any] | Any, key: str, default: Any = None) -> Any:
    """Read ``key`` off a settings mapping or an attribute object."""
    if isinstance(source, Mapping):
        return source.get(key, default)
    return getattr(source, key, default)


# ---------------------------------------------------------------------------
# Skill store
# ---------------------------------------------------------------------------

SKILLS_TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "skills"
"""Bundled ``apps/backend/skills/`` template seeded into the system library."""

WORKSPACE_SKILL_DIRS: tuple[str, ...] = (
    ".claude/skills",
    ".agents/skills",
    ".devin/skills",
)
"""Conventional per-workspace skill libraries, in precedence order."""


def system_skills_dir() -> Path:
    """The system skill library: ``data_dir()/skills``."""
    return data_dir() / "skills"


def ensure_system_skills() -> Path:
    """Create the system skill library, seeding it from the bundled template.

    Idempotent and lazy — called on first resolve (``build_run_kwargs`` and
    ``GET /api/skills``) and once at app startup. A missing template (e.g. a
    wheel install that didn't ship it) still yields an empty library, never a
    crash.
    """
    target = system_skills_dir()
    if target.is_dir():
        return target
    target.mkdir(parents=True, exist_ok=True)
    if SKILLS_TEMPLATE_DIR.is_dir():
        shutil.copytree(SKILLS_TEMPLATE_DIR, target, dirs_exist_ok=True)
        logger.info("Seeded system skill library at %s", target)
    else:
        logger.warning(
            "Bundled skills template %s missing; created empty skill library",
            SKILLS_TEMPLATE_DIR,
        )
    return target


def system_skills(include: Collection[str] | None = None) -> Skills:
    """A ``Skills`` capability serving the system library at ``data_dir()/skills``.

    The library lives outside any run workspace, so it is read through its own
    ``LocalWorkspaceBackend`` — rendered skills omit their directory path
    (``in_run_workspace=False``), fine for instruction-only system skills.
    ``include`` restricts by exact skill name (``None`` = all discovered).
    """
    library = ensure_system_skills()
    return Skills(
        [library],
        include=include,
        missing_directories="skip",
        duplicate_names="keep_first",
        unknown_names="skip",
        workspace=LocalWorkspaceBackend(library),
    )


def workspace_skills(include: Collection[str] | None = None) -> Skills:
    """A ``Skills`` capability serving :data:`WORKSPACE_SKILL_DIRS` in the run workspace.

    ``missing_directories='skip'`` tolerates workspaces with none of the
    conventional dirs; ``unknown_names='skip'`` tolerates profiles naming
    removed skills; ``keep_first`` lets an earlier dir shadow a later one.
    """
    return Skills(
        WORKSPACE_SKILL_DIRS,
        include=include,
        missing_directories="skip",
        duplicate_names="keep_first",
        unknown_names="skip",
    )
