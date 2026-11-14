"""MCP server registry: settings-table persistence + per-run toolset building.

Verified against ``pydantic-ai-slim==2.68.0`` (``[mcp]`` extra, pulling
``fastmcp-slim[client]``):

- ``MCPServerStdio``/``MCPServerStreamableHTTP``/``MCPServerSSE`` were removed
  in pydantic-ai v2 — :class:`pydantic_ai.mcp.MCPToolset` is the one toolset
  class, picking its transport from the ``client`` argument. This is the
  pattern ``pydantic_ai.mcp.load_mcp_toolsets`` uses: a
  ``fastmcp.client.transports.StdioTransport`` for stdio servers, the bare URL
  (plus ``headers=``) for HTTP ones, and ``.prefixed(name)`` so tools from
  different servers can't collide.
- ``MCPToolset.__aenter__`` connects *eagerly*, and the agent enters its
  combined toolset at run start — so an unreachable server would raise inside
  run setup and kill the whole run. :class:`ResilientToolset` wraps each
  server: a failed ``__aenter__``/``get_tools`` logs a warning and the server
  contributes no tools, rather than breaking the chat.
- ``Permissions`` gates only file-write tool kinds and tools declaring
  ``code_arg_language='shell'`` — it never sees MCP tools. To keep MCP calls
  inside the permission profiles, non-``bypass`` profiles wrap each server in
  ``ApprovalRequiredToolset``: every call raises ``ApprovalRequired`` and
  joins the ``DeferredToolRequests`` flow the UI already handles (the human
  approves under ``manual``/``read-only``; ``ApprovalReviewer`` — ``tools=
  'all'`` by default — judges them under ``smart``).

``env``/``headers`` may carry secrets: they are passed straight to the
transport and *never* logged — only server ``name`` appears in log lines.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Self

from pydantic import TypeAdapter, ValidationError
from pydantic_ai.capabilities import Toolset as ToolsetCapability
from pydantic_ai.toolsets import ApprovalRequiredToolset, WrapperToolset

from app.api.schemas import MCPServerSpec

if TYPE_CHECKING:
    from pydantic_ai._run_context import RunContext
    from pydantic_ai.capabilities import AbstractCapability
    from pydantic_ai.toolsets import ToolsetTool

    from app.db.store import ChatStore

logger = logging.getLogger(__name__)

MCP_SERVERS_KEY = "mcp_servers"
"""Settings-table key holding the JSON-encoded ``list[MCPServerSpec]``."""

_SPECS_ADAPTER = TypeAdapter(list[MCPServerSpec])


# ---------------------------------------------------------------------------
# Persistence (settings KV table — JSON list, like the allow/deny lists)
# ---------------------------------------------------------------------------


async def load_mcp_servers(store: ChatStore) -> list[MCPServerSpec]:
    """Every configured MCP server, in stored order.

    Args:
        store: The app ``ChatStore`` whose settings table holds the row.

    Returns:
        The validated server list. A missing row reads as ``[]``; malformed
        entries are skipped with a warning (never a crash — the row may have
        been written by an older schema).
    """
    settings = await store.get_settings()
    return parse_mcp_servers(settings.get(MCP_SERVERS_KEY))


async def save_mcp_servers(store: ChatStore, servers: list[MCPServerSpec]) -> None:
    """Rewrite the whole server list atomically (one JSON settings row)."""
    if not servers:
        await store.delete_setting(MCP_SERVERS_KEY)
        return
    payload = json.dumps([spec.model_dump() for spec in servers])
    await store.set_setting(MCP_SERVERS_KEY, payload)


def parse_mcp_servers(raw: Any) -> list[MCPServerSpec]:
    """Validate a decoded ``mcp_servers`` value into specs, skipping bad entries.

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
            logger.warning("Settings key %r is not valid JSON; ignoring", MCP_SERVERS_KEY)
            return []
    if not isinstance(raw, list):
        return []
    specs: list[MCPServerSpec] = []
    for index, entry in enumerate(raw):
        try:
            specs.append(_SPECS_ADAPTER.validate_python([entry])[0])
        except ValidationError as error:
            name = entry.get("name") if isinstance(entry, dict) else None
            logger.warning(
                "Skipping invalid MCP server entry %d (name=%r): %s",
                index,
                name,
                error.errors()[0]["msg"] if error.errors() else error,
            )
    return specs


# ---------------------------------------------------------------------------
# Per-workspace masks (workspaces.mcp_overrides — a name -> enabled JSON map)
# ---------------------------------------------------------------------------


def parse_mcp_mask(raw: Any) -> dict[str, bool] | None:
    """Normalize a decoded ``mcp_overrides`` value into a name->enabled mask.

    ``raw`` is whatever the workspace column decoded to. ``None`` — and
    anything that isn't a mapping — means "no workspace mask; inherit the
    global flags". Non-bool values are dropped so a corrupt row can't
    silently flip a flag; an empty dict is a real (no-op) mask.
    """
    if not isinstance(raw, Mapping):
        return None
    return {
        str(name): enabled
        for name, enabled in raw.items()
        if isinstance(enabled, bool)
    }


