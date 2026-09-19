"""
══════════════════════════════════════════════════════════════════
  ☀️  Upstage Solar Provider  — v3, fully async, curl_cffi only

  Async streaming reasoning model via console.upstage.ai
  4 models · Web search · Reasoning modes
  Auto-credentials via PURE HTTP (curl_cffi) · Cached to disk
  NO requests · NO DrissionPage · NO threads · NO fake "hi" prompt

  ┌────────────────────────────────────────────────────────────┐
  │  v3 changes (the "realtime" rebuild):                      │
  │                                                            │
  │  • 100% asyncio — one event loop, zero thread bridges.     │
  │    The v2 design ran the completion stream in a worker     │
  │    thread (plain `requests` + queue polling). v3 streams   │
  │    with curl_cffi's native AsyncSession:                   │
  │                                                            │
  │        async for line in r.aiter_lines():  → yield         │
  │                                                            │
  │    Every chunk is parsed and yielded the instant it hits   │
  │    the socket — true realtime.                             │
  │  • curl_cffi ONLY — Chrome TLS impersonation on every      │
  │    call (credentials AND completions). `requests` is gone. │
  │  • Typed stream: stream() yields StreamEvent(kind, text)   │
  │    with kind ∈ {"sources","thinking","content","done"}.    │
  │    chat() stays as the plain-string convenience API.       │
  │  • Usage department: TurnUsage + SessionUsage.             │
  │    Every turn records elapsed time, time-to-first-token,   │
  │    thinking/answer char counts, estimated tokens,          │
  │    tokens/sec, sources, API-reported usage (when non-zero).│
  │    → up.last_usage, up.session_usage.format_report()       │
  └────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────┐
  │  Credential Pipeline (v2, kept — no browser):              │
  │                                                            │
  │  The console is a Next.js app. Its client JS bundles embed │
  │  every server action id, e.g.:                             │
  │                                                            │
  │    createServerReference)("002f44cb…d5", …,               │
  │        "getConsoleCsrfToken")                              │
  │                                                            │
  │  1. Load cache/upstage_creds.json                          │
  │  2. Verify CSRF token via RSC POST                         │
  │  3. Valid?  → Instant start                                │
  │  4. Invalid → pure-HTTP re-capture:                        │
  │       a. GET /playground/chat  → session cookies           │
  │       b. read its JS chunks, regex out the action id       │
  │          BY NAME (robust to id-length changes)             │
  │       c. RSC POST (data="[]") → parse the token            │
  │       d. save cookies + action ids                         │
  │                                                            │
  │  First run : ~2-5s   (GET + chunk scan)                    │
  │  Next runs : ~1-2s   (cached credentials)                  │
  └────────────────────────────────────────────────────────────┘

  Usage:
      from upstage_provider import UpstageProvider

      up = UpstageProvider()

      # plain strings (v1/v2 compatible):
      async for token in up.chat(data="Hello!"):
          print(token, end="", flush=True)

      # typed, realtime events:
      async for ev in up.stream(data="What is 2+2?"):
          if ev.kind == "sources":   print(ev.text)
          elif ev.kind == "thinking": print(ev.text, end="")   # dim
          elif ev.kind == "content":  print(ev.text, end="")   # bright

      # after a turn:
      up.last_response      # text content (no think markup)
      up.last_reasoning     # reasoning trace
      up.last_sources       # [{index,title,url}, ...]
      up.last_usage         # TurnUsage (timing, tokens, …)
      up.session_usage.format_report()   # the usage department
══════════════════════════════════════════════════════════════
"""

from __future__ import annotations

import json
import os as _os
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple

from curl_cffi import requests as _cffi

# ═══════════════════════════════════════════════════════════
# §1 — CONSTANTS
# ═══════════════════════════════════════════════════════════
_CONSOLE  = "https://console.upstage.ai"
_API_HOST = "https://ap-northeast-2.apistage.ai"
_CHAT_EP  = "/playground/chat"
_COMP_URL = f"{_API_HOST}/v1/web/demo/chat/completions?include_think=true"

def _cred_file() -> Path:
    """Resolved at call time so UPSTAGE_CACHE_DIR can change post-import."""
    return Path(_os.getenv("UPSTAGE_CACHE_DIR", "/tmp/.cache/upstage")) / \
        "upstage_creds.json"

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/146.0.0.0 Safari/537.36"
)

