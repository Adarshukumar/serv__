"""
ADU-Headless Server v3 — Provider-based, Non-laggy, Zero API dep, Auto Search, Nice SSE
- Search AUTO — like inception.py and upstage, no Tavily, no manual toggle
- Nice SSE: event: sources/thinking/content/done + data: {...} + data: [DONE]
- OpenAI compat: data: {choices: [{delta: {content}}]} + data: [DONE]
- Provider + Model architecture, sharded stores, secured, hacked & fixed 20+ times
"""
from __future__ import annotations
import asyncio
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from .config import (
    SERVER_MAX_CONCURRENCY, SESSION_SHARDS, SESSION_TTL,
    PROVIDER_CONCURRENCY, RAGSRV_CONCURRENCY,
    IP_RPM, GLOBAL_RPM,
    ALLOWED_ORIGINS, ADMIN_API_KEY,
    UI_DIR,
)
from .core.session import SessionStore
from .core.rate_limiter import ShardedIPRateLimiter, ProviderRateLimiter, CircuitBreaker
from .core.ip_extractor import get_real_client_ip_from_headers, pseudonymize_ip
from .core.security import sanitize_for_log
from .providers.registry import global_registry

class ProviderManager:
    def __init__(self):
        self.registry = global_registry
        self.semaphores: dict[str, asyncio.Semaphore] = {}
        self.breakers: dict[str, CircuitBreaker] = {}
        self.request_counts: dict[str, int] = {}
        self.failure_counts: dict[str, int] = {}
        self._init_semaphores()

    def _init_semaphores(self):
        for prov in self.registry.all_providers():
            conc = RAGSRV_CONCURRENCY if prov.name == "ragsrv" else PROVIDER_CONCURRENCY
            self.semaphores[prov.name] = asyncio.Semaphore(conc)
            self.breakers[prov.name] = CircuitBreaker(fail_threshold=3, cooldown_s=60)
            self.request_counts[prov.name] = 0
            self.failure_counts[prov.name] = 0

    def stats(self):
        return {
            "providers": {
                name: {
                    "concurrency": sem._value if hasattr(sem, "_value") else "?",
                    "requests": self.request_counts.get(name, 0),
                    "failures": self.failure_counts.get(name, 0),
                    "breaker": self.breakers[name].stats() if name in self.breakers else {},
                }
                for name, sem in self.semaphores.items()
            }
        }

    async def stream(self, provider: str, model: str, data=None, messages=None, system=None, user_ip=None, temperature=0.7, max_tokens=2048):
        provider = (provider or "ragsrv").lower().strip()
        if provider not in self.semaphores:
            provider = "ragsrv"

        breaker = self.breakers.get(provider)
        if breaker and not breaker.can_try_sync():
            print(f"[ProviderManager] Breaker open for {provider}, fallback to ragsrv")
            provider = "ragsrv"
            breaker = self.breakers.get(provider)

        sem = self.semaphores.get(provider, self.semaphores.get("ragsrv"))
        if not sem:
            sem = asyncio.Semaphore(RAGSRV_CONCURRENCY)

        self.request_counts[provider] = self.request_counts.get(provider, 0) + 1

        async with sem:
            try:
                cls = self.registry._class_for_provider(provider)
                inst = cls(model=model, system=system, client_ip=user_ip, temperature=temperature, max_tokens=max_tokens)
                async for ev in inst.stream(data=data, messages=messages, model=model, system=system, user_ip=user_ip, temperature=temperature, max_tokens=max_tokens):
                    yield ev
                if breaker:
                    breaker.record_success_sync()
            except Exception as e:
                self.failure_counts[provider] = self.failure_counts.get(provider, 0) + 1
                if breaker:
                    breaker.record_failure_sync()
                print(f"[ProviderManager] {provider}/{model} failed: {e}")
                if provider != "ragsrv":
                    print(f"[ProviderManager] Fallback to ragsrv for {model}")
                    try:
                        from .providers.ragsrv import RAGSrvProvider
                        fallback = RAGSrvProvider(model=model, system=system, client_ip=user_ip, temperature=temperature, max_tokens=max_tokens)
                        async for ev in fallback.stream(data=data, messages=messages, model=model, system=system, user_ip=user_ip, temperature=temperature, max_tokens=max_tokens):
                            yield ev
                        self.breakers["ragsrv"].record_success_sync()
                        return
                    except Exception as fe:
                        print(f"[ProviderManager] Fallback also failed: {fe}")
                        self.failure_counts["ragsrv"] = self.failure_counts.get("ragsrv", 0) + 1
                        self.breakers["ragsrv"].record_failure_sync()
                raise

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.session_store = SessionStore(shards=SESSION_SHARDS, ttl=SESSION_TTL)
    app.state.ip_limiter = ShardedIPRateLimiter(rpm=IP_RPM, shards=16)
    app.state.global_limiter = ProviderRateLimiter(rpm=GLOBAL_RPM)
    app.state.provider_manager = ProviderManager()
    app.state.server_semaphore = asyncio.Semaphore(SERVER_MAX_CONCURRENCY)
    app.state.start_time = time.time()

    async def _prune_loop():
        while True:
            await asyncio.sleep(300)
            try:
                n = await app.state.session_store.prune_expired()
                if n:
                    print(f"[Prune] Removed {n} expired sessions")
            except Exception as e:
                print(f"[Prune] Error: {e}")

    prune_task = asyncio.create_task(_prune_loop())
    print(f"[Server v3] Started — providers={len(global_registry.all_providers())} models={len(global_registry.all_models())} max_conc={SERVER_MAX_CONCURRENCY} shards={SESSION_SHARDS} search=AUTO niceSSE")
    yield
    prune_task.cancel()
    try:
        await prune_task
    except asyncio.CancelledError:
        pass

