"""Settings REST routes: app settings KV, provider status, and secrets.

Storage layout
--------------
- Scalar settings live in the sqlite ``settings`` table as plain strings;
  list settings (``allowed_commands`` & co.) are stored JSON-encoded —
  ``app.api.chat._run_settings`` decodes them back when building run kwargs.
- ``ollama_base_url`` is the odd one out: ``resolve_model`` reads it through
  :func:`app.config.get_secret`, so it is persisted via ``set_secret`` (the
  chmod-600 secrets file) — it is a URL, not key material, and safe to return.
- Provider API keys go through :func:`app.config.set_secret` only. Nothing in
  this module logs or returns key material; ``GET`` responses carry at most
  ``has_key``/``source``.

Key names match what ``build_run_kwargs`` consumes (``allowed_patterns`` /
``denied_patterns`` are the ``FileSystem`` glob lists), so a setting written
here takes effect on the next agent run with no translation layer.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, get_args

from fastapi import APIRouter, HTTPException, status

from app.agent.factory import PermissionProfile
from app.agent.models import (
    DEFAULT_OLLAMA_BASE_URL,
    KNOWN_PROVIDERS,
    configured_providers,
)
from app.api.deps import StoreDep
from app.api.schemas import (
    ProviderOut,
    SecretSetIn,
    SettingsOut,
    SettingsPatch,
    SettingValueIn,
)
from app.config import (
    DEFAULT_MODEL,
    DEFAULT_PERMISSION_PROFILE,
    get_secret,
    load_settings,
    secret_source,
    set_secret,
)
from app.db import ChatStore

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/settings", tags=["settings"])

PERMISSION_PROFILES: tuple[str, ...] = get_args(PermissionProfile)
"""The builtin ``permission_profile`` ids — kept for callers listing builtins.

Custom tool profiles make any non-empty string a legal ``permission_profile``
value: unknown ids resolve to ``manual`` at run time, so writes here are
tolerant rather than schema-rejected."""

THEMES: tuple[str, ...] = ("light", "dark", "system")
"""Valid ``theme`` values; mirrored by the renderer's Tailwind dark-mode setup."""

DEFAULT_THEME = "system"

LIST_SETTING_KEYS: tuple[str, ...] = (
    "allowed_commands",
    "denied_commands",
    "allowed_patterns",
    "denied_patterns",
)
"""Settings stored as JSON-encoded ``list[str]`` in the KV table."""

MODEL_SPEC_KEYS: tuple[str, ...] = ("default_model", "judge_model")
"""Settings holding a ``provider:model`` spec, validated against the registry."""

SETTING_KEYS: tuple[str, ...] = (
    "theme",
    "default_model",
    "permission_profile",
    *LIST_SETTING_KEYS,
    "ollama_base_url",
    "judge_model",
)
"""Every key ``PUT /api/settings`` accepts."""

PROVIDER_KEY_NAMES: dict[str, str] = {
    "anthropic": "anthropic_api_key",
    "openai": "openai_api_key",
    "openai-chat": "openai_api_key",
    "google": "google_api_key",
    "google-cloud": "google_api_key",
    "ollama": "ollama_api_key",
    "openai-compatible": "openai_compatible_api_key",
}
"""Provider prefix -> its API-key secret name in ``secrets.json``.

``openai``/``openai-chat`` and ``google``/``google-cloud`` deliberately share a
secret: the registry resolves both prefixes from the same key, so setting or
deleting one prefix's key affects its sibling — same credential, two models.
"""

PROVIDER_BASE_URL_NAMES: dict[str, str] = {
    "ollama": "ollama_base_url",
    "openai-compatible": "openai_compatible_base_url",
}
"""Providers accepting a ``base_url`` on the secrets route; required for ``openai-compatible``."""

EXTRA_OPENAI_COMPATIBLE_SECRETS: tuple[str, ...] = ("openai_compatible_name",)
"""Non-key ``openai-compatible`` secrets cleared alongside its key on DELETE."""


# ---------------------------------------------------------------------------
# App settings
# ---------------------------------------------------------------------------


