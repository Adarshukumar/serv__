from __future__ import annotations

import asyncio
import atexit
import json
import queue as _queue
import random
import string
import threading
import time
from typing import Optional, AsyncGenerator, List, Dict, Union, Any, Tuple

import cloudscraper


# ═══════════════════════════════════════════════════════════
# §1 — CONSTANTS
# ═══════════════════════════════════════════════════════════
_URL = "https://chat.inceptionlabs.ai"
_API = _URL + "/api/chat"
_SESSION_API = _URL + "/api/session"
_CHARS = string.ascii_letters + string.digits
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/136.0.0.0 Safari/537.36"
)

_PROXY = "http://217.217.249.160:8080"

_SYS_PREFIX = "[SYSTEM INSTRUCTION]"
_CRED_TTL = 43200  # 12 hours


def _proxy_dict(proxy: Optional[str] = _PROXY) -> Dict[str, str]:
    if not proxy:
        return {}
    return {"http": proxy, "https": proxy}


# ═══════════════════════════════════════════════════════════
# §2 — IN-MEMORY CREDENTIAL CACHE
# ═══════════════════════════════════════════════════════════
_MEM_CACHE: Dict[str, Any] = {
    "cookies": None,
    "ua": _UA,
    "token": None,
    "timestamp": 0.0,
}


def _rid(n: int = 16) -> str:
    return "".join(random.choices(_CHARS, k=n))


# ═══════════════════════════════════════════════════════════
# §3 — SSE PARSER
# ═══════════════════════════════════════════════════════════
class _SSE:
    @staticmethod
    def parse(line: str) -> Optional[tuple[str, Union[str, Dict]]]:
        line = line.strip()
        if not line or line[0] == ":" or line.startswith(("event:", "id:")):
            return None

        if line.startswith("data:"):
            line = line[5:].strip()
        if not line:
            return None
        if line == "[DONE]":
            return ("done", "")

        try:
            obj = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            return None
        if not isinstance(obj, dict):
            return None

        evt = obj.get("type", "")

        if evt == "reasoning-delta":
            d = obj.get("delta", "")
            return ("r-delta", d) if d else None

        if evt == "text-delta":
            d = obj.get("delta", "")
            return ("t-delta", d) if d else None

        if evt == "source-url":
            sid = obj.get("sourceId", "")
            if sid == "__searching__":
                return None

            url = obj.get("url", "")
            if url:
                return (
                    "source",
                    {
                        "id": sid,
                        "url": url,
                        "title": obj.get("title", ""),
                    },
                )

        return None


# ═══════════════════════════════════════════════════════════
# §4 — MESSAGE CONVERTER
# ═══════════════════════════════════════════════════════════
class _Conv:
    @staticmethod
    def to_mercury(messages: List[Dict], system: str = "") -> List[Dict]:
        flat: List[Dict] = []

        if system:
            flat.append(
                {
                    "role": "user",
                    "content": f"{_SYS_PREFIX} {system}",
                }
            )

        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "")

            if isinstance(content, list):
                content = " ".join(
                    p.get("text", "") for p in content if p.get("type") == "text"
                )

            if role == "system":
                flat.append(
                    {
                        "role": "user",
                        "content": f"{_SYS_PREFIX} {content}",
                    }
                )
            elif role in ("user", "assistant"):
                flat.append({"role": role, "content": content})

        merged: List[Dict] = []
        for msg in flat:
            if merged and msg["role"] == "user" and merged[-1]["role"] == "user":
                merged[-1]["content"] += "\n\n" + msg["content"]
            else:
                merged.append(dict(msg))

        result: List[Dict] = []
        for msg in merged:
            parts = [{"type": "text", "text": msg["content"]}]
            if msg["role"] == "assistant":
                parts[0]["state"] = "done"
            result.append(
                {
                    "id": _rid(),
                    "role": msg["role"],
                    "parts": parts,
                }
            )

        return result


