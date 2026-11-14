"""Chat REST routes: create under a workspace, patch fields, delete, dump messages."""

from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic_ai.conversation_store import ConversationEntry
from pydantic_ai.messages import ModelRequest, UserPromptPart
from pydantic_ai.ui._utils import get_ui_message_id
from pydantic_ai.ui.vercel_ai import VercelAIAdapter

from app.agent.models import (
    UnknownProviderError,
    catalog_thinking_levels,
    split_model_spec,
)
from app.api.deps import StoreDep
from app.api.schemas import (
    ChatCreate,
    ChatPatch,
    ChatSummaryOut,
    ChatVersionsOut,
    PromptVersionOut,
)
from app.config import DEFAULT_MODEL

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
    if body.model is not None:
        try:
            split_model_spec(body.model)
        except UnknownProviderError as error:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)
            ) from error
    chat = await store.create_chat(
        workspace_id, title=body.title or "New chat", model=body.model
    )
    await store.set_last_chat(workspace_id, chat.id)
    return ChatSummaryOut.from_row(chat)


@router.patch("/chats/{chat_id}")
async def patch_chat(
    chat_id: str, body: ChatPatch, store: StoreDep
) -> ChatSummaryOut:
    """Merge the provided fields into the chat; explicit ``null`` clears an override.

    Validation (400s rather than silent writes):
    - ``model`` must be a ``provider:model`` spec with a known provider prefix;
    - ``thinking`` must be one of the effective model's catalog
      ``thinking_levels`` when the model is catalog-known (free-form otherwise —
      Ollama and ``openai-compatible`` have no fixed level set);
    - ``permission_profile`` is a free-form tool-profile id or ``null``
      (unknown ids resolve to ``manual`` at run time);
    - ``title``, when present, must be a non-empty string.
    """
    chat = await store.get_chat(chat_id)
    if chat is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found"
        )

    updates: dict[str, str | None] = {}
    fields = body.model_fields_set
    if "title" in fields:
        if body.title is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="title must be a non-empty string, not null",
            )
        updates["title"] = body.title
    if "model" in fields:
        if body.model is not None:
            try:
                split_model_spec(body.model)
            except UnknownProviderError as error:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)
                ) from error
        updates["model"] = body.model
    if "thinking" in fields and body.thinking is not None:
        # Validate against the *effective* model: the spec this patch sets, else
        # the chat's stored override, else the app default.
        spec = updates.get("model", chat.model) or (
            await store.get_setting("default_model") or DEFAULT_MODEL
        )
        levels = catalog_thinking_levels(spec)
        if levels is not None and body.thinking not in levels:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"thinking must be one of {levels} for {spec!r}; "
                    f"got {body.thinking!r}"
                ),
            )
        updates["thinking"] = body.thinking
    elif "thinking" in fields:
        updates["thinking"] = None
    if "permission_profile" in fields:
        updates["permission_profile"] = body.permission_profile

    if updates:
        chat = await store.update_chat(chat_id, **updates) or chat
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


@router.get("/chats/{chat_id}/versions")
async def get_chat_versions(chat_id: str, store: StoreDep) -> ChatVersionsOut:
    """The chat's replaced prompt versions, oldest-left branch first.

    Every resubmit/edit cuts the stored history at a user prompt and keeps
    the replaced tail as a ``ConversationRecord.branches`` tip. Each version
    here is a branch's first entry that diverges from the head chain, when
    that entry is a user-prompt request: its ``ui_message_id`` equals the
    transcript ``UIMessage.id`` the client resubmits against, so the
    renderer can attach an "edited" switcher to the right bubble.
    """
    chat = await store.get_chat(chat_id)
    if chat is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found"
        )
    record = await store.read_record(chat_id)
    if record is None or record.scope != chat.workspace_id:
        return ChatVersionsOut()
    head = await store.read_history(record.head_id)
    versions: list[PromptVersionOut] = []
    for tip in record.branches:
        branch = await store.read_history(tip)
        diverging = _first_diverging_entry(head, branch)
        if diverging is not None and (
            version := _prompt_version(diverging, tip)
        ) is not None:
            versions.append(version)
    return ChatVersionsOut(versions=versions)


def _first_diverging_entry(
    head: list[ConversationEntry], branch: list[ConversationEntry]
) -> ConversationEntry | None:
    """The first ``branch`` entry the head chain doesn't also contain.

    A branch shares its prefix entries with the head chain (same store
    ids), so the first id mismatch — or the first entry past the head's
    end — is where the replaced tail begins.
    """
    for index, entry in enumerate(branch):
        if index >= len(head) or head[index].id != entry.id:
            return entry
    return None


def _prompt_version(
    entry: ConversationEntry, tip: str
) -> PromptVersionOut | None:
    """A version row when ``entry`` is a ui-stamped user-prompt request."""
    message = entry.message
    if not isinstance(message, ModelRequest):
        return None
    prompt = next(
        (part for part in message.parts if isinstance(part, UserPromptPart)),
        None,
    )
    if prompt is None or not isinstance(prompt.content, str):
        return None
    message_id = get_ui_message_id(message)
    if message_id is None:
        return None
    return PromptVersionOut(
        id=entry.id,
        message_id=message_id,
        tip=tip,
        text=prompt.content,
        timestamp=prompt.timestamp,
    )
