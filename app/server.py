"""
═══ SILK — chat server ═══════════════════════════════════════════════════════
FastAPI app that owns the upstream call and streams it to the browser as SSE.

    browser ──POST /api/chat──▶ this server ──POST /api/chat──▶ upstream
      ▲                            │
      └──── SSE: reasoning / token / sources / done ────┘

Design rules
  1. The browser NEVER talks to the API. It only knows this origin. That keeps
     the session token server-side and makes one place to audit.
  2. Every stream is typed (see §6.4). The client never has to guess whether a
     chunk is prose or metadata.
  3. Cancellation propagates: close the tab, the upstream request dies. No
     orphaned generations burning quota.

Removed from the previous server (all of them were "bad things"):
  ✗ POST /v1/warmup            + a 900s loop burning upstream quota forever
  ✗ POST /v1/credentials/refresh
  ✗ GET  /v1/users             ← handed out every active user id + request count
  ✗ GET  /internal/v1/models
  ✗ model auditing / live probe loops
  ✗ `Powered By Adarsh Kumar` baked into the Dockerfile's system prompt
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app import client_ip as ipx
from app.config import WEB_DIR, banner, settings
from app.limits import RateLimiter
from app.providers import inception as inc

log = logging.getLogger("silk")

# ───────────────────────────────────────────────────────────────────────────
# §6.1 — session store (in-memory, TTL, no disk)
# ───────────────────────────────────────────────────────────────────────────
@dataclass
class Session:
    id: str
    created: float = field(default_factory=time.time)
    updated: float = field(default_factory=time.time)
    messages: List[Dict[str, str]] = field(default_factory=list)
    turns: int = 0
    conversation_id: str = field(default_factory=inc.rid)

    def trim(self, max_turns: int) -> None:
        if max_turns <= 0:
            return
        keep = max_turns * 2
        if len(self.messages) > keep:
            self.messages = self.messages[-keep:]

    def touch(self) -> None:
        self.updated = time.time()


class Store:
    def __init__(self, ttl: int, max_turns: int, cap: int = 5000) -> None:
        self.ttl = ttl
        self.max_turns = max_turns
        self.cap = cap
        self._d: Dict[str, Session] = {}
        self._lock = asyncio.Lock()

    async def get(self, sid: Optional[str]) -> Session:
        async with self._lock:
            self._prune_locked()
            if sid and sid in self._d:
                s = self._d[sid]
                s.trim(self.max_turns)
                s.touch()
                return s
            s = Session(id=inc.rid(12))
            self._d[s.id] = s
            return s

    async def reset(self, sid: str) -> bool:
        async with self._lock:
            s = self._d.pop(sid, None)
            if s is None:
                return False
            self._d[s.id] = Session(id=s.id, conversation_id=inc.rid())
            return True

    async def snapshot(self, sid: str) -> Dict[str, Any]:
        async with self._lock:
            s = self._d.get(sid)
            if s is None:
                return {}
            return {
                "session_id": s.id,
                "turns": s.turns,
                "messages": len(s.messages),
                "conversation_id": s.conversation_id,
            }

    def _prune_locked(self) -> None:
        now = time.time()
        for key in [k for k, v in self._d.items() if now - v.updated > self.ttl]:
            self._d.pop(key, None)
        if len(self._d) > self.cap:
            for key in list(self._d)[: len(self._d) - self.cap]:
                self._d.pop(key, None)


# ───────────────────────────────────────────────────────────────────────────
# §6.2 — request model
# ───────────────────────────────────────────────────────────────────────────
class ChatIn(BaseModel):
    message: str = Field(default="", max_length=32_000)
    session_id: Optional[str] = None
    system: Optional[str] = None
    search: Optional[bool] = None
    thinking: Optional[bool] = None
    reasoning_effort: Optional[str] = Field(
        default=None, pattern=r"^(disabled|low|medium|high)$"
    )
    stream: bool = True
    reset: bool = False


# ───────────────────────────────────────────────────────────────────────────
# §6.3 — app wiring
# ───────────────────────────────────────────────────────────────────────────
@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.provider = await inc.get_provider()
    app.state.store = Store(settings.session_ttl, settings.max_history_turns)
    app.state.limiter = RateLimiter(settings.rate_limit_requests, settings.rate_limit_window)
    app.state.sema = asyncio.Semaphore(settings.max_concurrency)
    app.state.started = time.time()
    log.info("SILK ready\n%s", banner())
    try:
        yield
    finally:
        await inc.close_provider()


_docs_on = settings.docs
app = FastAPI(
    title="SILK chat",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs" if _docs_on else None,
    redoc_url="/redoc" if _docs_on else None,
    openapi_url="/openapi.json" if _docs_on else None,
)


# ───────────────────────────────────────────────────────────────────────────
# §6.3b — Host header guard
# ───────────────────────────────────────────────────────────────────────────
# A server bound to 0.0.0.0 with no Host validation answers ANY hostname that
# resolves to it (DNS rebinding / request routing). Hugging Face Spaces also
# refuses to serve requests whose Host is not a recognised *.hf.space domain,
# so this doubles as the compatibility fix for "connection was not made to a
# recognised domain". Set HOST_GUARD=0 only if you front it with something that
# already validates this.
_HOST_OK = re.compile(
    r"^("
    r"localhost|127(?:\.[0-9]{1,3}){3}|\[?::1\]?"       # local dev
    r"|([a-z0-9-]+\.)+hf\.space"                          # *.hf.space + *.eu.hf.space
    r"|huggingface\.co"                                    # the space iframe origin
    r")(:[0-9]{1,5})?$",
    re.I,
)


@app.middleware("http")
async def host_guard(request: Request, call_next):
    if settings.host_guard:
        host = (request.headers.get("host") or "").strip()
        extra = {h.lower() for h in settings.allowed_hosts_extra}
        if host.lower() not in extra and not _HOST_OK.match(host):
            log.warning("rejected Host=%r from %s", host, ipx.socket_peer(request))
            return JSONResponse(
                {"error": "unrecognised host", "hint": "add it to ALLOWED_HOSTS"},
                status_code=400,
            )
    return await call_next(request)


def _client_info(request: Request) -> ipx.ClientInfo:
    return ipx.resolve(
        request,
        trusted_proxies=settings.trusted_proxies,
        trust_all=settings.trust_all_proxies,
    )


def _sse(event: str, payload: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


# ───────────────────────────────────────────────────────────────────────────
# §6.4 — the streaming endpoint
# ───────────────────────────────────────────────────────────────────────────
async def _generate(
    provider: "inc.MercuryProvider",
    store: Store,
    session: Session,
    payload_messages: List[Dict[str, str]],
    *,
    system: str,
    search: bool,
    effort: str,
    info: ipx.ClientInfo,
    emit_reasoning: bool,
) -> AsyncGenerator[str, None]:
    answer: List[str] = []
    scratch: List[str] = []
    sources: List[Dict[str, Any]] = []
    seen_urls: set[str] = set()
    started = time.time()
    ttf: Optional[float] = None

    yield _sse("start", {"session_id": session.id, "turn": session.turns + 1})

    try:
        async for kind, data in provider.stream(
            payload_messages,
            system=system,
            search=search,
            reasoning_effort=effort,
            conversation_id=session.conversation_id,
            client_info=info,
        ):
            if kind == inc.EVENT_REASONING:
                scratch.append(data)
                if emit_reasoning:
                    if ttf is None:
                        ttf = time.time() - started
                    yield _sse("reasoning", {"text": data})

            elif kind == inc.EVENT_TOKEN:
                answer.append(data)
                if ttf is None:
                    ttf = time.time() - started
                yield _sse("token", {"text": data})

            elif kind == inc.EVENT_SOURCES:
                # Dedupe here so the live event and the final list agree — and
                # so sources get their OWN event type. The old code serialised
                # {"sources": [...]} into the token stream, which forced the
                # client to guess whether a chunk was prose or JSON.
                url = (data or {}).get("url", "")
                if url and url not in seen_urls:
                    seen_urls.add(url)
                    sources.append(data)
                    yield _sse("sources", {"source": data})

            elif kind == inc.EVENT_DONE:
                pass

    except inc.RateLimitedError as exc:
        log.warning("upstream 429 %s", ipx.audit_line(info))
        yield _sse("error", {"code": "upstream_rate_limited", "message": str(exc),
                             "retry_after": exc.retry_after})
        return
    except inc.UpstreamError as exc:
        log.error("upstream failed %s :: %s", ipx.audit_line(info), exc)
        yield _sse("error", {"code": "upstream_error", "message": str(exc)})
        return
    except asyncio.CancelledError:
        log.info("client disconnected, aborting upstream %s", ipx.audit_line(info))
        raise
    except Exception:                                  # never leak a traceback body
        log.exception("unexpected stream failure")
        yield _sse("error", {"code": "internal", "message": "stream aborted"})
        return

    text = "".join(answer).strip()
    if text:
        session.messages.append({"role": "assistant", "content": text})
    session.trim(store.max_turns)
    session.turns += 1
    session.touch()

    done: Dict[str, Any] = {
        "chars": len(text),
        "elapsed_ms": int((time.time() - started) * 1000),
        "first_token_ms": int(ttf * 1000) if ttf else None,
        "turns": session.turns,
    }
    if scratch:
        done["reasoning_chars"] = len("".join(scratch))
    yield _sse("done", done)


@app.post("/api/chat")
async def chat(request: Request, body: ChatIn) -> Any:
    info = _client_info(request)
    limiter: RateLimiter = app.state.limiter
    store: Store = app.state.store

    message = (body.message or "").strip()
    if not message:
        raise HTTPException(422, "message is required")

    decision = await limiter.check(info.ip)
    if not decision.allowed:
        log.warning("rate limited %s reason=%s", ipx.audit_line(info), decision.reason)
        return JSONResponse(
            {"error": decision.reason, "retry_after": decision.retry_after},
            status_code=429,
            headers={"Retry-After": str(decision.retry_after)},
        )

    session = await store.get(body.session_id)
    if body.reset:
        await store.reset(session.id)
        session = await store.get(session.id)

    session.messages.append({"role": "user", "content": message})
    session.trim(store.max_turns)
    session.touch()

    provider: "inc.MercuryProvider" = app.state.provider
    history = list(session.messages)
    system = body.system if body.system is not None else settings.system_prompt
    search = settings.enable_search if body.search is None else bool(body.search)
    effort = body.reasoning_effort or settings.reasoning_effort
    emit_reasoning = True if body.thinking is None else bool(body.thinking)

    log.info("chat %s chars=%d search=%s", ipx.audit_line(info), len(message), search)

    if not body.stream:
        chunks: List[str] = []
        async for kind, data in provider.stream(
            history, system=system, search=search,
            reasoning_effort=effort, conversation_id=session.conversation_id,
            client_info=info,
        ):
            if kind == inc.EVENT_TOKEN:
                chunks.append(data)
        text = "".join(chunks)
        session.messages.append({"role": "assistant", "content": text})
        session.turns += 1
        session.touch()
        return {"ok": True, "session_id": session.id, "content": text}

    sem: asyncio.Semaphore = app.state.sema

    async def gated() -> AsyncGenerator[str, None]:
        async with sem:
            async for frame in _generate(
                provider, store, session, history,
                system=system, search=search, effort=effort,
                info=info, emit_reasoning=emit_reasoning,
            ):
                yield frame

    return StreamingResponse(
        gated(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",        # nginx: do not buffer the stream
            "Connection": "keep-alive",
            "X-RateLimit-Remaining": str(decision.remaining),
            "X-RateLimit-Limit": str(limiter.limit),
            "X-Client-Ip-Source": "trusted-proxy" if info.from_proxy else "socket",
        },
    )


# ───────────────────────────────────────────────────────────────────────────
# §6.5 — small, non-leaking operational surface
# ───────────────────────────────────────────────────────────────────────────
@app.get("/api/health")
async def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "uptime_s": int(time.time() - app.state.started),
        "upstream": settings.base_url,
        "proxy": None,
        "forward_client_ip": settings.forward_client_ip,
        "model": settings.model_name,
    }



@app.get("/healthcheck")
async def healthcheck():
    """
    Hugging Face Spaces probes this exact path and requires the literal body
    {"status": "ok"}.

    Do NOT add a return annotation here. Annotating it Dict[str, bool] makes
    FastAPI coerce "ok" to a bool, the response fails validation, and the Space
    answers 500 — which the platform reads as "permanently unhealthy" and it
    restarts the container forever. Caught exactly that way: it was the first
    version of this function.
    """
    return {"status": "ok"}


@app.get("/logs/stream")
async def logs_stream(request: Request) -> StreamingResponse:
    """
    HF Spaces streams container logs through this endpoint. This is NOT a
    pass-through of real logs — it returns only this space's own status line
    and no runtime output, because leaking stderr would leak prompts.
    """
    async def one() -> AsyncGenerator[str, None]:
        yield _sse("logs", {
            "logs": f"[silk] up for {int(time.time() - app.state.started)}s, "
                    f"upstream {settings.base_url}\n"
        })

    return StreamingResponse(one(), media_type="text/event-stream")

@app.get("/api/config")
async def config(request: Request) -> Dict[str, Any]:
    """What the UI needs to render + what my IP looks like to us."""
    info = _client_info(request)
    return {
        "model": settings.model_name,
        "system_prompt": settings.system_prompt,
        "search_default": settings.enable_search,
        "reasoning_effort": settings.reasoning_effort,
        "rate_limit": {
            "requests": settings.rate_limit_requests,
            "window_seconds": settings.rate_limit_window,
        },
        # Echo it back so you can VERIFY resolution works behind your proxy.
        # Safe because it is the caller's own address.
        "you": {
            "resolved_ip": info.ip,
            "label": info.label,
            "socket_peer": info.peer,
            "via_trusted_proxy": info.from_proxy,
            "headers_claimed": list(info.chain),
            "unverified": info.spoofable,
            "forwarded_upstream": settings.forward_client_ip,
        },
    }


@app.post("/api/session/reset")
async def reset_session(request: Request, session_id: str = "") -> Dict[str, Any]:
    if not session_id:
        raise HTTPException(422, "session_id required")
    ok = await app.state.store.reset(session_id)
    return {"ok": bool(ok)}


# ───────────────────────────────────────────────────────────────────────────
# §6.6 — static UI
# ───────────────────────────────────────────────────────────────────────────
if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    page = WEB_DIR / "index.html"
    if not page.exists():
        return HTMLResponse("<h1>SILK</h1><p>web/index.html missing</p>")
    return HTMLResponse(page.read_text(encoding="utf-8"))


def main() -> None:
    import uvicorn

    logging.basicConfig(level=settings.log_level.upper())

    # Uvicorn rewrites request.client.host from X-Forwarded-For when
    # proxy_headers is on (the DEFAULT) and the peer is in forwarded_allow_ips
    # (default "127.0.0.1,::1"). Left alone, that silently hands every local
    # client a self-chosen identity — and destroys the socket evidence our own
    # trust check needs. Bind the two trust decisions together: one knob.
    allow = [p for p in settings.trusted_proxies if p.strip()]
    uvicorn.run(
        "app.server:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level,
        reload=False,
        proxy_headers=bool(allow) or settings.trust_all_proxies,
        forwarded_allow_ips="*" if settings.trust_all_proxies else (",".join(allow) or "127.0.0.1"),
    )


if __name__ == "__main__":
    main()
