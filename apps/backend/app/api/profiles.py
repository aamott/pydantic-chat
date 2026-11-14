"""Tool-profile REST routes: ``/api/tool-profiles``, ``/api/tool-catalog``, ``/api/skills``.

Custom profiles are one JSON row in the settings KV table
(``tool_profiles`` — see :mod:`app.profiles`), rewritten on every mutation;
the four builtins are code constants merged at read time and immutable
through this API (``403`` on PUT/DELETE, ``409`` on a colliding POST — copy a
builtin by POSTing a new id).

``GET /api/tool-catalog`` lists the tools a profile's ``tools`` allowlist can
name (the ``Coder`` file surface, the persistent ``shell``, and the
``Planning`` set — the framework's ``load_capability`` is always permitted
and deliberately unlisted), plus one ``{server}_*`` prefix entry per
*enabled* MCP server for ``tool_prefixes``.

``GET /api/skills`` reports the discovered skill catalog for the profile
editor's skill picker: the system library (``data_dir()/skills``, seeded on
first use) always; workspace-local dirs when a ``workspace_id`` is passed.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic_ai.workspaces import LocalWorkspaceBackend
from pydantic_ai_harness.skills import SkillCatalog

from app.api.deps import StoreDep
from app.api.schemas import (
    SkillOut,
    SkillsCatalogOut,
    SkippedSkillOut,
    ToolCatalogEntry,
)
from app.mcp_servers import apply_mcp_mask, load_mcp_servers
from app.profiles import (
    BUILTIN_PROFILE_IDS,
    BUILTIN_PROFILES,
    ToolProfile,
    load_tool_profiles,
    save_tool_profiles,
    system_skills,
    workspace_skills,
)
from app.user_tools import (
    discover_user_tool_files,
    enabled_flags,
    load_user_tools,
    parse_user_tool_file,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["tool-profiles"])

# The static half of the tool catalog — every tool a run can actually expose,
# grouped by the capability that contributes it. Names match the assembled
# toolset (Coder uses FILE_TOOL_NAMES; Planning uses CORE_TOOL_NAMES).
_CATALOG_GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "filesystem",
        ("read_file", "write_file", "edit_file", "list_files", "grep"),
    ),
    ("shell", ("shell",)),
    (
        "planning",
        (
            "write_plan",
            "read_plan",
            "add_task",
            "update_task_status",
            "update_task_statuses",
            "remove_task",
        ),
    ),
)

_TOOL_DESCRIPTIONS: dict[str, str] = {
    "read_file": "Read a file, optionally a window of lines",
    "write_file": "Create or overwrite a file",
    "edit_file": "Edit a file by replacing matched text",
    "list_files": "List files (ripgrep-backed, respects .gitignore)",
    "grep": "Search file contents with ripgrep",
    "shell": "Run commands in a persistent shell",
    "write_plan": "Create or replace the task plan",
    "read_plan": "Read the current task plan",
    "add_task": "Add a task to the plan",
    "update_task_status": "Update one task's status",
    "update_task_statuses": "Update several tasks' statuses",
    "remove_task": "Remove a task from the plan",
}


# ---------------------------------------------------------------------------
# Profile CRUD
# ---------------------------------------------------------------------------


@router.get("/tool-profiles")
async def list_tool_profiles(store: StoreDep) -> list[ToolProfile]:
    """Every profile — builtins first, then custom in stored order."""
    return [*BUILTIN_PROFILES, *(await load_tool_profiles(store))]


@router.post("/tool-profiles", status_code=status.HTTP_201_CREATED)
async def create_tool_profile(body: ToolProfile, store: StoreDep) -> list[ToolProfile]:
    """Register a custom profile; ``id`` is the unique key used by PUT/DELETE.

    A duplicate id is a 409 — including collisions with a builtin id (edit a
    builtin by duplicating it under a new id, not by overwriting it). A
    submitted ``builtin`` flag is ignored: profiles written here are custom.
    """
    profiles = await load_tool_profiles(store)
    if body.id in BUILTIN_PROFILE_IDS or any(p.id == body.id for p in profiles):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A tool profile named {body.id!r} already exists",
        )
    profiles.append(body.model_copy(update={"builtin": False}))
    await save_tool_profiles(store, profiles)
    logger.info("Created tool profile %r (%s)", body.id, body.approval_mode)
    return [*BUILTIN_PROFILES, *profiles]


@router.put("/tool-profiles/{profile_id}")
async def put_tool_profile(
    profile_id: str, body: ToolProfile, store: StoreDep
) -> list[ToolProfile]:
    """Replace a custom profile wholesale; the path id wins over ``body.id``."""
    if profile_id in BUILTIN_PROFILE_IDS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Builtin tool profile {profile_id!r} cannot be edited",
        )
    profiles = await load_tool_profiles(store)
    index = _find(profiles, profile_id)
    profiles[index] = body.model_copy(update={"id": profile_id, "builtin": False})
    await save_tool_profiles(store, profiles)
    logger.info("Updated tool profile %r", profile_id)
    return [*BUILTIN_PROFILES, *profiles]


@router.delete("/tool-profiles/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tool_profile(profile_id: str, store: StoreDep) -> None:
    """Remove a custom profile; builtins are a 403, unknown ids a 404."""
    if profile_id in BUILTIN_PROFILE_IDS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Builtin tool profile {profile_id!r} cannot be deleted",
        )
    profiles = await load_tool_profiles(store)
    index = _find(profiles, profile_id)
    removed = profiles.pop(index)
    await save_tool_profiles(store, profiles)
    # Rows referencing the deleted id resolve to 'manual' on their next run.
    logger.info("Removed tool profile %r", removed.id)


def _find(profiles: list[ToolProfile], profile_id: str) -> int:
    """The index of the custom profile ``profile_id``, or a 404."""
    for index, profile in enumerate(profiles):
        if profile.id == profile_id:
            return index
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"No tool profile named {profile_id!r}",
    )


# ---------------------------------------------------------------------------
# Tool catalog + skills (profile editor pickers)
# ---------------------------------------------------------------------------


@router.get("/tool-catalog")
async def tool_catalog(
    store: StoreDep, workspace_id: str | None = None
) -> list[ToolCatalogEntry]:
    """The tools and MCP prefixes a profile's allowlists may name.

    ``workspace_id`` applies that workspace's ``mcp_overrides`` mask to the
    ``{server}_*`` prefix entries — a masked-out server disappears from the
    picker for that workspace, matching what a run there would expose. An
    unknown workspace is a 404, matching ``/api/skills``.
    """
    entries = [
        ToolCatalogEntry(
            name=name,
            description=_TOOL_DESCRIPTIONS[name],
            group=group,
        )
        for group, names in _CATALOG_GROUPS
        for name in names
    ]
    specs = await load_mcp_servers(store)
    workspace_root: Path | None = None
    if workspace_id is not None:
        workspace = await store.get_workspace(workspace_id)
        if workspace is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No workspace named {workspace_id!r}",
            )
        specs = apply_mcp_mask(specs, workspace.mcp_overrides)
        if Path(workspace.path).is_dir():
            workspace_root = Path(workspace.path)
    for spec in specs:
        if spec.enabled:
            entries.append(
                ToolCatalogEntry(
                    name=f"{spec.name}_*",
                    description=f"All tools from MCP server '{spec.name}'",
                    group="mcp",
                    prefix=True,
                )
            )
    # User tools: one exact-name entry per enabled, legally-named function —
    # ast-parsed only (importing would exec user code on a settings load).
    tool_flags = enabled_flags(await load_user_tools(store))
    for file in discover_user_tool_files(workspace_root):
        if file.shadowed_by is not None or not tool_flags.get(file.key, True):
            continue
        parsed = parse_user_tool_file(file.path)
        for fn in parsed.functions:
            if fn.legal:
                entries.append(
                    ToolCatalogEntry(
                        name=f"user_{fn.name}",
                        description=fn.docstring
                        or f"User-defined tool from {file.rel_path}",
                        group="user",
                    )
                )
    return entries


@router.get("/skills")
async def skills_catalog(
    store: StoreDep, workspace_id: str | None = None
) -> SkillsCatalogOut:
    """The discovered skill catalog — system library plus, optionally, a workspace's.

    ``workspace_id`` adds the workspace-local dirs (``.claude/skills``,
    ``.agents/skills``, ``.devin/skills``); each skill carries an ``origin``
    so the UI can badge where it came from. Skipped ``SKILL.md`` files and
    missing libraries are reported under ``skipped``.
    """
    skills: list[SkillOut] = []
    skipped: list[SkippedSkillOut] = []

    catalog = await system_skills().load()
    skills.extend(_skill_outs(catalog, origin="system"))
    skipped.extend(_skipped_outs(catalog))

    if workspace_id is not None:
        workspace = await store.get_workspace(workspace_id)
        if workspace is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No workspace named {workspace_id!r}",
            )
        if Path(workspace.path).is_dir():
            catalog = await workspace_skills().load(
                workspace=LocalWorkspaceBackend(workspace.path)
            )
            skills.extend(_skill_outs(catalog, origin="workspace"))
            skipped.extend(_skipped_outs(catalog))
        else:
            # A missing workspace folder reports system skills only — the
            # workspace row itself is already flagged `missing` for the UI.
            logger.warning(
                "Workspace %r path %s is missing; skipping its skills",
                workspace_id,
                workspace.path,
            )

    return SkillsCatalogOut(skills=skills, skipped=skipped)


def _skill_outs(
    catalog: SkillCatalog, *, origin: Literal["system", "workspace"]
) -> list[SkillOut]:
    return [
        SkillOut(
            name=skill.name,
            description=skill.description,
            path=skill.path,
            origin=origin,
            model_invocable=skill.model_invocable,
            user_invocable=skill.user_invocable,
        )
        for skill in catalog.skills
    ]


def _skipped_outs(catalog: SkillCatalog) -> list[SkippedSkillOut]:
    return [
        SkippedSkillOut(
            path=skipped.path, reason=str(skipped.reason), message=skipped.message
        )
        for skipped in catalog.skipped
    ]
