"""
══════════════════════════════════════════════════════════════
  ☀️  Upstage Solar Provider  (Async)

  Async streaming reasoning model via console.upstage.ai
  4 models · Web search · Reasoning modes
  Auto-credentials via headless Chrome · Cached to disk

  ┌──────────────────────────────────────────────────────┐
  │  Credential Pipeline (FAST startup):                 │
  │                                                      │
  │  1. Load cache/upstage_creds.json                    │
  │  2. Verify CSRF token via RSC POST                   │
  │  3. Valid?  → Instant start (NO browser!)            │
  │  4. Invalid → Headless Chrome → capture → Save       │
  │                                                      │
  │  First run  : ~10-30s  (browser capture)             │
  │  Next runs  : ~1-2s   (cached credentials)           │
  └──────────────────────────────────────────────────────┘

  Usage:
      from providers import UpstageProvider

      up = UpstageProvider()

      async for token in up.chat(data="Hello!"):
          print(token, end="", flush=True)
══════════════════════════════════════════════════════════════
"""

from __future__ import annotations

import atexit
import asyncio
import json
import queue as _queue
import uuid
from pathlib import Path
from typing import Optional, AsyncGenerator, Any, List, Dict, Tuple, Union

import aiofiles
import aiohttp
import requests
from DrissionPage import ChromiumPage, ChromiumOptions
import time
import os as _os

# ═══════════════════════════════════════════════════════════
# §1 — CONSTANTS
# ═══════════════════════════════════════════════════════════
_CONSOLE  = "https://console.upstage.ai"
_API_HOST = "https://ap-northeast-2.apistage.ai"
_CHAT_EP  = "/playground/chat"
_COMP_URL = f"{_API_HOST}/v1/web/demo/chat/completions?include_think=true"

_CRED_DIR  = Path(_os.getenv("UPSTAGE_CACHE_DIR", "/tmp/.cache/upstage"))
_CRED_FILE = _CRED_DIR / "upstage_creds.json"

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/146.0.0.0 Safari/537.36"
)

_ROUTER_STATE = (
    "%5B%22%22%2C%7B%22children%22%3A%5B%22(frame)%22%2C%7B%22children%22"
    "%3A%5B%22playground%22%2C%7B%22children%22%3A%5B%22(llm)%22%2C%7B%22"
    "children%22%3A%5B%22chat%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C"
    "%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2C"
    "null%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D"
)

_SYS_PREFIX = "[SYSTEM INSTRUCTION]"


# ═══════════════════════════════════════════════════════════
# §2 — MODEL REGISTRY
# ═══════════════════════════════════════════════════════════
_MODELS: Dict[str, Dict[str, Any]] = {
    "solar-pro3": {
        "reasoning":   ["low", "medium", "high"],
        "search":      True,
        "system":      "",
        "temperature": 0.8,
        "max_tokens":  65536,
        "metadata":    None,
    },
    "solar-pro2": {
        "reasoning":   ["low", "high"],
        "search":      True,
        "system":      "",
        "temperature": 0.8,
        "max_tokens":  16383,
        "metadata":    None,
    },
    "syn-pro": {
        "reasoning":   ["low", "high"],
        "search":      True,
        "system":      "",
        "temperature": 0.7,
        "max_tokens":  16384,
        "metadata": {
            "helpfulness": 4, "correctness": 4, "coherence": 4,
            "complexity": 4, "verbosity": 4, "quality": 4,
            "toxicity": 0, "humor": 0, "creativity": 0,
        },
    },
    "upstage/solar-1-mini-chat": {
        "reasoning":   None,
        "search":      True,
        "system":      "",
        "temperature": 0.8,
        "max_tokens":  16383,
        "metadata":    None,
    },
}

_MODEL_ALIASES: Dict[str, str] = {
    "solar-pro3": "solar-pro3", "solar-pro2": "solar-pro2",
    "syn-pro": "syn-pro",
    "solar-1-mini-chat": "upstage/solar-1-mini-chat",
    "upstage/solar-1-mini-chat": "upstage/solar-1-mini-chat",
    "solar3": "solar-pro3", "solar2": "solar-pro2",
    "pro3": "solar-pro3", "pro2": "solar-pro2",
    "syn": "syn-pro", "mini": "upstage/solar-1-mini-chat",
}


