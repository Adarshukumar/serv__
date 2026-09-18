"""
══════════════════════════════════════════════════════════════
  ☁️  DevsDo Provider  (Async)

  Async streaming via Cloudflare AI Playground
  Backend: https://adarshu07-ls.hf.space
  OpenAI-compatible SSE · 58 models · Instant · Private Access

  DNS FIX: Uses aiohttp.ThreadedResolver to bypass aiodns
           (c-ares fails on Windows / restricted networks).

  SESSION: Per-call session creation — avoids cross-event-loop
           issues when ChatStream bridges async→sync via thread.

  Usage:
      from providers.DevsDo import DevsdoProvider

      dp = DevsdoProvider()

      # Async
      async for tok in dp.chat(data="Hello!"):
          print(tok, end="", flush=True)

      # Via Completion (sync or async — auto-bridged)
      for tok in Completion.chat(model="devsdo:kimi-k2.5", data="Hello!"):
          print(tok, end="", flush=True)
══════════════════════════════════════════════════════════════
"""

from __future__ import annotations

import json
import asyncio
import random
from typing import Optional, AsyncGenerator, Dict, List

import aiohttp
import aiohttp.resolver
import os


# ═══════════════════════════════════════════════════════════
# §0 — API KEY (Set your private HF Space API key here)
# ═══════════════════════════════════════════════════════════
API = os.getenv("HF_SPACE_API", "")


# ═══════════════════════════════════════════════════════════
# §1 — CONSTANTS
# ═══════════════════════════════════════════════════════════
_BASE_URL   = "https://adarshu07-ls.hf.space"
_API_CHAT   = f"{_BASE_URL}/v1/chat/completions"
_API_MODELS = f"{_BASE_URL}/v1/models"
_API_HEALTH = f"{_BASE_URL}/health"


# ═══════════════════════════════════════════════════════════
# §2 — HEADERS BUILDER (with Authorization)
# ═══════════════════════════════════════════════════════════
def _get_headers() -> dict:
    """Build headers with Authorization if API key is set."""
    headers = {
        "Accept":             "application/json",
        "Accept-Encoding":    "gzip, deflate, br, zstd",
        "Accept-Language":    "en-US,en;q=0.9",
        "Content-Type":       "application/json",
        "Origin":             _BASE_URL,
        "Referer":            f"{_BASE_URL}/docs",
        "sec-ch-ua":          '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        "sec-ch-ua-mobile":   "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest":     "empty",
        "sec-fetch-mode":     "cors",
        "sec-fetch-site":     "same-origin",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/146.0.0.0 Safari/537.36"
        ),
    }
    
    # ── Add Authorization header if API key is provided ───
    if API and API.strip():
        headers["Authorization"] = f"Bearer {API.strip()}"
    
    return headers


_RETRY_CODES = {429, 500, 502, 503, 504, 520, 521, 522, 523, 524}
_FATAL_CODES = {400, 401, 403, 404, 405, 422}


