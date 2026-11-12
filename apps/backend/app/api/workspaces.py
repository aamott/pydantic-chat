"""Workspace REST routes: list (with nested chats), upsert, patch, delete."""

from fastapi import APIRouter, HTTPException, status

from app.api.deps import StoreDep
from app.api.schemas import WorkspaceCreate, WorkspaceOut, WorkspacePatch
from app.db import ChatStore

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])


@router.get("")
async def list_workspaces(store: StoreDep) -> list[WorkspaceOut]:
    """All workspaces (most recently opened first), each with its chat summaries."""
    summaries = await store.list_workspaces()
    return [
        WorkspaceOut.from_row(summary.workspace, summary.chats)
        for summary in summaries
    ]


@router.post("")
async def create_workspace(body: WorkspaceCreate, store: StoreDep) -> WorkspaceOut:
    """Open a folder as a workspace; idempotent on the normalized realpath."""
    workspace = await store.get_or_create_workspace(body.path)
    chats = await store.list_chats(workspace.id)
    return WorkspaceOut.from_row(workspace, chats)


@router.patch("/{workspace_id}")
async def patch_workspace(
    workspace_id: str, body: WorkspacePatch, store: StoreDep
) -> WorkspaceOut:
    """Update ``display_name``/``last_chat_id``/``permission_profile``.

    ``last_chat_id`` and ``permission_profile`` take explicit ``null`` to clear
    (the latter falling back to the global permission setting); values are
    schema-validated to the four profiles.
    """
    workspace = await store.get_workspace(workspace_id)
    if workspace is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found"
        )
    if body.display_name is not None:
        await _rename_workspace(store, workspace_id, body.display_name)
    if "last_chat_id" in body.model_fields_set:
        if body.last_chat_id is not None:
            chat = await store.get_chat(body.last_chat_id)
            if chat is None or chat.workspace_id != workspace_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="last_chat_id must name a chat in this workspace",
                )
        await store.set_last_chat(workspace_id, body.last_chat_id)
    if "permission_profile" in body.model_fields_set:
        await store.set_workspace_permission_profile(
            workspace_id, body.permission_profile
        )
    # Re-read after the updates; fall back to the earlier row (single-process store).
    workspace = await store.get_workspace(workspace_id) or workspace
    chats = await store.list_chats(workspace_id)
    return WorkspaceOut.from_row(workspace, chats)


@router.delete("/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workspace(workspace_id: str, store: StoreDep) -> None:
    """Delete a workspace; chats and their conversation state cascade in the store."""
    if not await store.delete_workspace(workspace_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found"
        )


async def _rename_workspace(
    store: ChatStore, workspace_id: str, display_name: str
) -> None:
    """Update a workspace's display name.

    ``AppTablesMixin`` has no rename method (store gap noted in the story file), so
    this runs the update through the store's locked connection offload, matching the
    mixin style. Revisit if a ``rename_workspace`` method lands on ``ChatStore``.
    """

    def update() -> None:
        with store._conn:
            store._conn.execute(
                "UPDATE workspaces SET display_name = ? WHERE id = ?",
                (display_name, workspace_id),
            )

    await store._run(update)
