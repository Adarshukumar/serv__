"""
══════════════════════════════════════════════════════════════
  💬  LLMChat Provider  (Async)

  Async streaming text generation via llmchat.in
  23 models · Thinking model support · Zero setup

  Uses curl_cffi for browser-like HTTP requests.
"""

from __future__ import annotations

import json
import asyncio
import random
import time
import threading
from dataclasses import dataclass
from typing import Optional, AsyncGenerator, Union, List, Dict, Any

from curl_cffi.requests import Session as CurlSession


# ═══════════════════════════════════════════════════════════
# §1 — MODEL DATACLASS
# ═══════════════════════════════════════════════════════════
@dataclass(frozen=True)
class LLMModel:
    """Single model definition."""
    tag: str
    name: str
    max_tokens: int

    @property
    def endpoint(self) -> str:
        return f"{self.tag}/{self.name}"

    @property
    def short(self) -> str:
        return self.name.split("/")[-1]

    def __str__(self) -> str:
        return self.name


# ═══════════════════════════════════════════════════════════
# §2 — MODEL REGISTRY
# ═══════════════════════════════════════════════════════════
MODELS: tuple[LLMModel, ...] = (
    LLMModel("@cf", "moonshotai/kimi-k2.5",                       200_000),
    LLMModel("@cf", "meta/llama-3.1-70b-instruct",                23_500),
    LLMModel("@cf", "qwen/qwq-32b",                               23_500),
    LLMModel("@cf", "meta/llama-3.3-70b-instruct-fp8-fast",       23_500),
    LLMModel("@cf", "qwen/qwen2.5-coder-32b-instruct",            32_500),
    LLMModel("@hf", "meta-llama/meta-llama-3-8b-instruct",         7_500),
    LLMModel("@cf", "meta/llama-3-8b-instruct",                    7_500),
    LLMModel("@cf", "meta/llama-2-7b-chat-int8",                   8_000),
    LLMModel("@cf", "meta/llama-3-8b-instruct-awq",                8_000),
    LLMModel("@cf", "google/gemma-2b-it-lora",                     8_000),
    LLMModel("@cf", "google/gemma-3-12b-it",                      79_500),
    LLMModel("@cf", "meta/llama-3.2-1b-instruct",                 59_500),
    LLMModel("@cf", "deepseek-ai/deepseek-r1-distill-qwen-32b",   79_500),
    LLMModel("@hf", "mistral/mistral-7b-instruct-v0.2",           14_500),
    LLMModel("@cf", "aisingapore/gemma-sea-lion-v4-27b-it",      100_000),
    LLMModel("@cf", "mistral/mistral-7b-instruct-v0.2-lora",      14_500),
    LLMModel("@cf", "meta/llama-4-scout-17b-16e-instruct",       100_000),
    LLMModel("@cf", "meta/llama-3.2-3b-instruct",                 79_500),
    LLMModel("@cf", "defog/sqlcoder-7b-2",                         9_500),
    LLMModel("@cf", "ibm-granite/granite-4.0-h-micro",           100_000),
    LLMModel("@cf", "qwen/qwen3-30b-a3b-fp8",                    32_500),
    LLMModel("@cf", "zai-org/glm-4.7-flash",                     100_000),
    LLMModel("@cf", "mistralai/mistral-small-3.1-24b-instruct",   76_500),
    LLMModel("@cf", "meta/llama-3.1-8b-instruct",                100_000),
)

_MODEL_MAP: dict[str, LLMModel] = {m.name: m for m in MODELS}

_THINKING_MODELS: frozenset[str] = frozenset({
    "moonshotai/kimi-k2.5",
    "qwen/qwq-32b",
    "deepseek-ai/deepseek-r1-distill-qwen-32b",
    "qwen/qwen3-30b-a3b-fp8",
})


# ═══════════════════════════════════════════════════════════
# §3 — CONSTANTS
# ═══════════════════════════════════════════════════════════
_API = "https://llmchat.in/inference/stream"