# ═══════════════════════════════════════════════════════════
# §3 — MODEL REGISTRY
#
#  All 58 models from the HF Space /v1/models endpoint
#  Structured as: name, owner, model_path (id), context_window, reasoning
# ═══════════════════════════════════════════════════════════
MODELS: List[Dict] = [
    # ══════════════════════════════════════════════════════
    # FLAGSHIP / LARGE MODELS (120B - 70B)
    # ══════════════════════════════════════════════════════
    {
        "name": "GPT-OSS 120B",
        "owner": "OpenAI",
        "model": "gpt-oss-120b",
        "id": "@cf/openai/gpt-oss-120b",
        "context_window": 128000,
        "reasoning": True
    },
    {
        "name": "Nemotron 3 120B A12B",
        "owner": "NVIDIA",
        "model": "nemotron-120b",
        "id": "@cf/nvidia/nemotron-3-120b-a12b",
        "context_window": 256000,
        "reasoning": True
    },
    {
        "name": "Llama 3.3 70B Instruct FP8 Fast",
        "owner": "Meta",
        "model": "llama-3.3-70b",
        "id": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        "context_window": 24000,
        "reasoning": False
    },

    # ══════════════════════════════════════════════════════
    # KIMI / MOONSHOT AI
    # ══════════════════════════════════════════════════════
    {
        "name": "Kimi K2.5",
        "owner": "Moonshot AI",
        "model": "kimi-k2.5",
        "id": "@cf/moonshotai/kimi-k2.5",
        "context_window": 256000,
        "reasoning": True
    },

    # ══════════════════════════════════════════════════════
    # META LLAMA FAMILY
    # ══════════════════════════════════════════════════════
    {
        "name": "Llama 4 Scout 17B 16E Instruct",
        "owner": "Meta",
        "model": "llama-4-scout",
        "id": "@cf/meta/llama-4-scout-17b-16e-instruct",
        "context_window": 131000,
        "reasoning": False
    },
    {
        "name": "Llama 3.2 11B Vision Instruct",
        "owner": "Meta",
        "model": "llama-3.2-11b-vision",
        "id": "@cf/meta/llama-3.2-11b-vision-instruct",
        "context_window": 128000,
        "reasoning": False
    },
    {
        "name": "Llama 3.1 8B Instruct Fast",
        "owner": "Meta",
        "model": "llama-3.1-8b",
        "id": "@cf/meta/llama-3.1-8b-instruct-fast",
        "context_window": 32000,
        "reasoning": False
    },
    {
        "name": "Llama 3.1 8B Instruct FP8",
        "owner": "Meta",
        "model": "llama-3.1-8b-fp8",
        "id": "@cf/meta/llama-3.1-8b-instruct-fp8",
        "context_window": 32000,
        "reasoning": False
    },
    {
        "name": "Llama 3.1 8B Instruct AWQ",
        "owner": "Meta",
        "model": "llama-3.1-8b-awq",
        "id": "@cf/meta/llama-3.1-8b-instruct-awq",
        "context_window": 8192,
        "reasoning": False
    },
    {
        "name": "Llama 3.2 3B Instruct",
        "owner": "Meta",
        "model": "llama-3.2-3b",
        "id": "@cf/meta/llama-3.2-3b-instruct",
        "context_window": 80000,
        "reasoning": False
    },
    {
        "name": "Llama 3.2 1B Instruct",
        "owner": "Meta",
        "model": "llama-3.2-1b",
        "id": "@cf/meta/llama-3.2-1b-instruct",
        "context_window": 60000,
        "reasoning": False
    },
    {
        "name": "Llama 3 8B Instruct",
        "owner": "Meta",
        "model": "llama-3-8b",
        "id": "@cf/meta/llama-3-8b-instruct",
        "context_window": 7968,
        "reasoning": False
    },
    {
        "name": "Llama 3 8B Instruct AWQ",
        "owner": "Meta",
        "model": "llama-3-8b-awq",
        "id": "@cf/meta/llama-3-8b-instruct-awq",
        "context_window": 8192,
        "reasoning": False
    },
    {
        "name": "Llama Guard 3 8B",
        "owner": "Meta",
        "model": "llama-guard-3",
        "id": "@cf/meta/llama-guard-3-8b",
        "context_window": 131072,
        "reasoning": False
    },
    {
        "name": "Llama 2 7B Chat FP16",
        "owner": "Meta",
        "model": "llama-2-7b-fp16",
        "id": "@cf/meta/llama-2-7b-chat-fp16",
        "context_window": 4096,
        "reasoning": False
    },
    {
        "name": "Llama 2 7B Chat INT8",
        "owner": "Meta",
        "model": "llama-2-7b-int8",
        "id": "@cf/meta/llama-2-7b-chat-int8",
        "context_window": 8192,
        "reasoning": False
    },
    {
        "name": "Llama 2 7B Chat HF LoRA",
        "owner": "Meta",
        "model": "llama-2-7b-lora",
        "id": "@cf/meta-llama/llama-2-7b-chat-hf-lora",
        "context_window": 8192,
        "reasoning": False
    },
    {
        "name": "Llama 2 13B Chat AWQ",
        "owner": "TheBloke",
        "model": "llama-2-13b",
        "id": "@hf/thebloke/llama-2-13b-chat-awq",
        "context_window": 4096,
        "reasoning": False
    },

    # ══════════════════════════════════════════════════════
    # QWEN FAMILY
    # ══════════════════════════════════════════════════════
    {
        "name": "QwQ 32B",
        "owner": "Qwen/Alibaba",
        "model": "qwq-32b",
        "id": "@cf/qwen/qwq-32b",
        "context_window": 24000,
        "reasoning": True
    },
    {
        "name": "Qwen 2.5 Coder 32B Instruct",
        "owner": "Qwen/Alibaba",
        "model": "qwen-coder-32b",
        "id": "@cf/qwen/qwen2.5-coder-32b-instruct",
        "context_window": 32768,
        "reasoning": False
    },
    {
        "name": "Qwen 3 30B A3B FP8",
        "owner": "Qwen/Alibaba",
        "model": "qwen3-30b",
        "id": "@cf/qwen/qwen3-30b-a3b-fp8",
        "context_window": 32768,
        "reasoning": True
    },
    {
        "name": "Qwen 1.5 14B Chat AWQ",
        "owner": "Qwen/Alibaba",
        "model": "qwen1.5-14b",
        "id": "@cf/qwen/qwen1.5-14b-chat-awq",
        "context_window": 7500,
        "reasoning": False
    },
    {
        "name": "Qwen 1.5 7B Chat AWQ",
        "owner": "Qwen/Alibaba",
        "model": "qwen1.5-7b",
        "id": "@cf/qwen/qwen1.5-7b-chat-awq",
        "context_window": 20000,
        "reasoning": False
    },
    {
        "name": "Qwen 1.5 1.8B Chat",
        "owner": "Qwen/Alibaba",
        "model": "qwen1.5-1.8b",
        "id": "@cf/qwen/qwen1.5-1.8b-chat",
        "context_window": 32000,
        "reasoning": False
    },
    {
        "name": "Qwen 1.5 0.5B Chat",
        "owner": "Qwen/Alibaba",
        "model": "qwen1.5-0.5b",
        "id": "@cf/qwen/qwen1.5-0.5b-chat",
        "context_window": 32000,
        "reasoning": False
    },

    # ══════════════════════════════════════════════════════
    # DEEPSEEK FAMILY
    # ══════════════════════════════════════════════════════
    {
        "name": "DeepSeek R1 Distill Qwen 32B",
        "owner": "DeepSeek AI",
        "model": "deepseek-r1",
        "id": "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        "context_window": 80000,
        "reasoning": True
    },
    {
        "name": "DeepSeek R1 Distill Qwen 32B",
        "owner": "DeepSeek AI",
        "model": "deepseek-r1-32b",
        "id": "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        "context_window": 80000,
        "reasoning": True
    },
    {
        "name": "DeepSeek Math 7B Instruct",
        "owner": "DeepSeek AI",
        "model": "deepseek-math",
        "id": "@cf/deepseek-ai/deepseek-math-7b-instruct",
        "context_window": 4096,
        "reasoning": False
    },
    {
        "name": "DeepSeek Coder 6.7B Base AWQ",
        "owner": "TheBloke",
        "model": "deepseek-coder-base",
        "id": "@hf/thebloke/deepseek-coder-6.7b-base-awq",
        "context_window": 4096,
        "reasoning": False
    },
    {
        "name": "DeepSeek Coder 6.7B Instruct AWQ",
        "owner": "TheBloke",
        "model": "deepseek-coder",
        "id": "@hf/thebloke/deepseek-coder-6.7b-instruct-awq",
        "context_window": 4096,
        "reasoning": False
    },

    # ══════════════════════════════════════════════════════
    # GOOGLE GEMMA FAMILY
    # ══════════════════════════════════════════════════════
    {
        "name": "Gemma 4 26B A4B IT",
        "owner": "Google",
        "model": "gemma-4-26b",
        "id": "@cf/google/gemma-4-26b-a4b-it",
        "context_window": 256000,
        "reasoning": True
    },
    {
        "name": "Gemma 3 12B IT",
        "owner": "Google",
        "model": "gemma-3-12b",
        "id": "@cf/google/gemma-3-12b-it",
        "context_window": 80000,
        "reasoning": False
    },
    {
        "name": "Gemma 7B IT",
        "owner": "Google",
        "model": "gemma-7b",
        "id": "@hf/google/gemma-7b-it",
        "context_window": 8192,
        "reasoning": False
    },
    {
        "name": "Gemma 2B IT LoRA",
        "owner": "Google",
        "model": "gemma-2b-lora",
        "id": "@cf/google/gemma-2b-it-lora",
        "context_window": 8192,
        "reasoning": False
    },
    {
        "name": "Gemma 7B IT LoRA",
        "owner": "Google",
        "model": "gemma-7b-lora",
        "id": "@cf/google/gemma-7b-it-lora",
        "context_window": 3500,
        "reasoning": False
    },

    # ══════════════════════════════════════════════════════
    # MISTRAL FAMILY
    # ══════════════════════════════════════════════════════
    {
        "name": "Mistral Small 3.1 24B Instruct",
        "owner": "Mistral AI",
        "model": "mistral-small-3.1",
        "id": "@cf/mistralai/mistral-small-3.1-24b-instruct",
        "context_window": 128000,
        "reasoning": False
    },
    {
        "name": "Mistral 7B Instruct V0.2",
        "owner": "Mistral AI",
        "model": "mistral-v0.2",
        "id": "@hf/mistral/mistral-7b-instruct-v0.2",
        "context_window": 3072,
        "reasoning": False
    },
    {
        "name": "Mistral 7B Instruct V0.2 LoRA",
        "owner": "Mistral AI",
        "model": "mistral-v0.2-lora",
        "id": "@cf/mistral/mistral-7b-instruct-v0.2-lora",
        "context_window": 15000,
        "reasoning": False
    },
    {
        "name": "Mistral 7B Instruct V0.1",
        "owner": "Mistral AI",
        "model": "mistral-v0.1",
        "id": "@cf/mistral/mistral-7b-instruct-v0.1",
        "context_window": 2824,
        "reasoning": False
    },
    {
        "name": "Mistral 7B Instruct V0.1 AWQ",
        "owner": "TheBloke",
        "model": "mistral-v0.1-awq",
        "id": "@hf/thebloke/mistral-7b-instruct-v0.1-awq",
        "context_window": 4096,
        "reasoning": False
    },

    # ══════════════════════════════════════════════════════
    # IBM GRANITE
    # ══════════════════════════════════════════════════════
    {
        "name": "Granite 4.0 H Micro",
        "owner": "IBM",
        "model": "granite-4.0",
        "id": "@cf/ibm-granite/granite-4.0-h-micro",
        "context_window": 131000,
        "reasoning": False
    },

    # ══════════════════════════════════════════════════════
    # GLM / ZHIPUAI
    # ══════════════════════════════════════════════════════
    {
        "name": "GLM 4.7 Flash",
        "owner": "ZAI",
        "model": "glm-4.7-flash",
        "id": "@cf/zai-org/glm-4.7-flash",
        "context_window": 131072,
        "reasoning": True
    },

    # ══════════════════════════════════════════════════════
    # AI SINGAPORE
    # ══════════════════════════════════════════════════════
    {
        "name": "Gemma SEA-LION V4 27B IT",
        "owner": "AI Singapore",
        "model": "sea-lion-27b",
        "id": "@cf/aisingapore/gemma-sea-lion-v4-27b-it",
        "context_window": 128000,
        "reasoning": False
    },

    # ══════════════════════════════════════════════════════
    # OPENAI OSS
    # ══════════════════════════════════════════════════════
    {
        "name": "GPT-OSS 20B",
        "owner": "OpenAI",
        "model": "gpt-oss-20b",
        "id": "@cf/openai/gpt-oss-20b",
        "context_window": 128000,
        "reasoning": True
    },

    # ══════════════════════════════════════════════════════
    # OTHER MODELS
    # ══════════════════════════════════════════════════════
    {
        "name": "Hermes 2 Pro Mistral 7B",
        "owner": "NousResearch",
        "model": "hermes-2-pro",
        "id": "@hf/nousresearch/hermes-2-pro-mistral-7b",
        "context_window": 24000,
        "reasoning": False
    },
    {
        "name": "OpenHermes 2.5 Mistral 7B AWQ",
        "owner": "TheBloke",
        "model": "openhermes-2.5",
        "id": "@hf/thebloke/openhermes-2.5-mistral-7b-awq",
        "context_window": 4096,
        "reasoning": False
    },
    {
        "name": "Starling LM 7B Beta",
        "owner": "Nexusflow",
        "model": "starling-7b",
        "id": "@hf/nexusflow/starling-lm-7b-beta",
        "context_window": 4096,
        "reasoning": False
    },
    {
        "name": "Neural Chat 7B V3.1 AWQ",
        "owner": "TheBloke",
        "model": "neural-chat-7b",
        "id": "@hf/thebloke/neural-chat-7b-v3-1-awq",
        "context_window": 4096,
        "reasoning": False
    },
    {
        "name": "OpenChat 3.5 0106",
        "owner": "OpenChat",
        "model": "openchat-3.5",
        "id": "@cf/openchat/openchat-3.5-0106",
        "context_window": 8192,
        "reasoning": False
    },
    {
        "name": "Una Cybertron 7B V2 BF16",
        "owner": "FBLGit",
        "model": "cybertron-7b",
        "id": "@cf/fblgit/una-cybertron-7b-v2-bf16",
        "context_window": 15000,
        "reasoning": False
    },
    {
        "name": "DiscoLM German 7B V1 AWQ",
        "owner": "TheBloke",
        "model": "discolm-german-7b",
        "id": "@cf/thebloke/discolm-german-7b-v1-awq",
        "context_window": 4096,
        "reasoning": False
    },
    {
        "name": "Zephyr 7B Beta AWQ",
        "owner": "TheBloke",
        "model": "zephyr-7b",
        "id": "@hf/thebloke/zephyr-7b-beta-awq",
        "context_window": 4096,
        "reasoning": False
    },
    {
        "name": "Falcon 7B Instruct",
        "owner": "TII UAE",
        "model": "falcon-7b",
        "id": "@cf/tiiuae/falcon-7b-instruct",
        "context_window": 4096,
        "reasoning": False
    },
    {
        "name": "TinyLlama 1.1B Chat V1.0",
        "owner": "TinyLlama",
        "model": "tinyllama-1.1b",
        "id": "@cf/tinyllama/tinyllama-1.1b-chat-v1.0",
        "context_window": 2048,
        "reasoning": False
    },
    {
        "name": "Phi 2",
        "owner": "Microsoft",
        "model": "phi-2",
        "id": "@cf/microsoft/phi-2",
        "context_window": 2048,
        "reasoning": False
    },
    {
        "name": "SQLCoder 7B 2",
        "owner": "Defog",
        "model": "sqlcoder",
        "id": "@cf/defog/sqlcoder-7b-2",
        "context_window": 10000,
        "reasoning": False
    },
]

