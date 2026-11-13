"""Agent streaming endpoint: one run per request, Vercel AI UI Message Stream over SSE.

Frontend contract
-----------------
`useChat` + `DefaultChatTransport` POST the run input to a single `api` URL —
``POST /api/chat`` here — with the chat id in the body's top-level ``id`` field
(``SubmitMessage`` / ``RegenerateMessage`` in
``pydantic_ai.ui.vercel_ai.request_types``). ``VercelAIAdapter.conversation_id``
reads that same field, so the body ``id`` IS the conversation id: no per-chat
route and no transport customization beyond ``api: '/api/chat'``. Body shape::

    {"id": "<chat_id>", "trigger": "submit-message", "messages": [UIMessage, ...]}
    {"id": "<chat_id>", "trigger": "regenerate-message", "messages": [...], "messageId": "<id>"}

The chat must already exist (``POST /api/workspaces/{workspace_id}/chats``): the
run's workspace, model, and permission settings resolve from the chat row, so an
``id`` the store doesn't know gets a 404 rather than silently running with no
workspace. The conversation *record* is created by the store on first save, so a
brand-new chat streams fine.

``POST /api/chats/{chat_id}/stop`` cancels the chat's live run through a
``CancellationToken`` registered on ``app.state.cancellation_tokens``. Client
disconnect does NOT fire ``on_cancel`` (external ``CancelledError`` never
becomes ``RunCancelled``), so the explicit stop route is the user's halt button.

``GET /api/chat/{chat_id}/stream`` is the resume route the SDK's
``DefaultChatTransport.reconnectToStream`` calls (``useChat({resume: true})``).
The adapter exposes no in-flight event buffer to attach to, so it replays the
last *persisted* assistant response as a completed UI message stream — see the
route's docstring for the mechanics and the v1 limitation.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from contextlib import suppress
from typing import TYPE_CHECKING, Any

import anyio
from fastapi import APIRouter, HTTPException, Request, status
from pydantic_ai import (
    AgentRunResult,
    AgentRunResultEvent,
    CancellationToken,
    capture_run_messages,
)
from pydantic_ai.conversation import Conversation
from pydantic_ai.conversation_store import ConversationConflict
from pydantic_ai.exceptions import RunCancelled
from pydantic_ai.messages import (
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    ModelRequest,
    ModelResponse,
    PartEndEvent,
    PartStartEvent,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.ui import NativeEvent, OnCancelFunc, OnCompleteFunc
from pydantic_ai.ui.vercel_ai import VercelAIAdapter, VercelAIEventStream
from pydantic_ai.ui.vercel_ai._utils import dump_message_metadata
from pydantic_ai.ui.vercel_ai.response_types import (
    BaseChunk,
    FinishChunk,
    FinishReason,
    MessageMetadataChunk,
    ToolApprovalRequestChunk,
)
from starlette.responses import Response, StreamingResponse

from app.agent.factory import build_run_kwargs, get_agent
from app.agent.models import ProviderNotConfigured, UnknownProviderError
from app.api.deps import StoreDep
from app.config import load_settings, resolve_model_name
from app.db import ChatStore
from app.db.app_tables import ChatSummary, Workspace

if TYPE_CHECKING:
    from pydantic_ai.messages import ModelMessage

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["chat"])

SDK_VERSION = 7
"""Pinned Vercel AI wire version — matches the app's ``ai@7`` / ``@ai-sdk/react@4``."""

TITLE_MAX_CHARS = 40
"""Auto-titles are the first user prompt truncated to about this many characters."""

NEW_CHAT_TITLE = "New chat"
"""The default chat title that auto-naming replaces."""


