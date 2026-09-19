"""
RAGSrv Provider — Non-laggy, Provider-based, Zero external API dependency
Search is AUTO — no Tavily, no manual toggle. If query looks like it needs search,
provider automatically yields sources via SSE event: sources
Nice SSE format: event: sources/thinking/content/done + data: {...}
"""
from __future__ import annotations
import asyncio
import json
import os
import hashlib
from typing import List, Dict, Optional, Tuple, AsyncGenerator

from .base import BaseProvider, StreamEvent

def M(mid, name, family, tags, ctx, desc, style, think=False):
    return {"id": mid, "name": name, "family": family, "tags": tags, "context": ctx, "description": desc, "style": style, "think": think}

MODELS = [
    M("openai-z/gpt-5.6-luna", "GPT-5.6 Luna", "openai-z", ["frontier", "reasoning"], 262144, "Flagship reasoning.", "luna", True),
    M("openai-z/gpt-5.4-nano", "GPT-5.4 Nano", "openai-z", ["fast", "cheap"], 131072, "Small quick.", "nano"),
    M("openai-z/gpt-4o-mini", "GPT-4o Mini", "openai-z", ["fast", "general"], 128000, "Lightweight.", "gptmini"),
    M("zai-z/zai-org-glm-5-3-flash", "GLM 5.3 Flash", "zai-z", ["reasoning", "fast"], 131072, "Z.ai GLM 5.3 flash.", "glm", True),
    M("zai-z/zai-org-glm-4.7-flash", "GLM 4.7 Flash", "zai-z", ["reasoning", "fast"], 131072, "GLM flash.", "glm", True),
    M("zai-z/olafangensan-glm-4.7-flash-heretic", "GLM 4.7 Heretic", "zai-z", ["uncensored", "roleplay"], 131072, "Uncensored.", "heretic", True),
    M("logfare/kimi-k3", "Kimi K3", "logfare", ["long-context", "helpful"], 262144, "Moonshot Kimi K3.", "kimi", True),
    M("logfare/minimax-m3", "MiniMax M3", "logfare", ["general", "creative"], 131072, "MiniMax M3.", "minimax"),
    M("logfare/deepseek-v4-flash", "DeepSeek V4 Flash", "logfare", ["reasoning", "fast"], 131072, "DeepSeek V4 flash.", "deepseek", True),
    M("logfare/deepseek-v4-pro", "DeepSeek V4 Pro", "logfare", ["reasoning", "strong"], 131072, "DeepSeek V4 pro.", "deepseek", True),
    M("poolside/laguna-xs-2.1", "Laguna XS 2.1", "poolside", ["coding", "agentic", "fast"], 262144, "Lightest agentic coder.", "coder"),
    M("poolside/laguna-s-2.1", "Laguna S 2.1", "poolside", ["coding", "agentic", "frontier"], 262144, "Most capable coder.", "coder"),
    M("osaii/voicellm", "VoiceLLM", "osaii", ["audio", "experimental"], 32768, "Voice experimental.", "osaii"),
    M("venice-z/gemma-4-31b-it", "Gemma 4 31B IT", "venice-z", ["general"], 32768, "Gemma 4 31B.", "venice"),
    M("venice-z/venice-uncensored-1-2", "Venice Uncensored 1.2", "venice-z", ["uncensored"], 32768, "Venice uncensored.", "venice_uncensored"),
    M("qwen-z/qwen3.8-flash", "Qwen 3.8 Flash", "qwen-z", ["fast", "general"], 131072, "Qwen 3.8 flash.", "qwen", True),
    M("qwen-z/qwen3-coder-flash", "Qwen 3 Coder Flash", "qwen-z", ["coding", "fast"], 131072, "Qwen coding flash.", "coder", True),
    M("fireworks-z/nemotron-lightning-3.5", "Nemotron Lightning 3.5", "fireworks-z", ["fast", "reasoning"], 131072, "NVIDIA Nemotron.", "fireworks"),
    M("groq-z/gpt-oss-20b", "GPT-OSS 20B", "groq-z", ["fast", "open-weights"], 131072, "GPT-OSS 20B.", "groq", True),
    M("groq-z/gpt-oss-120b", "GPT-OSS 120B", "groq-z", ["strong", "open-weights"], 131072, "GPT-OSS 120B.", "groq", True),
    M("deepseek-z/deepseek-v4-flash", "DeepSeek V4 Flash", "deepseek-z", ["reasoning", "fast"], 131072, "DeepSeek V4 flash.", "deepseek", True),
    M("mimo-z/mimo-v2.5", "MiMo v2.5", "mimo-z", ["general", "conversational"], 131072, "Xiaomi MiMo.", "mimo"),
    M("gemini-z/gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite", "gemini-z", ["fast", "cheap"], 1048576, "Cheapest Gemini.", "gemini"),
    M("minimax-z/minimax-m3", "MiniMax M3", "minimax-z", ["general", "creative"], 131072, "MiniMax M3 direct.", "minimax"),
    M("qwen-z/qwen3.7-plus", "Qwen 3.7 Plus", "qwen-z", ["general", "strong"], 131072, "Qwen 3.7 plus.", "qwen", True),
    M("inception-z/mercury-2", "Mercury 2", "inception-z", ["experimental"], 32768, "Inception Mercury 2.", "inception"),
    M("stealth/lion-alpha", "Lion Alpha", "stealth", ["experimental", "stealth"], 32768, "Mystery model.", "stealth"),
    M("microsoft/bitnet-b1.58-2B-4T", "BitNet b1.58 2B", "microsoft", ["tiny", "efficient"], 32768, "Microsoft 1.58-bit.", "bitnet"),
]

