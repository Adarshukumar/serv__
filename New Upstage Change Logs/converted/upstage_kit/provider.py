"""
provider.py — Upstage Solar async provider (v3 semantics, hosts from config).

Public surface (identical contract to the original New Upstage
Change Logs/upstage_provider.py):

    up = UpstageProvider()
    async for tok in up.chat(data="Hello!"): ...          # plain strings
    async for ev  in up.stream(data="Hi"): ...            # StreamEvent(kind,text)
    up.last_response / last_reasoning / last_sources
    up.last_usage / up.session_usage.format_report()
"""
from __future__ import annotations

import json
import time
import uuid
from typing import AsyncGenerator, Dict, List, Optional, Tuple

from . import config
from .creds import Credentials, _http_session
from .protocol import (
    OPEN_THINK, CLOSE_THINK,
    SSEParser, SessionUsage, Sources, StreamEvent, ThinkSplitter, TurnUsage,
)


class UpstageError(Exception):
    """Base class for all provider errors."""


class UpstageAuthError(UpstageError):
    """Credentials invalid / rejected — a re-capture was attempted."""


class UpstageStreamError(UpstageError):
    """The stream could not be established or died mid-flight."""


class UpstageProvider:
    """☀️ Upstage Solar — async reasoning-model provider."""

    def __init__(
        self,
        model: Optional[str] = None,
        system: str = "",
        search: bool = False,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
    ):
        self.model = config.resolve_model(model) if model else "solar-pro3"
        self.system = system
        self.search = search
        self.max_tokens = max_tokens
        self.temperature = temperature

        self.history: List[Dict] = []
        self.last_response: str = ""
        self.last_reasoning: str = ""
        self.last_sources: List[Dict] = []
        self.last_sources_text: str = ""
        self.last_sources_json: str = ""
        self.last_usage: Optional[TurnUsage] = None

        self.session_usage = SessionUsage()

        self._creds = Credentials()
        self._connected = False

    # ═══════════════════════════════════════════════════
    # CONNECTION PIPELINE
    # ═══════════════════════════════════════════════════
    async def connect(self):
        loaded = await self._creds.load()
        if loaded:
            token = await self._creds.verify()
            if token:
                self._connected = True
                return
        await self._creds.capture()
        self._connected = True

    async def _ensure_connected(self):
        if not self._connected:
            await self.connect()

    async def _get_csrf(self) -> str:
        token = await self._creds.verify()
        if token:
            return token
        await self._creds.capture()
        token = await self._creds.verify()
        if token:
            return token
        raise UpstageAuthError(
            f"Could not obtain CSRF token. "
            f"Try deleting {config.cred_file()} and restarting."
        )

    # ── payload builder (pure logic) ────────────────────
    def _build_payload(
        self,
        messages: List[Dict],
        model: str,
        search: bool,
        reasoning: Optional[str],
        temperature: Optional[float],
        max_tokens: Optional[int],
    ) -> Dict:
        cfg = config.MODELS.get(model, config.MODELS["solar-pro3"])
        temp = (temperature if temperature is not None
                else (self.temperature or cfg["temperature"]))
        tok = (max_tokens if max_tokens is not None
               else (self.max_tokens or cfg["max_tokens"]))

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
            "stream": True,
            "log_enabled": True,
            "messages": msgs,
            "model": model,
            "temperature": temp,
            "max_tokens": tok,
        }

        # reasoning: search on → HIGH · off → LOW (explicit wins)
        if cfg.get("reasoning"):
            valid = cfg["reasoning"]
            if search:
                effort = "high" if "high" in valid else valid[-1]
            else:
                effort = "low" if "low" in valid else valid[0]
            if reasoning and reasoning in valid:
                effort = reasoning
            payload["reasoning_effort"] = effort

        if cfg.get("metadata"):
            payload["metadata"] = cfg["metadata"]

        if search and cfg["search"]:
            payload["search_provider"] = "tavily"

        return payload

    # ═══════════════════════════════════════════════════
    # RAW STREAM (native async curl_cffi)
    # ═══════════════════════════════════════════════════
    async def _stream_events(
        self, payload: Dict
    ) -> AsyncGenerator[Tuple[str, str], None]:
        csrf = await self._get_csrf()
        headers = {
            "accept": "*/*",
            "content-type": "application/json",
            "origin": config.console_url(),
            "referer": f"{config.console_url()}/",
            "x-csrf-token": csrf,
            "x-session-id": self._creds.session_id,
            "x-upstage-logging-enabled": "true",
            "User-Agent": config.UA,
        }

        async with _http_session() as http:
            r = await http.post(
                config.completions_url(),
                json=payload,
                headers=headers,
                cookies=dict(self._creds.cookies),
                stream=True,
                timeout=(config.CONNECT_TIMEOUT, config.STREAM_TIMEOUT),
            )
            try:
                if r.status_code in (401, 403):
                    raise UpstageAuthError(f"Auth error: HTTP {r.status_code}")
                if r.status_code != 200:
                    raise UpstageStreamError(
                        f"HTTP {r.status_code}: {r.text[:200]}"
                    )

                async for raw in r.aiter_lines():
                    line = (raw.decode("utf-8", "replace")
                            if isinstance(raw, (bytes, bytearray)) else raw)
                    for ev in SSEParser.parse_line(line):
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
    # ★ STREAM (typed, realtime)
    # ═══════════════════════════════════════════════════
    async def stream(
        self,
        data: Optional[str] = None,
        messages: Optional[List[Dict]] = None,
        model: Optional[str] = None,
        system: Optional[str] = None,
        reasoning: Optional[str] = None,
        search: Optional[bool] = None,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
    ) -> AsyncGenerator[StreamEvent, None]:
        if not messages and not data:
            raise ValueError("Provide 'messages' or 'data'")

        await self._ensure_connected()

        use_model = config.resolve_model(model) if model else self.model
        use_search = search if search is not None else self.search
        use_system = system if system is not None else self.system

        if messages:
            clean: List[Dict] = []
            for msg in messages:
                role = msg.get("role", "")
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
            self.history.append({"role": "user", "content": data})
            send_msgs = []
            if use_system:
                send_msgs.append({"role": "system", "content": use_system})
            send_msgs.extend(self.history)

        payload = self._build_payload(
            send_msgs, use_model, use_search,
            reasoning, temperature, max_tokens,
        )

        t0 = time.time()
        usage = TurnUsage(
            model=use_model,
            prompt_chars=len(json.dumps(send_msgs, ensure_ascii=False)),
        )
        splitter = ThinkSplitter()
        reasoning_parts: List[str] = []
        content_parts: List[str] = []
        raw_sources: List[str] = []
        sources_yielded = False
        first_token: Optional[float] = None
        completed = False

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
                        fmt = Sources.parse(raw_sources)
                        self.last_sources = fmt
                        self.last_sources_json = Sources.format_json(fmt)
                        self.last_sources_text = Sources.format_text(fmt)
                        usage.n_sources = len(fmt)
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

                # s-start / s-summary: internal only

            for kind, seg in splitter.flush():
                _note(kind, seg)
                yield StreamEvent(kind, seg)

            completed = True
            yield StreamEvent("done", "")

        except UpstageError as e:
            usage.ok = False
            usage.error = ("auth: " if isinstance(e, UpstageAuthError) else "") + str(e)[:160]
            raise
        except Exception as e:
            usage.ok = False
            usage.error = str(e)[:200]
            raise UpstageStreamError(f"stream failed: {e}") from e
        finally:
            if not completed:
                for kind, seg in splitter.flush():
                    _note(kind, seg)
                if usage.ok and not usage.error:
                    usage.ok = False
                    usage.error = "stream interrupted"

            usage.elapsed_s = time.time() - t0
            usage.first_token_s = first_token
            self.last_response = "".join(content_parts)
            self.last_reasoning = "".join(reasoning_parts)

            if raw_sources:
                fmt = Sources.parse(raw_sources)
                if fmt:
                    self.last_sources = fmt
                    self.last_sources_text = Sources.format_text(fmt)
                    self.last_sources_json = Sources.format_json(fmt)
                    usage.n_sources = len(fmt)

            self.last_usage = usage
            self.session_usage.add(usage)

            if usage.ok and self.last_response:
                self.history.append({
                    "role": "assistant",
                    "content": self.last_response,
                })

    # ═══════════════════════════════════════════════════
    # ★ CHAT (plain-string convenience)
    # ═══════════════════════════════════════════════════
    async def chat(
        self,
        data: Optional[str] = None,
        messages: Optional[List[Dict]] = None,
        model: Optional[str] = None,
        system: Optional[str] = None,
        reasoning: Optional[str] = None,
        search: Optional[bool] = None,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
    ) -> AsyncGenerator[str, None]:
        async for ev in self.stream(
            data=data, messages=messages, model=model, system=system,
            reasoning=reasoning, search=search, max_tokens=max_tokens,
            temperature=temperature,
        ):
            yield ev.text

    # ═══════════════════════════════════════════════════
    # SETTERS (chainable) + session helpers
    # ═══════════════════════════════════════════════════
    def set_model(self, model: str) -> "UpstageProvider":
        self.model = config.resolve_model(model)
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
        self.last_response = ""
        self.last_reasoning = ""
        self.last_sources = []
        self.last_sources_text = ""
        self.last_sources_json = ""
        self.last_usage = None
        self.session_usage.clear()

    async def refresh_credentials(self):
        await self._creds.capture()

    @staticmethod
    async def clear_credentials():
        await Credentials().clear()

    # ═══════════════════════════════════════════════════
    # INFO
    # ═══════════════════════════════════════════════════
    def list_models(self) -> List[Dict]:
        return [{
            "name": name,
            "short": name.split("/")[-1],
            "reasoning": cfg.get("reasoning"),
            "search": cfg.get("search", False),
            "max_tokens": cfg.get("max_tokens"),
            "active": name == self.model,
        } for name, cfg in config.MODELS.items()]

    @staticmethod
    def available_models() -> List[str]:
        return list(config.MODELS.keys())

    @staticmethod
    def model_info() -> Dict:
        return {
            "name": "Upstage Solar",
            "provider": "Upstage AI",
            "models": list(config.MODELS.keys()),
            "thinking": True,
            "search": True,
        }

    async def close(self):
        pass

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