def _resolve_model(val: str) -> str:
    if not val:
        return "solar-pro3"
    v = val.lower().strip()
    if v in _MODEL_ALIASES:
        return _MODEL_ALIASES[v]
    if v in _MODELS:
        return v
    for name in _MODELS:
        if v in name.lower():
            return name
    return val


# ═══════════════════════════════════════════════════════════
# §3 — SSE PARSER
# ═══════════════════════════════════════════════════════════
class _SSE:
    """
    Parse Upstage SSE lines.

    Returns (event_type, content):
        "r-delta"   — reasoning token
        "t-delta"   — text/content token
        "source"    — search result JSON string
        "s-start"   — search started
        "s-summary" — summarizing
        "done"      — stream finished
    """

    @staticmethod
    def parse_line(line: str, in_think: list) -> Optional[Tuple[str, str]]:
        """
        Parse a single SSE line.
        in_think is a mutable [bool] to track think state across calls.
        """
        if not line or not line.startswith("data: "):
            return None

        data = line[6:].strip()
        if data == "[DONE]":
            return ("done", "")

        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            return None

        # ── Search events ──
        search = obj.get("search")
        if obj.get("choices") is None and search:
            st     = search.get("status", {})
            action = st.get("action", "")
            desc   = st.get("description", "")
            raw_sq = search.get("search_queries")

            if action == "search_start":
                query = ""
                if raw_sq and isinstance(raw_sq, list) and raw_sq:
                    query = raw_sq[0].get("query", "")
                return ("s-start", query)

            elif action == "search_finish":
                if raw_sq:
                    return ("source", json.dumps(raw_sq))

            elif action == "summarizing":
                return ("s-summary", desc)

            return None

        # ── Content / Thinking chunks ──
        choices = obj.get("choices")
        if not choices:
            return None

        delta  = choices[0].get("delta", {})
        finish = choices[0].get("finish_reason")

        if finish == "stop":
            return ("done", "")

        rc = delta.get("reasoning_content", "")
        if rc:
            return ("r-delta", rc)

        text = delta.get("content", "")
        if not text:
            return None

        # We return text events; <think> parsing done at higher level
        return ("t-delta", text)


# ═══════════════════════════════════════════════════════════
# §4 — SOURCE FORMATTER
# ═══════════════════════════════════════════════════════════
class _Sources:

    @staticmethod
    def parse(raw_json_list: List[str]) -> List[Dict]:
        seen_urls: set[str] = set()
        result: List[Dict] = []
        idx = 0

        for raw in raw_json_list:
            try:
                queries = json.loads(raw) if isinstance(raw, str) else raw
            except (json.JSONDecodeError, TypeError):
                continue

            if not isinstance(queries, list):
                continue

            for q_data in queries:
                query_text  = q_data.get("query", "")
                raw_results = q_data.get("results", [])

                if not isinstance(raw_results, list):
                    continue

                for r in raw_results:
                    url     = r.get("url", "").strip()
                    title   = r.get("title", "").strip()
                    score   = float(r.get("score", 0.0))
                    content = r.get("content", "").strip()

                    if not url or url in seen_urls:
                        continue

                    seen_urls.add(url)
                    idx += 1

                    snippet = content[:200].replace("\n", " ").strip()
                    if len(content) > 200:
                        snippet += "..."

                    result.append({
                        "index":   idx,
                        "query":   query_text,
                        "title":   title or "Untitled",
                        "url":     url,
                        "score":   score,
                        "snippet": snippet,
                    })

        return result

    @staticmethod
    def format_text(sources: List[Dict]) -> str:
        if not sources:
            return ""
        lines = [
            "",
            "  ┌─────────────────────────────────────────",
            f"  │ 📚 Sources ({len(sources)})",
        ]
        for s in sources:
            lines.append(f"  │  [{s['index']}] {s['title']}")
            lines.append(f"  │      {s['url']}")
            if s.get("score"):
                lines.append(f"  │      Score: {s['score']:.4f}")
        lines.append("  └─────────────────────────────────────────")
        return "\n".join(lines)
    
    @staticmethod
    def format_json(sources: List[Dict]) -> str:
        """Format sources as a JSON string for streaming."""
        clean_sources = []
        for src in sources:
            clean_sources.append({
                "title": src.get("title", ""),
                "url": src.get("url", ""),
                "score": src.get("score", 0)
            })
        return json.dumps({"sources": clean_sources})