# Action names to extract from the client JS bundles (stable across
# builds — only the 42-hex ids change on redeploys).
_ACTION_TOKEN = "getConsoleCsrfToken"   # → {"token": "<jwt>"}
_ACTION_INIT  = "authAction"            # → flight "1:null" (kept for parity)

# Cap on how many JS chunks we scan during capture.
_MAX_CHUNK_SCAN = 80

_UA_HEADERS = {"User-Agent": _UA}

# (connect_timeout, read_timeout) — curl_cffi makes the total
# connect+read, so a 5-minute envelope is plenty for long generations.
_CONNECT_TIMEOUT = 15
_STREAM_TIMEOUT   = 300


def _http_session() -> "_cffi.AsyncSession":
    """curl_cffi async session impersonating Chrome's TLS fingerprint."""
    return _cffi.AsyncSession(impersonate="chrome")


# ═══════════════════════════════════════════════════════════
# §2 — ERRORS
# ═══════════════════════════════════════════════════════════
class UpstageError(Exception):
    """Base class for all provider errors."""


class UpstageAuthError(UpstageError):
    """Credentials invalid / rejected — a re-capture was attempted."""


class UpstageStreamError(UpstageError):
    """The stream could not be established or died mid-flight."""


# ═══════════════════════════════════════════════════════════
# §3 — MODEL REGISTRY
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
# §4 — SSE PARSER
# ═══════════════════════════════════════════════════════════
class _SSE:
    """
    Parse Upstage SSE lines into a list of (event_type, content) tuples.

    Event types:
        "r-delta"   — reasoning token (delta.reasoning_content)
        "t-delta"   — text/content token (delta.content)
        "source"    — search results JSON string
        "s-start"   — search started
        "s-summary" — summarizing
        "usage"     — non-zero usage block from the API (JSON string)
        "done"      — stream finished (always last, if present)

    A single line can produce several events (e.g. the final chunk
    carries both `usage` and `finish_reason: stop`).
    """

    @staticmethod
    def parse_line(line: str) -> List[Tuple[str, str]]:
        if not line or not line.startswith("data: "):
            return []

        data = line[6:].strip()
        if data == "[DONE]":
            return [("done", "")]

        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            return []

        events: List[Tuple[str, str]] = []

        # ── Search events (arrived without choices) ──
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
                events.append(("s-start", query))
            elif action == "search_finish":
                if raw_sq:
                    events.append(("source", json.dumps(raw_sq)))
            elif action == "summarizing":
                events.append(("s-summary", desc))
        else:
            # ── Content / Thinking chunks ──
            choices = obj.get("choices")
            if choices:
                delta  = choices[0].get("delta", {})
                finish = choices[0].get("finish_reason")

                rc = delta.get("reasoning_content", "")
                if rc:
                    events.append(("r-delta", rc))

                text = delta.get("content", "")
                if text:
                    # <think> splitting happens one level up
                    events.append(("t-delta", text))

        # ── Usage (only when the API reports non-zero counts) ──
        usage = obj.get("usage")
        if isinstance(usage, dict) and (
            usage.get("prompt_tokens") or usage.get("completion_tokens")
            or usage.get("total_tokens")
        ):
            events.append(("usage", json.dumps(usage)))

        # ── done LAST so a same-line usage event is not skipped ──
        if obj.get("choices") and obj["choices"][0].get("finish_reason") == "stop":
            events.append(("done", ""))

        return events


# ═══════════════════════════════════════════════════════════
# §5 — SOURCE FORMATTER
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
            lines.append(f"  │  [{s.get('index', '?')}] {s.get('title', '')}")
            lines.append(f"  │      {s.get('url', '')}")
            if s.get("score"):
                try:
                    lines.append(f"  │      Score: {float(s['score']):.4f}")
                except (TypeError, ValueError):
                    pass
        lines.append("  └─────────────────────────────────────────")
        return "\n".join(lines)

    @staticmethod
    def format_json(sources: List[Dict]) -> str:
        """Format sources as a JSON string for streaming."""
        clean_sources = []
        for src in sources:
            clean_sources.append({
                "title": src.get("title", ""),
                "url":   src.get("url", ""),
                "score": src.get("score", 0),
            })
        return json.dumps({"sources": clean_sources})