@router.get("")
async def get_app_settings(store: StoreDep) -> SettingsOut:
    """All non-secret settings; unset keys come back as their defaults."""
    return await _settings_out(store)


@router.put("")
async def put_settings(body: SettingsPatch, store: StoreDep) -> SettingsOut:
    """Merge the provided keys into the settings; ``null`` resets a key."""
    for key, value in body.model_dump(exclude_unset=True).items():
        await _apply_setting(store, key, value)
    return await _settings_out(store)


@router.put("/{key}")
async def put_setting(key: str, body: SettingValueIn, store: StoreDep) -> SettingsOut:
    """Single-key convenience form of ``PUT /api/settings``."""
    if key not in SETTING_KEYS:
        known = ", ".join(SETTING_KEYS)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown setting {key!r}; expected one of: {known}",
        )
    await _apply_setting(store, key, body.value)
    return await _settings_out(store)


# ---------------------------------------------------------------------------
# Providers and secrets
# ---------------------------------------------------------------------------


@router.get("/providers")
async def list_providers() -> list[ProviderOut]:
    """Every known provider's credential status; never includes key material."""
    return [_provider_out(provider) for provider in KNOWN_PROVIDERS]


@router.put("/secrets/{provider}")
async def put_secret(provider: str, body: SecretSetIn) -> ProviderOut:
    """Store a provider's API key (and optionally its base URL) in ``secrets.json``.

    The value is written through :func:`app.config.set_secret`, which keeps the
    file at mode 0600, and is never logged or echoed back.
    """
    _require_known_provider(provider)
    key = _clean(body.key)
    base_url = _clean(body.base_url)
    if key is None and base_url is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide at least one of 'key' or 'base_url'",
        )
    if base_url is not None:
        url_secret = PROVIDER_BASE_URL_NAMES.get(provider)
        if url_secret is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Provider {provider!r} has no configurable base URL",
            )
        set_secret(url_secret, _validate_base_url(url_secret, base_url))
    if key is not None:
        set_secret(PROVIDER_KEY_NAMES[provider], key)
        logger.info("Stored API key for provider %r", provider)
    return _provider_out(provider)


