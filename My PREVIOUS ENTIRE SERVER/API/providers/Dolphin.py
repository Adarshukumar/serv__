"""
══════════════════════════════════════════════════════════════
  🐬  Dolphin AI Provider  (Async)

  Async streaming text generation via chat.dphn.ai
  Supports file attachments (images + text)
  AsyncGenerator-based · Clean API · Zero setup

  Note: Dolphin API does NOT support "system" role.
        System prompts auto-convert to user format:
        → [SYSTEM] YOU HAVE TO ACT AS : <prompt>

  Usage:
      from providers import DolphinProvider

      dp = DolphinProvider()

      async for token in dp.chat(data="Hello!"):
          print(token, end="", flush=True)

      # With system prompt
      async for token in dp.chat(
          system="You are a helpful assistant",
          data="Tell me a story"
      ):
          print(token, end="", flush=True)

      # With messages
      async for token in dp.chat(
          messages=[
              {"role": "user",      "content": "Name?"},
              {"role": "assistant", "content": "Anshu!"},
              {"role": "user",      "content": "Fun fact?"},
          ]
      ):
          print(token, end="", flush=True)
══════════════════════════════════════════════════════════════
"""

from __future__ import annotations

import base64
import json
import asyncio
from pathlib import Path
from typing import Optional, AsyncGenerator, Union, List, Dict

import aiohttp
import aiofiles


# ═══════════════════════════════════════════════════════════
# §1 — CONSTANTS
# ═══════════════════════════════════════════════════════════
_BASE = "https://chat.dphn.ai"
_API  = "/api/chat"

_SUPPORTED_IMAGES = {".png", ".jpg", ".jpeg"}
_SUPPORTED_TEXT   = {".txt"}
_SUPPORTED_ALL    = _SUPPORTED_IMAGES | _SUPPORTED_TEXT

_MIME_MAP = {
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
}

_SYS_PREFIX = "[SYSTEM] YOU HAVE TO ACT AS :"

_BASE_HEADERS = {
    "Accept":          "text/event-stream",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control":   "no-cache",
    "Content-Type":    "application/json",
    "Origin":          _BASE,
    "Referer":         f"{_BASE}/",
    "Sec-Fetch-Dest":  "empty",
    "Sec-Fetch-Mode":  "cors",
    "Sec-Fetch-Site":  "same-origin",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/145.0.0.0 Safari/537.36"
    ),
}


# ═══════════════════════════════════════════════════════════
# §2 — MODEL ENUM
# ═══════════════════════════════════════════════════════════
class Model:
    DOLPHIN_24B = "dolphinserver:24B"
    DP3_FLASH   = "dp3:flash"
    
    @staticmethod
    def resolve(val) -> str:
        if val is None:
            return Model.DOLPHIN_24B
        if val in (Model.DOLPHIN_24B, Model.DP3_FLASH):
            return val
        return str(val)


# ═══════════════════════════════════════════════════════════
# §3 — SYSTEM PROMPT CONVERTER
# ═══════════════════════════════════════════════════════════
class SystemConverter:
    """
    Convert system messages → user messages.
    
    The Dolphin API ignores role:"system", so we
    rewrite them as user messages with a special prefix
    that instructs the model to adopt the persona.
    """

    @staticmethod
    def convert_messages(messages: List[Dict]) -> List[Dict]:
        """
        Process a full message list.
        System messages → user messages with prefix.
        Also merges consecutive user messages.
        """
        converted: List[Dict] = []

        for msg in messages:
            role    = msg.get("role", "")
            content = msg.get("content", "")

            if role == "system":
                # ── Convert system → user with prefix ──
                converted.append({
                    "role":    "user",
                    "content": f"{_SYS_PREFIX} {content}",
                })
            else:
                converted.append(dict(msg))

        # ── Merge consecutive user messages ──
        merged: List[Dict] = []
        for msg in converted:
            if (merged
                    and msg.get("role") == "user"
                    and merged[-1].get("role") == "user"
                    and isinstance(merged[-1].get("content"), str)
                    and isinstance(msg.get("content"), str)):
                merged[-1]["content"] += "\n\n" + msg["content"]
            else:
                merged.append(msg)

        return merged

    @staticmethod
    def wrap_system(system_prompt: str) -> Dict:
        """Wrap a standalone system prompt string as a user message."""
        return {
            "role":    "user",
            "content": f"{_SYS_PREFIX} {system_prompt}",
        }