class AppVercelAIAdapter(VercelAIAdapter):
    """``VercelAIAdapter`` that also persists a run that dies without a result.

    The stock adapter only saves when an ``AgentRunResultEvent`` passes
    through its stream (``UIAdapter._saving_conversation``), and ``on_cancel``
    only fires for a first-party ``RunCancelled``. A provider exception — or
    a client disconnect's ``CancelledError``/``GeneratorExit``, which bypasses
    ``except Exception`` entirely — would otherwise lose the whole turn,
    user prompt included: the client's resubmit then finds nothing to match
    in the stored conversation, and the failed turn vanishes on reload.

    The fix wraps the *native* event stream in ``capture_run_messages()``,
    which makes the run's live ``message_history`` (stored prefix plus
    whatever the turn produced, interrupted parts included) readable here —
    at exactly the seam where run errors still propagate, before
    ``UIEventStream.transform_stream`` converts them into a stream error
    chunk.
    """

    def transform_stream(
        self,
        stream: AsyncIterator[NativeEvent],
        on_complete: OnCompleteFunc[BaseChunk] | None = None,
        on_cancel: OnCancelFunc[BaseChunk] | None = None,
    ) -> AsyncIterator[BaseChunk]:
        return super().transform_stream(
            self._persist_failed_run(stream),
            on_complete=on_complete,
            on_cancel=on_cancel,
        )

    async def _persist_failed_run(
        self, stream: AsyncIterator[NativeEvent]
    ) -> AsyncIterator[NativeEvent]:
        """Pass native events through; save the run's history if it dies unsaved."""
        store = self.conversation_store
        # The run's conversation id falls back to this same value, and our
        # route passes the body's `id` explicitly, so they always agree.
        conversation_id = self.conversation_id
        if store is None or not conversation_id or conversation_id == "new":
            async for event in stream:
                yield event
            return
        saved = False
        with capture_run_messages() as captured:
            try:
                async for event in stream:
                    # After the result event the adapter itself has saved.
                    saved = saved or isinstance(event, AgentRunResultEvent)
                    yield event
            except RunCancelled:
                raise  # `on_cancel` (`_persist_partial`) owns cancelled runs.
            except BaseException:
                # Provider errors, `UsageLimitExceeded`, disconnect close
                # (`GeneratorExit`) and task `CancelledError` all land here.
                if not saved:
                    # Disconnect lands inside a cancelled anyio scope where
                    # every further await re-raises; shield so the save runs.
                    with anyio.CancelScope(shield=True):
                        await self._save_captured(stream, conversation_id, captured)
                raise

    async def _save_captured(
        self,
        stream: AsyncIterator[NativeEvent],
        conversation_id: str,
        captured: list[ModelMessage],
    ) -> None:
        """Persist the captured at-failure history, mirroring ``_persist_partial``.

        Closing the (possibly still-suspended) inner stream first gives the
        run's own teardown a chance to record the in-flight part as
        ``state='interrupted'`` before the history is read. The save follows
        the store's content-comparison path, so a failed resubmit also
        branches the tail it replaces; failures to persist are logged, never
        raised over the run's own error.
        """
        aclose = getattr(stream, "aclose", None)
        if aclose is not None:
            # BaseException: even a cancellation surfacing from the run's own
            # teardown must not abort the save that teardown exists to enable.
            with suppress(BaseException):
                await aclose()
        if not captured:
            return
        store = self.conversation_store
        assert store is not None  # caller guarantees it
        try:
            loaded = await store.load(
                conversation_id, scope=self.conversation_scope
            )
            if loaded is None:
                conversation = Conversation(
                    messages=list(captured), conversation_id=conversation_id
                )
            else:
                loaded.messages = list(captured)
                conversation = loaded
            await store.save(conversation, scope=self.conversation_scope)
        except ConversationConflict:
            logger.warning(
                "Failed run for chat %s not saved: store conflict", conversation_id
            )
        except Exception:
            logger.exception("Failed run for chat %s not saved", conversation_id)


@router.post("/chat")
async def stream_chat(request: Request, store: StoreDep) -> Response:
    """Stream one agent run as a Vercel AI UI Message Stream (SSE).

    Reads the chat ``id`` off the request body (Starlette caches the body, so
    ``dispatch_request`` re-reading it for validation is free), resolves the
    chat + workspace rows into per-run kwargs, then hands the whole request to
    ``AppVercelAIAdapter.dispatch_request``, which owns run lifecycle and
    history persistence (``conversation_store`` + ``conversation_scope``,
    plus the failed-turn save the subclass adds).
    """
    chat_id = await _chat_id(request)
    chat = await store.get_chat(chat_id)
    if chat is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found"
        )
    workspace = await store.get_workspace(chat.workspace_id)
    if workspace is None:  # unreachable while the FK cascade holds; kept defensive
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found"
        )

    run_settings = await _run_settings(store, chat, workspace)
    try:
        run_kwargs = build_run_kwargs(run_settings, workspace)
    except ProviderNotConfigured as error:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED, detail=str(error)
        ) from error
    except UnknownProviderError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)
        ) from error

    token = CancellationToken()
    tokens = request.app.state.cancellation_tokens
    tokens[chat_id] = token

    response = await AppVercelAIAdapter.dispatch_request(
        request,
        agent=get_agent(),
        sdk_version=SDK_VERSION,
        conversation_id=chat_id,
        conversation_store=store,
        conversation_scope=chat.workspace_id,
        cancellation_token=token,
        on_complete=_on_run_end(store, chat),
        on_cancel=_on_run_cancelled(store, chat),
        **run_kwargs,
    )
    if isinstance(response, StreamingResponse):
        # The run finishes while the body streams, so token cleanup wraps the
        # iterator: it fires on success, cancel, mid-stream error, and disconnect.
        response.body_iterator = _release_token(
            response.body_iterator, tokens, chat_id, token
        )
    else:
        # A pre-run error response (validation, conversation lookup): no run
        # ever started, so release the token immediately.
        tokens.pop(chat_id, None)
    return response