@router.delete("/secrets/{provider}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_secret(provider: str) -> None:
    """Remove a provider's stored credential material from ``secrets.json``.

    Deletes the API-key secret plus, for ``openai-compatible``, its
    base-URL/name secrets (that provider is unusable without them). Env-provided
    credentials are untouched — deleting a file secret just lets env win again.
    """
    _require_known_provider(provider)
    set_secret(PROVIDER_KEY_NAMES[provider], None)
    if provider == "openai-compatible":
        for name in ("openai_compatible_base_url", *EXTRA_OPENAI_COMPATIBLE_SECRETS):
            set_secret(name, None)
    logger.info("Deleted stored credentials for provider %r", provider)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _settings_out(store: ChatStore) -> SettingsOut:
    """Assemble the full settings object, substituting defaults for missing rows."""
    raw = await load_settings(store)
    theme = raw.get("theme")
    profile = raw.get("permission_profile")
    return SettingsOut(
        theme=theme if theme in THEMES else DEFAULT_THEME,
        default_model=raw.get("default_model") or DEFAULT_MODEL,
        # Any non-empty id echoes back verbatim — it may name a custom
        # profile; unknown ids resolve to 'manual' when a run builds.
        permission_profile=(
            profile
            if isinstance(profile, str) and profile
            else DEFAULT_PERMISSION_PROFILE
        ),
        allowed_commands=_list_value(raw, "allowed_commands"),
        denied_commands=_list_value(raw, "denied_commands"),
        allowed_patterns=_list_value(raw, "allowed_patterns"),
        denied_patterns=_list_value(raw, "denied_patterns"),
        ollama_base_url=get_secret("ollama_base_url") or DEFAULT_OLLAMA_BASE_URL,
        # Nullable on purpose: judge_model carries an *explicit* override only.
        # Echoing a display default here once let the settings form persist it
        # back as a real row — a user without that provider's key then silently
        # got manual permissions instead of smart. ``None`` means "judge with
        # the run's own model" (the last-resort spec lives in the factory).
        judge_model=raw.get("judge_model") or None,
    )


def _list_value(raw: dict[str, str], key: str) -> list[str]:
    """Decode a JSON list setting; a missing or malformed row reads as ``[]``."""
    try:
        value = json.loads(raw.get(key) or "[]")
    except json.JSONDecodeError:
        return []
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return value
    return []


async def _apply_setting(store: ChatStore, key: str, value: Any) -> None:
    """Validate and persist one settings key; ``None`` resets it to the default.

    Raises:
        HTTPException: 400 when the value fails the key's per-key schema.
    """
    if key == "ollama_base_url":
        # resolve_model reads this via get_secret, so it lives in secrets.json.
        set_secret(
            "ollama_base_url",
            None
            if value is None
            else _validate_base_url(key, _require_str(key, value)),
        )
        return
    if value is None:
        await store.delete_setting(key)
        return
    # judge_model is the one nullable scalar: the settings form submits ""
    # for a cleared field, which must clear the row (not validate as a spec).
    if key == "judge_model" and isinstance(value, str) and not value.strip():
        await store.delete_setting(key)
        return
    if key in LIST_SETTING_KEYS:
        if not isinstance(value, list) or not all(
            isinstance(item, str) for item in value
        ):
            raise _bad_value(key, "must be a list of strings")
        await store.set_setting(key, json.dumps(value))
        return
    text = _require_str(key, value)
    if key == "theme" and text not in THEMES:
        raise _bad_value(key, f"must be one of: {', '.join(THEMES)}")
    # Custom profiles make any non-empty id legal; unknown resolves to manual.
    if key == "permission_profile" and not text.strip():
        raise _bad_value(key, "must be a non-empty tool profile id")
    if key in MODEL_SPEC_KEYS:
        _validate_model_spec(key, text)
    await store.set_setting(key, text)


def _provider_out(provider: str) -> ProviderOut:
    """Credential status for one provider — key presence and origin only."""
    source = secret_source(PROVIDER_KEY_NAMES[provider])
    has_key = source is not None
    if provider == "google-cloud" and not has_key and _has_google_adc():
        # Vertex can run on Application Default Credentials with no API key.
        has_key, source = True, "env"
    return ProviderOut(
        provider=provider,
        configured=provider in configured_providers(),
        has_key=has_key,
        source=source,
    )


def _has_google_adc() -> bool:
    """Whether Google Application Default Credentials are configured via env."""
    return bool(
        os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        or os.environ.get("GOOGLE_CLOUD_PROJECT")
    )


def _require_known_provider(provider: str) -> None:
    """400 when ``provider`` isn't a registry prefix."""
    if provider not in KNOWN_PROVIDERS:
        known = ", ".join(KNOWN_PROVIDERS)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown provider {provider!r}; expected one of: {known}",
        )


def _clean(value: str | None) -> str | None:
    """Strip a secret input; blank or missing reads as absent."""
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _require_str(key: str, value: Any) -> str:
    """Narrow a single-key PUT value to ``str``, or a 400."""
    if not isinstance(value, str):
        raise _bad_value(key, "must be a string")
    return value


def _validate_model_spec(key: str, value: str) -> None:
    """400 unless ``value`` is a ``provider:model`` spec with a known prefix."""
    provider, sep, model_name = value.partition(":")
    if not sep or not model_name or provider not in KNOWN_PROVIDERS:
        known = ", ".join(KNOWN_PROVIDERS)
        raise _bad_value(
            key,
            f"must be a 'provider:model' spec with a known provider "
            f"({known}); got {value!r}",
        )


def _validate_base_url(key: str, value: str) -> str:
    """400 unless ``value`` is an http(s) URL; returns the stripped value."""
    stripped = value.strip()
    if not stripped.startswith(("http://", "https://")):
        raise _bad_value(key, f"must be an http(s) URL; got {value!r}")
    return stripped


def _bad_value(key: str, why: str) -> HTTPException:
    """A 400 describing why a settings value was rejected."""
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"{key} {why}")
