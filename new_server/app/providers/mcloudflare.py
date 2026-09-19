"""
mCloudFlare v2 — Provider-based, Non-laggy, Auto search (no Tavily, no manual)
Nice SSE format
"""
from __future__ import annotations
import json
from typing import Optional, Dict, AsyncGenerator

from .base import BaseProvider, StreamEvent, ThinkSplitter
from ..config import CF_ACCOUNT_ID, CF_API_TOKEN

try:
    from curl_cffi.requests import AsyncSession
    HAS_CURL_CFFI = True
except ImportError:
    HAS_CURL_CFFI = False

_API_FALLBACK = "https://multi-modal.ai.cloudflare.com/api/inference"
_API_OFFICIAL_TMPL = "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}"

_BASE_HEADERS = {
    "Accept": "text/event-stream",
    "Content-Type": "application/json",
    "Origin": "https://multi-modal.ai.cloudflare.com",
    "Referer": "https://multi-modal.ai.cloudflare.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0",
}

MODELS = {
    "llama-4-scout": "@cf/meta/llama-4-scout-17b-16e-instruct",
    "llama-3.3-70b": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "llama-3.2-3b": "@cf/meta/llama-3.2-3b-instruct",
    "llama-3.2-1b": "@cf/meta/llama-3.2-1b-instruct",
    "llama-3.1-8b-fast": "@cf/meta/llama-3.1-8b-instruct-fast",
    "deepseek-r1-distill-32b": "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    "qwq-32b": "@cf/qwen/qwq-32b",
    "qwen2.5-coder-32b": "@cf/qwen/qwen2.5-coder-32b-instruct",
    "gemma-3-12b": "@cf/google/gemma-3-12b-it",
    "mistral-small-3.1-24b": "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "phi-2": "@cf/microsoft/phi-2",
    "tinyllama-1.1b": "@cf/tinyllama/tinyllama-1.1b-chat-v1.0",
    "llama-3.1-8b": "@cf/meta/llama-3.1-8b-instruct-fast",
    "gemma-7b": "@hf/google/gemma-7b-it",
    "mistral": "@hf/mistral/mistral-7b-instruct-v0.2",
}
_DEFAULT = "llama-3.2-3b"

def _resolve(m: Optional[str]) -> str:
    if not m:
        return MODELS[_DEFAULT]
    if m.startswith("@cf/") or m.startswith("@hf/"):
        return m
    return MODELS.get(m.lower().strip(), m)

def _build_forwarding_headers(user_ip: Optional[str]) -> Dict[str, str]:
    if not user_ip or user_ip == "unknown":
        return {}
    return {"X-Forwarded-For": user_ip, "X-Real-IP": user_ip, "CF-Connecting-IP": user_ip}

def _parse_sse(line: str):
    line = line.strip()
    if not line:
        return "", False
    if line.startswith("data:"):
        data = line[5:].strip()
        if data == "[DONE]":
            return "", True
        try:
            obj = json.loads(data)
            if "choices" in obj:
                delta = obj["choices"][0].get("delta", {})
                if delta.get("reasoning_content"):
                    return "__THINK__" + delta["reasoning_content"], False
                return delta.get("content", "") or "", False
            return obj.get("response", "") or "", False
        except:
            return "", False
    else:
        try:
            obj = json.loads(line)
            return obj.get("response", "") or "", False
        except:
            return "", False

