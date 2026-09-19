"""
Native Search — No Tavily, No API key, DuckDuckGo HTML scraping, Bing fallback, cached, fast
"""
from __future__ import annotations
import asyncio
import hashlib
import time
import re
import json
from typing import List, Dict, Tuple
from urllib.parse import quote, unquote
from dataclasses import dataclass

from ..config import RAG_MAX_RESULTS, SEARCH_CACHE_TTL, SEARCH_TIMEOUT, SEARCH_MAX_CONCURRENT

try:
    from curl_cffi.requests import AsyncSession
    HAS_CURL_CFFI = True
except ImportError:
    HAS_CURL_CFFI = False

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
_UA_HEADERS = {
    "User-Agent": _UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
}

@dataclass
class Source:
    title: str
    url: str
    snippet: str
    score: float = 0.0
    idx: int = 0

def _http_session():
    if not HAS_CURL_CFFI:
        raise RuntimeError("curl_cffi required")
    return AsyncSession(impersonate="chrome", timeout=SEARCH_TIMEOUT)

class NativeSearch:
    def __init__(self, cache_ttl: int = SEARCH_CACHE_TTL, max_concurrent: int = SEARCH_MAX_CONCURRENT):
        self._cache: Dict[str, Tuple[float, List[Source]]] = {}
        self._lock = asyncio.Lock()
        self._sem = asyncio.Semaphore(max_concurrent)
        self._cache_ttl = cache_ttl
        self._stats = {"hits": 0, "misses": 0, "failures": 0}

    async def search(self, query: str, max_results: int = RAG_MAX_RESULTS) -> List[Source]:
        if not query or not query.strip():
            return []

        key = hashlib.sha256(query.lower().strip().encode()).hexdigest()

        async with self._lock:
            if key in self._cache:
                ts, results = self._cache[key]
                if time.time() - ts < self._cache_ttl:
                    self._stats["hits"] += 1
                    return results

        self._stats["misses"] += 1

        async with self._sem:
            results = await self._search_duckduckgo(query, max_results)
            if not results:
                results = await self._search_bing(query, max_results)
            if not results:
                self._stats["failures"] += 1

        async with self._lock:
            self._cache[key] = (time.time(), results)

        return results

    async def _search_duckduckgo(self, query: str, max_results: int) -> List[Source]:
        try:
            async with _http_session() as session:
                url = f"https://html.duckduckgo.com/html/?q={quote(query)}"
                r = await session.get(url, headers=_UA_HEADERS)
                if r.status_code != 200:
                    return []
                html = r.text

                sources = []
                seen = set()

                # Pattern 1: result__url
                url_pat = r'class="result__url"[^>]*href="([^"]+)"'
                urls = re.findall(url_pat, html, re.I | re.S)

                # Pattern for title: result__title
                title_pat = r'class="result__title"[^>]*>(.*?)</h2>'
                titles = re.findall(title_pat, html, re.I | re.S)

                snippet_pat = r'class="result__snippet"[^>]*>(.*?)</a>'
                snippets = re.findall(snippet_pat, html, re.I | re.S)

                for i in range(min(len(urls), max_results * 2)):
                    if len(sources) >= max_results:
                        break
                    raw_url = urls[i] if i < len(urls) else ""
                    real_url = raw_url
                    if "uddg=" in raw_url:
                        m = re.search(r'uddg=([^&]+)', raw_url)
                        if m:
                            try:
                                real_url = unquote(m.group(1))
                            except:
                                pass
                    if not real_url.startswith("http"):
                        if real_url.startswith("//"):
                            real_url = "https:" + real_url
                        else:
                            continue
                    if real_url in seen:
                        continue
                    seen.add(real_url)

                    raw_title = titles[i] if i < len(titles) else "Untitled"
                    clean_title = re.sub(r'<[^>]+>', '', raw_title).strip()[:150]
                    raw_snip = snippets[i] if i < len(snippets) else ""
                    clean_snip = re.sub(r'<[^>]+>', '', raw_snip).strip()[:300]

                    if not clean_title and not clean_snip:
                        continue

                    sources.append(Source(title=clean_title or "Untitled", url=real_url, snippet=clean_snip, score=1.0 - i*0.05, idx=len(sources)+1))

                # Fallback pattern: result__a
                if not sources:
                    alt_pat = r'<a[^>]+rel="nofollow"[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>'
                    matches = re.findall(alt_pat, html, re.I | re.S)
                    for href, title_html in matches[:max_results*2]:
                        if len(sources) >= max_results:
                            break
                        real_url = href
                        if "uddg=" in href:
                            m = re.search(r'uddg=([^&]+)', href)
                            if m:
                                try:
                                    real_url = unquote(m.group(1))
                                except:
                                    pass
                        if not real_url.startswith("http"):
                            continue
                        if real_url in seen:
                            continue
                        seen.add(real_url)
                        clean_title = re.sub(r'<[^>]+>', '', title_html).strip()[:150]
                        sources.append(Source(title=clean_title or "Untitled", url=real_url, snippet="", score=0.8, idx=len(sources)+1))

                return sources[:max_results]
        except Exception as e:
            print(f"[Search] DuckDuckGo error: {e}")
            return []

    async def _search_bing(self, query: str, max_results: int) -> List[Source]:
        try:
            async with _http_session() as session:
                url = f"https://www.bing.com/search?q={quote(query)}"
                r = await session.get(url, headers={**_UA_HEADERS, "Accept": "text/html"}, timeout=SEARCH_TIMEOUT)
                if r.status_code != 200:
                    return []
                html = r.text
                sources = []
                seen = set()
                pat = r'<li[^>]+class="b_algo"[^>]*>.*?<h2[^>]*>.*?<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?</h2>.*?<div[^>]+class="b_caption"[^>]*>.*?<p[^>]*>(.*?)</p>'
                matches = re.findall(pat, html, re.I | re.S)
                for href, title_html, snippet_html in matches:
                    if len(sources) >= max_results:
                        break
                    if not href.startswith("http"):
                        continue
                    if href in seen:
                        continue
                    seen.add(href)
                    clean_title = re.sub(r'<[^>]+>', '', title_html).strip()[:150]
                    clean_snip = re.sub(r'<[^>]+>', '', snippet_html).strip()[:300]
                    sources.append(Source(title=clean_title or "Untitled", url=href, snippet=clean_snip, score=0.7, idx=len(sources)+1))
                return sources[:max_results]
        except Exception as e:
            print(f"[Search] Bing error: {e}")
            return []

    def format_text(self, sources: List[Source]) -> str:
        if not sources:
            return "No sources found."
        lines = []
        for s in sources:
            lines.append(f"[{s.idx}] {s.title}")
            lines.append(f"    {s.url}")
            if s.snippet:
                lines.append(f"    {s.snippet[:200]}...")
            lines.append("")
        return "\n".join(lines)

    def format_json(self, sources: List[Source]) -> str:
        return json.dumps({"sources": [{"title": s.title, "url": s.url, "snippet": s.snippet[:200], "score": s.score} for s in sources]})

    def clear_cache_sync(self):
        self._cache.clear()

    async def clear_cache(self):
        async with self._lock:
            self._cache.clear()

    def get_stats_sync(self):
        return {
            "cache_size": len(self._cache),
            "hits": self._stats["hits"],
            "misses": self._stats["misses"],
            "failures": self._stats["failures"],
            "hit_rate": round(self._stats["hits"] / (self._stats["hits"] + self._stats["misses"]) * 100, 1) if (self._stats["hits"] + self._stats["misses"]) > 0 else 0,
        }

    async def get_stats(self):
        async with self._lock:
            return self.get_stats_sync()

    # Alias for sync callers
    def get_stats_blocking(self):
        return self.get_stats_sync()

global_search = NativeSearch()