@router.post("/chats/{chat_id}/stop")
async def stop_chat(chat_id: str, request: Request) -> dict[str, str]:
    """Request cancellation of the chat's live run; 404 when nothing is running."""
    token = request.app.state.cancellation_tokens.get(chat_id)
    if token is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No run in progress for this chat",
        )
    token.cancel()
    return {"status": "cancel_requested"}


@router.get("/chat/{chat_id}/stream")
async def replay_stream(chat_id: str, store: StoreDep) -> Response:
    """Replay the chat's last persisted assistant response as a completed SSE stream.

    ``DefaultChatTransport.reconnectToStream`` calls this route when a mounted
    ``useChat({resume: true})`` chat wants to reattach. The transport's
    ``resumeStreamIsReplay`` (its default) makes the client drop its streamed
    message state on the first ``start`` chunk and rebuild the message keyed by
    ``start.messageId``, so the wire contract is "the response from its
    beginning", not "the chunks since disconnect".

    What is replayed: the last ``ModelResponse`` in the stored conversation
    that ``dump_messages`` renders, re-encoded through a standalone
    ``VercelAIEventStream`` — the same transformer the live path uses — fed
    with synthesized ``PartStartEvent``/``PartEndEvent``/``FunctionTool*Event``
    events. ``start.messageId`` is the id ``dump_messages`` gives that response
    over the full stored history, so the replayed message *replaces* the
    transcript entry the client already seeded from ``GET .../messages``
    instead of duplicating it. Each tool call gets ``args_valid=None``: the
    streamer's documented resume path then backfills ``tool-input-available``
    when the result chunk arrives, and an unanswered call is closed out with
    the same ``tool-approval-request`` ``dump_messages`` implies.

    v1 limitation: the adapter exposes no in-flight event buffer, so a run
    still streaming returns the last *committed* turn — its in-progress output
    is only persisted at completion (or on cancel), never mid-run. The client
    keeps consistent history and never blocks; it just doesn't see the live
    tail. True live reattach would take a per-chat tee buffer on the POST
    stream, which the frontend can adopt later without this route changing.

    404 when the chat is unknown, has no stored conversation, or has no
    assistant response yet — the transport maps that to "nothing to resume".
    """
    chat = await store.get_chat(chat_id)
    if chat is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found"
        )
    conversation = await store.load(chat_id, scope=chat.workspace_id)
    if conversation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Nothing to replay"
        )
    target = _replay_target(conversation.messages)
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Nothing to replay"
        )
    index, response = target

    # The start chunk's messageId must be the UIMessage id the client already
    # seeded for this response — `dump_messages` over the whole conversation,
    # same as `GET .../messages`, so the ids line up positionally.
    ui_messages = VercelAIAdapter.dump_messages(
        conversation.messages, sdk_version=SDK_VERSION
    )
    message_id = next(
        (m.id for m in reversed(ui_messages) if m.role == "assistant"), None
    )

    stream = VercelAIEventStream(sdk_version=SDK_VERSION, server_message_id=message_id)
    return stream.streaming_response(
        _replay_chunks(
            stream, response, _tool_returns(conversation.messages[index + 1 :])
        )
    )


def _replay_target(
    messages: list[ModelMessage],
) -> tuple[int, ModelResponse] | None:
    """Index and value of the last response that dumps as a UIMessage, or ``None``.

    A response the dumper skips (no renderable parts) produces no transcript
    message, so the replay target is the last one that *does* dump — which is
    what the last assistant ``UIMessage`` in the full dump corresponds to.
    """
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if isinstance(message, ModelResponse) and VercelAIAdapter.dump_messages(
            [message], sdk_version=SDK_VERSION
        ):
            return index, message
    return None


def _tool_returns(messages: list[ModelMessage]) -> dict[str, ToolReturnPart]:
    """Tool returns in ``messages``, keyed by ``tool_call_id`` (first wins)."""
    returns: dict[str, ToolReturnPart] = {}
    for message in messages:
        if isinstance(message, ModelRequest):
            for part in message.parts:
                if (
                    isinstance(part, ToolReturnPart)
                    and part.tool_call_id not in returns
                ):
                    returns[part.tool_call_id] = part
    return returns