MODEL_BY_ID = {m["id"]: m for m in MODELS}
MODEL_ALIASES = {
    "luna": "openai-z/gpt-5.6-luna",
    "kimi-k3": "logfare/kimi-k3",
    "kimi-k2.5": "logfare/kimi-k3",
    "glm-5.3-flash": "zai-z/zai-org-glm-5-3-flash",
    "grok-4-fast": "logfare/kimi-k3",
    "deepseek-v4-pro": "logfare/deepseek-v4-pro",
    "laguna-xs": "poolside/laguna-xs-2.1",
    "gemini-flash-lite": "gemini-z/gemini-2.5-flash-lite",
    "gpt-oss-20b": "groq-z/gpt-oss-20b",
    "bitnet": "microsoft/bitnet-b1.58-2B-4T",
    "llama-3.2-3b": "logfare/kimi-k3",
    "llama-3.1-8b": "logfare/kimi-k3",
    "mercury-2": "inception-z/mercury-2",
    "inception": "inception-z/mercury-2",
}

_DEFAULT = "logfare/kimi-k3"

def _resolve_model(m: Optional[str]) -> str:
    if not m:
        return _DEFAULT
    m = m.strip()
    low = m.lower()
    if low in MODEL_ALIASES:
        return MODEL_ALIASES[low]
    if m in MODEL_BY_ID:
        return m
    for alias, full in MODEL_ALIASES.items():
        if low in alias.lower():
            return full
    for mid in MODEL_BY_ID:
        if low in mid.lower():
            return mid
    return m

OPENERS = {
    "luna": ["Here's my take:", "Let me break that down:"],
    "glm": ["Step by step:", "Analyzing:"],
    "kimi": ["Happy to help!", "Great question!"],
    "coder": ["Plan:", "Here's the implementation:"],
    "deepseek": ["Thinking it through:", "Reasoning:"],
    "groq": ["Fast answer:", "Quick:"],
    "gemini": ["✨ Great question!", "Here you go:"],
    "inception": ["Mercury reasoning:", "Diffusion:"],
    "default": ["Sure:", "Here's the answer:"],
}

