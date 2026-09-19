"""
Base Provider — non-laggy, provider-based
"""
from __future__ import annotations
import re
import json
from dataclasses import dataclass
from typing import List, Tuple, Dict, AsyncGenerator

@dataclass
class StreamEvent:
    kind: str  # sources, thinking, content, done, error
    text: str = ""

class ThinkSplitter:
    def __init__(self):
        self._buf = ""
        self._in = False
        self._open = "<think>"
        self._close = "</think>"

    def feed(self, text: str) -> List[Tuple[str, str]]:
        out = []
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
                self._in = False
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
                self._in = True
                self._buf = self._buf[i + len(self._open):]
        return out

    def flush(self) -> List[Tuple[str, str]]:
        if not self._buf:
            return []
        kind = "thinking" if self._in else "content"
        seg, self._buf = self._buf, ""
        return [(kind, seg)]

class Sources:
    @staticmethod
    def parse(raw_list: List[str]) -> List[Dict]:
        sources = []
        seen = set()
        idx = 0
        for raw in raw_list:
            try:
                obj = json.loads(raw) if isinstance(raw, str) else raw
                # Handle {"sources": [...]} or direct list or {"query":..., "results":[...]}
                items = []
                if isinstance(obj, dict):
                    if "sources" in obj:
                        items = obj["sources"]
                    elif "results" in obj:
                        # Upstage style: {"query":..., "results": [{"title","url","content"}]}
                        items = obj["results"]
                    elif "query" in obj and isinstance(obj.get("results"), list):
                        items = obj["results"]
                    else:
                        items = [obj]
                elif isinstance(obj, list):
                    # List of query objects with results
                    for q in obj:
                        if isinstance(q, dict) and "results" in q:
                            items.extend(q["results"])
                        elif isinstance(q, dict):
                            items.append(q)
                    if not items:
                        items = obj
                else:
                    continue

                if not isinstance(items, list):
                    items = [items]

                for item in items:
                    if not isinstance(item, dict):
                        continue
                    url = item.get("url", "")
                    if not url or url in seen:
                        continue
                    seen.add(url)
                    idx += 1
                    title = item.get("title", "Untitled")[:150]
                    snippet = (item.get("snippet", "") or item.get("content", "") or "")[:300]
                    sources.append({"idx": idx, "title": title, "url": url, "snippet": snippet, "score": float(item.get("score", 0.0))})
            except Exception:
                continue
        return sources

    @staticmethod
    def format_json(sources: List[Dict]) -> str:
        return json.dumps({"sources": [{"title": s.get("title", ""), "url": s.get("url", "")} for s in sources]})

class BaseProvider:
    provider_name: str = "base"
    models: List[str] = []

    async def health_check(self) -> Dict:
        return {"ok": True, "provider": self.provider_name, "models": len(self.models)}

    async def stream(self, data=None, messages=None, model=None, system=None, search=False, user_ip=None, **kwargs) -> AsyncGenerator[StreamEvent, None]:
        raise NotImplementedError

    async def chat(self, data=None, messages=None, model=None, system=None, search=False, user_ip=None, **kwargs) -> AsyncGenerator[str, None]:
        async for ev in self.stream(data=data, messages=messages, model=model, system=system, search=search, user_ip=user_ip, **kwargs):
            yield ev.text