# ══════════════════════════════════════════════════════
# BUILD LOOKUP DICTIONARIES
# ══════════════════════════════════════════════════════
_MODEL_BY_ALIAS: Dict[str, Dict] = {m["model"]: m for m in MODELS}
_MODEL_BY_ID: Dict[str, Dict] = {m["id"]: m for m in MODELS}
_ID_TO_ALIAS: Dict[str, str] = {m["id"]: m["model"] for m in MODELS}

_DEFAULT_MODEL = "kimi-k2.5"


# ═══════════════════════════════════════════════════════════
# §4 — MODEL RESOLVER
# ═══════════════════════════════════════════════════════════
def _resolve_model(m: Optional[str]) -> str:
    """Resolve alias/ID → full @cf/@hf ID."""
    if not m:
        return _MODEL_BY_ALIAS[_DEFAULT_MODEL]["id"]
    
    m = m.strip()
    
    # Direct ID match
    if m.startswith("@cf/") or m.startswith("@hf/"):
        if m in _MODEL_BY_ID:
            return m
        return m  # Return as-is if not found
    
    # Alias match (case-insensitive)
    low = m.lower()
    if low in _MODEL_BY_ALIAS:
        return _MODEL_BY_ALIAS[low]["id"]
    
    # Partial match in alias
    for alias, model_data in _MODEL_BY_ALIAS.items():
        if low in alias.lower():
            return model_data["id"]
    
    # Partial match in ID
    for model_id in _MODEL_BY_ID.keys():
        if low in model_id.lower():
            return model_id
    
    return m


