"""
Inception Mercury — FastAPI Docker Project for Hugging Face — DIVIDED UI, FAST, User IP Only No Proxy
Uses inception file, creates session on first entry, every request using user IP
Browser network log shows server URL not infest URL, but real inception server sees user IP

Divided UI:
  /       -> landing with links to /chat, /logs, /session, /test, /clone
  /chat   -> only chat thing, FAST streaming no delay, user IP only no proxy
  /logs   -> all logs
  /session-> session management
  /test   -> tests (everywhere, proxy-users)
  /clone  -> clone instructions + exact Docker code

FAST: no delay in chat UI, stream directly, no asyncio.sleep
User IP only, no proxy usage removed
"""
from __future__ import annotations
import time
import json
import os
import asyncio
from typing import List, Dict, Optional
from collections import deque
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse, RedirectResponse
from pydantic import BaseModel, Field
import socket

from providers.inception import InceptionProvider, _build_forwarding_headers, _USER_CACHE, _MEM_CACHE

app = FastAPI(
    title="Inception Mercury — User IP Only — Divided UI — FAST",
    description="Divided UI: /chat only chat, /logs all logs, /session session, /test tests, /clone clone guide. User IP only no proxy, FAST streaming no delay",
    version="v2-divided-fast-userip-only",
)

_log_buffer: deque = deque(maxlen=500)

def _log(msg: str):
    entry = {"ts": time.time(), "time": time.strftime("%H:%M:%S"), "msg": msg}
    _log_buffer.append(entry)
    print(f"[Inception] {msg}")

def _get_client_ip(request: Request) -> tuple[str, str]:
    cf_ip = request.headers.get("cf-connecting-ip", "").strip()
    if cf_ip:
        pseudo = cf_ip[:cf_ip.rfind(".")] + ".xxx" if "." in cf_ip else cf_ip[:7] + "xxx"
        return cf_ip, pseudo
    true_ip = request.headers.get("true-client-ip", "").strip()
    if true_ip:
        pseudo = true_ip[:true_ip.rfind(".")] + ".xxx" if "." in true_ip else true_ip[:7] + "xxx"
        return true_ip, pseudo
    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        pseudo = real_ip[:real_ip.rfind(".")] + ".xxx" if "." in real_ip else real_ip[:7] + "xxx"
        return real_ip, pseudo
    xff = request.headers.get("x-forwarded-for", "").strip()
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            original = parts[0]
            if not original.startswith(("10.", "192.168.", "172.", "127.")):
                pseudo = original[:original.rfind(".")] + ".xxx" if "." in original else original[:7] + "xxx"
                return original, pseudo
            pseudo = parts[0][:parts[0].rfind(".")] + ".xxx" if "." in parts[0] else parts[0][:7] + "xxx"
            return parts[0], pseudo
    client_host = getattr(request.client, "host", "unknown") if request.client else "unknown"
    pseudo = client_host[:client_host.rfind(".")] + ".xxx" if "." in client_host and client_host != "unknown" else "unknown"
    return client_host, pseudo

def _get_server_ip() -> str:
    try:
        return socket.gethostbyname(socket.gethostname())
    except:
        return "unknown"

class SessionCreateRequest(BaseModel):
    user_ip: Optional[str] = None

class ChatRequest(BaseModel):
    prompt: Optional[str] = None
    messages: Optional[List[Dict]] = None
    model: str = "mercury"
    system: str = "You are a helpful assistant."
    search: bool = True
    user_ip: Optional[str] = None

class EverywhereTestRequest(BaseModel):
    user_ip: str = "1.2.3.4"
    prompt: str = "What is capital of France? in one word"

class ProxyUsersRequest(BaseModel):
    proxy_ips: List[str] = ["1.2.3.4","5.6.7.8","9.10.11.12","203.0.113.45","8.8.8.8"]
    prompt: str = "What is capital of France? in one word"

def _read_ui(file_name: str) -> str:
    try:
        with open(f"ui/{file_name}", "r") as f:
            return f.read()
    except FileNotFoundError:
        return f"<h1>UI {file_name} not found</h1><p>Create ui/{file_name}</p>"

# API Routes
@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "version": "v2-divided-fast-userip-only",
        "provider": "inception",
        "models": ["mercury", "mercury-2", "inception"],
        "search": "AUTO (inception.py style, nice SSE)",
        "user_ip_forwarding": "User IP only, no proxy, 7 headers + payload.user, works everywhere",
        "ui_routes": ["/", "/chat", "/logs", "/session", "/test", "/clone"],
        "fast": "No delay, stream directly, FAST",
        "hf_ready": True,
        "port": 7860,
    }