# ═══════════════════════════════════════════════════════════
# §4 — ATTACHMENT HANDLER  (Async file I/O)
# ═══════════════════════════════════════════════════════════
class Attachment:

    @staticmethod
    async def _read_image_b64(path: Path) -> str:
        mime = _MIME_MAP.get(path.suffix.lower(), "image/png")
        async with aiofiles.open(path, "rb") as f:
            raw = await f.read()
        b64 = base64.b64encode(raw).decode("ascii")
        return f"data:{mime};base64,{b64}"

    @staticmethod
    async def _read_text(path: Path) -> str:
        async with aiofiles.open(path, "r", encoding="utf-8", errors="replace") as f:
            return await f.read()

    @staticmethod
    def _validate(path: Path):
        if not path.exists():
            raise FileNotFoundError(f"File not found: {path}")
        if path.suffix.lower() not in _SUPPORTED_ALL:
            raise ValueError(
                f"Unsupported: {path.suffix} — "
                f"Use: {', '.join(sorted(_SUPPORTED_ALL))}"
            )

    @staticmethod
    async def process(text: str, files: List) -> Union[str, List[Dict]]:
        """
        Process text + file attachments → content payload.

        Images  → base64 image_url parts
        .txt    → appended to text content
        No files → returns plain text string
        """
        if not files:
            return text

        parts: List[Dict] = []
        extra: List[str]  = []

        for f in files:
            p = Path(f)
            Attachment._validate(p)
            s = p.suffix.lower()

            if s in _SUPPORTED_IMAGES:
                b64_url = await Attachment._read_image_b64(p)
                parts.append({
                    "type":      "image_url",
                    "image_url": {"url": b64_url},
                })
            elif s in _SUPPORTED_TEXT:
                content = await Attachment._read_text(p)
                extra.append(f"\n\n--- {p.name} ---\n{content}")

        full_text = text + "".join(extra)
        result: List[Dict] = [{"type": "text", "text": full_text}]
        result.extend(parts)
        return result


# ═══════════════════════════════════════════════════════════
# §5 — SSE PARSER
# ═══════════════════════════════════════════════════════════
def _parse_sse(line: str) -> tuple[Optional[str], bool]:
    """Parse one SSE 'data:' line → (token, is_done)."""
    line = line.strip()
    if not line or not line.startswith("data:"):
        return None, False
    
    data = line[5:].strip()
    if data == "[DONE]":
        return None, True
        
    try:
        obj = json.loads(data)
        choices = obj.get("choices", [])
        if not choices:
            return None, False
            
        delta = choices[0].get("delta", {})
        content = delta.get("content", "")
        finish = choices[0].get("finish_reason")
        
        return content, bool(finish)
    except (json.JSONDecodeError, KeyError, IndexError):
        return None, False


# ═══════════════════════════════════════════════════════════
# §6 — INJECTION HELPER  (Async)
# ═══════════════════════════════════════════════════════════
class _Inject:

    @staticmethod
    async def attachment(messages: List[Dict], files: List) -> List[Dict]:
        """Inject attachments into the LAST user message."""
        if not files or not messages:
            return messages

        result = list(messages)

        for i in range(len(result) - 1, -1, -1):
            if result[i].get("role") == "user":
                text = result[i].get("content", "")
                if isinstance(text, list):
                    text = next(
                        (p.get("text", "") for p in text if p.get("type") == "text"),
                        ""
                    )
                result[i] = {
                    "role":    "user",
                    "content": await Attachment.process(text, files),
                }
                break

        return result


# ═══════════════════════════════════════════════════════════
# §7 — SESSION FACTORY
# ═══════════════════════════════════════════════════════════
def _make_session() -> aiohttp.ClientSession:
    """Create a fresh session for each API call."""
    connector = aiohttp.TCPConnector(
        limit=20,
        limit_per_host=5,
        ttl_dns_cache=300,
        keepalive_timeout=60,
    )
    return aiohttp.ClientSession(
        connector=connector,
        headers=_BASE_HEADERS,
    )