def _get_model_info(m: Optional[str]) -> Dict:
    """Get full model info dict."""
    model_id = _resolve_model(m)
    return _MODEL_BY_ID.get(model_id, {
        "name": model_id,
        "owner": "Unknown",
        "model": model_id,
        "id": model_id,
        "context_window": 0,
        "reasoning": False
    })


# ═══════════════════════════════════════════════════════════
# §5 — SSE PARSER
# ═══════════════════════════════════════════════════════════
def _parse_sse(line: str) -> tuple[str, bool]:
    """Parse one SSE 'data:' line → (token, is_done)."""
    line = line.strip()
    if not line.startswith("data:"):
        return "", False
    data = line[5:].strip()
    if data == "[DONE]":
        return "", True
    try:
        chunk   = json.loads(data)
        if "error" in chunk:
            return "", True
        choices = chunk.get("choices", [])
        if not choices:
            return "", False
        delta = choices[0].get("delta", {})
        return delta.get("content", "") or "", False
    except (json.JSONDecodeError, KeyError, IndexError):
        return "", False


# ═══════════════════════════════════════════════════════════
# §6 — SESSION FACTORY
# ═══════════════════════════════════════════════════════════
def _make_session() -> aiohttp.ClientSession:
    """Create a fresh session with OS-native DNS resolution and auth headers."""
    connector = aiohttp.TCPConnector(
        resolver=aiohttp.resolver.ThreadedResolver(),
        limit=20,
        limit_per_host=5,
        ttl_dns_cache=300,
        keepalive_timeout=30,
        force_close=False,
    )
    return aiohttp.ClientSession(
        connector=connector,
        headers=_get_headers(),
    )