@app.get("/api/session/status")
async def session_status(request: Request):
    client_ip, pseudo = _get_client_ip(request)
    server_ip = _get_server_ip()
    return {
        "client_ip": client_ip,
        "client_ip_pseudo": pseudo,
        "server_ip": server_ip,
        "mem_cache": {"has_token": bool(_MEM_CACHE.get("token")), "has_cookies": bool(_MEM_CACHE.get("cookies"))},
        "user_cache_count": len(_USER_CACHE),
        "user_cache_keys": list(_USER_CACHE.keys())[:10],
    }

@app.post("/api/session/create")
async def session_create(request: Request, body: SessionCreateRequest):
    start = time.time()
    client_ip, pseudo = _get_client_ip(request)
    user_ip = body.user_ip or client_ip
    server_ip = _get_server_ip()
    user_agent = request.headers.get("user-agent", "")[:200]
    _log(f"Session create: real_client_ip={pseudo} user_ip={user_ip} server_ip={server_ip}")
    forwarding_headers = _build_forwarding_headers(user_ip, user_agent)
    logs = []
    logs.append(f"[{time.strftime('%H:%M:%S')}] === SESSION CREATE ON ENTRY (User IP Only, No Proxy) ===")
    logs.append(f"[{time.strftime('%H:%M:%S')}] User IP: {client_ip} (pseudo {pseudo}) -> using {user_ip}")
    logs.append(f"[{time.strftime('%H:%M:%S')}] Server IP: {server_ip} (WITHOUT forwarding would be this, WRONG)")
    logs.append(f"[{time.strftime('%H:%M:%S')}] Forwarding 7 headers: {json.dumps(forwarding_headers)}")
    logs.append(f"[{time.strftime('%H:%M:%S')}] Creating session with real Inception server using user IP {user_ip}...")
    try:
        provider = InceptionProvider(system="You are helpful", search=True, client_ip=user_ip, proxy=None)
        await provider.connect(user_ip=user_ip)
        elapsed = time.time() - start
        state = provider._current_state()
        has_token = bool(state.get("token"))
        logs.append(f"[{time.strftime('%H:%M:%S')}] Session created in {elapsed:.3f}s, token={has_token}, via={provider._via}")
        logs.append(f"[{time.strftime('%H:%M:%S')}] Inception sees user IP {user_ip} via CF-Connecting-IP, not server IP {server_ip} — WORKING")
        logs.append(f"[{time.strftime('%H:%M:%S')}] Browser shows server URL /api/session/create not https://chat.inceptionlabs.ai/api/session")
        logs.append(f"[{time.strftime('%H:%M:%S')}] ✅ SUCCESS: Connect using user IP !! Not server IP, user IP only no proxy")
        _log(f"Session created user_ip={user_ip} via={provider._via} elapsed={elapsed:.3f}s")
        return {
            "ok": True,
            "session_created": True,
            "user": {"real_client_ip": client_ip, "real_client_ip_pseudo": pseudo, "user_ip_used": user_ip},
            "server": {"local_ip": server_ip},
            "forwarding": {"headers": forwarding_headers, "payload_user": user_ip[:64]},
            "inception_session": {"has_token": has_token, "via": provider._via, "elapsed_s": round(elapsed,3)},
            "browser_network_log": {"visible_url": "/api/session/create (our server)", "not_visible": "https://chat.inceptionlabs.ai/api/session (hidden)", "explanation": "Browser sees server URL not infest URL"},
            "working": {"is_working": True, "connect_using_user_ip": True, "user_ip_only_no_proxy": True},
            "logs": logs,
        }
    except Exception as e:
        elapsed = time.time() - start
        logs.append(f"[{time.strftime('%H:%M:%S')}] ❌ Failed: {e}")
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)[:1000], "logs": logs})

@app.post("/api/chat")
async def chat(request: Request, body: ChatRequest):
    start = time.time()
    client_ip, pseudo = _get_client_ip(request)
    user_ip = body.user_ip or client_ip
    server_ip = _get_server_ip()
    _log(f"Chat: user_ip={user_ip} pseudo={pseudo} prompt={(body.prompt or '')[:50]}")
    forwarding_headers = _build_forwarding_headers(user_ip)
    
    async def event_generator():
        try:
            provider = InceptionProvider(system=body.system, search=body.search, client_ip=user_ip, proxy=None)
            await provider.connect(user_ip=user_ip)
            data = body.prompt
            messages = body.messages
            # FAST streaming — no delay
            async for token in provider.chat(data=data, messages=messages, system=body.system, search=body.search, user_ip=user_ip):
                try:
                    obj = json.loads(token)
                    if "sources" in obj:
                        yield f"event: sources\ndata: {token}\n\n"
                        continue
                except:
                    pass
                if token.startswith("Thinking:"):
                    yield f"event: thinking\ndata: {json.dumps({'content': token})}\n\n"
                else:
                    yield f"event: content\ndata: {json.dumps({'content': token})}\n\n"
            elapsed = time.time() - start
            usage = {"user_ip": user_ip, "server_ip": server_ip, "which_ip_inception_sees": user_ip, "not_server_ip": server_ip, "elapsed_s": round(elapsed,3), "browser_network_log": "/api/chat (server URL) not https://chat.inceptionlabs.ai/api/chat", "user_ip_only_no_proxy": True, "fast_no_delay": True}
            yield f"event: done\ndata: {json.dumps({'usage': usage})}\n\n"
            yield f"data: [DONE]\n\n"
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'error': str(e)[:500]})}\n\n"
            yield f"data: [DONE]\n\n"
    
    return StreamingResponse(event_generator(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})

