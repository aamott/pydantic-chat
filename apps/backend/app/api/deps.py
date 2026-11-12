"""Shared dependencies for the API routers."""

from typing import Annotated

from fastapi import Depends, Request

from app.db import ChatStore


def get_store(request: Request) -> ChatStore:
    """The lifespan-owned ``ChatStore`` singleton stashed on ``app.state.store``."""
    return request.app.state.store


StoreDep = Annotated[ChatStore, Depends(get_store)]
