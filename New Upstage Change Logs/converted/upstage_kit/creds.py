"""
creds.py — browser-free credential capture over pure HTTP
(curl_cffi AsyncSession, Chrome TLS impersonation).

Pipeline (unchanged from v3, hosts now come from config):
  1. load cache/upstage_creds.json
  2. verify CSRF token via RSC POST
  3. valid?  → instant start
  4. invalid → pure-HTTP re-capture:
       a. GET /playground/chat          → session cookies
       b. read its JS chunks, regex the action id BY NAME
       c. RSC POST (data="[]")          → parse {"token": …}
       d. save cookies + action ids
"""
from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path
from typing import Dict, Optional

from curl_cffi import requests as _cffi

from . import config


def _http_session() -> "_cffi.AsyncSession":
    return _cffi.AsyncSession(impersonate="chrome")


def find_action_id(js_text: str, action_name: str) -> Optional[str]:
    """
    Extract a Next.js server-action id from a client JS bundle by its
    declared name.  Matches minified patterns like:

      createServerReference)("002f44cb…d5",x.callServer,void 0,
          x.findSourceMapURL,"getConsoleCsrfToken")

    The regex pins the id to its OWN argument list (exactly 3 unquoted
    args before the name), so several actions on one minified line
    can't be cross-wired.  No fixed-length assumption (40 → 42 hex…).
    """
    m = re.search(
        r'createServerReference\)\("([a-f0-9]{32,80})"(?:,[^,\"]+){3},'
        r'"' + re.escape(action_name) + r'"\)',
        js_text,
    )
    return m.group(1) if m else None


class Credentials:

    def __init__(self, path: Optional[Path] = None):
        self.path = Path(path) if path else config.cred_file()
        self.action_init: Optional[str] = None
        self.action_token: Optional[str] = None
        self.cookies: Dict[str, str] = {}
        self.session_id: str = str(uuid.uuid4())

    # ── load / save / clear (tiny file → plain sync I/O) ──────
    async def load(self) -> bool:
        if not self.path.exists():
            return False
        try:
            data = json.loads(self.path.read_text())
            self.action_init = data.get("action_init")
            self.action_token = data.get("action_token")
            self.cookies = data.get("cookies", {})
            self.session_id = self.cookies.get("session_id", str(uuid.uuid4()))
            return bool(self.action_token)
        except Exception:
            return False

    async def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "action_init": self.action_init,
            "action_token": self.action_token,
            "cookies": self.cookies,
            "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        self.path.write_text(json.dumps(data, indent=2))

    async def clear(self):
        try:
            if self.path.exists():
                self.path.unlink()
        except Exception:
            pass

    # ── verify (one RSC POST) ─────────────────────────────────
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
            "accept": "text/x-component",
            "content-type": "text/plain;charset=UTF-8",
            "next-action": action_id,
            "origin": config.console_url(),
            "referer": f"{config.console_url()}{config.chat_path()}",
            "User-Agent": config.UA,
        }
        r = await http.post(
            f"{config.console_url()}{config.chat_path()}",
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

    # ── capture via pure HTTP (async) ─────────────────────────
    async def capture(self):
        async with _http_session() as http:
            # 1) page load — sets session cookies
            page = await http.get(
                f"{config.console_url()}{config.chat_path()}",
                headers=config.UA_HEADERS, timeout=20,
            )
            page.raise_for_status()
            html = page.text

            # 2) merge chunk refs from the page + its RSC payload
            # NOTE: fixed vs original — the v3 raw-string class
            #   [^\\\"\\s\\],] accidentally excluded the letter 's'
            #   (works only because real Next chunks are hex hashes).
            #   Correct negation: not quote, not whitespace, not ] or ,.
            _CHUNK_RE = re.compile(r'static/chunks/[^"\s\],]+\.js')
            chunk_refs = sorted(set(_CHUNK_RE.findall(html)))
            try:
                rsc = await http.get(
                    f"{config.console_url()}{config.chat_path()}",
                    headers={**config.UA_HEADERS, "RSC": "1"},
                    timeout=20,
                )
                if rsc.status_code == 200:
                    chunk_refs = sorted(set(chunk_refs) | set(
                        _CHUNK_RE.findall(rsc.text)
                    ))
            except Exception:
                pass  # RSC scan is insurance only

            # 3) scan chunks for action ids (by name)
            action_token: Optional[str] = None
            action_init: Optional[str] = None
            scanned = 0
            for ref in chunk_refs[: config.MAX_CHUNK_SCAN]:
                scanned += 1
                try:
                    r = await http.get(
                        f"{config.console_url()}/_next/{ref}",
                        headers=config.UA_HEADERS, timeout=20,
                    )
                except Exception:
                    continue
                if r.status_code != 200:
                    continue
                js = r.text
                if action_token is None and config.ACTION_TOKEN in js:
                    action_token = find_action_id(js, config.ACTION_TOKEN)
                if action_init is None and config.ACTION_INIT in js:
                    action_init = find_action_id(js, config.ACTION_INIT)
                if action_token:
                    break

            if not action_token:
                raise RuntimeError(
                    f"Could not find '{config.ACTION_TOKEN}' action in any of "
                    f"{scanned} scanned JS chunks — the console may have "
                    f"changed structure. Delete {config.cred_file()} and retry."
                )

            # 4) prove the action works + harvest a first token
            self._cookies_from(http)
            self.action_token = action_token
            self.action_init = action_init
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