# ═══════════════════════════════════════════════════════════
# §5 — SOURCE FORMATTER
# ═══════════════════════════════════════════════════════════
class _Sources:
    @staticmethod
    def collect(sources: List[Dict]) -> List[Dict]:
        seen_urls: set[str] = set()
        result: List[Dict] = []
        idx = 0

        for src in sources:
            url = src.get("url", "").strip()
            title = src.get("title", "").strip()
            sid = src.get("id", "")

            if not url or url in seen_urls:
                continue

            seen_urls.add(url)
            idx += 1
            result.append(
                {
                    "index": idx,
                    "id": sid,
                    "title": title or "Untitled",
                    "url": url,
                }
            )

        return result

    @staticmethod
    def format_text(sources: List[Dict]) -> str:
        if not sources:
            return ""

        lines = [
            "",
            "  ┌─────────────────────────────────────",
            f"  │ 📚 Sources ({len(sources)})",
        ]
        for s in sources:
            lines.append(f"  │  [{s['index']}] {s['title']}")
            lines.append(f"  │      {s['url']}")
        lines.append("  └─────────────────────────────────────")
        return "\n".join(lines)

    @staticmethod
    def format_json(sources: List[Dict]) -> str:
        clean_sources = []
        for src in sources:
            clean_sources.append(
                {
                    "title": src.get("title", ""),
                    "url": src.get("url", ""),
                }
            )
        return json.dumps({"sources": clean_sources})


# ═══════════════════════════════════════════════════════════
# §6 — CREDENTIAL MANAGER (IN MEMORY ONLY)
# ═══════════════════════════════════════════════════════════
class _Credentials:
    @staticmethod
    async def load() -> Optional[Dict]:
        """
        Load cached credentials from process memory.
        Returns None if missing / expired / incomplete.
        """
        token = _MEM_CACHE.get("token")
        cookies = _MEM_CACHE.get("cookies")
        ua = _MEM_CACHE.get("ua", _UA)
        ts = _MEM_CACHE.get("timestamp", 0.0)

        if not token or not cookies:
            return None

        if time.time() - ts > _CRED_TTL:
            return None

        if not cookies.get("session"):
            return None

        return {
            "token": token,
            "cookies": cookies,
            "ua": ua,
            "timestamp": ts,
        }

    @staticmethod
    async def save(cookies: Dict, ua: str, token: str):
        """
        Save credentials only into process memory.
        """
        _MEM_CACHE["cookies"] = dict(cookies)
        _MEM_CACHE["ua"] = ua
        _MEM_CACHE["token"] = token
        _MEM_CACHE["timestamp"] = time.time()

    @staticmethod
    async def clear():
        _MEM_CACHE["cookies"] = None
        _MEM_CACHE["ua"] = _UA
        _MEM_CACHE["token"] = None
        _MEM_CACHE["timestamp"] = 0.0

    @staticmethod
    async def validate(cookies: Dict, ua: str, proxy: Optional[str] = _PROXY) -> Optional[Dict]:
        """
        Validate existing cookies and refresh token using cloudscraper.
        Returns refreshed state if valid, otherwise None.
        """
        def _check() -> Optional[Dict]:
            try:
                scraper = cloudscraper.create_scraper(
                    browser={
                        "browser": "chrome",
                        "platform": "windows",
                        "mobile": False,
                    },
                    delay=10,
                )
                scraper.headers.update({"user-agent": ua})

                proxy_map = _proxy_dict(proxy)
                if proxy_map:
                    scraper.proxies.update(proxy_map)

                for k, v in cookies.items():
                    if v:
                        scraper.cookies.set(k, v)

                r = scraper.get(_SESSION_API, timeout=30)
                if r.status_code != 200:
                    return None

                data = r.json()
                token = data.get("token", "")
                if not token:
                    return None

                refreshed_cookies = scraper.cookies.get_dict()
                if not refreshed_cookies.get("session"):
                    return None

                return {
                    "cookies": refreshed_cookies,
                    "ua": ua,
                    "token": token,
                }
            except Exception:
                return None

        return await asyncio.to_thread(_check)