_BASE_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream, */*",
    "Origin": "https://llmchat.in",
    "Referer": "https://llmchat.in/",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/146.0.0.0 Safari/537.36"
    ),
    "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
}

_RETRY_CODES = {429, 500, 502, 503, 504, 520, 521, 522, 523, 524}
_FATAL_CODES = {400, 401, 403, 404, 405, 422}

_DONE = object()
_LOCK = threading.Lock()


# ═══════════════════════════════════════════════════════════
# §4 — SSE PARSER
# ═══════════════════════════════════════════════════════════
def _parse_sse(line: str) -> List[dict]:
    """
    Parse one SSE 'data:' line.

    Returns a list of events so we can handle both reasoning and content
    if the server ever sends both in the same chunk.
    """
    if not line.startswith("data:"):
        return []

    payload = line[5:].strip()
    if not payload or payload == "[DONE]":
        return []

    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return []

    events: List[dict] = []
    choices = data.get("choices")

    if isinstance(choices, list) and choices:
        first = choices[0] if isinstance(choices[0], dict) else {}
        delta = first.get("delta") or {}
        finish_reason = first.get("finish_reason")

        reasoning = delta.get("reasoning_content")
        if reasoning is None:
            reasoning = delta.get("reasoning")

        if isinstance(reasoning, str) and reasoning:
            events.append({
                "kind": "reasoning",
                "text": reasoning,
                "finish_reason": finish_reason,
            })

        content = delta.get("content")
        if isinstance(content, str) and content:
            events.append({
                "kind": "content",
                "text": content,
                "finish_reason": finish_reason,
            })

        if not events:
            events.append({
                "kind": "meta",
                "text": "",
                "finish_reason": finish_reason,
            })

        return events

    resp = data.get("response")
    if isinstance(resp, str):
        events.append({
            "kind": "response",
            "text": resp,
            "finish_reason": None,
        })

    return events


# ═══════════════════════════════════════════════════════════
# §5 — MODEL RESOLVER
# ═══════════════════════════════════════════════════════════
def _resolve_model(query: Union[str, LLMModel, None], default: LLMModel) -> LLMModel:
    """Resolve model from name, partial name, or LLMModel object."""
    if query is None:
        return default
    if isinstance(query, LLMModel):
        return query

    if query in _MODEL_MAP:
        return _MODEL_MAP[query]

    q = query.lower()
    for m in MODELS:
        if q in m.name.lower():
            return m

    raise ValueError(
        f"No model matching '{query}'\n"
        f"Use LLMChatProvider.available_models() to see available models"
    )


# ═══════════════════════════════════════════════════════════
# §6 — MESSAGE BUILDER
# ═══════════════════════════════════════════════════════════
def _build_messages(
    data: Optional[str],
    messages: Optional[List[Dict]],
    system: Optional[str]
) -> List[Dict]:
    """
    Build message list from data or messages with optional system prompt.

    Rules:
    - If messages are provided, keep them as-is.
    - If no system message exists and system is provided, prepend it.
    - Always ensure the last message is an empty assistant message.
    """
    result: List[Dict] = []

    if messages:
        result = [dict(msg) for msg in messages]
        has_system = any(m.get("role") == "system" for m in result)
        if system and not has_system:
            result.insert(0, {"role": "system", "content": system})
    else:
        if system:
            result.append({"role": "system", "content": system})
        if data is not None:
            result.append({"role": "user", "content": data})

    if not result or result[-1].get("role") != "assistant":
        result.append({"role": "assistant", "content": ""})

    return result


# ═══════════════════════════════════════════════════════════
# §7 — SESSION FACTORY
# ═══════════════════════════════════════════════════════════
def _make_session(timeout: int) -> CurlSession:
    """Create a fresh session for each request worker."""
    return CurlSession(
        impersonate="chrome",
        timeout=timeout,
        headers=_BASE_HEADERS,
    )


# ═══════════════════════════════════════════════════════════
# §8 — MAIN PROVIDER
# ═══════════════════════════════════════════════════════════
class LLMChatProvider:
    """
    💬 LLMChat — Async Text Generation Provider

    23 models · Thinking model support · Streaming
    """

    def __init__(
        self,
        model: Union[str, LLMModel] = None,
        system: str = "You are a helpful assistant.",
        temperature: float = 1.0,
        max_tokens: int = None,
        timeout: int = 60,
        retries: int = 3,
        referer: str = "https://llmchat.in/",
    ):
        self._model = _resolve_model(model, MODELS[0])
        self.system = system
        self.temperature = temperature
        self.max_tokens = max_tokens or self._model.max_tokens
        self.timeout = timeout
        self.retries = retries
        self.referer = referer

    @property
    def model(self) -> LLMModel:
        return self._model

    @property
    def is_thinking_model(self) -> bool:
        return self._model.name in _THINKING_MODELS

    def _payload(self, messages: List[Dict], max_tokens: int) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": True,
        }
        if self.temperature is not None:
            payload["temperature"] = self.temperature
        return payload

    def _push(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue, item: Any) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, item)

    def _stream_worker(
        self,
        loop: asyncio.AbstractEventLoop,
        queue: asyncio.Queue,
        messages: List[Dict],
        model: LLMModel,
        max_tokens: int,
    ) -> None:
        """
        Blocking worker that runs in a thread.
        Reads SSE lines using curl_cffi and pushes parsed tokens into asyncio queue.
        """
        session = _make_session(self.timeout)
        url = f"{_API}?model={model.endpoint}"
        payload = self._payload(messages, max_tokens)

        headers = dict(_BASE_HEADERS)
        headers["Referer"] = self.referer
        headers["Origin"] = "https://llmchat.in"

        resp = None
        last_err = ""
        think_open = False

        def emit(text: str) -> None:
            if text:
                self._push(loop, queue, text)

        def close_think() -> None:
            nonlocal think_open
            if think_open:
                think_open = False
                emit("\n</think>\n")

        try:
            for attempt in range(self.retries + 1):
                try:
                    resp = session.post(
                        url,
                        json=payload,
                        headers=headers,
                        impersonate="chrome",
                        timeout=self.timeout,
                        stream=True,
                    )

                    status = getattr(resp, "status_code", None)
                    if status == 200:
                        break

                    body = getattr(resp, "text", "")
                    last_err = f"HTTP {status}: {str(body)[:200]}"

                    if status in _FATAL_CODES:
                        raise RuntimeError(f"Fatal error: {last_err}")

                    if status in _RETRY_CODES and attempt < self.retries:
                        wait = min(2.0 * (2 ** attempt) + random.uniform(0, 1), 30)
                        time.sleep(wait)
                        continue

                    raise RuntimeError(last_err)

                except RuntimeError:
                    raise
                except Exception as exc:
                    last_err = str(exc)
                    if attempt < self.retries:
                        time.sleep(2.0 * (attempt + 1))
                        continue
                    raise RuntimeError(f"Connection failed: {last_err}") from exc

            if resp is None or getattr(resp, "status_code", None) != 200:
                raise RuntimeError(f"All retries exhausted: {last_err}")

            for raw_line in resp.iter_lines():
                if not raw_line:
                    continue

                if isinstance(raw_line, bytes):
                    line = raw_line.decode("utf-8", errors="replace").strip()
                else:
                    line = str(raw_line).strip()

                if not line:
                    continue

                for chunk in _parse_sse(line):
                    kind = chunk.get("kind")
                    text = chunk.get("text", "")
                    finish_reason = chunk.get("finish_reason")

                    if kind == "reasoning":
                        if self.is_thinking_model and not think_open:
                            think_open = True
                            emit("<think>\n")
                        emit(text)
                        continue

                    if kind in ("content", "response"):
                        close_think()
                        emit(text)
                        continue

                    if kind == "meta" and finish_reason == "stop":
                        close_think()

            close_think()
            self._push(loop, queue, _DONE)

        except Exception as exc:
            close_think()
            self._push(loop, queue, exc)

        finally:
            try:
                if resp is not None:
                    resp.close()
            except Exception:
                pass
            try:
                session.close()
            except Exception:
                pass

    async def _stream(
        self,
        messages: List[Dict],
        model: LLMModel,
        max_tokens: int,
    ) -> AsyncGenerator[str, None]:
        """
        Async generator that consumes tokens from the worker thread.
        """
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        thread = threading.Thread(
            target=self._stream_worker,
            args=(loop, queue, messages, model, max_tokens),
            daemon=True,
        )
        thread.start()

        while True:
            item = await queue.get()

            if item is _DONE:
                break

            if isinstance(item, Exception):
                raise item

            yield item

    async def chat(
        self,
        data: str = None,
        messages: List[Dict] = None,
        model: Union[str, LLMModel] = None,
        system: str = None,
        temperature: float = None,
        max_tokens: int = None,
    ) -> AsyncGenerator[str, None]:
        """
        Async-stream tokens from LLMChat.
        """
        if not messages and data is None:
            raise ValueError("Provide 'messages' or 'data'")

        use_model = _resolve_model(model, self._model)
        use_tokens = max_tokens or self.max_tokens
        use_system = system if system is not None else self.system

        if temperature is not None:
            self.temperature = temperature

        send_msgs = _build_messages(data, messages, use_system)

        async for token in self._stream(send_msgs, use_model, use_tokens):
            yield token

    def set_model(self, model: Union[str, LLMModel]) -> "LLMChatProvider":
        self._model = _resolve_model(model, self._model)
        if self.max_tokens is None:
            self.max_tokens = self._model.max_tokens
        return self

    def set_system(self, prompt: str) -> "LLMChatProvider":
        self.system = prompt
        return self

    def set_max_tokens(self, n: int) -> "LLMChatProvider":
        self.max_tokens = n
        return self

    @staticmethod
    def available_models() -> List[str]:
        return [m.name for m in MODELS]

    @staticmethod
    def thinking_models() -> List[str]:
        return [m.name for m in MODELS if m.name in _THINKING_MODELS]

    async def aclose(self) -> None:
        return

    def __repr__(self):
        think = " 🧠" if self.is_thinking_model else ""
        return (
            f"LLMChatProvider("
            f"model={self._model.name!r}, "
            f"max_tokens={self.max_tokens:,}"
            f"{think})"
        )


# ═══════════════════════════════════════════════════════════
# §9 — EXAMPLE USAGE
# ═══════════════════════════════════════════════════════════
async def main():
    lm = LLMChatProvider(
        model="moonshotai/kimi-k2.5",
    )

    async for token in lm.chat(data="Hello"):
        print(token, end="", flush=True)

    await lm.aclose()


if __name__ == "__main__":
    asyncio.run(main())