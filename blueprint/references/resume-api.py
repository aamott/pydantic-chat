"""Resume a chat's last interrupted run from its StepPersistence snapshot.

``POST /api/chats/{chat_id}/resume`` is the server-initiated counterpart of
``POST /api/chat``: instead of a client ``UIMessage`` driving a new turn, the
chat's newest run in ``steps.db`` (``list_runs(conversation_id=chat_id)``,
newest-last) supplies the history — its latest ``ContinuableSnapshot``,
interrupted ones included — and the run continues with
``agent.run_stream_events`` on it directly.

Why the adapter is bypassed: ``dispatch_request``'s ``conversation_store``
path rejects an explicit ``message_history`` outright
(``_check_conversation_store_run`` raises ``UserError`` — "pass either
``message_history`` or a ``conversation_store``, not both"), and under
``manage_message_history='server'`` the client's new turn is what gets cut or
appended — a server-initiated continuation has no client turn at all. So this
route drives the run itself and reproduces the persistence contract:

- **Save** — on ``AgentRunResultEvent`` the result's ``conversation`` goes to
  ``store.save``, the same content-comparison path the adapter uses with no
  resubmit in play: when the persisted failed tail is a prefix of the resumed
  history the new output appends; when it diverges (e.g. a snapshot boundary
  behind the stored tail) the replaced tail is kept in ``record.branches``.
- **Failure** — ``capture_run_messages`` + ``save_failed_run_messages``,
  shared with ``AppVercelAIAdapter._persist_failed_run``.
- **``ui_message_id``** — no synthetic stamping is needed: the snapshot's
  deep-copied messages carry the original user prompt's ``ui_message_id``
  forward, and a resumed run produces only assistant/tool messages, which the
  resubmit cut never matches against. Subsequent resubmits still cut at the
  original prompt, keeping the whole failed+resumed tail as a branch.

Unknown side effects: ``list_unresolved_tool_effects`` returns the tool calls
whose ledger record stayed ``started`` — ``unknown_after_crash``, meaning the
side effect may or may not have happened. They are never silently trusted:
the stream opens with a transient ``data-resume`` chunk naming them so the
user is told, whatever the continuation does next::

    {"type": "data-resume", "transient": true,
     "data": {"continued_run_id": str, "snapshot_state": "complete"|"interrupted",
              "unknown_effects": [{"tool_call_id": str, "tool_name": str}, ...]}}

What happens to those calls depends on the snapshot tail, pydantic-ai's own
rules: a snapshot ending in a ``ModelResponse`` with still-pending calls
resumes at ``CallToolsNode`` and re-executes them (visibly — the warning
already named them); a snapshot ending in an ``interrupted`` ``ModelRequest``
marker (a mid-execution cancel) is closed by ``_repair_interrupted_tail``
with synthesized ``interrupted`` returns instead — the model is told the
call did not finish rather than the effect being re-fired unknowable-times.

The frontend surfaces the chunk as a notice; it is transient so it never
lands in stored history or the persisted transcript.

Approvals interplay: a run interrupted *while awaiting approval* has pending
``deferred_tool_requests`` on the stored record, not an interrupted snapshot —
resume is refused (409). The correct continuation there is the approval
answer itself through ``POST /api/chat``. A run still streaming (a
cancellation token is registered) is likewise refused.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass

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
from pydantic_ai.exceptions import RunCancelled, UserError
from pydantic_ai.ui import NativeEvent
from pydantic_ai.ui.vercel_ai import VercelAIEventStream
from pydantic_ai.ui.vercel_ai.response_types import BaseChunk, DataChunk
from pydantic_ai.usage import RunUsage
from pydantic_ai_harness.step_persistence import (
    ContinuableSnapshot,
    SqliteStepStore,
    ToolEffectRecord,
)
from starlette.responses import Response

from app.agent.factory import build_run_kwargs, get_agent
from app.agent.models import ProviderNotConfigured, UnknownProviderError
from app.api.chat import (
    SDK_VERSION,
    _on_run_cancelled,
    _on_run_end,
    _release_token,
    _run_settings,
    save_failed_run_messages,
)
from app.api.deps import StoreDep
from app.config import data_dir
from app.db import ChatStore
from app.db.app_tables import ChatSummary

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["chat"])

_CONVERSATION_CHANGED = (
    "The conversation was changed by another request while this one ran, so "
    "this turn was not saved. Reload the conversation from the server and "
    "try again."
)
"""Same CAS-conflict text the adapter emits for a concurrent save."""


@dataclass
class _ResumeTarget:
    """The newest run's resume point and its unknown-after-crash effects."""

    run_id: str
    snapshot: ContinuableSnapshot
    unknown_effects: list[ToolEffectRecord]


