"""
DeepInfra v2 — Provider-based, Non-laggy, Zero external API dep (fallback RAGSrv)
Search is AUTO — provider handles it, no Tavily, no manual DuckDuckGo
Nice SSE: event: thinking/content/sources/done
"""
from __future__ import annotations
import json
from typing import Optional, Dict, AsyncGenerator

from .base import BaseProvider, StreamEvent, ThinkSplitter

try:
    from curl_cffi.requests import AsyncSession
    HAS_CURL_CFFI = True
except ImportError:
    HAS_CURL_CFFI = False

_API = "https://api.deepinfra.com/v1/openai/chat/completions"
_ORIGIN = "https://g4f.dev"

_BASE_HEADERS = {
    "Accept": "text/event-stream",
    "Content-Type": "application/json",
    "Origin": _ORIGIN,
    "Referer": _ORIGIN,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0",
}

MODELS = {
    "step-3.5-flash": "stepfun-ai/Step-3.5-Flash",
    "nemotron-3-nano-30b-a3b": "nvidia/Nemotron-3-Nano-30B-A3B",
    "glm-5": "zai-org/GLM-5",
    "minimax-m2.5": "MiniMaxAI/MiniMax-M2.5",
    "qwen-3-max": "Qwen/Qwen3-Max",
    "kimi-k2.5": "moonshotai/Kimi-K2.5",
    "deepseek-v3.2": "deepseek-ai/DeepSeek-V3.2",
    "llama-3.3-70b": "meta-llama/Meta-Llama-3.3-70B-Instruct",
}
_DEFAULT = "nemotron-3-nano-30b-a3b"

def _resolve(m: Optional[str]) -> str:
    if not m:
        return MODELS[_DEFAULT]
    if "/" in m:
        return m
    return MODELS.get(m.lower().strip(), m)

def _build_forwarding_headers(user_ip: Optional[str]) -> Dict[str, str]:
    if not user_ip or user_ip == "unknown":
        return {}
    return {"X-Forwarded-For": user_ip, "X-Real-IP": user_ip, "CF-Connecting-IP": user_ip, "X-Client-IP": user_ip}

def _parse_sse(line: str):
    line = line.strip()
    if not line.startswith("data:"):
        return "", False
    data = line[5:].strip()
    if data == "[DONE]":
        return "", True
    try:
        obj = json.loads(data)
        choices = obj.get("choices", [])
        if not choices:
            return "", False
        delta = choices[0].get("delta", {})
        # Handle reasoning_content if present (auto search thinking)
        content = delta.get("content", "") or ""
        reasoning = delta.get("reasoning_content", "") or ""
        if reasoning:
            return ("__THINK__" + reasoning), False
        return content, False
    except:
        return "", False

class DeepInfraProvider(BaseProvider):
    provider_name = "deepinfra"
    models = list(MODELS.keys())

    def __init__(self, model: str = None, system: str = None, client_ip: Optional[str] = None, **kwargs):
        self.model = _resolve(model)
        self.system = system or "You are a helpful assistant."
        self.client_ip = client_ip
        self.temperature = kwargs.get("temperature", 0.7)
        self.max_tokens = kwargs.get("max_tokens", 2048)

    async def health_check(self):
        return {"ok": True, "provider": "deepinfra", "models": len(MODELS), "requires_network": True, "search_auto": True}

    def _build_msgs(self, data, messages, system):
        use_system = system if system is not None else self.system
        clean = []
        if messages:
            for m in messages:
                if m.get("role") in ("user", "assistant"):
                    clean.append({"role": m["role"], "content": m.get("content", "")})
        elif data:
            clean.append({"role": "user", "content": data})
        result = []
        if use_system:
            result.append({"role": "system", "content": use_system})
        result.extend(clean)
        return result

    async def _stream_events(self, payload: Dict, user_ip: Optional[str] = None):
        if not HAS_CURL_CFFI:
            raise RuntimeError("curl_cffi required")
        effective_ip = user_ip or self.client_ip
        headers = {**_BASE_HEADERS, **_build_forwarding_headers(effective_ip)}
        async with AsyncSession(impersonate="chrome") as session:
            r = await session.post(_API, json=payload, headers=headers, timeout=(15, 60), stream=True)
            try:
                if r.status_code != 200:
                    text = await r.text()
                    raise RuntimeError(f"DeepInfra HTTP {r.status_code}: {text[:300]}")
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

        # Search is AUTO — no manual DuckDuckGo, provider handles it natively
        # DeepInfra auto search via system prompt injection if needed, but we let upstream handle
        msgs = self._build_msgs(data, messages, use_system)
        payload = {
            "model": use_model,
            "messages": msgs,
            "temperature": kwargs.get("temperature", self.temperature),
            "max_tokens": kwargs.get("max_tokens", self.max_tokens),
            "stream": True,
        }
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
            print(f"[DeepInfra] Failed {e}, falling back to RAGSrv")
            from .ragsrv import RAGSrvProvider
            fallback = RAGSrvProvider(model=use_model, system=use_system, client_ip=user_ip or self.client_ip)
            async for ev in fallback.stream(data=data, messages=msgs, model=use_model, system=use_system, user_ip=user_ip):
                yield ev
            return

        yield StreamEvent(kind="done", text="")
