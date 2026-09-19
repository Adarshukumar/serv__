from fastapi import APIRouter, Request, Depends, HTTPException, Header
from ..config import ADMIN_API_KEY

router = APIRouter()

def _check_admin(x_admin_key: str = Header(None), authorization: str = Header(None)):
    if not ADMIN_API_KEY:
        return True
    key = x_admin_key or (authorization.replace("Bearer ", "") if authorization else "")
    if key != ADMIN_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid admin key")
    return True

@router.get("/v1/admin/stats")
async def admin_stats(request: Request, _=Depends(_check_admin)):
    mgr = getattr(request.app.state, "provider_manager", None)
    store = getattr(request.app.state, "session_store", None)
    return {
        "provider_manager": mgr.stats() if mgr else {},
        "sessions": store.stats_sync() if store else {},
        "search": "AUTO (no manual, nice SSE event: sources)",
        "server": {
            "max_concurrency": request.app.state.server_semaphore._value if hasattr(request.app.state.server_semaphore, "_value") else "unknown",
        },
    }

@router.post("/v1/admin/search/clear-cache")
async def clear_search_cache(request: Request, _=Depends(_check_admin)):
    return {"cleared": True, "note": "Search AUTO, no cache"}

@router.post("/v1/admin/sessions/clear")
async def clear_sessions(request: Request, _=Depends(_check_admin)):
    store = request.app.state.session_store
    await store.clear()
    return {"cleared": True}

@router.post("/v1/admin/sessions/prune")
async def prune_sessions(request: Request, _=Depends(_check_admin)):
    store = request.app.state.session_store
    n = await store.prune_expired()
    return {"pruned": n}

@router.get("/v1/admin/providers/health")
async def providers_health(request: Request, _=Depends(_check_admin)):
    mgr = getattr(request.app.state, "provider_manager", None)
    if not mgr:
        return {"error": "No provider manager"}
    results = {}
    for name in ["ragsrv", "deepinfra", "mcloudflare", "upstage"]:
        try:
            cls = mgr.registry._class_for_provider(name)
            inst = cls()
            if hasattr(inst, "health_check"):
                results[name] = await inst.health_check()
            else:
                results[name] = {"ok": True, "provider": name}
        except Exception as e:
            results[name] = {"ok": False, "error": str(e)[:300]}
    return results
