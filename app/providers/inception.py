"""
═══ §4 — MERCURY PROVIDER (Inception) ═══════════════════════════════════════
Rebuilt from Inception.py. Everything that made that file a liability is gone;
everything that made it *work against the real API* is kept.

REMOVED  (each was a "bad thing")
  ✗ _PROXY = "http://217.217.249.160:8080"      hardcoded third-party proxy —
                                                 every user's prompt and every
                                                 response transited a stranger's
                                                 box in plaintext. Deleted.
  ✗ cloudscraper + browser={chrome,windows}      TLS/JS fingerprint spoofing to
                                                 defeat Cloudflare.
  ✗ Origin/Referer/UA/sec-ch-*/sec-fetch-site    crafted to look like the web
    forgery                                      app calling itself.
  ✗ time.sleep(random.uniform(1.5, 4.0))         jitter to look human.
  ✗ background refresh thread every 90s          a daemon that kept hitting
                                                 /api/session forever.
  ✗ 12h credential cache + atexit + __del__      opaque lifetime, file-cache
                                                 dirs (MERCURY_CACHE_DIR).
  ✗ sync-in-thread + queue bridge                two executors per stream.
  ✗ `sources` JSON yielded as a *token*          the UI could not tell sources
                                                 from prose; Server.py needed a
                                                 _is_search_json() guesser.
  ✗ bare `except Exception: return None`         silent failure everywhere.

KEPT  (the actual API contract)
  ✓ /api/session → {"token": ...} + session cookie, sent as x-session-token
  ✓ message shape: {id, role, parts:[{type:text,text}]} (assistant gets
    parts[0].state="done"), system prompts folded into a user message with a
    [SYSTEM INSTRUCTION] prefix, consecutive user messages merged
  ✓ payload: reasoningEffort / webSearchEnabled / voiceMode / id / messages /
    trigger="submit-message"
  ✓ SSE events: reasoning-delta, text-delta, source-url, [DONE]

WHAT "USER IP FORWARDING" MEANS HERE
  forwarded_headers() puts the user's IP in X-Forwarded-For / X-Real-IP /
  Forwarded so upstream can attribute the request. It is metadata. The socket
  still belongs to this server — that is not a limitation of this file, it is
  TCP. Do not add a proxy to "fix" it; that only swaps which stranger sees the
  traffic.
"""
from __future__ import annotations

import asyncio
import json
import random
import time
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple

import httpx

from app import config as _config
from app.config import Settings

SYS_PREFIX = "[SYSTEM INSTRUCTION]"
UA = "silk-chat/1.0 (+direct upstream client; no proxy)"

EVENT_REASONING = "reasoning"
EVENT_TOKEN = "token"
EVENT_SOURCES = "sources"
EVENT_DONE = "done"


# ───────────────────────────────────────────────────────────────────────────
# §4.1 — errors
# ───────────────────────────────────────────────────────────────────────────
class UpstreamError(RuntimeError):
    """Any failure talking to the upstream API."""

    def __init__(self, message: str, *, status: int = 0, retry_after: int = 0) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


class UnauthorizedError(UpstreamError):
    """Session token rejected — triggers exactly one refresh + replay."""


class RateLimitedError(UpstreamError):
    """Upstream said 429. We surface retry_after instead of sleeping blindly."""