# ═══════════════════════════════════════════════════════════
# §5 — CREDENTIAL MANAGER  (Async + File Cache)
# ═══════════════════════════════════════════════════════════
class _Creds:

    def __init__(self, path: Path = _CRED_FILE):
        self.path          = path
        self.action_init:  Optional[str]  = None
        self.action_token: Optional[str]  = None
        self.cookies:      Dict[str, str] = {}
        self.session_id:   str            = str(uuid.uuid4())

    # ── Async Load ────────────────────────────────────
    async def load(self) -> bool:
        if not self.path.exists():
            return False
        try:
            async with aiofiles.open(self.path, "r") as f:
                data = json.loads(await f.read())
            self.action_init  = data.get("action_init")
            self.action_token = data.get("action_token")
            self.cookies      = data.get("cookies", {})
            self.session_id   = self.cookies.get("session_id", str(uuid.uuid4()))
            return bool(self.action_token)
        except Exception:
            return False

    # ── Async Save ────────────────────────────────────
    async def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "action_init":  self.action_init,
            "action_token": self.action_token,
            "cookies":      self.cookies,
            "saved_at":     time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        async with aiofiles.open(self.path, "w") as f:
            await f.write(json.dumps(data, indent=2))

    # ── Async Clear ───────────────────────────────────
    async def clear(self):
        try:
            if self.path.exists():
                self.path.unlink()
        except Exception:
            pass

    # ── Verify (sync work via thread) ─────────────────
    async def verify(self) -> Optional[str]:
        return await asyncio.to_thread(self._verify_sync)

    def _verify_sync(self) -> Optional[str]:
        http = requests.Session()
        http.headers["User-Agent"] = _UA
        try:
            return self._try_get_token_sync(http)
        except Exception:
            return None
        finally:
            http.close()

    def _rsc_post_sync(self, http: requests.Session, action_id: str) -> str:
        headers = {
            "accept":                 "text/x-component",
            "content-type":           "text/plain;charset=UTF-8",
            "next-action":            action_id,
            "next-router-state-tree": _ROUTER_STATE,
            "origin":                 _CONSOLE,
            "referer":                f"{_CONSOLE}{_CHAT_EP}",
        }
        r = http.post(
            f"{_CONSOLE}{_CHAT_EP}",
            headers=headers, data="[]",
            cookies=self.cookies,
        )
        r.raise_for_status()
        return r.text

    def _try_get_token_sync(self, http: requests.Session) -> Optional[str]:
        try:
            if self.action_init:
                try:
                    self._rsc_post_sync(http, self.action_init)
                except Exception:
                    pass
            body = self._rsc_post_sync(http, self.action_token)
            for line in body.strip().splitlines():
                if '"token"' in line:
                    idx = line.index("{")
                    try:
                        return json.loads(line[idx:])["token"]
                    except Exception:
                        continue
        except Exception:
            pass
        return None

    # ── Capture via browser (sync, run in thread) ─────
    async def capture(self):
        await asyncio.to_thread(self._capture_sync)
        await self.save()

    def _capture_sync(self):
        opts = ChromiumOptions()
        opts.headless()
        page = ChromiumPage(opts)

        try:
            page.listen.start("playground/chat")
            page.get(f"{_CONSOLE}{_CHAT_EP}")
            time.sleep(4)

            textarea = page.ele("tag:textarea") or page.ele("css:textarea")
            if not textarea:
                raise RuntimeError("Textarea not found — site may require login")

            textarea.input("hi")
            time.sleep(0.5)

            btn = (
                page.ele('css:button[data-gtm-position="content"]')
                or page.ele('@data-gtm-position=content')
                or page.ele('tag:button[data-gtm-position="content"]')
                or page.ele('tag:button')
            )
            if not btn:
                raise RuntimeError("Send button not found")
            btn.click()

            ordered:      List[str]   = []
            action_init:  Optional[str] = None
            action_token: Optional[str] = None

            for _ in range(20):
                pkt = page.listen.wait(timeout=15)
                if pkt is None:
                    break
                if getattr(pkt, "method", "") != "POST":
                    continue
                if "playground/chat" not in getattr(pkt, "url", ""):
                    continue

                req_h = {}
                try:
                    req_h = pkt.request.headers or {}
                except Exception:
                    pass

                na = req_h.get("next-action", req_h.get("Next-Action", ""))
                if not na or len(na) != 40 or na in ordered:
                    continue
                ordered.append(na)

                resp_body = ""
                try:
                    b = pkt.response.body
                    if isinstance(b, bytes):
                        resp_body = b.decode("utf-8", errors="ignore")
                    elif isinstance(b, str):
                        resp_body = b
                    elif b is not None:
                        resp_body = str(b)
                except Exception:
                    pass

                if '"token"' in resp_body:
                    action_token = na
                elif "1:null" in resp_body:
                    action_init = na

                if action_token:
                    break

            page.listen.stop()

            if not action_token and len(ordered) >= 2:
                action_init  = ordered[0]
                action_token = ordered[1]
            elif not action_token and len(ordered) == 1:
                action_token = ordered[0]

            if not action_token:
                raise RuntimeError("Failed to capture action IDs")

            cookies: Dict[str, str] = {}
            try:
                d = page.cookies(as_dict=True)
                if isinstance(d, dict):
                    cookies = {str(k): str(v) for k, v in d.items()}
            except Exception:
                try:
                    for c in page.cookies():
                        if isinstance(c, dict):
                            cookies[str(c.get("name", ""))] = str(c.get("value", ""))
                        elif hasattr(c, "name"):
                            cookies[str(c.name)] = str(c.value)
                except Exception:
                    pass

            if "session_id" not in cookies:
                cookies["session_id"] = str(uuid.uuid4())

            self.action_init  = action_init
            self.action_token = action_token
            self.cookies      = cookies
            self.session_id   = cookies.get("session_id", str(uuid.uuid4()))

        finally:
            try:
                page.quit()
            except Exception:
                pass


