"""FastAPI app factory: health check, auth middleware, router wiring."""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.api import (
    chat,
    chats,
    files,
    mcp,
    models,
    profiles,
    resume,
    settings,
    workspaces,
)
from app.db import ChatStore
from app.profiles import ensure_system_skills

BEARER = HTTPBearer(auto_error=False)


def _check_auth(
    credentials: HTTPAuthorizationCredentials | None = Depends(BEARER),
) -> None:
    token = os.environ.get("APP_TOKEN", "")
    if not token or not credentials or credentials.credentials != token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Own the one ``ChatStore`` (``data_dir()/app.db``) for the app's lifetime."""
    store = ChatStore()
    app.state.store = store
    # Seed data_dir()/skills from the bundled template on first boot; lazy
    # resolves call this too, so a wiped data dir re-seeds on demand.
    ensure_system_skills()
    # Live agent runs: chat_id -> CancellationToken, for POST /api/chats/{id}/stop.
    app.state.cancellation_tokens = {}
    try:
        yield
    finally:
        store.close()


def create_app() -> FastAPI:
    """Build the FastAPI app. Token arrives via APP_TOKEN env from Electron."""
    app = FastAPI(title="pydantic-chat-backend", lifespan=_lifespan)

    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[os.environ.get("RENDERER_ORIGIN", "http://localhost:5173")],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/ping", dependencies=[Depends(_check_auth)])
    async def ping() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(workspaces.router, dependencies=[Depends(_check_auth)])
    app.include_router(chats.router, dependencies=[Depends(_check_auth)])
    app.include_router(files.router, dependencies=[Depends(_check_auth)])
    app.include_router(chat.router, dependencies=[Depends(_check_auth)])
    app.include_router(resume.router, dependencies=[Depends(_check_auth)])
    app.include_router(settings.router, dependencies=[Depends(_check_auth)])
    app.include_router(mcp.router, dependencies=[Depends(_check_auth)])
    app.include_router(models.router, dependencies=[Depends(_check_auth)])
    app.include_router(profiles.router, dependencies=[Depends(_check_auth)])

    return app


app = create_app()
