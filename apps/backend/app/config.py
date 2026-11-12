"""Runtime configuration: paths, env, secrets file, and app-settings helpers."""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from app.db.app_tables import ChatSummary
    from app.db.store import ChatStore

logger = logging.getLogger(__name__)

SECRETS_FILENAME = "secrets.json"
"""Name of the backend secrets file inside :func:`data_dir` (mode 0600, never logged)."""

DEFAULT_MODEL = "anthropic:claude-sonnet-4-6"
"""Fallback ``provider:model`` spec when neither the chat nor settings name one."""

DEFAULT_PERMISSION_PROFILE = "manual"
"""Fallback permission profile — the human approves every write and command."""


def data_dir() -> Path:
    """App data dir; Electron passes APP_DATA_DIR, dev falls back to ./.data."""
    raw = os.environ.get("APP_DATA_DIR", "./.data")
    path = Path(raw).expanduser().resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


# ---------------------------------------------------------------------------
# Secrets file
# ---------------------------------------------------------------------------


def secrets_path() -> Path:
    """Location of the secrets file holding provider keys, inside :func:`data_dir`."""
    return data_dir() / SECRETS_FILENAME


def _read_secrets() -> dict[str, Any]:
    """Read ``secrets.json``; an unreadable or malformed file counts as empty."""
    path = secrets_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError):
        logger.warning("Secrets file %s is unreadable; treating it as empty", path)
        return {}
    return data if isinstance(data, dict) else {}


def get_secret(name: str) -> str | None:
    """A secret by name (e.g. ``anthropic_api_key``), ``secrets.json`` over env.

    Args:
        name: The secret's key. The environment fallback is ``name.upper()``
            (``anthropic_api_key`` -> ``ANTHROPIC_API_KEY``).

    Returns:
        The secret value, or ``None`` when configured nowhere. Never logged.
    """
    value = _read_secrets().get(name)
    if isinstance(value, str) and value:
        return value
    return os.environ.get(name.upper()) or None


def secret_source(name: str) -> Literal["file", "env"] | None:
    """Where a secret resolves from, without exposing the value itself.

    Mirrors :func:`get_secret`'s precedence — a non-empty value in
    ``secrets.json`` wins over the matching environment variable. For the
    settings UI's per-provider ``source`` field; never returns key material.

    Returns:
        ``"file"`` when the secret lives in ``secrets.json``, ``"env"`` when
        only the environment provides it, ``None`` when configured nowhere.
    """
    value = _read_secrets().get(name)
    if isinstance(value, str) and value:
        return "file"
    return "env" if os.environ.get(name.upper()) else None


def set_secret(name: str, value: str | None) -> None:
    """Upsert (or, with ``None``, delete) a secret in ``secrets.json``.

    The file is rewritten atomically and kept at mode 0600. The value is never
    logged.
    """
    secrets = _read_secrets()
    if value is None:
        secrets.pop(name, None)
    else:
        secrets[name] = value
    _write_secrets(secrets)


def _write_secrets(secrets: dict[str, Any]) -> None:
    """Atomically rewrite ``secrets.json`` with mode 0600."""
    path = secrets_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f"{path.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(secrets, handle, indent=2)
            handle.write("\n")
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise
    # `os.replace` can leave permissions from an earlier write on some platforms;
    # enforce 0600 on the final path too.
    os.chmod(path, 0o600)


# ---------------------------------------------------------------------------
# Settings table (delegates to ChatStore; imported lazily to avoid a cycle)
# ---------------------------------------------------------------------------


async def load_settings(store: ChatStore | None = None) -> dict[str, str]:
    """All app settings as a plain dict.

    Args:
        store: An existing ``ChatStore`` to read through. When ``None``, a
            short-lived store on the default ``app.db`` is used.
    """
    if store is not None:
        return await store.get_settings()
    from app.db.store import ChatStore

    ephemeral = ChatStore()
    try:
        return await ephemeral.get_settings()
    finally:
        ephemeral.close()


async def save_settings(key: str, value: str, store: ChatStore | None = None) -> None:
    """Upsert one app setting; values are stored verbatim (JSON for structure)."""
    if store is not None:
        await store.set_setting(key, value)
        return
    from app.db.store import ChatStore

    ephemeral = ChatStore()
    try:
        await ephemeral.set_setting(key, value)
    finally:
        ephemeral.close()


async def resolve_model_name(
    chat: ChatSummary | None, store: ChatStore | None = None
) -> str:
    """The ``provider:model`` spec a run should use.

    Resolution order: the chat's own ``model`` column, then the
    ``default_model`` app setting, then :data:`DEFAULT_MODEL`.
    """
    model = getattr(chat, "model", None) if chat is not None else None
    if model:
        return model
    settings = await load_settings(store)
    return settings.get("default_model") or DEFAULT_MODEL