# ═══════════════════════════════════════════════════════════
# §7 — PROVIDER
# ═══════════════════════════════════════════════════════════
class DevsdoProvider:
    """
    ☁️  DevsDo — Async Cloudflare AI Playground Provider

    ┌─────────────────────────────────────────────────────┐
    │  58 models · SSE streaming · Private Access         │
    │  Backend: HuggingFace Space (OpenAI-compatible)     │
    │                                                     │
    │  dp = DevsdoProvider()                              │
    │                                                     │
    │  async for tok in dp.chat(data="Hello!"):           │
    │      print(tok, end="", flush=True)                 │
    │                                                     │
    │  # Via Completion (auto-bridges async→sync)         │
    │  for tok in Completion.chat(                        │
    │      model="devsdo:kimi-k2.5", data="Hello!"       │
    │  ):                                                 │
    │      print(tok, end="", flush=True)                 │
    └─────────────────────────────────────────────────────┘
    """

    def __init__(
        self,
        model:       str   = None,
        system:      str   = "You are a helpful assistant.",
        temperature: float = 0.7,
        max_tokens:  int   = 4096,
        timeout:     int   = 120,
        retries:     int   = 2,
    ):
        self.model       = _resolve_model(model)
        self.system      = system
        self.temperature = temperature
        self.max_tokens  = max_tokens
        self.timeout     = timeout
        self.retries     = retries

    # ═══════════════════════════════════════════════════
    # INTERNAL — Build messages for API request
    # ═══════════════════════════════════════════════════
    def _build_msgs(
        self,
        data:     Optional[str],
        messages: Optional[list[dict]],
        system:   Optional[str],
    ) -> list[dict]:
        use_system = system if system is not None else self.system

        # Build clean message list
        clean_msgs = []
        if messages:
            for m in messages:
                role, content = m.get("role", ""), m.get("content", "")
                if role in ("user", "assistant"):
                    clean_msgs.append({"role": role, "content": content})
                elif role == "system" and system is None:
                    use_system = content
        elif data:
            clean_msgs.append({"role": "user", "content": data})

        # Build final message list with system prompt
        result = []
        if use_system:
            result.append({"role": "system", "content": use_system})
        result.extend(clean_msgs)
        return result

    # ═══════════════════════════════════════════════════
    # INTERNAL — SSE stream with retry
    # ═══════════════════════════════════════════════════
    async def _stream(self, payload: dict) -> AsyncGenerator[str, None]:
        """POST /v1/chat/completions, parse SSE, yield tokens."""
        session = _make_session()
        last_err = ""

        try:
            for attempt in range(1 + self.retries):
                resp = None
                try:
                    resp = await session.post(
                        _API_CHAT,
                        json=payload,
                        timeout=aiohttp.ClientTimeout(
                            total=self.timeout,
                            sock_connect=30,
                            sock_read=self.timeout,
                        ),
                    )

                    if resp.status == 200:
                        # ── Stream SSE line by line ───────
                        while True:
                            raw = await resp.content.readline()
                            if not raw:
                                break
                            line = raw.decode("utf-8", errors="replace").strip()
                            if not line:
                                continue
                            tok, done = _parse_sse(line)
                            if done:
                                return
                            if tok:
                                yield tok
                        return  # EOF

                    # ── Non-200 ───────────────────────────
                    body = await resp.text()
                    last_err = f"HTTP {resp.status}: {body[:200]}"

                    if resp.status in _FATAL_CODES:
                        raise RuntimeError(f"Fatal error: {last_err}")

                    if resp.status in _RETRY_CODES and attempt < self.retries:
                        wait = min(1.5 * (attempt + 1) + random.uniform(0, 1), 15)
                        await asyncio.sleep(wait)
                        continue

                    raise RuntimeError(last_err)

                except (RuntimeError, GeneratorExit):
                    raise
                except (
                    aiohttp.ClientError,
                    asyncio.TimeoutError,
                    OSError,
                    ConnectionError,
                ) as exc:
                    last_err = str(exc)
                    if attempt < self.retries:
                        await asyncio.sleep(1.0 * (attempt + 1))
                        continue
                    raise RuntimeError(
                        f"Connection failed: {last_err}"
                    ) from exc

                finally:
                    if resp is not None and not resp.closed:
                        resp.close()

            raise RuntimeError(f"All retries exhausted: {last_err}")

        finally:
            try:
                await session.close()
            except Exception:
                pass

    # ═══════════════════════════════════════════════════
    # ★  CHAT  (async generator)
    # ═══════════════════════════════════════════════════
    async def chat(
        self,
        data:        str        = None,
        messages:    list[dict] = None,
        model:       str        = None,
        system:      str        = None,
        temperature: float      = None,
        max_tokens:  int        = None,
    ) -> AsyncGenerator[str, None]:
        """
        Async-stream tokens from Cloudflare AI Playground.

        Args:
            data       : Text prompt (ignored if messages given)
            messages   : OpenAI [{role, content}] list
            model      : Short alias or full @cf/@hf ID
            system     : System prompt override
            temperature: Sampling temperature (0.0 – 2.0)
            max_tokens : Max response tokens

        Yields:
            str: Response tokens
        """
        if not data and not messages:
            raise ValueError("Provide 'data' or 'messages'")

        use_model  = _resolve_model(model) if model else self.model
        use_tokens = max_tokens  if max_tokens  is not None else self.max_tokens
        use_temp   = temperature if temperature is not None else self.temperature

        # ── Build message array and API payload ───────
        msgs = self._build_msgs(data, messages, system)
        payload = {
            "model":       use_model,
            "messages":    msgs,
            "stream":      True,
            "temperature": use_temp,
        }
        if use_tokens:
            payload["max_tokens"] = use_tokens

        # ── Stream tokens ─────────────────────────────
        async for token in self._stream(payload):
            yield token

    # ═══════════════════════════════════════════════════
    # HEALTH CHECK
    # ═══════════════════════════════════════════════════
    async def health(self) -> dict:
        """Check server health. Returns status dict."""
        session = _make_session()
        try:
            async with session.get(
                _API_HEALTH,
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                if resp.status == 200:
                    return await resp.json()
                return {"status": "error", "code": resp.status}
        except Exception as e:
            return {"status": "error", "error": str(e)}
        finally:
            try:
                await session.close()
            except Exception:
                pass

    # ═══════════════════════════════════════════════════
    # SETTERS (chainable)
    # ═══════════════════════════════════════════════════
    def set_model(self, m: str) -> "DevsdoProvider":
        self.model = _resolve_model(m)
        return self

    def set_system(self, p: str) -> "DevsdoProvider":
        self.system = p
        return self

    def set_temperature(self, t: float) -> "DevsdoProvider":
        self.temperature = max(0.0, min(2.0, t))
        return self

    def set_max_tokens(self, n: int) -> "DevsdoProvider":
        self.max_tokens = n
        return self

    # ═══════════════════════════════════════════════════
    # MODEL LISTING & INFO
    # ═══════════════════════════════════════════════════
    @staticmethod
    def available_models() -> list[str]:
        """Return list of all model aliases."""
        return [m["model"] for m in MODELS]

    @staticmethod
    def get_all_models() -> list[dict]:
        """Return complete model registry."""
        return MODELS.copy()

    @staticmethod
    def get_model_id(alias: str) -> str:
        """Get full @cf/@hf ID from alias."""
        return _resolve_model(alias)

    @staticmethod
    def get_model_info(model: str) -> dict:
        """Get full model info dict."""
        return _get_model_info(model)

    @staticmethod
    def get_context_window(model: str) -> int:
        """Get context window size for a model."""
        info = _get_model_info(model)
        return info.get("context_window", 0)

    @staticmethod
    def is_reasoning_model(model: str) -> bool:
        """Check if model supports reasoning."""
        info = _get_model_info(model)
        return info.get("reasoning", False)

    @staticmethod
    def get_reasoning_models() -> list[str]:
        """Return list of reasoning model aliases."""
        return [m["model"] for m in MODELS if m["reasoning"]]

    @staticmethod
    def filter_models(
        min_context: int = None,
        max_context: int = None,
        reasoning: bool = None,
        owner: str = None
    ) -> list[dict]:
        """
        Filter models by criteria.
        
        Args:
            min_context: Minimum context window size
            max_context: Maximum context window size
            reasoning: Filter by reasoning capability
            owner: Filter by owner name (case-insensitive partial match)
        
        Returns:
            List of matching model dicts
        """
        results = MODELS.copy()
        
        if min_context is not None:
            results = [m for m in results if m["context_window"] >= min_context]
        
        if max_context is not None:
            results = [m for m in results if m["context_window"] <= max_context]
        
        if reasoning is not None:
            results = [m for m in results if m["reasoning"] == reasoning]
        
        if owner is not None:
            owner_low = owner.lower()
            results = [m for m in results if owner_low in m["owner"].lower()]
        
        return results

    # ═══════════════════════════════════════════════════
    # LIFECYCLE
    # ═══════════════════════════════════════════════════
    def close(self):
        """No persistent resources to clean up."""
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def __repr__(self):
        alias = _ID_TO_ALIAS.get(self.model, self.model)
        return f"DevsdoProvider(model={alias!r})"


# ═══════════════════════════════════════════════════════════
# §8 — CONVENIENCE FUNCTIONS
# ═══════════════════════════════════════════════════════════
def list_models() -> None:
    """Print all available models in a formatted table."""
    print("\n" + "="*100)
    print(f"{'MODEL':<25} {'OWNER':<20} {'CONTEXT':<12} {'REASONING':<10} {'ID':<43}")
    print("="*100)
    
    for m in MODELS:
        ctx = f"{m['context_window']:,}" if m['context_window'] else "N/A"
        reasoning = "✓" if m['reasoning'] else "✗"
        print(f"{m['model']:<25} {m['owner']:<20} {ctx:<12} {reasoning:<10} {m['id']:<43}")
    
    print("="*100)
    print(f"Total: {len(MODELS)} models\n")


def get_model_by_alias(alias: str) -> dict:
    """Get model info by alias (case-insensitive)."""
    return _get_model_info(alias)


# ═══════════════════════════════════════════════════════════
# §9 — MODULE EXPORTS
# ═══════════════════════════════════════════════════════════
__all__ = [
    "DevsdoProvider",
    "MODELS",
    "list_models",
    "get_model_by_alias",
]


# ═══════════════════════════════════════════════════════════
# §10 — CLI DEMO
# ═══════════════════════════════════════════════════════════
if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1 and sys.argv[1] == "list":
        list_models()
    else:
        print(__doc__)
        print("\n💡 Run with 'python DevsDo.py list' to see all available models")
        list_models()