# ═══════════════════════════════════════════════════════════
# §6 — ASYNC STREAM BRIDGE
# ═══════════════════════════════════════════════════════════
_SENTINEL = object()

async def _bridge_stream(producer_fn) -> AsyncGenerator[Tuple[str, str], None]:
    q = _queue.Queue()
    loop = asyncio.get_running_loop()

    def _wrapper():
        try:
            producer_fn(q)
        except Exception as e:
            q.put(e)
        finally:
            q.put(_SENTINEL)

    task = loop.run_in_executor(None, _wrapper)

    while True:
        try:
            item = await loop.run_in_executor(
                None, lambda: q.get(timeout=2.0)
            )
        except _queue.Empty:
            if task.done():
                while not q.empty():
                    try:
                        item = q.get_nowait()
                        if item is _SENTINEL:
                            break
                        if isinstance(item, Exception):
                            raise item
                        yield item
                    except _queue.Empty:
                        break
                break
            continue

        if item is _SENTINEL:
            break
        if isinstance(item, Exception):
            raise item
        yield item

    try:
        await task
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════
# §7 — MAIN PROVIDER
# ═══════════════════════════════════════════════════════════
class UpstageProvider:
    """
    ☀️ Upstage Solar — Async Reasoning Model Provider

    4 models · Web search · Reasoning modes
    Credential caching for instant subsequent startups

    ┌─────────────────────────────────────────────────────┐
    │  up = UpstageProvider()                             │
    │  up = UpstageProvider(model="solar-pro3")           │
    │                                                     │
    │  # Simple prompt                                    │
    │  async for t in up.chat(data="Hello!"):             │
    │      print(t, end="")                               │
    │                                                     │
    │  # Full messages with system                        │
    │  async for t in up.chat(                            │
    │      messages=[                                     │
    │          {"role":"system", "content":"You are Bob"},│
    │          {"role":"user",   "content":"Name?"},      │
    │      ],                                             │
    │      model="solar-pro2",                            │
    │      search=True,                                   │
    │  ):                                                 │
    │      print(t, end="")                               │
    │                                                     │
    │  # After chat:                                      │
    │  up.last_response      # text content               │
    │  up.last_reasoning     # reasoning trace            │
    │  up.last_sources       # [{index,title,url}, ...]   │
    │  up.last_sources_text  # formatted text block       │
    └─────────────────────────────────────────────────────┘

    Priority:
        messages given  →  data is IGNORED
        messages empty  →  data is used
    """

    def __init__(
        self,
        model:       str   = None,
        system:      str   = "",
        search:      bool  = False,
        max_tokens:  int   = None,
        temperature: float = None,
    ):
        self.model       = _resolve_model(model) if model else "solar-pro3"
        self.system      = system
        self.search      = search
        self.max_tokens  = max_tokens
        self.temperature = temperature

        self.history:           List[Dict] = []
        self.last_response:     str        = ""
        self.last_reasoning:    str        = ""
        self.last_sources:      List[Dict] = []
        self.last_sources_text: str        = ""
        self.last_sources_json: str        = ""

        self._creds     = _Creds()
        self._connected = False

        atexit.register(self._sync_cleanup)

    def _sync_cleanup(self):
        pass  # nothing to cleanup synchronously

    # ═══════════════════════════════════════════════════
    # CONNECTION PIPELINE
    # ═══════════════════════════════════════════════════
    async def connect(self):
        """
        Explicitly connect to Upstage.
        Tries cached credentials first (instant).
        Falls back to browser capture if needed.
        Called automatically on first chat().
        """
        loaded = await self._creds.load()

        if loaded:
            token = await self._creds.verify()
            if token:
                self._connected = True
                return

        # Credentials expired or missing — capture
        await self._creds.capture()
        self._connected = True

    async def _ensure_connected(self):
        if not self._connected:
            await self.connect()

    # ── Get CSRF token (with auto-refresh) ────────────
    async def _get_csrf(self) -> str:
        token = await self._creds.verify()
        if token:
            return token

        # Refresh
        await self._creds.capture()
        token = await self._creds.verify()
        if token:
            return token

        raise RuntimeError(
            f"Could not obtain CSRF token. "
            f"Try deleting {_CRED_FILE} and restarting."
        )

    # ── Payload builder (pure logic) ──────────────────
    def _build_payload(
        self,
        messages:    List[Dict],
        model:       str,
        search:      bool,
        reasoning:   Optional[str],
        temperature: Optional[float],
        max_tokens:  Optional[int],
    ) -> Dict:
        cfg  = _MODELS.get(model, _MODELS["solar-pro3"])
        temp = (
            temperature if temperature is not None
            else (self.temperature or cfg["temperature"])
        )
        tok = (
            max_tokens if max_tokens is not None
            else (self.max_tokens or cfg["max_tokens"])
        )

        msgs = [m.copy() for m in messages]

        if not msgs or msgs[0].get("role") != "system":
            sys_content = self.system or cfg["system"] or ""
            if sys_content:
                msgs.insert(0, {"role": "system", "content": sys_content})

        if search and cfg["search"]:
            for m in reversed(msgs):
                if m["role"] == "user":
                    m["mode"] = ["search"]
                    break

        payload: Dict = {
            "conversation_id": str(uuid.uuid4()),
            "stream":          True,
            "log_enabled":     True,
            "messages":        msgs,
            "model":           model,
            "temperature":     temp,
            "max_tokens":      tok,
        }

        # Automatically set reasoning based on search
        # If search is enabled: HIGH reasoning
        # If search is disabled: LOW reasoning
        if cfg.get("reasoning"):
            valid_reasoning = cfg["reasoning"]
            
            # Auto-select reasoning based on search
            if search:
                # Use high reasoning with search
                if "high" in valid_reasoning:
                    effort = "high"
                else:
                    effort = valid_reasoning[-1]  # Highest available
            else:
                # Use low reasoning without search
                if "low" in valid_reasoning:
                    effort = "low"
                else:
                    effort = valid_reasoning[0]  # Lowest available
            
            # Override with explicit reasoning if provided
            if reasoning and reasoning in valid_reasoning:
                effort = reasoning
                
            payload["reasoning_effort"] = effort

        if cfg.get("metadata"):
            payload["metadata"] = cfg["metadata"]

        if search and cfg["search"]:
            payload["search_provider"] = "tavily"

        return payload

    # ── Stream via thread bridge ──────────────────────
    async def _stream_events(
        self, payload: Dict
    ) -> AsyncGenerator[Tuple[str, str], None]:

        csrf       = await self._get_csrf()
        cookies    = dict(self._creds.cookies)
        session_id = self._creds.session_id

        def _producer(q: _queue.Queue):
            http = requests.Session()
            http.headers["User-Agent"] = _UA

            headers = {
                "accept":                    "*/*",
                "content-type":              "application/json",
                "origin":                    _CONSOLE,
                "referer":                   f"{_CONSOLE}/",
                "x-csrf-token":             csrf,
                "x-session-id":             session_id,
                "x-upstage-logging-enabled": "true",
            }

            resp = http.post(
                _COMP_URL,
                headers=headers,
                json=payload,
                stream=True,
                cookies=cookies,
            )

            if resp.status_code in (401, 403):
                raise RuntimeError(f"Auth error: HTTP {resp.status_code}")

            resp.raise_for_status()

            in_think = [False]

            for raw in resp.iter_lines():
                line = raw.decode("utf-8") if isinstance(raw, bytes) else raw
                if not line:
                    continue

                event = _SSE.parse_line(line, in_think)
                if event:
                    q.put(event)
                    if event[0] == "done":
                        return

            http.close()

        try:
            async for event in _bridge_stream(_producer):
                yield event

        except RuntimeError as e:
            if "Auth error" in str(e):
                # Re-capture and retry once
                await self._creds.capture()
                csrf2 = await self._get_csrf()

                def _retry_producer(q: _queue.Queue):
                    http = requests.Session()
                    http.headers["User-Agent"] = _UA

                    headers = {
                        "accept":                    "*/*",
                        "content-type":              "application/json",
                        "origin":                    _CONSOLE,
                        "referer":                   f"{_CONSOLE}/",
                        "x-csrf-token":             csrf2,
                        "x-session-id":             self._creds.session_id,
                        "x-upstage-logging-enabled": "true",
                    }

                    resp = http.post(
                        _COMP_URL,
                        headers=headers,
                        json=payload,
                        stream=True,
                        cookies=self._creds.cookies,
                    )
                    resp.raise_for_status()

                    in_think = [False]
                    for raw in resp.iter_lines():
                        line = raw.decode("utf-8") if isinstance(raw, bytes) else line
                        if not line:
                            continue
                        event = _SSE.parse_line(line, in_think)
                        if event:
                            q.put(event)
                            if event[0] == "done":
                                return
                    http.close()

                async for event in _bridge_stream(_retry_producer):
                    yield event
            else:
                raise

    # ═══════════════════════════════════════════════════
    # ★  CHAT  (async generator)
    # ═══════════════════════════════════════════════════
    async def chat(
        self,
        data:        str   = None,
        messages:    List[Dict] = None,
        model:       str   = None,
        system:      str   = None,
        reasoning:   str   = None,
        search:      bool  = None,
        max_tokens:  int   = None,
        temperature: float = None,
    ) -> AsyncGenerator[str, None]:
        """
        Async-stream tokens from Upstage Solar.

        Args:
            data        : Simple prompt (ignored if messages given)
            messages    : OpenAI-style [{role, content}]
            model       : Override model (solar-pro3/pro2/syn-pro/mini)
            system      : Override system prompt
            reasoning   : Reasoning effort (low/medium/high)
            search      : Web search enabled
            max_tokens  : Max output tokens
            temperature : Sampling temperature

        Yields:
            str: Each token (sources JSON first, then reasoning + text)

        After iteration:
            .last_response      — text content only
            .last_reasoning     — reasoning trace only
            .last_sources       — [{index, query, title, url, score, snippet}]
            .last_sources_text  — formatted text block
        """

        if not messages and not data:
            raise ValueError("Provide 'messages' or 'data'")

        await self._ensure_connected()

        # ── Resolve model ──────────────────────────────
        use_model = _resolve_model(model) if model else self.model

        # ── Resolve options ────────────────────────────
        use_search    = search if search is not None else self.search

        # ── Build messages ─────────────────────────────
        if messages:
            # ┌─────────────────────────────────────────┐
            # │  MESSAGES MODE — data is IGNORED        │
            # └─────────────────────────────────────────┘
            use_system = system if system is not None else self.system
            clean: List[Dict] = []
            for msg in messages:
                role    = msg.get("role", "")
                content = msg.get("content", "")
                if isinstance(content, list):
                    content = " ".join(
                        p.get("text", "") for p in content
                        if p.get("type") == "text"
                    )
                if role == "system":
                    use_system = content
                elif role in ("user", "assistant"):
                    clean.append({"role": role, "content": content})
            self.history = clean

            send_msgs: List[Dict] = []
            if use_system:
                send_msgs.append({"role": "system", "content": use_system})
            send_msgs.extend(clean)

        else:
            # ┌─────────────────────────────────────────┐
            # │  DATA MODE — append to history          │
            # └─────────────────────────────────────────┘
            use_system = system if system is not None else self.system
            self.history.append({"role": "user", "content": data})

            send_msgs = []
            if use_system:
                send_msgs.append({"role": "system", "content": use_system})
            send_msgs.extend(self.history)

        # ── Build payload ──────────────────────────────
        payload = self._build_payload(
            send_msgs, use_model, use_search,
            reasoning, temperature, max_tokens,
        )

        # ── Stream response ────────────────────────────
        reasoning_parts: List[str] = []
        content_parts:   List[str] = []
        raw_sources:     List[str] = []
        sources_yielded = False
        
        # Process the stream events
        async for etype, econtent in self._stream_events(payload):
            if etype == "done":
                break

            # Handle sources
            elif etype == "source":
                raw_sources.append(econtent)
                
                # When we collect sources, format and yield them as JSON first
                if use_search and not sources_yielded and raw_sources:
                    sources_yielded = True
                    formatted_sources = _Sources.parse(raw_sources)
                    self.last_sources = formatted_sources
                    self.last_sources_json = _Sources.format_json(formatted_sources)
                    self.last_sources_text = _Sources.format_text(formatted_sources)
                    
                    # First yield the sources as JSON
                    yield self.last_sources_json

            # Collect reasoning tokens
            elif etype == "r-delta":
                reasoning_parts.append(econtent)
                yield econtent

            # Collect content tokens
            elif etype == "t-delta":
                content_parts.append(econtent)
                yield econtent

        # ── Finalize ───────────────────────────────────
        self.last_response  = "".join(content_parts)
        self.last_reasoning = "".join(reasoning_parts)
        
        # Update sources one more time if new ones arrived
        if raw_sources:
            final_sources = _Sources.parse(raw_sources)
            if final_sources != self.last_sources:
                self.last_sources = final_sources
                self.last_sources_text = _Sources.format_text(final_sources)
                self.last_sources_json = _Sources.format_json(final_sources)

        if self.last_response:
            self.history.append({
                "role":    "assistant",
                "content": self.last_response,
            })

    # ═══════════════════════════════════════════════════
    # SETTERS (chainable)
    # ═══════════════════════════════════════════════════
    def set_model(self, model: str) -> "UpstageProvider":
        self.model = _resolve_model(model)
        return self

    def set_system(self, prompt: str) -> "UpstageProvider":
        self.system = prompt
        return self

    def set_search(self, enabled: bool) -> "UpstageProvider":
        self.search = enabled
        return self

    def set_temperature(self, t: float) -> "UpstageProvider":
        self.temperature = t
        return self

    def set_max_tokens(self, n: int) -> "UpstageProvider":
        self.max_tokens = n
        return self

    # ── History ──────────────────────────────────────────
    def clear_history(self):
        self.history.clear()

    def get_history(self) -> List[Dict]:
        out: List[Dict] = []
        if self.system:
            out.append({"role": "system", "content": self.system})
        out.extend(self.history)
        return out

    def get_sources(self) -> List[Dict]:
        return self.last_sources

    def get_sources_text(self) -> str:
        return self.last_sources_text
        
    def get_sources_json(self) -> str:
        return self.last_sources_json

    def new_session(self):
        self.history.clear()
        self.last_response     = ""
        self.last_reasoning    = ""
        self.last_sources      = []
        self.last_sources_text = ""
        self.last_sources_json = ""

    async def refresh_credentials(self):
        """Force re-capture credentials via browser."""
        await self._creds.capture()

    @staticmethod
    async def clear_credentials():
        """Delete cached credentials file."""
        creds = _Creds()
        await creds.clear()

    # ═══════════════════════════════════════════════════
    # INFO
    # ═══════════════════════════════════════════════════
    def list_models(self) -> List[Dict]:
        return [{
            "name":       name,
            "short":      name.split("/")[-1],
            "reasoning":  cfg.get("reasoning"),
            "search":     cfg.get("search", False),
            "max_tokens": cfg.get("max_tokens"),
            "active":     name == self.model,
        } for name, cfg in _MODELS.items()]

    @staticmethod
    def available_models() -> List[str]:
        return list(_MODELS.keys())

    @staticmethod
    def model_info() -> Dict:
        return {
            "name":     "Upstage Solar",
            "provider": "Upstage AI",
            "models":   list(_MODELS.keys()),
            "thinking": True,
            "search":   True,
        }

    # ═══════════════════════════════════════════════════
    # LIFECYCLE
    # ═══════════════════════════════════════════════════
    async def close(self):
        pass  # no persistent connection to close

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()

    def __repr__(self):
        s = "🔍" if self.search else ""
        r = "💭high" if self.search else "💭low"
        flags = f" {s}{r}".rstrip()
        return (
            f"UpstageProvider("
            f"model={self.model!r}, "
            f"via={'cached' if self._connected else 'not-connected'}, "
            f"history={len(self.history)}"
            f"{flags})"
        )



