"""Chat REST routes: create under a workspace, rename, delete, dump messages."""

from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic_ai.ui.vercel_ai import VercelAIAdapter

from app.api.deps import StoreDep
from app.api.schemas import ChatCreate, ChatPatch, ChatSummaryOut

router = APIRouter(prefix="/api", tags=["chats"])


@router.post("/workspaces/{workspace_id}/chats", status_code=status.HTTP_201_CREATED)
async def create_chat(
    workspace_id: str, body: ChatCreate, store: StoreDep
) -> ChatSummaryOut:
    """Create a chat in a workspace and make it the workspace's last-open chat."""
    if await store.get_workspace(workspace_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found"
        )
    chat = await store.create_chat(
        workspace_id, title=body.title or "New chat", model=body.model
    )
    await store.set_last_chat(workspace_id, chat.id)
    return ChatSummaryOut.from_row(chat)


@router.patch("/chats/{chat_id}")
async def patch_chat(
    chat_id: str, body: ChatPatch, store: StoreDep
) -> ChatSummaryOut:
    """Rename a chat."""
    chat = await store.rename_chat(chat_id, body.title)
    if chat is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found"
        )
    return ChatSummaryOut.from_row(chat)


@router.delete("/chats/{chat_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_chat(chat_id: str, store: StoreDep) -> None:
    """Delete a chat; its conversation record and entries cascade in the store."""
    if not await store.delete_chat(chat_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found"
        )


@router.get("/chats/{chat_id}/messages")
async def get_chat_messages(
    chat_id: str, store: StoreDep
) -> list[dict[str, Any]]:
    """The chat's transcript as Vercel AI ``UIMessage`` dicts (``[]`` before any run).

    Loads the stored conversation (chat id == conversation id, workspace id ==
    conversation scope) and renders it with ``VercelAIAdapter.dump_messages`` at the
    app's pinned wire version, serialized the same way the SSE stream emits it.
    """
    chat = await store.get_chat(chat_id)
    if chat is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found"
        )
    conversation = await store.load(chat_id, scope=chat.workspace_id)
    if conversation is None:
        return []
    ui_messages = VercelAIAdapter.dump_messages(
        conversation.messages, sdk_version=7
    )
    return [
        message.model_dump(mode="json", by_alias=True, exclude_none=True)
        for message in ui_messages
    ]