# ═══════════════════════════════════════════════════════════
# §7 — CLOUDFLARE SESSION MANAGER
# ═══════════════════════════════════════════════════════════
class _CloudScraperSessionManager:
    def __init__(
        self,
        base_url: str,
        token: str = "",
        cookies: Optional[Dict] = None,
        ua: str = _UA,
        proxy: Optional[str] = _PROXY,
        auto_refresh: bool = True,
        refresh_interval: int = 90,
    ):
        self.base_url = base_url.rstrip("/")
        self.session_url = self.base_url + "/api/session"
        self.token = token
        self.cookies = dict(cookies or {})
        self.ua = ua
        self.proxy = proxy
        self.refresh_interval = refresh_interval
        self.running = False
        self._stop_event = threading.Event()
        self._lock = threading.RLock()
        self.refresh_thread: Optional[threading.Thread] = None

        self.scraper = cloudscraper.create_scraper(
            browser={
                "browser": "chrome",
                "platform": "windows",
                "mobile": False,
            },
            delay=10,
        )
        self.scraper.headers.update({"user-agent": self.ua})

        proxy_map = _proxy_dict(self.proxy)
        if proxy_map:
            self.scraper.proxies.update(proxy_map)

        for k, v in self.cookies.items():
            if v:
                self.scraper.cookies.set(k, v)

        if auto_refresh and self.token:
            self.start_auto_refresh()

    def get_state(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "token": self.token,
                "cookies": dict(self.cookies),
                "ua": self.ua,
                "proxy": self.proxy,
            }

    def fetch_token(self) -> Optional[str]:
        try:
            time.sleep(random.uniform(1.5, 4.0))

            response = self.scraper.get(self.session_url, timeout=30)

            if response.status_code == 200:
                data = response.json()
                token = data.get("token")

                if token:
                    with self._lock:
                        self.token = token
                        self.cookies = self.scraper.cookies.get_dict()
                        self.ua = self.scraper.headers.get("user-agent", self.ua)
                    return token

                return None

            if response.status_code == 429:
                time.sleep(30)
                return None

            return None

        except Exception:
            return None

    def _refresh_loop(self):
        while self.running and not self._stop_event.wait(self.refresh_interval):
            token = self.fetch_token()
            if token:
                _MEM_CACHE["token"] = token
                _MEM_CACHE["cookies"] = dict(self.cookies)
                _MEM_CACHE["ua"] = self.ua
                _MEM_CACHE["timestamp"] = time.time()

    def start_auto_refresh(self):
        if not self.running:
            self.running = True
            self._stop_event.clear()
            self.refresh_thread = threading.Thread(
                target=self._refresh_loop,
                daemon=True,
            )
            self.refresh_thread.start()

    def stop_auto_refresh(self):
        self.running = False
        self._stop_event.set()

    def make_request(self, method, endpoint, **kwargs):
        headers = dict(kwargs.get("headers") or {})
        with self._lock:
            if self.token:
                headers["x-session-token"] = self.token
        kwargs["headers"] = headers
        url = f"{self.base_url}{endpoint}"
        return self.scraper.request(method, url, **kwargs)

    def close(self):
        self.stop_auto_refresh()
        try:
            self.scraper.close()
        except Exception:
            pass


# ═══════════════════════════════════════════════════════════
# §8 — ASYNC STREAM BRIDGE
# ═══════════════════════════════════════════════════════════
_SENTINEL = object()