async def _resume_target(steps: SqliteStepStore, chat_id: str) -> _ResumeTarget | None:
    """The chat's newest run's continuable snapshot, when one is worth resuming.

    ``None`` when no run was recorded, the newest run completed (its output
    is already the stored head — replaying it would only duplicate), or the
    failed run never produced a model response worth continuing from (a bare
    prompt is equivalent to resubmitting it, which the normal chat path does).
    """
    runs = await steps.list_runs(conversation_id=chat_id)
    if not runs:
        return None
    run = runs[-1]
    events = await steps.list_events(run_id=run.run_id)
    if any(event.kind == "run_completed" for event in events):
        return None
    snapshot = await steps.latest_snapshot(run_id=run.run_id, include_interrupted=True)
    if snapshot is None:
        return None
    return _ResumeTarget(
        run_id=run.run_id,
        snapshot=snapshot,
        unknown_effects=await steps.list_unresolved_tool_effects(run_id=run.run_id),
    )


async def _resume_blocker(
    store: ChatStore,
    chat: ChatSummary,
    tokens: dict[str, CancellationToken],
) -> tuple[int, str] | None:
    """``(status, detail)`` blocking a resume, or ``None`` when resumable."""
    if chat.id in tokens:
        return (
            status.HTTP_409_CONFLICT,
            "A run is still in progress for this chat",
        )
    record = await store.read_record(chat.id)
    if record is not None and record.deferred_tool_requests is not None:
        # The run ended waiting on tool approval or a deferred result, not
        # mid-work: the continuation is the approval answer through /api/chat.
        return (
            status.HTTP_409_CONFLICT,
            "The last run is waiting on a tool approval — answer it instead of resuming",
        )
    steps = _step_store()
    runs = await steps.list_runs(conversation_id=chat.id)
    if not runs:
        return (
            status.HTTP_404_NOT_FOUND,
            "No interrupted run to resume for this chat",
        )
    events = await steps.list_events(run_id=runs[-1].run_id)
    if any(event.kind == "run_completed" for event in events):
        # The newest run finished: its output is already the stored head, so
        # resuming would only duplicate it — a state conflict, not a miss.
        return (
            status.HTTP_409_CONFLICT,
            "The last run completed — there is nothing to resume",
        )
    if await _resume_target(steps, chat.id) is None:
        return (
            status.HTTP_404_NOT_FOUND,
            "No interrupted run to resume for this chat",
        )
    return None


def _step_store() -> SqliteStepStore:
    """A store handle on the same ``steps.db`` ``build_run_kwargs`` snapshots into."""
    return SqliteStepStore(database=data_dir() / "steps.db")


@router.get("/chats/{chat_id}/resume")
async def resume_status(
    chat_id: str, request: Request, store: StoreDep
) -> dict[str, object]:
    """Whether ``POST …/resume`` would run — the affordance's probe.

    ``{"resumable": bool, "reason": str | None}``; the reason is the same
    ``detail`` the POST would 404/409 with.
    """
    chat = await store.get_chat(chat_id)
    if chat is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found"
        )
    blocker = await _resume_blocker(store, chat, request.app.state.cancellation_tokens)
    return {
        "resumable": blocker is None,
        "reason": blocker[1] if blocker is not None else None,
    }