# ═══════════════════════════════════════════════════════════
# §6 — THINK SPLITTER
# ═══════════════════════════════════════════════════════════
_OPEN  = "<think>"
_CLOSE = "</think>"


class ThinkSplitter:
    """
    The backend inlines thinking INSIDE content deltas as
    <think>…</think> markup, and tags can be split across tokens.
    Feed it raw content tokens; get back (kind, segment) pairs with
    kind ∈ {"content", "thinking"} — each segment clean of markup.

    A trailing partial tag (e.g. buffer ending in `<thi`) is held
    back until the next feed() decides what it was; flush() releases
    whatever remains when the stream ends.
    """

    def __init__(self, open_tag: str = _OPEN, close_tag: str = _CLOSE):
        self._open  = open_tag
        self._close = close_tag
        self._buf   = ""
        self._in    = False

    def feed(self, text: str) -> List[Tuple[str, str]]:
        out: List[Tuple[str, str]] = []
        self._buf += text
        while True:
            if self._in:
                j = self._buf.find(self._close)
                if j == -1:
                    hold = len(self._close) - 1
                    if len(self._buf) > hold:
                        seg, self._buf = self._buf[:-hold], self._buf[-hold:]
                    else:
                        seg = ""
                    if seg:
                        out.append(("thinking", seg))
                    break
                seg = self._buf[:j]
                if seg:
                    out.append(("thinking", seg))
                self._in  = False
                self._buf = self._buf[j + len(self._close):]
            else:
                i = self._buf.find(self._open)
                if i == -1:
                    hold = len(self._open) - 1
                    if len(self._buf) > hold:
                        seg, self._buf = self._buf[:-hold], self._buf[-hold:]
                    else:
                        seg = ""
                    if seg:
                        out.append(("content", seg))
                    break
                seg = self._buf[:i]
                if seg:
                    out.append(("content", seg))
                self._in  = True
                self._buf = self._buf[i + len(self._open):]
        return out

    def flush(self) -> List[Tuple[str, str]]:
        """Release anything still buffered (stream over)."""
        if not self._buf:
            return []
        kind = "thinking" if self._in else "content"
        seg, self._buf = self._buf, ""
        return [(kind, seg)]


# ═══════════════════════════════════════════════════════════
# §7 — USAGE DEPARTMENT
# ═══════════════════════════════════════════════════════════
@dataclass
class TurnUsage:
    """Measured stats for one chat turn."""
    model:            str    = "solar-pro3"
    ok:               bool   = True
    error:            str    = ""
    prompt_chars:     int    = 0
    thinking_chars:   int    = 0
    content_chars:    int    = 0
    n_sources:        int    = 0
    api_usage:        Optional[Dict[str, Any]] = None   # when non-zero
    elapsed_s:        float  = 0.0
    first_token_s:    Optional[float] = None

    # ── tokens: API-reported if present, else chars/4 estimate ──
    @property
    def tokens_estimated(self) -> bool:
        return not (self.api_usage
                    and (self.api_usage.get("total_tokens") or 0) > 0)

    @property
    def tokens(self) -> int:
        if not self.tokens_estimated:
            return int(self.api_usage.get("total_tokens") or 0)
        chars = self.thinking_chars + self.content_chars
        # any non-empty response is at least one token
        return max(1, round(chars / 4)) if chars > 0 else 0

    @property
    def tokens_per_s(self) -> Optional[float]:
        if self.elapsed_s <= 0:
            return None
        return self.tokens / self.elapsed_s

    def format_line(self) -> str:
        bits = [f"⏱ {self.elapsed_s:.1f}s"]
        if self.first_token_s is not None:
            bits.append(f"first token {self.first_token_s:.2f}s")
        if self.tokens:
            est = " (est)" if self.tokens_estimated else ""
            bits.append(f"~{self.tokens} tok{est}")
            if self.tokens_per_s:
                bits.append(f"{self.tokens_per_s:.0f} tok/s")
        if self.thinking_chars:
            bits.append(f"💭 {self.thinking_chars}c")
        bits.append(self.model)
        if self.n_sources:
            bits.append(f"📚 {self.n_sources}")
        if not self.ok:
            bits.append(f"✗ {self.error[:40]}")
        return " · ".join(bits)