# ═══════════════════════════════════════════════════════════
# §8 — MAIN PROVIDER
# ═══════════════════════════════════════════════════════════
class DolphinProvider:
    """
    🐬 Dolphin AI — Async Text Generation Provider

    ┌───────────────────────────────────────────────────────┐
    │  dp = DolphinProvider()                               │
    │                                                       │
    │  async for t in dp.chat(data="Hello!"):               │
    │      print(t, end="")                                 │
    │                                                       │
    │  # With system prompt                                 │
    │  async for t in dp.chat(                              │
    │      system="You are a helpful assistant",            │
    │      data="Tell me a story"                           │
    │  ):                                                   │
    │      print(t, end="")                                 │
    │                                                       │
    │  # With attachments                                   │
    │  async for t in dp.chat(                              │
    │      data="What's in this?",                          │
    │      attachment=["photo.png"],                        │
    │  ):                                                   │
    │      print(t, end="")                                 │
    └───────────────────────────────────────────────────────┘
    """

    def __init__(
        self,
        model:    str = Model.DOLPHIN_24B,
        system:   str = "",
        timeout:  int = 120,
        retries:  int = 3,
    ):
        self.model    = Model.resolve(model)
        self.template = "creative"  # Default to creative template
        self.system   = system
        self.timeout  = timeout
        self.retries  = retries

    # ─────────────────────────────────────────────────
    # Payload builder
    # ─────────────────────────────────────────────────
    def _payload(
        self,
        messages: List[Dict],
        model:    Optional[str] = None,
    ) -> Dict:
        return {
            "messages": messages,
            "model":    model or self.model,
            "template": self.template,
        }

    # ─────────────────────────────────────────────────
    # Raw async SSE stream with retry
    # ─────────────────────────────────────────────────
    async def _stream(
        self,
        messages: List[Dict],
        model:    Optional[str] = None,
    ) -> AsyncGenerator[str, None]:
        session  = _make_session()
        payload  = self._payload(messages, model)
        last_err = ""
        resp     = None

        try:
            for attempt in range(1 + self.retries):
                try:
                    resp = await session.post(
                        f"{_BASE}{_API}",
                        json=payload,
                        timeout=aiohttp.ClientTimeout(total=self.timeout),
                    )

                    if resp.status == 200:
                        break

                    body     = await resp.text()
                    last_err = f"HTTP {resp.status}: {body[:200]}"

                    if resp.status in {400, 401, 403, 404, 405, 422}:
                        raise RuntimeError(f"Fatal error: {last_err}")

                    if attempt < self.retries:
                        await asyncio.sleep(2.0 * (attempt + 1))
                        continue

                    raise RuntimeError(last_err)

                except RuntimeError:
                    raise
                except Exception as exc:
                    last_err = str(exc)
                    if attempt < self.retries:
                        await asyncio.sleep(2.0 * (attempt + 1))
                        continue
                    raise RuntimeError(f"Connection failed: {last_err}") from exc

            if resp is None or resp.status != 200:
                raise RuntimeError(f"All retries exhausted: {last_err}")

            # ── Read SSE lines ──
            while not resp.content.at_eof():
                line_bytes = await resp.content.readline()
                if not line_bytes:
                    break
                line = line_bytes.decode("utf-8", errors="replace")
                token, done = _parse_sse(line)
                if token:
                    yield token
                if done:
                    break
                
        finally:
            if resp is not None and not resp.closed:
                resp.close()
            await session.close()

    # ═══════════════════════════════════════════════════
    # ★ CHAT  (async generator)
    # ═══════════════════════════════════════════════════
    async def chat(
        self,
        data:       str                    = None,
        messages:   List[Dict]             = None,
        model:      str                    = None,
        system:     str                    = None,
        attachment: List[Union[str, Path]] = None,
    ) -> AsyncGenerator[str, None]:
        """
        Send a message → async yield response tokens.

        Args:
            data       : Simple prompt (ignored if messages given)
            messages   : OpenAI-style [{role, content}]
            model      : Override model
            system     : Override system prompt
            attachment : File paths [.png, .jpg, .jpeg, .txt]

        Yields:
            str: Each token as it streams

        Note:
            System prompts are auto-converted:
            {"role":"system", "content":"X"}
            →
            {"role":"user", "content":"[SYSTEM] YOU HAVE TO ACT AS : X"}
        """
        if not messages and not data:
            raise ValueError("Provide 'messages' or 'data'")

        # ── Resolve overrides ──────────────────────────
        use_model  = Model.resolve(model) if model else self.model
        use_system = system if system is not None else self.system

        # ── Build message list ─────────────────────────
        if messages:
            # Use provided messages directly
            send_msgs = list(messages)
        else:
            # Create from data and system
            send_msgs = []
            if use_system:
                send_msgs.append({"role": "system", "content": use_system})
            send_msgs.append({"role": "user", "content": data})

        # ── Convert system → user and merge consecutive user messages ──
        send_msgs = SystemConverter.convert_messages(send_msgs)

        # ── Inject attachments (async file reads) ─────
        if attachment:
            send_msgs = await _Inject.attachment(send_msgs, attachment)

        # ── Stream tokens ─────────────────────────────
        async for token in self._stream(send_msgs, use_model):
            yield token

    # ═══════════════════════════════════════════════════
    # SETTERS (chainable)
    # ═══════════════════════════════════════════════════
    def set_model(self, model) -> "DolphinProvider":
        self.model = Model.resolve(model)
        return self

    def set_system(self, prompt: str) -> "DolphinProvider":
        self.system = prompt
        return self

    # ═══════════════════════════════════════════════════
    # INFO
    # ═══════════════════════════════════════════════════
    @staticmethod
    def available_models() -> List[str]:
        return [Model.DOLPHIN_24B, Model.DP3_FLASH]

    @staticmethod
    def supported_files() -> List[str]:
        return sorted(_SUPPORTED_ALL)

    # ── Lifecycle ────────────────────────────────────────
    def __repr__(self):
        return f"DolphinProvider(model={self.model!r}, template=creative)"

