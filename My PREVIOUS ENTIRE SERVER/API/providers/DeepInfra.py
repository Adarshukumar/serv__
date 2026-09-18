"""
══════════════════════════════════════════════════════════════
  🔷  DeepInfra Provider

  Streaming text generation via api.deepinfra.com
  20+ models · OpenAI-compatible SSE · Instant startup
  Singleton cloudscraper session · Auto-retry · Zero setup

  Usage:
      from providers import DeepInfraProvider

      di = DeepInfraProvider()

      for token in di.chat(data="Hello!"):
          print(token, end="", flush=True)
══════════════════════════════════════════════════════════════
"""

from __future__ import annotations

import json
import sys
import time
import random
from typing import Optional, Generator

import cloudscraper


# ═══════════════════════════════════════════════════════════
# §1 — CONSTANTS
# ═══════════════════════════════════════════════════════════
_API    = "https://api.deepinfra.com/v1/openai/chat/completions"
_ORIGIN = "https://g4f.dev"

_BASE_HEADERS = {
    "Accept":             "*/*",
    "Accept-Encoding":    "gzip, deflate, br, zstd",
    "Accept-Language":    "en-GB,en-US;q=0.9,en;q=0.8",
    "Connection":         "keep-alive",
    "Content-Type":       "application/json",
    "Origin":             _ORIGIN,
    "Referer":            _ORIGIN,
    "x-request-id":       "Ry3LRoEwEsPHJxUrUrYpfCzm",
    "sec-ch-ua":          '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
    "sec-ch-ua-mobile":   "?0",
    "sec-ch-ua-platform": '"Windows"',
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/145.0.0.0 Safari/537.36"
    ),
}

_RETRY_CODES = {429, 500, 502, 503, 504, 520, 521, 522, 523, 524}
_FATAL_CODES = {400, 401, 403, 404, 405, 422}


# ═══════════════════════════════════════════════════════════
# §2 — MODEL REGISTRY
# ═══════════════════════════════════════════════════════════
MODELS: dict[str, str] = {
    # ── StepFun ───────────────────────────────────────────
    "step-3.5-flash": "stepfun-ai/Step-3.5-Flash",

    # ── Qwen3.5 ───────────────────────────────────────────
    "qwen-3.5-397b-a17b": "Qwen/Qwen3.5-397B-A17B",
    "qwen-3.5-122b-a10b": "Qwen/Qwen3.5-122B-A10B",
    "qwen-3.5-35b-a3b": "Qwen/Qwen3.5-35B-A3B",
    "qwen-3.5-27b": "Qwen/Qwen3.5-27B",
    "qwen-3.5-9b": "Qwen/Qwen3.5-9B",
    "qwen-3.5-4b": "Qwen/Qwen3.5-4B",
    "qwen-3.5-2b": "Qwen/Qwen3.5-2B",
    "qwen-3.5-0.8b": "Qwen/Qwen3.5-0.8B",

    # ── NVIDIA ────────────────────────────────────────────
    "nvidia-nemotron-3-super-120b-a12b": "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B",
    "nemotron-3-nano-30b-a3b": "nvidia/Nemotron-3-Nano-30B-A3B",

    # ── Z.ai / GLM ────────────────────────────────────────
    "glm-5": "zai-org/GLM-5",
    "glm-4.7-flash": "zai-org/GLM-4.7-Flash",

    # ── MiniMax ───────────────────────────────────────────
    "minimax-m2.5": "MiniMaxAI/MiniMax-M2.5",

    # ── Qwen3 ─────────────────────────────────────────────
    "qwen-3-max": "Qwen/Qwen3-Max",
    "qwen-3-max-thinking": "Qwen/Qwen3-Max-Thinking",

    # ── Moonshot ──────────────────────────────────────────
    "kimi-k2.5": "moonshotai/Kimi-K2.5",

    # ── DeepSeek ──────────────────────────────────────────
    "deepseek-v3.2": "deepseek-ai/DeepSeek-V3.2",
}

_DEFAULT = "nemotron-3-nano-30b-a3b"


def _resolve(m: Optional[str]) -> str:
    """Resolve short alias or pass through full org/model path."""
    if not m:
        return MODELS[_DEFAULT]
    if "/" in m:
        return m    # already a full path
    return MODELS.get(m.lower().strip(), m)


# ═══════════════════════════════════════════════════════════
# §3 — SINGLETON SESSION MANAGER
# ═══════════════════════════════════════════════════════════
class _Session:
    _scraper: Optional[cloudscraper.CloudScraper] = None

    @classmethod
    def get(cls) -> cloudscraper.CloudScraper:
        if cls._scraper is None:
            cls._scraper = cloudscraper.create_scraper(
                browser={
                    "browser":  "chrome",
                    "platform": "windows",
                    "desktop":  True,
                }
            )
            cls._scraper.headers.update(_BASE_HEADERS)
        return cls._scraper

    @classmethod
    def reset(cls) -> cloudscraper.CloudScraper:
        """Force a fresh session (called after 521 / auth errors)."""
        try:
            if cls._scraper:
                cls._scraper.close()
        except Exception:
            pass
        cls._scraper = None
        return cls.get()


# ═══════════════════════════════════════════════════════════
# §4 — SSE PARSER  (OpenAI format)
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
        obj     = json.loads(data)
        choices = obj.get("choices", [])
        if not choices:
            return "", False
        delta = choices[0].get("delta", {})
        tok   = delta.get("content", "") or ""
        return tok, False
    except (json.JSONDecodeError, KeyError, IndexError, AttributeError):
        return "", False


