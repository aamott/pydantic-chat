"""Pydantic request/response models for the workspaces/chats REST surface.

Field names stay snake_case: the frontend mirrors them in
``packages/shared/src/index.ts`` (``Workspace``, ``ChatSummary``).
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.db import ChatSummary, Workspace


class ChatSummaryOut(BaseModel):
    """One chat's sidebar metadata; a superset of the shared ``ChatSummary`` type.

    ``model``/``thinking``/``permission_profile`` are the per-chat overrides the
    composer hydrates from; ``null`` means "inherit" (model/thinking -> app
    defaults; profile -> workspace -> global).
    """

    id: str
    workspace_id: str
    title: str
    model: str | None
    thinking: str | None
    permission_profile: str | None
    created_at: int
    updated_at: int

    @classmethod
    def from_row(cls, row: ChatSummary) -> ChatSummaryOut:
        return cls(
            id=row.id,
            workspace_id=row.workspace_id,
            title=row.title,
            model=row.model,
            thinking=row.thinking,
            permission_profile=row.permission_profile,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class WorkspaceOut(BaseModel):
    """A workspace plus its chats — one ``GET /api/workspaces`` feeds the whole sidebar."""

    id: str
    path: str
    display_name: str
    last_chat_id: str | None
    permission_profile: str | None
    """Per-workspace permission override; ``None`` inherits the global setting."""
    mcp_overrides: dict[str, bool] | None
    """Per-workspace MCP mask — server name -> enabled; ``None`` inherits the global registry."""
    created_at: int
    last_opened_at: int
    missing: bool
    chats: list[ChatSummaryOut] = Field(default_factory=list)

    @classmethod
    def from_row(
        cls, row: Workspace, chats: list[ChatSummary] | None = None
    ) -> WorkspaceOut:
        """Build the response, computing ``missing`` from the filesystem at read time."""
        return cls(
            id=row.id,
            path=row.path,
            display_name=row.display_name,
            last_chat_id=row.last_chat_id,
            permission_profile=row.permission_profile,
            mcp_overrides=row.mcp_overrides,
            created_at=row.created_at,
            last_opened_at=row.last_opened_at,
            missing=not Path(row.path).exists(),
            chats=[ChatSummaryOut.from_row(chat) for chat in chats or []],
        )


class WorkspaceCreate(BaseModel):
    """``POST /api/workspaces`` body — a folder to open (upserted on its realpath)."""

    path: str = Field(min_length=1)


class WorkspacePatch(BaseModel):
    """``PATCH /api/workspaces/{id}`` body; unset fields are left alone.

    ``last_chat_id`` and ``permission_profile`` use ``model_fields_set`` at the
    route so an explicit ``null`` clears the value while an absent key keeps it.
    ``mcp_overrides`` is a server-name -> enabled map over the global MCP
    registry — ``null`` restores inheritance; unknown names are stored
    verbatim (they go stale silently if the server is later removed).
    """

    display_name: str | None = Field(default=None, min_length=1)
    last_chat_id: str | None = None
    permission_profile: str | None = None
    mcp_overrides: dict[str, bool] | None = None


class ChatCreate(BaseModel):
    """``POST /api/workspaces/{id}/chats`` body; title defaults to "New chat"."""

    title: str | None = Field(default=None, min_length=1)
    model: str | None = None


class PromptVersionOut(BaseModel):
    """One replaced prompt in ``GET /api/chats/{id}/versions``.

    Produced from a ``ConversationRecord.branches`` tip: the branch's first
    entry that diverges from the head chain, when it's a ``UserPromptPart``
    request. ``id`` is that entry's store id — the version's stable key.
    ``message_id`` is the ``ui_message_id`` the transcript's user message
    shares with the request this version replaced; the client resubmits
    against it. ``tip`` is the branch tip's entry id — the ``from_entry``
    a future ``store.branch()`` checkout would pass.
    """

    id: str
    message_id: str
    tip: str
    text: str
    timestamp: datetime


class ChatVersionsOut(BaseModel):
    """``GET /api/chats/{id}/versions`` response — branches oldest-left first."""

    versions: list[PromptVersionOut] = Field(default_factory=list)


class ChatPatch(BaseModel):
    """``PATCH /api/chats/{id}`` body — merge semantics; unset fields are left alone.

    ``model`` is a ``provider:model`` spec (``null`` clears the override).
    ``thinking`` is a normalized level (``off``/``low``/``medium``/``high``,
    free-form tolerated for models outside the static catalog) or ``null``.
    ``permission_profile`` is any tool-profile id (builtin or custom, free-form —
    an unknown id resolves to ``manual`` at run time) or ``null`` to inherit.
    ``title`` must be a non-empty string when present — ``null`` is rejected.
    """

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1)
    model: str | None = None
    thinking: str | None = None
    permission_profile: str | None = None


class FileOut(BaseModel):
    """``GET /api/files`` response — one text file served to the CM6 viewer.

    ``language`` is a ``@codemirror/language-data`` name (``None`` when the
    extension is unmapped — the frontend falls back to plain text). ``path``
    is the root-relative POSIX spelling.
    """

    content: str
    language: str | None = None
    size: int
    path: str


class FileTreeNode(BaseModel):
    """One node in the ``GET /api/files/tree`` response.

    ``path`` is root-relative POSIX (``""`` for the workspace root itself);
    ``children`` is set on directories — possibly empty — and ``None`` on
    files.
    """

    name: str
    path: str
    type: Literal["file", "dir"]
    children: list[FileTreeNode] | None = None


class FileTreeOut(BaseModel):
    """``GET /api/files/tree`` response.

    ``truncated`` is ``True`` when the listing hit the server-side entry cap —
    the returned tree is a prefix, not the whole workspace.
    """

    root: FileTreeNode
    truncated: bool = False


class SettingsOut(BaseModel):
    """``GET /api/settings`` response — every non-secret app setting, fully populated.

    Missing rows fall back to the app defaults, so the frontend always gets a
    complete object. ``judge_model`` is the exception — it is ``None`` unless
    the user picked an explicit judge, since ``None`` means "smart judges with
    the run's own model". ``allowed_patterns``/``denied_patterns`` are
    file-glob lists applied to the agent's ``FileSystem`` capability; the
    command lists feed ``Shell``. Never contains key material.
    """

    theme: str
    default_model: str
    permission_profile: str
    allowed_commands: list[str]
    denied_commands: list[str]
    allowed_patterns: list[str]
    denied_patterns: list[str]
    ollama_base_url: str
    judge_model: str | None


class ToolCatalogEntry(BaseModel):
    """One selectable item in the tool-profile editor's tool picker.

    ``group`` identifies the source capability (or ``"mcp"`` for the
    ``{server}_*`` prefix entries, flagged by ``prefix=True`` — those match a
    profile's ``tool_prefixes``, everything else matches ``tools``).
    """

    name: str
    description: str
    group: Literal["filesystem", "shell", "planning", "mcp"]
    prefix: bool = False


class SkillOut(BaseModel):
    """One discovered skill in the ``GET /api/skills`` response."""

    name: str
    description: str
    path: str
    origin: Literal["system", "workspace"]
    model_invocable: bool
    user_invocable: bool


class SkippedSkillOut(BaseModel):
    """A ``SKILL.md`` or library path left out of the catalog, and why."""

    path: str
    reason: str
    message: str


class SkillsCatalogOut(BaseModel):
    """``GET /api/skills`` response — discovered skills plus what was skipped."""

    skills: list[SkillOut]
    skipped: list[SkippedSkillOut]


class SettingsPatch(BaseModel):
    """``PUT /api/settings`` body — merge semantics: only provided keys change.

    An explicit ``null`` on a field resets it to the app default (the stored
    row is deleted). Unknown keys are rejected so frontend typos can't land
    silently in the KV table.
    """

    model_config = ConfigDict(extra="forbid")

    theme: str | None = None
    default_model: str | None = None
    permission_profile: str | None = None
    allowed_commands: list[str] | None = None
    denied_commands: list[str] | None = None
    allowed_patterns: list[str] | None = None
    denied_patterns: list[str] | None = None
    ollama_base_url: str | None = None
    judge_model: str | None = None


class MCPServerSpec(BaseModel):
    """One registered MCP server — a row of the ``mcp_servers`` settings list.

    ``transport`` picks the required fields: ``stdio`` launches ``command``
    (with ``args``/``env``) through FastMCP's ``StdioTransport``; ``http``
    connects to ``url`` (with optional ``headers``) through the streamable-HTTP
    transport ``MCPToolset`` derives from the URL. ``env`` and ``headers`` may
    carry secrets — they are stored and returned but never logged. ``name``
    addresses the server in ``/api/mcp-servers/{name}``, so slashes are
    rejected.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, pattern=r"^[^/]+$")
    transport: Literal["stdio", "http"]
    command: str | None = None
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] | None = None
    url: str | None = None
    headers: dict[str, str] | None = None
    enabled: bool = True

    @model_validator(mode="after")
    def _require_transport_fields(self) -> MCPServerSpec:
        if self.transport == "stdio" and not (self.command and self.command.strip()):
            raise ValueError("stdio MCP servers require a 'command'")
        if self.transport == "http" and not (self.url and self.url.strip()):
            raise ValueError("http MCP servers require a 'url'")
        return self