class SessionUsage:
    """Accumulates TurnUsage across a provider's lifetime."""

    def __init__(self) -> None:
        self.turns: List[TurnUsage] = []

    def add(self, turn: TurnUsage) -> None:
        self.turns.append(turn)

    def clear(self) -> None:
        self.turns.clear()

    def totals(self) -> Dict[str, Any]:
        ok = [t for t in self.turns if t.ok]
        return {
            "turns":        len(self.turns),
            "ok":           len(ok),
            "failed":       len(self.turns) - len(ok),
            "elapsed_s":    round(sum(t.elapsed_s for t in ok), 2),
            "tokens":       sum(t.tokens for t in ok),
            "thinking_chars": sum(t.thinking_chars for t in ok),
            "content_chars":  sum(t.content_chars for t in ok),
            "sources":      sum(t.n_sources for t in ok),
        }

    def format_report(self) -> str:
        if not self.turns:
            return "  (no turns yet)"
        lines = [
            "",
            "  ┌──────────────────────────────────────────────────────────────────",
            "  │ 📊 Session usage",
            "  │  turn  status      time     tokens   thinking  answer   src  model",
            "  │  ──────  ─────────  ──────  ────────  ────────  ──────  ───  ─────",
        ]
        for i, t in enumerate(self.turns, 1):
            status = "✓" if t.ok else f"✗ {t.error[:14]}"
            lines.append(
                f"  │  {i:<6} {status:<11} {t.elapsed_s:>5.1f}s  {t.tokens:>6}  "
                f"{t.thinking_chars:>6}    {t.content_chars:>4}   {t.n_sources:>2}  {t.model}"
            )
        tt = self.totals()
        lines.append("  │  ──────  ─────────  ──────  ────────  ────────  ──────  ───  ─────")
        lines.append(
            f"  │  TOTAL  {tt['turns']} turns ({tt['ok']} ok, {tt['failed']} failed) · "
            f"{tt['elapsed_s']:.1f}s · ~{tt['tokens']} tokens · "
            f"{tt['sources']} sources"
        )
        lines.append("  └──────────────────────────────────────────────────────────────────")
        return "\n".join(lines)


# ═══════════════════════════════════════════════════════════
# §8 — STREAM EVENTS
# ═══════════════════════════════════════════════════════════
@dataclass
class StreamEvent:
    """One realtime piece of the response.

    kind:
        "sources"   — search sources (JSON blob, streamed first)
        "thinking"  — reasoning token
        "content"   — answer token
        "done"      — stream finished (final event)
    """
    kind: str
    text: str = ""


# ═══════════════════════════════════════════════════════════
# §9 — CREDENTIAL MANAGER  (pure HTTP, fully async)
# ═══════════════════════════════════════════════════════════
def _find_action_id(js_text: str, action_name: str) -> Optional[str]:
    """
    Extract a Next.js server-action id from a client JS bundle by its
    declared name. Matches minified patterns like:

        createServerReference)("002f44cb…d5",x.callServer,void 0,x.findSourceMapURL,"getConsoleCsrfToken")

    The regex pins the id to its OWN argument list (exactly 3 unquoted
    args before the name), so when several actions are declared on one
    line (very common after minification) ids can't be cross-wired.
    No fixed length assumption (ids were 40 hex, now 42 — extract by
    name so future format changes don't break capture).
    """
    m = re.search(
        r'createServerReference\)\("([a-f0-9]{32,80})"(?:,[^,\"]+){3},'
        r'"' + re.escape(action_name) + r'"\)',
        js_text,
    )
    return m.group(1) if m else None