# ═══════════════════════════════════════════════════════════
# §5 — PROVIDER
# ═══════════════════════════════════════════════════════════
class DeepInfraProvider:
    """
    🔷  DeepInfra — Streaming Text Generation

    ┌─────────────────────────────────────────────────────┐
    │  20+ models · OpenAI-compatible · Instant boot      │
    │  Cloudflare bypass via cloudscraper singleton.      │
    │                                                     │
    │  di = DeepInfraProvider()                           │
    │                                                     │
    │  for token in di.chat(data="Hello!"):               │
    │      print(token, end="", flush=True)               │
    └─────────────────────────────────────────────────────┘
    """

    def __init__(
        self,
        model:       str   = None,
        system:      str   = "You are a helpful assistant.",
        temperature: float = 0.7,
        max_tokens:  int   = 8192,
        timeout:     int   = 120,
        retries:     int   = 3,
    ):
        self.model       = _resolve(model)
        self.system      = system
        self.temperature = temperature
        self.max_tokens  = max_tokens
        self.timeout     = timeout
        self.retries     = retries

        # Warm up the shared session immediately
        _Session.get()

    # ── Build Messages ───────────────────────────────────
    def _build_msgs(
        self,
        data:     Optional[str],
        messages: Optional[list[dict]],
        system:   Optional[str],
    ) -> list[dict]:
        use_system = system if system is not None else self.system

        # Prepare clean list of messages
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

        # Build final message list
        result = []
        if use_system:
            result.append({"role": "system", "content": use_system})
        result.extend(clean_msgs)
        return result

    # ── SSE streaming with retry ─────────────────────────
    def _stream(self, payload: dict) -> Generator[str, None, None]:
        scraper  = _Session.get()
        last_err = ""

        for attempt in range(1 + self.retries):
            try:
                resp = scraper.post(
                    _API,
                    json=payload,
                    stream=True,
                    timeout=self.timeout,
                )

                if resp.status_code == 200:
                    break

                last_err = f"HTTP {resp.status_code}: {resp.text[:200]}"

                if resp.status_code in _FATAL_CODES:
                    raise RuntimeError(f"Fatal error: {last_err}")

                if resp.status_code in _RETRY_CODES and attempt < self.retries:
                    if resp.status_code == 521:
                        scraper = _Session.reset()
                    wait = min(2.0 * (2 ** attempt) + random.uniform(0, 1), 30)
                    time.sleep(wait)
                    continue

                raise RuntimeError(last_err)

            except RuntimeError:
                raise
            except Exception as exc:
                last_err = str(exc)
                scraper  = _Session.reset()
                if attempt < self.retries:
                    time.sleep(2.0 * (attempt + 1))
                    continue
                raise RuntimeError(f"Connection failed: {last_err}") from exc

        # Stream and parse SSE lines
        for raw_line in resp.iter_lines(decode_unicode=True):
            if not raw_line:
                continue
            tok, done = _parse_sse(raw_line)
            if done:
                return
            if tok:
                yield tok

    # ═══════════════════════════════════════════════════════
    # ★  CHAT
    # ═══════════════════════════════════════════════════════
    def chat(
        self,
        data:        str        = None,
        messages:    list[dict] = None,
        model:       str        = None,
        system:      str        = None,
        temperature: float      = None,
        max_tokens:  int        = None,
        stream:      bool       = True,
    ) -> Generator[str, None, None]:
        """
        Stream tokens from DeepInfra.

        Args:
            data       : Text prompt (ignored if messages given)
            messages   : OpenAI [{role, content}] list
            model      : Short alias or full org/model path
            system     : System prompt override
            temperature: Sampling temperature (0.0 – 2.0)
            max_tokens : Max tokens to generate

        Yields:
            str: Response tokens
        """
        if not data and not messages:
            raise ValueError("Provide 'data' or 'messages'")

        use_model  = _resolve(model) if model else self.model
        use_temp   = temperature if temperature is not None else self.temperature
        use_tokens = max_tokens  if max_tokens  is not None else self.max_tokens

        msgs = self._build_msgs(data, messages, system)

        payload = {
            "model":       use_model,
            "messages":    msgs,
            "temperature": use_temp,
            "max_tokens":  use_tokens,
            "stream":      True,
            "stream_options": {"include_usage": True},
        }

        return self._stream(payload)

    # ── Setters (chainable) ──────────────────────────────
    def set_model(self, m: str) -> "DeepInfraProvider":
        self.model = _resolve(m)
        return self

    def set_system(self, p: str) -> "DeepInfraProvider":
        self.system = p
        return self

    def set_temperature(self, t: float) -> "DeepInfraProvider":
        self.temperature = max(0.0, min(2.0, t))
        return self

    def set_max_tokens(self, n: int) -> "DeepInfraProvider":
        self.max_tokens = n
        return self
    
    # ── Models ───────────────────────────────────────────
    @staticmethod
    def available_models() -> list[str]:
        return list(MODELS.keys())

    # ── Lifecycle ────────────────────────────────────────
    def close(self):
        pass    # shared singleton session — don't close it

    def __enter__(self):  
        return self
        
    def __exit__(self, *_): 
        self.close()

    def __repr__(self):
        return f"DeepInfraProvider(model={self.model!r})"