# ───────────────────────────────────────────────────────────────────────────
# §4.2 — SSE line parser
# ───────────────────────────────────────────────────────────────────────────
def parse_sse_line(line: str) -> Optional[Tuple[str, Any]]:
    """One SSE `data:` line → (kind, payload) | None. `[DONE]` → ('done','')."""
    line = line.strip()
    if not line or line[0] == ":" or line.startswith(("event:", "id:", "retry:")):
        return None
    if line.startswith("data:"):
        line = line[5:].strip()
    if not line:
        return None
    if line == "[DONE]":
        return (EVENT_DONE, "")

    try:
        obj = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None

    kind = obj.get("type", "")
    if kind == "reasoning-delta":
        delta = obj.get("delta", "")
        return (EVENT_REASONING, delta) if delta else None
    if kind == "text-delta":
        delta = obj.get("delta", "")
        return (EVENT_TOKEN, delta) if delta else None
    if kind == "source-url":
        source_id = obj.get("sourceId", "")
        if source_id == "__searching__":
            return None
        url = obj.get("url", "")
        if not url:
            return None
        return (
            EVENT_SOURCES,
            {"id": source_id, "url": url, "title": obj.get("title", "")},
        )
    if kind == "error":
        raise UpstreamError(str(obj.get("error") or obj.get("message") or "upstream error"))
    return None


# ───────────────────────────────────────────────────────────────────────────
# §4.3 — message converter (chat messages ⇄ mercury wire format)
# ───────────────────────────────────────────────────────────────────────────
def rid(n: int = 16) -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    return "".join(random.choice(alphabet) for _ in range(n))


def _flatten(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            str(p.get("text", ""))
            for p in content
            if isinstance(p, dict) and p.get("type") == "text"
        )
    return "" if content is None else str(content)


def to_mercury(messages: List[Dict[str, Any]], system: str = "") -> List[Dict[str, Any]]:
    """
    OpenAI-style messages → mercury `parts` format.

    Upstream has no `system` role, so a system prompt becomes a user message
    with an instruction prefix — same as the original. Consecutive user
    messages are merged, also same as the original (upstream gets confused by
    back-to-back user turns).
    """
    flat: List[Dict[str, str]] = []
    if system:
        flat.append({"role": "user", "content": f"{SYS_PREFIX} {system}"})

    for msg in messages:
        role = msg.get("role", "")
        content = _flatten(msg.get("content", ""))
        if role == "system":
            flat.append({"role": "user", "content": f"{SYS_PREFIX} {content}"})
        elif role in ("user", "assistant"):
            flat.append({"role": role, "content": content})

    merged: List[Dict[str, str]] = []
    for msg in flat:
        if merged and msg["role"] == "user" and merged[-1]["role"] == "user":
            merged[-1]["content"] += "\n\n" + msg["content"]
        else:
            merged.append(dict(msg))

    out: List[Dict[str, Any]] = []
    for msg in merged:
        part: Dict[str, Any] = {"type": "text", "text": msg["content"]}
        if msg["role"] == "assistant":
            part["state"] = "done"
        out.append({"id": rid(), "role": msg["role"], "parts": [part]})
    return out