@router.post("/chats/{chat_id}/resume")
async def resume_chat(chat_id: str, request: Request, store: StoreDep) -> Response:
    """Continue the chat's last interrupted run as a UI Message Stream (SSE).

    Same wire contract as ``POST /api/chat`` — the frontend consumes it
    through the SDK's ``resume-stream`` trigger (see
    ``lib/transport.ts``): ``data-resume`` notice, ``data-run-meta``, the
    usual parts, ``finish``. The run continues from the snapshot's history,
    so tool work it proves settled is not re-executed.
    """
    chat = await store.get_chat(chat_id)
    if chat is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found"
        )
    workspace = await store.get_workspace(chat.workspace_id)
    if workspace is None:  # unreachable while the FK cascade holds; defensive
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found"
        )

    tokens = request.app.state.cancellation_tokens
    blocker = await _resume_blocker(store, chat, tokens)
    if blocker is not None:
        raise HTTPException(status_code=blocker[0], detail=blocker[1])
    target = await _resume_target(_step_store(), chat_id)
    if target is None:  # lost the race with another writer since the check
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No interrupted run to resume for this chat",
        )

    # The stored head supplies usage and the CAS revision; the messages come
    # from the snapshot, NOT the stored history — the whole point is the
    # snapshot may be a superset (settled boundary) or a different tail than
    # the persisted failed turn. `new_message_index` stays unset so the save
    # compares content and branches on divergence.
    loaded = await store.load(chat_id, scope=chat.workspace_id)
    conversation = Conversation(
        messages=list(target.snapshot.messages),
        conversation_id=chat_id,
        usage=loaded.usage if loaded is not None else RunUsage(),
        revision=loaded.revision if loaded is not None else None,
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
    tokens[chat_id] = token

    event_stream = VercelAIEventStream(sdk_version=SDK_VERSION)
    response = event_stream.streaming_response(
        _resume_chunks(
            event_stream, store, chat, conversation, run_kwargs, token, target
        )
    )
    # Same lifecycle as /api/chat: the token is released however the body ends.
    response.body_iterator = _release_token(
        response.body_iterator, tokens, chat_id, token
    )
    return response


async def _resume_chunks(
    event_stream: VercelAIEventStream,
    store: ChatStore,
    chat: ChatSummary,
    conversation: Conversation,
    run_kwargs: dict,
    token: CancellationToken,
    target: _ResumeTarget,
) -> AsyncIterator[BaseChunk]:
    """``data-resume`` notice, then the resumed run's chunks.

    ``on_complete``/``on_cancel`` are the same callbacks ``/api/chat`` wires —
    title, activity timestamp, and (on cancel) the partial-turn save, which
    works here unchanged because ``RunCancelled.all_messages()`` is the
    snapshot prefix plus the resumed run's partial output.
    """
    yield DataChunk(
        type="data-resume",
        data={
            "continued_run_id": target.run_id,
            "snapshot_state": target.snapshot.state,
            "unknown_effects": [
                {
                    "tool_call_id": effect.tool_call_id,
                    "tool_name": effect.tool_name,
                }
                for effect in target.unknown_effects
            ],
        },
        transient=True,
    )
    async for chunk in event_stream.transform_stream(
        _resume_native_events(store, chat, conversation, run_kwargs, token),
        on_complete=_on_run_end(store, chat),
        on_cancel=_on_run_cancelled(store, chat),
    ):
        yield chunk


async def _resume_native_events(
    store: ChatStore,
    chat: ChatSummary,
    conversation: Conversation,
    run_kwargs: dict,
    token: CancellationToken,
) -> AsyncIterator[NativeEvent]:
    """Run the agent on the snapshot history; save on result, rescue on error.

    The save-on-result seam mirrors ``UIAdapter._saving_conversation``: it
    runs *before* the result event passes through, so a store conflict is
    delivered as a stream error chunk rather than silently lost. The
    error-rescue seam mirrors ``_persist_failed_run`` — same captured-history
    save, so a run that fails *again* is itself resumable (its own snapshots
    and at-failure history land in ``steps.db``/``app.db`` as usual).
    """
    saved = False
    with capture_run_messages() as captured:
        try:
            async with get_agent().run_stream_events(
                conversation=conversation,
                cancellation_token=token,
                **run_kwargs,
            ) as events:
                async for event in events:
                    if isinstance(event, AgentRunResultEvent):
                        await _save_resumed_run(store, chat, event.result)
                        saved = True
                    yield event
        except RunCancelled:
            raise  # `on_cancel` (`_persist_partial`) owns cancelled runs.
        except BaseException:
            if not saved:
                with anyio.CancelScope(shield=True):
                    await save_failed_run_messages(
                        store, chat.workspace_id, chat.id, captured
                    )
            raise


async def _save_resumed_run(
    store: ChatStore, chat: ChatSummary, result: AgentRunResult
) -> None:
    """Store the resumed conversation: append on prefix match, branch on divergence.

    ``result.conversation`` carries the run's full history — snapshot prefix
    plus resumed output — with the input ``revision`` as the CAS token and no
    ``new_message_index`` mark, so the store's content comparison decides:
    the persisted failed tail is appended-to when it's a prefix of the new
    history, and kept as a ``record.branches`` tip when it isn't.
    """
    try:
        await store.save(result.conversation, scope=chat.workspace_id)
    except ConversationConflict as error:
        raise UserError(_CONVERSATION_CHANGED) from error
