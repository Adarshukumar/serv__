from fastapi import APIRouter, Request
from ..config import SERVER_MAX_CONCURRENCY, SESSION_SHARDS, PROVIDER_CONCURRENCY, RAGSRV_CONCURRENCY
from ..providers.registry import global_registry
import time

router = APIRouter()
_start = time.time()

@router.get("/health")
@router.get("/v1/health")
async def health(request: Request):
    mgr = getattr(request.app.state, "provider_manager", None)
    mgr_stats = mgr.stats() if mgr else {}
    session_store = getattr(request.app.state, "session_store", None)
    try:
        sess_stats = session_store.stats_sync() if session_store else {}
    except:
        sess_stats = {}

    return {
        "ok": True,
        "uptime_s": round(time.time() - _start, 1),
        "version": "v3-auto-search-nice-sse",
        "search": "AUTO (inception.py/upstage style, no Tavily, nice SSE event: sources/thinking/content/done)",
        "architecture": {
            "providers": len(global_registry.all_providers()),
            "models": len(global_registry.all_models()),
            "server_max_concurrency": SERVER_MAX_CONCURRENCY,
            "session_shards": SESSION_SHARDS,
            "provider_concurrency": PROVIDER_CONCURRENCY,
            "ragsrv_concurrency": RAGSRV_CONCURRENCY,
        },
        "sessions": sess_stats,
        "provider_manager": mgr_stats,
    }