def _det(model_id: str, text: str) -> int:
    return int(hashlib.sha256(f"{model_id}:{text}".encode()).hexdigest(), 16)

def _needs_search(text: str) -> bool:
    """Auto-detect if query needs search — like inception.py and upstage auto search"""
    low = text.lower()
    triggers = ["what is", "who is", "when is", "where is", "capital of", "current", "latest", "news", "weather", "price", "how many", "search", "find", "tell me about", "explain", "define"]
    return any(t in low for t in triggers)

def _simulated_sources(query: str) -> List[Dict]:
    """Auto sources — no Tavily, no external API, simulated but realistic for demo"""
    low = query.lower()
    base_sources = []
    if "capital of france" in low:
        base_sources = [
            {"title": "Paris - Capital of France - Wikipedia", "url": "https://en.wikipedia.org/wiki/Paris", "snippet": "Paris is the capital and most populous city of France..."},
            {"title": "France - Wikipedia", "url": "https://en.wikipedia.org/wiki/France", "snippet": "France's capital is Paris, located in north-central France..."},
        ]
    elif "france" in low:
        base_sources = [
            {"title": "France - Wikipedia", "url": "https://en.wikipedia.org/wiki/France", "snippet": "France is a country in Western Europe..."},
        ]
    elif "india" in low:
        base_sources = [
            {"title": "India - Wikipedia", "url": "https://en.wikipedia.org/wiki/India", "snippet": "India is a country in South Asia... capital New Delhi"},
        ]
    else:
        # Generic simulated sources
        h = hashlib.sha256(query.encode()).hexdigest()[:8]
        base_sources = [
            {"title": f"Search result for {query[:30]}", "url": f"https://example.com/search/{h}", "snippet": f"Information about {query[:50]}..."},
        ]
    return base_sources

def simulate_fast(model: dict, last: str) -> Tuple[str, str, List[Dict]]:
    style = model.get("style", "default")
    seed = _det(model["id"], last)
    openers = OPENERS.get(style, OPENERS["default"])
    opener = openers[seed % len(openers)]

    low = last.lower()
    if "capital of france" in low:
        body = "The capital of France is **Paris**."
    elif "capital of india" in low:
        body = "The capital of India is **New Delhi**."
    elif low.strip() in {"hi", "hello", "hey"}:
        body = f"Hey! I'm **{model['name']}** — ready to help. What are we working on?"
    elif "who are you" in low or "what model" in low:
        body = f"I'm **{model['name']}** from {model['family']} — {model['description']}"
    else:
        body = f"On **{last[:100]}** — here's the direct take: This is a simulated response from {model['name']} ({model['id']}). In proxy mode with RAGSRV_UPSTREAM_BASE set, you'd get real LLM output. For now, this instant simulated persona shows the routing works. Want me to go deeper?"

    answer = f"{opener} {body}"

    thinking = ""
    if model.get("think"):
        thinking = f"Thinking: User asks '{last[:80]}'. Need to answer directly. Model {model['id']} is reasoning-capable, so show chain: 1) parse intent, 2) retrieve fact, 3) structure answer. Confidence high."

    sources = []
    if _needs_search(last):
        sources = _simulated_sources(last)

    return thinking, answer, sources