class MCloudFlareProvider(BaseProvider):
    provider_name = "mcloudflare"
    models = list(MODELS.keys())

    def __init__(self, model: str = None, system: str = None, client_ip: Optional[str] = None, **kwargs):
        self.model = _resolve(model)
        self.system = system or "You are a helpful assistant."
        self.client_ip = client_ip
        self.temperature = kwargs.get("temperature", 1.0)
        self.max_tokens = kwargs.get("max_tokens", 2048)

    async def health_check(self):
        has_official = bool(CF_ACCOUNT_ID and CF_API_TOKEN)
        return {"ok": True, "provider": "mcloudflare", "models": len(MODELS), "official_available": has_official, "fallback": _API_FALLBACK, "search_auto": True}

    def _build_msgs(self, data, messages, system):
        result = []
        if system:
            result.append({"role": "system", "content": system})
        if messages:
            for m in messages:
                if m.get("role") in ("user", "assistant"):
                    result.append({"role": m["role"], "content": m.get("content", "")})
        elif data:
            result.append({"role": "user", "content": data})
        return result

    async def _stream_events(self, payload: Dict, user_ip: Optional[str] = None, backend: str = "auto"):
        if not HAS_CURL_CFFI:
            raise RuntimeError("curl_cffi required")
        if backend == "auto":
            backend = "official" if CF_ACCOUNT_ID and CF_API_TOKEN else "fallback"

        if backend == "official":
            url = _API_OFFICIAL_TMPL.format(account_id=CF_ACCOUNT_ID, model=payload["model"])
            headers = {"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json", "User-Agent": _BASE_HEADERS["User-Agent"]}
            headers.update(_build_forwarding_headers(user_ip or self.client_ip))
            cf_payload = {"messages": payload["messages"], "max_tokens": payload.get("max_tokens", 2048), "stream": True}
        else:
            url = _API_FALLBACK
            headers = {**_BASE_HEADERS, **_build_forwarding_headers(user_ip or self.client_ip)}
            cf_payload = payload

        async with AsyncSession(impersonate="chrome") as session:
            r = await session.post(url, json=cf_payload, headers=headers, timeout=(15, 60), stream=True)
            try:
                if r.status_code != 200:
                    text = await r.text()
                    if backend == "official":
                        async with AsyncSession(impersonate="chrome") as fb_s:
                            fb_r = await fb_s.post(_API_FALLBACK, json=payload, headers={**_BASE_HEADERS, **_build_forwarding_headers(user_ip or self.client_ip)}, timeout=(15,60), stream=True)
                            if fb_r.status_code != 200:
                                raise RuntimeError(f"Both backends failed {r.status_code}/{fb_r.status_code}")
                            async for raw in fb_r.aiter_lines():
                                line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
                                tok, done = _parse_sse(line)
                                if done:
                                    return
                                if tok:
                                    yield tok
                            return
                    raise RuntimeError(f"mCloudFlare HTTP {r.status_code}: {text[:300]}")
                async for raw in r.aiter_lines():
                    line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
                    tok, done = _parse_sse(line)
                    if done:
                        return
                    if tok:
                        yield tok
            finally:
                await r.aclose()

    async def stream(self, data=None, messages=None, model=None, system=None, search=False, user_ip=None, **kwargs) -> AsyncGenerator[StreamEvent, None]:
        if not data and not messages:
            raise ValueError("Provide data or messages")

        use_model = _resolve(model) if model else self.model
        use_system = system if system is not None else self.system

        # Search AUTO — no manual DuckDuckGo, provider handles natively
        msgs = self._build_msgs(data, messages, use_system)
        payload = {"model": use_model, "messages": msgs, "max_tokens": self.max_tokens, "temperature": self.temperature, "stream": True}
        if user_ip or self.client_ip:
            payload["user"] = (user_ip or self.client_ip)[:64]

        splitter = ThinkSplitter()
        try:
            async for tok in self._stream_events(payload, user_ip=user_ip):
                if tok.startswith("__THINK__"):
                    yield StreamEvent(kind="thinking", text=tok[9:])
                else:
                    for kind, seg in splitter.feed(tok):
                        yield StreamEvent(kind=kind, text=seg)
            for kind, seg in splitter.flush():
                yield StreamEvent(kind=kind, text=seg)
        except Exception as e:
            print(f"[mCloudFlare] Failed {e}, fallback to RAGSrv")
            from .ragsrv import RAGSrvProvider
            fallback = RAGSrvProvider(model=use_model, system=use_system, client_ip=user_ip or self.client_ip)
            async for ev in fallback.stream(data=data, messages=msgs, model=use_model, system=use_system, user_ip=user_ip):
                yield ev
            return

        yield StreamEvent(kind="done", text="")