async def interactive_chat():
    print("=" * 70)
    print("  ☀️  Upstage Solar Interactive Chat")
    print("  Commands: 'exit', 'clear', 'search on/off', 'model <name>'")
    print("=" * 70)
    print()
    
    up = UpstageProvider(
        model="solar-pro3",
        system="You are a helpful AI assistant.",
        search=False  # Start with fast mode (LOW reasoning)
    )
    
    print(f"Current: {up.model} | Search: {up.search} (reasoning: auto)")
    
    while True:
        try:
            user_input = input("\n👤 You: ").strip()
            
            if not user_input:
                continue
            
            if user_input.lower() == 'exit':
                print("\n👋 Goodbye!")
                break
            
            if user_input.lower() == 'clear':
                up.new_session()
                print("\n✓ Started new conversation")
                continue
            
            if user_input.lower().startswith('search '):
                cmd = user_input[7:].lower()
                up.set_search(cmd == 'on')
                print(f"\n✓ Search: {up.search} (reasoning: {'HIGH' if up.search else 'LOW'})")
                continue
            
            if user_input.lower().startswith('model '):
                model_name = user_input[6:].strip()
                up.set_model(model_name)
                print(f"\n✓ Model: {up.model}")
                continue
            
            # Stream response
            print("\n🤖 Solar: ", end="", flush=True)
            
            async for token in up.chat(data=user_input):
                print(token, end="", flush=True)
            
            print()
            
            # Show sources
            if up.last_sources:
                print(f"\n📚 {len(up.last_sources)} sources used")
        
        except KeyboardInterrupt:
            print("\n\n👋 Goodbye!")
            break
        except Exception as e:
            print(f"\n❌ Error: {e}")


if __name__ == "__main__":
    asyncio.run(interactive_chat())