class MCPServerPatch(BaseModel):
    """``PATCH /api/mcp-servers/{name}`` body — merge semantics.

    Unset fields keep their stored values; an explicit ``null`` clears an
    optional field. ``transport`` itself is immutable (patching it would make
    half the stored fields meaningless) — delete and re-add to change it.
    The merged result is re-validated as an :class:`MCPServerSpec`.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, pattern=r"^[^/]+$")
    command: str | None = None
    args: list[str] | None = None
    env: dict[str, str] | None = None
    url: str | None = None
    headers: dict[str, str] | None = None
    enabled: bool | None = None


class SettingValueIn(BaseModel):
    """``PUT /api/settings/{key}`` body — the single-key convenience form.

    ``value`` is required but nullable: ``{"value": null}`` resets the key.
    List keys take ``list[str]``, scalar keys take ``str``.
    """

    model_config = ConfigDict(extra="forbid")

    value: str | list[str] | None


class ProviderOut(BaseModel):
    """One provider's credential status — the row a settings window renders.

    ``configured`` mirrors :func:`app.agent.models.configured_providers` (the
    provider can resolve a model right now — e.g. ``ollama`` needs no key);
    ``has_key``/``source`` describe only the provider's API-key secret.
    Never carries key material.
    """

    provider: str
    configured: bool
    has_key: bool
    source: Literal["file", "env"] | None = None


class SecretSetIn(BaseModel):
    """``PUT /api/settings/secrets/{provider}`` body — credential material to store.

    ``key`` is the provider's API key. ``base_url`` is accepted only for
    providers with an endpoint secret (``openai-compatible``, which requires
    one, and ``ollama``). At least one of the two must be present. Values are
    written to the chmod-600 secrets file and never echoed back.
    """

    model_config = ConfigDict(extra="forbid")

    key: str | None = None
    base_url: str | None = None


class ModelOut(BaseModel):
    """One selectable model in the ``GET /api/models`` catalog.

    ``id`` is the full ``provider:model`` spec to store on the chat.
    ``thinking_levels`` is the subset of the normalized
    ``off``/``low``/``medium``/``high`` scale the model accepts; ``max_context``
    is the context window in tokens (``null`` when unknown, e.g. Ollama).
    """

    id: str
    name: str
    thinking_levels: list[str]
    max_context: int | None


class ModelProviderOut(BaseModel):
    """One configured provider's section of the model catalog.

    ``models`` is empty for providers with no fixed list — a configured
    ``openai-compatible`` endpoint, or Ollama when the local server is offline.
    """

    provider: str
    label: str
    models: list[ModelOut]


class ModelsOut(BaseModel):
    """``GET /api/models`` response — only providers usable right now."""

    providers: list[ModelProviderOut]