class RAGSrvProvider(BaseProvider):
    provider_name = "ragsrv"
    models = list(MODEL_BY_ID.keys()) + list(MODEL_ALIASES.keys())

    def __init__(self, model: str = None, system: str = None, client_ip: Optional[str] = None, **kwargs):
        self.model = _resolve_model(model)
        self.system = system or "You are a helpful assistant."
        self.client_ip = client_ip
        self.upstream_base = os.getenv("RAGSRV_UPSTREAM_BASE", "").strip().rstrip("/")
        self.upstream_key = os.getenv("RAGSRV_UPSTREAM_KEY", "").strip()

    async def health_check(self):
        return {"ok": True, "provider": "ragsrv", "models": len(MODELS), "mode": "proxy" if self.upstream_base else "simulated", "default": _DEFAULT, "search_auto": True}

    def _build_messages(self, data, messages, system):
        use_system = system if system is not None else self.system
        clean = []
        if messages:
            for m in messages:
                role = m.get("role", "")
                content = m.get("content", "")
                if role in ("user", "assistant"):
                    clean.append({"role": role, "content": content})
        elif data:
            clean.append({"role": "user", "content": data})
        result = []
        if use_system:
            result.append({"role": "system", "content": use_system})
        result.extend(clean)
        return result

    async def stream(self, data=None, messages=None, model=None, system=None, search=False, user_ip=None, **kwargs) -> AsyncGenerator[StreamEvent, None]:
        if not data and not messages:
            raise ValueError("Provide data or messages")

        use_model = _resolve_model(model) if model else self.model
        use_system = system if system is not None else self.system
        model_info = MODEL_BY_ID.get(use_model, {"id": use_model, "name": use_model, "style": "default", "think": False, "family": "unknown"})

        msgs = self._build_messages(data, messages, use_system)
        last_user = ""
        for m in reversed(msgs):
            if m.get("role") == "user":
                last_user = m.get("content", "")
                break
        if not last_user:
            last_user = data or "hello"

        # If upstream set, proxy (real LLM) — search auto handled by upstream
        if self.upstream_base:
            try:
                import aiohttp
                headers = {"Content-Type": "application/json"}
                if self.upstream_key:
                    headers["Authorization"] = f"Bearer {self.upstream_key}"
                payload = {"model": use_model, "messages": msgs, "stream": True, "temperature": kwargs.get("temperature", 0.7)}

                async with aiohttp.ClientSession() as session:
                    async with session.post(f"{self.upstream_base}/chat/completions", json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=120)) as resp:
                        if resp.status != 200:
                            raise RuntimeError(f"Upstream HTTP {resp.status}")
                        async for line in resp.content:
                            line = line.decode("utf-8", errors="replace").strip()
                            if not line or not line.startswith("data:"):
                                continue
                            d = line[5:].strip()
                            if d == "[DONE]":
                                break
                            try:
                                obj = json.loads(d)
                                choices = obj.get("choices", [])
                                if not choices:
                                    continue
                                delta = choices[0].get("delta", {})
                                if delta.get("content"):
                                    yield StreamEvent(kind="content", text=delta["content"])
                                if delta.get("reasoning_content"):
                                    yield StreamEvent(kind="thinking", text=delta["reasoning_content"])
                                # Check for sources in upstream response (auto search)
                                if obj.get("sources"):
                                    yield StreamEvent(kind="sources", text=json.dumps({"sources": obj["sources"]}))
                            except:
                                continue
                yield StreamEvent(kind="done", text="")
                return
            except Exception as e:
                print(f"[RAGSrv] Proxy failed {e}, falling back to simulated")

        # Simulated mode — FAST, non-laggy, chunked, AUTO SEARCH
        thinking, answer, sources = simulate_fast(model_info, last_user)

        # Auto sources via SSE first — nice SSE format
        if sources:
            yield StreamEvent(kind="sources", text=json.dumps({"sources": sources}))

        if thinking:
            chunk_size = 60
            for i in range(0, len(thinking), chunk_size):
                yield StreamEvent(kind="thinking", text=thinking[i:i+chunk_size])
                await asyncio.sleep(0.005)

        chunk_size = 80
        for i in range(0, len(answer), chunk_size):
            yield StreamEvent(kind="content", text=answer[i:i+chunk_size])
            await asyncio.sleep(0.003)

        yield StreamEvent(kind="done", text="")

    @staticmethod
    def available_models():
        return list(MODEL_BY_ID.keys()) + list(MODEL_ALIASES.keys())

RAGSrvProviderAsync = RAGSrvProvider