def collect_sources(raw: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Dedupe by URL, keep arrival order, number them 1..n."""
    seen: set[str] = set()
    out: List[Dict[str, Any]] = []
    for src in raw:
        url = (src.get("url") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        out.append(
            {
                "index": len(out) + 1,
                "id": src.get("id", ""),
                "title": (src.get("title") or "Untitled").strip(),
                "url": url,
            }
        )
    return out


# ───────────────────────────────────────────────────────────────────────────
# §4.4 — session token store
# ───────────────────────────────────────────────────────────────────────────
@dataclass
class _TokenState:
    token: str = ""
    cookies: Dict[str, str] = field(default_factory=dict)
    obtained_at: float = 0.0

    def stale(self, ttl: int) -> bool:
        return (not self.token) or (time.time() - self.obtained_at) > ttl


class TokenManager:
    """
    Lazily fetch a session token. One in-flight fetch shared by all waiters,
    refreshed on demand rather than by a background thread.
    """

    def __init__(self, client: httpx.AsyncClient, cfg: Settings) -> None:
        self._client = client
        self._cfg = cfg
        self._state = _TokenState()
        self._lock = asyncio.Lock()

    async def get(self, *, force: bool = False) -> str:
        async with self._lock:
            if not force and not self._state.stale(self._cfg.token_ttl):
                return self._state.token
            await self._fetch_locked()
            return self._state.token

    async def invalidate(self) -> None:
        async with self._lock:
            self._state = _TokenState()

    async def _fetch_locked(self) -> None:
        url = f"{self._cfg.base_url}{self._cfg.session_endpoint}"
        try:
            resp = await self._client.get(url)
        except httpx.HTTPError as exc:
            raise UpstreamError(f"session request failed: {exc}") from exc

        if resp.status_code == 429:
            raise RateLimitedError(
                "upstream rate-limited the session handshake",
                status=429,
                retry_after=_retry_after(resp),
            )
        if resp.status_code >= 400:
            raise UpstreamError(
                f"session handshake HTTP {resp.status_code}: {resp.text[:200]}",
                status=resp.status_code,
            )
        try:
            data = resp.json()
        except ValueError as exc:
            raise UpstreamError("session handshake returned non-JSON") from exc

        token = (data or {}).get("token", "")
        if not token:
            raise UpstreamError("session handshake returned no token")

        self._state = _TokenState(
            token=token,
            cookies=dict(resp.cookies),
            obtained_at=time.time(),
        )


def _retry_after(resp: httpx.Response) -> int:
    raw = resp.headers.get("retry-after", "")
    try:
        return max(1, int(float(raw)))
    except (TypeError, ValueError):
        return 0


# ───────────────────────────────────────────────────────────────────────────
# §4.5 — provider
# ───────────────────────────────────────────────────────────────────────────
class MercuryProvider:
    """
    Direct, proxy-free async client for the Inception chat API.

        async with MercuryProvider() as mc:
            async for kind, payload in mc.stream(messages, client_info=info):
                ...

    `stream()` yields typed tuples instead of one blob of text, so reasoning,
    prose and sources never get mixed into the same channel.
    """

    def __init__(
        self,
        cfg: Optional[Settings] = None,
        *,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self.cfg = cfg or _config.settings   # read live: env may change after import
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            base_url=self.cfg.base_url,
            timeout=httpx.Timeout(
                float(self.cfg.request_timeout),
                connect=float(self.cfg.connect_timeout),
            ),
            limits=httpx.Limits(
                max_connections=self.cfg.max_connections,
                max_keepalive_connections=self.cfg.max_connections,
            ),
            follow_redirects=True,
            headers={"User-Agent": UA, "Accept": "text/event-stream"},
        )
        self.tokens = TokenManager(self._client, self.cfg)
        self._closed = False

    # ── lifecycle ───────────────────────────────────────────────────────
    async def __aenter__(self) -> "MercuryProvider":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._owns_client:
            await self._client.aclose()

    # ── request building ────────────────────────────────────────────────
    def _headers(self, token: str, client_info: Any) -> Dict[str, str]:
        """
        Truthful headers only.

        No Origin, no Referer, no sec-fetch-*, no browser User-Agent. Those all
        describe a *browser*, and we are not one — the previous file set
        Origin/Referer to the upstream's own URL specifically so the call would
        look same-origin. An HTTP client that does not exist in a page should not
        claim to be one: omit the headers rather than invent them.

        If the real API starts rejecting us for missing them, that is upstream
        asking for a browser. The answer then is an API key or their official
        endpoint — not a fingerprint costume, and definitely not a proxy.
        """
        from app.client_ip import forwarded_headers   # local import: avoids cycle

        headers = {
            "content-type": "application/json",
            "accept": "text/event-stream",
            "cache-control": "no-cache",
            "x-session-token": token,
        }
        if client_info is not None:
            headers.update(
                forwarded_headers(client_info, enabled=self.cfg.forward_client_ip)
            )
        return headers

    def _payload(
        self,
        mercury_msgs: List[Dict[str, Any]],
        *,
        conversation_id: str,
        search: bool,
        reasoning_effort: str,
    ) -> Dict[str, Any]:
        return {
            "reasoningEffort": reasoning_effort,
            "webSearchEnabled": bool(search),
            "voiceMode": False,
            "id": conversation_id,
            "messages": mercury_msgs,
            "trigger": "submit-message",
        }

    # ── the stream ──────────────────────────────────────────────────────
    async def stream(
        self,
        messages: List[Dict[str, Any]],
        *,
        system: str = "",
        search: Optional[bool] = None,
        reasoning_effort: Optional[str] = None,
        conversation_id: Optional[str] = None,
        client_info: Any = None,
    ) -> AsyncGenerator[Tuple[str, Any], None]:
        cfg = self.cfg
        use_search = cfg.enable_search if search is None else bool(search)
        effort = reasoning_effort or cfg.reasoning_effort
        conv_id = conversation_id or rid()
        mercury_msgs = to_mercury(messages, system=system)
        payload = self._payload(
            mercury_msgs,
            conversation_id=conv_id,
            search=use_search,
            reasoning_effort=effort,
        )

        token = await self.tokens.get()
        attempts = 0
        while True:
            try:
                async for event in self._once(payload, token, client_info):
                    yield event
                return
            except UnauthorizedError:
                attempts += 1
                if attempts > 1:
                    raise
                await self.tokens.invalidate()
                token = await self.tokens.get(force=True)
                continue

    async def _once(
        self,
        payload: Dict[str, Any],
        token: str,
        client_info: Any,
    ) -> AsyncGenerator[Tuple[str, Any], None]:
        cfg = self.cfg
        url = f"{cfg.base_url}{cfg.chat_endpoint}"
        headers = self._headers(token, client_info)
        done_seen = False

        try:
            async with self._client.stream("POST", url, headers=headers, json=payload) as resp:
                if resp.status_code == 401 or resp.status_code == 403:
                    body = (await resp.aread()).decode("utf-8", "replace")
                    raise UnauthorizedError(
                        f"upstream rejected the session token (HTTP {resp.status_code}): "
                        f"{body[:160]}",
                        status=resp.status_code,
                    )
                if resp.status_code == 429:
                    raise RateLimitedError(
                        "upstream rate limit reached",
                        status=429,
                        retry_after=_retry_after(resp),
                    )
                if resp.status_code >= 400:
                    body = (await resp.aread()).decode("utf-8", "replace")
                    raise UpstreamError(
                        f"HTTP {resp.status_code}: {body[:300]}", status=resp.status_code
                    )

                async for raw in resp.aiter_lines():
                    if not raw:
                        continue
                    try:
                        event = parse_sse_line(raw)
                    except UpstreamError:
                        raise
                    if event is None:
                        continue
                    kind, data = event
                    if kind == EVENT_DONE:
                        done_seen = True
                        break
                    yield event
        except UpstreamError:
            raise
        except httpx.HTTPError as exc:
            raise UpstreamError(f"upstream connection failed: {exc}") from exc
        except asyncio.CancelledError:
            raise
        finally:
            if not done_seen:
                # Upstream closed without [DONE]; that is normal for some
                # deployments, so it is not an error — just note it.
                pass

        yield (EVENT_DONE, {"conversation_id": conv_id_hint(payload)})


def conv_id_hint(payload: Dict[str, Any]) -> str:
    return str(payload.get("id", ""))


# ───────────────────────────────────────────────────────────────────────────
# §4.6 — registry: one provider instance per process
# ───────────────────────────────────────────────────────────────────────────
_provider: Optional[MercuryProvider] = None
_provider_lock = asyncio.Lock()


async def get_provider() -> MercuryProvider:
    global _provider
    async with _provider_lock:
        if _provider is None or _provider._closed:
            _provider = MercuryProvider()
        return _provider


async def close_provider() -> None:
    global _provider
    async with _provider_lock:
        if _provider is not None:
            await _provider.aclose()
            _provider = None
