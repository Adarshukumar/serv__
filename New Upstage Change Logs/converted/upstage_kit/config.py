"""
config.py — endpoints, models registry, constants.

Everything that was hardcoded in the original v3 provider now resolves
at CALL time from environment variables, so the same code can talk to:

  * the real Upstage console/API   (defaults), or
  * any compatible mock / staging  (UPSTAGE_CONSOLE_URL, UPSTAGE_API_BASE)

No other module may hardcode hosts.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Optional

# ── endpoints (env-overridable, resolved per call) ──────────────
def console_url() -> str:
    """e.g. https://console.upstage.ai  (or http://127.0.0.1:8485 for mock)"""
    return os.getenv("UPSTAGE_CONSOLE_URL", "https://console.upstage.ai").rstrip("/")


def api_base() -> str:
    return os.getenv("UPSTAGE_API_BASE", "https://ap-northeast-2.apistage.ai").rstrip("/")


def chat_path() -> str:
    return "/playground/chat"


def completions_url() -> str:
    return f"{api_base()}/v1/web/demo/chat/completions?include_think=true"


def cred_file() -> Path:
    """Resolved at call time so UPSTAGE_CACHE_DIR can change post-import."""
    return Path(os.getenv("UPSTAGE_CACHE_DIR", "/tmp/.cache/upstage")) / "upstage_creds.json"


# ── HTTP constants ──────────────────────────────────────────────
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/146.0.0.0 Safari/537.36"
)
UA_HEADERS = {"User-Agent": UA}

# Action names embedded in the console's client JS bundles
# (stable across redeploys — only the 42-hex ids change).
ACTION_TOKEN = "getConsoleCsrfToken"
ACTION_INIT = "authAction"

MAX_CHUNK_SCAN = 80

CONNECT_TIMEOUT = 15
STREAM_TIMEOUT = 300   # 5-minute envelope for long generations


# ── model registry ──────────────────────────────────────────────
MODELS: Dict[str, Dict[str, Any]] = {
    "solar-pro3": {
        "reasoning":   ["low", "medium", "high"],
        "search":      True,
        "system":      "",
        "temperature": 0.8,
        "max_tokens":  65536,
        "metadata":    None,
    },
    "solar-pro2": {
        "reasoning":   ["low", "high"],
        "search":      True,
        "system":      "",
        "temperature": 0.8,
        "max_tokens":  16383,
        "metadata":    None,
    },
    "syn-pro": {
        "reasoning":   ["low", "high"],
        "search":      True,
        "system":      "",
        "temperature": 0.7,
        "max_tokens":  16384,
        "metadata":    {
            "helpfulness": 4, "correctness": 4, "coherence": 4,
            "complexity": 4, "verbosity": 4, "quality": 4,
            "toxicity": 0, "humor": 0, "creativity": 0,
        },
    },
    "upstage/solar-1-mini-chat": {
        "reasoning":   None,
        "search":      True,
        "system":      "",
        "temperature": 0.8,
        "max_tokens":  16383,
        "metadata":    None,
    },
}

MODEL_ALIASES: Dict[str, str] = {
    "solar-pro3": "solar-pro3", "solar-pro2": "solar-pro2",
    "syn-pro": "syn-pro",
    "solar-1-mini-chat": "upstage/solar-1-mini-chat",
    "upstage/solar-1-mini-chat": "upstage/solar-1-mini-chat",
    "solar3": "solar-pro3", "solar2": "solar-pro2",
    "pro3": "solar-pro3", "pro2": "solar-pro2",
    "syn": "syn-pro", "mini": "upstage/solar-1-mini-chat",
}


def resolve_model(val: Optional[str]) -> str:
    if not val:
        return "solar-pro3"
    v = val.lower().strip()
    if v in MODEL_ALIASES:
        return MODEL_ALIASES[v]
    if v in MODELS:
        return v
    for name in MODELS:
        if v in name.lower():
            return name
    return val