class _Creds:

    def __init__(self, path: Optional[Path] = None):
        self.path          = Path(path) if path else _cred_file()
        self.action_init:  Optional[str]  = None
        self.action_token: Optional[str]  = None
        self.cookies:      Dict[str, str] = {}
        self.session_id:   str            = str(uuid.uuid4())

    # ── Load / Save / Clear (tiny file → plain sync I/O) ──
    async def load(self) -> bool:
        if not self.path.exists():
            return False
        try:
            data = json.loads(self.path.read_text())
            self.action_init  = data.get("action_init")
            self.action_token = data.get("action_token")
            self.cookies      = data.get("cookies", {})
            self.session_id   = self.cookies.get("session_id", str(uuid.uuid4()))
            return bool(self.action_token)
        except Exception:
            return False

    async def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "action_init":  self.action_init,
            "action_token": self.action_token,
            "cookies":      self.cookies,
            "saved_at":     time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        self.path.write_text(json.dumps(data, indent=2))

    async def clear(self):
        try:
            if self.path.exists():
                self.path.unlink()
        except Exception:
            pass

    # ── Verify (one RSC POST) ─────────────────────────────
    async def verify(self) -> Optional[str]:
        if not self.action_token:
            return None
        try:
            async with _http_session() as http:
                return await self._try_get_token(http)
        except Exception:
            return None

    async def _rsc_post(self, http, action_id: str) -> str:
        headers = {
            "accept":       "text/x-component",
            "content-type": "text/plain;charset=UTF-8",
            "next-action":  action_id,
            "origin":       _CONSOLE,
            "referer":      f"{_CONSOLE}{_CHAT_EP}",
            "User-Agent":   _UA,
        }
        # NOTE: no next-router-state-tree needed — verified empirically
        # that the token action answers with and without it.
        r = await http.post(
            f"{_CONSOLE}{_CHAT_EP}",
            headers=headers, data="[]",
            cookies=self.cookies, timeout=20,
        )
        r.raise_for_status()
        return r.text

    async def _try_get_token(self, http) -> Optional[str]:
        try:
            body = await self._rsc_post(http, self.action_token)
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

    # ── Capture via pure HTTP (async) ─────────────────────
    async def capture(self):
        """
        Browser-free credential capture:

          1. GET /playground/chat        → session cookies + chunk list
          2. GET the RSC payload         → additional chunk refs (ins.)
          3. scan chunks for createServerReference("…","getConsoleCsrfToken")
          4. RSC POST with that id       → parse {"token": …}
          5. store cookies + ids
        """
        async with _http_session() as http:
            # 1) page load — sets the session cookies we need
            page = await http.get(f"{_CONSOLE}{_CHAT_EP}",
                                  headers=_UA_HEADERS, timeout=20)
            page.raise_for_status()
            html = page.text

            # 2) merge chunk refs from the page + its RSC payload
            chunk_refs = sorted(set(re.findall(r'static/chunks/[^\\"\\s\],]+\.js', html)))
            try:
                rsc = await http.get(
                    f"{_CONSOLE}{_CHAT_EP}",
                    headers={**_UA_HEADERS, "RSC": "1"},
                    timeout=20,
                )
                if rsc.status_code == 200:
                    chunk_refs = sorted(set(chunk_refs) | set(
                        re.findall(r'static/chunks/[^\\"\\s\],]+\.js', rsc.text)))
            except Exception:
                pass  # RSC scan is insurance only

            # 3) scan chunks for the action ids (by name)
            action_token: Optional[str] = None
            action_init:  Optional[str] = None
            scanned = 0
            for ref in chunk_refs[:_MAX_CHUNK_SCAN]:
                scanned += 1
                try:
                    r = await http.get(f"{_CONSOLE}/_next/{ref}",
                                       headers=_UA_HEADERS, timeout=20)
                except Exception:
                    continue
                if r.status_code != 200:
                    continue
                js = r.text
                if action_token is None and _ACTION_TOKEN in js:
                    action_token = _find_action_id(js, _ACTION_TOKEN)
                if action_init is None and _ACTION_INIT in js:
                    action_init = _find_action_id(js, _ACTION_INIT)
                if action_token:
                    break

            if not action_token:
                raise RuntimeError(
                    f"Could not find '{_ACTION_TOKEN}' action in any of "
                    f"{scanned} scanned JS chunks — the console may have "
                    f"changed structure. Delete {_cred_file()} and retry."
                )

            # 4) prove the action works + harvest a first token
            self._cookies_from(http)
            self.action_token = action_token
            self.action_init  = action_init
            body = await self._rsc_post(http, action_token)
            if '"token"' not in body:
                raise RuntimeError(
                    f"Token action '{action_token[:12]}…' answered but "
                    f"no token in response (len={len(body)})."
                )

            self.session_id = self.cookies.get("session_id", str(uuid.uuid4()))
        await self.save()

    def _cookies_from(self, http):
        try:
            d = http.cookies.get_dict()
            if isinstance(d, dict) and d:
                self.cookies = {str(k): str(v) for k, v in d.items()}
        except Exception:
            pass
        if "session_id" not in self.cookies:
            self.cookies["session_id"] = str(uuid.uuid4())


