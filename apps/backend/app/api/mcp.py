"""MCP server registry REST routes: ``/api/mcp-servers``.

The whole registry is one JSON row in the settings KV table
(``mcp_servers`` — see ``app.mcp_servers``), rewritten on every mutation.
``env``/``headers`` may carry secrets: they round-trip to the renderer (the
settings UI edits them) but are never logged — log lines name servers only.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import ValidationError

from app.api.deps import StoreDep
from app.api.schemas import MCPServerPatch, MCPServerSpec
from app.mcp_servers import apply_mcp_mask, load_mcp_servers, save_mcp_servers

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/mcp-servers", tags=["mcp-servers"])


@router.get("")
async def list_mcp_servers(
    store: StoreDep, workspace_id: str | None = None
) -> list[MCPServerSpec]:
    """Every registered MCP server, enabled or not, in stored order.

    ``workspace_id`` reports *effective* flags: the workspace's
    ``mcp_overrides`` mask is applied at read time (the stored registry is
    never mutated), so a masked-out server reads ``enabled: false`` for that
    workspace. An unknown workspace is a 404, matching ``/api/skills``.
    """
    servers = await load_mcp_servers(store)
    if workspace_id is None:
        return servers
    workspace = await store.get_workspace(workspace_id)
    if workspace is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No workspace named {workspace_id!r}",
        )
    return apply_mcp_mask(servers, workspace.mcp_overrides)


@router.post("", status_code=status.HTTP_201_CREATED)
async def add_mcp_server(body: MCPServerSpec, store: StoreDep) -> list[MCPServerSpec]:
    """Register a new server; the body is a full ``MCPServerSpec``.

    ``name`` is the unique key used by PATCH/DELETE — a duplicate is a 409.
    """
    servers = await load_mcp_servers(store)
    if any(spec.name == body.name for spec in servers):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"An MCP server named {body.name!r} already exists",
        )
    servers.append(body)
    await save_mcp_servers(store, servers)
    logger.info("Registered MCP server %r (%s)", body.name, body.transport)
    return servers


@router.patch("/{name}")
async def patch_mcp_server(
    name: str, body: MCPServerPatch, store: StoreDep
) -> list[MCPServerSpec]:
    """Merge ``body`` into one server; the merged spec is re-validated.

    An explicit ``null`` clears an optional field — e.g. ``{"headers": null}``
    drops stored headers. A merge that would leave the spec invalid (clearing
    ``command`` on a stdio server) is a 400, not a silently broken row.
    """
    servers = await load_mcp_servers(store)
    index = _find(servers, name)
    merged: dict[str, Any] = {
        **servers[index].model_dump(),
        **body.model_dump(exclude_unset=True),
    }
    try:
        servers[index] = MCPServerSpec.model_validate(merged)
    except ValidationError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Patch would leave {name!r} invalid: {error.errors()[0]['msg']}",
        ) from error
    new_name = servers[index].name
    if new_name != name and any(
        spec.name == new_name for spec in servers[:index] + servers[index + 1 :]
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"An MCP server named {new_name!r} already exists",
        )
    await save_mcp_servers(store, servers)
    logger.info("Updated MCP server %r", name)
    return servers


@router.delete("/{name}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_mcp_server(name: str, store: StoreDep) -> None:
    """Remove a server by name."""
    servers = await load_mcp_servers(store)
    index = _find(servers, name)
    removed = servers.pop(index)
    await save_mcp_servers(store, servers)
    logger.info("Removed MCP server %r (%s)", removed.name, removed.transport)


def _find(servers: list[MCPServerSpec], name: str) -> int:
    """The index of the server named ``name``, or a 404."""
    for index, spec in enumerate(servers):
        if spec.name == name:
            return index
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"No MCP server named {name!r}",
    )
