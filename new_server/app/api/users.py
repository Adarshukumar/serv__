"""
Users loadtest — parallel N users via asyncio.gather, provider-based
Search is AUTO — no manual toggle
"""
from __future__ import annotations
import asyncio
import time
import random
import string
from typing import List, Dict

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..models.requests import LoadTestRequest
from ..providers.registry import global_registry
from ..core.security import sanitize_for_log

router = APIRouter()

def _rand_id(k=8):
    return "user-" + "".join(random.choices(string.ascii_lowercase + string.digits, k=k))

async def single_request(provider_mgr, provider: str, model: str, prompt: str, client_ip: str, user_idx: int):
    t0 = time.time()
    content_len = 0
    thinking_len = 0
    sources_found = 0
    error = None
    try:
        async for ev in provider_mgr.stream(
            provider=provider,
            model=model,
            data=prompt,
            system="You are a helpful assistant.",
            user_ip=client_ip,
            temperature=0.7,
            max_tokens=512,
        ):
            if ev.kind == "content":
                content_len += len(ev.text)
            elif ev.kind == "thinking":
                thinking_len += len(ev.text)
            elif ev.kind == "sources":
                sources_found = 1
    except Exception as e:
        error = str(e)[:200]

    elapsed = time.time() - t0
    tokens_est = max(1, (content_len + thinking_len)//4) if content_len or thinking_len else 0
    tps = tokens_est / elapsed if elapsed > 0 else 0

    return {
        "user_idx": user_idx,
        "ok": error is None and content_len > 0,
        "error": error,
        "elapsed_s": round(elapsed, 3),
        "content_chars": content_len,
        "thinking_chars": thinking_len,
        "tokens_est": tokens_est,
        "tokens_per_s": round(tps, 1),
        "sources": sources_found,
        "provider": provider,
        "model": model,
    }

@router.post("/v1/users/loadtest")
@router.post("/users/loadtest")
@router.post("/v1/users")
@router.post("/users")
async def loadtest(request: Request, body: LoadTestRequest):
    provider_mgr = request.app.state.provider_manager
    client_ip = getattr(request.state, "client_ip", "unknown")

    provider = body.provider or "ragsrv"
    if body.model:
        mi = global_registry.get(body.model)
        if mi:
            if not body.provider:
                provider = mi.provider
            model = mi.id
        else:
            model = body.model
    else:
        prov_info = global_registry.get_provider(provider)
        model = prov_info.models[0] if prov_info and prov_info.models else "luna"

    prompt = body.prompt
    n = body.n_users

    print(f"[LoadTest] {n} users provider={provider} model={model} parallel={body.parallel} ip={sanitize_for_log(client_ip)[:20]}")

    t0 = time.time()
    if body.parallel:
        tasks = [single_request(provider_mgr, provider, model, prompt, client_ip, i) for i in range(n)]
        results = await asyncio.gather(*tasks)
    else:
        results = []
        for i in range(n):
            r = await single_request(provider_mgr, provider, model, prompt, client_ip, i)
            results.append(r)

    total_elapsed = time.time() - t0
    ok_count = sum(1 for r in results if r["ok"])
    fail_count = n - ok_count
    avg_elapsed = sum(r["elapsed_s"] for r in results) / n if n else 0
    avg_tps = sum(r["tokens_per_s"] for r in results) / n if n else 0
    total_tokens = sum(r["tokens_est"] for r in results)

    return {
        "summary": {
            "n_users": n,
            "provider": provider,
            "model": model,
            "parallel": body.parallel,
            "ok": ok_count,
            "failed": fail_count,
            "success_rate": round(ok_count / n * 100, 1) if n else 0,
            "total_elapsed_s": round(total_elapsed, 3),
            "avg_elapsed_s": round(avg_elapsed, 3),
            "avg_tokens_per_s": round(avg_tps, 1),
            "total_tokens_est": total_tokens,
            "throughput_users_per_s": round(n / total_elapsed, 2) if total_elapsed > 0 else 0,
        },
        "results": results,
        "provider_manager": provider_mgr.stats(),
    }

@router.get("/v1/users/sessions")
async def list_sessions(request: Request):
    store = request.app.state.session_store
    try:
        sessions = store.all_sessions_sync()
        return {"count": len(sessions), "sessions": sessions[:100]}
    except Exception:
        data = await store.all_sessions()
        return {"count": data.get("total", 0), "sessions": data}

@router.delete("/v1/users/sessions/{session_id}")
async def delete_session(request: Request, session_id: str):
    store = request.app.state.session_store
    ok = await store.delete(session_id)
    return {"deleted": ok, "session_id": session_id}
