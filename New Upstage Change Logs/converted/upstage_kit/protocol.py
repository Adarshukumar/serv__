"""
protocol.py — pure logic: SSE parser, think-tag splitter, source
formatter, stream event + usage dataclasses.  No I/O, no network.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

# think tags (built from fragments so naive file tools can't mangle them)
OPEN_THINK = "<" + "think" + ">"
CLOSE_THINK = "</" + "think" + ">"


# ═══════════════════════════════════════════════════════════
# SSE PARSER
# ═══════════════════════════════════════════════════════════
class SSEParser:
    """
    Parse one Upstage SSE line → list of (event_type, content).

        "r-delta"   reasoning token          (delta.reasoning_content)
        "t-delta"   answer token             (delta.content)
        "source"    search results JSON      (search_finish)
        "s-start"   search started
        "s-summary" summarizing notice
        "usage"     non-zero usage block
        "done"      stream finished (always last on its line)

    A single line can produce several events (final chunk may carry
    both `usage` and `finish_reason: stop`).
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

        # ── search events (arrive WITHOUT choices) ──
        search = obj.get("search")
        if obj.get("choices") is None and search:
            st = search.get("status", {})
            action = st.get("action", "")
            desc = st.get("description", "")
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
            # ── content / thinking chunks ──
            choices = obj.get("choices")
            if choices:
                delta = choices[0].get("delta", {})

                rc = delta.get("reasoning_content", "")
                if rc:
                    events.append(("r-delta", rc))

                text = delta.get("content", "")
                if text:
                    # inline <think>…## splitting happens one level up
                    events.append(("t-delta", text))

        # ── usage only when API reports non-zero counts ──
        usage = obj.get("usage")
        if isinstance(usage, dict) and (
            usage.get("prompt_tokens") or usage.get("completion_tokens")
            or usage.get("total_tokens")
        ):
            events.append(("usage", json.dumps(usage)))

        # ── done LAST so same-line usage isn't skipped ──
        if obj.get("choices") and obj["choices"][0].get("finish_reason") == "stop":
            events.append(("done", ""))

        return events


# ═══════════════════════════════════════════════════════════
# SOURCE FORMATTER
# ═══════════════════════════════════════════════════════════
class Sources:

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
                query_text = q_data.get("query", "")
                raw_results = q_data.get("results", [])
                if not isinstance(raw_results, list):
                    continue

                for r in raw_results:
                    url = (r.get("url") or "").strip()
                    title = (r.get("title") or "").strip()
                    try:
                        score = float(r.get("score", 0.0))
                    except (TypeError, ValueError):
                        score = 0.0
                    content = (r.get("content") or "").strip()

                    if not url or url in seen_urls:
                        continue
                    seen_urls.add(url)
                    idx += 1

                    snippet = content[:200].replace("\n", " ").strip()
                    if len(content) > 200:
                        snippet += "..."

                    result.append({
                        "index": idx, "query": query_text,
                        "title": title or "Untitled", "url": url,
                        "score": score, "snippet": snippet,
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
        clean = [
            {"title": s.get("title", ""), "url": s.get("url", ""),
             "score": s.get("score", 0)}
            for s in sources
        ]
        return json.dumps({"sources": clean})


# ═══════════════════════════════════════════════════════════
# THINK SPLITTER
# ═══════════════════════════════════════════════════════════
class ThinkSplitter:
    """
    Backend inlines thinking INSIDE content deltas as
     <think>…##  and tags can be split across tokens.
    Feed raw content tokens; get (kind, segment) pairs with
    kind ∈ {"content", "thinking"} — each segment clean of markup.
    A trailing partial tag is held until the next feed() decides;
    flush() releases whatever remains at stream end.
    """

    def __init__(self, open_tag: str = OPEN_THINK, close_tag: str = CLOSE_THINK):
        self._open = open_tag
        self._close = close_tag
        self._buf = ""
        self._in = False

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


# ═══════════════════════════════════════════════════════════
# STREAM EVENT + USAGE DEPARTMENT
# ═══════════════════════════════════════════════════════════
@dataclass
class StreamEvent:
    """kind ∈ {"sources","thinking","content","done"}"""
    kind: str
    text: str = ""


@dataclass
class TurnUsage:
    """Measured stats for one chat turn."""
    model: str = "solar-pro3"
    ok: bool = True
    error: str = ""
    prompt_chars: int = 0
    thinking_chars: int = 0
    content_chars: int = 0
    n_sources: int = 0
    api_usage: Optional[Dict[str, Any]] = None
    elapsed_s: float = 0.0
    first_token_s: Optional[float] = None

    @property
    def tokens_estimated(self) -> bool:
        return not (self.api_usage
                    and (self.api_usage.get("total_tokens") or 0) > 0)

    @property
    def tokens(self) -> int:
        if not self.tokens_estimated:
            return int(self.api_usage.get("total_tokens") or 0)
        chars = self.thinking_chars + self.content_chars
        return max(1, round(chars / 4)) if chars > 0 else 0

    @property
    def tokens_per_s(self) -> Optional[float]:
        if self.elapsed_s <= 0:
            return None
        return self.tokens / self.elapsed_s

    def to_dict(self) -> Dict[str, Any]:
        return {
            "model": self.model, "ok": self.ok, "error": self.error,
            "prompt_chars": self.prompt_chars,
            "thinking_chars": self.thinking_chars,
            "content_chars": self.content_chars,
            "n_sources": self.n_sources,
            "api_usage": self.api_usage,
            "elapsed_s": round(self.elapsed_s, 4),
            "first_token_s": (round(self.first_token_s, 4)
                              if self.first_token_s is not None else None),
            "tokens": self.tokens,
            "tokens_estimated": self.tokens_estimated,
        }

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
            "turns": len(self.turns), "ok": len(ok),
            "failed": len(self.turns) - len(ok),
            "elapsed_s": round(sum(t.elapsed_s for t in ok), 2),
            "tokens": sum(t.tokens for t in ok),
            "thinking_chars": sum(t.thinking_chars for t in ok),
            "content_chars": sum(t.content_chars for t in ok),
            "sources": sum(t.n_sources for t in ok),
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
