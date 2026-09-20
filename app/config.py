"""
═══ §1 — CONFIG ════════════════════════════════════════════════════════════
Every knob lives here. Nothing else in the codebase reads os.environ.

This is the whole config surface of the app. The old server scattered
os.getenv() across six files; here it is in one place so you can audit
what the process is actually allowed to do.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # repo root (app/ sits inside it)
WEB_DIR = ROOT / "web"


def _env(key: str, default: str = "") -> str:
    """
    UNSET → default.  SET-BUT-EMPTY → empty, on purpose.

    The previous version treated `TRUSTED_PROXIES=` the same as leaving it out,
    so the documented way to disable proxy trust silently re-enabled it. For a
    security flag, "I turned this off" must never mean "this stayed on".
    """
    val = os.getenv(key)
    return default if val is None else val


def _int(key: str, default: int) -> int:
    try:
        return int(_env(key, str(default)))
    except ValueError:
        return default


def _bool(key: str, default: bool) -> bool:
    raw = _env(key, "1" if default else "0").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _csv(key: str, default: str) -> list[str]:
    return [p.strip() for p in _env(key, default).split(",") if p.strip()]


@dataclass(frozen=True)
class Settings:
    # ── upstream (the real Inception chat API) ──────────────────────────
    base_url: str = field(default_factory=lambda: _env(
        "INCEPTION_BASE_URL", "https://chat.inceptionlabs.ai"
    ).rstrip("/"))
    chat_endpoint: str = "/api/chat"
    session_endpoint: str = "/api/session"
    model_name: str = field(default_factory=lambda: _env("MODEL_NAME", "mercury"))
    # reasoning | low | medium | high — passed straight through upstream
    reasoning_effort: str = field(default_factory=lambda: _env("REASONING_EFFORT", "high"))

    # ── connection ──────────────────────────────────────────────────────
    # Deliberately NO proxy. Requests go directly to base_url.
    request_timeout: int = field(default_factory=lambda: _int("UPSTREAM_TIMEOUT", 180))
    connect_timeout: int = field(default_factory=lambda: _int("UPSTREAM_CONNECT_TIMEOUT", 20))
    max_connections: int = field(default_factory=lambda: _int("UPSTREAM_MAX_CONNECTIONS", 32))

    # ── client IP forwarding (see app/client_ip.py for the honesty rules) ─
    forward_client_ip: bool = field(default_factory=lambda: _bool("FORWARD_CLIENT_IP", True))
    # Only these socket peers may tell us who the client was.
    trusted_proxies: list[str] = field(default_factory=lambda: _csv(
        "TRUSTED_PROXIES", "127.0.0.1,::1"
    ))
    trust_all_proxies: bool = field(default_factory=lambda: _bool("TRUST_ALL_PROXIES", False))
    forwarded_for: bool = field(default_factory=lambda: _bool("XFF_FORWARDED", True))

    # ── per-user limits on OUR side ──────────────────────────────────────
    rate_limit_requests: int = field(default_factory=lambda: _int("RATE_LIMIT_REQUESTS", 20))
    rate_limit_window: int = field(default_factory=lambda: _int("RATE_LIMIT_WINDOW", 60))
    max_concurrency: int = field(default_factory=lambda: _int("MAX_CONCURRENCY", 8))
    session_ttl: int = field(default_factory=lambda: _int("SESSION_TTL", 3600))
    max_history_turns: int = field(default_factory=lambda: _int("MAX_HISTORY_TURNS", 20))

    # ── session token cache (in-memory only, never written to disk) ──────
    token_ttl: int = field(default_factory=lambda: _int("TOKEN_TTL", 3600))
    auto_refresh: bool = field(default_factory=lambda: _bool("TOKEN_AUTO_REFRESH", False))
    refresh_interval: int = field(default_factory=lambda: _int("TOKEN_REFRESH_INTERVAL", 900))

    # ── Hugging Face Spaces hardening ─────────────────────────────────────
    # HF's proxy requires a recognised Host header, otherwise it answers
    # "The connection was not made to a recognised domain". Rejecting unknown
    # hosts also blocks the request-routing attack that plain bind-to-0.0.0.0
    # servers are vulnerable to.
    allowed_hosts_extra: list[str] = field(default_factory=lambda: _csv(
        "ALLOWED_HOSTS", ""
    ))
    host_guard: bool = field(default_factory=lambda: _bool("HOST_GUARD", "1"))

    # ── misc ──────────────────────────────────────────────────────────────
    system_prompt: str = field(default_factory=lambda: _env(
        "SYSTEM_PROMPT", "You are a helpful, precise assistant."
    ))
    enable_search: bool = field(default_factory=lambda: _bool("ENABLE_WEB_SEARCH", False))
    log_level: str = field(default_factory=lambda: _env("LOG_LEVEL", "info"))
    port: int = field(default_factory=lambda: _int("PORT", 7860))
    host: str = field(default_factory=lambda: _env("HOST", "0.0.0.0"))

    @property
    def is_local_upstream(self) -> bool:
        """True when upstream points at localhost — used by the smoke test."""
        return any(h in self.base_url for h in ("127.0.0.1", "localhost", "0.0.0.0"))


settings = Settings()


def banner() -> str:
    s = settings
    fwd = "ON  (X-Forwarded-For + Forwarded)" if s.forward_client_ip else "OFF"
    proxies = ", ".join(s.trusted_proxies) if s.trusted_proxies else "(none — socket peer only)"
    if s.trust_all_proxies:
        proxies = "⚠ TRUST ALL — any client can claim any IP"
    return (
        f"upstream   : {s.base_url}\n"
        f"proxy      : none (direct)\n"
        f"ip forward : {fwd}\n"
        f"trust      : {proxies}\n"
        f"limits     : {s.rate_limit_requests} req/{s.rate_limit_window}s, "
        f"concurrency {s.max_concurrency}\n"
        f"timeout    : read {s.request_timeout}s / connect {s.connect_timeout}s"
    )
