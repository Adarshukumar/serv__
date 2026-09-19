"""
Config — provider-based, no external API dependency
"""
from __future__ import annotations
import os
from pathlib import Path

# Server
SERVER_HOST = os.getenv("SERVER_HOST", "0.0.0.0")
SERVER_PORT = int(os.getenv("SERVER_PORT", "7860"))
SERVER_MAX_CONCURRENCY = int(os.getenv("SERVER_MAX_CONCURRENCY", "64"))  # increased from 32
SERVER_MAX_SESSIONS = int(os.getenv("SERVER_MAX_SESSIONS", "8192"))
SERVER_SESSION_TTL = int(os.getenv("SERVER_SESSION_TTL_SECONDS", "3600"))
SERVER_CLEANUP_INTERVAL = int(os.getenv("SERVER_CLEANUP_SECONDS", "120"))
SERVER_SESSION_SHARDS = int(os.getenv("SERVER_SESSION_SHARDS", "32"))  # increased from 16

# Provider concurrency — per provider
PROVIDER_CONCURRENCY = int(os.getenv("PROVIDER_CONCURRENCY", "10"))  # increased from 5
RAGSRV_CONCURRENCY = int(os.getenv("RAGSRV_CONCURRENCY", "50"))  # RAGSrv simulated can handle many

# Rate limits
IP_RPM = int(os.getenv("IP_RPM", "60"))  # increased from 30
MODEL_RPM = int(os.getenv("MODEL_RPM", "300"))
GLOBAL_RPM = int(os.getenv("GLOBAL_RPM", "1000"))

# Search
RAG_MAX_RESULTS = int(os.getenv("RAG_MAX_RESULTS", "5"))
SEARCH_CACHE_TTL = int(os.getenv("SEARCH_CACHE_TTL", "3600"))
SEARCH_TIMEOUT = int(os.getenv("SEARCH_TIMEOUT", "8"))
SEARCH_MAX_CONCURRENT = int(os.getenv("SEARCH_MAX_CONCURRENT", "10"))

# Default
DEFAULT_PROVIDER = os.getenv("DEFAULT_PROVIDER", "ragsrv")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "luna")
DEFAULT_SYSTEM = os.getenv("SERVER_SYSTEM_PROMPT", "You are a helpful, fast, and precise assistant.")

# Security
MAX_PROMPT_LENGTH = int(os.getenv("MAX_PROMPT_LENGTH", "8000"))
MAX_MESSAGES = int(os.getenv("MAX_MESSAGES", "50"))

# Paths
ROOT_DIR = Path(__file__).resolve().parent.parent
UI_DIR = ROOT_DIR / "ui"

# Provider flags — all optional, RAGSrv always works without any API
ENABLE_DEEPINFRA = os.getenv("ENABLE_DEEPINFRA", "1") == "1"
ENABLE_MCLOUDFLARE = os.getenv("ENABLE_MCLOUDFLARE", "1") == "1"
ENABLE_UPSTAGE = os.getenv("ENABLE_UPSTAGE", "1") == "1"
ENABLE_RAGSRV = True  # always enabled, no API dependency

# Aliases for main.py compat
SESSION_SHARDS = SERVER_SESSION_SHARDS
SESSION_TTL = SERVER_SESSION_TTL

# Cloudflare official
CF_ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID", "")
CF_API_TOKEN = os.getenv("CF_API_TOKEN", "")

# RAGSrv upstream (optional proxy)
RAGSRV_UPSTREAM_BASE = os.getenv("RAGSRV_UPSTREAM_BASE", "")

# CORS
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*").split(",") if os.getenv("ALLOWED_ORIGINS") else ["*"]

# Admin
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY", "")
