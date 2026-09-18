"""
══════════════════════════════════════════════════════════════
  🌐  mCloudFlare Provider

  Text generation via multi-modal.ai.cloudflare.com
  Full model registry · SSE streaming · Instant · Zero setup

  Usage:
      from providers import mCloudFlareProvider

      mc = mCloudFlareProvider()

      for token in mc.chat(data="Hello!"):
          print(token, end="", flush=True)

  Works with Client + Completion system:
      for tok in Completion.chat(model="cf", data="Hello!"):
          print(tok, end="", flush=True)
══════════════════════════════════════════════════════════════
"""

from __future__ import annotations

import json
import time
import random
import threading
from typing import Optional, Generator, List, Dict, Union

from curl_cffi.requests import Session as CurlSession


# ═══════════════════════════════════════════════════════════
# §1 — CONSTANTS
# ═══════════════════════════════════════════════════════════
_API  = "https://multi-modal.ai.cloudflare.com/api/inference"
_BASE = "https://multi-modal.ai.cloudflare.com"

_BASE_HEADERS = {
    "Accept":             "text/event-stream",
    "Accept-Encoding":    "gzip, deflate, br",
    "Accept-Language":    "en-US,en;q=0.9",
    "Content-Type":       "application/json",
    "Origin":             _BASE,
    "Referer":            f"{_BASE}/",
    "Sec-Ch-Ua":          '"Chromium";v="146","Google Chrome";v="146","Not-A.Brand";v="24"',
    "Sec-Ch-Ua-Mobile":   "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest":     "empty",
    "Sec-Fetch-Mode":     "cors",
    "Sec-Fetch-Site":     "same-origin",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/146.0.0.0 Safari/537.36"
    ),
}

_RETRY_CODES = {429, 500, 502, 503, 504, 520, 521, 522, 523, 524}
_FATAL_CODES = {400, 401, 403, 404, 405, 422}


# ═══════════════════════════════════════════════════════════
# §2 — TEXT MODEL REGISTRY
# ═══════════════════════════════════════════════════════════
TEXT_MODELS: dict[str, str] = {
    "llama-3.2-3b": "@cf/meta/llama-3.2-3b-instruct",
    "llama-3.1-8b": "@cf/meta/llama-3.1-8b-instruct-fast",
    "gemma-7b":     "@hf/google/gemma-7b-it",
    "mistral":      "@hf/mistral/mistral-7b-instruct-v0.2",
}

_DEFAULT = "llama-3.2-3b"


def _resolve(m: Optional[str]) -> str:
    """Resolve model alias to full model ID."""
    if not m:
        return TEXT_MODELS[_DEFAULT]
    if m.startswith("@cf/") or m.startswith("@hf/"):
        return m
    return TEXT_MODELS.get(m.lower().strip(), m)


# ═══════════════════════════════════════════════════════════
# §3 — SSE PARSER
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
        tok = json.loads(data).get("response", "")
        return (tok or ""), False
    except (json.JSONDecodeError, AttributeError):
        return "", False


# ═══════════════════════════════════════════════════════════
# §4 — SINGLETON SESSION  (curl_cffi · sync · thread-safe)
# ═══════════════════════════════════════════════════════════
class _Session:
    _session: Optional[CurlSession] = None
    _lock:    threading.Lock        = threading.Lock()

    @classmethod
    def get(cls) -> CurlSession:
        with cls._lock:
            if cls._session is None:
                cls._session = CurlSession(
                    headers=_BASE_HEADERS,
                    impersonate="chrome120",
                )
            return cls._session

    @classmethod
    def reset(cls) -> CurlSession:
        with cls._lock:
            if cls._session:
                try:
                    cls._session.close()
                except Exception:
                    pass
            cls._session = None
        time.sleep(0.25)
        return cls.get()

    @classmethod
    def close(cls):
        with cls._lock:
            if cls._session:
                try:
                    cls._session.close()
                except Exception:
                    pass
            cls._session = None


# ═══════════════════════════════════════════════════════════
# §5 — MESSAGE BUILDER
# ═══════════════════════════════════════════════════════════
def _build_messages(data: Optional[str], messages: Optional[List[Dict]], system: str) -> List[Dict]:
    """Build message list from data or messages with system prompt."""
    result = []
    
    # Add system message if provided
    if system:
        result.append({"role": "system", "content": system})
    
    # Add messages or data
    if messages:
        # Filter out system messages (we already handled system separately)
        for m in messages:
            role = m.get("role", "")
            content = m.get("content", "")
            if role in ("user", "assistant"):
                result.append({"role": role, "content": content})
    elif data:
        result.append({"role": "user", "content": data})
        
    return result