app = FastAPI(
    title="ADU-Headless Server v3",
    description="Provider-based, non-laggy, zero API dep, auto search (inception.py/upstage style), nice SSE, hacked & fixed 20+ times",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def client_ip_middleware(request: Request, call_next):
    headers = dict(request.headers)
    client_host = request.client.host if request.client else "unknown"
    real_ip = get_real_client_ip_from_headers(headers, client_host=client_host)
    request.state.client_ip = real_ip
    request.state.client_ip_pseudo = pseudonymize_ip(real_ip)

    # IP rate limit — exempt hack, health, docs, ui, providers, models
    exempt_paths = ("/v1/hack", "/health", "/docs", "/openapi.json", "/ui", "/", "/v1/providers", "/v1/models", "/v1/admin")
    is_exempt = any(request.url.path.startswith(p) for p in exempt_paths)

    ip_limiter: ShardedIPRateLimiter = getattr(request.app.state, "ip_limiter", None)
    if ip_limiter and request.url.path.startswith("/v1/") and not is_exempt:
        try:
            res = ip_limiter.is_allowed_sync(real_ip)
            allowed = res[0] if isinstance(res, tuple) else res
            if not allowed:
                return JSONResponse(status_code=429, content={"error": "Rate limit exceeded", "retry_after": 60})
        except Exception:
            pass

    global_limiter = getattr(request.app.state, "global_limiter", None)
    if global_limiter and request.url.path.startswith("/v1/chat") and not is_exempt:
        try:
            g_res = await global_limiter.is_allowed("global")
            g_allowed = g_res[0] if isinstance(g_res, tuple) else g_res
            if not g_allowed:
                return JSONResponse(status_code=429, content={"error": "Global rate limit exceeded"})
        except Exception:
            pass

    start = time.time()
    response = await call_next(request)
    elapsed = time.time() - start
    if not request.url.path.endswith("/health") and not request.url.path == "/":
        print(f"[{request.method}] {request.url.path} ip={sanitize_for_log(request.state.client_ip_pseudo)} elapsed={elapsed:.3f}s status={response.status_code}")
    return response

from .api import health, models, providers, chat, users, admin, hack, experimental

app.include_router(health.router)
app.include_router(models.router)
app.include_router(providers.router)
app.include_router(chat.router)
app.include_router(users.router)
app.include_router(admin.router)
app.include_router(hack.router)
app.include_router(experimental.router)

@app.get("/")
async def root():
    ui_index = Path(__file__).parent.parent / "ui" / "index.html"
    if ui_index.exists():
        return FileResponse(str(ui_index))
    return {
        "name": "ADU-Headless Server v3",
        "version": "3.0.0",
        "search": "AUTO (like inception.py/upstage, no Tavily, nice SSE)",
        "providers": len(global_registry.all_providers()),
        "models": len(global_registry.all_models()),
        "docs": "/docs",
        "health": "/health",
        "models_api": "/v1/models",
        "providers_api": "/v1/providers",
        "chat_api": "/v1/chat/completions (OpenAI compat nice SSE) + /v1/chat (native nice SSE event: sources/thinking/content/done)",
        "loadtest_api": "/v1/users/loadtest",
    }

try:
    ui_dir = Path(__file__).parent.parent / "ui"
    if ui_dir.exists() and (ui_dir / "index.html").exists():
        app.mount("/ui", StaticFiles(directory=str(ui_dir), html=True), name="ui")
except Exception:
    pass