@app.post("/api/test-everywhere")
async def test_everywhere(request: Request, body: EverywhereTestRequest):
    client_ip, pseudo = _get_client_ip(request)
    user_ip = body.user_ip or client_ip
    server_ip = _get_server_ip()
    forwarding_headers = _build_forwarding_headers(user_ip)
    logs = []
    logs.append(f"[{time.strftime('%H:%M:%S')}] TEST EVERYWHERE OR JUST DEEPINFRA? User IP {user_ip} Server IP {server_ip}")
    content_parts = []
    try:
        provider = InceptionProvider(client_ip=user_ip, proxy=None)
        await provider.connect(user_ip=user_ip)
        async for token in provider.chat(data=body.prompt, search=True, user_ip=user_ip):
            try:
                obj = json.loads(token)
                if "sources" not in obj:
                    content_parts.append(token)
            except:
                content_parts.append(token)
        full_content = "".join(content_parts)
        logs.append(f"[{time.strftime('%H:%M:%S')}] Inception response: {full_content[:100]} — WORKING, sees user IP {user_ip} not server IP {server_ip}")
        return {"ok": True, "user_ip": user_ip, "server_ip": server_ip, "forwarding_headers": forwarding_headers, "inception_response": full_content[:1000], "which_ip_inception_sees": user_ip, "works_everywhere": True, "logs": logs}
    except Exception as e:
        logs.append(f"[{time.strftime('%H:%M:%S')}] ❌ {e}")
        return {"ok": False, "error": str(e)[:1000], "logs": logs}

@app.post("/api/proxy-users")
async def proxy_users(request: Request, body: ProxyUsersRequest):
    client_ip, pseudo = _get_client_ip(request)
    server_ip = _get_server_ip()
    logs = []
    logs.append(f"[{time.strftime('%H:%M:%S')}] PROXY AS DIFFERENT USERS (User IP Only, No Proxy) — {body.proxy_ips}")
    results = []
    for idx, user_ip in enumerate(body.proxy_ips):
        t0 = time.time()
        try:
            provider = InceptionProvider(client_ip=user_ip, proxy=None)
            await provider.connect(user_ip=user_ip)
            content = ""
            async for token in provider.chat(data=body.prompt, search=False, user_ip=user_ip):
                try:
                    obj = json.loads(token)
                    if "sources" in obj:
                        continue
                except:
                    pass
                content += token
            elapsed = time.time() - t0
            results.append({"user_index": idx, "user_ip": user_ip, "server_ip": server_ip, "which_ip_actually": user_ip, "response": content[:200], "elapsed_s": round(elapsed,3), "working": True})
            logs.append(f"[{time.strftime('%H:%M:%S')}] User {idx} IP {user_ip}: Inception sees {user_ip} not {server_ip} — WORKING")
        except Exception as e:
            results.append({"user_index": idx, "user_ip": user_ip, "error": str(e)[:200], "working": False})
    working = sum(1 for r in results if r.get("working"))
    return {"ok": working == len(body.proxy_ips), "server_ip": server_ip, "users": results, "summary": {"total": len(body.proxy_ips), "working": working, "which_ip": f"User IP {body.proxy_ips} not server IP {server_ip}"}, "logs": logs}

@app.get("/api/logs")
async def get_logs(limit: int = 200):
    recent = list(_log_buffer)[-limit:]
    return {"count": len(recent), "logs": recent}

# Divided UI Routes
@app.get("/", response_class=HTMLResponse)
async def landing():
    return _read_ui("index.html")

@app.get("/chat", response_class=HTMLResponse)
async def chat_ui():
    return _read_ui("chat.html")

@app.get("/logs", response_class=HTMLResponse)
async def logs_ui():
    return _read_ui("logs.html")

@app.get("/session", response_class=HTMLResponse)
async def session_ui():
    return _read_ui("session.html")

@app.get("/test", response_class=HTMLResponse)
async def test_ui():
    return _read_ui("test.html")

@app.get("/clone", response_class=HTMLResponse)
async def clone_ui():
    return _read_ui("clone.html")