async def _bridge_stream(
    producer_fn,
) -> AsyncGenerator[Tuple[str, Any], None]:
    q = _queue.Queue()

    def _wrapper():
        try:
            producer_fn(q)
        except Exception as e:
            q.put(e)
        finally:
            q.put(_SENTINEL)

    loop = asyncio.get_running_loop()
    task = loop.run_in_executor(None, _wrapper)

    while True:
        try:
            item = await loop.run_in_executor(None, lambda: q.get(timeout=2.0))
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
# §9 — MAIN PROVIDER
# ═══════════════════════════════════════════════════════════
class MercuryProvider:
    """
    ⚡ Mercury — Async Reasoning Model Provider
    """

    def __init__(
        self,
        system: str = "",
        search: bool = True,
        timeout: int = 180,
        auto_refresh: bool = True,
        refresh_interval: int = 90,
        proxy: Optional[str] = _PROXY,
    ):
        self.model = "mercury"
        self.system = system
        self.search = search
        self.timeout = timeout
        self.auto_refresh = auto_refresh
        self.refresh_interval = refresh_interval
        self.proxy = proxy

        self.history: List[Dict] = []
        self.last_response: str = ""
        self.last_reasoning: str = ""
        self.last_sources: List[Dict] = []
        self.last_sources_text: str = ""

        self._conv_id: str = _rid()
        self._auth: Optional[_CloudScraperSessionManager] = None
        self._via: Optional[str] = None
        self._token: str = ""
        self._ua: str = _UA
        self._cookies: Dict = {}
        self._connected: bool = False

        atexit.register(self._sync_cleanup)

    def _sync_cleanup(self):
        if self._auth:
            try:
                self._auth.close()
            except Exception:
                pass
            self._auth = None

    async def connect(self):
        """
        Try in-memory cached credentials first.
        If invalid, obtain a fresh token via cloudscraper /api/session.
        """
        cached = await _Credentials.load()

        if cached:
            validated = await _Credentials.validate(
                cached["cookies"],
                cached.get("ua", _UA),
                proxy=self.proxy,
            )
            if validated:
                self._auth = _CloudScraperSessionManager(
                    _URL,
                    token=validated["token"],
                    cookies=validated["cookies"],
                    ua=validated.get("ua", _UA),
                    proxy=self.proxy,
                    auto_refresh=self.auto_refresh,
                    refresh_interval=self.refresh_interval,
                )
                self._token = validated["token"]
                self._ua = validated.get("ua", _UA)
                self._cookies = validated["cookies"]
                self._via = "http"
                self._connected = True
                return

        auth = _CloudScraperSessionManager(
            _URL,
            proxy=self.proxy,
            auto_refresh=False,
            refresh_interval=self.refresh_interval,
        )

        token = await asyncio.to_thread(auth.fetch_token)
        if not token:
            try:
                auth.close()
            except Exception:
                pass
            raise RuntimeError("Unable to obtain session token")

        state = auth.get_state()
        self._auth = auth
        self._token = state["token"]
        self._ua = state["ua"]
        self._cookies = state["cookies"]
        self._via = "http"
        self._connected = True

        await _Credentials.save(self._cookies, self._ua, self._token)

        if self.auto_refresh:
            self._auth.start_auto_refresh()

    async def _ensure_connected(self):
        if not self._connected:
            await self.connect()

    def _current_state(self) -> Dict[str, Any]:
        if self._auth:
            state = self._auth.get_state()
            self._token = state["token"] or self._token
            self._ua = state["ua"] or self._ua
            self._cookies = state["cookies"] or self._cookies
        return {
            "token": self._token,
            "ua": self._ua,
            "cookies": dict(self._cookies),
        }

    def _hdrs(self) -> Dict:
        state = self._current_state()
        return {
            "accept": "*/*",
            "accept-language": "en-US,en;q=0.9",
            "content-type": "application/json",
            "origin": _URL,
            "referer": _URL + "/",
            "user-agent": state["ua"],
            "sec-ch-ua": (
                '"Chromium";v="136","Not-A.Brand";v="24",'
                '"Google Chrome";v="136"'
            ),
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "x-session-token": state["token"],
        }

    async def _stream_events(
        self, payload: Dict
    ) -> AsyncGenerator[Tuple[str, Any], None]:
        try:
            if self._via == "http":
                async for event in self._stream_http(payload):
                    yield event
            else:
                raise RuntimeError("No browser mode available")
        except RuntimeError as e:
            err_msg = str(e)

            if self._via == "http" and ("401" in err_msg or "403" in err_msg):
                await _Credentials.clear()
                self._connected = False

                if self._auth:
                    try:
                        self._auth.close()
                    except Exception:
                        pass
                    self._auth = None

                await self._ensure_connected()

                async for event in self._stream_http(payload):
                    yield event
            else:
                raise

    async def _stream_http(
        self, payload: Dict
    ) -> AsyncGenerator[Tuple[str, Any], None]:
        state = self._current_state()
        cookies = dict(state["cookies"])
        headers = dict(self._hdrs())
        timeout = self.timeout
        proxy = self.proxy

        def _producer(q: _queue.Queue):
            scraper = cloudscraper.create_scraper(
                browser={
                    "browser": "chrome",
                    "platform": "windows",
                    "mobile": False,
                },
                delay=10,
            )
            scraper.headers.update(headers)

            proxy_map = _proxy_dict(proxy)
            if proxy_map:
                scraper.proxies.update(proxy_map)

            for k, v in cookies.items():
                if v:
                    scraper.cookies.set(k, v)

            resp = scraper.post(
                _API,
                data=json.dumps(payload),
                stream=True,
                timeout=timeout,
            )

            try:
                if resp.status_code != 200:
                    err = ""
                    try:
                        err = resp.text[:300]
                    except Exception:
                        pass
                    raise RuntimeError(f"HTTP {resp.status_code}: {err}")

                buf = ""
                for chunk in resp.iter_content(chunk_size=None):
                    if not chunk:
                        continue
                    s = chunk.decode("utf-8", "replace") if isinstance(chunk, bytes) else chunk
                    buf += s

                    while "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        event = _SSE.parse(line)
                        if event:
                            if event[0] == "done":
                                return
                            q.put(event)

                for line in buf.strip().splitlines():
                    event = _SSE.parse(line)
                    if event:
                        if event[0] == "done":
                            return
                        q.put(event)
            finally:
                try:
                    scraper.close()
                except Exception:
                    pass

        async for event in _bridge_stream(_producer):
            yield event

    async def chat(
        self,
        data: Optional[str] = None,
        messages: Optional[List[Dict]] = None,
        system: Optional[str] = None,
        search: Optional[bool] = None,
    ) -> AsyncGenerator[str, None]:
        if not messages and not data:
            raise ValueError("Provide 'messages' or 'data'")

        await self._ensure_connected()

        use_search = search if search is not None else self.search

        if messages:
            use_system = system if system is not None else self.system
            clean: List[Dict] = []

            for msg in messages:
                role = msg.get("role", "")
                content = msg.get("content", "")

                if isinstance(content, list):
                    content = " ".join(
                        p.get("text", "") for p in content if p.get("type") == "text"
                    )

                if role == "system":
                    use_system = content
                elif role in ("user", "assistant"):
                    clean.append({"role": role, "content": content})

            self.history = clean
        else:
            use_system = system if system is not None else self.system
            self.history.append({"role": "user", "content": data})

        # reset per-request outputs so stale state never leaks into a new run
        self.last_response = ""
        self.last_reasoning = ""
        self.last_sources = []
        self.last_sources_text = ""

        mercury_msgs = _Conv.to_mercury(self.history, system=use_system)

        payload = {
            "reasoningEffort": "high",
            "webSearchEnabled": use_search,
            "voiceMode": False,
            "id": self._conv_id,
            "messages": mercury_msgs,
            "trigger": "submit-message",
        }

        reasoning_parts: List[str] = []
        content_parts: List[str] = []
        sources_list: List[Dict] = []
        sources_yielded = False

        async for etype, econtent in self._stream_events(payload):
            if etype == "source" and isinstance(econtent, dict):
                sources_list.append(econtent)

                # Emit the source JSON as soon as the first real source appears.
                # This does not block the answer stream.
                if use_search and not sources_yielded and sources_list:
                    sources_yielded = True
                    formatted_sources = _Sources.collect(sources_list)
                    self.last_sources = formatted_sources
                    yield _Sources.format_json(formatted_sources)
                continue

            if etype == "r-delta":
                reasoning_parts.append(econtent)
                yield econtent
            elif etype == "t-delta":
                content_parts.append(econtent)
                yield econtent

        if use_search and sources_list and not sources_yielded:
            formatted_sources = _Sources.collect(sources_list)
            self.last_sources = formatted_sources
            yield _Sources.format_json(formatted_sources)

        self.last_response = "".join(content_parts)
        self.last_reasoning = "".join(reasoning_parts)
        self.last_sources_text = _Sources.format_text(self.last_sources)

        if self.last_response:
            self.history.append(
                {
                    "role": "assistant",
                    "content": self.last_response,
                }
            )

    def set_system(self, prompt: str) -> "MercuryProvider":
        self.system = prompt
        return self

    def set_search(self, enabled: bool) -> "MercuryProvider":
        self.search = enabled
        return self

    def clear_history(self):
        self.history.clear()

    def get_history(self) -> List[Dict]:
        out: List[Dict] = []
        if self.system:
            out.append({"role": "system", "content": self.system})
        out.extend(self.history)
        return out

    def new_session(self):
        self.history.clear()
        self._conv_id = _rid()
        self.last_response = ""
        self.last_reasoning = ""
        self.last_sources = []
        self.last_sources_text = ""

    def get_sources(self) -> List[Dict]:
        return self.last_sources

    def get_sources_text(self) -> str:
        return self.last_sources_text

    async def close(self):
        if self._auth:
            await asyncio.to_thread(self._auth.close)
            self._auth = None

    @staticmethod
    async def clear_credentials():
        await _Credentials.clear()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()

    def __del__(self):
        try:
            self._sync_cleanup()
        except Exception:
            pass

    def __repr__(self):
        via = self._via or "not-connected"
        s = "🔍" if self.search else ""
        return f"MercuryProvider(mode=high, via={via}{' ' + s if s else ''})"


# ═══════════════════════════════════════════════════════════
# Example usage
# ═══════════════════════════════════════════════════════════
if __name__ == "__main__":

    async def main():
        mc = MercuryProvider(auto_refresh=True, refresh_interval=90)

        async for token in mc.chat(data="do a websearch over the new information about iran war",search=True):
            print(token, end="", flush=True)

        print("\n")
        print(mc.last_sources_text)

    asyncio.run(main())