def apply_mcp_mask(
    specs: list[MCPServerSpec], mask: dict[str, bool] | None
) -> list[MCPServerSpec]:
    """Apply a workspace enable/disable mask to the global server registry.

    ``mask`` is a name->enabled map (``workspaces.mcp_overrides``). A named
    entry *replaces* the spec's global ``enabled`` flag for the workspace —
    ``False`` masks a server out, ``True`` may re-enable one disabled
    globally. Entries naming no registered server are stale (the server was
    deleted or renamed after the mask was written) and are ignored with a
    single warning. ``None`` returns ``specs`` verbatim.

    Args:
        specs: The global registry (e.g. from ``load_mcp_servers``).
        mask: The workspace's decoded mask, or ``None`` to inherit.

    Returns:
        A new list — specs are never mutated in place.
    """
    if mask is None:
        return specs
    known = {spec.name for spec in specs}
    stale = sorted(set(mask) - known)
    if stale:
        logger.warning(
            "Workspace MCP mask names unknown servers; ignoring: %s", stale
        )
    return [
        spec.model_copy(update={"enabled": mask[spec.name]})
        if spec.name in mask
        else spec
        for spec in specs
    ]


# ---------------------------------------------------------------------------
# Run-time toolset construction
# ---------------------------------------------------------------------------


@dataclass
class ResilientToolset(WrapperToolset[None]):
    """Warn-and-skip wrapper: an unreachable MCP server yields zero tools.

    ``MCPToolset`` connects in ``__aenter__``; if the server is down the plain
    toolset would raise inside run setup and fail the whole agent run. This
    wrapper swallows the enter failure (remembering not to ``__aexit__`` —
    exiting an un-entered ``MCPToolset`` raises ``ValueError``) and likewise
    degrades a ``get_tools`` failure to an empty tool list, so one bad server
    never takes a run — or its healthy sibling servers — down with it.
    """

    server_name: str = ""
    _entered: bool = field(default=False, init=False)

    async def __aenter__(self) -> Self:
        try:
            await self.wrapped.__aenter__()
        except Exception as error:  # noqa: BLE001 — any transport error must not kill the run
            logger.warning(
                "MCP server %r failed to connect; skipping its tools: %s",
                self.server_name,
                error,
            )
            return self
        self._entered = True
        return self

    async def __aexit__(self, *args: object) -> bool | None:
        if not self._entered:
            return None
        return await self.wrapped.__aexit__(*args)

    async def get_tools(self, ctx: RunContext[Any]) -> dict[str, ToolsetTool[Any]]:
        try:
            return await self.wrapped.get_tools(ctx)
        except Exception as error:  # noqa: BLE001 — degrade to "no tools" instead of failing
            logger.warning(
                "MCP server %r failed to list tools; skipping it: %s",
                self.server_name,
                error,
            )
            return {}


def build_mcp_capabilities(
    specs: list[MCPServerSpec], *, gate: bool
) -> list[AbstractCapability]:
    """One ``Toolset`` capability per *enabled* server, for ``build_run_kwargs``.

    Each server becomes ``MCPToolset(transport, id=name).prefixed(name)`` —
    the name prefixes every tool (``fs-tools_read``) so servers can't collide
    — wrapped outermost in :class:`ResilientToolset` for failure isolation.
    With ``gate=True`` (every profile except ``bypass``) an
    ``ApprovalRequiredToolset`` layer makes each call a deferred approval,
    putting MCP tools under the same approval pipeline as the rest.

    Args:
        specs: Validated server specs; disabled entries are skipped.
        gate: Whether calls require approval (``True`` unless the profile is
            ``bypass``).

    Returns:
        ``Toolset`` capabilities ready to append to the run's capability
        list. A spec whose transport fails to construct is skipped with a
        warning.
    """
    # Imported lazily: `pydantic_ai.mcp` pulls in fastmcp/mcp, which are only
    # needed when servers are actually configured.
    from fastmcp.client.transports import StdioTransport
    from pydantic_ai.mcp import MCPToolset

    capabilities: list[AbstractCapability] = []
    for spec in specs:
        if not spec.enabled:
            continue
        try:
            if spec.transport == "stdio":
                toolset = MCPToolset(
                    StdioTransport(
                        command=spec.command or "",
                        args=list(spec.args),
                        env=spec.env,
                    ),
                    id=spec.name,
                )
            else:
                toolset = MCPToolset(
                    spec.url or "", id=spec.name, headers=spec.headers
                )
        except Exception as error:  # noqa: BLE001 — one bad spec must not break the run
            logger.warning(
                "Skipping MCP server %r — could not build its transport: %s",
                spec.name,
                error,
            )
            continue
        wrapped = toolset.prefixed(spec.name)
        if gate:
            wrapped = ApprovalRequiredToolset(wrapped)
        capabilities.append(
            ToolsetCapability(
                ResilientToolset(wrapped=wrapped, server_name=spec.name)
            )
        )
    return capabilities