# ═══════════════════════════════════════════════════════════
# §6 — PROVIDER
# ═══════════════════════════════════════════════════════════
class mCloudFlareProvider:
    """
    🌐  mCloudFlare — Cloudflare Workers AI (text)

    ┌─────────────────────────────────────────────────────┐
    │  mc = mCloudFlareProvider()                         │
    │                                                     │
    │  for tok in mc.chat(data="Hello!"):                 │
    │      print(tok, end="", flush=True)                 │
    │                                                     │
    │  for tok in mc.chat(messages=[                      │
    │      {"role":"system", "content":"You are Bob"},    │
    │      {"role":"user",   "content":"Name?"},          │
    │  ]):                                                │
    │      print(tok, end="", flush=True)                 │
    └─────────────────────────────────────────────────────┘
    """

    def __init__(
        self,
        model:       str   = None,
        system:      str   = "You are a helpful assistant.",
        temperature: float = 1.0,
        max_tokens:  int   = 2048,
        timeout:     int   = 90,
        retries:     int   = 2,
    ):
        self.model       = _resolve(model)
        self.system      = system
        self.temperature = temperature
        self.max_tokens  = max_tokens
        self.timeout     = timeout
        self.retries     = retries

    # ── SSE stream with retry ─────────────────────────
    def _stream(self, payload: Dict) -> Generator[str, None, None]:
        """Stream tokens from CloudFlare Workers AI with retry logic."""
        session  = _Session.get()
        last_err = ""
        resp     = None

        for attempt in range(1 + self.retries):
            try:
                resp = session.post(
                    _API,
                    json=payload,
                    headers=_BASE_HEADERS,
                    timeout=self.timeout,
                    stream=True,
                )

                if resp.status_code == 200:
                    break

                try:
                    body = resp.text[:200]
                except Exception:
                    body = ""
                last_err = f"HTTP {resp.status_code}: {body}"

                if resp.status_code in _FATAL_CODES:
                    raise RuntimeError(f"Fatal error: {last_err}")

                if resp.status_code in _RETRY_CODES and attempt < self.retries:
                    wait = min(1.5 * (attempt + 1) + random.uniform(0, 1), 15)
                    time.sleep(wait)
                    session = _Session.reset()
                    continue

                raise RuntimeError(last_err)

            except RuntimeError:
                raise
            except Exception as exc:
                last_err = str(exc)
                session  = _Session.reset()
                if attempt < self.retries:
                    time.sleep(1.0 * (attempt + 1))
                    continue
                raise RuntimeError(f"Connection failed: {last_err}") from exc

        if resp is None or resp.status_code != 200:
            raise RuntimeError(f"All retries exhausted: {last_err}")

        # Process SSE stream
        buf = ""
        for chunk in resp.iter_content():
            if isinstance(chunk, bytes):
                chunk = chunk.decode("utf-8", errors="replace")
            buf += chunk
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                tok, done = _parse_sse(line)
                if done:
                    return
                if tok:
                    yield tok

        # Process any remaining buffer content
        for line in buf.split("\n"):
            tok, done = _parse_sse(line)
            if done:
                return
            if tok:
                yield tok

    # ═══════════════════════════════════════════════════
    # ★  CHAT  (sync generator)
    # ═══════════════════════════════════════════════════
    def chat(
        self,
        data:        str        = None,
        messages:    List[Dict] = None,
        model:       str        = None,
        system:      str        = None,
        temperature: float      = None,
        max_tokens:  int        = None,
    ) -> Generator[str, None, None]:
        """
        Stream text tokens from Cloudflare Workers AI.

        Args:
            data       : Text prompt (ignored if messages given)
            messages   : OpenAI [{role, content}] list
            model      : Short alias or full @cf/@hf ID
            system     : System prompt override
            temperature: Sampling temperature
            max_tokens : Max tokens

        Yields:
            str: Response tokens
        """
        if not data and not messages:
            raise ValueError("Provide 'data' or 'messages'")

        # Resolve parameters
        use_model  = _resolve(model) if model else self.model
        use_tokens = max_tokens if max_tokens is not None else self.max_tokens
        use_temp   = temperature if temperature is not None else self.temperature
        use_system = system if system is not None else self.system

        # Build message list
        msgs = _build_messages(data, messages, use_system)

        # Create API payload
        payload = {
            "model":      use_model,
            "messages":   msgs,
            "max_tokens": use_tokens,
            "temperature": use_temp,
            "stream":     True,
        }

        # Stream and return tokens
        for token in self._stream(payload):
            yield token

    # ── Setters (chainable) ─────────────────────────────
    def set_model(self, m: str) -> "mCloudFlareProvider":
        self.model = _resolve(m)
        return self

    def set_system(self, p: str) -> "mCloudFlareProvider":
        self.system = p
        return self

    def set_temperature(self, t: float) -> "mCloudFlareProvider":
        self.temperature = max(0.0, min(2.0, t))
        return self

    def set_max_tokens(self, n: int) -> "mCloudFlareProvider":
        self.max_tokens = n
        return self

    # ── Model info ────────────────────────────────────────
    @staticmethod
    def available_models() -> List[str]:
        """Return list of available model aliases."""
        return list(TEXT_MODELS.keys())

    # ── Lifecycle ────────────────────────────────────────
    def close(self):
        """No-op for compatibility."""
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    async def __aenter__(self):
        """Support async context manager for compatibility."""
        return self

    async def __aexit__(self, *_):
        self.close()

    def __repr__(self):
        return f"mCloudFlareProvider(model={self.model!r})"