async def _replay_events(
    response: ModelResponse, returns: dict[str, ToolReturnPart]
) -> AsyncIterator[NativeEvent]:
    """The native events a run emitted while producing ``response``.

    Each part arrives whole: one ``PartStartEvent`` + ``PartEndEvent`` pair per
    stored part — the start hook itself emits the part's content as a single
    delta, so no ``PartDeltaEvent``s are needed. Tool calls then follow, as in
    a live run: a ``FunctionToolCallEvent`` with ``args_valid=None`` (the call
    doesn't execute on a replayed stream) and the stored ``FunctionToolResultEvent``
    when the return is in history.
    """
    parts = response.parts
    for index, part in enumerate(parts):
        # `canonical_system` applies to a part when the part's provider is the
        # response's — the same rule `StreamedResponse._part_canonical_system`
        # uses when stamping live part events.
        canonical = (
            response.canonical_system
            if part.provider_name == response.provider_name
            else None
        )
        yield PartStartEvent(
            index=index,
            part=part,
            previous_part_kind=parts[index - 1].part_kind if index else None,
            canonical_system=canonical,
        )
        yield PartEndEvent(
            index=index,
            part=part,
            next_part_kind=parts[index + 1].part_kind
            if index + 1 < len(parts)
            else None,
            canonical_system=canonical,
        )
    for part in parts:
        if isinstance(part, ToolCallPart):
            yield FunctionToolCallEvent(part, args_valid=None)
            if (result := returns.get(part.tool_call_id)) is not None:
                yield FunctionToolResultEvent(result)


async def _replay_chunks(
    stream: VercelAIEventStream[Any, BaseChunk, Any, Any],
    response: ModelResponse,
    returns: dict[str, ToolReturnPart],
) -> AsyncIterator[BaseChunk]:
    """Protocol chunks for the replay, with the run-result chunks re-attached.

    The synthesized event stream has no ``AgentRunResultEvent`` to synthesize
    (no run exists), so the chunks ``handle_run_result`` would have emitted are
    injected just before ``finish``: the response's ``message-metadata``, then
    ``tool-approval-request`` for each call history never answered — the same
    "no result found → approval-requested" rule ``dump_messages`` applies.
    """
    unanswered = [
        part.tool_call_id
        for part in response.parts
        if isinstance(part, ToolCallPart) and part.tool_call_id not in returns
    ]
    async for chunk in stream.transform_stream(_replay_events(response, returns)):
        if isinstance(chunk, FinishChunk):
            yield MessageMetadataChunk(message_metadata=dump_message_metadata(response))
            for tool_call_id in unanswered:
                yield ToolApprovalRequestChunk(
                    approval_id=tool_call_id, tool_call_id=tool_call_id
                )
            chunk = FinishChunk(
                finish_reason=_replay_finish_reason(response, chunk.finish_reason)
            )
        yield chunk


def _replay_finish_reason(
    response: ModelResponse, fallback: FinishReason
) -> FinishReason:
    """The wire ``finishReason`` for the replayed response, mirroring ``handle_run_result``."""
    if response.finish_reason is None:
        return fallback
    return _FINISH_REASONS.get(response.finish_reason, "other")


_FINISH_REASONS: dict[str, FinishReason] = {
    "stop": "stop",
    "length": "length",
    "content_filter": "content-filter",
    "tool_call": "tool-calls",
    "error": "error",
}
"""Pydantic → Vercel finish-reason map, as in ``VercelAIEventStream.handle_run_result``."""


async def _chat_id(request: Request) -> str:
    """The chat id from the body's top-level ``id`` field, or a 422.

    ``await request.json()`` caches the raw body on the request, so the
    adapter's own ``request.body()`` read inside ``dispatch_request`` still sees
    the full payload and does the authoritative ``RequestData`` validation.
    """
    try:
        body = await request.json()
    except ValueError as exc:  # JSONDecodeError and UnicodeDecodeError
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Request body must be a JSON object",
        ) from exc
    chat_id = body.get("id") if isinstance(body, dict) else None
    if not isinstance(chat_id, str) or not chat_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Request body must include the chat `id`",
        )
    return chat_id