# ═══════════════════════════════════════════════════════════
# §10 — MAIN PROVIDER  (fully async, realtime)
# ═══════════════════════════════════════════════════════════
class UpstageProvider:
    provider_name = "upstage"
    models = list(_MODELS.keys())

    async def health_check(self):
        return {"ok": True, "provider": "upstage", "models": len(_MODELS), "connected": self._connected}

    """
    ☀️ Upstage Solar — Async Reasoning Model Provider (v3)

    4 models · Web search · Reasoning modes · Session usage stats
    100% asyncio streaming over curl_cffi (Chrome TLS impersonation)
    Credentials cached to disk for instant subsequent startups.

    ┌─────────────────────────────────────────────────────────┐
    │  up = UpstageProvider()                                 │
    │  up = UpstageProvider(model="solar-pro3")               │
    │                                                         │
    │  # Plain strings (backward compatible):                 │
    │  async for t in up.chat(data="Hello!"):                 │
    │      print(t, end="")                                   │
    │                                                         │
    │  # Typed realtime events:                               │
    │  async for ev in up.stream(                             │
    │      messages=[                                         │
    │          {"role":"system", "content":"You are Bob"},    │
    │          {"role":"user",   "content":"Name?"},          │
    │      ],                                                 │
    │      model="solar-pro2",                                │
    │      search=True,                                       │
    │  ):                                                     │
    │      if ev.kind == "thinking":  print(ev.text, dim)     │
    │      elif ev.kind == "content":  print(ev.text, bright) │
    │                                                         │
    │  # After chat:                                          │
    │  up.last_response      # text content                   │
    │  up.last_reasoning     # reasoning trace                │
    │  up.last_sources       # [{index,title,url}, ...]       │
    │  up.last_sources_text  # formatted text block           │
    │  up.last_usage         # TurnUsage (time/tokens/ttfb)   │
    │  up.session_usage.format_report()  # usage department   │
    └─────────────────────────────────────────────────────────┘

    Priority:
        messages given  →  data is IGNORED
        messages empty  →  data is used
    """

    def __init__(
        self,
        model:       Optional[str]   = None,
        system:      str   = "",
        search:      bool  = False,
        max_tokens:  Optional[int]   = None,
        temperature: Optional[float] = None,
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
        self.last_usage:        Optional[TurnUsage] = None

        self.session_usage = SessionUsage()

        self._creds     = _Creds()
        self._connected = False

    # ═══════════════════════════════════════════════════
    # CONNECTION PIPELINE
    # ═══════════════════════════════════════════════════
    async def connect(self):
        """
        Explicitly connect to Upstage.
        Tries cached credentials first (instant).
        Falls back to pure-HTTP re-capture if needed.
        Called automatically on first chat()/stream().
        """
        loaded = await self._creds.load()

        if loaded:
            token = await self._creds.verify()
            if token:
                self._connected = True
                return

        # Credentials expired or missing — re-capture over HTTP
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

        raise UpstageAuthError(
            f"Could not obtain CSRF token. "
            f"Try deleting {_cred_file()} and restarting."
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

        # Automatically set reasoning based on search:
        # search on  → HIGH reasoning · search off → LOW
        if cfg.get("reasoning"):
            valid_reasoning = cfg["reasoning"]

            if search:
                effort = ("high" if "high" in valid_reasoning
                          else valid_reasoning[-1])
            else:
                effort = ("low" if "low" in valid_reasoning
                          else valid_reasoning[0])

            # Override with explicit reasoning if provided
            if reasoning and reasoning in valid_reasoning:
                effort = reasoning

            payload["reasoning_effort"] = effort

        if cfg.get("metadata"):
            payload["metadata"] = cfg["metadata"]

        if search and cfg["search"]:
            payload["search_provider"] = "tavily"

        return payload

    # ═══════════════════════════════════════════════════
    # RAW STREAM  (native async curl_cffi — the realtime core)
    # ═══════════════════════════════════════════════════
    async def _stream_events(
        self, payload: Dict
    ) -> AsyncGenerator[Tuple[str, str], None]:
        """
        One attempt: POST the completion and yield (etype, econtent)
        tuples the instant each SSE line arrives on the socket.
        No threads, no queues, no polling — just aiter_lines().
        """
        csrf = await self._get_csrf()
        headers = {
            "accept":                    "*/*",
            "content-type":              "application/json",
            "origin":                    _CONSOLE,
            "referer":                   f"{_CONSOLE}/",
            "x-csrf-token":             csrf,
            "x-session-id":             self._creds.session_id,
            "x-upstage-logging-enabled": "true",
            "User-Agent":               _UA,
        }

        async with _http_session() as http:
            r = await http.post(
                _COMP_URL,
                json=payload,
                headers=headers,
                cookies=dict(self._creds.cookies),
                stream=True,
                timeout=(_CONNECT_TIMEOUT, _STREAM_TIMEOUT),
            )
            try:
                if r.status_code in (401, 403):
                    raise UpstageAuthError(
                        f"Auth error: HTTP {r.status_code}"
                    )
                if r.status_code != 200:
                    raise UpstageStreamError(
                        f"HTTP {r.status_code}: {r.text[:200]}"
                    )

                async for raw in r.aiter_lines():
                    line = (raw.decode("utf-8", "replace")
                            if isinstance(raw, (bytes, bytearray)) else raw)
                    for ev in _SSE.parse_line(line):
                        yield ev
                        if ev[0] == "done":
                            return
            finally:
                try:
                    await r.aclose()
                except Exception:
                    pass

    async def _events_with_retry(
        self, payload: Dict
    ) -> AsyncGenerator[Tuple[str, str], None]:
        """
        _stream_events with one auth-retry: on UpstageAuthError
        (401/403 — happens before any chunk is yielded) re-capture
        credentials once and try again.
        """
        for attempt in (1, 2):
            try:
                async for ev in self._stream_events(payload):
                    yield ev
                return
            except UpstageAuthError:
                if attempt == 1:
                    await self._creds.capture()
                    continue
                raise

    # ═══════════════════════════════════════════════════
    # ★  STREAM  (typed, realtime)
    # ═══════════════════════════════════════════════════
    async def stream(
        self,
        data:        Optional[str]   = None,
        messages:    Optional[List[Dict]] = None,
        model:       Optional[str]   = None,
        system:      Optional[str]   = None,
        reasoning:   Optional[str]   = None,
        search:      Optional[bool]  = None,
        max_tokens:  Optional[int]   = None,
        temperature: Optional[float] = None,
    ) -> AsyncGenerator[StreamEvent, None]:
        """
        Realtime async stream of the full response.

        Args:
            data        : Simple prompt (ignored if messages given)
            messages    : OpenAI-style [{role, content}]
            model       : Override model (solar-pro3/pro2/syn-pro/mini)
            system      : Override system prompt
            reasoning   : Reasoning effort (low/medium/high)
            search      : Web search enabled
            max_tokens  : Max output tokens
            temperature : Sampling temperature

        Yields StreamEvent(kind, text), kind ∈
            "sources"    — search sources JSON (first, when searching)
            "thinking"   — reasoning tokens (dim-friendly)
            "content"    — answer tokens
            "done"       — final event

        After iteration (even if abandoned early):
            .last_response / .last_reasoning / .last_sources
            .last_usage       — TurnUsage
            .session_usage    — accumulated usage department
        """
        if not messages and not data:
            raise ValueError("Provide 'messages' or 'data'")

        await self._ensure_connected()

        # ── Resolve model ──────────────────────────────
        use_model = _resolve_model(model) if model else self.model

        # ── Resolve options ────────────────────────────
        use_search = search if search is not None else self.search
        use_system = system if system is not None else self.system

        # ── Build messages ─────────────────────────────
        if messages:
            # MESSAGES MODE — data is IGNORED
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
            # DATA MODE — append to history
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

        # ── State for this turn ────────────────────────
        t0 = time.time()
        usage = TurnUsage(
            model=use_model,
            prompt_chars=len(json.dumps(send_msgs, ensure_ascii=False)),
        )
        splitter        = ThinkSplitter()
        reasoning_parts: List[str] = []
        content_parts:   List[str] = []
        raw_sources:     List[str] = []
        sources_yielded = False
        first_token:     Optional[float] = None
        completed       = False

        def _note(kind: str, seg: str):
            nonlocal first_token
            if first_token is None:
                first_token = time.time() - t0
            if kind == "thinking":
                reasoning_parts.append(seg)
                usage.thinking_chars += len(seg)
            else:
                content_parts.append(seg)
                usage.content_chars += len(seg)

        try:
            async for etype, econtent in self._events_with_retry(payload):
                if etype == "done":
                    break

                elif etype == "source":
                    raw_sources.append(econtent)
                    if use_search and not sources_yielded and raw_sources:
                        sources_yielded = True
                        fmt = _Sources.parse(raw_sources)
                        self.last_sources      = fmt
                        self.last_sources_json = _Sources.format_json(fmt)
                        self.last_sources_text = _Sources.format_text(fmt)
                        usage.n_sources        = len(fmt)
                        if first_token is None:
                            first_token = time.time() - t0
                        yield StreamEvent("sources", self.last_sources_json)

                elif etype == "usage":
                    try:
                        u = json.loads(econtent)
                        if isinstance(u, dict) and u:
                            usage.api_usage = u
                    except (json.JSONDecodeError, TypeError):
                        pass

                elif etype == "r-delta":
                    _note("thinking", econtent)
                    yield StreamEvent("thinking", econtent)

                elif etype == "t-delta":
                    for kind, seg in splitter.feed(econtent):
                        _note(kind, seg)
                        yield StreamEvent(kind, seg)

                # s-start / s-summary: internal, not surfaced

            # flush the splitter (stream finished cleanly)
            for kind, seg in splitter.flush():
                _note(kind, seg)
                yield StreamEvent(kind, seg)

            completed = True          # before the yield: a consumer that
            yield StreamEvent("done", "")   # stops *on* done is a clean exit

        except UpstageError as e:
            usage.ok    = False
            usage.error = ("auth: " if isinstance(e, UpstageAuthError) else "") + str(e)[:160]
            raise
        except Exception as e:
            usage.ok    = False
            usage.error = str(e)[:200]
            raise UpstageStreamError(f"stream failed: {e}") from e
        finally:
            # finalize state — runs on clean exit, early break,
            # GeneratorExit, and error paths alike
            if not completed:
                for kind, seg in splitter.flush():
                    _note(kind, seg)          # state only — no yield here
                if usage.ok and not usage.error:
                    usage.ok    = False
                    usage.error = "stream interrupted"

            usage.elapsed_s     = time.time() - t0
            usage.first_token_s = first_token
            self.last_response  = "".join(content_parts)
            self.last_reasoning = "".join(reasoning_parts)

            if raw_sources:
                fmt = _Sources.parse(raw_sources)
                if fmt:
                    self.last_sources      = fmt
                    self.last_sources_text = _Sources.format_text(fmt)
                    self.last_sources_json = _Sources.format_json(fmt)
                    usage.n_sources        = len(fmt)

            self.last_usage    = usage
            self.session_usage.add(usage)

            if usage.ok and self.last_response:
                self.history.append({
                    "role":    "assistant",
                    "content": self.last_response,
                })

    # ═══════════════════════════════════════════════════
    # ★  CHAT  (plain-string convenience, v1/v2 contract)
    # ═══════════════════════════════════════════════════
    async def chat(
        self,
        data:        Optional[str]   = None,
        messages:    Optional[List[Dict]] = None,
        model:       Optional[str]   = None,
        system:      Optional[str]   = None,
        reasoning:   Optional[str]   = None,
        search:      Optional[bool]  = None,
        max_tokens:  Optional[int]   = None,
        temperature: Optional[float] = None,
    ) -> AsyncGenerator[str, None]:
        """
        Async-stream tokens from Upstage Solar (plain strings).

        Yields the sources JSON blob first (when searching), then
        reasoning + answer tokens in realtime. Identical contract to
        the v1/v2 chat() — built on top of stream() now.
        """
        async for ev in self.stream(
            data=data, messages=messages, model=model, system=system,
            reasoning=reasoning, search=search, max_tokens=max_tokens,
            temperature=temperature,
        ):
            yield ev.text

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
        self.last_usage        = None
        self.session_usage.clear()

    async def refresh_credentials(self):
        """Force re-capture credentials (pure HTTP, ~2-5s)."""
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
        pass  # sessions are per-call — nothing persistent to close

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
            f"history={len(self.history)}, "
            f"turns={self.session_usage.totals()['turns']}"
            f"{flags})"
        )