async def _run_settings(
    store: ChatStore, chat: ChatSummary, workspace: Workspace
) -> dict[str, Any]:
    """The ``chat_settings`` mapping ``build_run_kwargs`` consumes.

    App settings come first — the KV table stores strings, so JSON-typed values
    (the allow/deny lists) decode back while plain scalars pass through. The
    merge order for the per-run overrides is chat > workspace > global:
    ``permission_profile`` falls through each ``NULL`` to the next layer
    (``build_run_kwargs`` then falls back to :data:`DEFAULT_PERMISSION_PROFILE`),
    ``model`` resolves via :func:`resolve_model_name` (chat -> default_model ->
    :data:`DEFAULT_MODEL`), and ``thinking`` is the chat's normalized level or
    ``None``. ``chat_id`` (which scopes the ``Planning`` store) overlays
    everything.
    """
    settings: dict[str, Any] = {
        key: _decode_setting(value)
        for key, value in (await load_settings(store)).items()
    }
    if workspace.permission_profile:
        settings["permission_profile"] = workspace.permission_profile
    if chat.permission_profile:
        settings["permission_profile"] = chat.permission_profile
    settings["model"] = await resolve_model_name(chat, store)
    settings["thinking"] = chat.thinking
    settings["chat_id"] = chat.id
    return settings


def _decode_setting(value: str) -> Any:
    """JSON-decode a settings value when it parses (lists, bools); else keep the raw string."""
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return value


def _on_run_end(store: ChatStore, chat: ChatSummary):
    """``on_complete``: auto-title the chat from its first prompt and bump activity.

    The ``conversation_store`` already saved the run before this fires (the
    adapter wraps ``on_complete`` around ``_save_conversation``), so the only
    work left is chat metadata.
    """

    async def complete(result: AgentRunResult[Any]) -> None:
        await _maybe_set_title(store, chat.id, result.all_messages())
        await store.touch_chat(chat.id)

    return complete


def _on_run_cancelled(store: ChatStore, chat: ChatSummary):
    """``on_cancel``: persist the partial turn, then same metadata as a completed run.

    ``_saving_conversation`` only saves on ``AgentRunResultEvent``, which a
    cancelled run never emits — without this the stopped turn would vanish.
    """

    async def cancelled(cancelled_run: RunCancelled) -> None:
        await _persist_partial(store, chat, cancelled_run)
        await _maybe_set_title(store, chat.id, cancelled_run.all_messages())
        await store.touch_chat(chat.id)

    return cancelled


async def _persist_partial(
    store: ChatStore, chat: ChatSummary, cancelled_run: RunCancelled
) -> None:
    """Save what a cancelled run completed before the token fired.

    ``cancelled_run.all_messages()`` is the resumable history — stored prefix
    plus whatever the run produced. Reusing the stored record's revision keeps
    the save CAS-checked; ``save`` compares by content and appends only the
    tail, so a no-progress cancel stores nothing.
    """
    messages = cancelled_run.all_messages()
    if not messages:
        return
    loaded = await store.load(chat.id, scope=chat.workspace_id)
    if loaded is None:
        conversation = Conversation(
            messages=list(messages),
            usage=cancelled_run.usage,
            conversation_id=chat.id,
        )
    else:
        loaded.messages = list(messages)
        loaded.usage = loaded.usage + cancelled_run.usage
        conversation = loaded
    try:
        await store.save(conversation, scope=chat.workspace_id)
    except ConversationConflict:
        logger.warning("Partial state for chat %s not saved: store conflict", chat.id)
    except Exception:
        logger.exception("Partial state for chat %s not saved", chat.id)


async def _maybe_set_title(
    store: ChatStore, chat_id: str, messages: list[ModelMessage]
) -> None:
    """Name an untitled chat after its first user prompt, truncated to ~40 chars.

    Re-reads the row so a rename done while the run was live isn't clobbered.
    """
    current = await store.get_chat(chat_id)
    if current is None or current.title != NEW_CHAT_TITLE:
        return
    title = _first_user_text(messages)
    if title:
        await store.rename_chat(chat_id, title)


def _first_user_text(messages: list[ModelMessage]) -> str | None:
    """First user prompt text in the history, whitespace-collapsed and truncated."""
    for message in messages:
        if not isinstance(message, ModelRequest):
            continue
        for part in message.parts:
            if isinstance(part, UserPromptPart) and isinstance(part.content, str):
                text = " ".join(part.content.split())
                if not text:
                    continue
                if len(text) > TITLE_MAX_CHARS:
                    text = text[:TITLE_MAX_CHARS].rstrip() + "…"
                return text
    return None


async def _release_token(
    stream: AsyncIterator[str],
    tokens: dict[str, CancellationToken],
    chat_id: str,
    token: CancellationToken,
) -> AsyncIterator[str]:
    """Pass SSE chunks through, then drop the run's token however the stream ends.

    Guards the pop with identity so a token a newer run registered for the same
    chat is never removed underneath it.
    """
    try:
        async for chunk in stream:
            yield chunk
    finally:
        if tokens.get(chat_id) is token:
            tokens.pop(chat_id, None)
